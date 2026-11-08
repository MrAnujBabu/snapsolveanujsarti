/**
 * Crawl4AI engine as tutor tools: free direct reading first, Lovable AI web search for discovery.
 * Results are compact (links stripped, size-capped) because they go straight into the tutor's context.
 */
import { crawl } from "./crawler.server";
import { assertAiAvailable, CrawlAiError } from "./llm.server";
import { aiWebSearch, focusedExcerpt, plainText, searchAndCrawl } from "./search.server";
import { outcomeFromCrawl, siteOf, type ReadOutcome } from "./read-outcome";

/** Called once per page the reader tried to open (reliability tracking). */
export type OnRead = (outcome: ReadOutcome) => void;

export type ToolRead = { url: string; title?: string; text: string; truncated?: boolean; error?: string; pages?: number };

const cut = (s: string, max: number) => (s.length > max ? { text: `${s.slice(0, max)}…`, truncated: true } : { text: s, truncated: false });

/** Reads one page/PDF directly. Empty text means "use another reader"; error says why. */
export async function crawlRead(url: string, opts: { focus?: string; maxChars?: number; signal?: AbortSignal; timeoutMs?: number; onRead?: OnRead } = {}): Promise<ToolRead> {
  const r = await crawl(url, {
    ...(opts.focus?.trim() ? { query: opts.focus } : {}),
    fetch: { timeoutMs: opts.timeoutMs ?? 12000, ...(opts.signal ? { signal: opts.signal } : {}) },
  }).catch((e: unknown) => ({ success: false as const, error: e instanceof Error ? e.message : "Could not read this link." }));
  const empty = (error: string): ToolRead => {
    opts.onRead?.({ url, site: siteOf(url), reader: "none", ok: false, reason: "empty", detail: error, words: 0, pages: 0 });
    return { url, text: "", error };
  };
  if (!("markdown" in r)) {
    opts.onRead?.({ url, site: siteOf(url), reader: "none", ok: false, reason: "other", detail: r.error.slice(0, 200), words: 0, pages: 0 });
    return { url, text: "", error: r.error };
  }
  if (!r.success) {
    opts.onRead?.(outcomeFromCrawl(r));
    return { url, text: "", error: r.error ?? "Could not read this link." };
  }
  if (r.needsBrowser && r.wordCount < 40) return empty("This page builds its text with JavaScript, so it could not be read directly.");
  const max = opts.maxChars ?? 12000;
  const full = plainText(r.markdown.rawMarkdown);
  if (!full.trim()) return empty(r.kind === "pdf" ? "This PDF has no readable text (it may be scanned images)." : "This link returned no readable text.");
  opts.onRead?.(outcomeFromCrawl(r));
  // With a focus, keep the best-matching passages from the whole page/PDF instead of its opening lines.
  const { text, truncated } = opts.focus?.trim() && full.length > max
    ? { text: focusedExcerpt(r.markdown.rawMarkdown, opts.focus, max), truncated: true }
    : cut(full, max);
  return { url: r.finalUrl, ...(r.metadata.title ? { title: r.metadata.title } : {}), text, truncated, ...(r.pages ? { pages: r.pages.length } : {}) };
}

export type ToolSearch = { summary?: string; results: { title?: string; url: string; snippet: string; read?: boolean }[]; error?: string };

/** True when the shared AI pause allows a Lovable AI call right now. */
export async function aiSearchAvailable(): Promise<boolean> {
  try {
    await assertAiAvailable();
    return true;
  } catch {
    return false;
  }
}

/**
 * Lovable AI web search (billed to Lovable AI credits) + free crawl of the best hits so the tutor
 * gets text that was actually read. Returns error (never throws) so callers can fall back.
 */
export async function aiSearchForTool(
  query: string,
  opts: { allowedDomains?: string[]; crawlPages?: number; maxResults?: number; extraInstructions?: string; signal?: AbortSignal; onRead?: OnRead } = {},
): Promise<ToolSearch> {
  try {
    if (!(await aiSearchAvailable())) return { results: [], error: "Lovable AI search is paused." };
    if (opts.crawlPages) {
      const { search, pages } = await searchAndCrawl(query, {
        maxPages: opts.crawlPages,
        maxResults: opts.maxResults ?? 6,
        excerptChars: 700,
        pageTimeoutMs: 6000,
        ...(opts.allowedDomains ? { allowedDomains: opts.allowedDomains } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.onRead ? { onPage: (page, r) => opts.onRead?.(outcomeFromCrawl(r, r.success && !page.crawled)) } : {}),
      });
      const read = new Map(pages.map((p) => [p.url, p]));
      return {
        summary: search.summary,
        results: search.hits.slice(0, opts.maxResults ?? 6).map((h) => {
          const p = read.get(h.url);
          const snippet = p?.crawled && p.excerpt ? p.excerpt : h.snippet;
          const title = h.title || p?.title;
          return { ...(title ? { title } : {}), url: h.url, snippet: snippet.slice(0, 700), ...(p ? { read: p.crawled } : {}) };
        }),
      };
    }
    const s = await aiWebSearch(query, {
      maxResults: opts.maxResults ?? 6,
      ...(opts.allowedDomains ? { allowedDomains: opts.allowedDomains } : {}),
      ...(opts.extraInstructions ? { extraInstructions: opts.extraInstructions } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return { summary: s.summary, results: s.hits.map((h) => ({ ...(h.title ? { title: h.title } : {}), url: h.url, snippet: h.snippet })) };
  } catch (e) {
    if (e instanceof CrawlAiError) return { results: [], error: e.message };
    return { results: [], error: "Lovable AI search failed." };
  }
}
