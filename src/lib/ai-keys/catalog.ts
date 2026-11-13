/**
 * Browser-safe list of AI services whose keys the admin may store for the future.
 * Saved keys are DORMANT: no existing feature reads them. Everything still runs on
 * the Lovable AI Gateway until a later, explicit change wires a provider in.
 */
export type ProviderId =
  | 'lovable' | 'anthropic' | 'openai' | 'google' | 'openrouter'
  | 'bytedance' | 'topaz' | 'sarvam' | 'perplexity' | 'parallel' | 'firecrawl';

export type ProviderInfo = {
  id: ProviderId;
  name: string;
  /** Where this app uses the service today (plain words for the admin). */
  usedFor: string;
  /** Where the admin gets a key. */
  getKeyAt: string;
  /** Loose shape check; a mismatch is refused so a wrong paste is caught early. */
  pattern?: RegExp;
  hint: string;
  /** A free, read-only "is this key valid?" check exists. */
  testable: boolean;
  group: 'ai' | 'tools';
};

export const PROVIDERS: readonly ProviderInfo[] = [
  { id: 'lovable', name: 'Lovable AI Gateway', group: 'ai', testable: true, hint: 'Lovable API key',
    usedFor: 'Abhi saara AI isi se chalta hai (Claude, GPT, Gemini, Seedream, Seedance, Topaz). Yahan doosre project / doosri hosting ki key rakh sakte hain.',
    getKeyAt: 'Lovable project → Settings → Cloud / AI' },
  { id: 'anthropic', name: 'Claude (Anthropic)', group: 'ai', testable: true, pattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/, hint: 'sk-ant-…',
    usedFor: 'Tutor ke jawab, voice call ka dimaag, answer-check ka final judge.',
    getKeyAt: 'console.anthropic.com → API Keys' },
  { id: 'openai', name: 'OpenAI (GPT)', group: 'ai', testable: true, pattern: /^sk-(?!ant-|or-)[A-Za-z0-9_-]{20,}$/, hint: 'sk-… / sk-proj-…',
    usedFor: 'Maths check, diagram pictures (gpt-image), search ke liye text samajhna, awaaz se likhna.',
    getKeyAt: 'platform.openai.com → API keys' },
  { id: 'google', name: 'Google Gemini', group: 'ai', testable: true, pattern: /^AIza[A-Za-z0-9_-]{30,}$/, hint: 'AIza…',
    usedFor: 'Facts check, photo padhna, live voice call, transcript, Veo video.',
    getKeyAt: 'aistudio.google.com → Get API key' },
  { id: 'openrouter', name: 'OpenRouter', group: 'ai', testable: true, pattern: /^sk-or-[A-Za-z0-9_-]{20,}$/, hint: 'sk-or-v1-…',
    usedFor: 'Ek hi key se kai companies ke model (Claude, GPT, Gemini, DeepSeek…). Backup ke liye accha.',
    getKeyAt: 'openrouter.ai → Keys' },
  { id: 'bytedance', name: 'ByteDance (BytePlus ModelArk)', group: 'ai', testable: false, hint: 'ModelArk API key',
    usedFor: 'AI Studio: Seedream pictures aur Seedance animation.',
    getKeyAt: 'console.byteplus.com → ModelArk → API keys' },
  { id: 'topaz', name: 'Topaz Labs', group: 'ai', testable: false, hint: 'Topaz API key',
    usedFor: 'AI Studio: purani / dhundhli video saaf karna.',
    getKeyAt: 'topazlabs.com → Account → API' },
  { id: 'sarvam', name: 'Sarvam AI', group: 'tools', testable: false, hint: 'Sarvam API subscription key',
    usedFor: 'Hindi / Indian awaaz (YouTube dub, voice). Abhi apne connection se chalta hai.',
    getKeyAt: 'dashboard.sarvam.ai → API keys' },
  { id: 'perplexity', name: 'Perplexity', group: 'tools', testable: false, pattern: /^pplx-[A-Za-z0-9]{20,}$/, hint: 'pplx-…',
    usedFor: 'Web search (backup).',
    getKeyAt: 'perplexity.ai → Settings → API' },
  { id: 'parallel', name: 'Parallel', group: 'tools', testable: false, hint: 'Parallel API key',
    usedFor: 'Web search (doosra source).',
    getKeyAt: 'platform.parallel.ai → API keys' },
  { id: 'firecrawl', name: 'Firecrawl', group: 'tools', testable: false, pattern: /^fc-[A-Za-z0-9]{20,}$/, hint: 'fc-…',
    usedFor: 'Web page padhna (backup reader).',
    getKeyAt: 'firecrawl.dev → Dashboard → API keys' },
];

export function providerInfo(id: string): ProviderInfo | undefined {
  return PROVIDERS.find(p => p.id === id);
}

/** Returns an error message for a pasted key, or null when it looks right. */
export function checkKeyShape(id: string, raw: string): string | null {
  const p = providerInfo(id);
  if (!p) return 'Unknown service.';
  const key = raw.trim();
  if (key.length < 8) return 'Key bahut chhoti hai — poori key paste karein.';
  if (key.length > 512) return 'Key bahut lambi hai — sirf key paste karein.';
  if (/\s/.test(key)) return 'Key mein space / nayi line nahi honi chahiye.';
  if (p.pattern && !p.pattern.test(key)) return `Yeh ${p.name} key jaisi nahi lagti (aisi dikhti hai: ${p.hint}).`;
  return null;
}
