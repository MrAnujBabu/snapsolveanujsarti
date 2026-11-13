import { describe, expect, it } from 'vitest';
import { aacLcCoreConfig } from '@/lib/media-audio';

describe('aacLcCoreConfig', () => {
  it('turns an Instagram HE-AAC 44.1 kHz stereo setup into AAC-LC at the 22.05 kHz core', () => {
    const out = aacLcCoreConfig(new Uint8Array([0x2b, 0x92, 0x08]));
    expect(out).toEqual({ description: new Uint8Array([0x13, 0x90]), sampleRate: 22050, numberOfChannels: 2 });
  });

  it('keeps a plain AAC-LC 44.1 kHz stereo setup as AAC-LC', () => {
    expect(aacLcCoreConfig(new Uint8Array([0x12, 0x10]))).toEqual({ description: new Uint8Array([0x12, 0x10]), sampleRate: 44100, numberOfChannels: 2 });
  });

  it('refuses non-AAC-LC families and truncated bytes', () => {
    expect(aacLcCoreConfig(new Uint8Array([0x0a, 0x10]))).toBeNull();
    expect(aacLcCoreConfig(new Uint8Array([0x2b]))).toBeNull();
  });
});
