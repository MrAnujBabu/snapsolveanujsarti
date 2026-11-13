// Browser-only: pulls speech out of a local or web video/audio file as 16 kHz mono WAV pieces.
// Media is decoded on the device (Mediabunny + WebCodecs), so large videos never upload whole;
// only small speech pieces go to the listener. Import lazily — never from SSR code paths.
import { AUDIO_CHUNK_SECONDS, MAX_MEDIA_SECONDS } from './youtube-hindi';

export const LISTEN_RATE = 16000;
export type AudioPiece = { index: number; offset: number; duration: number; wav: Blob };

/** Writes 16-bit PCM samples into a complete WAV file. */
export function pcm16Wav(samples: Int16Array, sampleRate = LISTEN_RATE): Blob {
  const header = new ArrayBuffer(44); const v = new DataView(header);
  const tag = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + samples.byteLength, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); tag(36, 'data'); v.setUint32(40, samples.byteLength, true);
  return new Blob([header, samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength) as ArrayBuffer], { type: 'audio/wav' });
}

/** Streaming box-filter resampler to 16 kHz: averages input inside each output step (light anti-aliasing for speech). */
export class SpeechResampler {
  private acc = 0; private n = 0; private pos = 0; private last = 0;
  constructor(private readonly outRate = LISTEN_RATE) {}
  push(input: Float32Array, inRate: number, emit: (value: number) => void) {
    const step = inRate / this.outRate;
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i] ?? 0; this.n++; this.pos += 1;
      while (this.pos >= step) {
        const value = this.n ? this.acc / this.n : this.last;
        emit(value); this.last = value; this.acc = 0; this.n = 0; this.pos -= step;
      }
    }
  }
}

/** Collects 16 kHz samples into fixed-length WAV pieces aligned to the media timeline. */
export class PieceWriter {
  private buffer: Int16Array; private filled = 0; private index = 0; private written = 0;
  constructor(private readonly pieceSeconds: number, private readonly onPiece: (piece: AudioPiece) => void, private readonly rate = LISTEN_RATE) {
    this.buffer = new Int16Array(pieceSeconds * rate);
  }
  get seconds() { return this.written / this.rate; }
  write(value: number) {
    const s = Math.max(-1, Math.min(1, value));
    this.buffer[this.filled++] = s < 0 ? s * 32768 : s * 32767;
    this.written++;
    if (this.filled === this.buffer.length) this.flush();
  }
  /** Inserts silence so a gap in the media keeps later speech at the right timestamp. */
  padTo(frame: number) { while (this.written < frame) this.write(0); }
  flush() {
    if (!this.filled) return;
    const samples = this.buffer.slice(0, this.filled);
    const offset = this.index * this.pieceSeconds;
    this.onPiece({ index: this.index, offset, duration: this.filled / this.rate, wav: pcm16Wav(samples, this.rate) });
    this.index++; this.filled = 0;
  }
}

function proxied(url: string) { return `/api/media-proxy?url=${encodeURIComponent(url)}`; }

/** Same-origin when the media site allows cross-origin reads, else through the app's media reader. */
async function readableUrl(url: string) {
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-1' }, mode: 'cors' });
    await res.body?.cancel().catch(() => {});
    if (res.ok || res.status === 206) return url;
  } catch { /* blocked by CORS */ }
  return proxied(url);
}

export type ExtractOptions = {
  file?: Blob; url?: string; signal: AbortSignal;
  pieceSeconds?: number; maxSeconds?: number;
  onPiece(piece: AudioPiece): void;
  onProgress?(seconds: number, total: number): void;
};

export class MediaAudioError extends Error {}

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function descriptionBytes(d: AllowSharedBufferSource | undefined): Uint8Array | null {
  if (!d) return null;
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  return null;
}

/**
 * HE-AAC (common on Instagram reels) is AAC-LC plus an add-on layer. Phone browsers that refuse "HE-AAC"
 * still play AAC-LC, so this rewrites the setup bytes to plain AAC-LC at the core rate — enough for speech.
 */
export function aacLcCoreConfig(description: Uint8Array): { description: Uint8Array; sampleRate: number; numberOfChannels: number } | null {
  let bit = 0;
  const read = (n: number) => { let v = 0; for (let i = 0; i < n; i++, bit++) { const byte = description[bit >> 3]; if (byte === undefined) throw new Error('short'); v = (v << 1) | ((byte >> (7 - (bit & 7))) & 1); } return v; };
  try {
    let objectType = read(5); if (objectType === 31) objectType = 32 + read(6);
    let rateIndex = read(4); let rate = rateIndex === 15 ? read(24) : AAC_RATES[rateIndex];
    const channels = read(4);
    if (objectType === 5 || objectType === 29) {
      const ext = read(4); if (ext === 15) read(24);
      let core = read(5); if (core === 31) core = 32 + read(6);
      if (core !== 2) return null;
    } else if (objectType !== 2) return null;
    if (rate === undefined || rateIndex === 15 || channels < 1 || channels > 7) return null;
    rateIndex = AAC_RATES.indexOf(rate); if (rateIndex < 0) return null;
    // objectType 2 (5 bits) · rate index (4) · channels (4) · GASpecificConfig zeros (3) = 16 bits.
    const word = (2 << 11) | (rateIndex << 7) | (channels << 3);
    return { description: new Uint8Array([word >> 8, word & 0xff]), sampleRate: rate, numberOfChannels: channels === 7 ? 8 : channels };
  } catch { return null; }
}

