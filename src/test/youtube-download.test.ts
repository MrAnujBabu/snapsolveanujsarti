import { expect, it } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { narrationWav } from '@/lib/youtube-download';

it('exports complete 24 kHz mono Hindi narration in the original transcript order', async () => {
  const { vi } = await import('vitest');
  vi.stubGlobal('Blob', NodeBlob);
  const first = new Uint8Array([1, 0, 2, 0]), second = new Uint8Array([3, 0]);
  const wav = await narrationWav([new Blob([first]), new Blob([second])]);
  const bytes = await wav.arrayBuffer(), header = new DataView(bytes);
  expect(wav.type).toBe('audio/wav');
  expect(header.getUint32(24, true)).toBe(24000);
  expect(header.getUint16(22, true)).toBe(1);
  expect(header.getUint32(40, true)).toBe(6);
  expect([...new Uint8Array(bytes, 44)]).toEqual([1, 0, 2, 0, 3, 0]);
  vi.unstubAllGlobals();
});
it('makes up to 4 narration pieces at once, each only once, and keeps transcript order', async () => {
  const { mapInOrder, NARRATION_PARALLEL } = await import('@/lib/youtube-download');
  expect(NARRATION_PARALLEL).toBe(4);
  let live = 0, peak = 0; const calls: number[] = [];
  const out = await mapInOrder([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], NARRATION_PARALLEL, async (n, i) => {
    calls.push(i); live++; peak = Math.max(peak, live);
    await new Promise(r => setTimeout(r, (11 - n) * 2));
    live--; return n * 10;
  });
  expect(out).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  expect(peak).toBe(4);
  expect(calls.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

it('stops starting new narration pieces after one fails', async () => {
  const { mapInOrder } = await import('@/lib/youtube-download');
  const started: number[] = [];
  await expect(mapInOrder([0, 1, 2, 3, 4, 5, 6, 7], 2, async i => {
    started.push(i); if (i === 1) throw new Error('boom'); await new Promise(r => setTimeout(r, 5)); return i;
  })).rejects.toThrow('boom');
  expect(started.length).toBeLessThan(8);
});

it('retries only a cut-off voice piece, up to 3 tries, and never a credits refusal', async () => {
  const { withPieceRetry } = await import('@/lib/youtube-download');
  const signal = new AbortController().signal;
  let calls = 0;
  await expect(withPieceRetry(async () => { calls++; if (calls < 3) throw new Error('Incomplete Hindi audio. Please try again.'); return 'ok'; }, signal, 3, 1)).resolves.toBe('ok');
  expect(calls).toBe(3);
  calls = 0;
  await expect(withPieceRetry(async () => { calls++; throw new Error('Incomplete Hindi audio. Please try again.'); }, signal, 3, 1)).rejects.toThrow('Incomplete');
  expect(calls).toBe(3);
  calls = 0;
  await expect(withPieceRetry(async () => { calls++; throw new Error('AI credits khatam ho gaye.'); }, signal, 3, 1)).rejects.toThrow('credits');
  expect(calls).toBe(1);
});

it('lets pieces already being made finish when another piece fails', async () => {
  const { mapInOrder } = await import('@/lib/youtube-download');
  const finished: number[] = [];
  await expect(mapInOrder([0, 1, 2, 3], 4, async i => {
    if (i === 0) throw new Error('boom');
    await new Promise(r => setTimeout(r, 5)); finished.push(i); return i;
  })).rejects.toThrow('boom');
  expect(finished.sort()).toEqual([1, 2, 3]);
});
