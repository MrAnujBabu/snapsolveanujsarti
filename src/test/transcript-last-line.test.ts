import { expect, it } from 'vitest';
import { parsePastedTranscript } from '@/lib/transcript-cues';
import { wordBudget } from '@/lib/interpreter-models';

it('gives an untimed last pasted line enough time for its words, not a fixed 5 seconds', () => {
  const last = 'In the first column I write a question, in the second column the answer, and then I hide the answer column. It is way more efficient, and it massively improves retention.';
  const cues = parsePastedTranscript(`0:00 Hey friends, I am Ali.\n0:30 ${last}`);
  const end = cues.at(-1)!;
  expect(end.end - end.start).toBeGreaterThanOrEqual(13);
  expect(wordBudget(end.end - end.start)).toBeGreaterThanOrEqual(30);
});

it('keeps a short last line at the usual 5 seconds', () => {
  const cues = parsePastedTranscript('0:00 Hello.\n0:10 Thanks.');
  expect(cues.at(-1)!.end).toBe(15);
});
