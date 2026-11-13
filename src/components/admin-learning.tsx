import { useEffect, useState } from 'react';
import { useServerFn } from '@tanstack/react-start';
import { Brain, Check, Loader2, MessageSquareWarning, RefreshCw, ShieldCheck, TrendingDown } from 'lucide-react';
import { deleteLesson, listLearning, saveLesson, updateFeedback } from '@/lib/learning/learning.functions';
import { isStale, lessonVerdict, type Verdict } from '@/lib/learning/lessons';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';

type Data = Awaited<ReturnType<typeof listLearning>>;
type Lesson = Data['lessons'][number];
type Subject = 'physics' | 'chemistry' | 'biology' | 'general';
const SUBJECTS: Subject[] = ['general', 'physics', 'chemistry', 'biology'];
const asSubject = (s: string): Subject => (SUBJECTS as string[]).includes(s) ? s as Subject : 'general';

const when = (iso: string | null) => iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const pct = (a: number, n: number) => n ? `${Math.round((a / n) * 100)}%` : '—';

const VERDICT: Record<Verdict, { label: string; variant: 'secondary' | 'outline' | 'destructive' }> = {
  few: { label: 'Data kam hai', variant: 'outline' },
  helping: { label: 'Madad kar raha ✓', variant: 'secondary' },
  'no-effect': { label: 'Asar nahi dikh raha', variant: 'outline' },
  hurting: { label: 'Nuksaan — band karein?', variant: 'destructive' },
};

const CATEGORY: Record<string, string> = {
  tool_failed: 'Tool fail hua', missing_capability: 'Zaroori tool nahi tha', confusing_instructions: 'Instructions ulajh rahe',
  conflicting_rules: 'Rules takra rahe', bad_source: 'Source galat tha', other: 'Aur kuch',
};

export function AdminLearning() {
  const list = useServerFn(listLearning);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try { setError(''); setData(await list()); }
    catch (e) { setError(e instanceof Error ? e.message : 'Dobara koshish karein.'); }
    finally { setRefreshing(false); }
  };
  useEffect(() => { void refresh(); }, []);

  const pending = data?.lessons.filter(l => l.status === 'pending') ?? [];
  const active = data?.lessons.filter(l => l.status === 'active') ?? [];
  const retired = data?.lessons.filter(l => l.status === 'retired') ?? [];
  const open = data?.feedback.filter(f => f.status === 'open') ?? [];
  const resolved = data?.feedback.filter(f => f.status === 'resolved') ?? [];

  return <section aria-label="Agent learning" className="min-w-0 space-y-8 [&_.font-display]:tracking-normal">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-2">
        <div className="flex items-center gap-2 text-sm text-primary"><Brain className="size-4" aria-hidden />Tutor improvement</div>
        <h2 className="font-display text-2xl sm:text-3xl">Agent learning</h2>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5"><ShieldCheck className="size-3.5 text-primary" aria-hidden />Admin approval</span>
          <span>Doubt chat only</span><span>Lovable AI Gateway</span>
        </div>
      </div>
      <Button variant="outline" size="icon" disabled={refreshing} onClick={() => void refresh()} aria-label="Refresh learning" title="Refresh learning" className="shrink-0">
        {refreshing ? <Loader2 className="size-4 motion-safe:animate-spin" /> : <RefreshCw className="size-4" />}
      </Button>
    </div>
    {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"><p className="min-w-0 break-words text-destructive">{error}</p><Button size="sm" variant="outline" disabled={refreshing} onClick={() => void refresh()}>Dobara koshish</Button></div>}
    {!data && !error && <div role="status" aria-label="Learning load ho raha hai" className="space-y-4 motion-safe:animate-pulse"><div className="h-32 rounded-lg bg-muted" /><div className="h-48 rounded-lg bg-muted" /><span className="sr-only">Loading…</span></div>}

    {data && <StuckTrend stats={data.stats} />}

    {data && <div className="space-y-4 border-t border-border pt-6">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-display text-lg">Manzoori ke liye</h3><Badge variant="secondary">{pending.length} naye sabak</Badge></div>
      {!pending.length && <div className="flex items-center gap-3 border-y border-dashed border-border py-6 text-sm text-muted-foreground"><Check className="size-5 text-primary" aria-hidden />Abhi koi sabak manzoori ke liye nahi hai.</div>}
      {pending.map(l => <LessonCard key={l.id} lesson={l} onChanged={refresh} />)}
    </div>}

    {data && <div className="space-y-4 border-t border-border pt-6">
      <div className="flex items-center justify-between gap-2"><h3 className="font-display text-lg">Lagu sabak</h3><Badge variant="outline">{active.length} active</Badge></div>
      {!active.length && <p className="py-4 text-sm text-muted-foreground">Abhi koi seekha hua sabak lagu nahi hai.</p>}
      {active.map(l => <LessonCard key={l.id} lesson={l} onChanged={refresh} />)}
      <NewLesson onChanged={refresh} />
    </div>}

    {data && retired.length > 0 && <details className="space-y-3">
      <summary className="cursor-pointer font-display text-lg">Band kiye sabak ({retired.length})</summary>
      <div className="mt-3 space-y-3">{retired.map(l => <LessonCard key={l.id} lesson={l} onChanged={refresh} />)}</div>
    </details>}

    {data && <div className="space-y-4 border-t border-border pt-6">
      <div className="flex items-center gap-2"><MessageSquareWarning className="size-5 text-primary" aria-hidden /><h3 className="font-display text-lg">Tutor ki shikayatein ({open.length})</h3></div>
      {!open.length && <p className="text-sm text-muted-foreground">Koi khuli shikayat nahi.</p>}
      {open.map(f => <FeedbackCard key={f.id} item={f} onChanged={refresh} />)}
      {resolved.length > 0 && <details><summary className="cursor-pointer text-sm text-muted-foreground">Theek ki gayi ({resolved.length})</summary>
        <div className="mt-3 space-y-3">{resolved.map(f => <FeedbackCard key={f.id} item={f} onChanged={refresh} />)}</div></details>}
    </div>}
  </section>;
}

