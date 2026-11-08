// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { chunkMarkdown } from "@/lib/crawl4ai/chunking";
import { clearCrawlCache, crawl } from "@/lib/crawl4ai/crawler.server";
import { cssExtract, validateCssSchema } from "@/lib/crawl4ai/css-extract";
import { freshnessScore, makeFilterChain, pathDepthScore, scoreUrl } from "@/lib/crawl4ai/deep-crawl.server";
import { fieldsSchema } from "@/lib/crawl4ai/extraction.server";
import { convertLinksToCitations } from "@/lib/crawl4ai/markdown";
import { createNdjsonParser, researchRequestSchema, usesAi } from "@/lib/crawl4ai/research-protocol";
import { isAllowed, parseRobots } from "@/lib/crawl4ai/robots";
import { focusedExcerpt } from "@/lib/crawl4ai/search.server";
import { checkUrlSafety } from "@/lib/crawl4ai/url";

afterEach(() => {
  vi.unstubAllGlobals();
  clearCrawlCache();
});

describe("link safety", () => {
  it.each([
    "http://localhost/admin",
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/",
    "http://metadata.google.internal/",
    "https://intranet/",
    "https://user:pass@example.com/",
    "https://example.com:8443/",
    "file:///etc/passwd",
  ])("refuses %s", (url) => {
    expect(checkUrlSafety(url).ok).toBe(false);
  });
  it("allows public web pages", () => {
    expect(checkUrlSafety("https://ncert.nic.in/textbook.php?kebo1=0-22").ok).toBe(true);
  });
});

describe("citations", () => {
  it("numbers each link once, in first-seen order, with a reference list", () => {
    const r = convertLinksToCitations("See [cells](https://a.org/cell) and [mitosis](https://a.org/m) then [cells again](https://a.org/cell).");
    expect(r.markdown).toBe("See cells⟨1⟩ and mitosis⟨2⟩ then cells again⟨1⟩.");
    expect(r.references).toContain("⟨1⟩ https://a.org/cell: cells");
    expect(r.references).toContain("⟨2⟩ https://a.org/m: mitosis");
  });
});

describe("chunking", () => {
  it("keeps every chunk under the token budget", () => {
    const md = Array.from({ length: 60 }, (_, i) => `## Part ${i}\n\n${"word ".repeat(120)}`).join("\n\n");
    const chunks = chunkMarkdown(md, 500, 0);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.split(/\s+/).filter(Boolean).length * 1.3).toBeLessThanOrEqual(500 * 1.25);
  });
});

describe("robots.txt", () => {
  it("applies the longest matching rule for our agent", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/notes\n");
    expect(isAllowed(rules, "/private/x")).toBe(false);
    expect(isAllowed(rules, "/private/notes/ch1")).toBe(true);
    expect(isAllowed(rules, "/public")).toBe(true);
  });
});

describe("deep crawl rules", () => {
  it("stays on the starting site unless outside links are allowed", () => {
    const filter = makeFilterChain({}, "www.example.com");
    expect(filter("https://docs.example.com/a")).toBeNull();
    expect(filter("https://other.org/a")).toBe("outside the site");
    expect(filter("https://www.example.com/photo.jpg")).toBe("file type");
  });
  it("honours include and exclude patterns", () => {
    const filter = makeFilterChain({ includePatterns: ["*/biology/*"], excludePatterns: ["*/login*"] }, "example.com");
    expect(filter("https://example.com/biology/cells")).toBeNull();
    expect(filter("https://example.com/physics/motion")).toBe("does not match include pattern");
    expect(filter("https://example.com/biology/login")).toBe("matches exclude pattern");
  });
  it("scores keyword links above unrelated ones", () => {
    expect(scoreUrl("https://example.com/biology/cell-division", ["cell", "division"])).toBeGreaterThan(scoreUrl("https://example.com/about/team", ["cell", "division"]));
    expect(pathDepthScore("https://a.com/x/y/z")).toBe(1);
    expect(freshnessScore("https://a.com/neet-2026-notice", 2026)).toBe(1);
  });
});

describe("CSS extraction (no AI)", () => {
  const html = `<ul><li class="q"><h3>Q1 Inertia</h3><a href="/q1">open</a><span class="m">4 marks</span></li>
    <li class="q"><h3>Q2 Momentum</h3><a href="/q2">open</a><span class="m">2 marks</span></li></ul>`;
  it("extracts one item per base match with absolute links", () => {
    const items = cssExtract(html, {
      baseSelector: "li.q",
      fields: [
        { name: "title", selector: "h3", type: "text" },
        { name: "link", selector: "a", type: "attribute", attribute: "href" },
        { name: "marks", selector: ".m", type: "regex", pattern: "(\\d+) marks", transform: "number" },
      ],
    }, "https://example.com/list");
    expect(items).toEqual([
      { title: "Q1 Inertia", link: "https://example.com/q1", marks: 4 },
      { title: "Q2 Momentum", link: "https://example.com/q2", marks: 2 },
    ]);
  });
  it("rejects schemas without a base selector", () => {
    expect(validateCssSchema({ fields: [{ name: "a", type: "text" }] })).toMatch(/baseSelector/);
  });
});

