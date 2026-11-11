import { describe, expect, it } from 'vitest';
import { mergeSpeakerGender, speakerGenderRule, toSpeakerGender } from '@/lib/speaker-gender';
import { parseListenOutput } from '@/lib/transcript-cues';
import { normalizeBrief, timedBatchPrompt, withHeardSpeaker } from '@/lib/interpreter.server';

const brief = (gender?: string) => ({ language: 'en', domain: 'study', summary: 'पढ़ाई', glossary: [], corrections: [], ...(gender ? { speaker_gender: gender, speaker_evidence: 'test' } : {}) });
const seg = [{ start: 0, end: 30, text: 'I was tired, so I went home.' }];

describe('speaker gender interpretation', () => {
  it('tells the interpreter to use masculine first-person Hindi for a male speaker', () => {
    const prompt = timedBatchPrompt(seg, { title: 'T', brief: normalizeBrief(brief('male')) });
    expect(prompt).toContain('Speaker gender: MALE');
    expect(prompt).toContain('मैं करता हूँ');
    expect(prompt).not.toContain('Speaker gender: FEMALE');
  });

  it('tells the interpreter to use feminine first-person Hindi for a female speaker', () => {
    const prompt = timedBatchPrompt(seg, { title: 'T', brief: normalizeBrief(brief('female')) });
    expect(prompt).toContain('Speaker gender: FEMALE');
    expect(prompt).toContain('मैं करती हूँ');
  });

  it('uses gender-neutral phrasing when the gender is not established', () => {
    expect(timedBatchPrompt(seg, { title: 'T', brief: null })).toContain('Speaker gender: NOT ESTABLISHED');
    expect(normalizeBrief(brief('robot'))?.speaker?.gender).toBe('unknown');
  });

  it('keeps a saved brief speaker when a stopped run resumes', () => {
    expect(normalizeBrief({ ...brief(), speaker: { gender: 'female', evidence: 'said I am Priya' } })?.speaker?.gender).toBe('female');
  });

  it('reads the voice the listener heard, and drops the header from the transcript', () => {
    const heard = parseListenOutput('LANG=en\nSPEAKER=female\n[0:00] I went home.\n[0:05] I was tired.');
    expect(heard.speaker).toBe('female');
    expect(heard.cues.map(c => c.text).join(' ')).not.toContain('SPEAKER');
    expect(parseListenOutput('LANG=en\n[0:00] Hi.').speaker).toBeUndefined();
  });

  it('uses the heard voice only when the text brief could not decide', () => {
    expect(withHeardSpeaker(normalizeBrief(brief('unknown')), 'male')?.speaker?.gender).toBe('male');
    expect(withHeardSpeaker(normalizeBrief(brief('female')), 'male')?.speaker?.gender).toBe('female');
    expect(withHeardSpeaker(null, 'female', 'en')?.speaker?.gender).toBe('female');
  });

  it('combines listened pieces: different voices become mixed, unknown never overrides', () => {
    expect(mergeSpeakerGender('unknown', 'male')).toBe('male');
    expect(mergeSpeakerGender('male', 'unknown')).toBe('male');
    expect(mergeSpeakerGender('male', 'female')).toBe('mixed');
    expect(toSpeakerGender('Woman')).toBe('female');
    expect(speakerGenderRule('mixed')).toContain('SEVERAL SPEAKERS');
  });
});