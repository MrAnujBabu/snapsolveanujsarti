import { describe, it, expect } from 'vitest';
import { cleanTranscript, isNoiseOnly } from '@/lib/noise-filter';

describe('transcript noise filter', () => {
  it('drops whisper and noise tags', () => {
    expect(isNoiseOnly('[whispering]')).toBe(true);
    expect(isNoiseOnly('(background noise)')).toBe(true);
    expect(cleanTranscript('Mitochondria kya hai [inaudible]').trim()).toBe('Mitochondria kya hai');
  });
  it('drops phantom phrases from silence', () => {
    expect(isNoiseOnly('Thank you for watching!')).toBe(true);
  });
  it('keeps real speech', () => {
    expect(cleanTranscript('Option B sahi hai').trim()).toBe('Option B sahi hai');
    expect(isNoiseOnly('B')).toBe(false);
  });
});

describe('traffic and machinery noise', () => {
  it('drops vehicle, factory, weather and animal sound tags', () => {
    expect(isNoiseOnly('(car horn)')).toBe(true);
    expect(isNoiseOnly('(engine noise)')).toBe(true);
    expect(isNoiseOnly('(traffic)')).toBe(true);
    expect(isNoiseOnly('[dog barking]')).toBe(true);
    expect(isNoiseOnly('(factory machine)')).toBe(true);
    expect(isNoiseOnly('(train passing)')).toBe(true);
    expect(isNoiseOnly('(हॉर्न)')).toBe(true);
  });
  it('keeps the speech around a noise tag', () => {
    expect(cleanTranscript('Beta suno (bus passing) ye important hai').trim()).toBe('Beta suno ye important hai');
  });
  it('never eats real speech containing these words outside tags', () => {
    expect(cleanTranscript('Train ka example samjho').trim()).toBe('Train ka example samjho');
  });
});

describe('body sounds never become a turn', () => {
  it('drops sniff, cough, sneeze and throat-clearing tags', () => {
    expect(isNoiseOnly('[sniff]')).toBe(true);
    expect(isNoiseOnly('[sniff')).toBe(true);
    expect(isNoiseOnly('(sneezes)')).toBe(true);
    expect(isNoiseOnly('[clears throat]')).toBe(true);
    expect(isNoiseOnly('(coughing)')).toBe(true);
    expect(isNoiseOnly('(छींक)')).toBe(true);
    expect(isNoiseOnly('[door slams]')).toBe(true);
  });
  it('keeps the question around a sniff tag', () => {
    expect(cleanTranscript('[sniff] . Movement of our limb, jaw, tongue').trim()).toBe('. Movement of our limb, jaw, tongue');
    expect(cleanTranscript('] . Movement of our limb').trim()).toBe('Movement of our limb');
  });
  it('keeps real speech in round brackets about ring or sound', () => {
    expect(cleanTranscript('Benzene (ring structure) samjhao').trim()).toBe('Benzene (ring structure) samjhao');
  });
});
