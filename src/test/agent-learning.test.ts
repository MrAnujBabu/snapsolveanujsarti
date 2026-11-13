import { describe, expect, it } from 'vitest';
import { findRecovery, isComplaint, isResolved, isStuckTurn } from '@/lib/learning/signals';
import { feedbackFingerprint, isHoldout, isStale, lessonFingerprint, lessonVerdict, parseLessonDraft, pickLessons, similarLesson } from '@/lib/learning/lessons';

const u = (text: string) => ({ role: 'user', parts: [{ type: 'text', text }] });
const a = (text: string) => ({ role: 'assistant', parts: [{ type: 'text', text }] });

describe('stuck signals', () => {
  it('a short complaint after an answer counts as stuck', () => {
    expect(isStuckTurn([u('Projectile range formula?'), a('R = u²sin2θ/g'), u('samajh nahi aaya, phir se batao')])).toBe(true);
  });
  it('repeating the same question counts as stuck', () => {
    const q = 'why is the range maximum at 45 degree angle for projectile';
    expect(isStuckTurn([u(q), a('...'), u(q + ' please')])).toBe(true);
  });
  it('a new unrelated question is not stuck', () => {
    expect(isStuckTurn([u('Projectile range formula?'), a('...'), u('Ab Krebs cycle ke steps batao')])).toBe(false);
  });
  it('a long pasted question containing "wrong" is not a complaint', () => {
    expect(isComplaint('Which statement is wrong? '.padEnd(500, 'x'))).toBe(false);
  });
  it('"samajh gaya thanks" is resolved, "galat hai" is not', () => {
    expect(isResolved('samajh gaya, thanks!')).toBe(true);
    expect(isResolved('thanks par yeh galat hai')).toBe(false);
  });
  it('stuck → unstuck produces a recovery excerpt; a plain thanks does not', () => {
    const rec = findRecovery([u('Range kab maximum hota hai?'), a('At 90°'), u('galat hai, phir se'), a('At 45° because sin2θ = 1'), u('ab samajh gaya thanks')]);
    expect(rec?.excerpt).toContain('STUDENT: Range kab maximum hota hai?');
    expect(rec?.excerpt).toContain('At 45°');
    expect(findRecovery([u('Range kab maximum hota hai?'), a('At 45°'), u('thanks')])).toBeNull();
  });
});

describe('lessons', () => {
  const rows = [
    { id: '1', problem: 'student asks projectile range questions', guidance: 'Split motion into horizontal and vertical components before using the range formula', subject: 'physics' },
    { id: '2', problem: 'student asks about Krebs cycle', guidance: 'List the cycle steps with the NADH count at each step', subject: 'biology' },
  ];
  it('picks only lessons that match the conversation', () => {
    expect(pickLessons(rows, 'projectile range kaise nikale horizontal').map(r => r.id)).toEqual(['1']);
    expect(pickLessons(rows, 'hello')).toEqual([]);
  });
  it('holdout is stable per chat and close to 20%', () => {
    expect(isHoldout('same chat')).toBe(isHoldout('same chat'));
    const n = Array.from({ length: 2000 }, (_, i) => isHoldout(`chat ${i}`)).filter(Boolean).length;
    expect(n / 2000).toBeGreaterThan(0.15);
    expect(n / 2000).toBeLessThan(0.25);
  });
  it('near-duplicate lessons cluster to the same row', () => {
    const fp = lessonFingerprint('projectile range', 'Split motion into horizontal and vertical components first');
    const existing = [{ fingerprint: lessonFingerprint('projectile range questions', 'Split the motion into horizontal and vertical components first') }];
    expect(similarLesson(existing, fp)).toBe(existing[0]);
    expect(similarLesson([{ fingerprint: lessonFingerprint('krebs', 'count NADH per step') }], fp)).toBeUndefined();
  });
  it('verdict needs enough data and compares with the holdout', () => {
    expect(lessonVerdict({ shown_ok: 3, shown_stuck: 0, held_ok: 1, held_stuck: 1 })).toBe('few');
    expect(lessonVerdict({ shown_ok: 18, shown_stuck: 2, held_ok: 3, held_stuck: 2 })).toBe('helping');
    expect(lessonVerdict({ shown_ok: 10, shown_stuck: 10, held_ok: 4, held_stuck: 1 })).toBe('hurting');
  });
  it('a lesson unused for 45+ days is stale', () => {
    const now = Date.parse('2026-11-13T00:00:00Z');
    expect(isStale('2026-09-01T00:00:00Z', '2026-01-01T00:00:00Z', now)).toBe(true);
    expect(isStale('2026-11-01T00:00:00Z', '2026-01-01T00:00:00Z', now)).toBe(false);
  });
  it('reviewer "none" or too-short guidance is not saved', () => {
    expect(parseLessonDraft('{"none": true}')).toBeNull();
    expect(parseLessonDraft('{"problem":"x","guidance":"short"}')).toBeNull();
    expect(parseLessonDraft('```json\n{"problem":"range at angle","guidance":"State that range peaks at 45° since sin2θ is 1 there","subject":"Physics"}\n```')?.subject).toBe('physics');
  });
  it('repeat tutor complaints share one fingerprint', () => {
    expect(feedbackFingerprint('tool_failed', 'ncert_read', 'NCERT PDF could not be read twice'))
      .toBe(feedbackFingerprint('tool_failed', 'NCERT_READ', 'NCERT PDF could not be read twice'));
  });
});
