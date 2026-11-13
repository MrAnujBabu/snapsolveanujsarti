import { describe, expect, it } from 'vitest';
import { interpretTimed, interpretProse, timedBatchPrompt } from '@/lib/interpreter.server';
import { checkpointKey } from '@/lib/interpret-checkpoint';

const segs = [{ start: 0, end: 10, text: 'मुझको ना बाँधिए, मुझे उड़ जाने दीजिए' }];
const ctx = { title: 'Reel', brief: null };

describe('as-it-is (word-to-word) transcript toggle', () => {
  it('asks for the exact words, without a word limit, and checks them as an exact transcript', async () => {
    const calls: { system: string; user: string }[] = [];
    await interpretTimed({ segments: segs, context: ctx, engine: 'claude', signal: new AbortController().signal, review: true, verbatim: true, onSegment: () => {},
      call: async (_e, system, user) => { calls.push({ system, user }); return calls.length === 1 ? '### 1\nमुझको ना बाँधिए, मुझे उड़ जाने दीजिए।' : '### 1\nOK'; } });
    expect(calls[0]?.system).toContain('AS-IT-IS');
    expect(calls[0]?.user).not.toMatch(/max \d+ words/);
    expect(calls[1]?.system).toContain('AS-IT-IS');
    expect(calls[1]?.user).not.toMatch(/max \d+ words/);
  });

  it('keeps the simple-Hindi explanation when the toggle is off', async () => {
    const systems: string[] = [];
    await interpretTimed({ segments: segs, context: ctx, engine: 'claude', signal: new AbortController().signal, review: false, onSegment: () => {},
      call: async (_e, system) => { systems.push(system); return '### 1\nमुझे बाँधिए मत।'; } });
    expect(systems[0]).not.toContain('AS-IT-IS');
    expect(timedBatchPrompt(segs, ctx)).toMatch(/max \d+ words/);
  });

  it('uses the exact-words instructions for pasted transcripts too', async () => {
    const systems: string[] = [];
    await interpretProse({ chunks: ['मुझको ना बाँधिए'], context: ctx, engine: 'gpt', signal: new AbortController().signal, review: false, verbatim: true, onChunk: () => {},
      call: async (_e, system) => { systems.push(system); return '### 1\nमुझको ना बाँधिए।'; } });
    expect(systems[0]).toContain('AS-IT-IS');
  });

  it('saves as-it-is progress separately from simple-Hindi progress', () => {
    const input = { kind: 'link' as const, url: 'https://www.instagram.com/reel/DfeTunvAEk-/' };
    expect(checkpointKey(input, 'claude', true, false, true)).not.toBe(checkpointKey(input, 'claude', true, false));
    expect(checkpointKey(input, 'claude', true, false, false)).toBe(checkpointKey(input, 'claude', true, false));
  });
});
