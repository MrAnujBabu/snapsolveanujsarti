/**
 * AsyncWebCrawler port: arun() = fetch → scrape → markdown + citations → fit markdown (Pruning or
 * BM25) with caching; arunMany() = semaphore dispatcher with a per-site polite delay.
 */
import { fetchArchived, fetchRendered, rendererAvailable } from "./browser-reader.server";
import { canRead, canWrite, LruCache, type CacheMode } from "./cache";
import { CrawlError, fetchPage, type FetchedPage, type FetchOptions } from "./fetcher.server";
import { bm25Filter, pruningFilter, rankPassages } from "./filters";
import { generateMarkdown, type MarkdownResult } from "./markdown";
import { CrawlAiError } from "./llm.server";
import { pdfPagesToMarkdown, pdfToText } from "./pdf.server";
import { scrapeHtml, type PageLink, type PageMedia, type PageMetadata, type PageTable, type ScrapeOptions } from "./scrape";
import { wordCount } from "./text";
import { normalizeUrl, twinHostUrl } from "./url";

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
  /**
   * Browser rescue: "auto" re-reads JavaScript-only, bot-check and refused pages with the free
   * browser renderer and then the web archive; "always" renders every HTML page; "never" = direct only.
   */
  browser?: "auto" | "always" | "never";
  /**
   * Reader for scanned PDFs (pages that are photos, no text layer). Web research passes the Lovable AI
   * transcriber here; without it a scanned PDF is reported honestly as scanned (never as "blocked").
   * It returns page texts, or `skipped` with a reason; Stop and AI failures propagate.
   */
  scannedPdf?: (bytes: Uint8Array, info: { pageCount: number; url: string; photoPages: number[] }) => Promise<{ pages: string[] } | { skipped: string }>;
};

/** How the text was obtained: a direct read, the free browser renderer, or the web archive's copy. */
export type ReadVia = "direct" | "browser" | "archive";

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
  via: ReadVia;
  /** Date of the web archive copy when via = "archive". */
  archivedAt?: string;
  /** A PDF made of scanned pages (no text layer). */
  scanned?: boolean;
  /** The text was transcribed from scanned pages by AI (check numbers against the original). */
  ocr?: boolean;
};

const EMPTY_MD: MarkdownResult = { rawMarkdown: "", markdownWithCitations: "", referencesMarkdown: "", fitMarkdown: "", fitHtml: "" };
const MAX_MARKDOWN_CHARS = 250_000;

const cache = new LruCache<CrawlResult>(150);

function cacheKey(url: string, c: CrawlConfig) {
  return JSON.stringify([normalizeUrl(url) ?? url, c.query ?? "", c.contentFilter ?? "auto", c.bm25Threshold ?? null, c.pruningThreshold ?? null, c.thresholdType ?? null, c.scrape ?? null, !!c.ignoreLinks, !!c.ignoreImages, c.citations !== false, !!c.keepHtml, c.browser ?? "auto", !!c.scannedPdf]);
}

export function failedResult(url: string, error: unknown, elapsedMs = 0): CrawlResult {
  const e = error instanceof CrawlError ? error : new CrawlError("network", error instanceof Error ? error.message : "The page could not be read.");
  return {
    url, finalUrl: url, success: false, status: e.status ?? 0, error: e.message, errorCode: e.code, kind: "html", metadata: { title: "" },
    markdown: EMPTY_MD, links: { internal: [], external: [] }, media: { images: [], videos: [], audios: [] }, tables: [], wordCount: 0,
    fitWordCount: 0, needsBrowser: false, cached: false, elapsedMs, redirects: [], truncated: false, via: "direct",
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
    ...(config.keepHtml ? { html: page.text ?? "" } : {}), via: "direct",
  };
}

/** Mixed PDFs also need OCR when even one page carries almost no text. */
export function isScannedPdf(pages: string[]): boolean {
  return pages.some((t) => wordCount(t) < 5);
}

