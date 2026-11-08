import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, FileSearch, Globe, Network, Table2 } from "lucide-react";
import { useState } from "react";
import { rememberSchema, ResearchForm } from "@/components/research/research-forms";
import { AnswerCard, ErrorNote, ExtractedView, PagesList, ProgressBar, SaveResearch, SearchHits, UsageNote } from "@/components/research/research-results";
import { useResearch } from "@/hooks/use-research";
import type { ResearchMode } from "@/lib/crawl4ai/research-protocol";
import { cn } from "@/lib/utils";

type Search = { mode?: ResearchMode | undefined };
const MODES: { id: ResearchMode; label: string; icon: typeof Globe; hint: string }[] = [
  { id: "search", label: "Search", icon: Globe, hint: "Search the web, read the best pages and get a cited answer." },
  { id: "read", label: "Read page", icon: FileSearch, hint: "Turn any web page or PDF into clean study notes." },
  { id: "deep", label: "Deep crawl", icon: Network, hint: "Follow a website's links and read many pages at once." },
  { id: "extract", label: "Extract", icon: Table2, hint: "Pull lists, tables and details out of a page as data." },
];

export const Route = createFileRoute("/research")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    mode: s["mode"] === "search" || s["mode"] === "read" || s["mode"] === "deep" || s["mode"] === "extract" ? s["mode"] : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Web Research — SnapSolve" },
      { name: "description", content: "Search the web, read pages and PDFs as clean notes, crawl whole websites and extract tables and data — powered by a Crawl4AI engine and Lovable AI." },
      { property: "og:title", content: "Web Research — SnapSolve" },
      { property: "og:description", content: "Cited web answers, clean page notes, deep website crawls and data extraction for NEET study." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Research,
});

function Research() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const mode = search.mode ?? "search";
  const { state, start, stop, cooldown } = useResearch();
  const [reuse, setReuse] = useState<string | null>(null);
  const active = MODES.find((m) => m.id === mode)!;
  const shown = state.request?.mode === mode;

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-4 py-6 sm:px-5 md:py-8">
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-primary"><ArrowLeft className="size-4" /> SnapSolve</Link>
      <div className="mt-6">
        <h1 className="font-display text-3xl font-semibold">Web Research</h1>
        <p className="mt-1 text-sm text-muted-foreground">{active.hint}</p>
      </div>
      <div role="tablist" aria-label="Research tools" className="mt-5 grid grid-cols-4 gap-1 rounded-2xl bg-muted p-1.5">
        {MODES.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" role="tab" aria-selected={mode === id} aria-controls="research-panel" id={`research-tab-${id}`}
            onClick={() => { void navigate({ search: { mode: id }, replace: true }); }}
            className={cn("touch-btn flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-xl px-1 py-2 text-[11px] font-medium transition-colors sm:flex-row sm:gap-2 sm:text-sm",
              mode === id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
            <Icon className="size-4" />
            <span className="text-center leading-tight">{label}</span>
          </button>
        ))}
      </div>
      <div id="research-panel" role="tabpanel" aria-labelledby={`research-tab-${mode}`} className="mt-4 space-y-4">
        <ResearchForm mode={mode} busy={state.running} cooldown={cooldown} reuseSchema={reuse}
          onSubmit={(req) => {
            setReuse(null);
            if (req.mode === "extract" && req.method === "css-schema" && req.schema) rememberSchema(req.url, req.schema);
            void start(req);
          }} />
        <ProgressBar state={state} onStop={stop} />
        {shown && (
          <>
            <ErrorNote error={state.error} />
            <AnswerCard state={state} title={state.request?.mode === "deep" ? "Summary" : "Answer"} />
            <SaveResearch state={state} />
            <SearchHits state={state} />
            <ExtractedView state={state} onReuseSchema={(s) => {
              setReuse(s);
              if (state.request && state.request.mode === "extract") rememberSchema(state.request.url, s);
              window.scrollTo({ top: 0, behavior: "smooth" });
            }} />
            <PagesList pages={state.pages} title={state.request?.mode === "search" ? "Pages read" : state.request?.mode === "deep" ? "Crawled pages" : "Page"} />
            {state.skipped.length > 0 && <p className="text-xs text-muted-foreground">{state.skipped.length} links were skipped because the website's robots.txt asks crawlers not to open them.</p>}
            <UsageNote state={state} />
          </>
        )}
        {!state.running && !shown && (
          <p className="px-1 text-xs leading-relaxed text-muted-foreground">
            Built on a Crawl4AI engine: pages are cleaned into markdown with numbered link citations and focused with BM25 or pruning filters for free. Steps marked “Lovable AI credits” use this workspace's AI balance.
          </p>
        )}
      </div>
    </main>
  );
}
