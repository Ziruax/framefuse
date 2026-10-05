"use client";

// ---------------------------------------------------------------------------
// v1.27/v1.28 CENTRAL AI SETTINGS — one store, every AI surface.
//
// The Dub Studio's script writing, the Captions transcription and the voice
// model catalogs all read their PROVIDER + MODEL from here. The pickers live
// ONLY in the Settings tab — the other surfaces show a read-only summary +
// a jump link.
//
// v1.28: the "builtin" (sandbox z-ai) provider is GONE — it only worked on
// the dev box, never on user devices. Real providers: Groq + Gemini. Keys:
// in the WEB PREVIEW they live in localStorage (framefuse.ai.v1) and ride
// each request to the API routes; in the DESKTOP app they are stored by the
// MAIN process (userData/groq.json + gemini.json, 0600) via the
// whisperGroqSet/geminiSet IPC — the store's key fields are then
// best-effort mirrors, and the *OnDevice flags track the main-process truth.
//
// v1.29 KEY TRUTH: on desktop the DEVICE key file is the ONLY key any AI
// feature sends. The Settings tab migrates any localStorage mirror onto the
// device on first hydrate and then keeps the mirror EMPTY (groqKey/geminiKey
// stay ""), so the *OnDevice flags alone describe desktop key presence and
// the masked display can never show a stale second key.
//
// Model catalogs: the Groq chat ids, the Gemini text ids and the Groq
// Whisper ids. The server routes accept the same ids
// (src/lib/server/ai-models.ts keeps a mirrored copy — keep in sync).
// ---------------------------------------------------------------------------

/** Text-LLM providers for script writing. */
export type AiTextProvider = "groq" | "gemini";
/** Transcription providers (captions + Dub Studio stage 1) — Groq Whisper. */
export type AiSttProvider = "groq";

export interface AiSettings {
  /** Transcription provider — "groq" (Whisper, real word timestamps,
   *  needs the Groq key). v1.28: the only provider (builtin removed). */
  sttProvider: AiSttProvider;
  /** Groq Whisper model id. */
  sttGroqModel: string;
  /** The dub's SCRIPT WRITING provider (speaker detection + translation). */
  dubTextProvider: AiTextProvider;
  dubGroqModel: string;
  dubGeminiModel: string;
  /** API keys (web preview — localStorage only, sent per-request). In the
   *  desktop app the raw key lives ONLY in the main-process key files; the
   *  *OnDevice flags below mirror their presence for the read-only
   *  summaries. */
  groqKey: string;
  geminiKey: string;
  /** v1.28 desktop mirrors: the main process has a key saved on this device
   *  (userData/groq.json / gemini.json). Set by the Settings tab from the
   *  whisperGroqGet/geminiGet IPC payloads; always false in the web preview. */
  groqKeyOnDevice?: boolean;
  geminiKeyOnDevice?: boolean;
}

// ---------------------------------------------------------------------------
// Model catalogs (mirrored server-side in src/lib/server/ai-models.ts)
// ---------------------------------------------------------------------------

export interface AiModelOption {
  id: string;
  label: string;
  hint: string;
}

