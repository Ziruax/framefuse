"use client";

// ---------------------------------------------------------------------------
// v1.27 CENTRAL AI SETTINGS — one store, every AI surface.
//
// The Dub Studio's script writing, the Captions transcription and the voice
// model catalogs all read their PROVIDER + MODEL from here. Before v1.27 the
// provider/model pickers were scattered (Dub Studio stage 2, the Captions
// engine card, the Script Writer); they now live ONLY in the Settings tab —
// the other surfaces show a read-only summary + a jump link.
//
// Keys: in the WEB PREVIEW the Groq/Gemini keys live in localStorage
// (framefuse.aikeys.v1) and ride EACH request to the API routes (the server
// never persists them). In the desktop app the main-process key files remain
// authoritative — this store's key fields are then best-effort mirrors.
//
// Model catalogs: the GLM ids the built-in cloud accepts, the Groq chat ids,
// the Gemini text ids and the Groq Whisper ids. The server routes accept the
// same ids (src/lib/server/ai-models.ts keeps a mirrored copy — keep in sync).
// ---------------------------------------------------------------------------

/** Text-LLM providers for script writing. */
export type AiTextProvider = "builtin" | "groq" | "gemini";
/** Transcription providers (captions + Dub Studio stage 1). */
export type AiSttProvider = "builtin" | "groq";

export interface AiSettings {
  /** v1.27: transcription provider — "builtin" (cloud ASR, no key) or
   *  "groq" (Groq Whisper, real word timestamps, needs the Groq key). */
  sttProvider: AiSttProvider;
  /** Groq Whisper model id. */
  sttGroqModel: string;
  /** v1.27: the dub's SCRIPT WRITING provider (speaker detection +
   *  translation). "builtin" = the keyless cloud model. */
  dubTextProvider: AiTextProvider;
  dubGroqModel: string;
  dubGeminiModel: string;
  dubBuiltinModel: string;
  /** API keys (web preview — localStorage only, sent per-request). */
  groqKey: string;
  geminiKey: string;
}

// ---------------------------------------------------------------------------
// Model catalogs (mirrored server-side in src/lib/server/ai-models.ts)
// ---------------------------------------------------------------------------

export interface AiModelOption {
  id: string;
  label: string;
  hint: string;
}

/** Built-in cloud text models (the z-ai backend). */
export const BUILTIN_TEXT_MODELS: AiModelOption[] = [
  { id: "glm-4.6", label: "GLM 4.6", hint: "Most capable — best translation quality" },
  { id: "glm-4.5-air", label: "GLM 4.5 Air", hint: "Lighter + fast, solid translations" },
  { id: "glm-4.5", label: "GLM 4.5", hint: "Balanced flagship" },
  { id: "glm-4-plus", label: "GLM 4 Plus", hint: "Steady all-rounder" },
  { id: "glm-4-flash", label: "GLM 4 Flash", hint: "Fastest, short scripts" },
];

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

export const DUB_BUILTIN_DEFAULT = "glm-4.6";
export const DUB_GROQ_DEFAULT = "llama-3.3-70b-versatile";
export const DUB_GEMINI_DEFAULT = "gemini-3.5-flash-lite";
export const STT_GROQ_DEFAULT = "whisper-large-v3-turbo";

// ---------------------------------------------------------------------------
// Defaults + guards
// ---------------------------------------------------------------------------

export const DEFAULT_AI_SETTINGS: AiSettings = {
  sttProvider: "builtin",
  sttGroqModel: STT_GROQ_DEFAULT,
  dubTextProvider: "builtin",
  dubGroqModel: DUB_GROQ_DEFAULT,
  dubGeminiModel: DUB_GEMINI_DEFAULT,
  dubBuiltinModel: DUB_BUILTIN_DEFAULT,
  groqKey: "",
  geminiKey: "",
};

const STORAGE_KEY = "framefuse.ai.v1";

function isTextProvider(v: unknown): v is AiTextProvider {
  return v === "builtin" || v === "groq" || v === "gemini";
}
function isSttProvider(v: unknown): v is AiSttProvider {
  return v === "builtin" || v === "groq";
}
function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}
function pickModel(v: unknown, catalog: AiModelOption[], fallback: string): string {
  if (typeof v === "string" && catalog.some((m) => m.id === v)) return v;
  return fallback;
}

/** Load + sanitize (unknown/garbage fields fall back to defaults). */
export function loadAiSettings(): AiSettings {
  if (typeof window === "undefined") return { ...DEFAULT_AI_SETTINGS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_AI_SETTINGS };
    const j = JSON.parse(raw) as Record<string, unknown>;
    return {
      sttProvider: isSttProvider(j.sttProvider) ? j.sttProvider : "builtin",
      sttGroqModel: pickModel(j.sttGroqModel, GROQ_WHISPER_MODELS, STT_GROQ_DEFAULT),
      dubTextProvider: isTextProvider(j.dubTextProvider) ? j.dubTextProvider : "builtin",
      dubGroqModel: pickModel(j.dubGroqModel, GROQ_TEXT_MODELS, DUB_GROQ_DEFAULT),
      dubGeminiModel: pickModel(j.dubGeminiModel, GEMINI_TEXT_MODELS, DUB_GEMINI_DEFAULT),
      dubBuiltinModel: pickModel(j.dubBuiltinModel, BUILTIN_TEXT_MODELS, DUB_BUILTIN_DEFAULT),
      groqKey: typeof j.groqKey === "string" ? j.groqKey : "",
      geminiKey: typeof j.geminiKey === "string" ? j.geminiKey : "",
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
    case "builtin":
      return "Built-in Cloud AI";
  }
}

export function modelLabel(catalog: AiModelOption[], id: string): string {
  return catalog.find((m) => m.id === id)?.label ?? id;
}

/** The provider+model the DUB script writing currently uses. */
export function dubTextConfig(s: AiSettings): { provider: string; modelId: string; modelLabel: string } {
  const provider = providerLabel(s.dubTextProvider);
  if (s.dubTextProvider === "groq")
    return { provider, modelId: s.dubGroqModel, modelLabel: modelLabel(GROQ_TEXT_MODELS, s.dubGroqModel) };
  if (s.dubTextProvider === "gemini")
    return { provider, modelId: s.dubGeminiModel, modelLabel: modelLabel(GEMINI_TEXT_MODELS, s.dubGeminiModel) };
  return { provider, modelId: s.dubBuiltinModel, modelLabel: modelLabel(BUILTIN_TEXT_MODELS, s.dubBuiltinModel) };
}

/** The provider+model CAPTION transcription currently uses. */
export function sttConfig(s: AiSettings): { provider: string; modelId: string; modelLabel: string } {
  const provider = providerLabel(s.sttProvider);
  if (s.sttProvider === "groq")
    return { provider, modelId: s.sttGroqModel, modelLabel: modelLabel(GROQ_WHISPER_MODELS, s.sttGroqModel) };
  return { provider, modelId: "", modelLabel: "Cloud ASR" };
}

/** A Groq key is configured (web localStorage or Electron main-process). */
export function hasGroqKey(s: AiSettings): boolean {
  return s.groqKey.trim().length > 0;
}
export function hasGeminiKey(s: AiSettings): boolean {
  return s.geminiKey.trim().length > 0;
}