/** At least half the pages are photos: without OCR the PDF is not a usable source. */
export function isMostlyScannedPdf(pages: string[]): boolean {
  if (!pages.length) return false;
  return pages.filter((t) => wordCount(t) < 5).length >= Math.ceil(pages.length / 2);
}

async function fromPdf(page: FetchedPage, config: CrawlConfig): Promise<CrawlResult> {
  const bytes = page.bytes ?? new Uint8Array();
  // The PDF parser may take over (detach) the buffer it is given; keep the original for the scan reader.
  const pdf = await pdfToText(bytes.slice());
  const scanned = isScannedPdf(pdf.pages);
  const mostlyScanned = isMostlyScannedPdf(pdf.pages);
  let ocr = false;
  let scanNote = "";
  if (scanned && config.scannedPdf) {
    const photoPages = pdf.pages.flatMap((t, i) => (wordCount(t) < 5 ? [i + 1] : []));
    const read = await config.scannedPdf(bytes, { pageCount: pdf.pageCount, url: page.url, photoPages });
    // "[text layer kept]" is the AI's marker for readable pages it was told to skip; never page text.
    const ocrPages = "pages" in read ? read.pages.map((t) => t.replace(/^\s*\[text layer kept\]\s*$/gim, "").trim()) : [];
    const photoRead = photoPages.some((n) => (ocrPages[n - 1] ?? "").trim());
    if ("pages" in read && read.pages.length === pdf.pageCount && photoRead) {
      // Keep accurate embedded text on readable pages; replace only the photo pages.
      pdf.pages = ocrPages.map((text, i) => {
        const original = pdf.pages[i] ?? "";
        return wordCount(original) >= 5 ? original : text;
      });
      ocr = true;
    } else {
      scanNote = "skipped" in read ? read.skipped : "The AI transcription did not cover every PDF page reliably.";
    }
  }
  const textWords = wordCount(pdf.pages.join("\n"));
  const raw = pdfPagesToMarkdown(pdf.pages);
  let fit = "";
  if (config.query?.trim() && config.contentFilter !== "none") {
    const passages = pdf.pages.flatMap((t, p) => t.split(/\n\s*\n|(?<=[.?!])\s{2,}/).map((x) => ({ page: p + 1, text: x.trim() }))).filter((x) => x.text.split(/\s+/).length >= 6);
    const ranked = rankPassages(passages.map((p) => p.text), config.query).filter((r) => r.score >= (config.bm25Threshold ?? 1.0)).slice(0, 40);
    fit = ranked.sort((a, b) => a.index - b.index).map((r) => `[Page ${passages[r.index]!.page}] ${r.text}`).join("\n\n");
  }
  // Only real page text counts: the "(no text on this page)" placeholders are not words of the PDF.
  const words = textWords;
  const unreadScan = scanned && !ocr;
  // A mostly readable PDF with a blank/photo page stays usable, but is marked incomplete.
  const failed = page.status >= 400 || words === 0 || (unreadScan && mostlyScanned);
  const scanError = `This PDF is made of scanned pages (photos), so it has no text layer to read.${scanNote ? ` ${scanNote}` : ""}`;
  return {
    url: page.requestedUrl, finalUrl: page.url, success: !failed, status: page.status,
    ...(unreadScan && failed ? { error: scanError, errorCode: "scanned" } : words === 0 ? { error: "This PDF has no readable text.", errorCode: "empty" } : {}),
    ...(scanned ? { scanned: true } : {}), ...(ocr ? { ocr: true } : {}),
    kind: "pdf", metadata: { title: pdf.title ?? page.url.split("/").pop() ?? "PDF" },
    markdown: { rawMarkdown: cap(raw), markdownWithCitations: cap(raw), referencesMarkdown: "", fitMarkdown: cap(fit), fitHtml: "" },
    links: { internal: [], external: [] }, media: { images: [], videos: [], audios: [] }, tables: [], pages: pdf.pages,
    wordCount: words, fitWordCount: wordCount(fit), needsBrowser: false, cached: false, elapsedMs: page.elapsedMs, redirects: page.redirects,
    truncated: pdf.truncatedPages || (unreadScan && !failed), via: "direct",
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
    fitWordCount: wordCount(fit), needsBrowser: false, cached: false, elapsedMs: page.elapsedMs, redirects: page.redirects, truncated: page.truncated, via: "direct",
  };
}

