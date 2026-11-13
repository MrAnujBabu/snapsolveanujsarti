// Server-only expert interpreter panel:
//   Listener      — Gemini 4 Argon hears audio / watches YouTube when no usable captions exist
//   Terminologist — GPT-6 Astra prepares the brief (language, topic, glossary, caption fixes)
//   Interpreter   — the chosen premium model (Claude Opus 5.5 · GPT-6 Astra · Gemini 4 Argon),
//                   with the other two as automatic per-batch backups
import {
  generateChatCompletion, generateMessage, generateResponse, streamChatCompletion,
  GatewayError as SdkGatewayError, PaymentRequiredError, RateLimitError, PermissionDeniedError,
  ConfigurationError, AuthenticationError, CancelledError,
} from '@lovable.dev/ai-gateway';
import { interpreterInfo, interpreterOrder, LISTENER, TERMINOLOGIST, wordBudget, type InterpreterId } from './interpreter-models';
import type { InterpretBrief } from './interpret-protocol';
import { parseNumberedBlocks, type TimedSegment } from './youtube-hindi';
import { parseListenOutput, type ListenResult } from './transcript-cues';
import { SPEAKER_GENDERS, speakerGenderRule, toSpeakerGender, type SpeakerGender } from './speaker-gender';
import { englishLettersNote, EVERYDAY_ENGLISH_RULE, latinWords } from './hindi-english-words';

export class InterpretError extends Error {
  constructor(message: string, public status: number, public terminal = false) { super(message); }
}

/** Maps SDK failures to a status and a student-friendly Hindi message. */
export function describeFailure(error: unknown): { status: number; message: string; terminal: boolean } {
  if (error instanceof InterpretError) return { status: error.status, message: error.message, terminal: error.terminal };
  if (error instanceof PaymentRequiredError) return { status: 402, message: 'AI credits खत्म हो गए हैं — workspace में credits जोड़कर फिर चलाएँ।', terminal: true };
  if (error instanceof ConfigurationError || error instanceof AuthenticationError) return { status: 503, message: 'AI connection इस workspace में setup नहीं है। Lovable AI फिर से जोड़ें।', terminal: true };
  if (error instanceof CancelledError || (error instanceof Error && error.name === 'AbortError')) return { status: 499, message: 'रोक दिया गया।', terminal: true };
  if (error instanceof RateLimitError) return { status: 429, message: 'AI अभी बहुत busy है — एक मिनट बाद फिर कोशिश करें।', terminal: false };
  if (error instanceof PermissionDeniedError) return { status: 403, message: 'यह AI model अभी इस workspace के लिए उपलब्ध नहीं है।', terminal: false };
  if (error instanceof SdkGatewayError) return { status: error.httpStatus && error.httpStatus >= 400 ? error.httpStatus : 503, message: 'AI से जवाब नहीं मिला। थोड़ी देर बाद फिर कोशिश करें।', terminal: false };
  return { status: 503, message: 'Hindi interpretation नहीं बन पाया। फिर कोशिश करें।', terminal: false };
}

type ContentBlock = { type?: string; text?: string };
const blocksText = (blocks: unknown) => Array.isArray(blocks) ? (blocks as ContentBlock[]).filter(b => b?.type === 'text' || b?.type === 'output_text').map(b => b.text ?? '').join('') : '';

export type Effort = 'low' | 'medium' | 'high';
/** Quality first (the student accepts the extra credits): interpretation thinks deeply, review and listening carefully. */
export const INTERPRET_EFFORT: Effort = 'high';
export const REVIEW_EFFORT: Effort = 'medium';
export const LISTEN_EFFORT: Effort = 'medium';
export const BRIEF_EFFORT: Effort = 'medium';

/** One plain-text call to a premium interpreter model. */
const wait = (ms: number, signal: AbortSignal) => new Promise<void>((res, rej) => {
  const t = setTimeout(res, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason); }, { once: true });
});

/** Bounded backoff for rate limits / transient 5xx (the workspace shares one rate budget). */
export const RETRY_DELAYS_MS = [4000, 10000, 20000];

export async function callInterpreter(engine: InterpreterId, system: string, user: string, signal: AbortSignal, effort: Effort = INTERPRET_EFFORT): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try { return await callInterpreterOnce(engine, system, user, signal, effort); }
    catch (error) {
      const f = describeFailure(error);
      const retryable = f.status === 429 || (f.status >= 500 && f.status < 600 && !f.terminal);
      if (!retryable || signal.aborted || attempt >= RETRY_DELAYS_MS.length) throw error;
      const base = RETRY_DELAYS_MS[attempt] ?? 20000;
      await wait(base + Math.random() * base * 0.5, signal);
    }
  }
}

