// Browser-safe: common-sense readability for simple-Hindi interpretations.
// Shared by the interpreter, the reviewer and the transcript display/download so every step follows one rule.

/** Interpretation rule (also given to the reviewer) so a student with no English understands on first hearing. */
/** Approximate rupee value of one unit of each foreign currency, for the "यानी करीब ₹…" hint. Update when rates move a lot. */
export const RUPEE_RATES = [
  { currency: 'US dollar (डॉलर)', rupees: 85 },
  { currency: 'British pound (पाउंड)', rupees: 110 },
  { currency: 'euro (यूरो)', rupees: 95 },
  { currency: 'Hong Kong dollar (हॉन्ग कॉन्ग डॉलर)', rupees: 11 },
  { currency: 'Canadian/Australian dollar', rupees: 60 },
  { currency: 'UAE dirham (दिरहम)', rupees: 23 },
] as const;

/** The money hint rule: one approximate rupee value after a foreign amount, never replacing it. */
export const RUPEE_HINT_RULE = `Foreign money: keep every amount and currency exactly as said, then at its first mention add once, in the same sentence, an easy approximate rupee value joined with "यानी करीब" — "1 लाख डॉलर, यानी करीब 85 लाख रुपये"; "5 पाउंड का कबाब, यानी करीब 550 रुपये". Use only these approximate rates: ${RUPEE_RATES.map(r => `1 ${r.currency} ≈ ${r.rupees} रुपये`).join('; ')}. Work the multiplication out carefully, round to an easy Indian figure (सौ, हज़ार, लाख, करोड़) and write the number with 0-9 digits. For any other currency, or when unsure, skip the hint. Do not repeat a hint for an amount already converted. When one sentence has several amounts, add the hint only to the main or largest one so the sentence stays easy to hear.`;

/** Interpretation rule (also given to the reviewer) so a student with no English understands on first hearing. */
export const COMMON_SENSE_RULE = `Common-sense clarity — the listener may be a small-town student who knows no English:
a. Every sentence is a complete spoken sentence where it is clear who is doing what: keep the subject and the verb (मैंने सोचा, मैं डॉक्टरों से पूछता था). Never write note-style fragments such as "पहला सबक: लॉटरी।" or "उम्र 18, लगा…" — write "पहला सबक मुझे लॉटरी वाले एक सवाल से मिला।" When the word budget is tight, cut extra words, never the subject or the verb.
b. A foreign name or phrase an ordinary Indian student would not know (a company, university, city or area, food, product, job title or English expression such as "six figure") gets a few simple words of meaning at its first mention only, joined with "यानी" — मैककिंज़ी, यानी बड़ी सलाह देने वाली कंपनी; यम चा, यानी हांगकांग का चाय-नाश्ता. Do this only when you are sure what it is; well-known names (गूगल, यूट्यूब, आईफ़ोन) need nothing; never use brackets and never repeat the explanation later.
c. Write every number with the digits 0-9 (3,000 · 18 · 1 लाख), never Devanagari digits (३,०००).
d. ${RUPEE_HINT_RULE}`;

/** How an expert human interpreter works, so the Hindi feels thought through instead of shortened captions. */
export const INTERPRETER_CRAFT_RULE = `Interpret like an expert human interpreter, not a caption shortener:
a. First understand the whole thought — this block together with the neighbour context and the summary — then say it the way this speaker would naturally explain it if he or she spoke Hindi.
b. Make the reasoning easy to follow: join ideas with natural connectors (क्योंकि, इसलिए, लेकिन, यानी, तो, जैसे), make clear whom "they/it/this" refers to, and keep cause → result order. Two clear connected sentences are better than five chopped fragments.
c. Turn English sentence shapes, rhetorical questions, lists and idioms into the natural Hindi way of saying the same thing; keep the speaker's jokes and examples, told the way an Indian speaker would tell them.
d. Read each sentence back as a listener hearing it once: if it would make them stop and think "क्या मतलब?", rewrite it more simply.
e. Clarity beats brevity: treat the word budget as a guide — going up to about 15% over is fine when a sentence needs it to be clear; cut repetition and filler first, never facts.`;

const DEVANAGARI_DIGIT = /[०-९]/g;

/** ३,००० → 3,000: one digit style everywhere (free, no AI call). */
export function asciiDigits(text: string): string {
  return text.replace(DEVANAGARI_DIGIT, d => String(d.charCodeAt(0) - 0x0966));
}

const SENTENCE_END = /[।॥.!?…"'”’)\]]\s*$/;

/** Joins paragraphs that were split in the middle of a sentence (timed parts), so reading never stops mid-thought. */
export function readableParagraphs(text: string): string {
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const out: string[] = [];
  for (const p of paragraphs) {
    const last = out[out.length - 1];
    if (last !== undefined && !SENTENCE_END.test(last)) out[out.length - 1] = `${last} ${p}`;
    else out.push(p);
  }
  return out.join('\n\n');
}

/** What the reader sees and downloads: one digit style and whole sentences per paragraph. */
export function readableHindi(text: string): string {
  return readableParagraphs(asciiDigits(text));
}
