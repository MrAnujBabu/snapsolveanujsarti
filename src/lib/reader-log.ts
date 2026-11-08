/**
 * On-device log of page-read outcomes for the Reader report page. Browser-only, capped, and never
 * sent anywhere (usage counts go through the app's event tracking at each call site instead).
 */
import { FAILURE_LABEL, type ReadFailure, type ReadMode, type ReadOutcome, type ReaderSource } from "@/lib/crawl4ai/read-outcome";

export type LoggedRead = ReadOutcome & { mode: ReadMode; at: number; run: string };

const KEY = "snapsolve.reader-log";
const MAX = 300;
export const READER_LOG_EVENT = "snapsolve:reader-log";

export const MODE_LABEL: Record<ReadMode, string> = { web_research: "Web research", chat: "Chat", voice: "Voice" };
export const READER_LABEL: Record<ReaderSource, string> = { direct: "Direct", browser: "Browser reader", archive: "Web archive", none: "Failed" };

export function readLog(): LoggedRead[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const rows = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(rows) ? (rows as LoggedRead[]).filter((r) => r && typeof r.url === "string" && typeof r.mode === "string") : [];
  } catch {
    return [];
  }
}

export function logRead(mode: ReadMode, outcome: ReadOutcome, run: string) {
  try {
    const rows = [...readLog(), { ...outcome, mode, run, at: Date.now() }].slice(-MAX);
    window.localStorage.setItem(KEY, JSON.stringify(rows));
    window.dispatchEvent(new Event(READER_LOG_EVENT));
  } catch {
    /* storage full or unavailable: the report just misses this read */
  }
}

export function clearReaderLog() {
  try {
    window.localStorage.removeItem(KEY);
    window.dispatchEvent(new Event(READER_LOG_EVENT));
  } catch {
    /* storage unavailable */
  }
}

export type ModeSummary = {
  mode: ReadMode;
  reads: number;
  ok: number;
  pages: number;
  byReader: Record<ReaderSource, number>;
  reasons: Partial<Record<ReadFailure, number>>;
};

export function summarize(rows: LoggedRead[], mode: ReadMode): ModeSummary {
  const mine = rows.filter((r) => r.mode === mode);
  const byReader: Record<ReaderSource, number> = { direct: 0, browser: 0, archive: 0, none: 0 };
  const reasons: Partial<Record<ReadFailure, number>> = {};
  let ok = 0;
  let pages = 0;
  for (const r of mine) {
    byReader[r.reader] = (byReader[r.reader] ?? 0) + 1;
    if (r.ok) {
      ok += 1;
      pages += r.pages || 1;
    } else if (r.reason) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  }
  return { mode, reads: mine.length, ok, pages, byReader, reasons };
}

/** Plain-text report (for copying into chat or notes). */
export function reportText(rows: LoggedRead[]): string {
  const out: string[] = ["SnapSolve reader report", ""];
  for (const mode of Object.keys(MODE_LABEL) as ReadMode[]) {
    const s = summarize(rows, mode);
    if (!s.reads) continue;
    out.push(`## ${MODE_LABEL[mode]}: ${s.ok}/${s.reads} opened (${Math.round((s.ok / s.reads) * 100)}%), ${s.pages} page(s) read`);
    out.push(`Direct ${s.byReader.direct} · Browser reader ${s.byReader.browser} · Web archive ${s.byReader.archive} · Failed ${s.byReader.none}`);
    for (const r of rows.filter((x) => x.mode === mode)) {
      out.push(`- ${r.url} | ${READER_LABEL[r.reader]} | ${r.ok ? `${r.pages} page(s), ${r.words} words` : `${FAILURE_LABEL[r.reason ?? "other"]}${r.detail ? ` — ${r.detail}` : ""}`}`);
    }
    out.push("");
  }
  return out.length > 2 ? out.join("\n").trim() : "No pages have been opened yet.";
}
