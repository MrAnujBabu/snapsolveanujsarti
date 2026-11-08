/**
 * Plain-HTTP crawler strategy (Crawl4AI AsyncHTTPCrawlerStrategy) for the edge server: no browser,
 * manual redirects with the private-network guard re-checked on every hop, byte caps while
 * streaming, charset detection and cancellation that follows the caller's Stop.
 */
import { checkUrlSafety } from "./url";

export type FetchKind = "html" | "pdf" | "text" | "json" | "xml" | "binary";

export type FetchedPage = {
  requestedUrl: string;
  url: string;
  status: number;
  contentType: string;
  kind: FetchKind;
  text?: string;
  bytes?: Uint8Array;
  redirects: string[];
  lastModified?: string;
  elapsedMs: number;
  truncated: boolean;
};

export type CrawlErrorCode = "blocked" | "timeout" | "too_large" | "http" | "network" | "unsupported" | "robots" | "cancelled" | "empty";

export class CrawlError extends Error {
  constructor(public code: CrawlErrorCode, message: string, public status?: number) {
    super(message);
    this.name = "CrawlError";
  }
}

export type FetchOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxHtmlBytes?: number;
  maxPdfBytes?: number;
  maxRedirects?: number;
  accept?: string;
  referer?: string;
};

export const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function combineSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const list = signals.filter((s): s is AbortSignal => !!s);
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (any) return any(list);
  const ctrl = new AbortController();
  for (const s of list) {
    if (s.aborted) { ctrl.abort(s.reason); break; }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

function kindOf(contentType: string, url: string, head: Uint8Array): FetchKind {
  const ct = contentType.toLowerCase();
  if (ct.includes("application/pdf") || (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46)) return "pdf";
  if (ct.includes("html") || ct.includes("xhtml")) return "html";
  if (ct.includes("json")) return "json";
  if (ct.includes("xml") || ct.includes("rss") || ct.includes("atom")) return "xml";
  if (ct.startsWith("text/")) return "text";
  if (!ct || ct.includes("octet-stream")) {
    if (/\.pdf($|\?)/i.test(url)) return "pdf";
    const sniff = new TextDecoder().decode(head.slice(0, 512)).trimStart().toLowerCase();
    if (sniff.startsWith("<!doctype html") || sniff.startsWith("<html") || sniff.includes("<body")) return "html";
    if (sniff.startsWith("{") || sniff.startsWith("[")) return "json";
    if (sniff.startsWith("<?xml")) return "xml";
  }
  return "binary";
}

function decode(bytes: Uint8Array, contentType: string): string {
  let charset = contentType.match(/charset=["']?([\w-]+)/i)?.[1];
  if (!charset) {
    const head = new TextDecoder("latin1").decode(bytes.slice(0, 4096));
    charset = head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  }
  try {
    return new TextDecoder((charset ?? "utf-8").toLowerCase(), { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

export async function readCapped(res: Response, max: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared && declared > max * 1.5) {
    await res.body?.cancel().catch(() => {});
    throw new CrawlError("too_large", `This file is too large to read (${Math.round(declared / 1_000_000)} MB).`);
  }
  if (!res.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason ?? new Error("aborted");
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > max) {
        parts.push(value.subarray(0, max - size));
        size = max;
        truncated = true;
        break;
      }
      parts.push(value);
      size += value.byteLength;
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.byteLength; }
  return { bytes: out, truncated };
}

export async function fetchPage(rawUrl: string, opts: FetchOptions = {}): Promise<FetchedPage> {
  const started = Date.now();
  const first = checkUrlSafety(rawUrl);
  if (!first.ok) throw new CrawlError("blocked", first.reason);
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 20000);
  const signal = combineSignals(opts.signal, timeout);
  const redirects: string[] = [];
  let url = first.url.toString();
  const maxRedirects = opts.maxRedirects ?? 5;
  try {
    for (let hop = 0; ; hop++) {
      const res = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: opts.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.5",
          "Accept-Language": "en-IN,en;q=0.9,hi;q=0.8",
          ...(opts.referer ? { Referer: opts.referer } : {}),
        },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel().catch(() => {});
        if (hop >= maxRedirects) throw new CrawlError("network", "This link redirects too many times.");
        const next = new URL(res.headers.get("location")!, url).toString();
        const safe = checkUrlSafety(next);
        if (!safe.ok) throw new CrawlError("blocked", `The link redirected to a blocked address. ${safe.reason}`);
        redirects.push(url);
        url = safe.url.toString();
        continue;
      }
      const contentType = res.headers.get("content-type") ?? "";
      const peekKind = contentType.includes("pdf") || /\.pdf($|\?)/i.test(url) ? "pdf" : "other";
      const cap = peekKind === "pdf" ? opts.maxPdfBytes ?? 15_000_000 : opts.maxHtmlBytes ?? 3_000_000;
      const { bytes, truncated } = await readCapped(res, cap, signal);
      const kind = kindOf(contentType, url, bytes.subarray(0, 512));
      if (kind === "pdf" && truncated) throw new CrawlError("too_large", "This PDF is larger than 15 MB. Upload it directly instead.");
      const page: FetchedPage = {
        requestedUrl: rawUrl, url, status: res.status, contentType, kind, redirects, elapsedMs: Date.now() - started, truncated,
        ...(res.headers.get("last-modified") ? { lastModified: res.headers.get("last-modified")! } : {}),
      };
      if (kind === "pdf" || kind === "binary") page.bytes = bytes;
      else page.text = decode(bytes, contentType);
      return page;
    }
  } catch (error) {
    if (error instanceof CrawlError) throw error;
    if (opts.signal?.aborted) throw new CrawlError("cancelled", "Stopped.");
    if (timeout.aborted) throw new CrawlError("timeout", "The website took too long to answer.");
    throw new CrawlError("network", "The website could not be reached.");
  }
}