/** AAC decoder settings this browser accepts, trying plain AAC-LC labels when the exact codec is refused. */
async function supportedAacConfig(config: AudioDecoderConfig | null): Promise<AudioDecoderConfig | null> {
  if (!config || !config.codec.startsWith('mp4a') || typeof AudioDecoder === 'undefined') return null;
  const candidates: AudioDecoderConfig[] = [{ ...config, codec: 'mp4a.40.2' }];
  const bytes = descriptionBytes(config.description);
  const core = bytes ? aacLcCoreConfig(bytes) : null;
  if (core) candidates.push({ codec: 'mp4a.40.2', ...core });
  for (const candidate of candidates) {
    try { if ((await AudioDecoder.isConfigSupported(candidate)).supported) return candidate; } catch { /* try next */ }
  }
  return null;
}

type Sink = { add(mono: Float32Array, rate: number, timestamp: number): void; seconds(): number };

function makeSink(pieceSeconds: number, onPiece: (p: AudioPiece) => void) {
  const resampler = new SpeechResampler();
  const writer = new PieceWriter(pieceSeconds, onPiece);
  const sink: Sink = {
    add(mono, rate, timestamp) {
      writer.padTo(Math.round(timestamp * LISTEN_RATE) - LISTEN_RATE / 50);
      resampler.push(mono, rate, v => writer.write(v));
    },
    seconds: () => writer.seconds,
  };
  return { sink, writer };
}

function mixToMono(frames: number, channels: number, copy: (plane: Float32Array, c: number) => void) {
  const mono = new Float32Array(frames), plane = new Float32Array(frames);
  for (let c = 0; c < channels; c++) { copy(plane, c); for (let i = 0; i < frames; i++) mono[i] = (mono[i] ?? 0) + (plane[i] ?? 0) / channels; }
  return mono;
}

/** Feeds the track's raw packets to the browser's own AudioDecoder with settings it accepts. */
async function decodePackets(mb: typeof import('mediabunny'), track: import('mediabunny').InputAudioTrack, config: AudioDecoderConfig, end: number, sink: Sink, o: ExtractOptions) {
  let failure: unknown = null;
  const decoder = new AudioDecoder({
    output: data => {
      try {
        const mono = mixToMono(data.numberOfFrames, data.numberOfChannels, (plane, c) => data.copyTo(plane, { planeIndex: c, format: 'f32-planar' }));
        sink.add(mono, data.sampleRate, data.timestamp / 1e6);
      } catch (error) { failure ??= error; } finally { data.close(); }
    },
    error: error => { failure ??= error; },
  });
  decoder.configure(config);
  let lastReport = 0;
  try {
    for await (const packet of new mb.EncodedPacketSink(track).packets()) {
      if (o.signal.aborted || failure || packet.timestamp >= end) break;
      decoder.decode(packet.toEncodedAudioChunk());
      while (decoder.decodeQueueSize > 32 && !failure) await new Promise(r => setTimeout(r, 4));
      if (sink.seconds() - lastReport >= 5) { lastReport = sink.seconds(); o.onProgress?.(sink.seconds(), end); }
    }
    if (!failure && !o.signal.aborted) await decoder.flush();
  } finally { if (decoder.state !== 'closed') decoder.close(); }
  if (failure) throw failure;
}

const WHOLE_FILE_LIMIT = 250 * 1024 * 1024;

/** Downloads a web video whole (size-capped) so the browser's built-in sound decoder can try it. */
async function downloadWhole(url: string, signal: AbortSignal): Promise<Blob | null> {
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    if (Number(res.headers.get('content-length') || 0) > WHOLE_FILE_LIMIT) { await res.body?.cancel().catch(() => {}); return null; }
    const blob = await res.blob();
    return blob.size && blob.size <= WHOLE_FILE_LIMIT ? blob : null;
  } catch (error) { if (signal.aborted) throw error; return null; }
}

const CANNOT_OPEN = 'इस phone के browser में इस video की आवाज़ नहीं खुल पाई। Video download करके "Phone से" में upload करें, या Chrome में खोलें।';

