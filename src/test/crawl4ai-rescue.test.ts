// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { archiveDate, resetRendererPause, rendererAvailable } from "@/lib/crawl4ai/browser-reader.server";
import { clearCrawlCache, crawl } from "@/lib/crawl4ai/crawler.server";
import { createAdaptiveTracker } from "@/lib/crawl4ai/deep-crawl.server";
import { researchRequestSchema } from "@/lib/crawl4ai/research-protocol";
import { parseSitemap, seedFromSitemaps, sitemapsFromRobots } from "@/lib/crawl4ai/seeder.server";

afterEach(() => {
  vi.unstubAllGlobals();
  clearCrawlCache();
  resetRendererPause();
});

const article = (n = 120) => `<html><head><title>Neuropathy in India</title></head><body><main><h1>Neuropathy in India</h1><p>${"Peripheral neuropathy prevalence study among Indian adults. ".repeat(n / 6)}</p></main></body></html>`;
const botCheck = `<html><head><title>Just a moment...</title></head><body>Verify you are human</body></html>`;
const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

function routeFetch(routes: (url: string) => Response | undefined) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    return routes(url) ?? new Response("not found", { status: 404 });
  }));
  return calls;
}

describe("browser rescue", () => {
  it("re-reads a refused (403) bot-check page with the browser reader", async () => {
    const calls = routeFetch((u) => (u.startsWith("https://r.jina.ai/") ? html(article()) : u.startsWith("https://journal.example.com/") ? html(botCheck, 403) : undefined));
    const r = await crawl("https://journal.example.com/article/1");
    expect(r.success).toBe(true);
    expect(r.via).toBe("browser");
    expect(r.wordCount).toBeGreaterThan(80);
    expect(calls.some((c) => c.startsWith("https://r.jina.ai/https://journal.example.com/article/1"))).toBe(true);
  });

  it("falls back to the web archive when the browser reader is busy, and pauses the reader", async () => {
    routeFetch((u) => {
      if (u.startsWith("https://r.jina.ai/")) return new Response("busy", { status: 429 });
      if (u.startsWith("https://archive.org/wayback/available")) return new Response(JSON.stringify({ archived_snapshots: { closest: { available: true, status: "200", timestamp: "20250314101500", url: "x" } } }), { headers: { "content-type": "application/json" } });
      if (u.startsWith("https://web.archive.org/web/20250314101500id_/")) return html(article());
      if (u.startsWith("https://journal.example.com/")) return html(botCheck, 403);
      return undefined;
    });
    const r = await crawl("https://journal.example.com/article/2");
    expect(r.via).toBe("archive");
    expect(r.archivedAt).toBe("2025-03-14");
    expect(r.finalUrl).toBe("https://journal.example.com/article/2");
    expect(rendererAvailable()).toBe(false);
  });

  it("never calls helpers when browser is 'never' or the direct read is good", async () => {
    const calls = routeFetch((u) => (u.startsWith("https://site.example.com/") ? html(article()) : u.startsWith("https://blocked.example.com/") ? html(botCheck, 403) : html(article())));
    await crawl("https://blocked.example.com/x", { browser: "never" });
    const good = await crawl("https://site.example.com/y");
    expect(good.via).toBe("direct");
    expect(calls.filter((c) => c.includes("jina.ai") || c.includes("archive.org"))).toEqual([]);
  });

  it("keeps 404 pages as not found without rescue calls", async () => {
    const calls = routeFetch((u) => (u.startsWith("https://site.example.com/") ? html("gone", 404) : html(article())));
    const r = await crawl("https://site.example.com/missing");
    expect(r.success).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("never counts a 'security check required' page from the browser reader as a source", async () => {
    const check = `<html><head><title>Site - Temporarily Unavailable</title></head><body><h1>Security check required</h1><p>We've detected unusual activity from your network. To continue, complete the security check below.</p></body></html>`;
    routeFetch((u) => (u.startsWith("https://r.jina.ai/") ? html(check) : u.startsWith("https://papers.example.com/") ? html(botCheck, 403) : undefined));
    const r = await crawl("https://papers.example.com/publication/1");
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("blocked_site");
  });

  it("reports a text-less app page as empty, not as a blocking website", async () => {
    routeFetch((u) => (u.startsWith("https://app.example.com/") ? html(`<html><head><title>Whiteboard</title></head><body><div id="root"></div><h1>Whiteboard</h1></body></html>`) : undefined));
    const r = await crawl("https://app.example.com/");
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("empty");
  });

  it("treats a 'page not found' page from the browser reader as a dead link, not a source", async () => {
    const missing = `<html><head><title>Page Unavailable | Journal</title></head><body><h1>Page not found</h1><p>Sorry, the page you requested is unavailable.</p></body></html>`;
    routeFetch((u) => (u.startsWith("https://r.jina.ai/") ? html(missing) : u.startsWith("https://journal.example.com/") ? html(botCheck, 403) : undefined));
    const r = await crawl("https://journal.example.com/article/old");
    expect(r.success).toBe(false);
    expect(r.status).toBe(404);
    expect(r.error).toMatch(/no longer exists/);
  });

  it("formats archive timestamps as dates", () => {
    expect(archiveDate("20240131120000")).toBe("2024-01-31");
  });
});

describe("sitemap seeding", () => {
  it("parses url sets, indexes, entities and robots lines", () => {
    const set = parseSitemap(`<urlset><url><loc>https://a.in/x?a=1&amp;b=2</loc><lastmod>2026-01-01</lastmod></url><url><loc><![CDATA[https://a.in/y]]></loc></url></urlset>`);
    expect(set.kind).toBe("urlset");
    expect(set.entries).toEqual([{ loc: "https://a.in/x?a=1&b=2", lastmod: "2026-01-01" }, { loc: "https://a.in/y" }]);
    expect(parseSitemap(`<sitemapindex><sitemap><loc>https://a.in/s1.xml</loc></sitemap></sitemapindex>`).kind).toBe("index");
    expect(sitemapsFromRobots("User-agent: *\nSitemap: https://a.in/sm.xml\nsitemap:https://a.in/two.xml")).toEqual(["https://a.in/sm.xml", "https://a.in/two.xml"]);
  });

  it("follows the robots sitemap index, keeps same-site pages and ranks keyword matches first", async () => {
    routeFetch((u) => {
      const xml = (b: string) => new Response(b, { headers: { "content-type": "application/xml" } });
      if (u === "https://edu.example.in/robots.txt") return new Response("Sitemap: https://edu.example.in/index.xml", { headers: { "content-type": "text/plain" } });
      if (u === "https://edu.example.in/index.xml") return xml(`<sitemapindex><sitemap><loc>https://edu.example.in/pages.xml</loc></sitemap></sitemapindex>`);
      if (u === "https://edu.example.in/pages.xml") return xml(`<urlset><url><loc>https://edu.example.in/about</loc></url><url><loc>https://edu.example.in/biology/cell</loc></url><url><loc>https://other.example.com/biology</loc></url></urlset>`);
      return undefined;
    });
    const r = await seedFromSitemaps("https://edu.example.in/", { keywords: ["biology"] });
    expect(r.total).toBe(2);
    expect(r.urls[0]!.url).toBe("https://edu.example.in/biology/cell");
    expect(r.sitemaps).toEqual(["https://edu.example.in/index.xml", "https://edu.example.in/pages.xml"]);
  });
});

describe("adaptive stopping", () => {
  it("stops once every keyword appears in two pages", () => {
    const t = createAdaptiveTracker("mitosis meiosis");
    t.add("Mitosis and meiosis are types of cell division.");
    expect(t.stopReason()).toBeNull();
    t.add("Meiosis halves chromosomes; mitosis keeps them.");
    expect(t.coverage()).toBe(1);
    expect(t.stopReason()).toBe("Found enough about your keywords");
  });

  it("stops when new pages only repeat earlier information", () => {
    const t = createAdaptiveTracker("");
    const text = "photosynthesis chlorophyll light reaction dark reaction stroma thylakoid";
    t.add(text);
    t.add(text);
    expect(t.stopReason()).toBeNull();
    t.add(text);
    expect(t.stopReason()).toBe("New pages were repeating what was already found");
  });
});

describe("protocol", () => {
  it("accepts depth-first, sitemap, adaptive, browser and screenshot options with safe defaults", () => {
    const deep = researchRequestSchema.parse({ mode: "deep", url: "https://a.in", strategy: "dfs", sitemap: true, adaptive: true });
    expect(deep).toMatchObject({ strategy: "dfs", sitemap: true, adaptive: true });
    const read = researchRequestSchema.parse({ mode: "read", url: "https://a.in" });
    expect(read).toMatchObject({ browser: "auto", screenshot: false });
  });
});
