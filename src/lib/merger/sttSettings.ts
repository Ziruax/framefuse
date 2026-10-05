/**
 * v1.15/v1.20 — app-level speech-to-text settings (Groq model preference).
 *
 * These are DEVICE/App preferences, not project settings: they live in
 * localStorage (the browser) and are respected by the Electron main process
 * via the whisper:transcribe payload. The Groq API key itself is stored by
 * the MAIN process in userData/groq.json (0600, device-local, never in
 * project files) — this module only stores the preferred cloud model.
 *
 * v1.20: Groq Cloud is the ONLY transcription engine — the "local" engine
 * option no longer exists (stored "local" preferences migrate to "groq"
 * on read).
 *
 * v1.28: the model preference moved to the central AI settings
 * (src/lib/merger/ai-settings.ts — the Settings tab); sttRouting() reads
 * it from there. This module remains for the saved-key diagnostics and
 * legacy migration only.
 */

import { loadAiSettings } from "./ai-settings";

export type SttEngine = "groq";

export interface SttSettings {
  /** "groq" — the Groq Whisper API (the ONLY engine; requires a saved key). */
  engine: SttEngine;
  /** Groq model id: whisper-large-v3-turbo (default, faster) or
   *  whisper-large-v3. */
  groqModel: string;
}

const STORAGE_KEY = "framefuse.stt.v1";

export const GROQ_MODEL_OPTIONS: Array<{
  id: string;
  label: string;
  hint: string;
}> = [
  {
    id: "whisper-large-v3-turbo",
    label: "Large v3 Turbo",
    hint: "Fastest — recommended default",
  },
  {
    id: "whisper-large-v3",
    label: "Large v3",
    hint: "Maximum accuracy, slower",
  },
];

export const DEFAULT_STT_SETTINGS: SttSettings = {
  engine: "groq",
  groqModel: "whisper-large-v3-turbo",
};

export function normalizeSttModel(id: string | undefined | null): string {
  return GROQ_MODEL_OPTIONS.some((m) => m.id === id)
    ? (id as string)
    : DEFAULT_STT_SETTINGS.groqModel;
}

export function loadSttSettings(): SttSettings {
  if (typeof window === "undefined") return { ...DEFAULT_STT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STT_SETTINGS };
    const j = JSON.parse(raw) as Partial<SttSettings>;
    return {
      // v1.20: the local engines are gone — a stored "local" preference
      // migrates to "groq" on read.
      engine: "groq",
      groqModel: normalizeSttModel(j.groqModel),
    };
  } catch {
    return { ...DEFAULT_STT_SETTINGS };
  }
}

export function saveSttSettings(s: SttSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        // v1.20: groq is the only engine — always persisted as "groq".
        engine: "groq" as const,
        groqModel: normalizeSttModel(s.groqModel),
      }),
    );
  } catch {
    /* storage unavailable (private mode) — preference stays in-memory */
  }
}

/**
 * The routing object whisper.ts forwards to the main process on every
 * transcription call. v1.20: the engine is always "groq" — a missing key
 * produces a clear actionable error main-side (no local fallback exists).
 * v1.28: the model comes from the CENTRAL AI settings (the Settings tab's
 * "Caption transcription" picker) — this legacy store is no longer a second
 * source of truth.
 */
export function sttRouting(): { engine: "groq"; groqModel: string } {
  return { engine: "groq", groqModel: loadAiSettings().sttGroqModel || DEFAULT_STT_SETTINGS.groqModel };
}
