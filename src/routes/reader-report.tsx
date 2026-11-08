import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Copy, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FAILURE_LABEL, type ReadFailure, type ReadMode } from "@/lib/crawl4ai/read-outcome";
import { clearReaderLog, MODE_LABEL, READER_LABEL, READER_LOG_EVENT, readLog, reportText, summarize, type LoggedRead } from "@/lib/reader-log";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/reader-report")({
  head: () => ({
    meta: [
      { title: "Reader report — SnapSolve" },
      { name: "description", content: "See how reliably SnapSolve opens web pages in Web research, Chat and Voice: reader used, pages read and why a page failed." },
      { property: "og:title", content: "Reader report — SnapSolve" },
      { property: "og:description", content: "Per-mode web page reading reliability: direct, browser reader, web archive or failed, with reasons." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ReaderReport,
});

const MODES = Object.keys(MODE_LABEL) as ReadMode[];

function ReaderReport() {
  const [rows, setRows] = useState<LoggedRead[]>([]);
  useEffect(() => {
    const load = () => setRows(readLog());
    load();
    window.addEventListener(READER_LOG_EVENT, load);
    window.addEventListener("storage", load);
    return () => {
      window.removeEventListener(READER_LOG_EVENT, load);
      window.removeEventListener("storage", load);
    };
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(reportText(rows));
      toast.success("Report copied.");
    } catch {
      toast.error("Copy failed — select the text instead.");
    }
  };

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-4 py-6 sm:px-5 md:py-8">
      <Link to="/research" className="inline-flex items-center gap-1 text-sm text-primary"><ArrowLeft className="size-4" /> Web Research</Link>
      <div className="mt-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-semibold">Reader report</h1>
          <p className="mt-1 text-sm text-muted-foreground">Every web page opened on this device in Web research, Chat and Voice: which reader worked, pages read, and why a page failed.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void copy()} disabled={!rows.length}><Copy className="size-4" />Copy report</Button>
          <Button variant="ghost" size="sm" onClick={() => { clearReaderLog(); toast.success("Report cleared."); }} disabled={!rows.length}><Trash2 className="size-4" />Clear</Button>
        </div>
      </div>

      {!rows.length && (
        <p className="mt-8 rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          No pages opened yet. Run a Web research search, ask Chat with Web search on, or ask Voice to open a page — results appear here.
        </p>
      )}

      {MODES.map((mode) => {
        const s = summarize(rows, mode);
        if (!s.reads) return null;
        const mine = rows.filter((r) => r.mode === mode).reverse();
        const reasons = Object.entries(s.reasons) as [ReadFailure, number][];
        return (
          <section key={mode} className="mt-8" aria-labelledby={`report-${mode}`}>
            <h2 id={`report-${mode}`} className="font-display text-xl font-semibold">{MODE_LABEL[mode]}</h2>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Opened" value={`${s.ok}/${s.reads}`} note={`${Math.round((s.ok / s.reads) * 100)}%`} />
              <Stat label="Pages read" value={String(s.pages)} />
              <Stat label="Direct" value={String(s.byReader.direct)} />
              <Stat label="Browser / archive" value={`${s.byReader.browser} / ${s.byReader.archive}`} />
            </div>
            {reasons.length > 0 && (
              <p className="mt-2 text-sm text-muted-foreground">Failures: {reasons.map(([r, n]) => `${FAILURE_LABEL[r]} ×${n}`).join(" · ")}</p>
            )}
            <ul className="mt-3 divide-y rounded-2xl border bg-card">
              {mine.map((r, i) => (
                <li key={`${r.at}-${i}`} className="flex flex-col gap-1 p-3 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <a href={r.url} target="_blank" rel="noreferrer" className="min-w-0 break-all font-medium text-primary underline-offset-2 hover:underline">{r.url}</a>
                    <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-medium", r.ok ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive")}>{READER_LABEL[r.reader]}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {r.ok ? `${r.pages} page${r.pages === 1 ? "" : "s"} · ${r.words.toLocaleString()} words` : `${FAILURE_LABEL[r.reason ?? "other"]}${r.detail ? ` — ${r.detail}` : ""}`}
                    {" · "}{new Date(r.at).toLocaleString()}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </main>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-2xl border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}{note && <span className="ml-1 text-xs font-normal text-muted-foreground">{note}</span>}</p>
    </div>
  );
}
