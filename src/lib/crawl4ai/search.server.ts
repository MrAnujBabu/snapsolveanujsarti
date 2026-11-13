/**
 * Search for the Crawl4AI port. Crawl4AI crawls URLs it is given; discovery here is Lovable AI web
 * search (gpt-6-astra + web_search tool, billed to Lovable AI credits). The found pages are then
 * crawled for free and BM25-filtered against the query, so answers rest on text actually read.
 */
import { crawlMany, looksBlocked, type CrawlConfig, type CrawlResult } from "./crawler.server";
import { rankPassages } from "./filters";
import { runResponse, type UsageMeter } from "./llm.server";
import { normalizeUrl, parseHttpUrl, urlContentType } from "./url";

export type SearchHit = { url: string; title?: string; snippet: string; cited: boolean };
export type WebSearchResult = { query: string; summary: string; hits: SearchHit[]; queries: string[] };

const SEARCH_INSTRUCTIONS = `You are the search step of a study research tool for Indian NEET/JEE/board students.
Search the live web for the user's query. Prefer official and authoritative sources (NTA, NCERT, CBSE, government sites, universities, journals, reputable publications) over coaching blogs and forums.
Then write a short factual summary (at most 120 words) of what the sources say, citing them inline. Use plain sentences, include exact dates, numbers and names when found. If sources disagree, say so. Do not invent anything not found in the sources.
Always run at least one web search, even for short or vague queries. Never reply with a clarifying question instead of searching: pick the most likely meaning for an Indian NEET/JEE student (for example, an unnamed exam usually means NEET), search for it, and state the assumption in one short sentence. The summary must report facts from the sources and must never be a question back to the user.`;

