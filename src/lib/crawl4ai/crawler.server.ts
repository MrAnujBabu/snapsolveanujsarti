/**
 * AsyncWebCrawler port: arun() = fetch → scrape → markdown + citations → fit markdown (Pruning or
 * BM25) with caching; arunMany() = semaphore dispatcher with a per-site polite delay.
 */
import { canRead, canWrite, LruCache, type CacheMode } from "./cache";
import { CrawlError, fetchPage, type FetchedPage, type FetchOptions } from "./fetcher.server";
import { bm25Filter, pruningFilter, rankPassages } from "./filters";
import { generateMarkdown, type MarkdownResult } from "./markdown";
import { pdfPagesToMarkdown, pdfToText } from "./pdf.server";
import { scrapeHtml, type PageLink, type PageMedia, type PageMetadata, type PageTable, type ScrapeOptions } from "./scrape";
import { wordCount } from "./text";
import { normalizeUrl } from "./url";

export type ContentFilterChoice = "auto" | "pruning" | "bm25" | "none";

export type CrawlConfig = {
  /** Focus query: BM25 fit markdown keeps only passages about it. */
  query?: string;
  contentFilter?: ContentFilterChoice;
  bm25Threshold?: number;
  pruningThreshold?: number;
  thresholdType?: "fixed" | "dynamic";
  scrape?: ScrapeOptions;
  ignoreLinks?: boolean;
  ignoreImages?: boolean;
  citations?: boolean;
  cacheMode?: CacheMode;
  fetch?: FetchOptions;
  /** Keep the original HTML on the result (CSS-schema extraction needs classes and ids). */
  keepHtml?: boolean;
};

export type CrawlResult = {
  url: string;
  finalUrl: string;
  success: boolean;
  status: number;
  error?: string;
  errorCode?: string;
  kind: "html" | "pdf" | "text";
  metadata: PageMetadata;
  markdown: MarkdownResult;
  links: { internal: PageLink[]; external: PageLink[] };
  media: PageMedia;
  tables: PageTable[];
  pages?: string[];
  wordCount: number;
  fitWordCount: number;
  /** Little text and an app shell: the page probably needs a real browser to render. */
  needsBrowser: boolean;
  cached: boolean;
  elapsedMs: number;
  redirects: string[];
  truncated: boolean;
  html?: string;
};

const EMPTY_MD: MarkdownResult = { rawMarkdown: "", markdownWithCitations: "", referencesMarkdown: "", fitMarkdown: "", fitHtml: "" };
const MAX_MARKDOWN_CHARS = 250_000;

const cache = new LruCache<CrawlResult>(150);

function cacheKey(url: string, c: CrawlConfig) {
  return JSON.stringify([normalizeUrl(url) ?? url, c.query ?? "", c.contentFilter ?? "auto", c.bm25Threshold ?? null, c.pruningThreshold ?? null, c.thresholdType ?? null, c.scrape ?? null, !!c.ignoreLinks, !!c.ignoreImages, c.citations !== false, !!c.keepHtml]);
}

export function failedResult(url: string, error: unknown, elapsedMs = 0): CrawlResult {
  const e = error instanceof CrawlError ? error : new CrawlError("network", error instanceof Error ? error.message : "The page could not be read.");
  return {
    url, finalUrl: url, success: false, status: e.status ?? 0, error: e.message, errorCode: e.code, kind: "html", metadata: { title: "" },
    markdown: EMPTY_MD, links: { internal: [], external: [] }, media: { images: [], videos: [], audios: [] }, tables: [], wordCount: 0,
    fitWordCount: 0, needsBrowser: false, cached: false, elapsedMs, redirects: [], truncated: false,
  };
}

const cap = (s: string) => (s.length > MAX_MARKDOWN_CHARS ? `${s.slice(0, MAX_MARKDOWN_CHARS)}\n\n…(truncated)` : s);

