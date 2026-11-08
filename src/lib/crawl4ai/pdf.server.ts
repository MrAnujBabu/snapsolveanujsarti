/**
 * PDF strategy (Crawl4AI PDFCrawlerStrategy + PDFContentScrapingStrategy) using the worker-safe
 * unpdf build that the chat already uses in the browser: per-page text with [Page N] markers.
 */
export type PdfText = { pages: string[]; title?: string; pageCount: number; truncatedPages: boolean };

const MAX_PAGES = 300;

export async function pdfToText(bytes: Uint8Array): Promise<PdfText> {
  const { extractText, getDocumentProxy, getMeta } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: false });
  const all = (Array.isArray(text) ? text : [text]).map((t) => String(t).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim());
  let title: string | undefined;
  try {
    const meta = await getMeta(pdf);
    const t = (meta.info as Record<string, unknown> | undefined)?.["Title"];
    if (typeof t === "string" && t.trim()) title = t.trim().slice(0, 300);
  } catch {
    /* metadata is optional */
  }
  return { pages: all.slice(0, MAX_PAGES), pageCount: all.length, truncatedPages: all.length > MAX_PAGES, ...(title ? { title } : {}) };
}

export function pdfPagesToMarkdown(pages: string[]): string {
  return pages.map((t, i) => `## Page ${i + 1}\n\n${t || "_(no text on this page — it may be a scanned image)_"}`).join("\n\n");
}
