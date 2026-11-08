// Shared clean-up for spoken transcripts: removes noise tags, whisper markers and
// the phantom phrases speech models invent from silence or background hiss.

/** Mic settings for clear speech: echo/noise removal, auto volume, mono, voice isolation where supported. */
export const CLEAN_MIC: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
  // Chrome/Android support this; other browsers ignore unknown constraints.
  ...({ voiceIsolation: true } as Record<string, boolean>),
};

// Traffic, vehicle, machinery, crowd, weather and animal sounds the speech model
// tags instead of speech — these must never reach the tutor or the transcript.
const TAG = /[[(（【<*♪]\s*(?:whisper\w*|inaudible|noise|background\s*noise|static|silence|music|breath\w*|cough\w*|laugh\w*|sigh\w*|unclear|blank_audio|no\s*speech|applause|foreign|hiss\w*|engine|horn\w*|honk\w*|traffic|vehicle|car|bus|train|bike|motorcycle|scooter|machine\w*|factory|crowd|chatter|wind|rain|thunder|dog|bark\w*|siren|construction|fan|sniff\w*|snif|sneez\w*|clears?\s*(?:his|her|their)?\s*throat|throat\w*|gasp\w*|yawn\w*|hiccup\w*|groan\w*|grunt\w*|snor\w*|swallow\w*|gulp\w*|exhal\w*|inhal\w*|lip\s*smack\w*|smack\w*|knock\w*|beep\w*|keyboard|typing|rustl\w*|footstep\w*|clap\w*|chew\w*|छींक\w*|खांस\w*|खाँस\w*|फुसफुस\w*|शोर|ट्रैफिक|हॉर्न|गाड़ी|इंजन|भीड़|हवा)[^\])）】>*♪]*[\])）】>*♪]?/giu;

// Speech models write any other non-speech event as a short [bracketed] tag
// ("[sneezes]", "[door slams]"); a lone unclosed one ("[sniff") can end a fragment.
const BRACKET_EVENT = /\[\s*[\p{L}\s'_-]{2,40}\s*\]|【\s*[\p{L}\s'_-]{2,40}\s*】/gu;
const OPEN_EVENT_TAIL = /\[\s*[\p{L}_-]{2,20}\s*$/u;
// The closing half of a tag split across fragments ("] . Movement…").
const STRAY_CLOSE = /^\s*[\])）】]+[\s.,]*/u;

const PHANTOMS = [
  /thank(?:s| you)(?: so much)? for watching[.!]*/giu,
  /please (?:like and )?subscribe[^.!]*[.!]*/giu,
  /subtitles? (?:by|from)[^.!]*[.!]*/giu,
  /(?:amara\.org|www\.\S+)[^.!]*[.!]*/giu,
  /♪+/gu,
];

/** Clean a transcript fragment; returns "" when it was only noise. */
export function cleanTranscript(text: string): string {
  let out = text.replace(TAG, ' ').replace(BRACKET_EVENT, ' ').replace(OPEN_EVENT_TAIL, ' ').replace(STRAY_CLOSE, '');
  for (const re of PHANTOMS) out = out.replace(re, ' ');
  out = out.replace(/\s{2,}/g, ' ');
  return /[\p{L}\p{N}]/u.test(out) ? out : '';
}

/** True when a fragment carries no real speech (noise/whisper tag or phantom phrase only). */
export function isNoiseOnly(text: string): boolean {
  return text.trim() !== '' && cleanTranscript(text).trim() === '';
}
