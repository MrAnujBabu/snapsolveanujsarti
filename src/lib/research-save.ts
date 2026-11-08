/**
 * Browser-safe: turns a finished Web Research result into a doubt thread or a practice card.
 * Free (no AI): it reuses the answer or page notes the research already produced.
 */
import type { UIMessage } from "ai";
import type { ResearchState } from "@/hooks/use-research";
import type { SourceRef } from "@/lib/crawl4ai/research-protocol";
import { cardId, type Card } from "@/lib/srs";
import { titleFrom, type Thread } from "@/lib/threads";

/** Notes saved from a page without an AI answer are capped so they fit browser storage. */
export const SAVED_NOTES_CHARS = 8000;
/** Practice card backs stay short enough to read in one look. */
export const CARD_ANSWER_CHARS = 2500;
export const RESEARCH_TOPIC = "Web research";

export type ResearchSnapshot = { question: string; answer: string; sources: SourceRef[] };

function cap(text: string, max: number) {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}\n\n…(shortened)` : t;
}

/** What a finished research run can be saved as, or null while running / when nothing readable came back. */
export function researchSnapshot(state: ResearchState): ResearchSnapshot | null {
  const req = state.request;
  if (!req || state.running) return null;
  if (state.answerDone && state.answer.trim()) {
    const question =
      req.mode === "search" ? req.query
      : req.mode === "read" ? req.question?.trim() || `Notes: ${state.pages[0]?.title ?? req.url}`
      : req.mode === "deep" ? `Summary of ${req.url}`
      : `Data from ${req.url}`;
    return { question: question.trim(), answer: state.answer.trim(), sources: state.sources };
  }
  if (req.mode === "read" || req.mode === "deep") {
    const page = state.pages.find((p) => p.success);
    if (!page) return null;
    const text = page.aiMarkdown?.trim() || page.fitMarkdown.trim() || page.rawMarkdown.trim();
    if (!text) return null;
    return { question: `Notes: ${page.title}`, answer: cap(text, SAVED_NOTES_CHARS), sources: [{ n: 1, url: page.finalUrl, title: page.title }] };
  }
  return null;
}

/** `[2]` → markdown link to source 2, then a numbered source list, so a saved answer keeps where facts came from. */
export function answerWithSources(snap: ResearchSnapshot) {
  const map = new Map(snap.sources.map((s) => [s.n, s.url]));
  const body = snap.answer.replace(/\[(\d{1,2})\](?!\()/g, (m, n: string) => {
    const url = map.get(Number(n));
    return url ? `[[${n}]](${url})` : m;
  });
  if (!snap.sources.length) return body;
  const list = snap.sources.map((s) => `${s.n}. [${s.title || s.url}](${s.url})`).join("\n");
  return `${body}\n\n**Sources**\n${list}`;
}

/** Same question → same thread id, so saving twice updates one doubt instead of making copies. */
export function researchThreadId(question: string) {
  return `web-${cardId(question).slice(1)}`;
}

export function researchThread(snap: ResearchSnapshot, now: number): Thread {
  const id = researchThreadId(snap.question);
  const messages: UIMessage[] = [
    { id: `${id}-q`, role: "user", parts: [{ type: "text", text: snap.question }] },
    { id: `${id}-a`, role: "assistant", parts: [{ type: "text", text: answerWithSources(snap) }] },
  ];
  return { id, title: titleFrom(messages), updatedAt: now, messages };
}

/** One new (ungraded, due now) card; its id matches the card a saved doubt would make, so the deck never doubles. */
export function researchCard(snap: ResearchSnapshot): Card {
  return {
    id: cardId(snap.question),
    q: snap.question,
    a: cap(answerWithSources(snap), CARD_ANSWER_CHARS),
    topic: RESEARCH_TOPIC,
    box: 1,
    due: 0,
    reviews: 0,
    lastCorrect: false,
  };
}