async function fromPage(page: FetchedPage, config: CrawlConfig): Promise<CrawlResult> {
  if (page.kind === "html" || page.kind === "xml" && /<html/i.test(page.text ?? "")) return fromHtml(page, config);
  if (page.kind === "pdf") return fromPdf(page, config);
  if (page.kind === "text" || page.kind === "json" || page.kind === "xml") return fromText(page, config);
  throw new CrawlError("unsupported", "This link is a file type that cannot be read as text.");
}

const BLOCK_PAGE = /access denied|client challenge|just a moment|attention required|are you a robot|verify you are human|captcha|enable javascript|request blocked|forbidden|security check|unusual (?:activity|traffic)|temporarily unavailable/i;
/** Unmistakable challenge wording: counts even on long pages (a captcha page can carry a big footer). */
const STRONG_BLOCK = /are you a robot|verify (?:that )?you are (?:a )?human|confirm you are a human|captcha challenge|checking your browser|client challenge|just a moment\.\.\.|access to this page has been denied|security check required|detected unusual (?:activity|traffic)/i;

/** Bot-check and "access denied" pages; they are not readable sources. */
export function looksBlocked(r: CrawlResult): boolean {
  // Bot checks are web pages; a short PDF or text file is just short, never "blocked".
  if (!r.success || r.kind !== "html") return false;
  if (STRONG_BLOCK.test(r.metadata.title ?? "") || STRONG_BLOCK.test(plainHead(r.markdown.rawMarkdown))) return true;
  if (r.wordCount >= 80) return false;
  return BLOCK_PAGE.test(r.metadata.title ?? "") || BLOCK_PAGE.test(r.markdown.rawMarkdown.slice(0, 1500)) || r.wordCount < 25;
}

