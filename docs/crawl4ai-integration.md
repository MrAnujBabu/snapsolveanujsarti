# Crawl4AI inside SnapSolve — findings and integration plan

## 1. What Crawl4AI is (findings from the uploaded source, v0.8.x)

| Crawl4AI piece | Python source | What it does |
| --- | --- | --- |
| `AsyncWebCrawler.arun / arun_many` | `async_webcrawler.py`, `async_dispatcher.py` | Fetch a page (Playwright browser or plain HTTP), run the scraping + markdown pipeline, cache the result, dispatch many URLs with a semaphore and a per-domain rate limiter. |
| `WebScrapingStrategy` / `LXMLWebScrapingStrategy` | `content_scraping_strategy.py` | Clean HTML: drop scripts/styles/forms/iframes/comments, apply `css_selector`, `excluded_tags`, `word_count_threshold`, collect metadata, internal/external links, scored images, social-link filtering. |
| `DefaultMarkdownGenerator` | `markdown_generation_strategy.py`, `html2text/` | HTML → Markdown, then links → numbered citations `text⟨1⟩` with a `## References` block; optional "fit markdown" from a content filter. |
| `PruningContentFilter` | `content_filter_strategy.py` | Query-free boilerplate removal: per-node score from text density, link density, tag weight, class/id penalties and text length; nodes under a fixed/dynamic threshold are pruned. |
| `BM25ContentFilter` | `content_filter_strategy.py` | Query-focused filtering: split the page into text chunks, BM25Okapi-score them against the query (stemmed, stop-words removed), weight by tag priority (h1 = 5, h2 = 4 …), keep chunks above a threshold in document order. |
| `LLMContentFilter` | `content_filter_strategy.py`, `prompts.py` (`PROMPT_FILTER_CONTENT`) | LLM turns noisy HTML chunks into clean, relevant markdown following an instruction. |
| `LLMExtractionStrategy` | `extraction_strategy.py`, `prompts.py` | Token-chunked (2048 tokens, 10 % overlap, 1.3 tokens/word) LLM extraction into semantic "blocks" or into a user JSON schema; chunks run in parallel and are merged; token usage tracked. |
| `JsonCssExtractionStrategy` + `generate_schema` | `extraction_strategy.py`, `prompts.py` | No-LLM structured extraction with a CSS schema (`baseSelector`, fields of type text / attribute / html / regex / nested / list). An LLM can write that schema once; every later extraction is free. |
| Deep crawling (`BFS`, `DFS`, `BestFirst`) | `deep_crawling/` | Follow links up to `max_depth` / `max_pages`, with a `FilterChain` (domain, URL pattern, content type) and URL scorers (keyword relevance, path depth, freshness …). |
| `AsyncUrlSeeder`, adaptive crawling | `async_url_seeder.py`, `adaptive_crawler.py` | Discover URLs from sitemaps / Common Crawl and stop crawling when the gathered content is "sufficient". |
| LLM provider layer | `utils.perform_completion_with_backoff` (LiteLLM) | Any provider via LiteLLM with exponential backoff. |

### Why it cannot run as-is in this app
* The app's server runs as a lightweight edge server (no Python, no long-running processes, no headless browser). Crawl4AI needs Python 3.10+, Playwright/Chromium, lxml and a writable home folder.
* Crawl4AI's own Docker server could be hosted elsewhere, but that is a separate always-on machine to pay for and secure, and its LLM calls would use separate provider keys instead of the workspace's Lovable AI credits.
* Crawl4AI has **no search engine of its own** — it crawls URLs you already have.
* The tutor's existing web search, link reader and NCERT tools depended on Perplexity, Parallel and Firecrawl connectors; whenever those are missing, out of credits or slow, the tutor had no other reader.

## 2. Integration decision

Port Crawl4AI's pipeline to TypeScript that runs inside the app's own server (`src/lib/crawl4ai/`), and route every AI step through the **Lovable AI Gateway** so it is billed to the workspace's Lovable AI credits:

```text
query ──► Lovable AI web search (openai/gpt-6-astra + web_search tool) ──► source URLs
                                                                           │
URL(s) ──► safe fetch (redirect + private-network guard, size caps, robots for deep crawl)
       ──► scrape/clean (WebScrapingStrategy port)            ── free
       ──► markdown + citations (DefaultMarkdownGenerator port) ── free
       ──► fit markdown: Pruning (no query) or BM25 (with query) ── free
       ──► optional AI steps on Lovable AI (credits):
             • LLMContentFilter  (AI-cleaned markdown)
             • LLMExtractionStrategy (blocks or your fields → JSON)
             • CSS schema generation (once) → JsonCssExtraction (free afterwards)
             • answer synthesis with numbered citations
       ──► deep crawl: BFS / Best-First with filters + keyword scorer (bounded)
```

