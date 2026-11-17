import { describe, it, expect, beforeEach } from 'vitest';
import { readDubVoiceOn } from '@/components/youtube-dub';

describe('YouTube voice on/off choice', () => {
  beforeEach(() => localStorage.clear());
  it('voice is on by default', () => { expect(readDubVoiceOn()).toBe(true); });
  it('remembers voice off on this device', () => {
    localStorage.setItem('snapsolve.youtube-dub-voice', 'off');
    expect(readDubVoiceOn()).toBe(false);
  });
});
