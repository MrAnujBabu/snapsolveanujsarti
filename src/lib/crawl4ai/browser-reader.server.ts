/**
 * No-cost "browser" for the edge server. Crawl4AI renders pages in Playwright; this app cannot run a
 * browser, so pages that need one are rescued by:
 *  1. a free public browser renderer (r.jina.ai) that returns the rendered HTML — it then runs
 *     through the same scrape → markdown → filter pipeline as a direct read, and
 *  2. the Internet Archive's latest saved copy, for sites that block readers entirely.
 * Both are optional helpers: when they are busy or fail, the direct result is kept. A 429 from the
 * renderer pauses it briefly so a busy minute never multiplies into many failing calls.
 */
import { combineSignals, CrawlError, fetchPage, readCapped, type FetchedPage } from "./fetcher.server";
import { checkUrlSafety } from "./url";

export const RENDERER_ORIGIN = "https://r.jina.ai";
const MAX_RENDERED_BYTES = 3_000_000;
const RENDERER_COOLDOWN_MS = 60_000;

let rendererPausedUntil = 0;

export function rendererAvailable(now = Date.now()): boolean {
  return now >= rendererPausedUntil;
}

/** Test hook. */
export function resetRendererPause() {
  rendererPausedUntil = 0;
}

type RenderOptions = { signal?: AbortSignal; timeoutMs?: number };

async function callRenderer(url: string, format: "html" | "screenshot" | "pageshot", opts: RenderOptions): Promise<Response> {
  const safe = checkUrlSafety(url);
  if (!safe.ok) throw new CrawlError("blocked", safe.reason);
  if (!rendererAvailable()) throw new CrawlError("network", "The browser reader is busy. Try again in a minute.");
  const timeoutMs = Math.max(6000, Math.min(opts.timeoutMs ?? 20000, format === "html" ? 30000 : 45000));
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = combineSignals(opts.signal, timeout);
  let res: Response;
  try {
    res = await fetch(`${RENDERER_ORIGIN}/${safe.url.toString()}`, {
      method: "GET",
      signal,
      // Screenshots answer with a redirect to the image; keep the link instead of downloading the image.
      redirect: format === "html" ? "follow" : "manual",
      headers: {
        "X-Return-Format": format,
        "X-Timeout": String(Math.max(5, Math.floor(timeoutMs / 1000) - 2)),
        Accept: "text/plain, text/html;q=0.9, */*;q=0.5",
      },
    });
  } catch {
    if (opts.signal?.aborted) throw new CrawlError("cancelled", "Stopped.");
    if (timeout.aborted) throw new CrawlError("timeout", "The browser reader took too long.");
    throw new CrawlError("network", "The browser reader could not be reached.");
  }
  if (res.status === 429) {
    rendererPausedUntil = Date.now() + RENDERER_COOLDOWN_MS;
    await res.body?.cancel().catch(() => {});
    throw new CrawlError("http", "The browser reader is busy. Try again in a minute.", 429);
  }
  if (!res.ok && !(format !== "html" && res.status >= 300 && res.status < 400)) {
    await res.body?.cancel().catch(() => {});
    throw new CrawlError("http", `The browser reader could not open this page (error ${res.status}).`, res.status);
  }
  return res;
}

/** The page as a real browser renders it (JavaScript run), shaped like a direct fetch. */
export async function fetchRendered(url: string, opts: RenderOptions = {}): Promise<FetchedPage> {
  const started = Date.now();
  const res = await callRenderer(url, "html", opts);
  const signal = opts.signal ?? new AbortController().signal;
  const { bytes, truncated } = await readCapped(res, MAX_RENDERED_BYTES, signal);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (!/<(html|body|div|p|main|article)[\s>]/i.test(text)) throw new CrawlError("empty", "The browser reader returned no page.");
  return { requestedUrl: url, url, status: 200, contentType: "text/html; charset=utf-8", kind: "html", text, redirects: [], elapsedMs: Date.now() - started, truncated };
}

/** A screenshot of the rendered page; returns a temporary image link (valid for a few hours). */
export async function screenshotPage(url: string, opts: RenderOptions & { fullPage?: boolean } = {}): Promise<string | null> {
  try {
    const res = await callRenderer(url, opts.fullPage ? "pageshot" : "screenshot", { ...opts, timeoutMs: opts.timeoutMs ?? 45000 });
    const location = res.headers.get("location");
    const body = location ? "" : (await res.text()).trim().slice(0, 4000);
    if (location) await res.body?.cancel().catch(() => {});
    const link = location ?? body.split(/\s+/).find((w) => /^https:\/\/\S+$/.test(w));
    return link && /^https:\/\//.test(link) ? link : null;
  } catch (e) {
    if (e instanceof CrawlError && e.code === "cancelled") throw e;
    return null;
  }
}

export type ArchivedCopy = { page: FetchedPage; archivedAt: string; snapshotUrl: string };

/** "20240131120000" → "2024-01-31". */
export function archiveDate(timestamp: string): string {
  const m = timestamp.match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : timestamp;
}

/** The Internet Archive's latest saved copy of a page, read raw (no archive toolbar). */
export async function fetchArchived(url: string, opts: RenderOptions = {}): Promise<ArchivedCopy | null> {
  const safe = checkUrlSafety(url);
  if (!safe.ok) return null;
  const target = safe.url.toString();
  try {
    const look = await fetchPage(`https://archive.org/wayback/available?url=${encodeURIComponent(target)}`, {
      timeoutMs: 6000, accept: "application/json", ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const info = JSON.parse(look.text ?? "{}") as { archived_snapshots?: { closest?: { available?: boolean; status?: string; timestamp?: string } } };
    const closest = info.archived_snapshots?.closest;
    if (!closest?.available || !closest.timestamp || (closest.status && closest.status !== "200")) return null;
    const snapshotUrl = `https://web.archive.org/web/${closest.timestamp}id_/${target}`;
    const page = await fetchPage(snapshotUrl, { timeoutMs: opts.timeoutMs ?? 15000, ...(opts.signal ? { signal: opts.signal } : {}) });
    if (page.status >= 400) return null;
    return { page: { ...page, requestedUrl: url, url: target }, archivedAt: archiveDate(closest.timestamp), snapshotUrl };
  } catch (e) {
    if (e instanceof CrawlError && e.code === "cancelled") throw e;
    return null;
  }
}
