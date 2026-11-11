import { History, Trash2, PlayCircle, Download } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import type { LibraryEntry } from '@/lib/youtube-study-store';
import { interpreterInfo } from '@/lib/interpreter-models';
import { formatTime } from '@/components/youtube-dub';

/** Finished interpretations saved on this device; open instantly without spending credits again. */
export function StudyLibrary({ entries, activeKey, disabled, onOpen, onRemove, audioReady, onDownload }: {
  entries: LibraryEntry[]; activeKey: string | null; disabled?: boolean; onOpen(entry: LibraryEntry): void; onRemove(entry: LibraryEntry): void;
  /** Library keys whose Hindi audio is already saved on this device. */
  audioReady?: ReadonlySet<string>; onDownload?(entry: LibraryEntry): void;
}) {
  if (!entries.length) return null;
  return (
    <section className="mt-12" aria-labelledby="library-title">
      <div className="flex items-center justify-between gap-3"><h2 id="library-title" className="flex items-center gap-2 text-lg font-semibold"><History className="size-5 text-primary" />आपकी लाइब्रेरी</h2><Link to="/transcripts" className="shrink-0 text-sm font-medium text-primary hover:underline">Transcript History →</Link></div>
      <p className="mt-1 text-sm text-muted-foreground">इसी device पर save है — दोबारा खोलने पर credits नहीं लगते। <Download className="inline size-3.5" /> से Hindi audio phone में download करें।</p>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
        {entries.map(e => {
          const r = e.result, duration = r.dub?.at(-1)?.end;
          return (
            <li key={e.key} data-active={e.key === activeKey} className="group flex items-center gap-3 rounded-xl border bg-card p-2 pr-1 data-[active=true]:border-primary">
              <button type="button" disabled={disabled} onClick={() => onOpen(e)} className="touch-btn flex min-w-0 flex-1 items-center gap-3 text-left disabled:opacity-50">
                {r.videoId
                  ? <img src={`https://i.ytimg.com/vi/${r.videoId}/mqdefault.jpg`} alt="" loading="lazy" referrerPolicy="no-referrer" className="aspect-video w-24 shrink-0 rounded-lg object-cover" />
                  : <span className="flex aspect-video w-24 shrink-0 items-center justify-center rounded-lg bg-accent"><PlayCircle className="size-6 text-primary" /></span>}
                <span className="min-w-0">
                  <span className="line-clamp-2 text-sm leading-snug font-medium">{r.title || 'Video'}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                    {[r.engine ? interpreterInfo(r.engine).name : null, duration ? formatTime(duration) : null, new Date(e.savedAt).toLocaleDateString('hi-IN', { day: 'numeric', month: 'short' })].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </button>
              {onDownload && (audioReady?.has(e.key)
                ? <Button variant="default" size="icon" disabled={disabled} aria-label={`${r.title || 'Video'} का Hindi audio download करो`} title="Hindi audio download (saved)" onClick={() => onDownload(e)} className="shrink-0"><Download className="size-4" /></Button>
                : <Button variant="outline" size="icon" disabled={disabled} aria-label={`${r.title || 'Video'} का Hindi audio बनाकर download करो`} title="Hindi audio बनाओ और download करो" onClick={() => onDownload(e)} className="shrink-0"><Download className="size-4" /></Button>)}
              <Button variant="ghost" size="icon" disabled={disabled} aria-label={`${r.title || 'Video'} लाइब्रेरी से हटाओ`} onClick={() => onRemove(e)} className="shrink-0 text-muted-foreground"><Trash2 className="size-4" /></Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
