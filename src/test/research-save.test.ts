import { describe, expect, it } from "vitest";
import type { ResearchState } from "@/hooks/use-research";
import type { PageView } from "@/lib/crawl4ai/research-protocol";
import { savedPractice } from "@/lib/practice";
import { CARD_ANSWER_CHARS, researchCard, researchSnapshot, researchThread, SAVED_NOTES_CHARS } from "@/lib/research-save";
import { cardId } from "@/lib/srs";

const base: ResearchState = {
  running: false, status: "", error: null, search: null, pages: [], answer: "", answerDone: false, sources: [], extracted: null,
  stats: null, usage: null, skipped: [], elapsedMs: null, request: null,
};

const page = (over: Partial<PageView> = {}): PageView => ({
  url: "https://example.org/a", finalUrl: "https://example.org/a", title: "Mitosis", success: true, kind: "html", status: 200, wordCount: 10,
  rawMarkdown: "raw text", fitMarkdown: "focused text", citedMarkdown: "", links: { internal: 0, external: 0 }, tables: 0, images: [],
  ...over,
} as PageView);

const searched: ResearchState = {
  ...base,
  request: { mode: "search", query: "What is prophase?", pages: 4, answer: true },
  answer: "Prophase is the first stage of mitosis [1].",
  answerDone: true,
  sources: [{ n: 1, url: "https://en.wikipedia.org/wiki/Prophase", title: "Prophase" }],
};

describe("saving web research", () => {
  it("saves a search as a doubt: the query is the student question and the answer keeps its sources", () => {
    const snap = researchSnapshot(searched)!;
    const thread = researchThread(snap, 1000);
    expect(thread.messages[0]).toMatchObject({ role: "user", parts: [{ type: "text", text: "What is prophase?" }] });
    const answer = (thread.messages[1]!.parts[0] as { text: string }).text;
    expect(thread.messages[1]!.role).toBe("assistant");
    expect(answer).toContain("[[1]](https://en.wikipedia.org/wiki/Prophase)");
    expect(answer).toContain("1. [Prophase](https://en.wikipedia.org/wiki/Prophase)");
  });

  it("saving the same question twice updates one doubt", () => {
    const a = researchThread(researchSnapshot(searched)!, 1);
    const b = researchThread(researchSnapshot({ ...searched, answer: "Newer answer." })!, 2);
    expect(a.id).toBe(b.id);
  });

  it("a practice card from research is new and due now, and matches the card its saved doubt makes", () => {
    const snap = researchSnapshot(searched)!;
    const card = researchCard(snap);
    expect(card).toMatchObject({ id: cardId("What is prophase?"), box: 1, due: 0, reviews: 0, topic: "Web research" });
    const deck = savedPractice([card], [researchThread(snap, 1)]);
    expect(deck).toHaveLength(1);
  });

  it("nothing can be saved while research is still running", () => {
    expect(researchSnapshot({ ...searched, running: true })).toBeNull();
  });

  it("a page read without an AI question saves its focused notes, capped", () => {
    const long = "x".repeat(SAVED_NOTES_CHARS + 500);
    const snap = researchSnapshot({ ...base, request: { mode: "read", url: "https://example.org/a", filter: "auto", aiClean: false, browser: "auto", screenshot: false }, pages: [page({ fitMarkdown: long })] })!;
    expect(snap.question).toBe("Notes: Mitosis");
    expect(snap.answer.length).toBeLessThan(SAVED_NOTES_CHARS + 50);
    expect(snap.sources).toEqual([{ n: 1, url: "https://example.org/a", title: "Mitosis" }]);
  });

  it("card backs are capped so a long answer stays readable", () => {
    const snap = researchSnapshot({ ...searched, answer: "y".repeat(CARD_ANSWER_CHARS * 2) })!;
    expect(researchCard(snap).a.length).toBeLessThan(CARD_ANSWER_CHARS + 50);
  });

  it("a failed read with no answer cannot be saved", () => {
    expect(researchSnapshot({ ...base, request: { mode: "read", url: "https://example.org/a", filter: "auto", aiClean: false, browser: "auto", screenshot: false }, pages: [page({ success: false })] })).toBeNull();
  });
});