function fromHtml(page: FetchedPage, config: CrawlConfig): CrawlResult {
  const scraped = scrapeHtml(page.text ?? "", page.url, config.scrape);
  const filter = config.contentFilter ?? "auto";
  const useBm25 = filter === "bm25" || (filter === "auto" && !!config.query?.trim());
  let filtered: string[] | null = null;
  if (filter !== "none") {
    filtered = useBm25
      ? bm25Filter(scraped.root, config.query, { threshold: config.bm25Threshold ?? 1.0 })
      : pruningFilter(scraped.root, { threshold: config.pruningThreshold ?? 0.48, thresholdType: config.thresholdType ?? "fixed" });
  }
  const md = generateMarkdown(scraped.root, {
    baseUrl: page.url, citations: config.citations !== false, filtered,
    ...(config.ignoreLinks ? { ignoreLinks: true } : {}), ...(config.ignoreImages ? { ignoreImages: true } : {}),
  });
  const words = wordCount(md.rawMarkdown);
  const shell = /id=["'](root|app|__next|__nuxt|svelte)["']|data-reactroot|ng-version/i.test(page.text ?? "");
  return {
    url: page.requestedUrl, finalUrl: page.url, success: page.status < 400, status: page.status,
    ...(page.status >= 400 ? { error: `The website answered with error ${page.status}.`, errorCode: "http" } : {}),
    kind: "html", metadata: scraped.metadata,
    markdown: { ...md, rawMarkdown: cap(md.rawMarkdown), markdownWithCitations: cap(md.markdownWithCitations), fitMarkdown: cap(md.fitMarkdown), fitHtml: md.fitHtml.slice(0, MAX_MARKDOWN_CHARS) },
    links: scraped.links, media: scraped.media, tables: scraped.tables, wordCount: words, fitWordCount: wordCount(md.fitMarkdown),
    needsBrowser: words < 40 && shell, cached: false, elapsedMs: page.elapsedMs, redirects: page.redirects, truncated: page.truncated,
    ...(config.keepHtml ? { html: page.text ?? "" } : {}),
  };
}

async function fromPdf(page: FetchedPage, config: CrawlConfig): Promise<CrawlResult> {
  const pdf = await pdfToText(page.bytes ?? new Uint8Array());
  const raw = pdfPagesToMarkdown(pdf.pages);
  let fit = "";
  if (config.query?.trim() && config.contentFilter !== "none") {
    const passages = pdf.pages.flatMap((t, p) => t.split(/\n\s*\n|(?<=[.?!])\s{2,}/).map((x) => ({ page: p + 1, text: x.trim() }))).filter((x) => x.text.split(/\s+/).length >= 6);
    const ranked = rankPassages(passages.map((p) => p.text), config.query).filter((r) => r.score >= (config.bm25Threshold ?? 1.0)).slice(0, 40);
    fit = ranked.sort((a, b) => a.index - b.index).map((r) => `[Page ${passages[r.index]!.page}] ${r.text}`).join("\n\n");
  }
  const words = wordCount(raw);
  return {
    url: page.requestedUrl, finalUrl: page.url, success: page.status < 400 && words > 0, status: page.status,
    ...(words === 0 ? { error: "This PDF has no readable text (it may be scanned images).", errorCode: "empty" } : {}),
    kind: "pdf", metadata: { title: pdf.title ?? page.url.split("/").pop() ?? "PDF" },
    markdown: { rawMarkdown: cap(raw), markdownWithCitations: cap(raw), referencesMarkdown: "", fitMarkdown: cap(fit), fitHtml: "" },
    links: { internal: [], external: [] }, media: { images: [], videos: [], audios: [] }, tables: [], pages: pdf.pages,
    wordCount: words, fitWordCount: wordCount(fit), needsBrowser: false, cached: false, elapsedMs: page.elapsedMs, redirects: page.redirects,
    truncated: pdf.truncatedPages,
  };
}

function fromText(page: FetchedPage, config: CrawlConfig): CrawlResult {
  let text = page.text ?? "";
  if (page.kind === "json") {
    try { text = "```json\n" + JSON.stringify(JSON.parse(text), null, 2).slice(0, MAX_MARKDOWN_CHARS) + "\n```"; } catch { /* keep raw */ }
  }
  let fit = "";
  if (config.query?.trim() && page.kind !== "json") {
    const paras = text.split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean);
    fit = rankPassages(paras, config.query).filter((r) => r.score >= (config.bm25Threshold ?? 1.0)).slice(0, 40).sort((a, b) => a.index - b.index).map((r) => r.text).join("\n\n");
  }
  return {
    url: page.requestedUrl, finalUrl: page.url, success: page.status < 400, status: page.status,
    ...(page.status >= 400 ? { error: `The website answered with error ${page.status}.`, errorCode: "http" } : {}),
    kind: "text", metadata: { title: page.url.split("/").pop() || page.url },
    markdown: { rawMarkdown: cap(text), markdownWithCitations: cap(text), referencesMarkdown: "", fitMarkdown: cap(fit), fitHtml: "" },
    links: { internal: [], external: [] }, media: { images: [], videos: [], audios: [] }, tables: [], wordCount: wordCount(text),
    fitWordCount: wordCount(fit), needsBrowser: false, cached: false, elapsedMs: page.elapsedMs, redirects: page.redirects, truncated: page.truncated,
  };
}

