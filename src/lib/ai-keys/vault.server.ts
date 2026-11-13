/**
 * Server-only reader for stored provider keys. Intentionally NOT used by any
 * feature yet — the app stays on the Lovable AI Gateway. A future change can call
 * readStoredProviderKey('anthropic') to switch a feature onto the admin's own key.
 */
import { openKey } from './vault-crypto';
import type { ProviderId } from './catalog';

export async function readStoredProviderKey(provider: ProviderId): Promise<string | null> {
  const secret = process.env['AI_KEY_VAULT_SECRET'];
  if (!secret) return null;
  const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
  const { data } = await supabaseAdmin.from('ai_provider_keys').select('iv,ciphertext').eq('provider', provider).maybeSingle();
  if (!data) return null;
  try { return await openKey(secret, provider, data); } catch { return null; }
}

/** Free, read-only validity checks (list models / key info). Never generates anything billable. */
export async function probeProviderKey(provider: ProviderId, key: string): Promise<{ ok: boolean; note: string }> {
  const req: Record<string, [string, Record<string, string>]> = {
    lovable: ['https://ai.gateway.lovable.dev/v1/models', { Authorization: `Bearer ${key}` }],
    anthropic: ['https://api.anthropic.com/v1/models?limit=1', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }],
    openai: ['https://api.openai.com/v1/models', { Authorization: `Bearer ${key}` }],
    google: ['https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { 'x-goog-api-key': key }],
    openrouter: ['https://openrouter.ai/api/v1/key', { Authorization: `Bearer ${key}` }],
  };
  const target = req[provider];
  if (!target) return { ok: false, note: 'Is service ke liye free test nahi hai.' };
  try {
    const res = await fetch(target[0], { headers: target[1], signal: AbortSignal.timeout(10_000) });
    await res.body?.cancel().catch(() => {});
    if (res.ok) return { ok: true, note: 'Key sahi hai ✓' };
    if (res.status === 401 || res.status === 403) return { ok: false, note: 'Key galat ya band hai.' };
    if (res.status === 429) return { ok: false, note: 'Service abhi busy hai — thodi der baad test karein.' };
    return { ok: false, note: `Service ne mana kiya (code ${res.status}).` };
  } catch {
    return { ok: false, note: 'Service tak pahunch nahi paye — baad mein test karein.' };
  }
}
