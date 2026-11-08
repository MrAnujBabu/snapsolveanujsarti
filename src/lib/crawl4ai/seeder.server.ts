/**
 * AsyncUrlSeeder port (sitemap source): discovers a site's pages from robots.txt "Sitemap:" lines or
 * /sitemap.xml, follows sitemap indexes (gzip supported), keeps same-site safe links and ranks them
 * with the deep-crawl keyword scorer plus lastmod freshness. Bounded: ≤ 8 sitemap files, ≤ 5000 URLs.
 */
import { CrawlError, fetchPage } from "./fetcher.server";
import { baseDomain, checkUrlSafety, normalizeUrl } from "./url";

export type SeedUrl = { url: string; lastmod?: string; score: number };
export type SeedResult = { urls: SeedUrl[]; sitemaps: string[]; total: number };

const MAX_SITEMAP_FILES = 8;
const MAX_URLS = 5000;

const decodeXml = (s: string) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();

/** Parses a sitemap (urlset, sitemapindex or plain text list). */
export function parseSitemap(body: string): { kind: "index" | "urlset"; entries: { loc: string; lastmod?: string }[] } {
  const isIndex = /<sitemapindex[\s>]/i.test(body);
  const tag = isIndex ? "sitemap" : "url";
  const entries: { loc: string; lastmod?: string }[] = [];
  const block = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi");
  for (const m of body.matchAll(block)) {
    const loc = m[1]!.match(/<loc>([\s\S]*?)<\/loc>/i)?.[1];
    if (!loc) continue;
    const lastmod = m[1]!.match(/<lastmod>([\s\S]*?)<\/lastmod>/i)?.[1];
    entries.push({ loc: decodeXml(loc), ...(lastmod ? { lastmod: decodeXml(lastmod) } : {}) });
  }
  if (!entries.length && !/<\w/.test(body)) {
    for (const line of body.split(/\r?\n/)) if (/^https?:\/\//i.test(line.trim())) entries.push({ loc: line.trim() });
  }
  return { kind: isIndex ? "index" : "urlset", entries };
}

/** robots.txt "Sitemap:" lines. */
export function sitemapsFromRobots(body: string): string[] {
  return [...body.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => m[1]!).slice(0, 10);
}

function keywordScore(url: string, keywords: string[]): number {
  if (!keywords.length) return 0;
  let lower = url.toLowerCase();
  try { lower = decodeURIComponent(lower); } catch { /* keep encoded */ }
  return keywords.filter((k) => lower.includes(k.toLowerCase())).length / keywords.length;
}

function lastmodScore(lastmod: string | undefined, now = Date.now()): number {
  if (!lastmod) return 0.5;
  const t = Date.parse(lastmod);
  if (!Number.isFinite(t)) return 0.5;
  const days = (now - t) / 86_400_000;
  return days < 30 ? 1 : days < 365 ? 0.8 : days < 3 * 365 ? 0.6 : 0.3;
}

async function loadText(url: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const page = await fetchPage(url, { timeoutMs: 8000, maxHtmlBytes: 8_000_000, accept: "application/xml,text/xml,text/plain,*/*;q=0.5", ...(signal ? { signal } : {}) });
    if (page.status >= 400) return null;
    if (page.text !== undefined) return page.text;
    if (page.bytes && (/\.gz($|\?)/i.test(url) || (page.bytes[0] === 0x1f && page.bytes[1] === 0x8b))) {
      const stream = new Blob([page.bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
      const text = await new Response(stream).text();
      return text.slice(0, 20_000_000);
    }
    return null;
  } catch (e) {
    if (e instanceof CrawlError && e.code === "cancelled") throw e;
    return null;
  }
}

export async function seedFromSitemaps(startUrl: string, opts: { keywords?: string[]; max?: number; signal?: AbortSignal; includeExternal?: boolean } = {}): Promise<SeedResult> {
  const start = new URL(startUrl);
  const startBase = baseDomain(start.hostname);
  const keywords = (opts.keywords ?? []).filter(Boolean);
  const robots = await loadText(`${start.origin}/robots.txt`, opts.signal);
  const fromRobots = robots ? sitemapsFromRobots(robots) : [];
  const queue = (fromRobots.length ? fromRobots : [`${start.origin}/sitemap.xml`, `${start.origin}/sitemap_index.xml`])
    .map((u) => normalizeUrl(u, start.origin)).filter((u): u is string => !!u && checkUrlSafety(u).ok);
  const seenMaps = new Set<string>();
  const sitemaps: string[] = [];
  const found = new Map<string, SeedUrl>();
  while (queue.length && seenMaps.size < MAX_SITEMAP_FILES && found.size < MAX_URLS) {
    if (opts.signal?.aborted) throw new CrawlError("cancelled", "Stopped.");
    const next = queue.shift()!;
    if (seenMaps.has(next)) continue;
    seenMaps.add(next);
    const body = await loadText(next, opts.signal);
    if (!body) continue;
    const parsed = parseSitemap(body);
    if (!parsed.entries.length) continue;
    sitemaps.push(next);
    if (parsed.kind === "index") {
      // Child sitemaps whose names match the keywords are opened first (e.g. sitemap-biology.xml).
      const children = parsed.entries.map((e) => e.loc).filter((u) => checkUrlSafety(u).ok)
        .sort((a, b) => keywordScore(b, keywords) - keywordScore(a, keywords));
      queue.unshift(...children);
      continue;
    }
    for (const e of parsed.entries) {
      const url = normalizeUrl(e.loc);
      if (!url || found.has(url) || !checkUrlSafety(url).ok) continue;
      if (!opts.includeExternal && baseDomain(new URL(url).hostname) !== startBase) continue;
      found.set(url, { url, ...(e.lastmod ? { lastmod: e.lastmod } : {}), score: keywordScore(url, keywords) + lastmodScore(e.lastmod) * 0.15 });
      if (found.size >= MAX_URLS) break;
    }
  }
  const urls = [...found.values()].sort((a, b) => b.score - a.score).slice(0, opts.max ?? 200);
  return { urls, sitemaps, total: found.size };
}
