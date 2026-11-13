/**
 * One page-read outcome, shared by Web research, Chat and Voice so reader reliability can be
 * measured per mode. Browser-safe: no server imports.
 */
export type ReadMode = "web_research" | "chat" | "voice";
export type ReaderSource = "direct" | "browser" | "archive" | "none";
export type ReadFailure = "blocked_site" | "not_found" | "empty" | "scanned_pdf" | "timeout" | "network" | "http_error" | "unsupported" | "too_large" | "cancelled" | "other";

export type ReadOutcome = {
  url: string;
  site: string;
  /** Which reader produced the text; "none" when nothing readable came back. */
  reader: ReaderSource;
  ok: boolean;
  reason?: ReadFailure;
  /** Short human explanation of the failure. */
  detail?: string;
  words: number;
  /** PDF pages read (1 for an ordinary web page). */
  pages: number;
};

/** The parts of a crawl result an outcome needs (kept structural so this stays browser-safe). */
export type OutcomeSource = {
  url: string;
  finalUrl?: string;
  success: boolean;
  status?: number;
  error?: string;
  errorCode?: string;
  via?: "direct" | "browser" | "archive";
  wordCount?: number;
  pages?: unknown[];
};

export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function failureReason(errorCode: string | undefined, status: number | undefined): ReadFailure {
  switch (errorCode) {
    case "blocked":
    case "blocked_site":
      return "blocked_site";
    case "empty":
      return "empty";
    case "scanned":
      return "scanned_pdf";
    case "timeout":
      return "timeout";
    case "network":
      return "network";
    case "unsupported":
      return "unsupported";
    case "too_large":
      return "too_large";
    case "cancelled":
      return "cancelled";
    case "http":
      return status === 404 || status === 410 ? "not_found" : status === 401 || status === 403 || status === 429 ? "blocked_site" : "http_error";
    default:
      return "other";
  }
}

/** `blockedAnyway` covers pages that loaded but turned out to be a bot check. */
export function outcomeFromCrawl(r: OutcomeSource, blockedAnyway = false): ReadOutcome {
  const url = r.finalUrl || r.url;
  const ok = r.success && !blockedAnyway;
  const pages = Array.isArray(r.pages) && r.pages.length ? r.pages.length : 1;
  if (ok) return { url, site: siteOf(url), reader: r.via ?? "direct", ok: true, words: r.wordCount ?? 0, pages };
  const reason = blockedAnyway ? "blocked_site" : failureReason(r.errorCode, r.status);
  const detail = (blockedAnyway ? "The website showed a bot check instead of the page." : r.error ?? "").slice(0, 200);
  return { url, site: siteOf(url), reader: "none", ok: false, reason, ...(detail ? { detail } : {}), words: 0, pages: 0 };
}

/** Plain-language label for a failure reason (used in reliability reports). */
export const FAILURE_LABEL: Record<ReadFailure, string> = {
  blocked_site: "Website blocked the reader",
  not_found: "Dead link (page not found)",
  empty: "No readable text",
  scanned_pdf: "Scanned PDF (photo pages)",
  timeout: "Took too long",
  network: "Could not connect",
  http_error: "Website error",
  unsupported: "File type not supported",
  too_large: "File too large",
  cancelled: "Stopped",
  other: "Other",
};

export function isReadOutcome(value: unknown): value is ReadOutcome {
  const v = value as Partial<ReadOutcome> | null;
  return !!v && typeof v.url === "string" && typeof v.ok === "boolean" && typeof v.reader === "string";
}
