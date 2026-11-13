import { useEffect, useState } from 'react';
import { useServerFn } from '@tanstack/react-start';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { listAiKeys, saveAiKey, deleteAiKey, testAiKey } from '@/lib/ai-keys/ai-keys.functions';
import { PROVIDERS, checkKeyShape, type ProviderInfo } from '@/lib/ai-keys/catalog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

type Status = Awaited<ReturnType<typeof listAiKeys>>;
type KeyStatus = Status['keys'][number];

const when = (iso: string | null) => iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '';

export function AdminAiKeys() {
  const list = useServerFn(listAiKeys);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const refresh = async () => { try { setError(''); setStatus(await list()); } catch (e) { setError((e as Error).message); } };
  useEffect(() => { void refresh(); }, []);
  const byId = new Map(status?.keys.map(k => [k.provider, k]));

  return <section aria-label="AI API keys" className="space-y-6">
    <div className="space-y-2">
      <h2 className="font-display text-2xl">AI API keys</h2>
      <div className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 text-sm">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
        <div className="space-y-1">
          <p><strong>Abhi ka system:</strong> saara AI <strong>Lovable AI Gateway</strong> se hi chal raha hai — yahan key rakhne se kuch nahi badlega.</p>
          <p className="text-muted-foreground">Yeh keys future ke liye safe tijori mein rakhi jaati hain (encrypted). Save hone ke baad key dobara dikhayi nahi jaati — sirf "Saved" dikhega. Jab aap kahenge, tab kisi feature ko apni key par switch kiya jaayega.</p>
        </div>
      </div>
      {status && !status.vaultReady && <p className="text-sm text-destructive">Key tijori abhi taiyaar nahi hai — keys save nahi hongi.</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
    {(['ai', 'tools'] as const).map(group => <div key={group} className="space-y-3">
      <h3 className="font-display text-lg">{group === 'ai' ? 'AI models' : 'Awaaz, search aur web tools'}</h3>
      <div className="grid gap-3 md:grid-cols-2">
        {PROVIDERS.filter(p => p.group === group).map(p => <KeyCard key={p.id} info={p} status={byId.get(p.id)} loading={!status} onChanged={refresh} />)}
      </div>
    </div>)}
  </section>;
}

function KeyCard({ info, status, loading, onChanged }: { info: ProviderInfo; status: KeyStatus | undefined; loading: boolean; onChanged: () => Promise<void> }) {
  const save = useServerFn(saveAiKey);
  const remove = useServerFn(deleteAiKey);
  const test = useServerFn(testAiKey);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const run = (fn: () => Promise<string>) => async () => {
    setBusy(true); setMsg('');
    try { setMsg(await fn()); await onChanged(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  const shapeError = value ? checkKeyShape(info.id, value) : null;

  return <article className="space-y-3 rounded-xl border border-border bg-card p-4" aria-label={`${info.name} key`}>
    <div className="flex items-start justify-between gap-2">
      <div className="flex items-center gap-2"><KeyRound className="size-4 text-muted-foreground" aria-hidden /><h4 className="font-medium">{info.name}</h4></div>
      {loading ? null : status?.saved ? <Badge variant="secondary">Saved</Badge> : <Badge variant="outline">Khaali</Badge>}
    </div>
    <p className="text-sm text-muted-foreground">{info.usedFor}</p>
    <p className="text-xs text-muted-foreground">Key kahan milegi: {info.getKeyAt}</p>
    {status?.saved && <p className="text-xs text-muted-foreground">Saved: {when(status.updatedAt)}{status.checkedAt ? ` · Test: ${status.checkNote ?? ''}` : ''}</p>}
    <form className="flex gap-2" onSubmit={e => { e.preventDefault(); if (!shapeError && value) void run(async () => { await save({ data: { provider: info.id, key: value } }); setValue(''); return 'Key safe rakh di ✓'; })(); }}>
      <Input type="password" autoComplete="off" spellCheck={false} placeholder={status?.saved ? 'Nayi key paste karein (purani badal jaayegi)' : `Paste: ${info.hint}`}
        value={value} onChange={e => setValue(e.target.value)} disabled={busy || loading} aria-label={`${info.name} API key`} />
      <Button type="submit" disabled={busy || loading || !value || !!shapeError}>Save</Button>
    </form>
    {shapeError && <p className="text-xs text-destructive">{shapeError}</p>}
    {status?.saved && <div className="flex flex-wrap gap-2">
      {info.testable && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={run(async () => (await test({ data: { provider: info.id } })).note)}>Test key (free)</Button>}
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { if (window.confirm(`${info.name} ki saved key hata dein?`)) void run(async () => { await remove({ data: { provider: info.id } }); return 'Key hata di.'; })(); }}>Remove</Button>
    </div>}
    {msg && <p className="text-sm text-muted-foreground" role="status">{msg}</p>}
  </article>;
}