describe("AI field schema", () => {
  it("is strict: every property required and nullable, no extra keys", () => {
    const s = fieldsSchema([{ name: "Exam date", type: "string" }, { name: "Seats", type: "number" }]);
    const item = s.properties.items.items;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(["exam_date", "seats"]);
    expect(item.properties["seats"]).toEqual({ type: ["number", "null"] });
  });
});

describe("research requests", () => {
  it("only spends AI credits for AI options", () => {
    expect(usesAi(researchRequestSchema.parse({ mode: "search", query: "neet 2026 date" }))).toBe(true);
    expect(usesAi(researchRequestSchema.parse({ mode: "read", url: "https://example.com" }))).toBe(false);
    expect(usesAi(researchRequestSchema.parse({ mode: "read", url: "https://example.com", aiClean: true }))).toBe(true);
    expect(usesAi(researchRequestSchema.parse({ mode: "extract", url: "https://example.com", method: "tables" }))).toBe(false);
    expect(usesAi(researchRequestSchema.parse({ mode: "extract", url: "https://example.com", method: "css-auto" }))).toBe(true);
  });
  it("caps deep crawls at 3 levels and 15 pages", () => {
    expect(researchRequestSchema.safeParse({ mode: "deep", url: "https://example.com", maxDepth: 4 }).success).toBe(false);
    expect(researchRequestSchema.safeParse({ mode: "deep", url: "https://example.com", maxPages: 16 }).success).toBe(false);
    expect(researchRequestSchema.safeParse({ mode: "deep", url: "https://example.com", maxDepth: 3, maxPages: 15 }).success).toBe(true);
  });
  it("parses events split across network chunks", () => {
    const events: unknown[] = [];
    const p = createNdjsonParser((e) => events.push(e));
    p.push('{"type":"status","mess');
    p.push('age":"hi"}\n{"type":"done","elapsedMs":3}');
    p.flush();
    expect(events).toEqual([{ type: "status", message: "hi" }, { type: "done", elapsedMs: 3 }]);
  });
});

describe("focused excerpts", () => {
  it("keeps the passage that answers the question even deep inside a long PDF page", () => {
    const filler = Array.from({ length: 40 }, (_, i) => `Interphase sentence number ${i} talks about growth and DNA synthesis in the cell.`).join(" ");
    const doc = `${filler} During prophase the chromatin condenses into compact mitotic chromosomes and the nuclear envelope disappears. ${filler}`;
    const ex = focusedExcerpt(doc, "prophase chromosomes condense", 800);
    expect(ex.length).toBeLessThanOrEqual(900);
    expect(ex).toContain("During prophase the chromatin condenses");
  });
});

describe("crawl pipeline", () => {
  const page = `<!doctype html><html><head><title>Cell cycle</title><meta name="description" content="Mitosis notes"></head><body>
    <nav class="menu"><a href="/">Home</a><a href="/login">Login</a></nav>
    <article><h1>Cell cycle</h1><p>During prophase the chromosomes condense and the nuclear envelope begins to break down, while spindle fibres form from the centrosomes.</p>
    <p>In metaphase chromosomes align at the equatorial plate, attached to spindle fibres at their kinetochores. See <a href="/meiosis">meiosis</a>.</p>
    <table><tr><th>Phase</th><th>Event</th></tr><tr><td>Prophase</td><td>Condensation</td></tr><tr><td>Anaphase</td><td>Separation</td></tr></table></article>
    <footer class="footer">Copyright</footer><script>track()</script></body></html>`;

  it("turns a page into cited markdown, a focused excerpt, links and tables", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(page, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })));
    const r = await crawl("https://bio.example.com/cell-cycle", { query: "prophase chromosomes condense" });
    expect(r.success).toBe(true);
    expect(r.metadata.title).toBe("Cell cycle");
    expect(r.markdown.rawMarkdown).toContain("# Cell cycle");
    expect(r.markdown.rawMarkdown).not.toContain("track()");
    expect(r.markdown.markdownWithCitations).toContain("meiosis⟨");
    expect(r.markdown.referencesMarkdown).toContain("https://bio.example.com/meiosis");
    expect(r.markdown.fitMarkdown).toContain("prophase");
    expect(r.links.internal.map((l) => l.href)).toContain("https://bio.example.com/meiosis");
    expect(r.tables[0]?.headers).toEqual(["Phase", "Event"]);
  });

  it("re-checks redirects and refuses a hop to a private address", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } })));
    const r = await crawl("https://example.com/go", { cacheMode: "bypass" });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("blocked");
  });
});