/** Always show the full 14-day window so a single busy day reads as one bar, not a full-width block. */
function fillDays(stats: Data['stats'], days = 14): Data['stats'] {
  const byDay = new Map(stats.map(s => [s.day, s]));
  const end = stats.length ? new Date(`${[...stats].sort((a, b) => a.day.localeCompare(b.day)).at(-1)!.day}T00:00:00Z`) : new Date();
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const last = end > today ? end : today;
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(last.getTime() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    return byDay.get(d) ?? { day: d, turns: 0, stuck: 0, recovered: 0 };
  });
}

function StuckTrend({ stats: raw }: { stats: Data['stats'] }) {
  const stats = fillDays(raw);
  const turns = stats.reduce((n, s) => n + s.turns, 0);
  const stuck = stats.reduce((n, s) => n + s.stuck, 0);
  const recovered = stats.reduce((n, s) => n + s.recovered, 0);
  const max = Math.max(1, ...stats.map(s => s.turns));
  return <div className="space-y-5 border-y border-border py-5">
    <div className="flex items-center gap-2"><TrendingDown className="size-4 text-primary" aria-hidden /><h3 className="text-sm font-medium">Pichhle 14 din</h3></div>
    <div className="grid grid-cols-3 divide-x divide-border text-center">
      <div className="px-2"><p className="font-display text-2xl tabular-nums">{turns.toLocaleString('en-IN')}</p><p className="mt-1 text-xs text-muted-foreground">Jawab</p></div>
      <div className="px-2"><p className="font-display text-2xl tabular-nums">{pct(stuck, turns)}</p><p className="mt-1 text-xs text-muted-foreground">Student atka</p></div>
      <div className="px-2"><p className="font-display text-2xl tabular-nums">{recovered.toLocaleString('en-IN')}</p><p className="mt-1 text-xs text-muted-foreground">Atak ke samjha</p></div>
    </div>
    {turns > 0 && <div className="space-y-2"><div className="flex h-20 items-end gap-1" role="img" aria-label="Roz ke jawab aur student atakne ka hisaab">
      {stats.map(s => <div key={s.day} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${s.day}: ${s.turns} jawab, ${s.stuck} baar atka`}>
        <div className="relative overflow-hidden rounded-t-sm bg-primary/30" style={{ height: `${(s.turns / max) * 100}%` }}>
          <div className="rounded-t bg-destructive" style={{ height: `${s.turns ? (s.stuck / s.turns) * 100 : 0}%` }} />
        </div>
      </div>)}
    </div><div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground"><span>{stats[0]?.day} — {stats.at(-1)?.day}</span><span className="flex items-center gap-3"><span className="flex items-center gap-1.5"><i className="size-2 rounded-sm bg-primary/30" />Jawab</span><span className="flex items-center gap-1.5"><i className="size-2 rounded-sm bg-destructive" />Student atka</span></span></div></div>}
    {!turns && <p className="text-xs text-muted-foreground">Is dauraan abhi koi jawab record nahi hua.</p>}
  </div>;
}

function LessonCard({ lesson, onChanged }: { lesson: Lesson; onChanged: () => Promise<void> }) {
  const save = useServerFn(saveLesson);
  const remove = useServerFn(deleteLesson);
  const [guidance, setGuidance] = useState(lesson.guidance);
  const [problem, setProblem] = useState(lesson.problem);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const verdict = lessonVerdict(lesson);
  const stale = lesson.status === 'active' && isStale(lesson.last_matched_at, lesson.created_at);
  const shown = lesson.shown_ok + lesson.shown_stuck;
  const held = lesson.held_ok + lesson.held_stuck;
  const act = (status: Lesson['status'] | 'delete') => async () => {
    setBusy(true); setMsg('');
    try {
      if (status === 'delete') { if (!window.confirm('Yeh sabak hamesha ke liye hata dein?')) return; await remove({ data: { id: lesson.id } }); }
      else await save({ data: { id: lesson.id, problem, guidance, subject: asSubject(lesson.subject), status } });
      await onChanged();
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  const edited = guidance !== lesson.guidance || problem !== lesson.problem;

  return <article className="min-w-0 space-y-4 rounded-lg border border-border bg-card p-4 sm:p-5" aria-label="Sabak" aria-busy={busy}>
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="outline">{lesson.subject || 'general'}</Badge>
      {lesson.seen_count > 1 && <Badge variant="secondary">{lesson.seen_count} baar dikha</Badge>}
      {lesson.status === 'active' && <Badge variant={VERDICT[verdict].variant}>{VERDICT[verdict].label}</Badge>}
      {stale && <Badge variant="outline">Purana lag raha — 45+ din se kaam nahi aaya</Badge>}
    </div>
    <label className="block space-y-1.5 text-sm"><span className="font-medium">Student kahan atka</span>
      <Input value={problem} onChange={e => setProblem(e.target.value)} disabled={busy} /></label>
    <label className="block space-y-1.5 text-sm"><span className="font-medium">Tutor ke liye sabak</span>
      <Textarea value={guidance} onChange={e => setGuidance(e.target.value)} disabled={busy} rows={3} /></label>
    {lesson.example && <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Asli baatcheet dekhein</summary>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs">{lesson.example}</pre></details>}
    {lesson.status !== 'pending' && <p className="text-xs text-muted-foreground">
      Sabak ke saath: {shown} baar, baad mein atka {pct(lesson.shown_stuck, shown)} · Bina sabak (test): {held} baar, atka {pct(lesson.held_stuck, held)} · Aakhri baar kaam aaya: {when(lesson.last_matched_at)}
    </p>}
    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
      {busy && <Loader2 className="size-4 text-muted-foreground motion-safe:animate-spin" aria-label="Saving" />}
      {lesson.status === 'pending' && <Button size="sm" disabled={busy} onClick={act('active')}><Check className="size-4" aria-hidden />Lagu karo</Button>}
      {lesson.status === 'active' && edited && <Button size="sm" disabled={busy} onClick={act('active')}>Badlav save karo</Button>}
      {lesson.status === 'active' && <Button size="sm" variant="outline" disabled={busy} onClick={act('retired')}>Band karo</Button>}
      {lesson.status === 'retired' && <Button size="sm" variant="outline" disabled={busy} onClick={act('active')}>Phir se lagu karo</Button>}
      <Button size="sm" variant="ghost" disabled={busy} onClick={act('delete')}>{lesson.status === 'pending' ? 'Reject' : 'Hatao'}</Button>
    </div>
    {msg && <p className="text-sm text-destructive" role="status">{msg}</p>}
  </article>;
}

function NewLesson({ onChanged }: { onChanged: () => Promise<void> }) {
  const save = useServerFn(saveLesson);
  const [problem, setProblem] = useState('');
  const [guidance, setGuidance] = useState('');
  const [subject, setSubject] = useState<Subject>('general');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  return <details className="border-y border-dashed border-border py-4">
    <summary className="cursor-pointer text-sm font-medium">+ Khud ek sabak jodo</summary>
    <form className="mt-3 space-y-3" onSubmit={async e => {
      e.preventDefault(); setBusy(true); setMsg('');
      try { await save({ data: { problem, guidance, subject, status: 'active' } }); setProblem(''); setGuidance(''); await onChanged(); setMsg('Sabak lagu ho gaya ✓'); }
      catch (err) { setMsg((err as Error).message); } finally { setBusy(false); }
    }}>
      <Input placeholder="Kab? e.g. jab student projectile ka sawaal pooche" value={problem} onChange={e => setProblem(e.target.value)} disabled={busy} aria-label="Situation" />
      <Textarea placeholder="Tutor kya kare? e.g. pehle horizontal aur vertical motion alag-alag likho, phir formula" value={guidance} onChange={e => setGuidance(e.target.value)} disabled={busy} rows={3} aria-label="Sabak" />
      <div className="flex flex-wrap items-center gap-2">
        <select disabled={busy} className="h-9 rounded-md border border-input bg-background px-2 text-sm" value={subject} onChange={e => setSubject(asSubject(e.target.value))} aria-label="Subject">
          {SUBJECTS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <Button type="submit" size="sm" disabled={busy || guidance.trim().length < 10}>Lagu karo</Button>
      </div>
      {msg && <p className="text-sm text-muted-foreground" role="status">{msg}</p>}
    </form>
  </details>;
}

function FeedbackCard({ item, onChanged }: { item: Data['feedback'][number]; onChanged: () => Promise<void> }) {
  const update = useServerFn(updateFeedback);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act = (action: 'resolve' | 'reopen' | 'delete') => async () => {
    if (action === 'delete' && !window.confirm('Yeh shikayat hamesha ke liye hata dein?')) return;
    setBusy(true); setError('');
    try { await update({ data: { id: item.id, action } }); await onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Dobara koshish karein.'); }
    finally { setBusy(false); }
  };
  return <article className="min-w-0 space-y-3 rounded-lg border border-border bg-card p-4 sm:p-5" aria-label="Tutor shikayat" aria-busy={busy}>
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={item.status === 'open' ? 'destructive' : 'outline'}>{CATEGORY[item.category] ?? item.category}</Badge>
      {item.tool && <Badge variant="outline">{item.tool}</Badge>}
      {item.count > 1 && <Badge variant="secondary">{item.count} baar</Badge>}
      <span className="text-xs text-muted-foreground">Aakhri baar: {when(item.last_seen)}</span>
    </div>
    <p className="break-words text-sm leading-relaxed">{item.message}</p>
    <div className="flex flex-wrap items-center gap-2">
      {busy && <Loader2 className="size-4 text-muted-foreground motion-safe:animate-spin" aria-label="Saving" />}
      {item.status === 'open'
        ? <Button size="sm" variant="outline" disabled={busy} onClick={act('resolve')}>Theek ho gaya</Button>
        : <Button size="sm" variant="outline" disabled={busy} onClick={act('reopen')}>Phir kholo</Button>}
      <Button size="sm" variant="ghost" disabled={busy} onClick={act('delete')}>Hatao</Button>
    </div>
    {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
  </article>;
}
