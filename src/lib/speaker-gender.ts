// Browser-safe speaker gender used by the interpreter brief, listener and UI.
export type SpeakerGender = 'male' | 'female' | 'mixed' | 'unknown';
export const SPEAKER_GENDERS: readonly SpeakerGender[] = ['male', 'female', 'mixed', 'unknown'];

export const isSpeakerGender = (value: unknown): value is SpeakerGender => typeof value === 'string' && (SPEAKER_GENDERS as readonly string[]).includes(value);

/** Normalizes model text such as "Male", "woman" or "M" to a gender; anything unclear stays unknown. */
export function toSpeakerGender(value: unknown): SpeakerGender {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (isSpeakerGender(v)) return v;
  if (/^(m|man|men|boy|masculine)$/.test(v)) return 'male';
  if (/^(f|woman|women|girl|feminine)$/.test(v)) return 'female';
  if (/^(both|several|multiple|many)$/.test(v)) return 'mixed';
  return 'unknown';
}

/** Combines evidence from several listened pieces: unknown never overrides, different voices become mixed. */
export function mergeSpeakerGender(a: SpeakerGender | undefined, b: SpeakerGender | undefined): SpeakerGender {
  const x = a ?? 'unknown', y = b ?? 'unknown';
  if (x === 'unknown') return y;
  if (y === 'unknown' || x === y) return x;
  return 'mixed';
}

/** Interpreter instruction for the speaker's own first-person Hindi grammar. */
export function speakerGenderRule(gender: SpeakerGender): string {
  if (gender === 'male') return 'Speaker gender: MALE. Every first-person reference by the speaker uses masculine Hindi grammar throughout (मैं करता हूँ, मैं पढ़ता था, मैं गया, मैं थक गया हूँ, मुझे यकीन था कि मैं कर सकता हूँ). Never switch to feminine forms in any part.';
  if (gender === 'female') return 'Speaker gender: FEMALE. Every first-person reference by the speaker uses feminine Hindi grammar throughout (मैं करती हूँ, मैं पढ़ती थी, मैं गई, मैं थक गई हूँ, मुझे यकीन था कि मैं कर सकती हूँ). Never switch to masculine forms in any part.';
  if (gender === 'mixed') return 'Speaker gender: SEVERAL SPEAKERS of different genders. Keep each speaker\'s own first-person gender from the source context; when a line\'s speaker is unclear, use gender-neutral phrasing.';
  return 'Speaker gender: NOT ESTABLISHED. Prefer gender-neutral first-person phrasing (मुझे लगता है, मेरा तरीका है, मैंने इस्तेमाल किया) and never alternate masculine and feminine forms.';
}

export const speakerGenderLabel = (gender: SpeakerGender) =>
  gender === 'male' ? 'पुरुष' : gender === 'female' ? 'महिला' : gender === 'mixed' ? 'एक से ज़्यादा' : 'पता नहीं';
