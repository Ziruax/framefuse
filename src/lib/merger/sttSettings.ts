/**
 * v1.15 — app-level speech-to-text settings (ENGINE preference + Groq model).
 *
 * These are DEVICE/App preferences, not project settings: they live in
 * localStorage (the browser) and are respected by the Electron main process
 * via the whisper:transcribe payload. The Groq API key itself is stored by
 * the MAIN process in userData/groq.json (0600, device-local, never in
 * project files) — this module only stores the *preference* of which engine
 * to use and the preferred cloud model.
 */

export type SttEngine = "groq" | "local";

export interface SttSettings {
  /** "groq" — use the Groq Whisper API when a key is saved on this device
   *  (falls back to local engines on failure). "local" — always offline. */
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
      engine: j.engine === "local" ? "local" : "groq",
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
        engine: s.engine === "local" ? "local" : "groq",
        groqModel: normalizeSttModel(s.groqModel),
      }),
    );
  } catch {
    /* storage unavailable (private mode) — preference stays in-memory */
  }
}

/**
 * The routing object whisper.ts forwards to the main process on every
 * transcription call. With no saved Groq key the main process ignores the
 * cloud routing and uses the local engines — the renderer stays honest
 * about what actually runs via the result's `engine` field.
 */
export function sttRouting(): { engine: "groq" | "local" | "auto"; groqModel: string } {
  const s = loadSttSettings();
  return { engine: s.engine, groqModel: s.groqModel };
}
