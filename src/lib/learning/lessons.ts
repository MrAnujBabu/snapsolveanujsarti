// Browser-safe lesson helpers: retrieval, holdout arm, clustering fingerprint and verdict.

export type LessonRow = { id: string; problem: string; guidance: string; subject: string };
export type LessonStats = { shown_ok: number; shown_stuck: number; held_ok: number; held_stuck: number };

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9\u0900-\u097f]{3,}/g) ?? []);
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'when', 'from', 'student', 'students', 'tutor', 'answer', 'question', 'explain', 'always', 'never', 'should', 'kya', 'hai', 'nahi', 'aur']);

/** Up to `limit` active lessons whose words clearly match the recent conversation. */
export function pickLessons<T extends LessonRow>(rows: ReadonlyArray<T>, query: string, limit = 3): T[] {
  const q = words(query);
  if (!q.size) return [];
  return rows
    .map((r) => {
      let score = 0;
      for (const w of words(`${r.problem} ${r.guidance}`)) if (!STOP.has(w) && q.has(w)) score++;
      if (r.subject && q.has(r.subject.toLowerCase())) score++;
      return { r, score };
    })
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.r);
}

export function formatLessons(rows: ReadonlyArray<LessonRow>, cap = 1500): string {
  let out = '';
  for (const r of rows) {
    const line = `- ${r.problem ? `When ${r.problem.replace(/\.$/, '')}: ` : ''}${r.guidance.trim()}\n`;
    if (out.length + line.length > cap) break;
    out += line;
  }
  return out.trim();
}

/** Share of conversations that get no lessons, so we can see whether lessons really help. */
export const HOLDOUT_SHARE = 0.2;

/** Stable per conversation: the same chat always lands in the same arm. */
export function isHoldout(seed: string, share = HOLDOUT_SHARE): boolean {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000) / 1000 < share;
}

/** Order-free keyword fingerprint so near-identical lessons cluster into one row. */
export function lessonFingerprint(problem: string, guidance: string): string {
  const keys = [...words(`${problem} ${guidance}`)].filter((w) => !STOP.has(w)).sort();
  return keys.slice(0, 24).join(' ');
}

/** Existing lesson that says nearly the same thing, if any. */
export function similarLesson<T extends { fingerprint: string }>(rows: ReadonlyArray<T>, fingerprint: string): T | undefined {
  const a = new Set(fingerprint.split(' ').filter(Boolean));
  if (!a.size) return undefined;
  return rows.find((r) => {
    const b = new Set(r.fingerprint.split(' ').filter(Boolean));
    if (!b.size) return false;
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    return shared / Math.min(a.size, b.size) >= 0.6;
  });
}

export type Verdict = 'few' | 'helping' | 'no-effect' | 'hurting';

/** Compare "student got stuck again" rates with and without the lesson. */
export function lessonVerdict(s: LessonStats, minShown = 10, minHeld = 4): Verdict {
  const shown = s.shown_ok + s.shown_stuck;
  const held = s.held_ok + s.held_stuck;
  if (shown < minShown || held < minHeld) return 'few';
  const withRate = s.shown_stuck / shown;
  const withoutRate = s.held_stuck / held;
  if (withRate <= withoutRate - 0.1) return 'helping';
  if (withRate >= withoutRate + 0.1) return 'hurting';
  return 'no-effect';
}

/** Lessons that have not matched any conversation in this many days are likely stale. */
export const STALE_DAYS = 45;
export function isStale(lastMatchedAt: string | null, createdAt: string, now = Date.now()): boolean {
  const since = Date.parse(lastMatchedAt ?? createdAt);
  return Number.isFinite(since) && now - since > STALE_DAYS * 86_400_000;
}

export type LessonDraft = { problem: string; guidance: string; subject: string };

/** Parse the reviewer model's JSON; `null` when it found nothing reusable. */
export function parseLessonDraft(raw: string): LessonDraft | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { none?: boolean; problem?: unknown; guidance?: unknown; subject?: unknown };
    if (j.none) return null;
    const guidance = typeof j.guidance === 'string' ? j.guidance.trim() : '';
    if (guidance.length < 15) return null;
    const problem = typeof j.problem === 'string' ? j.problem.trim() : '';
    const subject = typeof j.subject === 'string' && /^(physics|chemistry|biology|general)$/i.test(j.subject) ? j.subject.toLowerCase() : 'general';
    return { problem: problem.slice(0, 300), guidance: guidance.slice(0, 500), subject };
  } catch { return null; }
}

export const FEEDBACK_CATEGORIES = ['tool_failed', 'missing_capability', 'confusing_instructions', 'conflicting_rules', 'bad_source', 'other'] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export function feedbackFingerprint(category: string, tool: string, message: string): string {
  const head = [...words(message)].slice(0, 10).join(' ');
  return `${category}|${tool.toLowerCase()}|${head}`;
}
