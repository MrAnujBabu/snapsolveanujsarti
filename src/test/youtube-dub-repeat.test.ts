import { describe, it, expect, vi } from 'vitest';
import { runDubPlayback } from '@/lib/youtube-dub-sync';

function setup(startTime: number) {
  let time = startTime, state = 1;
  const sources: { offset: number; onended: (() => void) | null }[] = [];
  const ctx = { state: 'running', currentTime: 0, destination: {}, resume: vi.fn(), suspend: vi.fn(),
    createBufferSource: () => {
      const source = { offset: -1, onended: null as (() => void) | null, connect: vi.fn(), disconnect: vi.fn(),
        start: vi.fn((_: number, offset: number) => { source.offset = offset; }), stop: vi.fn() };
      sources.push(source); return source;
    } } as unknown as AudioContext;
  const p = { getCurrentTime: () => time, getPlayerState: () => state, getPlaybackRate: () => 1, getAvailablePlaybackRates: () => [0.5, 0.75, 1],
    setPlaybackRate: vi.fn(), mute: vi.fn(), unMute: vi.fn(), seekTo: vi.fn(), playVideo: vi.fn(() => { state = 1; }), pauseVideo: vi.fn(() => { state = 2; }) };
  return { p, ctx, sources, setTime: (t: number) => { time = t; } };
}
const segments = [{ start: 0, end: 10, hindi: 'पहला हिस्सा।' }, { start: 10, end: 20, hindi: 'दूसरा हिस्सा।' }];

describe('Hindi voice-over never speaks a part twice', () => {
  it('waits silently when the voice of a part finishes before its video window ends', async () => {
    vi.useFakeTimers();
    const { p, ctx, sources, setTime } = setup(0.1);
    const ctl = new AbortController(), buffer = { duration: 4 } as AudioBuffer;
    const task = runDubPlayback({ player: p, context: ctx, segments, from: 0, signal: ctl.signal,
      getAudio: async () => buffer, readyAudio: () => buffer, update: vi.fn(), paused: () => false, holding: vi.fn() }).catch(e => e);
    try {
      await vi.advanceTimersByTimeAsync(120);
      expect(sources.length).toBe(1);
      setTime(4.2); sources[0]?.onended?.();
      for (let t = 4.3; t < 9.9; t += 0.06) { setTime(t); await vi.advanceTimersByTimeAsync(60); }
      expect(sources.length).toBe(1);
      setTime(10.01); await vi.advanceTimersByTimeAsync(120);
      expect(sources.length).toBe(2);
      expect(sources[1]?.offset).toBeLessThan(0.1);
      ctl.abort(); await vi.advanceTimersByTimeAsync(120); await task;
    } finally { vi.useRealTimers(); }
  });
  it('starting from a timestamp that lands just before it does not play the previous part', async () => {
    vi.useFakeTimers();
    const { p, ctx, sources, setTime } = setup(9.8);
    const ctl = new AbortController(), buffer = { duration: 4 } as AudioBuffer;
    const task = runDubPlayback({ player: p, context: ctx, segments, from: 1, signal: ctl.signal,
      getAudio: async () => buffer, readyAudio: () => buffer, update: vi.fn(), paused: () => false, holding: vi.fn() }).catch(e => e);
    try {
      await vi.advanceTimersByTimeAsync(120);
      for (let t = 9.82; t < 9.94; t += 0.03) { setTime(t); await vi.advanceTimersByTimeAsync(60); }
      expect(sources.length).toBe(0);
      setTime(10.01); await vi.advanceTimersByTimeAsync(120);
      expect(sources.length).toBe(1);
      expect(sources[0]?.offset).toBeLessThan(0.1);
      ctl.abort(); await vi.advanceTimersByTimeAsync(120); await task;
    } finally { vi.useRealTimers(); }
  });
  it('still follows a real jump back into the previous part', async () => {
    vi.useFakeTimers();
    const { p, ctx, sources, setTime } = setup(0.1);
    const ctl = new AbortController(), buffer = { duration: 4 } as AudioBuffer;
    const task = runDubPlayback({ player: p, context: ctx, segments, from: 0, signal: ctl.signal,
      getAudio: async () => buffer, readyAudio: () => buffer, update: vi.fn(), paused: () => false, holding: vi.fn() }).catch(e => e);
    try {
      await vi.advanceTimersByTimeAsync(120);
      setTime(4.2); sources[0]?.onended?.();
      await vi.advanceTimersByTimeAsync(120);
      setTime(1); await vi.advanceTimersByTimeAsync(120);
      expect(sources.length).toBe(2);
      ctl.abort(); await vi.advanceTimersByTimeAsync(120); await task;
    } finally { vi.useRealTimers(); }
  });
});
