import { encodeWav } from './record-wav';
import { SPEECH_SAMPLE_RATE } from './stream-speech';
import { downloadBlob } from './transcript-export';

/** Join PCM payloads in transcript order, with one valid WAV header. */
export async function narrationWav(parts: readonly Blob[]): Promise<Blob> {
  const size = parts.reduce((sum, part) => sum + part.size, 0);
  if (!size || size % 2 || size > 0xffffffff - 36) throw new Error('Invalid narration audio.');
  const header = await encodeWav([], SPEECH_SAMPLE_RATE).arrayBuffer();
  const view = new DataView(header);
  view.setUint32(4, 36 + size, true);
  view.setUint32(40, size, true);
  return new Blob([header, ...parts], { type: 'audio/wav' });
}

export async function deliverNarration(blob: Blob, name: string) {
  const file = new File([blob], name, { type: 'audio/wav' });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (error) { if (error instanceof DOMException && error.name === 'AbortError') return; }
  }
  downloadBlob(name, blob);
}
/** Simultaneous voice requests while preparing a download (each piece is still made exactly once). */
export const NARRATION_PARALLEL = 4;

/** Run `work` over every item with at most `limit` in flight; results keep input order.
 * The first failure stops new work from starting; pieces already being made are allowed to finish
 * (so callers can keep them) before the first error is thrown. */
export async function mapInOrder<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>, onDone?: (done: number) => void): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0, done = 0, failure: { error: unknown } | null = null;
  async function lane() {
    while (!failure && next < items.length) {
      const i = next++;
      try { out[i] = await work(items[i] as T, i); onDone?.(++done); }
      catch (error) { failure ??= { error }; }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  if (failure) throw (failure as { error: unknown }).error;
  return out;
}

/** A broken or cut-off voice stream (not a credits/access refusal) is worth one more try for that piece only. */
export function isRetryablePieceError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  if (error instanceof TypeError) return true; // network dropped
  const message = error instanceof Error ? error.message : String(error);
  return /Incomplete Hindi audio|Invalid audio stream|No audio|network|Speech failed \((429|5\d\d|network)\)/i.test(message);
}

/** Make one piece, trying again (up to `tries` times in total) only when the stream broke. */
export async function withPieceRetry<R>(make: () => Promise<R>, signal: AbortSignal, tries = 3, waitMs = 1500): Promise<R> {
  for (let attempt = 1; ; attempt++) {
    try { return await make(); }
    catch (error) {
      if (signal.aborted || attempt >= tries || !isRetryablePieceError(error)) throw error;
      await new Promise(r => setTimeout(r, waitMs * attempt));
      signal.throwIfAborted();
    }
  }
}
