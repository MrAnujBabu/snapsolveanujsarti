import { describe, it, expect } from 'vitest';
import { checkKeyShape, PROVIDERS } from '@/lib/ai-keys/catalog';
import { sealKey, openKey } from '@/lib/ai-keys/vault-crypto';

const SECRET = 'x'.repeat(64);

describe('AI key vault', () => {
  it('lists Claude, OpenAI, Gemini and Lovable as storable services', () => {
    const ids = PROVIDERS.map(p => p.id);
    for (const id of ['anthropic', 'openai', 'google', 'lovable']) expect(ids).toContain(id);
  });

  it('refuses an OpenAI-looking key in the Claude slot, accepts a Claude key', () => {
    expect(checkKeyShape('anthropic', 'sk-proj-abcdefghijklmnopqrstuvwxyz')).not.toBeNull();
    expect(checkKeyShape('anthropic', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz')).toBeNull();
  });

  it('refuses a Claude key or OpenRouter key in the OpenAI slot', () => {
    expect(checkKeyShape('openai', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz')).not.toBeNull();
    expect(checkKeyShape('openai', 'sk-or-v1-abcdefghijklmnopqrstuvwxyz')).not.toBeNull();
    expect(checkKeyShape('openai', 'sk-proj-abcdefghijklmnopqrstuvwxyz')).toBeNull();
  });

  it('refuses keys with spaces and unknown services', () => {
    expect(checkKeyShape('lovable', 'abc def ghi jkl')).not.toBeNull();
    expect(checkKeyShape('nope', 'abcdefghijkl')).not.toBeNull();
  });

  it('stores keys encrypted and opens them only for the same service', async () => {
    const sealed = await sealKey(SECRET, 'anthropic', 'sk-ant-real-key-value');
    expect(sealed.ciphertext).not.toContain('sk-ant');
    expect(await openKey(SECRET, 'anthropic', sealed)).toBe('sk-ant-real-key-value');
    await expect(openKey(SECRET, 'openai', sealed)).rejects.toThrow();
    await expect(openKey('y'.repeat(64), 'anthropic', sealed)).rejects.toThrow();
  });
});
