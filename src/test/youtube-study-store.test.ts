import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { isSavedYouTubeStudy, loadYouTubeStudy, saveYouTubeStudy, libraryKey, type SavedYouTubeStudy } from '@/lib/youtube-study-store';

it('keeps distinct conversions of the same video in separate library entries', () => {
  expect(libraryKey({ title: 'T', videoId: 'Lt54CX9DmS4', sourceKey: 'reviewed' }, '', '')).
    not.toBe(libraryKey({ title: 'T', videoId: 'Lt54CX9DmS4', sourceKey: 'fast' }, '', ''));
});

it('restores completed transcript, timestamps, URL and voice from device storage', async () => {
  const study: SavedYouTubeStudy = { version: 1, url: 'https://youtu.be/KA5kPbdkK2E', transcript: '', voice: 'ishita_hi_edtech',
    result: { title: 'Lecture', hindi: 'पहला। दूसरा।', truncated: false, videoId: 'KA5kPbdkK2E', dub: [{ start: 0, end: 30, hindi: 'पहला।' }, { start: 30, end: 60, hindi: 'दूसरा।' }] } };
  await saveYouTubeStudy(study);
  expect(await loadYouTubeStudy()).toEqual(study);
});
it('rejects corrupt stored timestamps and unknown voices', () => {
  expect(isSavedYouTubeStudy({ version: 1, voice: 'fake', url: '', transcript: '', result: {} })).toBe(false);
  expect(isSavedYouTubeStudy({ version: 1, voice: 'ishita_hi_edtech', url: '', transcript: '', result: { title: '', hindi: 'a', truncated: false, dub: [{ start: 30, end: 1, hindi: 'a' }] } })).toBe(false);
});
it('keeps finished Hindi audio on the device for re-download, newest 5 only', async () => {
  // jsdom's Blob cannot be stored by the test database; browsers store real Blobs.
  const { Blob: NodeBlob } = await import('node:buffer'); const { vi } = await import('vitest'); vi.stubGlobal('Blob', NodeBlob);
  const { saveNarrationAudio, listNarrationAudio, removeNarrationAudio, textFingerprint, AUDIO_LIMIT } = await import('@/lib/youtube-study-store');
  expect(AUDIO_LIMIT).toBe(5);
  for (let i = 0; i < 6; i++) {
    await saveNarrationAudio({ key: `video:${i}`, savedAt: 1000 + i, textHash: textFingerprint(`हिंदी ${i}`), voice: 'ishita_hi_edtech', engine: 'sarvam', blob: new Blob([new Uint8Array(100)], { type: 'audio/wav' }) });
  }
  const keys = (await listNarrationAudio()).map(a => a.key).sort();
  expect(keys).toEqual(['video:1', 'video:2', 'video:3', 'video:4', 'video:5']);
  await removeNarrationAudio('video:5');
  expect((await listNarrationAudio()).map(a => a.key)).not.toContain('video:5');
  vi.unstubAllGlobals();
});

it('treats audio as stale once the Hindi text changes', async () => {
  const { textFingerprint } = await import('@/lib/youtube-study-store');
  expect(textFingerprint('पहला। दूसरा।')).toBe(textFingerprint('पहला। दूसरा।'));
  expect(textFingerprint('पहला। दूसरा।')).not.toBe(textFingerprint('पहला। तीसरा।'));
});
