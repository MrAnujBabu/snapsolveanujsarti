// Browser-safe "is the student stuck?" signals, following the Lovable continuous-learning talk:
// a repeated request or a complaint means the last answer did not land; a short thanks after
// that means the student got unstuck, which is the moment worth learning from.

export type ChatLike = { role: string; parts?: ReadonlyArray<{ type: string; text?: string }> };

export const messageText = (m: ChatLike | undefined): string =>
  (m?.parts ?? []).map((p) => (p.type === 'text' ? p.text ?? '' : '')).join(' ')
    // Photo transcriptions and pasted documents are not the student's own words.
    .replace(/<photo-reading>[\s\S]*?<\/photo-reading>/g, ' ')
    .replace(/<doc\b[\s\S]*?<\/doc>/g, ' ')
    .trim();

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9\u0900-\u097f]{3,}/g) ?? []);

export function overlap(a: string, b: string): number {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.min(x.size, y.size);
}

const COMPLAINT = /(galat|glat|wrong|incorrect|not correct|sahi nahi|sahi nhi|samajh? ?nahi|samjh? ?nahi|samajh? ?nhi|samjh? ?nhi|nahi samjh|nhi samjh|samajh me nahi|not clear|unclear|confus|phir se|fir se|dobara|explain again|once more|still (?:not|wrong|confus)|ab bhi|abhi bhi|kaam nahi|doesn'?t make sense|makes no sense|nahi aaya|nhi aaya|ulta|गलत|ग़लत|समझ नहीं|समझ में नहीं|नहीं समझ|फिर से|दोबारा|सही नहीं)/i;
const RESOLVED = /(samajh? ?gay|samjh? ?gay|samajh? ?aa? gay|samjh? ?aa? gay|ab clear|clear ho gaya|clear hai ab|got it|understood|makes sense now|thank|thanx|thnx|thnks|dhanyavad|shukriya|perfect|ab sahi|haan sahi|ab samjh|समझ गया|समझ गई|समझ गयी|समझ आ गया|धन्यवाद|शुक्रिया)/i;

/** Short complaint about the previous answer (long pastes are new material, not complaints). */
export const isComplaint = (text: string) => text.length > 0 && text.length <= 400 && COMPLAINT.test(text);

/** Short "got it / thanks" that is not itself a complaint. */
export const isResolved = (text: string) => text.length > 0 && text.length <= 200 && RESOLVED.test(text) && !isComplaint(text);

function userTexts(messages: ReadonlyArray<ChatLike>): string[] {
  return messages.filter((m) => m.role === 'user').map(messageText);
}

/** True when the latest student message repeats an earlier ask or complains about the last answer. */
export function isStuckTurn(messages: ReadonlyArray<ChatLike>): boolean {
  const asks = userTexts(messages);
  if (asks.length < 2) return false;
  const last = asks[asks.length - 1] ?? '';
  if (isResolved(last)) return false;
  if (isComplaint(last)) return true;
  if (words(last).size < 4) return false;
  return asks.slice(-4, -1).some((earlier) => overlap(last, earlier) >= 0.7);
}

export type Recovery = { excerpt: string };

/**
 * The student just said "got it" after being stuck within the last few turns.
 * Returns the stuck stretch (question → failed answer → complaint → fixing answer) for review.
 */
export function findRecovery(messages: ReadonlyArray<ChatLike>, maxChars = 3500): Recovery | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user' || !isResolved(messageText(last))) return null;
  // Look back up to 3 earlier student turns for the moment they got stuck.
  let stuckAt = -1;
  let seen = 0;
  for (let i = messages.length - 2; i >= 0 && seen < 3; i--) {
    if (messages[i]?.role !== 'user') continue;
    seen++;
    if (isStuckTurn(messages.slice(0, i + 1))) stuckAt = i;
  }
  if (stuckAt < 0) return null;
  // Include the original question before the stuck point.
  let start = stuckAt;
  for (let i = stuckAt - 1; i >= 0; i--) if (messages[i]?.role === 'user') { start = i; break; }
  const lines = messages.slice(start, -1).map((m) => {
    const t = messageText(m);
    const room = m.role === 'user' ? 600 : 900;
    return `${m.role === 'user' ? 'STUDENT' : 'TUTOR'}: ${t.length > room ? `${t.slice(0, room)}…` : t}`;
  });
  return { excerpt: lines.join('\n\n').slice(0, maxChars) };
}