async function callInterpreterOnce(engine: InterpreterId, system: string, user: string, signal: AbortSignal, effort: Effort): Promise<string> {
  if (engine === 'claude') {
    const r = await generateMessage({
      model: 'anthropic/claude-opus-5-5', max_tokens: 32000, system,
      thinking: { type: 'adaptive' }, output_config: { effort },
      messages: [{ role: 'user', content: user }],
    }, { signal });
    return blocksText((r as { content?: unknown }).content);
  }
  if (engine === 'gpt') {
    const r = await generateResponse({
      model: 'openai/gpt-6-astra', reasoning: { effort }, instructions: system,
      input: [{ role: 'user', content: user }],
    }, { signal });
    const output = (r as { output?: { content?: unknown }[] }).output ?? [];
    return output.map(item => blocksText(item.content)).join('');
  }
  const r = await generateChatCompletion({
    model: 'google/gemini-4-argon', reasoning_effort: effort,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  }, { signal });
  const content = (r as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : blocksText(content);
}

// ---------- Brief ----------

const BRIEF_SYSTEM = `You are the lead terminologist preparing a professional interpreter's brief. The interpreter will turn a recorded video into simple spoken Hindi for Indian students.
The transcript can be in any language and may be automatic captions with mis-heard words.
Return JSON only:
- language: ISO 639-1 code of the main spoken language
- domain: subject area, max 8 words, English
- summary: what the video explains, max 45 words, in simple everyday spoken Hindi, fully in Devanagari, with English words written the way Indians say them
- glossary: up to 20 key terms exactly as said in the video — names, brands, apps, subject terms and English words a Hindi listener needs. hindi is the ONE everyday spoken form, in Devanagari, that the whole interpretation must use (e.g. Google Sheets → गूगल शीट्स, Ali Abdaal → अली अब्दाल, active recall → ऐक्टिव रिकॉल, revision → रिवीज़न, retention → याद रहना). It is a short label, NOT a definition or explanatory clause, and a consistency guide, not words to mechanically substitute on every mention. Choose each form by these rules:
${EVERYDAY_ENGLISH_RULE}
- corrections: up to 15 likely mis-heard words or names, each with the correct form (empty when the transcript is clean); listen for sound-alike errors in automatic captions
- speaker_gender: the MAIN speaker's gender for Hindi first-person grammar — "male", "female", "mixed" (several speakers of different genders) or "unknown". Decide from, in order: explicit self-identification or gendered grammar in the source; the listener's heard-voice hint; the speaker's own name when it is clearly gendered and agrees with the channel/author name. Captions often mis-hear names (e.g. "Ellie" for "Ali"): when the channel/author name is a better match for the speaker, trust it. Never guess from the topic, profession or interests. Use "unknown" when the evidence is weak.
- speaker_evidence: max 20 words, English, the evidence used (or why unknown)
Never invent content that is not in the transcript.`;

const BRIEF_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['language', 'domain', 'summary', 'glossary', 'corrections', 'speaker_gender', 'speaker_evidence'],
  properties: {
    language: { type: 'string' }, domain: { type: 'string' }, summary: { type: 'string' },
    glossary: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['term', 'hindi'], properties: { term: { type: 'string' }, hindi: { type: 'string' } } } },
    corrections: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['heard', 'correct'], properties: { heard: { type: 'string' }, correct: { type: 'string' } } } },
    speaker_gender: { type: 'string', enum: [...SPEAKER_GENDERS] }, speaker_evidence: { type: 'string' },
  },
} as const;

const str = (v: unknown, max: number) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** Validates and bounds a model-written brief; returns null when it is unusable. */
export function normalizeBrief(raw: unknown): InterpretBrief | null {
  let value = raw;
  if (typeof raw === 'string') { try { value = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return null; } }
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const glossary = (Array.isArray(v['glossary']) ? v['glossary'] : []).map(g => ({ term: str((g as Record<string, unknown>)?.['term'], 80), hindi: str((g as Record<string, unknown>)?.['hindi'], 120) })).filter(g => g.term && g.hindi).slice(0, 20);
  const corrections = (Array.isArray(v['corrections']) ? v['corrections'] : []).map(c => ({ heard: str((c as Record<string, unknown>)?.['heard'], 80), correct: str((c as Record<string, unknown>)?.['correct'], 80) })).filter(c => c.heard && c.correct && c.heard.toLowerCase() !== c.correct.toLowerCase()).slice(0, 15);
  const saved = v['speaker'] && typeof v['speaker'] === 'object' ? v['speaker'] as Record<string, unknown> : {};
  const gender = toSpeakerGender(v['speaker_gender'] ?? saved['gender']);
  const evidence = str(v['speaker_evidence'] ?? saved['evidence'], 160);
  const brief: InterpretBrief = { language: str(v['language'], 12).toLowerCase(), domain: str(v['domain'], 80), summary: str(v['summary'], 400), glossary, corrections,
    ...(gender !== 'unknown' || evidence ? { speaker: { gender, evidence } } : {}) };
  return brief.summary || brief.glossary.length || brief.speaker ? brief : null;
}

export const BRIEF_INPUT_CHARS = 120000;

export type BriefHints = { channel?: string; heardVoice?: SpeakerGender };

/** Heard voice is the best fallback when the text brief cannot decide (or fails entirely). */
export function withHeardSpeaker(brief: InterpretBrief | null, heard: SpeakerGender | undefined, language = ''): InterpretBrief | null {
  if (!heard || heard === 'unknown' || (brief?.speaker && brief.speaker.gender !== 'unknown')) return brief;
  const speaker = { gender: heard, evidence: 'Voice heard by the listener' };
  return brief ? { ...brief, speaker } : { language, domain: '', summary: '', glossary: [], corrections: [], speaker };
}

