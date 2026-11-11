import type { VoiceQuizEntry, VoiceRow } from './voice-transcript';

/** Voice mode transcript kept on this device so a refresh does not wipe it. */
export const VOICE_DRAFT_KEY = 'snapsolve.voice-transcript';
/** How long a saved voice transcript lives after its last change. */
export const VOICE_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

type Draft = { savedAt: number; rows: VoiceRow[]; quiz: VoiceQuizEntry[] };

function storage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

/** Saved transcript, or null when there is none or it is older than 24 hours (an expired one is deleted). */
export function loadVoiceDraft(now = Date.now(), store = storage()): { rows: VoiceRow[]; quiz: VoiceQuizEntry[] } | null {
  if (!store) return null;
  try {
    const raw = store.getItem(VOICE_DRAFT_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<Draft>;
    const fresh = typeof data.savedAt === 'number' && now - data.savedAt < VOICE_DRAFT_TTL_MS && now >= data.savedAt - 60_000;
    const rows = Array.isArray(data.rows) ? data.rows.filter((r): r is VoiceRow => !!r && typeof r.id === 'string' && (r.role === 'user' || r.role === 'assistant') && typeof r.text === 'string') : [];
    if (!fresh || !rows.length) { store.removeItem(VOICE_DRAFT_KEY); return null; }
    const quiz = Array.isArray(data.quiz) ? data.quiz.filter((q): q is VoiceQuizEntry => !!q && typeof q.id === 'string' && typeof q.text === 'string' && !!q.labels && typeof q.labels === 'object') : [];
    return { rows, quiz };
  } catch {
    try { store.removeItem(VOICE_DRAFT_KEY); } catch { /* ignore */ }
    return null;
  }
}

/** Saves the transcript (resetting its 24-hour clock); an empty transcript removes the saved copy. Never throws. */
export function saveVoiceDraft(rows: VoiceRow[], quiz: VoiceQuizEntry[], now = Date.now(), store = storage()): boolean {
  if (!store) return false;
  try {
    if (!rows.length) { store.removeItem(VOICE_DRAFT_KEY); return true; }
    store.setItem(VOICE_DRAFT_KEY, JSON.stringify({ savedAt: now, rows, quiz } satisfies Draft));
    return true;
  } catch { return false; }
}
