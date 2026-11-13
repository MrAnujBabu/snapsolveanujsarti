import { tool } from "ai";
import { z } from "zod";
import { isNcertUrl, MAX_TOOL_CALLS, NCERT_BOOKS, bookKey, textbookUrl, trim } from "./ncert";
import { earlyFallback } from "./fallback";
import { aiSearchForTool, crawlRead, type OnRead } from "@/lib/crawl4ai/agent-bridge.server";
import { FEEDBACK_CATEGORIES } from "@/lib/learning/lessons";

export type OnProblem = (p: { category: string; tool: string; message: string }) => Promise<void> | void;

const GW = "https://connector-gateway.lovable.dev";

// Per-provider cap so one slow service never stalls the answer (the gateway itself allows ~60s).
const SEARCH_TIMEOUT_MS = 8000;
const EXTRACT_TIMEOUT_MS = 15000;
const PDF_EXTRACT_TIMEOUT_MS = 25000;
const SCRAPE_TIMEOUT_MS = 20000;

async function gw(connector: string, keyName: string, path: string, body: unknown, timeoutMs = 15000) {
  const lovable = process.env["LOVABLE_API_KEY"];
  const key = process.env[keyName];
  if (!lovable || !key) throw new Error(`${connector} not configured`);
  const res = await fetch(`${GW}/${connector}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${lovable}`,
      "X-Connection-Api-Key": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const t = await res.text();
    console.error(`${connector} failed [${res.status}]: ${t}`);
    throw new Error(`${connector} failed [${res.status}]`);
  }
  return res.json() as Promise<any>;
}

