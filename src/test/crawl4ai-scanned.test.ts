// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetRendererPause } from "@/lib/crawl4ai/browser-reader.server";
import { clearCrawlCache, crawl, isMostlyScannedPdf, isScannedPdf, looksBlocked } from "@/lib/crawl4ai/crawler.server";
import { CrawlAiError } from "@/lib/crawl4ai/llm.server";
import { ocrRequestText, splitOcrPages } from "@/lib/crawl4ai/ocr.server";
import { pageLabelledMarkdown } from "@/lib/crawl4ai/search.server";
import { outcomeFromCrawl } from "@/lib/crawl4ai/read-outcome";
import { researchRequestSchema, usesAi } from "@/lib/crawl4ai/research-protocol";
import { twinHostUrl } from "@/lib/crawl4ai/url";

afterEach(() => {
  vi.unstubAllGlobals();
  clearCrawlCache();
  resetRendererPause();
});

/** A one-page PDF with no text layer, like a photographed notice. */
function blankPdf(): Uint8Array<ArrayBuffer> {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << >> >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

const pdfResponse = () => new Response(blankPdf(), { status: 200, headers: { "content-type": "application/pdf" } });

describe("www / no-www twin", () => {
  it("swaps www and the bare name, and ignores IPs and single names", () => {
    expect(twinHostUrl("https://www.nta.ac.in/Download/a.pdf")).toBe("https://nta.ac.in/Download/a.pdf");
    expect(twinHostUrl("https://nta.ac.in/x")).toBe("https://www.nta.ac.in/x");
    expect(twinHostUrl("http://10.0.0.1/x")).toBeNull();
    expect(twinHostUrl("http://localhost/x")).toBeNull();
  });

  it("reads the page from the twin name when the www name refuses the connection", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://www.nta.ac.in/")) throw new TypeError("connection reset");
      if (url.startsWith("https://nta.ac.in/")) return new Response(`<html><head><title>NTA</title></head><body><main><p>${"National Testing Agency public notice about NEET. ".repeat(20)}</p></main></body></html>`, { headers: { "content-type": "text/html" } });
      return new Response("no", { status: 404 });
    }));
    const r = await crawl("https://www.nta.ac.in/notice", { browser: "never" });
    expect(r.success).toBe(true);
    expect(r.finalUrl).toBe("https://nta.ac.in/notice");
    expect(r.url).toBe("https://www.nta.ac.in/notice");
  });
});

