import { describe, expect, it } from 'vitest';
import { latinWords, englishLettersNote, EVERYDAY_ENGLISH_RULE } from '@/lib/hindi-english-words';
import { acceptEnglishFix, finishEnglishWords, interpretTimed, reviewPrompt } from '@/lib/interpreter.server';

describe('English words left in English letters', () => {
  it('finds words a Hindi listener should hear the everyday way', () => {
    expect(latinWords('मैं Google Sheets में flashcards बनाता हूँ, फिर Google खोलता हूँ।')).toEqual(['Google', 'Sheets', 'flashcards']);
  });

  it('allows formulas, units after numbers, single letters, code and links', () => {
    expect(latinWords('पानी H2O है, रोज़ 5 mg लें, option A देखें, `npm run` चलाएँ, https://ncert.nic.in खोलें, a@b.in पर लिखें।')).toEqual(['option']);
  });

  it('is clean for fully Devanagari Hindi', () => {
    expect(latinWords('मैं गूगल शीट्स में फ़्लैशकार्ड बनाता हूँ।')).toEqual([]);
    expect(englishLettersNote('मैं गूगल शीट्स में फ़्लैशकार्ड बनाता हूँ।')).toBe('');
  });

  it('the rule asks for Devanagari as Indians say it and plain Hindi for uncommon words', () => {
    expect(EVERYDAY_ENGLISH_RULE).toContain('revision → रिवीज़न');
    expect(EVERYDAY_ENGLISH_RULE).toContain('retention → याद रहना');
    expect(EVERYDAY_ENGLISH_RULE).toContain('पुनरावृत्ति');
  });
});

describe('reviewer and final English-letters check', () => {
  it('tells the reviewer exactly which words are still in English letters', () => {
    const prompt = reviewPrompt([{ source: 'I use Google Sheets.', hindi: 'मैं Google Sheets इस्तेमाल करता हूँ।' }], { title: 'T', brief: null });
    expect(prompt).toContain('ENGLISH LETTERS TO REWRITE: Google, Sheets');
  });

  it('accepts a copy-edit that only converts the English words', () => {
    expect(acceptEnglishFix('मैं Google Sheets इस्तेमाल करता हूँ।', 'मैं गूगल शीट्स इस्तेमाल करता हूँ।')).toBe('मैं गूगल शीट्स इस्तेमाल करता हूँ।');
  });

  it('rejects a copy-edit that drops content, adds notes or keeps the English', () => {
    const line = 'मैं हर दिन Google Sheets में अपने सारे सवाल और जवाब लिखता हूँ, फिर उन्हें छिपाकर याद करता हूँ।';
    expect(acceptEnglishFix(line, 'मैं गूगल शीट्स लिखता हूँ।')).toBe(line);
    expect(acceptEnglishFix(line, 'Converted Google Sheets to Hindi.')).toBe(line);
    expect(acceptEnglishFix(line, line)).toBe(line);
    expect(acceptEnglishFix(line, 'मेरा तरीका यह है कि मैं रोज़ गूगल शीट्स में सवाल-जवाब लिखूँ और बाद में उन्हें छिपाकर देखूँ।')).toBe(line);
  });

  it('costs nothing when every block is already in everyday Devanagari', async () => {
    let calls = 0;
    const out = await finishEnglishWords({ lines: ['मैं गूगल शीट्स इस्तेमाल करता हूँ।'], engine: 'claude', context: { title: 'T', brief: null },
      signal: new AbortController().signal, call: async () => { calls++; return ''; } });
    expect(calls).toBe(0);
    expect(out.fixed).toBe(0);
  });

  it('fixes only the blocks with English letters and keeps their timestamp order', async () => {
    const published: [number, string][] = [];
    const prompts: string[] = [];
    await interpretTimed({
      segments: [{ start: 0, end: 10, text: 'I am a doctor.' }, { start: 10, end: 20, text: 'I use Google Sheets.' }],
      context: { title: 'T', brief: null }, engine: 'claude', signal: new AbortController().signal, review: false,
      onSegment: (i, hindi) => published.push([i, hindi]),
      call: async (_engine, system, user) => {
        prompts.push(user);
        if (system.includes('final copy editor')) return '### 1\nमैं गूगल शीट्स इस्तेमाल करता हूँ।';
        return '### 1\nमैं डॉक्टर हूँ।\n### 2\nमैं Google Sheets इस्तेमाल करता हूँ।';
      },
    });
    expect(published).toEqual([[0, 'मैं डॉक्टर हूँ।'], [1, 'मैं गूगल शीट्स इस्तेमाल करता हूँ।']]);
    const fixPrompt = prompts[1] ?? '';
    expect(fixPrompt).toContain('REWRITE: Google, Sheets');
    expect(fixPrompt).not.toContain('मैं डॉक्टर हूँ।');
  });
});
