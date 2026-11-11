import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useId, useMemo, useState } from 'react';
import { ArrowLeft, ChevronDown, History, PlayCircle, Search, Trash2, Youtube } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { YouTubeTranscriptDownload } from '@/components/youtube-transcript-download';
import { formatTime } from '@/components/youtube-dub';
import { interpreterInfo } from '@/lib/interpreter-models';
import { speakerGenderLabel } from '@/lib/speaker-gender';
import { listLibrary, removeFromLibrary, removeNarrationAudio, type LibraryEntry } from '@/lib/youtube-study-store';

export const Route = createFileRoute('/transcripts')({
  head: () => ({ meta: [
    { title: 'Transcript History — SnapSolve' },
    { name: 'description', content: 'इस device पर save हुए सारे Hindi video transcripts एक जगह पढ़ें, खोजें और download करें।' },
    { property: 'og:title', content: 'Transcript History — SnapSolve' },
    { property: 'og:description', content: 'Every saved Hindi video transcript in one place.' },
    { property: 'og:type', content: 'website' }, { name: 'twitter:card', content: 'summary' },
  ] }),
  component: TranscriptHistory,
});

function TranscriptHistory() {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { void listLibrary().then(setEntries).catch(() => { setEntries([]); setError('Saved transcripts खोल नहीं पाए।'); }); }, []);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (entries ?? []).filter(e => !q || e.result.title.toLowerCase().includes(q) || e.result.hindi.toLowerCase().includes(q));
  }, [entries, query]);

  async function remove(entry: LibraryEntry) {
    await removeFromLibrary(entry.key).catch(() => {});
    await removeNarrationAudio(entry.key).catch(() => {});
    setEntries(await listLibrary().catch(() => []));
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-6 sm:px-8 sm:py-10">
      <Link to="/youtube" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />Video → Hindi</Link>
      <header className="mt-8 border-b pb-6">
        <h1 className="flex items-center gap-3 text-3xl font-semibold"><History className="size-7 shrink-0 text-primary" />Transcript History</h1>
        <p className="mt-2 text-sm text-muted-foreground">इस device पर save हुए सारे Hindi transcripts — पढ़ने या दोबारा खोलने पर credits नहीं लगते।</p>
      </header>
      {entries && entries.length > 0 && (
        <div className="relative mt-6">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Title या शब्द से खोजें" aria-label="Transcript खोजें" className="h-11 pl-9" />
        </div>
      )}
      {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
      {entries === null ? <p className="mt-8 text-sm text-muted-foreground">खोल रहा हूँ…</p>
        : !entries.length ? (
          <div className="mt-10 rounded-2xl border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground">अभी कोई transcript save नहीं है।</p>
            <Button asChild className="mt-4"><Link to="/youtube"><Youtube className="size-4" />Video को Hindi में समझाओ</Link></Button>
          </div>
        ) : (
          <ul className="mt-6 space-y-3">
            {shown.map(e => <HistoryItem key={e.key} entry={e} onRemove={() => void remove(e)} />)}
            {!shown.length && <li className="text-sm text-muted-foreground">“{query}” से कोई transcript नहीं मिला।</li>}
          </ul>
        )}
    </main>
  );
}

function HistoryItem({ entry, onRemove }: { entry: LibraryEntry; onRemove(): void }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const r = entry.result, duration = r.dub?.at(-1)?.end;
  const speaker = r.brief?.speaker?.gender && r.brief.speaker.gender !== 'unknown' ? speakerGenderLabel(r.brief.speaker.gender) : null;
  const meta = [new Date(entry.savedAt).toLocaleString('hi-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }),
    duration ? formatTime(duration) : null, r.engine ? interpreterInfo(r.engine).name : null, speaker ? `बोलने वाला: ${speaker}` : null].filter(Boolean).join(' · ');
  return (
    <li className="rounded-2xl border bg-card">
      <div className="flex items-center gap-3 p-3">
        {r.videoId
          ? <img src={`https://i.ytimg.com/vi/${r.videoId}/mqdefault.jpg`} alt="" loading="lazy" referrerPolicy="no-referrer" className="aspect-video w-24 shrink-0 rounded-lg object-cover" />
          : <span className="flex aspect-video w-24 shrink-0 items-center justify-center rounded-lg bg-accent"><PlayCircle className="size-6 text-primary" /></span>}
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-medium leading-snug">{r.title || 'Video'}</p>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{meta}</p>
        </div>
        <Button type="button" variant="ghost" size="icon" className="shrink-0" aria-expanded={open} aria-controls={id}
          aria-label={open ? 'Transcript बंद करें' : 'Transcript खोलें'} title={open ? 'Transcript बंद करें' : 'Transcript खोलें'} onClick={() => setOpen(v => !v)}>
          <ChevronDown className={`size-4 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} />
        </Button>
      </div>
      <div id={id} hidden={!open} className="border-t">
        {r.dub?.length
          ? <ol className="max-h-[28rem] divide-y overflow-y-auto" aria-label={`${r.title || 'Video'} का transcript`}>
              {r.dub.map((s, i) => <li key={i} className="flex items-start gap-3 px-4 py-3">
                <span className="mt-0.5 shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] text-primary tabular-nums">{formatTime(s.start)}</span>
                <span className="min-w-0 text-sm leading-relaxed">{s.hindi}</span>
              </li>)}
            </ol>
          : <p className="max-h-[28rem] overflow-y-auto whitespace-pre-wrap px-4 py-3 text-sm leading-relaxed">{r.hindi}</p>}
        <div className="flex flex-wrap items-center gap-2 border-t p-3">
          <Button asChild size="sm"><Link to="/youtube" search={{ open: entry.key }}><PlayCircle className="size-4" />Video के साथ खोलें</Link></Button>
          <YouTubeTranscriptDownload result={r} transcript="" disabled={false} />
          <Button type="button" variant="ghost" size="sm" className="ml-auto text-destructive" onClick={onRemove}><Trash2 className="size-4" />हटाएँ</Button>
        </div>
      </div>
    </li>
  );
}