/** Removes markdown links/images and citation wrappers, leaving readable text. */
export function plainText(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\(\[([^\]]+)\]\([^)]+\)\)/g, "")
    .replace(/\[([^\]]+)\]\((?:[^()\s]|\([^()]*\))*(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/⟨\d+⟩/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function lineAround(text: string, start: number): string {
  const s = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const e = text.indexOf("\n", start);
  return plainText(text.slice(s, e < 0 ? undefined : e)).replace(/^[-*\d.\s]+/, "").slice(0, 400);
}

export async function aiWebSearch(
  query: string,
  opts: { allowedDomains?: string[]; maxResults?: number; contextSize?: "low" | "medium" | "high"; effort?: "low" | "medium" | "high"; signal?: AbortSignal; meter?: UsageMeter; extraInstructions?: string } = {},
): Promise<WebSearchResult> {
  const r = await runResponse({
    instructions: SEARCH_INSTRUCTIONS + (opts.extraInstructions ? `\n${opts.extraInstructions}` : ""),
    input: query.slice(0, 600),
    ...(opts.effort ? { effort: opts.effort } : {}),
    webSearch: { contextSize: opts.contextSize ?? "low", ...(opts.allowedDomains?.length ? { allowedDomains: opts.allowedDomains } : {}) },
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.meter ? { meter: opts.meter } : {}),
  });
  const hits = new Map<string, SearchHit>();
  for (const c of r.citations) {
    const url = normalizeUrl(c.url);
    if (!url) continue;
    const prev = hits.get(url);
    if (!prev) hits.set(url, { url, ...(c.title ? { title: c.title } : {}), snippet: lineAround(r.text, c.start), cited: true });
    else if (!prev.title && c.title) prev.title = c.title;
  }
  for (const s of r.sources) {
    const url = normalizeUrl(s);
    if (url && !hits.has(url)) hits.set(url, { url, snippet: "", cited: false });
  }
  const allowed = opts.allowedDomains?.map((d) => d.toLowerCase());
  const list = [...hits.values()].filter((h) => {
    if (!allowed?.length) return true;
    const host = parseHttpUrl(h.url)?.hostname.toLowerCase() ?? "";
    return allowed.some((d) => host === d || host.endsWith(`.${d}`));
  });
  return { query, summary: plainText(r.text), hits: list.slice(0, opts.maxResults ?? 10), queries: r.queries };
}

export type SearchPage = SearchHit & { excerpt: string; crawled: boolean; words: number; error?: string; kind?: CrawlResult["kind"] };

/** PDF pages arrive as one block: cut long blocks into ~size windows at sentence ends. */
function splitLong(p: string, size: number): string[] {
  if (p.length <= size * 1.5) return [p];
  const sentences = p.match(/[^.!?\n]+(?:[.!?]+|\n|$)/g) ?? [p];
  const out: string[] = [];
  let cur = "";
  for (const sentence of sentences) {
    if (cur && cur.length + sentence.length > size) { out.push(cur.trim()); cur = ""; }
    cur += sentence;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * The passages that best answer `query`, highest BM25 score first until `maxChars`, then put back
 * in page order — so a long page or PDF contributes its most relevant lines, not its first ones.
 */
export function focusedExcerpt(markdown: string, query: string, maxChars: number): string {
  const text = plainText(markdown);
  if (text.length <= maxChars || !query.trim()) return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  const passages = text.split(/\n\s*\n/).flatMap((p) => splitLong(p.trim(), 700)).filter((p) => p.length >= 40);
  const ranked = rankPassages(passages, query).filter((r) => r.score > 0);
  if (!ranked.length) return `${text.slice(0, maxChars)}…`;
  const picked: typeof ranked = [];
  let used = 0;
  for (const r of ranked) {
    const piece = r.text.length > maxChars ? `${r.text.slice(0, maxChars - used)}…` : r.text;
    if (used + piece.length > maxChars && picked.length) continue;
    picked.push({ ...r, text: piece });
    used += piece.length + 2;
    if (used >= maxChars * 0.95) break;
  }
  return picked.sort((a, b) => a.index - b.index).map((r) => r.text).join("\n\n");
}

export function pageExcerpt(r: CrawlResult, maxChars = 1200, query = ""): string {
  const fit = plainText(r.markdown.fitMarkdown);
  if (query.trim()) return focusedExcerpt(r.markdown.rawMarkdown, query, maxChars);
  const body = fit.length >= 120 ? fit : plainText(r.markdown.rawMarkdown);
  return body.length > maxChars ? `${body.slice(0, maxChars)}…` : body;
}

export { looksBlocked } from "./crawler.server";

/** Search → crawl the best hits → BM25 excerpts about the query. */
export async function searchAndCrawl(
  query: string,
  opts: {
    allowedDomains?: string[];
    maxPages?: number;
    /** Extra hits read in the same batch so blocked or unreadable pages can be replaced. */
    sparePages?: number;
    maxResults?: number;
    excerptChars?: number;
    pageTimeoutMs?: number;
    /** Search depth: "high" + "high" effort for Deep research. */
    contextSize?: "low" | "medium" | "high";
    effort?: "low" | "medium" | "high";
    extraInstructions?: string;
    /** Scanned-PDF reader (Lovable AI) for the pages read. */
    scannedPdf?: CrawlConfig["scannedPdf"];
    signal?: AbortSignal;
    meter?: UsageMeter;
    onSearch?: (r: WebSearchResult) => void;
    onPage?: (page: SearchPage, result: CrawlResult) => void;
  } = {},
): Promise<{ search: WebSearchResult; pages: SearchPage[]; results: CrawlResult[] }> {
  const search = await aiWebSearch(query, {
    ...(opts.allowedDomains ? { allowedDomains: opts.allowedDomains } : {}),
    maxResults: opts.maxResults ?? 10,
    ...(opts.contextSize ? { contextSize: opts.contextSize } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...(opts.extraInstructions ? { extraInstructions: opts.extraInstructions } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.meter ? { meter: opts.meter } : {}),
  });
  opts.onSearch?.(search);
  const readable = search.hits.filter((h) => ["text/html", "application/pdf", "text/plain", "unknown"].includes(urlContentType(h.url)));
  const targets = [...readable.filter((h) => h.cited), ...readable.filter((h) => !h.cited)].slice(0, (opts.maxPages ?? 4) + (opts.sparePages ?? 0));
  const pages: SearchPage[] = [];
  const passageQuery = [query, ...search.queries.slice(0, 3)].join(" ").slice(0, 600);
  const results = await crawlMany(
    targets.map((t) => t.url),
    // Rank passages with the search's own queries too: they use the sources' wording
    // (e.g. "peripheral neuropathy prevalence") when the student's words differ ("nerve fibre cases").
    { query: passageQuery, fetch: { timeoutMs: opts.pageTimeoutMs ?? 10000 }, ...(opts.scannedPdf ? { scannedPdf: opts.scannedPdf } : {}) },
    {
      concurrency: 4,
      ...(opts.signal ? { signal: opts.signal } : {}),
      onResult: (r, i) => {
        const hit = targets[i]!;
        const blocked = looksBlocked(r);
        const page: SearchPage = {
          ...hit,
          title: hit.title || r.metadata.title || hit.url,
          excerpt: r.success && !blocked ? pageExcerpt(r, opts.excerptChars ?? 1200, passageQuery) : "",
          crawled: r.success && !blocked,
          words: r.wordCount,
          kind: r.kind,
          ...(r.success && !blocked ? {} : { error: blocked ? "The website showed a bot check instead of the page." : (r.error ?? "Could not read this page.") }),
        };
        pages[i] = page;
        opts.onPage?.(page, r);
      },
    },
  );
  return { search, pages: pages.filter(Boolean), results };
}