export async function makeBrief(title: string, transcript: string, signal: AbortSignal, hints: BriefHints = {}): Promise<{ brief: InterpretBrief | null; model?: string }> {
  // The first ~2 hours are plenty to fix names and terminology for the whole video.
  const sample = transcript.length > BRIEF_INPUT_CHARS ? `${transcript.slice(0, BRIEF_INPUT_CHARS)}\n[transcript continues]` : transcript;
  const hintLines = [title ? `Video title: ${title}` : '', hints.channel ? `Channel/author: ${hints.channel}` : '',
    hints.heardVoice && hints.heardVoice !== 'unknown' ? `Listener heard the main voice as: ${hints.heardVoice}` : ''].filter(Boolean).join('\n');
  const user = `${hintLines ? `${hintLines}\n\n` : ''}Transcript:\n${sample}\n\nReturn the JSON brief.`;
  try {
    const r = await generateResponse({
      model: 'openai/gpt-6-astra', reasoning: { effort: BRIEF_EFFORT }, instructions: BRIEF_SYSTEM,
      input: [{ role: 'user', content: user }],
      text: { format: { type: 'json_schema', name: 'interpreter_brief', strict: true, schema: BRIEF_SCHEMA } },
    }, { signal });
    const text = ((r as { output?: { content?: unknown }[] }).output ?? []).map(item => blocksText(item.content)).join('');
    const brief = normalizeBrief(text);
    if (brief) return { brief, model: TERMINOLOGIST.name };
  } catch (error) {
    const f = describeFailure(error);
    if (f.terminal) throw error;
    console.error('[interpreter] brief by GPT-6 Astra failed, trying Gemini', f.status);
  }
  try {
    const r = await generateChatCompletion({
      model: 'google/gemini-4-argon', reasoning_effort: BRIEF_EFFORT,
      messages: [{ role: 'system', content: BRIEF_SYSTEM }, { role: 'user', content: user }],
      response_format: { type: 'json_schema', json_schema: { name: 'interpreter_brief', strict: true, schema: BRIEF_SCHEMA } },
    }, { signal });
    const brief = normalizeBrief((r as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content);
    if (brief) return { brief, model: LISTENER.name };
  } catch (error) {
    const f = describeFailure(error);
    if (f.terminal) throw error;
    console.error('[interpreter] backup brief failed; continuing without brief', f.status);
  }
  return { brief: null };
}

// ---------- Interpretation ----------

const RULES = `Interpretation rules:
1. Meaning first: convey what the speaker means, not word-by-word. Keep every fact, number, name, example, step and conclusion. Never add facts that were not said.
2. Simplest spoken Hindi: use everyday words and short, naturally connected sentences that a beginner understands on first hearing — the Hindi people speak at home, with friends and in coaching class. Prefer familiar words (यूज़र, प्रोडक्ट, सिस्टम, डेटा) over formal Sanskritised ones (उपयोगकर्ता, उत्पाद). Avoid textbook phrasing and literal English sentence structure. Simplify the wording, never the underlying facts or reasoning. Before writing, think through each sentence's meaning and every English word in it.
3. ${EVERYDAY_ENGLISH_RULE}
The glossary fixes the spoken form of key terms: use exactly its Devanagari spelling. Never mechanically substitute a long definition; previously mentioned terms have already been introduced.
4. Repair the source: transcripts may be automatic captions with mis-heard words. Use context, the title and the caption fixes to recover the intended meaning. Drop filler, false starts, repetition and [music]/[applause] tags.
5. Culture: express idioms and jokes naturally in Hindi without replacing the speaker's actual examples, places or cultural references with invented ones.
6. Voice: sound as if this speaker originally recorded the video in Hindi. Preserve their point of view (I/we/you), questions, uncertainty, emotion and conversational tone. Follow the "Speaker gender" line exactly for the speaker's own first-person verbs, adjectives and participles in every block; it never changes between blocks, even if a caption mis-hears the speaker's name. Other people keep their own gender from the source. Preserve names as supported by the source/title/brief; never invent a corrected identity. Do not turn narration into an extra lesson, address the listener when the source does not, or insert "देखिए", "तो दोस्तों" or explanations not in the source. Use "आप" only where the speaker addresses the listener. The text is read aloud by text-to-speech: use natural punctuation and short pauses, no markdown, bullets, emojis or brackets. Preserve uncertainty and self-corrections in doses/scientific claims; never convert a hesitant example into confident medical advice.
7. Output only the numbered blocks, in order — no introductions, notes or explanations of your work.`;

const TIMED_SYSTEM = `You are a senior professional interpreter and a gifted Indian teacher. You interpret recorded videos from ANY language into simple, natural spoken Hindi (Devanagari) for Indian students — faithful like a top conference interpreter, easy like the best teacher.
You receive numbered transcript segments, each with its video time window and a word budget. For EVERY segment output exactly:
### <number>
<Hindi interpretation of that segment>
${RULES}
8. Timing: each block is spoken over its own video window. Stay within its word budget by condensing wording, never by dropping facts. Use neighbour context for a smooth transition, but interpret only this block's content: never move a fact to an earlier/later block or repeat it across boundaries. Prefer complete, speakable clauses with natural Hindi word order. If a sentence continues across blocks, connect it smoothly using neighbour context, without leaving a lone "अगर", "तो", "मेरी liver" or "Google" at the end or duplicating the continuation. Never fabricate an ending or add an introduction/conclusion at a timestamp boundary.`;

const PROSE_SYSTEM = `You are a senior professional interpreter and a gifted Indian teacher. You interpret lecture transcripts from ANY language into simple, natural spoken Hindi (Devanagari) for Indian students.
You receive consecutive numbered parts of one transcript. For EVERY part output exactly:
### <number>
<Hindi interpretation of that whole part as flowing spoken paragraphs>
${RULES}
8. Completeness: interpret each part fully — do not summarise it away. FIRST and LAST indicate position only: do not invent an introduction or summary. Use neighbour context to connect sentences across parts naturally without repeating or translating the context itself.`;

// ---------- As-it-is (word-to-word) transcript ----------

const VERBATIM_RULES = `As-it-is transcript rules — the student asked for the speaker's exact words, NOT an explanation:
1. Word for word: keep every spoken word in the same order and the same sentence structure. Never paraphrase, simplify, summarise, explain, replace a word with a synonym (ख़्वाब stays ख़्वाब, कठिन stays कठिन, सबक stays सबक), change tense, person or number, or merge/split ideas. Never add anything that was not said.
2. Source already in Hindi, Hindustani or Urdu (any script): write exactly what was said, in Devanagari, keeping the speaker's own grammar and verb forms (सीखेंगे stays सीखेंगे — never change it to सीखूँगी). The "Speaker gender" line never overrides words that were actually spoken. Hindi in Roman letters or Urdu script is only transliterated into Devanagari.
3. Repair only mis-hearings: the source may be automatic captions or machine listening with sound-alike errors (for example "बाद़िये" heard for "बाँधिए", "उरजाने" for "उड़ जाने", "ख़ौब" for "ख़्वाब", "अरहार" for "अगर हार"). Restore the word the speaker really said using sound, context, rhyme and metre in poems or songs, the title and the caption fixes — never a "better" or simpler word. Spell correctly, with proper nukta and chandrabindu.
4. Any other source language: translate literally, word for word, keeping the speaker's sentence order, word choices, repetitions and phrasing as closely as Hindi grammar allows; follow the "Speaker gender" line for the speaker's first-person forms. Do not simplify or explain.
5. English words the speaker said inside Hindi stay those same English words, written in Devanagari as pronounced (टेस्ट, फ़ोन, रिवीज़न); names in Devanagari as pronounced. Keep English letters only for equations, formulas, units right after a number, code, URLs and email addresses.
6. Drop only pure fillers (um, uh) and [music]/[applause] tags. Keep refrains, repetitions and self-corrections that were actually spoken. Use natural punctuation (। , ?) for text-to-speech; no markdown, bullets, emojis, brackets or notes.
7. Output only the numbered blocks, in order — no introductions, notes or explanations of your work.`;

const VERBATIM_TIMED_SYSTEM = `You are a senior professional transcriber and literal translator. You write an AS-IT-IS Hindi (Devanagari) transcript of recorded videos for Indian students: exactly what the speaker said, word for word.
You receive numbered transcript segments, each with its video time window. For EVERY segment output exactly:
### <number>
<as-it-is Hindi of that segment>
${VERBATIM_RULES}
8. Blocks: write only this block's own words — never move words to an earlier/later block, repeat them across a boundary or complete a sentence the next block continues. Never shorten a block to fit its time window.`;

const VERBATIM_PROSE_SYSTEM = `You are a senior professional transcriber and literal translator. You write an AS-IT-IS Hindi (Devanagari) transcript of lecture transcripts for Indian students: exactly what the speaker said, word for word.
You receive consecutive numbered parts of one transcript. For EVERY part output exactly:
### <number>
<as-it-is Hindi of that whole part>
${VERBATIM_RULES}
8. Completeness: write each part fully, never summarise it. FIRST and LAST indicate position only. Neighbour context is for repairing words only; never copy it into a block.`;

const fmt = (t: number) => { const s = Math.max(0, Math.round(t)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };

export type BatchContext = { title: string; language?: string; brief: InterpretBrief | null; before?: string; after?: string; opening?: string; mentionedTerms?: string[] };

function briefLines(c: BatchContext) {
  const lines = [`Video: ${c.title || 'untitled'}`, `Spoken language: ${c.brief?.language || c.language || 'detect automatically'}`];
  if (c.brief?.domain) lines.push(`Topic: ${c.brief.domain}`);
  if (c.brief?.summary) lines.push(`Summary: ${c.brief.summary}`);
  if (c.brief?.glossary.length) lines.push(`Glossary (meaning/short-label guide, not repeated definitions): ${c.brief.glossary.map(g => `${g.term} → ${g.hindi}`).join('; ')}`);
  lines.push(speakerGenderRule(c.brief?.speaker?.gender ?? 'unknown'));
  if (c.brief?.corrections.length) lines.push(`Caption fixes: ${c.brief.corrections.map(x => `"${x.heard}" means "${x.correct}"`).join('; ')}`);
  if (c.opening) lines.push(`Source opening (identity/style context only; do not interpret again): ${c.opening.slice(0, 1400)}`);
  if (c.mentionedTerms?.length) lines.push(`Previously mentioned terms: ${c.mentionedTerms.join('; ')}. Use short labels, not definitions.`);
  return lines.join('\n');
}

function neighbourLines(c: BatchContext) {
  return `${c.before ? `\nContext just before (do not interpret): ${c.before.slice(-900)}\n` : ''}${c.after ? `\nContext just after (do not interpret): ${c.after.slice(0, 900)}\n` : ''}`;
}

/** Source-derived, independent of concurrent batch completion order. */
function continuityContext(texts: string[], start: number, count: number, context: BatchContext): BatchContext {
  const previous = texts.slice(0, start).join(' ').toLowerCase();
  const terms = [...new Set([...(context.brief?.glossary.map(g => g.term) ?? []), 'Google Sheets', 'flashcards', 'Anki', 'Quizlet', 'spreadsheet', 'column'])];
  return { ...context, opening: texts.slice(0, 2).join(' ').slice(0, 1400), before: texts[start - 1] ?? '', after: texts[start + count] ?? '',
    mentionedTerms: terms.filter(term => previous.includes(term.toLowerCase())) };
}

/** Builds one timed batch prompt with neighbour context and per-segment word budgets. */
export function timedBatchPrompt(segs: TimedSegment[], c: BatchContext, budget = true) {
  const body = segs.map((s, i) => `### ${i + 1} (${fmt(s.start)}–${fmt(s.end)} · ${Math.max(1, Math.round(s.end - s.start))}s${budget ? ` · max ${wordBudget(s.end - s.start)} words` : ''})\n${s.text}`).join('\n\n');
  return `${briefLines(c)}\n${neighbourLines(c)}\n${body}`;
}

export function proseBatchPrompt(parts: { text: string; first: boolean; last: boolean }[], c: BatchContext) {
  const body = parts.map((p, i) => `### ${i + 1}${p.first ? ' (FIRST)' : ''}${p.last ? ' (LAST)' : ''}\n${p.text}`).join('\n\n');
  return `${briefLines(c)}\n${neighbourLines(c)}\n${body}`;
}

type Caller = (engine: InterpreterId, system: string, user: string, signal: AbortSignal, effort?: Effort) => Promise<string>;

/** Interprets one batch with the chosen engine, falling back across vendors on non-terminal failures. */
export async function interpretBatch(o: { engine: InterpreterId; system: string; user: string; count: number; signal: AbortSignal; call?: Caller }) {
  const call = o.call ?? callInterpreter;
  let last: unknown = null;
  for (const engine of interpreterOrder(o.engine)) {
    o.signal.throwIfAborted();
    try {
      const raw = await call(engine, o.system, o.user, o.signal);
      const lines = parseNumberedBlocks(raw, o.count).map(line => line.replace(/^\s*(?:\*\*|#+\s*)/, '').trim());
      if (lines.every(Boolean)) return { lines, engine };
      last = new InterpretError('Incomplete interpretation.', 502);
      console.error(`[interpreter] ${engine} returned ${lines.filter(Boolean).length}/${o.count} blocks; trying backup`);
    } catch (error) {
      const f = describeFailure(error);
      if (f.terminal || o.signal.aborted) throw error;
      console.error(`[interpreter] ${engine} failed (${f.status}); trying backup`);
      last = error;
    }
  }
  throw last ?? new InterpretError('Hindi interpretation नहीं बन पाया।', 503);
}


// ---------- Quality review (a second vendor checks every batch) ----------

const REVIEW_SYSTEM = `You are the chief reviewer of a professional interpreting team. A colleague interpreted video transcript segments (any source language) into simple spoken Hindi for Indian students. Compare every Hindi interpretation with its source and fix only real problems:
- a missing, added or changed fact, number, name, example, step or conclusion; any wrong meaning
- inconsistent term meaning/naming, or a mis-heard caption word not repaired; a long glossary definition mechanically repeated instead of a short familiar label
- unnecessarily formal, literal or awkward Hindi; prefer the simplest natural spoken phrasing a beginner understands — the Hindi people speak every day
- English words not handled the everyday way: anything still in English letters (blocks marked "ENGLISH LETTERS TO REWRITE" list them), textbook/Sanskritised replacements, or a spelling that differs from the glossary. Rewrite each by this rule:
${EVERYDAY_ENGLISH_RULE}
- the speaker's first-person Hindi grammar not matching the "Speaker gender" line (e.g. करती हूँ for a male speaker or करता हूँ for a female speaker); fix every such form
- changed speaker identity, viewpoint, uncertainty, questions or tone; added teacher commentary, invented cultural examples or facts moved/repeated between timestamp blocks
- repeated dictionary explanations of Google Sheets/flashcards/Anki/Quizlet/spreadsheet/column or already-introduced terms; remove unnecessary expansions without deleting a definition the source actually repeats
- chopped Hindi clauses, dangling connectors and unnatural transitions across neighbouring blocks; restore fluent spoken Hindi while keeping every fact in its original block
- longer than the word budget (condense wording, never drop facts)
- markdown, brackets, emojis or notes; fix punctuation minimally, preserving natural questions and already-good wording
For EVERY segment output exactly:
### <number>
OK
— when the interpretation is already faithful, simple, everyday in its English words and within budget — or otherwise the complete corrected Hindi interpretation and nothing else.`;

const VERBATIM_REVIEW_SYSTEM = `You are the chief reviewer of a professional transcription team. A colleague wrote an AS-IT-IS Hindi (Devanagari) transcript of video segments: the speaker's exact words, word for word — not an explanation. Compare every HINDI block with its SOURCE and fix only real problems:
- a spoken word missing, added, reordered, paraphrased, simplified or swapped for a synonym; a changed tense, person, number or grammar (a Hindi speaker's own सीखेंगे must not become सीखूँगी)
- a mis-heard word not repaired, or repaired to the wrong word (use sound, context, rhyme/metre, the title and the caption fixes)
- for a non-Hindi source: anything that is not a literal, word-for-word translation
- English letters left for an English word (write it in Devanagari as pronounced), wrong spelling, nukta or chandrabindu
- words moved or repeated across blocks; markdown, brackets, emojis or notes
For EVERY segment output exactly:
### <number>
OK
— when the block is already the exact as-it-is transcript — or otherwise the complete corrected Hindi block and nothing else.`;

// ---------- English-letters check (last step) ----------

const ENGLISH_FIX_SYSTEM = `You are the final copy editor of a professional Hindi interpreting team. Some finished Hindi blocks still contain words written in English letters. For each numbered block you get the HINDI text and the words to rewrite.
Rewrite ONLY those words, by this rule:
${EVERYDAY_ENGLISH_RULE}
Use the glossary's Devanagari spelling when it covers the word. Adjust only a postposition or verb ending right next to a replaced word if Hindi needs it. Do not rephrase, restructure, shorten or add anything: every other word, fact, number, punctuation mark and the sentence order stay exactly as given. Words the rule keeps in English letters (formulas, units right after numbers, code, links) stay unchanged.
For EVERY block output exactly:
### <number>
<the complete corrected Hindi block, nothing else>`;

const VERBATIM_ENGLISH_FIX_SYSTEM = `You are the final copy editor of an as-it-is Hindi transcript. Some blocks still contain words written in English letters. For each numbered block you get the HINDI text and the words to rewrite.
Write ONLY those words in Devanagari exactly as they are pronounced (transliterate: test → टेस्ट, phone → फ़ोन, Google → गूगल) — never replace them with Hindi synonyms. Keep English letters only for equations, formulas, units right after a number, code, URLs and email addresses. Every other word, punctuation mark and the word order stay exactly as given.
For EVERY block output exactly:
### <number>
<the complete corrected Hindi block, nothing else>`;

export function englishWordsPrompt(items: { hindi: string; words: string[] }[], c: BatchContext) {
  const body = items.map((it, i) => `### ${i + 1}\nHINDI: ${it.hindi}\nREWRITE: ${it.words.join(', ')}`).join('\n\n');
  return `${briefLines(c)}\n\n${body}`;
}

/** Takes the copy-edit only when it removed English letters without rewriting the block. */
export function acceptEnglishFix(original: string, fixed: string) {
  const v = fixed.replace(/^\s*(?:\*\*|#+\s*)/, '').replace(/^HINDI:\s*/i, '').trim();
  if (!v || !/[\u0900-\u097F]/.test(v)) return original;
  if (latinWords(v).length >= latinWords(original).length) return original;
  const ratio = v.length / Math.max(1, original.length);
  if (ratio < 0.6 || ratio > 1.8) return original;
  // A word swap keeps the surrounding Hindi; a rewritten sentence does not.
  const before = devanagariWords(original), after = new Set(devanagariWords(v));
  const kept = before.filter(word => after.has(word)).length;
  return before.length < 6 || kept / before.length >= 0.9 ? v : original;
}

const devanagariWords = (text: string) => text.match(/[\u0900-\u097F]+/g)?.filter(word => !/^[।॥]+$/.test(word)) ?? [];

/** Final pass for blocks still holding English-letter words; clean blocks cost nothing. */
export async function finishEnglishWords(o: { lines: string[]; engine: InterpreterId; context: BatchContext; signal: AbortSignal; call?: Caller; verbatim?: boolean }) {
  const pending = o.lines.map((hindi, index) => ({ index, hindi, words: latinWords(hindi) })).filter(it => it.hindi.trim() && it.words.length);
  if (!pending.length) return { lines: o.lines, fixed: 0 };
  const call = o.call ?? callInterpreter;
  for (const engine of interpreterOrder(o.engine)) {
    o.signal.throwIfAborted();
    try {
      const raw = await call(engine, o.verbatim ? VERBATIM_ENGLISH_FIX_SYSTEM : ENGLISH_FIX_SYSTEM, englishWordsPrompt(pending, o.context), o.signal, REVIEW_EFFORT);
      const blocks = parseNumberedBlocks(raw, pending.length);
      if (!blocks.some(b => b.trim())) { console.error(`[interpreter] ${engine} English-letters check returned nothing; trying backup`); continue; }
      const lines = [...o.lines];
      let fixed = 0;
      pending.forEach((it, i) => {
        const next = acceptEnglishFix(it.hindi, blocks[i] ?? '');
        if (next !== it.hindi) { lines[it.index] = next; fixed++; }
      });
      return { lines, fixed };
    } catch (error) {
      const f = describeFailure(error);
      if (f.terminal || o.signal.aborted) throw error;
      console.error(`[interpreter] English-letters check by ${engine} failed (${f.status})`);
    }
  }
  // A polish step: the reviewed interpretation is still delivered.
  return { lines: o.lines, fixed: 0 };
}

/** The reviewer always comes from a different vendor than the interpreter. */
export function reviewerOrder(interpreter: InterpreterId): InterpreterId[] {
  return interpreter === 'claude' ? ['gpt', 'gemini'] : interpreter === 'gpt' ? ['claude', 'gemini'] : ['claude', 'gpt'];
}

export function reviewPrompt(items: { source: string; hindi: string; seconds?: number }[], c: BatchContext) {
  const body = items.map((it, i) => {
    const note = englishLettersNote(it.hindi);
    return `### ${i + 1}${it.seconds ? ` (${Math.max(1, Math.round(it.seconds))}s · max ${wordBudget(it.seconds)} words)` : ''}\nSOURCE: ${it.source}\nHINDI: ${it.hindi}${note ? `\n${note}` : ''}`;
  }).join('\n\n');
  return `${briefLines(c)}\n${neighbourLines(c)}\n${body}`;
}

/** Applies reviewer output: "OK" keeps the interpretation, anything else replaces it. */
export function applyReview(lines: string[], raw: string) {
  const verdicts = parseNumberedBlocks(raw, lines.length).map(v => v.replace(/^\s*(?:\*\*|#+\s*)/, '').trim());
  let corrected = 0, reviewed = 0;
  const out = lines.map((line, i) => {
    const v = verdicts[i] ?? '';
    if (!v) return line;
    if (/^ok[.!।]?$/i.test(v) || v === line) { reviewed++; return line; }
    // A real correction is Hindi prose, never a stray note from the reviewer.
    if (!/[\u0900-\u097F]/.test(v) || v.length < Math.min(12, line.length / 3)) return line;
    reviewed++;
    corrected++;
    return v;
  });
  return { lines: out, corrected, reviewed };
}

export async function reviewBatch(o: { interpreter: InterpreterId; items: { source: string; hindi: string; seconds?: number }[]; context: BatchContext; signal: AbortSignal; call?: Caller; verbatim?: boolean }) {
  const call = o.call ?? callInterpreter;
  const lines = o.items.map(it => it.hindi);
  for (const engine of reviewerOrder(o.interpreter)) {
    o.signal.throwIfAborted();
    try {
      const raw = await call(engine, o.verbatim ? VERBATIM_REVIEW_SYSTEM : REVIEW_SYSTEM, reviewPrompt(o.items, o.context), o.signal, REVIEW_EFFORT);
      const result = applyReview(lines, raw);
      if (result.reviewed === lines.length) return { ...result, reviewer: interpreterInfo(engine).name };
      console.error(`[interpreter] reviewer ${engine} answered ${result.reviewed}/${lines.length}; trying another reviewer`);
    } catch (error) {
      const f = describeFailure(error);
      if (f.terminal || o.signal.aborted) throw error;
      console.error(`[interpreter] reviewer ${engine} failed (${f.status})`);
    }
  }
  // Review is a quality layer: the interpretation itself is still delivered.
  return { lines, corrected: 0, reviewed: 0, reviewer: '' };
}

export type QualityStats = { reviewers: string[]; reviewed: number; corrected: number };

async function pool<T>(items: T[], limit: number, run: (item: T, index: number) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; await run(items[i] as T, i); }
  }));
}

// Speed: larger batches = fewer calls; more lanes = parts translate and get checked side by side.
export const TIMED_BATCH = 6;
export const PARALLEL_BATCHES = 6;

/** Timed segments → simple Hindi lines (same order), reporting each finished segment. */
export async function interpretTimed(o: {
  segments: TimedSegment[]; context: Omit<BatchContext, 'before' | 'after'>; engine: InterpreterId; signal: AbortSignal;
  review?: boolean; onSegment(index: number, hindi: string): void; call?: Caller;
  /** As-it-is mode: the speaker's exact words (word for word) instead of a simple Hindi explanation. */
  verbatim?: boolean;
  /** Hindi already finished in an earlier (interrupted) run, aligned to segments; those batches are not paid for again. */
  saved?: string[];
}) {
  const lines = Array<string>(o.segments.length).fill('');
  const used = new Set<string>();
  const quality: QualityStats = { reviewers: [], reviewed: 0, corrected: 0 };
  const batches: number[] = [];
  for (let b = 0; b < o.segments.length; b += TIMED_BATCH) {
    const prior = o.saved && o.saved.length === o.segments.length ? o.saved.slice(b, b + TIMED_BATCH) : [];
    const count = Math.min(TIMED_BATCH, o.segments.length - b);
    if (o.review === false && prior.length === count && prior.every(line => line.trim())) {
      prior.forEach((line, i) => { lines[b + i] = line; o.onSegment(b + i, line); });
    } else batches.push(b);
  }
  await pool(batches, PARALLEL_BATCHES, async start => {
    const segs = o.segments.slice(start, start + TIMED_BATCH);
    const context = continuityContext(o.segments.map(s => s.text), start, segs.length, o.context);
    const verbatim = o.verbatim === true;
    const user = timedBatchPrompt(segs, context, !verbatim);
    const prior = o.saved?.length === o.segments.length ? o.saved.slice(start, start + segs.length) : [];
    // Device data is not proof of independent review. Recheck matching saved translations,
    // without retranslating them, whenever review is requested.
    const first = prior.length === segs.length && prior.every(line => line.trim())
      ? { lines: prior, engine: o.engine }
      : await interpretBatch({ engine: o.engine, system: verbatim ? VERBATIM_TIMED_SYSTEM : TIMED_SYSTEM, user, count: segs.length, signal: o.signal, ...(o.call ? { call: o.call } : {}) });
    used.add(interpreterInfo(first.engine).name);
    let out = first.lines;
    if (o.review !== false) {
      const checked = await reviewBatch({ interpreter: first.engine, items: segs.map((s, i) => ({ source: s.text, hindi: out[i] ?? '', ...(verbatim ? {} : { seconds: s.end - s.start }) })), context, signal: o.signal, verbatim, ...(o.call ? { call: o.call } : {}) });
      out = checked.lines; quality.reviewed += checked.reviewed; quality.corrected += checked.corrected;
      if (checked.reviewer && !quality.reviewers.includes(checked.reviewer)) quality.reviewers.push(checked.reviewer);
    }
    out = (await finishEnglishWords({ lines: out, engine: first.engine, context, signal: o.signal, verbatim, ...(o.call ? { call: o.call } : {}) })).lines;
    out.forEach((line, i) => { lines[start + i] = line; o.onSegment(start + i, line); });
  });
  return { lines, interpreters: [...used], quality };
}

/** Untimed transcript chunks → simple Hindi paragraphs (same order). */
export async function interpretProse(o: {
  chunks: string[]; context: Omit<BatchContext, 'before' | 'after'>; engine: InterpreterId; signal: AbortSignal;
  review?: boolean; onChunk(index: number, hindi: string): void; call?: Caller; verbatim?: boolean;
}) {
  const lines = Array<string>(o.chunks.length).fill('');
  const used = new Set<string>();
  const quality: QualityStats = { reviewers: [], reviewed: 0, corrected: 0 };
  const PER = 2;
  const batches: number[] = [];
  for (let b = 0; b < o.chunks.length; b += PER) batches.push(b);
  await pool(batches, PARALLEL_BATCHES, async start => {
    const parts = o.chunks.slice(start, start + PER).map((text, i) => ({ text, first: start + i === 0, last: start + i === o.chunks.length - 1 }));
    const context = continuityContext(o.chunks, start, parts.length, o.context);
    const verbatim = o.verbatim === true;
    const first = await interpretBatch({ engine: o.engine, system: verbatim ? VERBATIM_PROSE_SYSTEM : PROSE_SYSTEM, user: proseBatchPrompt(parts, context), count: parts.length, signal: o.signal, ...(o.call ? { call: o.call } : {}) });
    used.add(interpreterInfo(first.engine).name);
    let out = first.lines;
    if (o.review !== false) {
      const checked = await reviewBatch({ interpreter: first.engine, items: parts.map((p, i) => ({ source: p.text, hindi: out[i] ?? '' })), context, signal: o.signal, verbatim, ...(o.call ? { call: o.call } : {}) });
      out = checked.lines; quality.reviewed += checked.reviewed; quality.corrected += checked.corrected;
      if (checked.reviewer && !quality.reviewers.includes(checked.reviewer)) quality.reviewers.push(checked.reviewer);
    }
    out = (await finishEnglishWords({ lines: out, engine: first.engine, context, signal: o.signal, verbatim, ...(o.call ? { call: o.call } : {}) })).lines;
    out.forEach((line, i) => { lines[start + i] = line; o.onChunk(start + i, line); });
  });
  return { lines, interpreters: [...used], quality };
}

// ---------- Listening (Gemini 4 Argon) ----------

const LISTEN_SYSTEM = `You are a professional transcriber. Listen to the whole recording carefully and write a verbatim transcript of all speech in the ORIGINAL spoken language and its usual script.
Write every spoken word in order: never summarise, paraphrase, skip, translate or "improve" the speaker's sentences. Keep numbers, names, examples and self-corrections exactly as said; drop only pure fillers (um, uh).
Start a new line at each sentence boundary and at least every 15 seconds, prefixed with the start time as [h:mm:ss] measured from the start of this recording.
Spell names, brands, apps and technical terms correctly using on-screen text, the topic and context; when one word is unclear, write the most likely word rather than inventing a sentence. Mark long non-speech only as [music] or [silence].
The first line must be: LANG=<ISO 639-1 code of the main spoken language>.
The second line must be: SPEAKER=<male|female|mixed|unknown> — the main speaker's voice as heard (mixed for several speakers of different genders; unknown when unclear). Output nothing else.`;

/** Stops listening output beyond what the interpreter will use, so long videos do not run up cost. */
export const MAX_LISTEN_CHARS = 30000;

/** Gemini 4 Argon watches a public YouTube video directly and returns timestamped original-language speech. */
export async function listenYouTube(videoId: string, maxSeconds: number, signal: AbortSignal, onReached: (seconds: number) => void): Promise<ListenResult> {
  const stream = await streamChatCompletion({
    model: 'google/gemini-4-argon', reasoning_effort: LISTEN_EFFORT,
    messages: [
      { role: 'system', content: `${LISTEN_SYSTEM}\nStop after ${fmt(maxSeconds)} of the recording.` },
      { role: 'user', content: [{ type: 'video_url', video_url: { url: `https://www.youtube.com/watch?v=${videoId}` } }, { type: 'text', text: 'Transcribe this video.' }] },
    ],
  }, { signal });
  let text = '', reported = 0, truncated = false;
  for await (const event of stream) {
    const delta = (event as { choices?: { delta?: { content?: unknown } }[] }).choices?.[0]?.delta?.content;
    if (typeof delta !== 'string' || !delta) continue;
    text += delta;
    const stamps = [...text.slice(-400).matchAll(/\[(\d{1,2}:\d{2}:\d{2}|\d{1,3}:\d{2})\]/g)];
    const lastStamp = stamps.at(-1)?.[1];
    if (lastStamp) {
      const parts = lastStamp.split(':').map(Number);
      const seconds = parts.length === 3 ? (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0) : (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
      if (seconds - reported >= 15) { reported = seconds; onReached(seconds); }
      if (seconds > maxSeconds + 30) { truncated = true; break; }
    }
    if (text.length > MAX_LISTEN_CHARS) { truncated = true; text = text.slice(0, text.lastIndexOf('\n')); break; }
  }
  const result = parseListenOutput(text);
  if (!result.cues.length) throw new InterpretError('इस video में साफ़ बोली हुई बात नहीं मिली।', 422);
  return { ...result, truncated };
}

/** Gemini 4 Argon listens to one 16 kHz WAV chunk; cue times are shifted by the chunk offset. */
export async function listenAudioChunk(wavBase64: string, offset: number, signal: AbortSignal): Promise<ListenResult> {
  const r = await generateChatCompletion({
    model: 'google/gemini-4-argon', reasoning_effort: LISTEN_EFFORT,
    messages: [
      { role: 'system', content: LISTEN_SYSTEM },
      { role: 'user', content: [{ type: 'input_audio', input_audio: { data: wavBase64, format: 'wav' } }, { type: 'text', text: 'Transcribe this audio.' }] },
    ],
  }, { signal });
  const content = (r as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
  return parseListenOutput(typeof content === 'string' ? content : blocksText(content), offset);
}
