import { describe, expect, it } from "vitest";
import { outcomeFromCrawl } from "@/lib/crawl4ai/read-outcome";

describe("page-read outcome", () => {
  it("records the reader that produced the text and the PDF page count", () => {
    const o = outcomeFromCrawl({ url: "https://www.example.com/a.pdf", success: true, via: "archive", wordCount: 900, pages: ["p1", "p2", "p3"] });
    expect(o).toMatchObject({ ok: true, reader: "archive", site: "example.com", pages: 3, words: 900 });
  });

  it("counts an ordinary web page as one page", () => {
    expect(outcomeFromCrawl({ url: "https://example.com/", success: true, via: "browser", wordCount: 400 }).pages).toBe(1);
  });

  it("marks a dead link as not found", () => {
    const o = outcomeFromCrawl({ url: "https://example.com/x", success: false, status: 404, errorCode: "http", error: "Page not found" });
    expect(o).toMatchObject({ ok: false, reader: "none", reason: "not_found", pages: 0 });
  });

  it("marks refused and bot-check pages as blocked by the website", () => {
    expect(outcomeFromCrawl({ url: "https://example.com/", success: false, status: 403, errorCode: "http" }).reason).toBe("blocked_site");
    expect(outcomeFromCrawl({ url: "https://example.com/", success: false, status: 403, errorCode: "blocked_site" }).reason).toBe("blocked_site");
    expect(outcomeFromCrawl({ url: "https://example.com/", success: true, via: "direct", wordCount: 30 }, true)).toMatchObject({ ok: false, reason: "blocked_site", reader: "none" });
  });

  it("keeps timeouts and empty pages apart", () => {
    expect(outcomeFromCrawl({ url: "https://example.com/", success: false, errorCode: "timeout" }).reason).toBe("timeout");
    expect(outcomeFromCrawl({ url: "https://example.com/", success: false, errorCode: "empty" }).reason).toBe("empty");
  });
});
