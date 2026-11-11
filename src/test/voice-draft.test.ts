import { describe, expect, it } from 'vitest';
import { loadVoiceDraft, saveVoiceDraft, VOICE_DRAFT_KEY } from '@/lib/voice-draft';

function memory(): Storage {
  const m = new Map<string, string>();
  return { getItem: k => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: k => { m.delete(k); }, clear: () => m.clear(), key: () => null, get length() { return m.size; } } as Storage;
}
const rows = [{ id: 'a', role: 'user' as const, text: 'Photosynthesis samjhao' }, { id: 'b', role: 'assistant' as const, text: 'Chalo shuru karte hain.' }];
const HOUR = 60 * 60 * 1000;

describe('voice transcript saved on the device', () => {
  it('comes back after a refresh within 24 hours', () => {
    const store = memory();
    saveVoiceDraft(rows, [], 1_000, store);
    expect(loadVoiceDraft(1_000 + 23 * HOUR, store)?.rows).toEqual(rows);
  });
  it('is deleted once 24 hours have passed', () => {
    const store = memory();
    saveVoiceDraft(rows, [], 1_000, store);
    expect(loadVoiceDraft(1_000 + 24 * HOUR, store)).toBeNull();
    expect(store.getItem(VOICE_DRAFT_KEY)).toBeNull();
  });
  it('restarts the 24 hours when the transcript changes', () => {
    const store = memory();
    saveVoiceDraft(rows.slice(0, 1), [], 0, store);
    saveVoiceDraft(rows, [], 20 * HOUR, store);
    expect(loadVoiceDraft(30 * HOUR, store)?.rows).toHaveLength(2);
  });
});