describe("scanned PDFs", () => {
  it("are reported as scanned PDFs, never as a website blocking the reader", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => pdfResponse()));
    const r = await crawl("https://nta.ac.in/Download/Notice/scan.pdf");
    expect(r.success).toBe(false);
    expect(r.scanned).toBe(true);
    expect(r.errorCode).toBe("scanned");
    expect(looksBlocked(r)).toBe(false);
    expect(outcomeFromCrawl(r).reason).toBe("scanned_pdf");
  });

  it("are read through the scanned-PDF reader when one is given", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => pdfResponse()));
    const reader = vi.fn(async () => ({ pages: ["PUBLIC NOTICE NEET (UG) 2026 provisional answer keys uploaded on 6 May 2026"] }));
    const r = await crawl("https://nta.ac.in/Download/Notice/scan2.pdf", { scannedPdf: reader });
    expect(reader).toHaveBeenCalledTimes(1);
    // The reader gets the real PDF bytes, not a buffer emptied by the text parser.
    expect((reader.mock.calls[0] as unknown as [Uint8Array])[0].byteLength).toBe(blankPdf().byteLength);
    expect(r.success).toBe(true);
    expect(r.ocr).toBe(true);
    expect(r.markdown.rawMarkdown).toContain("6 May 2026");
  });

  it("keeps the scanned label and the reason when the reader skips the PDF", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => pdfResponse()));
    const r = await crawl("https://nta.ac.in/Download/Notice/scan3.pdf", { scannedPdf: async () => ({ skipped: "Too big." }) });
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe("scanned");
    expect(r.error).toContain("Too big.");
  });

  it("splits the AI transcription into pages by its '## Page N' lines", () => {
    expect(splitOcrPages("## Page 1\nA notice\n\n## Page 2\nSecond page", 2)).toEqual(["A notice", "Second page"]);
    expect(splitOcrPages("No markers at all", 1)).toEqual(["No markers at all"]);
  });

  it("detects one photo page in a mostly readable PDF", () => {
    expect(isScannedPdf(["Readable page with several real printed words", "Another readable page with real text here", ""])).toBe(true);
    expect(isScannedPdf(["Readable page with several real printed words"])).toBe(false);
    expect(isMostlyScannedPdf(["Readable page with several real printed words", "Another readable page with real text here", ""])).toBe(false);
    expect(isMostlyScannedPdf(["Readable page with several real printed words", "", ""])).toBe(true);
  });

  it("rejects missing, duplicate or out-of-range OCR page markers", () => {
    expect(splitOcrPages("No markers at all", 3)).toEqual([]);
    expect(splitOcrPages("## Page 1\nText", 2)).toEqual([]);
    expect(splitOcrPages("## Page 1\nText\n## Page 1\nRepeated", 2)).toEqual([]);
    expect(splitOcrPages("## Page 999999999\nText", 1)).toEqual([]);
  });

  it("does not count incomplete OCR as a successful read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => pdfResponse()));
    const r = await crawl("https://nta.ac.in/incomplete.pdf", { scannedPdf: async () => ({ pages: ["Text", "Invented extra page"] }) });
    expect(r.success).toBe(false);
    expect(r.ocr).toBeUndefined();
    expect(r.error).toContain("every PDF page");
  });

  it("asks AI to transcribe only the photo pages of a mixed PDF", () => {
    expect(ocrRequestText(18, [1])).toContain("ONLY page 1 ");
    expect(ocrRequestText(2, [1, 2])).toBe("Transcribe all 2 pages of this scanned PDF.");
  });

  it("never uses the skipped-page marker as the photo page's text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => pdfResponse()));
    const r = await crawl("https://nta.ac.in/marker.pdf", { scannedPdf: async () => ({ pages: ["[text layer kept]"] }) });
    expect(r.success).toBe(false);
    expect(r.ocr).toBeUndefined();
  });

  it("keeps PDF page numbers on every paragraph used for answers", () => {
    const md = pageLabelledMarkdown({ kind: "pdf", pages: ["Notice heading\n\nSyllabus line", "Signed by Director"], markdown: { rawMarkdown: "", markdownWithCitations: "", referencesMarkdown: "", fitMarkdown: "", fitHtml: "" } });
    expect(md).toBe("[Page 1] Notice heading\n\n[Page 1] Syllabus line\n\n[Page 2] Signed by Director");
  });

  it("propagates AI credits failures without a twin retry or browser rescue", async () => {
    const fetchMock = vi.fn(async () => pdfResponse());
    vi.stubGlobal("fetch", fetchMock);
    const failure = new CrawlAiError("credits", "Credits used up", 402);
    await expect(crawl("https://nta.ac.in/credits.pdf", { scannedPdf: async () => { throw failure; } })).rejects.toBe(failure);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("research options", () => {
  it("search reads scanned PDFs by default and keeps Deep research off until chosen", () => {
    expect(researchRequestSchema.parse({ mode: "search", query: "neet 2026 date" })).toMatchObject({ deep: false, ocr: true });
    expect(researchRequestSchema.parse({ mode: "search", query: "neet 2026 date", deep: true })).toMatchObject({ deep: true });
  });

  it("a plain page read stays free: scanned-PDF AI reading is off unless switched on", () => {
    expect(researchRequestSchema.parse({ mode: "read", url: "https://a.in/x.pdf" })).toMatchObject({ ocr: false });
    expect(usesAi(researchRequestSchema.parse({ mode: "read", url: "https://a.in/x.pdf" }))).toBe(false);
    expect(usesAi(researchRequestSchema.parse({ mode: "read", url: "https://a.in/x.pdf", ocr: true }))).toBe(true);
  });
});
