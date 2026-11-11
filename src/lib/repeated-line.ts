const norm = (v: string) => v.replace(/[\s।.,!?'"“”‘’\-–—:;()]+/g, '').toLowerCase();
const sentences = (v: string) => (v.replace(/\s+/g, ' ').match(/[^।.!?]+[।.!?]*/g) ?? []).map(s => s.trim()).filter(Boolean);

/** True when a Hindi voice line is the same as the one just before it (ignoring spaces and punctuation). */
export function isRepeatedLine(text: string, previous: string | undefined) {
  const a = norm(text);
  return a.length > 0 && previous !== undefined && a === norm(previous);
}

/** Text to speak with back-to-back duplicate sentences removed, including a first sentence that repeats the previous part's last one. */
export function speakableText(text: string, previous?: string) {
  let last = previous ? norm(sentences(previous).at(-1) ?? '') : '';
  const kept: string[] = [];
  for (const s of sentences(text)) {
    const n = norm(s);
    if (!n || n === last) continue;
    kept.push(s); last = n;
  }
  return kept.join(' ');
}

/** A full stop that ends a sentence (not the dot inside "2.5"). */
const ENDING = /[।॥!?…]|\.(?!\d)/g;

/** Short unfinished words after a part's last full stop ("…बोझ। अगर"), which belong to the next part's sentence. */
export function danglingTail(text: string | undefined, maxWords = 6) {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  let end = -1;
  for (const m of s.matchAll(ENDING)) end = (m.index ?? -1) + m[0].length;
  if (end <= 0) return '';
  const tail = s.slice(end).replace(/^["'”’)\]\s]+/, '').trim();
  if (!tail || !/[\p{L}\p{N}]/u.test(tail) || tail.split(' ').length > maxWords) return '';
  return tail;
}

/**
 * Dub parts are cut by time, so a part often ends with the first word of the next sentence. Spoken alone,
 * Gemini TTS repeats or invents words after it, so that unfinished tail is spoken at the start of the next part.
 */
export function dubSpeechText(text: string, previous?: string, hasNext = false) {
  const own = (text ?? '').replace(/\s+/g, ' ').trim();
  const tail = hasNext ? danglingTail(own) : '';
  const body = tail ? own.slice(0, own.length - tail.length).trim() : own;
  const carried = danglingTail(previous);
  const before = carried && previous ? previous.replace(/\s+/g, ' ').trim().slice(0, -carried.length).trim() : previous;
  return speakableText(carried ? `${carried} ${body}` : body, before);
}