/** Groq chat models (script writing — free tier friendly). */
export const GROQ_TEXT_MODELS: AiModelOption[] = [
  { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", hint: "Groq default — best quality" },
  { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B", hint: "Instant — very fast" },
  { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", hint: "OpenAI open-weight 120B" },
  { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B", hint: "OpenAI open-weight 20B" },
  { id: "qwen/qwen3-32b", label: "Qwen 3 32B", hint: "Strong multilingual" },
  { id: "gemma2-9b-it", label: "Gemma 2 9B", hint: "Light multilingual" },
];

/** Google Gemini text models (script writing — generous free tier). */
export const GEMINI_TEXT_MODELS: AiModelOption[] = [
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite", hint: "Fastest + generous free tier" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", hint: "Fast, high quality" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite", hint: "Light + fast" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", hint: "Proven all-rounder" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", hint: "Highest quality, slower" },
];

/** Groq Whisper transcription models. */
export const GROQ_WHISPER_MODELS: AiModelOption[] = [
  { id: "whisper-large-v3-turbo", label: "Whisper Large v3 Turbo", hint: "Faster, near-identical accuracy" },
  { id: "whisper-large-v3", label: "Whisper Large v3", hint: "Maximum accuracy" },
];

export const DUB_GROQ_DEFAULT = "llama-3.3-70b-versatile";
export const DUB_GEMINI_DEFAULT = "gemini-3.5-flash-lite";
export const STT_GROQ_DEFAULT = "whisper-large-v3-turbo";

// ---------------------------------------------------------------------------
// Defaults + guards
// ---------------------------------------------------------------------------

export const DEFAULT_AI_SETTINGS: AiSettings = {
  sttProvider: "groq",
  sttGroqModel: STT_GROQ_DEFAULT,
  dubTextProvider: "groq",
  dubGroqModel: DUB_GROQ_DEFAULT,
  dubGeminiModel: DUB_GEMINI_DEFAULT,
  groqKey: "",
  geminiKey: "",
  groqKeyOnDevice: false,
  geminiKeyOnDevice: false,
};

const STORAGE_KEY = "framefuse.ai.v1";

function isTextProvider(v: unknown): v is AiTextProvider {
  return v === "groq" || v === "gemini";
}
function pickModel(v: unknown, catalog: AiModelOption[], fallback: string): string {
  if (typeof v === "string" && catalog.some((m) => m.id === v)) return v;
  return fallback;
}

/** Load + sanitize (unknown/garbage fields fall back to defaults).
 * v1.28 migration: a stored "builtin" provider (the removed sandbox-only
 * engine) reads as "groq" — old installs keep working with one provider. */
export function loadAiSettings(): AiSettings {
  if (typeof window === "undefined") return { ...DEFAULT_AI_SETTINGS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_AI_SETTINGS };
    const j = JSON.parse(raw) as Record<string, unknown>;
    return {
      sttProvider: "groq",
      sttGroqModel: pickModel(j.sttGroqModel, GROQ_WHISPER_MODELS, STT_GROQ_DEFAULT),
      dubTextProvider: isTextProvider(j.dubTextProvider) ? j.dubTextProvider : "groq",
      dubGroqModel: pickModel(j.dubGroqModel, GROQ_TEXT_MODELS, DUB_GROQ_DEFAULT),
      dubGeminiModel: pickModel(j.dubGeminiModel, GEMINI_TEXT_MODELS, DUB_GEMINI_DEFAULT),
      groqKey: typeof j.groqKey === "string" ? j.groqKey : "",
      geminiKey: typeof j.geminiKey === "string" ? j.geminiKey : "",
      groqKeyOnDevice: j.groqKeyOnDevice === true,
      geminiKeyOnDevice: j.geminiKeyOnDevice === true,
    };
  } catch {
    return { ...DEFAULT_AI_SETTINGS };
  }
}

export function saveAiSettings(s: AiSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage full / private mode — settings stay in-memory this session */
  }
  notify();
}

// ---------------------------------------------------------------------------
// Tiny pub/sub so every mounted surface re-renders when the Settings tab
// changes a provider/model (useSyncExternalStore-friendly).
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* listener errors never break the store */
    }
  }
}

export function subscribeAiSettings(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Snapshot for useSyncExternalStore (stable object per read). */
let cachedSnapshot: AiSettings | null = null;
let cachedRaw = "";
export function getAiSettingsSnapshot(): AiSettings {
  if (typeof window === "undefined") return DEFAULT_AI_SETTINGS;
  const raw = window.localStorage.getItem(STORAGE_KEY) ?? "";
  if (cachedSnapshot && raw === cachedRaw) return cachedSnapshot;
  cachedRaw = raw;
  cachedSnapshot = loadAiSettings();
  return cachedSnapshot;
}

// ---------------------------------------------------------------------------
// React binding
// ---------------------------------------------------------------------------

import { useSyncExternalStore } from "react";

/** Live AI settings (re-renders whenever the Settings tab saves). */
export function useAiSettings(): AiSettings {
  return useSyncExternalStore(subscribeAiSettings, getAiSettingsSnapshot, () => DEFAULT_AI_SETTINGS);
}

// ---------------------------------------------------------------------------
// Helpers for the read-only summaries the Dub Studio / Captions cards show.
// ---------------------------------------------------------------------------

export function providerLabel(p: AiTextProvider | AiSttProvider): string {
  switch (p) {
    case "groq":
      return "Groq";
    case "gemini":
      return "Gemini";
    default:
      return "Groq";
  }
}

export function modelLabel(catalog: AiModelOption[], id: string): string {
  return catalog.find((m) => m.id === id)?.label ?? id;
}

/** The provider+model the DUB script writing currently uses. */
export function dubTextConfig(s: AiSettings): { provider: string; modelId: string; modelLabel: string } {
  if (s.dubTextProvider === "gemini")
    return { provider: "Gemini", modelId: s.dubGeminiModel, modelLabel: modelLabel(GEMINI_TEXT_MODELS, s.dubGeminiModel) };
  return { provider: "Groq", modelId: s.dubGroqModel, modelLabel: modelLabel(GROQ_TEXT_MODELS, s.dubGroqModel) };
}

/** The provider+model CAPTION transcription currently uses. */
export function sttConfig(s: AiSettings): { provider: string; modelId: string; modelLabel: string } {
  return {
    provider: "Groq Whisper",
    modelId: s.sttGroqModel,
    modelLabel: modelLabel(GROQ_WHISPER_MODELS, s.sttGroqModel),
  };
}

/** A Groq key is configured (web localStorage or the Electron main process). */
export function hasGroqKey(s: AiSettings): boolean {
  return s.groqKey.trim().length > 0 || s.groqKeyOnDevice === true;
}
export function hasGeminiKey(s: AiSettings): boolean {
  return s.geminiKey.trim().length > 0 || s.geminiKeyOnDevice === true;
}
