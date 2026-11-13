/**
 * URL helpers for the Crawl4AI port: normalisation (normalize_url_for_deep_crawl), registrable-domain
 * matching for internal/external links, social-media detection, and the private-network guard that
 * keeps the server-side fetcher from ever becoming a proxy into internal addresses.
 * Browser-safe (no server imports) so the Web Research page can pre-validate input too.
 */

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref_src|_hsenc|_hsmi|yclid|si)$/i;

/** Second-level public suffixes common for this audience (India first) and the wider web. */
const TWO_PART_SUFFIXES = new Set([
  "co.in", "gov.in", "nic.in", "ac.in", "org.in", "net.in", "edu.in", "res.in", "ernet.in", "firm.in", "gen.in", "ind.in",
  "co.uk", "ac.uk", "gov.uk", "org.uk", "com.au", "edu.au", "gov.au", "co.nz", "co.jp", "com.br", "com.cn", "com.sg", "edu.sg",
  "co.za", "com.mx", "com.pk", "edu.pk", "com.bd", "com.np", "edu.np", "github.io", "vercel.app", "netlify.app", "pages.dev",
  "lovable.app", "blogspot.com", "wordpress.com", "medium.com",
]);

export const SOCIAL_MEDIA_DOMAINS = [
  "facebook.com", "twitter.com", "x.com", "linkedin.com", "instagram.com", "pinterest.com", "tiktok.com", "snapchat.com", "reddit.com",
];

export function parseHttpUrl(raw: string, base?: string): URL | null {
  try {
    const u = base ? new URL(raw, base) : new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** Fragment removed, tracking parameters dropped, default port and trailing slash trimmed. */
export function normalizeUrl(raw: string, base?: string): string | null {
  const u = parseHttpUrl(raw.trim(), base);
  if (!u) return null;
  u.hash = "";
  if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) u.port = "";
  for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  let out = u.toString();
  if (u.pathname !== "/" && out.endsWith("/") && !u.search) out = out.slice(0, -1);
  return out;
}

export function baseDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return host;
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join(".");
  return TWO_PART_SUFFIXES.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

export function isInternalUrl(url: string, pageHost: string): boolean {
  const u = parseHttpUrl(url);
  return !!u && baseDomain(u.hostname) === baseDomain(pageHost);
}

export function isSocialMediaUrl(url: string): boolean {
  const u = parseHttpUrl(url);
  if (!u) return false;
  const host = u.hostname.toLowerCase();
  return SOCIAL_MEDIA_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

export type UrlSafety = { ok: true; url: URL } | { ok: false; reason: string };

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa", ".corp", ".intranet", ".localdomain"];

function ipv4Blocked(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && Number(m[3]) === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function ipv6Blocked(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h.includes(":")) return false;
  if (h === "::" || h === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return true; // unique-local, link-local
  const mapped = h.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Blocked(mapped[1]!);
  if (/^::ffff:/.test(h)) return true; // hex-form mapped address: refuse rather than decode
  return false;
}

/**
 * Public http(s) URLs only: no credentials, default ports, no localhost/private/link-local/metadata
 * addresses and no single-label or internal hostnames. Every redirect hop must pass this too.
 */
export function checkUrlSafety(raw: string): UrlSafety {
  const u = parseHttpUrl(raw);
  if (!u) return { ok: false, reason: "Only http:// or https:// web links can be read." };
  if (u.username || u.password) return { ok: false, reason: "Links with a username or password are not allowed." };
  if (u.port && u.port !== "80" && u.port !== "443") return { ok: false, reason: "Only standard web ports can be read." };
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, reason: "This link has no website name." };
  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s)) || host === "metadata.google.internal") {
    return { ok: false, reason: "Private or internal addresses cannot be read." };
  }
  if (ipv4Blocked(host) || ipv6Blocked(host)) return { ok: false, reason: "Private or internal addresses cannot be read." };
  if (!host.includes(".") && !host.includes(":")) return { ok: false, reason: "Private or internal addresses cannot be read." };
  return { ok: true, url: u };
}

const FILE_TYPES: Record<string, string> = {
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", xml: "application/xml",
  html: "text/html", htm: "text/html", php: "text/html", asp: "text/html", aspx: "text/html", jsp: "text/html",
  jpg: "image", jpeg: "image", png: "image", gif: "image", webp: "image", svg: "image", avif: "image", ico: "image",
  mp4: "video", webm: "video", mov: "video", mp3: "audio", wav: "audio", m4a: "audio", ogg: "audio",
  zip: "archive", rar: "archive", gz: "archive", "7z": "archive", exe: "binary", dmg: "binary", apk: "binary",
  doc: "office", docx: "office", ppt: "office", pptx: "office", xls: "office", xlsx: "office",
};

/** Guessed type from the URL extension (ContentTypeFilter); "text/html" when there is no extension. */
export function urlContentType(url: string): string {
  const u = parseHttpUrl(url);
  if (!u) return "unknown";
  const ext = u.pathname.split("/").pop()?.match(/\.([a-z0-9]{1,5})$/i)?.[1]?.toLowerCase();
  return ext ? FILE_TYPES[ext] ?? "unknown" : "text/html";
}

/**
 * The same link on the "www." twin host (www.example.in ↔ example.in), or null for IPs, localhost
 * and single-label hosts. Some sites (e.g. nta.ac.in) refuse connections on one of the two names.
 */
export function twinHostUrl(raw: string): string | null {
  const u = parseHttpUrl(raw);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  if (/^[\d.]+$/.test(host) || host.includes(":") || !host.includes(".")) return null;
  if (host.startsWith("www.")) {
    const bare = host.slice(4);
    if (!bare.includes(".")) return null;
    u.hostname = bare;
  } else {
    u.hostname = `www.${host}`;
  }
  return u.toString();
}