/** arun(): one URL through the whole pipeline. Never throws for page problems — see success/error. */
export async function crawl(url: string, config: CrawlConfig = {}): Promise<CrawlResult> {
  const mode = config.cacheMode ?? "enabled";
  const key = cacheKey(url, config);
  if (canRead(mode)) {
    const hit = cache.get(key);
    if (hit) return { ...hit, cached: true };
  }
  const started = Date.now();
  let result: CrawlResult;
  try {
    const page = await fetchPage(url, config.fetch);
    if (page.kind === "html" || page.kind === "xml" && /<html/i.test(page.text ?? "")) result = fromHtml(page, config);
    else if (page.kind === "pdf") result = await fromPdf(page, config);
    else if (page.kind === "text" || page.kind === "json" || page.kind === "xml") result = fromText(page, config);
    else throw new CrawlError("unsupported", "This link is a file type that cannot be read as text.");
  } catch (error) {
    if (error instanceof CrawlError && error.code === "cancelled") throw error;
    return failedResult(url, error, Date.now() - started);
  }
  if (result.success && canWrite(mode)) cache.set(key, result);
  return result;
}

/** The markdown a reader should get: fit markdown when it kept enough, otherwise the full page. */
export function bestMarkdown(r: CrawlResult, opts: { preferFit?: boolean; citations?: boolean } = {}): string {
  const full = opts.citations ? r.markdown.markdownWithCitations + r.markdown.referencesMarkdown : r.markdown.rawMarkdown;
  if (opts.preferFit === false || !r.markdown.fitMarkdown.trim()) return full;
  const enough = r.fitWordCount >= Math.min(80, r.wordCount) && r.fitWordCount >= r.wordCount * 0.15;
  return enough ? r.markdown.fitMarkdown : full;
}

export type ManyOptions = { concurrency?: number; perSiteDelayMs?: number; signal?: AbortSignal; onResult?: (r: CrawlResult, i: number) => void };

/** arun_many(): bounded concurrency with a per-site delay (Crawl4AI RateLimiter base_delay). */
export async function crawlMany(urls: string[], config: CrawlConfig = {}, opts: ManyOptions = {}): Promise<CrawlResult[]> {
  const results: CrawlResult[] = new Array(urls.length);
  const lastHit = new Map<string, number>();
  const delay = opts.perSiteDelayMs ?? 400;
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      if (opts.signal?.aborted) throw new CrawlError("cancelled", "Stopped.");
      const i = next++;
      const url = urls[i]!;
      let host = "";
      try { host = new URL(url).host; } catch { /* invalid URLs fail inside crawl */ }
      const wait = (lastHit.get(host) ?? 0) + delay - Date.now();
      lastHit.set(host, Math.max(Date.now(), (lastHit.get(host) ?? 0) + delay));
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const r = await crawl(url, { ...config, fetch: { ...config.fetch, ...(opts.signal ? { signal: opts.signal } : {}) } });
      results[i] = r;
      opts.onResult?.(r, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 4, urls.length) }, worker));
  return results;
}

export function clearCrawlCache() {
  cache.clear();
}
