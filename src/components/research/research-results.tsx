import { Link, useNavigate } from "@tanstack/react-router";
import { AlertCircle, Check, ChevronRight, Copy, Download, ExternalLink, FileText, Globe, Layers, MessageSquarePlus, Sparkles, Square } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { ResearchState } from "@/hooks/use-research";
import type { PageView, SourceRef } from "@/lib/crawl4ai/research-protocol";
import { normalizeMath } from "@/lib/math-format";
import { researchCard, researchSnapshot, researchThread } from "@/lib/research-save";
import { addCards } from "@/lib/srs";
import { upsertThread } from "@/lib/threads";
import { downloadBlob } from "@/lib/transcript-export";
import { cn } from "@/lib/utils";

export function hostOf(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

/** host + path, so pages from one site are told apart. */
export function shortUrl(url: string) {
  try {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname).replace(/\/$/, "");
    return `${u.hostname.replace(/^www\./, "")}${path}${u.search}`;
  } catch {
    return url;
  }
}

function safeName(s: string) {
  return (s.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 60) || "page").toLowerCase();
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button type="button" variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-xs"
      onClick={() => { void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }).catch(() => undefined); }}>
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{done ? "Copied" : label}
    </Button>
  );
}

/** `[2]` → a link to source 2, so citations in the answer open the page they came from. */
export function linkCitations(text: string, sources: SourceRef[]) {
  if (!sources.length) return text;
  const map = new Map(sources.map((s) => [s.n, s.url]));
  return text.replace(/\[(\d{1,2})\](?!\()/g, (m, n: string) => {
    const url = map.get(Number(n));
    return url ? `[[${n}]](${url})` : m;
  });
}

export function ProgressBar({ state, onStop }: { state: ResearchState; onStop: () => void }) {
  if (!state.running) return null;
  return (
    <div className="flex items-center gap-3 rounded-xl border bg-card px-3 py-2.5 shadow-sm" role="status" aria-live="polite">
      <Spinner className="size-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate text-sm">{state.status || "Working…"}</span>
      <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" onClick={onStop}><Square className="size-3" />Stop</Button>
    </div>
  );
}

export function ErrorNote({ error }: { error: ResearchState["error"] }) {
  if (!error) return null;
  const stopped = error.kind === "cancelled";
  return (
    <div className={cn("flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm", stopped ? "bg-muted text-muted-foreground" : "border-destructive/40 bg-destructive/5 text-foreground")} role={stopped ? "status" : "alert"}>
      <AlertCircle className={cn("mt-0.5 size-4 shrink-0", stopped ? "" : "text-destructive")} />
      <span>{error.message}</span>
    </div>
  );
}

export function AnswerCard({ state, title = "Answer" }: { state: ResearchState; title?: string }) {
  const text = useMemo(() => normalizeMath(linkCitations(state.answer, state.sources)), [state.answer, state.sources]);
  if (!state.answer) return null;
  return (
    <section className="rounded-2xl border bg-card p-4 shadow-sm" aria-label={title}>
      <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Sparkles className="size-3.5 text-primary" />{title}
        {state.answerDone && <span className="ml-auto normal-case tracking-normal"><CopyButton text={state.answer} /></span>}
      </div>
      <div className="assistant-answer text-[15px]"><MessageResponse isAnimating={!state.answerDone}>{text}</MessageResponse></div>
      {state.sources.length > 0 && (
        <ol className="mt-3 space-y-1 border-t pt-3 text-xs">
          {state.sources.map((s) => (
            <li key={s.n} className="flex min-w-0 gap-2">
              <span className="shrink-0 font-medium text-primary">[{s.n}]</span>
              <a href={s.url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-muted-foreground hover:text-foreground hover:underline">{s.title} · {hostOf(s.url)}</a>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function SearchHits({ state }: { state: ResearchState }) {
  const s = state.search;
  if (!s) return null;
  const read = new Map(state.pages.map((p) => [p.url, p]));
  return (
    <section className="rounded-2xl border bg-card p-4 shadow-sm" aria-label="Search results">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"><Globe className="size-3.5" />Found on the web</div>
      {s.summary && <p className="text-sm leading-relaxed text-foreground">{s.summary}</p>}
      {s.queries.length > 0 && <p className="mt-2 text-xs text-muted-foreground">Searched: {s.queries.slice(0, 4).join(" · ")}</p>}
      <ul className="mt-3 divide-y">
        {s.hits.map((h) => {
          const page = read.get(h.url);
          return (
            <li key={h.url} className="py-2.5">
              <a href={h.url} target="_blank" rel="noreferrer" className="group flex min-w-0 items-start gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium group-hover:underline">{h.title || hostOf(h.url)}</span>
                  <span className="block truncate text-xs text-muted-foreground">{hostOf(h.url)}</span>
                </span>
                <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              </a>
              {h.snippet && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{h.snippet}</p>}
              {page && (
                <span className={cn("mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]", page.success ? "bg-accent text-accent-foreground" : "bg-muted text-muted-foreground")}>
                  {page.success ? <><Check className="size-3" />Read · {page.wordCount.toLocaleString()} words</> : <>Could not read</>}
                </span>
              )}
            </li>
          );
        })}
        {!s.hits.length && <li className="py-2 text-sm text-muted-foreground">No web pages were found for this search.</li>}
      </ul>
    </section>
  );
}

type View = "fit" | "ai" | "raw" | "cited";

export function PageCard({ page, defaultOpen }: { page: PageView; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [source, setSource] = useState(false);
  const views = ([
    page.aiMarkdown ? ["ai", "AI cleaned"] : null,
    page.fitMarkdown.trim() ? ["fit", "Focused"] : null,
    ["raw", "Full page"],
    page.kind === "html" ? ["cited", "With citations"] : null,
  ].filter(Boolean) as [View, string][]);
  const [view, setView] = useState<View>(views[0]![0]);
  const text = view === "ai" ? page.aiMarkdown ?? "" : view === "fit" ? page.fitMarkdown : view === "cited" ? page.citedMarkdown : page.rawMarkdown;
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="group rounded-2xl border bg-card shadow-sm">
      <summary className="flex cursor-pointer list-none items-start gap-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{page.title}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            <span className="min-w-0 max-w-full truncate">{shortUrl(page.finalUrl)}</span>
            {page.depth !== undefined && <span>Level {page.depth}</span>}
            {page.success ? <span>{page.wordCount.toLocaleString()} words</span> : <span className="text-destructive">Not read</span>}
            {page.kind !== "html" && <span className="uppercase">{page.kind}</span>}
            {page.cached && <span>from memory</span>}
          </span>
        </span>
      </summary>
      {open && <div className="border-t px-4 pb-4 pt-3">
        {!page.success ? (
          <p className="text-sm text-muted-foreground">{page.error ?? "This page could not be read."}</p>
        ) : (
          <>
            {page.needsBrowser && <p className="mb-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">This site builds most of its text with JavaScript, so only part of the page could be read.</p>}
            {page.truncated && <p className="mb-2 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">This page was very large; only the first part was read.</p>}
            <div className="flex flex-wrap items-center gap-1">
              <div role="tablist" aria-label="Page text" className="flex flex-wrap gap-1 rounded-lg bg-muted p-1">
                {views.map(([id, label]) => (
                  <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)}
                    className={cn("rounded-md px-2.5 py-1 text-xs font-medium transition-colors", view === id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>{label}</button>
                ))}
              </div>
              <span className="ml-auto flex">
                <CopyButton text={text} />
                <Button type="button" variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-xs" onClick={() => downloadBlob(`${safeName(page.title)}.md`, new Blob([`# ${page.title}\n\nSource: ${page.finalUrl}\n\n${text}`], { type: "text/markdown" }))}>
                  <Download className="size-3.5" />.md
                </Button>
              </span>
            </div>
            {!text ? (
              <p className="mt-2 rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">Nothing matched the focus words on this page. Open “Full page”.</p>
            ) : source ? (
              <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-3 font-mono text-xs leading-relaxed text-foreground">{text}</pre>
            ) : (
              <div className="assistant-answer mt-2 max-h-96 overflow-auto rounded-lg bg-muted/50 p-3 text-sm"><MessageResponse>{text}</MessageResponse></div>
            )}
            <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-[11px] text-muted-foreground">
              <input type="checkbox" checked={source} onChange={(e) => setSource(e.target.checked)} className="accent-primary" />Show markdown source
            </label>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              {page.kind === "html" && <span>{page.links.internal} site links · {page.links.external} outside links</span>}
              {page.tables > 0 && <span>{page.tables} tables</span>}
              {page.images.length > 0 && <span>{page.images.length}+ images</span>}
              <a href={page.finalUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground hover:underline">Open page <ExternalLink className="size-3" /></a>
            </div>
          </>
        )}
      </div>}
    </details>
  );
}

export function PagesList({ pages, title }: { pages: PageView[]; title: string }) {
  if (!pages.length) return null;
  return (
    <section aria-label={title} className="space-y-2">
      <h2 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"><FileText className="size-3.5" />{title} ({pages.length})</h2>
      {pages.map((p, i) => <PageCard key={`${p.url}-${i}`} page={p} defaultOpen={pages.length === 1} />)}
    </section>
  );
}

function toCsv(rows: Record<string, unknown>[], keys: string[]) {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [keys.join(","), ...rows.map((r) => keys.map((k) => cell(r[k])).join(","))].join("\n");
}

function DataTable({ headers, rows, caption }: { headers: string[]; rows: unknown[][]; caption?: string | undefined }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-left text-xs">
        {caption && <caption className="px-3 py-2 text-left text-xs font-medium">{caption}</caption>}
        {headers.length > 0 && <thead className="bg-muted"><tr>{headers.map((h, i) => <th key={i} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>}
        <tbody className="divide-y">
          {rows.slice(0, 100).map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j} className="max-w-64 px-3 py-1.5 align-top">{c === null || c === undefined ? "—" : typeof c === "object" ? JSON.stringify(c) : String(c)}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {rows.length > 100 && <p className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">Showing 100 of {rows.length}. Download for all rows.</p>}
    </div>
  );
}

export function ExtractedView({ state, onReuseSchema }: { state: ResearchState; onReuseSchema?: (schema: string) => void }) {
  const e = state.extracted;
  const [showJson, setShowJson] = useState(false);
  if (!e) return null;
  const json = JSON.stringify(e.data, null, 2);
  const rows = Array.isArray(e.data) ? (e.data as unknown[]) : [];
  const flat = e.method !== "tables" && e.method !== "ai-blocks" && rows.length > 0 && rows.every((r) => r && typeof r === "object" && !Array.isArray(r));
  const keys = flat ? [...new Set(rows.flatMap((r) => Object.keys(r as object)))].slice(0, 20) : [];
  const schemaText = e.schema ? JSON.stringify(e.schema, null, 2) : "";
  return (
    <section className="space-y-3 rounded-2xl border bg-card p-4 shadow-sm" aria-label="Extracted data">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Extracted · {e.count} {e.method === "tables" ? "tables" : e.method === "ai-blocks" ? "blocks" : "items"}</h2>
        <span className="ml-auto flex flex-wrap">
          <CopyButton text={json} label="Copy JSON" />
          <Button type="button" variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-xs" onClick={() => downloadBlob("extracted.json", new Blob([json], { type: "application/json" }))}><Download className="size-3.5" />JSON</Button>
          {flat && <Button type="button" variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-xs" onClick={() => downloadBlob("extracted.csv", new Blob([toCsv(rows as Record<string, unknown>[], keys)], { type: "text/csv" }))}><Download className="size-3.5" />CSV</Button>}
        </span>
      </div>
      {e.note && <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">{e.note}</p>}
      {!showJson && e.method === "tables" && (rows as { caption?: string; headers: string[]; rows: string[][] }[]).map((t, i) => <DataTable key={i} headers={t.headers} rows={t.rows} caption={t.caption} />)}
      {!showJson && e.method === "ai-blocks" && (
        <ol className="space-y-2">
          {(rows as { index: number; tags: string[]; content: string[] }[]).slice(0, 60).map((b) => (
            <li key={b.index} className="rounded-lg border p-3">
              <div className="mb-1 flex flex-wrap gap-1">{b.tags.map((t) => <span key={t} className="rounded-full bg-accent px-2 py-0.5 text-[11px] text-accent-foreground">{t}</span>)}</div>
              <p className="whitespace-pre-wrap text-sm">{b.content.join("\n")}</p>
            </li>
          ))}
        </ol>
      )}
      {!showJson && flat && <DataTable headers={keys} rows={(rows as Record<string, unknown>[]).map((r) => keys.map((k) => r[k]))} />}
      {(showJson || (!flat && e.method !== "tables" && e.method !== "ai-blocks")) && rows.length > 0 && <pre className="max-h-96 overflow-auto rounded-lg bg-muted/50 p-3 font-mono text-xs">{json}</pre>}
      {rows.length > 0 && <button type="button" className="text-xs text-primary hover:underline" onClick={() => setShowJson((v) => !v)}>{showJson ? "Show as table" : "Show raw JSON"}</button>}
      {schemaText && (
        <details className="rounded-lg border">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium">CSS schema {e.method === "css-auto" ? "written by AI" : "used"}</summary>
          <pre className="max-h-64 overflow-auto border-t bg-muted/50 p-3 font-mono text-xs">{schemaText}</pre>
          <div className="flex flex-wrap gap-1 border-t px-2 py-1.5">
            <CopyButton text={schemaText} label="Copy schema" />
            {onReuseSchema && e.method === "css-auto" && e.count > 0 && (
              <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => onReuseSchema(schemaText)}>Use again without AI</Button>
            )}
          </div>
        </details>
      )}
    </section>
  );
}

/** Save a finished answer or page notes into a doubt chat or the practice deck (free, stays on this device). */
export function SaveResearch({ state }: { state: ResearchState }) {
  const navigate = useNavigate();
  const snap = useMemo(() => researchSnapshot(state), [state]);
  const [saved, setSaved] = useState<{ doubt?: string; card?: boolean }>({});
  const key = snap ? `${snap.question}\n${snap.answer.length}` : "";
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) { setLastKey(key); setSaved({}); }
  if (!snap) return null;
  const saveDoubt = () => {
    const thread = researchThread(snap, Date.now());
    if (!upsertThread(thread)) { toast.error("Browser storage is full. The doubt was not saved — clear old media first."); return; }
    setSaved((s) => ({ ...s, doubt: thread.id }));
    toast.success("Saved as a doubt", { action: { label: "Open", onClick: () => { void navigate({ to: "/doubt/$threadId", params: { threadId: thread.id } }); } } });
  };
  const saveCard = () => {
    try { addCards([researchCard(snap)]); } catch { toast.error("Browser storage is full. The card was not saved."); return; }
    setSaved((s) => ({ ...s, card: true }));
    toast.success("Added to practice", { action: { label: "Practice", onClick: () => { void navigate({ to: "/practice" }); } } });
  };
  return (
    <section aria-label="Save research" className="flex flex-wrap items-center gap-2 rounded-2xl border bg-card px-3 py-2.5 shadow-sm">
      <span className="min-w-0 flex-1 text-xs text-muted-foreground">Keep this for later — free, saved on this device.</span>
      {saved.doubt ? (
        <Button asChild variant="secondary" size="sm" className="h-9 gap-1.5"><Link to="/doubt/$threadId" params={{ threadId: saved.doubt }}><Check className="size-4" />Open doubt</Link></Button>
      ) : (
        <Button type="button" variant="outline" size="sm" className="h-9 gap-1.5" onClick={saveDoubt}><MessageSquarePlus className="size-4" />Save as doubt</Button>
      )}
      <Button type="button" variant={saved.card ? "secondary" : "outline"} size="sm" className="h-9 gap-1.5" disabled={saved.card} onClick={saveCard}>
        {saved.card ? <><Check className="size-4" />In practice</> : <><Layers className="size-4" />Add to practice</>}
      </Button>
    </section>
  );
}

export function UsageNote({ state }: { state: ResearchState }) {
  const u = state.usage;
  const st = state.stats;
  if (!u && !st && state.elapsedMs === null) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {st && <>Crawled {st.crawled} pages{st.failed ? ` · ${st.failed} failed` : ""} · {st.discovered} links queued · {st.skippedByFilter} filtered{st.skippedByRobots ? ` · ${st.skippedByRobots} blocked by robots.txt` : ""} · deepest level {st.depthReached}. </>}
      {u ? <>Lovable AI: {u.calls} {u.calls === 1 ? "step" : "steps"}{u.webSearches ? ` · ${u.webSearches} web ${u.webSearches === 1 ? "search" : "searches"}` : ""} · {u.totalTokens.toLocaleString()} tokens. </> : <>No AI credits used. </>}
      {state.elapsedMs !== null && <>Took {(state.elapsedMs / 1000).toFixed(1)} s.</>}
    </p>
  );
}