const MISSING_TITLE = /\b(?:page not found|not found|404|page unavailable|page (?:does not|doesn't) exist|no longer available|content unavailable)\b/i;
const MISSING_HEAD = /^(?:#+\s*)?(?:skip to (?:main )?content\s+#*\s*)?(?:page not found|404\b|not found\b|sorry,? (?:the|this) page|the page you (?:were looking for|requested))/i;

/**
 * Soft "page not found" pages: the site (or the browser reader, which always answers 200) shows a
 * 404 page instead of an error. They are dead links, never sources.
 */
export function looksMissing(r: CrawlResult): boolean {
  if (!r.success || r.kind !== "html" || r.wordCount >= 400) return false;
  return MISSING_TITLE.test(r.metadata.title ?? "") || MISSING_HEAD.test(plainHead(r.markdown.rawMarkdown).trim());
}

function hasBlockWording(r: CrawlResult): boolean {
  const title = r.metadata.title ?? "";
  return STRONG_BLOCK.test(title) || BLOCK_PAGE.test(title) || BLOCK_PAGE.test(r.markdown.rawMarkdown.slice(0, 1500));
}

/** The first ~60 words of the page text (links and images stripped). */
function plainHead(md: string): string {
  return md.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").split(/\s+/).slice(0, 60).join(" ");
}

/** True when a real browser (or an archived copy) could plausibly read more than the direct read did. */
export function needsRescue(r: CrawlResult): boolean {
  if (!r.success) {
    if (r.errorCode === "http") return ![404, 410].includes(r.status);
    return r.errorCode === "network" || r.errorCode === "timeout";
  }
  if (r.kind !== "html") return false;
  return r.needsBrowser || looksBlocked(r) || r.wordCount < 40;
}

/** The rescue result replaces the direct one only when it is clearly more readable. */
export function isBetterRead(candidate: CrawlResult | null, current: CrawlResult): candidate is CrawlResult {
  if (!candidate?.success || looksBlocked(candidate)) return false;
  if (!current.success || looksBlocked(current)) return true;
  return candidate.wordCount > current.wordCount * 1.2 + 20;
}

async function rescue(url: string, current: CrawlResult, config: CrawlConfig): Promise<CrawlResult> {
  const signal = config.fetch?.signal;
  const timeoutMs = Math.max(8000, config.fetch?.timeoutMs ?? 20000);
  let best = current;
  if (rendererAvailable()) {
    const rendered = await fetchRendered(url, { timeoutMs, ...(signal ? { signal } : {}) })
      .then((page) => ({ ...fromHtml(page, config), via: "browser" as const }))
      .catch((e: unknown) => {
        if (e instanceof CrawlError && e.code === "cancelled") throw e;
        return null;
      });
    // A browser-rendered "page not found" is the definitive answer: the link is dead.
    if (rendered && looksMissing(rendered)) return rendered;
    if (config.browser === "always" ? !!rendered?.success && !looksBlocked(rendered) : isBetterRead(rendered, best)) best = rendered!;
  }
  if (needsRescue(best)) {
    const archived = await fetchArchived(url, { timeoutMs, ...(signal ? { signal } : {}) });
    if (archived) {
      const r = await fromPage(archived.page, config).catch((error: unknown) => {
        if (error instanceof CrawlAiError || (error instanceof CrawlError && error.code === "cancelled")) throw error;
        return null;
      });
      const fromArchive = r ? { ...r, via: "archive" as const, archivedAt: archived.archivedAt } : null;
      if (isBetterRead(fromArchive, best)) best = fromArchive;
    }
  }
  return best;
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
    result = await fromPage(await fetchPage(url, config.fetch), config);
  } catch (error) {
    if (error instanceof CrawlAiError) throw error;
    if (error instanceof CrawlError && error.code === "cancelled") throw error;
    result = failedResult(url, error, Date.now() - started);
  }
  // Some sites refuse connections on one of their two names (www.nta.ac.in resets, nta.ac.in works):
  // one free retry on the www/no-www twin before the slower browser and archive rescue.
  const twin = !result.success && result.errorCode === "network" ? twinHostUrl(url) : null;
  if (twin) {
    try {
      const alt = await fromPage(await fetchPage(twin, config.fetch), config);
      if (alt.success) result = { ...alt, url, elapsedMs: Date.now() - started };
    } catch (error) {
      if (error instanceof CrawlAiError) throw error;
      if (error instanceof CrawlError && error.code === "cancelled") throw error;
    }
  }
  const browser = config.browser ?? "auto";
  if (browser !== "never" && (needsRescue(result) || (browser === "always" && result.success && result.kind === "html"))) {
    result = await rescue(url, result, config);
    result = { ...result, elapsedMs: Date.now() - started };
    if (looksMissing(result)) {
      // Marked as a dead link below.
    } else if (result.success && result.kind === "html" && result.wordCount < 25 && !hasBlockWording(result)) {
      result = {
        ...result, success: false, errorCode: "empty",
        error: "This page shows almost no text, even in a browser (it may be an app, a video or images). Try a different source.",
      };
    } else if (looksBlocked(result) || (!result.success && result.errorCode === "http" && [401, 403, 429, 503].includes(result.status))) {
      result = {
        ...result, success: false, errorCode: "blocked_site",
        error: "This website blocks automatic readers. A browser and the web archive were tried too. Open the link yourself, or try a different source.",
      };
    }
  }
  if (looksMissing(result)) {
    result = {
      ...result, success: false, status: 404, errorCode: "http",
      error: "This page no longer exists on the website (page not found). Try a different source.",
    };
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
