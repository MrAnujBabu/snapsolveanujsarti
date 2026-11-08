import { useCallback, useEffect, useRef, useState } from "react";
import { createNdjsonParser, type PageView, type ResearchEvent, type ResearchRequest, type SourceRef, type UsageView } from "@/lib/crawl4ai/research-protocol";

type SearchEvent = Extract<ResearchEvent, { type: "search" }>;
type ExtractedEvent = Extract<ResearchEvent, { type: "extracted" }>;
type StatsEvent = Extract<ResearchEvent, { type: "stats" }>["stats"];

export type ResearchError = { message: string; kind?: string; status?: number };

export type ResearchState = {
  running: boolean;
  status: string;
  error: ResearchError | null;
  search: SearchEvent | null;
  pages: PageView[];
  answer: string;
  answerDone: boolean;
  sources: SourceRef[];
  extracted: ExtractedEvent | null;
  stats: StatsEvent | null;
  usage: UsageView | null;
  skipped: { url: string; reason: string }[];
  elapsedMs: number | null;
  request: ResearchRequest | null;
};

const EMPTY: ResearchState = {
  running: false, status: "", error: null, search: null, pages: [], answer: "", answerDone: false, sources: [], extracted: null,
  stats: null, usage: null, skipped: [], elapsedMs: null, request: null,
};

/** Runs one research request against /api/crawl and folds its NDJSON events into view state. */
export function useResearch() {
  const [state, setState] = useState<ResearchState>(EMPTY);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const ctrl = useRef<AbortController | null>(null);
  const pendingDelta = useRef("");
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    flushTimer.current = null;
    const d = pendingDelta.current;
    if (!d) return;
    pendingDelta.current = "";
    setState((s) => ({ ...s, answer: s.answer + d }));
  }, []);

  useEffect(() => () => {
    ctrl.current?.abort();
    if (flushTimer.current) clearTimeout(flushTimer.current);
  }, []);

  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= cooldownUntil) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [cooldownUntil]);

  const onEvent = useCallback((e: ResearchEvent) => {
    if (e.type === "answer-delta") {
      pendingDelta.current += e.delta;
      flushTimer.current ??= setTimeout(flush, 80);
      return;
    }
    if (e.type === "answer") {
      if (flushTimer.current) clearTimeout(flushTimer.current);
      flushTimer.current = null;
      pendingDelta.current = "";
    }
    setState((s) => {
      switch (e.type) {
        case "status": return { ...s, status: e.message };
        case "search": return { ...s, search: e };
        case "page": return { ...s, pages: [...s.pages, e.page] };
        case "skip": return { ...s, skipped: [...s.skipped, { url: e.url, reason: e.reason }].slice(-50) };
        case "answer": return { ...s, answer: e.text, answerDone: true, sources: e.sources };
        case "extracted": return { ...s, extracted: e };
        case "stats": return { ...s, stats: e.stats };
        case "usage": return { ...s, usage: e.usage };
        case "error": return { ...s, error: { message: e.message, ...(e.kind ? { kind: e.kind } : {}), ...(e.status ? { status: e.status } : {}) } };
        case "done": return { ...s, running: false, status: "", elapsedMs: e.elapsedMs };
        default: return s;
      }
    });
  }, [flush]);

  const start = useCallback(async (request: ResearchRequest) => {
    ctrl.current?.abort();
    const controller = new AbortController();
    ctrl.current = controller;
    pendingDelta.current = "";
    setState({ ...EMPTY, running: true, status: "Starting…", request });
    try {
      const res = await fetch("/api/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => null)) as { error?: string; kind?: string } | null;
        if (res.status === 429) {
          const wait = Number(res.headers.get("Retry-After")) || 30;
          setCooldownUntil(Date.now() + wait * 1000);
          setNow(Date.now());
        }
        setState((s) => ({ ...s, running: false, status: "", error: { message: body?.error ?? `Research could not start (error ${res.status}).`, ...(body?.kind ? { kind: body.kind } : {}), status: res.status } }));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = createNdjsonParser(onEvent);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.push(decoder.decode());
      parser.flush();
      flush();
      setState((s) => (s.running ? { ...s, running: false, status: "" } : s));
    } catch (error) {
      flush();
      if (controller.signal.aborted) {
        setState((s) => ({ ...s, running: false, status: "", error: { message: "Stopped.", kind: "cancelled", status: 499 } }));
        return;
      }
      setState((s) => ({ ...s, running: false, status: "", error: { message: "The connection dropped. Check your internet and try again.", kind: "network" } }));
      console.warn("[research] stream failed", error instanceof Error ? error.message : error);
    } finally {
      if (ctrl.current === controller) ctrl.current = null;
    }
  }, [flush, onEvent]);

  const stop = useCallback(() => ctrl.current?.abort(), []);
  const reset = useCallback(() => {
    ctrl.current?.abort();
    setState(EMPTY);
  }, []);

  const cooldown = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  return { state, start, stop, reset, cooldown };
}