* Plain reading, cleaning, markdown, Pruning/BM25 filtering, CSS extraction and deep-crawl link scoring cost **no AI credits**.
* Search, AI filtering, AI extraction, schema generation and answers use **Lovable AI credits** and respect the app's existing AI pause/credits rules.
* PDFs are read with the app's existing worker-safe PDF reader (`unpdf`) and split into `[Page N]` sections.
* JavaScript-only pages (which need a browser) are reported honestly as "no readable text"; when a Firecrawl/Parallel connector is linked, the tutor falls back to it automatically.
* NCERT's website sends an incomplete certificate chain, so strict TLS readers (Node, curl) refuse it. TLS checking is never disabled; NCERT reads fall back to Parallel/Firecrawl when the direct read fails.

## 3. Where it plugs in

| App feature | Before | After (built) |
| --- | --- | --- |
| Tutor chat `web_search` (Web search switch) | Perplexity + Parallel connectors | Lovable AI web search → free crawl of the top 3 pages → BM25 excerpts; Perplexity + Parallel only when AI search is paused, fails or finds nothing |
| Tutor `open_web_page` (new, Web search on) | — | "Web teacher": opens one search result and returns the passages matching a focus, free (Crawl4AI read) |
| Tutor `read_link` (student's pasted link) | Parallel → Firecrawl | Crawl4AI read first (free) → Parallel → Firecrawl |
| Tutor `ncert_search` | Parallel (ncert.nic.in) | Parallel first; Lovable AI web search limited to ncert.nic.in when Parallel gives nothing |
| Tutor `ncert_read` | Parallel → Firecrawl | Crawl4AI read with BM25 focus (best passages from the whole PDF) → connectors as fallback |
| Tutor `neet_pyq_search` | Perplexity | Lovable AI web search → Perplexity fallback |
| Voice calls | `web_search` only | `web_search` (quick: no page crawl) + `open_web_page` when Web search is on; `read_link` for links the student types |
| Answer-check council, admin "read link into memory" | Same tools | Inherit the upgrade automatically (they share the tutor tools) |
| NCERT Deep Scan | Perplexity + Firecrawl | Lovable AI search (Perplexity backup) + Crawl4AI read (Firecrawl backup) |
| **Web Research** page (`/research`) | — | Search & answer, Read a page, Deep crawl, Extract data — live progress, Stop, citations, markdown/JSON/CSV download, credit-use labels |
| `/api/crawl` endpoint | — | NDJSON progress stream; zod-validated, rate-limited per visitor, bounded, cancellable; AI modes check the shared AI pause first |

### Module map (`src/lib/crawl4ai/`)
`url.ts` (normalise, link safety) · `fetcher.server.ts` (safe fetch) · `robots.ts` · `dom.ts` · `scrape.ts` · `markdown.ts` (citations) · `filters.ts` (Pruning, BM25) · `text.ts` (tokens, stemmer, BM25) · `chunking.ts` · `pdf.server.ts` · `cache.ts` · `crawler.server.ts` (arun / arun_many) · `deep-crawl.server.ts` (BFS, Best-First, filters, scorers) · `css-extract.ts` (JsonCss) · `llm.server.ts` (Lovable AI calls, usage, pause) · `search.server.ts` · `extraction.server.ts` (LLM filter, blocks/fields, schema generation) · `research-protocol.ts` (browser-safe request/event contract) · `research.server.ts` (page flows) · `agent-bridge.server.ts` (tutor tools).

## 4. Safety and limits
* Only `http(s)` on default ports; localhost, private/link-local/metadata IP ranges and internal hostnames are refused, and every redirect hop is re-checked.
* HTML capped at 3 MB, PDFs at 15 MB, 20 s per page, at most 5 redirects.
* Deep crawl: depth ≤ 3, pages ≤ 15, same site by default, robots.txt respected, polite per-site delay.
* Results cache in server memory for 15 minutes (Crawl4AI `CacheMode`), never in the database.
* AI chunks run at most 3 at a time; one search per tool call; tool budget per tutor answer unchanged (4).
* Stop cancels the crawl and any running AI call (no paid automatic retries of cancelled work).
* The link-safety check works on the hostname/IP in the link; it does not resolve DNS, so a public name pointing at a private address is not detected by the app itself (the hosting platform's outbound network does not reach private networks).

## 5. Not ported
* Headless-browser rendering (Playwright), screenshots, PDF printing, JS execution, session/stealth/proxy features — the edge server has no browser.
* URL seeding from sitemaps/Common Crawl, adaptive crawling and DFS — Best-First with keywords covers the study use cases within the page caps.
* `computed` CSS fields (upstream evaluates code strings).

## 6. Saving and verification status (Nov 7)
* Web Research results (cited answers, page notes, crawl summaries) save as a doubt thread or a practice card on the device, free; the same question updates one doubt/card.
* Voice answers with Web search were looping (each step only saw the first tool result) — fixed in the call relay; the real Claude + search + open-page step answers in ~23 s.
* A fully spoken call could not be completed from the sandbox: its browser cannot open the call's audio link. Try it once on a phone.

## 6. Browser features without a paid server (Nov 2026)

The user chose not to pay for an always-on Crawl4AI/Playwright machine. The app's own server now reaches browser-level coverage with free helpers:

| Crawl4AI feature | How it works here | Module |
| --- | --- | --- |
| Browser rendering (JS pages, many bot checks) | When a direct read fails (403/429/5xx, network, TLS), is a bot check, or is a JS shell (< 40 words), `crawl()` asks the free renderer `r.jina.ai` for the rendered HTML and runs it through the same scrape → markdown → BM25 pipeline. A 429 pauses the renderer for 60 s. | `browser-reader.server.ts`, `crawler.server.ts` |
| Blocked sites | If the browser read is still blocked, the Internet Archive's latest saved copy is read raw (marked "web archive copy" with its date). | same |
| Honest failure | Pages that stay blocked fail with "This website blocks automatic readers…", never count as sources. | `crawler.server.ts` (`looksBlocked`) |
| Screenshots | Read mode "Take a screenshot" → renderer screenshot link (temporary, a few hours). | `screenshotPage` |
| URL seeding (AsyncUrlSeeder) | robots.txt `Sitemap:` lines or `/sitemap.xml`, sitemap indexes, gzip; same-site URLs ranked by keywords + lastmod; ≤ 8 files, ≤ 5000 URLs. | `seeder.server.ts` |
| Adaptive crawling | Stops when every keyword appears in ≥ 2 pages (coverage ≥ 0.9) or two pages in a row add < 10 % new terms. | `deep-crawl.server.ts` |
| DFS strategy | Stack order, one path deep first. | `deep-crawl.server.ts` |

Every reader (Web Research, tutor `read_link`/`open_web_page`/`web_search` page reads, NCERT reads, voice) uses `crawl()`, so all get the rescue automatically.

Still not possible: pages behind a login, sites that also block the renderer and have no archive copy (e.g. some Wiley pages), clicking/scrolling scripts, and Crawl4AI's own Python extras. The renderer's free tier is rate limited; heavy use may see "browser reader is busy" for a minute.

## Reader reliability tracking

Every page the reader tries to open produces one `ReadOutcome` (`src/lib/crawl4ai/read-outcome.ts`): URL, site, reader
(`direct` / `browser` / `archive` / `none`), success, failure reason (blocked site, dead link, no text, timeout, network,
website error, unsupported, too large, stopped), words and PDF page count.

- Web research: `PageView.outcome` on each NDJSON `page` event.
- Chat: `/api/chat` writes transient `data-reader` parts (not saved in the thread, not sent to the model).
- Voice: the live relay emits `app.reader` events from the delegated tutor's page tools.

The browser keeps the last 300 outcomes on the device (`src/lib/reader-log.ts`) and shows them at `/reader-report`
(per-mode totals, reader mix, failure reasons, per-URL list, Copy report). Each outcome is also tracked as
`project.page_read` (no full URLs; site host only). Known gap: ncert_read/read_link remote (Firecrawl) fallbacks are not
counted, and sites that serve their homepage for unknown paths (e.g. springer.com) still count as opened.

## Scanned PDFs, www twins and Deep research (Nov 13)

- Scanned and mixed PDFs (any page with almost no text) are reported as `scanned_pdf`, never as a blocking website. Web research can send them once to Lovable AI (`ocr.server.ts`, gpt-6-astra with the PDF as an input file) for a page-by-page transcription: on by default in Search, opt-in in Read page; ≤ 10 MB, ≤ 30 pages, ≤ 3 scanned PDFs per request; results carry "read from scan with AI". Embedded text is preserved on readable pages; missing, duplicate or out-of-range OCR page markers are rejected rather than counted as complete. Without OCR, a mostly readable PDF stays usable but is marked incomplete; a mostly scanned PDF fails as `scanned_pdf`. Mixed PDFs ask AI to transcribe only their photo pages, and answer excerpts keep `[Page N]` labels (live check on an 18-page NTA notice with one photo page: ~11.3k → ~0.9k output tokens, 96 s → 23 s, correct page-1 answer). Tutor/voice reads stay free and never OCR. Read-mode OCR is classified as a paid option in both the form and pause preflight; AI failures and Stop propagate without reader retries.
- A direct read that fails to connect retries once on the www/no-www twin host (www.nta.ac.in refuses, nta.ac.in works) before the browser/archive rescue.
- Search "Deep research": web search with high context and high effort, extra search angles, 4 spare pages, 6000-char excerpts, a high-effort comparing answer (~450 words). Default stays the quick, cheaper setting.
- Live check: "NEET 2026 exam date NTA" went from 2/6 to 6/6 pages read (one scanned notice transcribed).