/** Tools for one request; a shared counter caps paid calls per answer. */
/** fastSearch skips reading the found pages (voice calls need answers within seconds). */
/** onRead reports every page the tools tried to open (reader reliability tracking). */
/** onProblem enables report_problem: the tutor tells the developers when tools or instructions get in its way. */
export function createAgentTools(opts?: { webSearch?: boolean; fastSearch?: boolean; onRead?: OnRead; onProblem?: OnProblem }) {
  const track = opts?.onRead ? { onRead: opts.onRead } : {};
  let calls = 0;
  const guard = () => {
    calls += 1;
    if (calls > MAX_TOOL_CALLS) throw new Error("Tool budget used up — answer with what you have.");
  };

  const webSearchTool = tool({
    description:
      "Search the live web for real, current information (news, facts, dates, stats, anything beyond NCERT). Only available when the student turned Web search on. Returns titled results with links and snippets — cite the links you use.",
    inputSchema: z.object({
      query: z.string().describe("Short search keywords, e.g. 'NEET 2027 exam date NTA'"),
    }),
    execute: async ({ query }, { abortSignal }) => {
      guard();
      // Crawl4AI search on Lovable AI first: AI web search, then the best pages are read for real.
      const ai = await aiSearchForTool(query, { crawlPages: opts?.fastSearch ? 0 : 3, maxResults: 6, ...track, ...(abortSignal ? { signal: abortSignal } : {}) });
      if (ai.results.length) return { summary: ai.summary, results: ai.results };
      const seen = new Set<string>();
      const results: { title?: string; url?: string; snippet: string }[] = [];
      const push = (r: any) => {
        const url = r?.url;
        if (!url || seen.has(url)) return;
        seen.add(url);
        results.push({ title: r.title, url, snippet: trim(r.snippet ?? (r.excerpts ?? []).join(" … "), 500) });
      };
      const [ppx, par] = await Promise.allSettled([
        gw("perplexity", "PERPLEXITY_API_KEY", "/search", { query, max_results: 5 }, SEARCH_TIMEOUT_MS),
        gw("parallel", "PARALLEL_API_KEY", "/v1/search", {
          objective: `Find accurate, current information for: ${query}`,
          search_queries: [query.slice(0, 190)],
          mode: "fast",
          advanced_settings: { max_results: 5, excerpt_settings: { max_chars_per_result: 600 } },
        }, SEARCH_TIMEOUT_MS),
      ]);
      if (ppx.status === "fulfilled") (ppx.value.results ?? []).forEach(push);
      if (par.status === "fulfilled") (par.value.results ?? []).forEach(push);
      if (!results.length) return { results: [], error: "Web search returned nothing — answer from your own knowledge." };
      return { results: results.slice(0, 8) };
    },
  });

  // Web teacher: after web_search, open the best result and teach from what the page actually says.
  const openWebPageTool = tool({
    description:
      "Open and read one public web page or PDF (usually a web_search result) to teach from its exact content. Use when the search snippets are not enough — prefer official sources (NTA, NCERT, government, universities). Returns the passages that match `focus`.",
    inputSchema: z.object({
      url: z.string().describe("Full https:// link from web_search results"),
      focus: z.string().describe("What to look for on the page, e.g. 'NEET 2026 exam date'"),
    }),
    execute: async ({ url, focus }, { abortSignal }) => {
      if (!/^https?:\/\//i.test(url)) return { error: "Not a web link." };
      guard();
      const page = await crawlRead(url, { focus, maxChars: 5000, ...track, ...(abortSignal ? { signal: abortSignal } : {}) });
      return page.text ? page : { url, error: `${page.error ?? "This page could not be read."} Use the search snippets instead and do not guess the page's contents.` };
    },
  });

  const onProblem = opts?.onProblem;
  let reported = false;
  const reportProblemTool = tool({
    description:
      "Tell the SnapSolve developers about a REAL blocker: a tool that failed or returned unusable results more than once, a capability you needed but do not have, unclear or conflicting instructions, or a source that misled you. Use only when it genuinely hurt this answer — never when things worked, never to comment on the student. Not counted in the tool budget. Never mention this report to the student.",
    inputSchema: z.object({
      category: z.enum(FEEDBACK_CATEGORIES),
      tool: z.string().max(60).optional().describe("Tool name involved, e.g. ncert_read"),
      message: z.string().min(10).max(600).describe("What you tried, what went wrong, and what would have helped — specific, 1–3 sentences"),
    }),
    execute: async ({ category, tool: toolName, message }) => {
      if (reported) return { ok: false, note: "Already reported once in this answer. Continue helping the student." };
      reported = true;
      await onProblem?.({ category, tool: toolName ?? "", message });
      return { ok: true, note: "Report saved for the developers. Continue helping the student." };
    },
  });

  return {
    ...(onProblem ? { report_problem: reportProblemTool } : {}),
    ...(opts?.webSearch ? { web_search: webSearchTool, open_web_page: openWebPageTool } : {}),
    ncert_search: tool({
      description:
        "Search the official NCERT Class 11/12 textbooks (ncert.nic.in) for the chapter and exact lines covering a concept. Call this first for every new question.",
      inputSchema: z.object({
        query: z.string().describe("Short keywords, e.g. 'Newton second law momentum'"),
        classNum: z.number().describe("11 or 12"),
        subject: z.string().describe("physics, chemistry or biology"),
      }),
      execute: async ({ query, classNum, subject }, { abortSignal }) => {
        guard();
        const book = NCERT_BOOKS[bookKey(classNum, subject)];
        try {
          const data = await gw("parallel", "PARALLEL_API_KEY", "/v1/search", {
            objective: `Find the NCERT ${book?.label ?? ""} textbook section explaining: ${query}`,
            search_queries: [`NCERT class ${classNum} ${subject} ${query}`.slice(0, 190)],
            mode: "fast",
            advanced_settings: {
              max_results: 4,
              source_policy: { include_domains: ["ncert.nic.in"] },
              excerpt_settings: { max_chars_per_result: 900 },
            },
          }, SEARCH_TIMEOUT_MS);
          const results = (data.results ?? []).map((r: any) => ({
            title: r.title,
            url: r.url,
            excerpt: trim((r.excerpts ?? []).join(" … "), 900),
          }));
          if (results.length) return { book: book?.label, bookUrl: textbookUrl(classNum, subject), results };
        } catch {
          /* fall through to Lovable AI search restricted to ncert.nic.in */
        }
        const ai = await aiSearchForTool(`NCERT class ${classNum} ${subject} ${query}`, {
          allowedDomains: ["ncert.nic.in"],
          maxResults: 4,
          extraInstructions: `Find the NCERT ${book?.label ?? ""} chapter and section that explains this. Quote the NCERT wording when the search shows it.`,
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
        return {
          book: book?.label,
          bookUrl: textbookUrl(classNum, subject),
          ...(ai.summary ? { summary: ai.summary } : {}),
          results: ai.results.map((r) => ({ title: r.title, url: r.url, excerpt: trim(r.snippet, 900) })),
          ...(ai.results.length ? {} : { error: ai.error ?? "NCERT search found nothing." }),
        };
      },
    }),

    ncert_read: tool({
      description: "Read the text of one ncert.nic.in page or chapter PDF found by ncert_search, to quote NCERT exactly.",
      inputSchema: z.object({
        url: z.string(),
        focus: z.string().describe("What to look for in the page"),
      }),
      execute: async ({ url, focus }, { abortSignal }) => {
        if (!isNcertUrl(url)) return { error: "Only ncert.nic.in pages can be read." };
        guard();
        const parallelExtract = async (): Promise<{ url: string; title?: string; text?: string; error?: string }> => {
          try {
            const data = await gw("parallel", "PARALLEL_API_KEY", "/v1/extract", {
              urls: [url],
              objective: focus,
              advanced_settings: { excerpt_settings: { max_chars_per_result: 3000 } },
            }, PDF_EXTRACT_TIMEOUT_MS);
            const r = data.results?.[0];
            if (r) return { url, title: r.title, text: trim((r.excerpts ?? []).join("\n…\n")) };
          } catch {
            /* fall through to Firecrawl */
          }
          return { url, text: "", error: "No readable text found on this page." };
        };
        const firecrawlScrape = async (): Promise<{ url: string; title?: string; text?: string; error?: string }> => {
          try {
            const data = await gw("firecrawl", "FIRECRAWL_API_KEY", "/v2/scrape", {
              url,
              formats: ["markdown"],
              onlyMainContent: true,
            }, SCRAPE_TIMEOUT_MS);
            const md = data.markdown ?? data.data?.markdown ?? "";
            return { url, text: trim(md) };
          } catch (e) {
            return { url, error: String(e) };
          }
        };
        // Crawl4AI reads the page/PDF directly for free and keeps the lines about `focus`;
        // the paid readers only run when that fails (e.g. NCERT's certificate chain is rejected).
        const local = await crawlRead(url, { focus, maxChars: 3000, ...track, ...(abortSignal ? { signal: abortSignal } : {}) });
        if (local.text) return local;
        // Parallel extracts faster; if it is slow, Firecrawl starts too and the first usable text wins.
        const remote = await earlyFallback(parallelExtract(), firecrawlScrape, 4000, (r) => !!r.text);
        return remote.text ? remote : { url, error: local.error ?? remote.error ?? "No readable text found on this page." };
      },
    }),

    read_link: tool({
      description:
        "Read a web page or PDF link the STUDENT pasted (their notes, a chapter PDF, an article) so you can teach or quiz from it. Only for links the student gave.",
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }, { abortSignal }) => {
        if (!/^https?:\/\//i.test(url)) return { error: "Not a web link." };
        guard();
        const parallelRead = async (): Promise<{ url: string; title?: string; text?: string; truncated?: boolean; error?: string }> => {
          try {
            const data = await gw("parallel", "PARALLEL_API_KEY", "/v1/extract", {
              urls: [url],
              objective: "Read the student's document, preserving questions, options, answer keys and page references.",
              advanced_settings: { full_content: true, excerpt_settings: { max_chars_per_result: 12000 } },
            }, EXTRACT_TIMEOUT_MS);
            const result = data.results?.[0];
            const text = result?.full_content || (result?.excerpts ?? []).join("\n");
            if (text?.trim()) return { url, title: result.title, text: trim(text, 12000), truncated: text.length > 12000 };
          } catch { /* Fall back to the existing reader. */ }
          return { url, text: "", error: "This link returned no readable text. Upload the PDF instead; do not guess its contents." };
        };
        const firecrawlRead = async (): Promise<{ url: string; title?: string; text?: string; truncated?: boolean; error?: string }> => {
          try {
            const data = await gw("firecrawl", "FIRECRAWL_API_KEY", "/v2/scrape", {
              url,
              formats: ["markdown"],
              onlyMainContent: true,
            }, SCRAPE_TIMEOUT_MS);
            const md = data.markdown ?? data.data?.markdown ?? "";
            const title = data.metadata?.title ?? data.data?.metadata?.title;
            if (!md.trim()) return { url, error: "This link returned no readable text. Upload the PDF instead; do not guess its contents." };
            return { url, title, text: trim(md, 12000), truncated: md.length > 12000 };
          } catch (e) {
            return { url, error: String(e) };
          }
        };
        // Crawl4AI first: free direct read of the page or PDF (no AI, no connector credits).
        const local = await crawlRead(url, { maxChars: 12000, ...track, ...(abortSignal ? { signal: abortSignal } : {}) });
        if (local.text) return local;
        // Public PDF extraction is faster via Parallel; if it is slow, Firecrawl starts too and the first usable text wins.
        const remote = await earlyFallback(parallelRead(), firecrawlRead, 4000, (r) => !!r.text);
        if (remote.text) return remote;
        return { url, error: local.error && !/not configured/.test(remote.error ?? "") ? `${local.error} This link returned no readable text. Upload the PDF instead; do not guess its contents.` : remote.error ?? "This link returned no readable text. Upload the PDF instead; do not guess its contents." };
      },
    }),

    neet_pyq_search: tool({
      description: "Find NEET previous-year questions and exam trends on a topic. Use once at most, only for new questions.",
      inputSchema: z.object({ topic: z.string() }),
      execute: async ({ topic }, { abortSignal }) => {
        guard();
        const ai = await aiSearchForTool(`NEET previous year questions ${topic}`, {
          maxResults: 5,
          extraInstructions: "Focus on actual NEET (AIPMT) previous-year questions on this topic: list the years asked, question patterns and how often the topic appears. Never invent questions or years.",
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
        if (ai.results.length) return { summary: ai.summary, results: ai.results.map((r) => ({ title: r.title, url: r.url, snippet: trim(r.snippet, 500) })) };
        try {
          const data = await gw("perplexity", "PERPLEXITY_API_KEY", "/search", {
            query: `NEET previous year questions ${topic}`,
            max_results: 4,
          }, SEARCH_TIMEOUT_MS);
          return {
            results: (data.results ?? []).map((r: any) => ({
              title: r.title,
              url: r.url,
              snippet: trim(r.snippet ?? "", 500),
            })),
          };
        } catch (e) {
          return { results: [], error: String(e) };
        }
      },
    }),
  };
}
