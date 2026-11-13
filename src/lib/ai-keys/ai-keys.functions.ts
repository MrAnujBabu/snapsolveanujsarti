import { createServerFn } from '@tanstack/react-start';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { z } from 'zod';
import { PROVIDERS, checkKeyShape, providerInfo, type ProviderId } from './catalog';

type Ctx = { supabase: { rpc: (fn: 'has_role', args: { _user_id: string; _role: 'admin' }) => PromiseLike<{ data: unknown; error: unknown }> }; userId: string };
async function assertAdmin({ supabase, userId }: Ctx) {
  const { data, error } = await supabase.rpc('has_role', { _user_id: userId, _role: 'admin' });
  if (error || !data) throw new Error('Access denied');
}
const providerSchema = z.string().refine(v => !!providerInfo(v), 'Unknown service');

/** Status only — stored keys never leave the server. */
export const listAiKeys = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context as unknown as Ctx);
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const { data, error } = await supabaseAdmin.from('ai_provider_keys').select('provider,updated_at,last_check_at,last_check_ok,last_check_note');
    if (error) throw new Error(error.message);
    const rows = new Map((data ?? []).map(r => [r.provider, r]));
    return {
      vaultReady: (process.env['AI_KEY_VAULT_SECRET'] ?? '').length >= 32,
      keys: PROVIDERS.map(p => {
        const r = rows.get(p.id);
        return { provider: p.id, saved: !!r, updatedAt: r?.updated_at ?? null, checkedAt: r?.last_check_at ?? null, checkOk: r?.last_check_ok ?? null, checkNote: r?.last_check_note ?? null };
      }),
    };
  });

export const saveAiKey = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ provider: providerSchema, key: z.string().max(600) }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context as unknown as Ctx);
    const bad = checkKeyShape(data.provider, data.key);
    if (bad) throw new Error(bad);
    const secret = process.env['AI_KEY_VAULT_SECRET'];
    if (!secret) throw new Error('Key vault is not configured.');
    const { sealKey } = await import('./vault-crypto');
    const sealed = await sealKey(secret, data.provider, data.key.trim());
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const { error } = await supabaseAdmin.from('ai_provider_keys').upsert({
      provider: data.provider, ...sealed, key_version: 1, updated_by: context.userId, updated_at: new Date().toISOString(),
      last_check_at: null, last_check_ok: null, last_check_note: null,
    });
    if (error) throw new Error(error.message);
    return { saved: true };
  });

export const deleteAiKey = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ provider: providerSchema }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context as unknown as Ctx);
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const { error } = await supabaseAdmin.from('ai_provider_keys').delete().eq('provider', data.provider);
    if (error) throw new Error(error.message);
    return { deleted: true };
  });

export const testAiKey = createServerFn({ method: 'POST' })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ provider: providerSchema }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context as unknown as Ctx);
    const provider = data.provider as ProviderId;
    const { readStoredProviderKey, probeProviderKey } = await import('./vault.server');
    const key = await readStoredProviderKey(provider);
    const result = key ? await probeProviderKey(provider, key) : { ok: false, note: 'Saved key khul nahi payi — dobara paste karein.' };
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    await supabaseAdmin.from('ai_provider_keys').update({ last_check_at: new Date().toISOString(), last_check_ok: result.ok, last_check_note: result.note }).eq('provider', provider);
    return result;
  });