/** Decodes the primary audio track and emits WAV pieces as soon as each is complete. */
export async function extractSpeechPieces(o: ExtractOptions): Promise<{ duration: number; heard: number; truncated: boolean }> {
  const mb = await import('mediabunny');
  const pieceSeconds = o.pieceSeconds ?? AUDIO_CHUNK_SECONDS, maxSeconds = o.maxSeconds ?? MAX_MEDIA_SECONDS;
  let source: InstanceType<typeof mb.BlobSource> | InstanceType<typeof mb.UrlSource>;
  let url = '';
  if (o.file) source = new mb.BlobSource(o.file);
  else if (o.url) { url = await readableUrl(o.url); source = new mb.UrlSource(url, { maxCacheSize: 32 * 1024 * 1024 }); }
  else throw new MediaAudioError('कोई video नहीं दी गई।');
  const input = new mb.Input({ formats: mb.ALL_FORMATS, source });
  const abort = () => { input.dispose(); };
  o.signal.addEventListener('abort', abort, { once: true });
  try {
    const track = await input.getPrimaryAudioTrack().catch(() => { throw new MediaAudioError('यह file पढ़ी नहीं जा सकी। MP4, WebM, MOV, MP3 या M4A आज़माएँ।'); });
    if (!track) throw new MediaAudioError('इस video में आवाज़ (audio track) नहीं मिली।');
    const total = await input.computeDuration().catch(() => 0);
    const end = Math.min(total || maxSeconds, maxSeconds);
    const { sink, writer } = makeSink(pieceSeconds, o.onPiece);
    const finish = () => {
      o.signal.throwIfAborted();
      writer.flush();
      o.onProgress?.(writer.seconds, end);
      return { duration: total, heard: writer.seconds, truncated: total > maxSeconds + 1 };
    };
    if (!(await track.canDecode())) {
      const fallback = await supportedAacConfig(await track.getDecoderConfig().catch(() => null));
      if (fallback) {
        try { await decodePackets(mb, track, fallback, end, sink, o); if (writer.seconds > 0) return finish(); }
        catch (error) { if (o.signal.aborted || writer.seconds > 0) throw error; }
      }
      const whole = o.file ?? (url ? await downloadWhole(url, o.signal) : null);
      if (whole) {
        try { return await decodeWithWebAudio(whole, pieceSeconds, maxSeconds, o); }
        catch (error) { if (o.signal.aborted) throw error; }
      }
      throw new MediaAudioError(CANNOT_OPEN);
    }
    const samples = new mb.AudioSampleSink(track);
    let lastReport = 0;
    for await (const sample of samples.samples(0, end)) {
      if (o.signal.aborted) { sample.close(); break; }
      try {
        const mono = mixToMono(sample.numberOfFrames, sample.numberOfChannels, (plane, c) => sample.copyTo(plane, { planeIndex: c, format: 'f32-planar' }));
        sink.add(mono, sample.sampleRate, sample.timestamp);
      } finally { sample.close(); }
      if (writer.seconds - lastReport >= 5) { lastReport = writer.seconds; o.onProgress?.(writer.seconds, end); }
      if (writer.seconds >= end) break;
    }
    return finish();
  } finally {
    o.signal.removeEventListener('abort', abort);
    input.dispose();
  }
}

/** Fallback for browsers without WebCodecs audio decoding: whole-file Web Audio decode (size-capped). */
async function decodeWithWebAudio(file: Blob, pieceSeconds: number, maxSeconds: number, o: ExtractOptions) {
  if (file.size > 250 * 1024 * 1024) throw new MediaAudioError('यह browser इतनी बड़ी file की आवाज़ नहीं खोल सकता। Chrome में खोलें या छोटी file चुनें।');
  const context = new OfflineAudioContext(1, 1, LISTEN_RATE);
  let buffer: AudioBuffer;
  try { buffer = await context.decodeAudioData(await file.arrayBuffer()); }
  catch { throw new MediaAudioError('इस file की आवाज़ खोली नहीं जा सकी।'); }
  o.signal.throwIfAborted();
  const frames = Math.min(buffer.length, Math.round(maxSeconds * buffer.sampleRate));
  const mono = new Float32Array(frames);
  for (let c = 0; c < buffer.numberOfChannels; c++) { const data = buffer.getChannelData(c); for (let i = 0; i < frames; i++) mono[i] = (mono[i] ?? 0) + (data[i] ?? 0) / buffer.numberOfChannels; }
  const writer = new PieceWriter(pieceSeconds, o.onPiece);
  new SpeechResampler().push(mono, buffer.sampleRate, v => writer.write(v));
  writer.flush();
  o.onProgress?.(writer.seconds, frames / buffer.sampleRate);
  return { duration: buffer.duration, heard: writer.seconds, truncated: buffer.duration > maxSeconds + 1 };
}
