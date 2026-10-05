"use client";

// ---------------------------------------------------------------------------
// v1.26 SPEECH TRANSPORT — one API surface for BOTH runtimes.
//
// The packaged Electron app exposes TTS/dubbing through window.electronAPI
// (Edge-TTS in the main process, Groq Whisper + Gemini/Groq LLM via the
// user's keys). The WEB PREVIEW has no electronAPI — these wrappers fall
// back to the Next.js API routes (src/app/api/tts/*, src/app/api/dub/*)
// which run Edge-TTS + ffmpeg + the z-ai SDK server-side. Every component
// below (TTS Studio, Voiceover, Dub Studio) calls THIS module instead of
// touching window.electronAPI directly, so the same UI works in both.
//
// Electron discipline stays intact: when the bridge exists the IPC path is
// preferred (byte-identical to ≤ v1.25 behavior); the routes are only hit
// when the bridge is absent.
// ---------------------------------------------------------------------------

import type {
  DubScriptResult,
  DubTrackResult,
  DubTranscriptResult,
} from "@/lib/merger/types";

/** True when the Electron IPC bridge is present (packaged app / dev electron). */
export function hasElectronBridge(): boolean {
  return typeof window !== "undefined" && window.electronAPI != null;
}

// ---------------------------------------------------------------------------
// Shared response plumbing
// ---------------------------------------------------------------------------

interface ApiEnvelope {
  ok: boolean;
  error?: string;
}

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new Error(
      e instanceof Error && e.message
        ? `Network error: ${e.message}`
        : "Network error — the speech service is unreachable",
    );
  }
  let body: (ApiEnvelope & T) | null = null;
  try {
    body = (await res.json()) as ApiEnvelope & T;
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok || !body || body.ok === false) {
    const msg = body?.error ?? `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return body;
}

function postJson<T>(url: string, payload: unknown, signal?: AbortSignal): Promise<T> {
  return apiJson<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
}

function postForm<T>(url: string, form: FormData, signal?: AbortSignal): Promise<T> {
  return apiJson<T>(url, { method: "POST", body: form, signal });
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Voice catalog
// ---------------------------------------------------------------------------

export interface SpeechVoice {
  shortName: string;
  gender: string;
  locale: string;
  friendlyName: string;
  displayName: string;
  styleList?: string[];
}

export interface SpeechLanguage {
  code: string;
  name: string;
  locales: string[];
}

export interface SpeechVoiceCatalog {
  voices: SpeechVoice[];
  pairs: Record<string, { female: string; male: string }>;
  languages: SpeechLanguage[];
}

interface VoicesResponse extends ApiEnvelope {
  voices: SpeechVoice[];
  pairs: Record<string, { female: string; male: string }>;
  languages: SpeechLanguage[];
}

/**
 * IPC-first voice catalog. Electron: the main-process Edge-TTS cache.
 * Web: GET /api/tts/voices (server Edge-TTS catalog, 322+ voices).
 * Returns null only when BOTH paths fail (offline-ish) — callers treat
 * null as "catalog unavailable" and keep their pickers usable.
 */
export async function fetchTtsVoices(): Promise<SpeechVoiceCatalog | null> {
  const ipc = hasElectronBridge() ? window.electronAPI?.ttsVoices : undefined;
  if (typeof ipc === "function") {
    try {
      const r = await ipc();
      if (r && Array.isArray(r.voices)) {
        return {
          voices: r.voices,
          pairs: r.pairs ?? {},
          languages: groupLanguages(r.voices),
        };
      }
    } catch {
      /* fall through to the web route */
    }
  }
  try {
    const r = await apiJson<VoicesResponse>("/api/tts/voices");
    return { voices: r.voices ?? [], pairs: r.pairs ?? {}, languages: r.languages ?? [] };
  } catch {
    return null;
  }
}

/** Client-side language grouping when the catalog came from IPC (no
 *  `languages` field there): locale "hi-IN" → language "hi" / Hindi via
 *  Intl.DisplayNames with a graceful code fallback. */
export function groupLanguages(voices: SpeechVoice[]): SpeechLanguage[] {
  const byLang = new Map<string, Set<string>>();
  for (const v of voices) {
    const lang = (v.locale || "").split("-")[0];
    if (!lang) continue;
    let set = byLang.get(lang);
    if (!set) {
      set = new Set<string>();
      byLang.set(lang, set);
    }
    set.add(v.locale);
  }
  let dn: Intl.DisplayNames | null = null;
  try {
    dn = new Intl.DisplayNames(["en"], { type: "language" });
  } catch {
    /* very old engines — code fallback */
  }
  const out: SpeechLanguage[] = [];
  for (const [code, locales] of byLang) {
    let name = code;
    try {
      name = dn?.of(code) ?? code;
    } catch {
      /* unknown code */
    }
    out.push({
      code,
      name: name.charAt(0).toUpperCase() + name.slice(1),
      locales: Array.from(locales).sort(),
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Human region label for a locale ("hi-IN" → "India"), code fallback. */
export function regionLabel(locale: string): string {
  const region = locale.split("-")[1];
  if (!region) return locale;
  try {
    const dn = new Intl.DisplayNames(["en"], { type: "region" });
    return dn.of(region) ?? region;
  } catch {
    return region;
  }
}

// ---------------------------------------------------------------------------
// Voice preview + synthesis (short + long)
// ---------------------------------------------------------------------------

export interface SynthWord {
  text: string;
  offsetMs: number;
  durationMs: number;
}

export interface PreviewResult {
  bytes: ArrayBuffer;
  bytesLen: number;
}

interface SynthResponse extends ApiEnvelope {
  bytes: string;
  bytesLen: number;
  mimeType: string;
  words: SynthWord[];
  chunkCount: number;
}

/** Short voice preview. IPC-first (single-flight main-side), else the route. */
export async function ttsPreviewVoice(p: {
  voice: string;
  text: string;
}): Promise<PreviewResult> {
  const ipc = hasElectronBridge() ? window.electronAPI?.ttsPreview : undefined;
  if (typeof ipc === "function") {
    return ipc(p);
  }
  const r = await postJson<SynthResponse>("/api/tts/synthesize", {
    text: p.text,
    voice: p.voice,
  });
  const u8 = base64ToUint8(r.bytes);
  return {
    bytes: u8.buffer.slice(
      u8.byteOffset,
      u8.byteOffset + u8.byteLength,
    ) as ArrayBuffer,
    bytesLen: r.bytesLen,
  };
}

export interface ShortSynthResult {
  bytes: ArrayBuffer;
  bytesLen: number;
  durationMs: number;
  words: SynthWord[];
}

/** Single-shot synthesis (Voiceover-section sized texts). Electron:
 *  ttsSynthesize IPC (one utterance, main-side temp file); web: one
 *  /api/tts/synthesize call. `volumePct` follows the 0..100 slider
 *  convention (100 = unity). */
export async function ttsSynthesizeShort(p: {
  text: string;
  voice: string;
  ratePct?: number;
  pitchHz?: number;
  volumePct?: number;
}): Promise<ShortSynthResult> {
  const ipc = hasElectronBridge() ? window.electronAPI?.ttsSynthesize : undefined;
  if (typeof ipc === "function") {
    const r = await ipc({
      text: p.text,
      voice: p.voice,
      ratePct: p.ratePct,
      pitchHz: p.pitchHz,
      // The engine takes -100..0 (attenuation only; 0 = unity).
      volumePct: (p.volumePct ?? 100) - 100,
    });
    return {
      bytes: r.bytes,
      bytesLen: r.bytes.byteLength,
      durationMs: r.durationMs,
      words: r.words ?? [],
    };
  }
  const r = await postJson<SynthResponse>("/api/tts/synthesize", {
    text: p.text,
    voice: p.voice,
    ratePct: p.ratePct,
    pitchHz: p.pitchHz,
    volume: (p.volumePct ?? 100) / 100,
  });
  const u8 = base64ToUint8(r.bytes);
  const lastWordEnd =
    r.words && r.words.length > 0
      ? Math.max(...r.words.map((w) => w.offsetMs + w.durationMs))
      : Math.round(u8.length / 6);
  return {
    bytes: u8.buffer.slice(
      u8.byteOffset,
      u8.byteOffset + u8.byteLength,
    ) as ArrayBuffer,
    bytesLen: r.bytesLen ?? u8.length,
    durationMs: lastWordEnd,
    words: r.words ?? [],
  };
}

export interface ChunkSynthOptions {
  text: string;
  voice: string;
  /** −95..+100 (percent, matching the studio slider). */
  ratePct?: number;
  /** −100..+100 Hz. */
  pitchHz?: number;
  /** 0..100 slider (100 = unity) — maps to the route's linear 0..1 volume. */
  volumePct?: number;
  onProgress?: (d: {
    chunkIndex: number;
    chunkCount: number;
    charsDone: number;
    totalChars: number;
    status: string;
  }) => void;
  signal?: AbortSignal;
}

export interface ChunkSynthResult {
  bytes: Uint8Array;
  bytesLen: number;
  durationMs: number;
  words: SynthWord[];
  chunkCount: number;
}

/**
 * One synthesis (short OR long). Electron: ttsSynthesizeLong + ttsReadAudio
 * (main-side chunking, live progress channel). Web: client-side
 * sentence-aware chunking — each chunk POSTs /api/tts/synthesize, bytes are
 * concatenated (raw MP3 frames, same merge the main process does) and word
 * offsets are re-based per chunk, giving real progress + AbortController
 * cancel parity with the desktop app.
 */
export async function ttsSynthesize(opts: ChunkSynthOptions): Promise<ChunkSynthResult> {
  const api = hasElectronBridge() ? window.electronAPI : undefined;
  if (typeof api?.ttsSynthesizeLong === "function" && typeof api.ttsReadAudio === "function") {
    const runId = `tts_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const unsub =
      typeof api.onTtsProgress === "function"
        ? api.onTtsProgress((d) => {
            if (!d || d.runId !== runId) return;
            opts.onProgress?.({
              chunkIndex: d.chunkIndex ?? 0,
              chunkCount: d.chunkCount ?? 0,
              charsDone: d.charsDone ?? 0,
              totalChars: d.totalChars ?? 0,
              status: d.status ?? "",
            });
          })
        : undefined;
    try {
      const res = await api.ttsSynthesizeLong({
        runId,
        text: opts.text,
        voice: opts.voice,
        ratePct: opts.ratePct,
        pitchHz: opts.pitchHz,
        // The engine takes -100..0 (attenuation only; 0 = unity).
        volumePct: (opts.volumePct ?? 100) - 100,
      });
      const rr = await api.ttsReadAudio({ filePath: res.filePath });
      return {
        bytes: new Uint8Array(rr.bytes),
        bytesLen: rr.bytesLen ?? res.bytesLen,
        durationMs: res.durationMs,
        words: res.words ?? [],
        chunkCount: res.chunkCount,
      };
    } finally {
      unsub?.();
    }
  }

  // ---- Web route path (client-side chunk loop) ----
  const chunks = splitForSynthesis(opts.text);
  const totalChars = opts.text.length;
  const parts: Uint8Array[] = [];
  const words: SynthWord[] = [];
  const chunkChars: number[] = [];
  let bytesLen = 0;
  let chunkStartMs = 0;

  for (let i = 0; i < chunks.length; i++) {
    if (opts.signal?.aborted) throw new DOMException("Synthesis cancelled", "AbortError");
    const charsDone = chunkChars.reduce((a, b) => a + b, 0);
    opts.onProgress?.({
      chunkIndex: i,
      chunkCount: chunks.length,
      charsDone,
      totalChars,
      status:
        chunks.length > 1
          ? `Synthesizing chunk ${i + 1} of ${chunks.length}…`
          : "Synthesizing…",
    });
    const r = await postJson<SynthResponse>(
      "/api/tts/synthesize",
      {
        text: chunks[i],
        voice: opts.voice,
        ratePct: opts.ratePct,
        pitchHz: opts.pitchHz,
        volume: (opts.volumePct ?? 100) / 100,
      },
    );
    chunkChars.push(chunks[i].length);
    const u8 = base64ToUint8(r.bytes);
    parts.push(u8);
    bytesLen += r.bytesLen ?? u8.length;
    let chunkDur: number;
    if (r.words && r.words.length > 0) {
      for (const w of r.words) {
        words.push({
          text: w.text,
          offsetMs: chunkStartMs + w.offsetMs,
          durationMs: w.durationMs,
        });
      }
      chunkDur = Math.max(
        ...r.words.map((w) => w.offsetMs + w.durationMs),
      );
    } else {
      // 48 kbps MP3 ≈ 6000 bytes/s → ms.
      chunkDur = Math.round(u8.length / 6);
    }
    chunkStartMs += chunkDur;
  }

  const merged = new Uint8Array(bytesLen);
  let off = 0;
  for (const p of parts) {
    merged.set(p, off);
    off += p.length;
  }
  opts.onProgress?.({
    chunkIndex: chunks.length,
    chunkCount: chunks.length,
    charsDone: totalChars,
    totalChars,
    status: "Measuring duration…",
  });
  const durationMs =
    words.length > 0
      ? Math.max(...words.map((w) => w.offsetMs + w.durationMs))
      : chunkStartMs;
  return { bytes: merged, bytesLen, durationMs, words, chunkCount: chunks.length };
}

/** Aborts the active web long-run (IPC runs cancel via ttsCancelLong at
 *  the call site — the runId lives there). */
export function makeSynthAbort(): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  return { signal: ctrl.signal, cancel: () => ctrl.abort() };
}

/**
 * Sentence-aware chunking (mirrors the main process's splitter: never
 * splits mid-sentence unless a single sentence exceeds the cap; honors
 * Devanagari danda, Arabic-period Urdu, Latin punctuation and newlines).
 */
export function splitForSynthesis(text: string, maxLen = 2000): string[] {
  const t = text.trim();
  if (t.length <= maxLen) return t ? [t] : [];
  const sentences =
    t.match(/[^।.!?؟\n]+[।.!?؟]*\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [t];
  const chunks: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (s.length > maxLen) {
      if (cur) {
        chunks.push(cur);
        cur = "";
      }
      for (let i = 0; i < s.length; i += maxLen) {
        chunks.push(s.slice(i, i + maxLen));
      }
      continue;
    }
    if ((cur + " " + s).trim().length > maxLen) {
      if (cur) chunks.push(cur);
      cur = s;
    } else {
      cur = cur ? `${cur} ${s}` : s;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// ---------------------------------------------------------------------------
// Dub Studio — models / transcribe / script / synthesize
// ---------------------------------------------------------------------------

export interface DubModelsWeb {
  models: Array<{ id: string; label: string; hint: string }>;
  default: string;
  langNames: Record<string, string>;
  /** "web" when served by the API route (no key needed); "ipc" shape keeps
   *  the Electron gemini block. */
  provider: "web" | "ipc";
  gemini?: {
    models: Array<{ id: string; label: string; hint: string }>;
    default: string;
    hasKey: boolean;
  };
  /** v1.27: the full Settings-tab catalogs (web route). */
  builtin?: { models: Array<{ id: string; label: string; hint: string }>; default: string };
  groq?: { models: Array<{ id: string; label: string; hint: string }>; default: string };
  whisper?: { models: Array<{ id: string; label: string; hint: string }>; default: string };
}

interface ModelsResponse extends ApiEnvelope {
  models: Array<{ id: string; label: string; hint: string }>;
  default?: string;
  langNames: Record<string, string>;
  provider?: string;
  web?: boolean;
  builtin?: { models: Array<{ id: string; label: string; hint: string }>; default: string };
  groq?: { models: Array<{ id: string; label: string; hint: string }>; default: string };
  gemini?: { models: Array<{ id: string; label: string; hint: string }>; default: string };
  whisper?: { models: Array<{ id: string; label: string; hint: string }>; default: string };
}

/** Model/language catalog for the Dub Studio (langNames feeds the language
 *  dropdown; web provider needs no key). */
export async function fetchDubModels(): Promise<DubModelsWeb | null> {
  const ipc = hasElectronBridge() ? window.electronAPI?.dubModels : undefined;
  if (typeof ipc === "function") {
    try {
      const r = await ipc();
      return {
        models: r.models ?? [],
        default: r.default ?? "",
        langNames: r.langNames ?? {},
        provider: "ipc",
        gemini: r.gemini,
      };
    } catch {
      /* fall through to the web route */
    }
  }
  try {
    const r = await apiJson<ModelsResponse>("/api/dub/models");
    return {
      models: r.models ?? [],
      default: r.default ?? "",
      langNames: r.langNames ?? {},
      provider: "web",
      builtin: r.builtin,
      groq: r.groq,
      gemini: r.gemini
        ? { models: r.gemini.models ?? [], default: r.gemini.default ?? "", hasKey: true }
        : undefined,
      whisper: r.whisper,
    };
  } catch {
    return null;
  }
}

export interface WebDubSource {
  /** The timeline file (web preview: browser File object). */
  file: File;
  startMs: number;
  endMs?: number;
}

interface TranscribeResponse extends ApiEnvelope {
  language: string;
  totalMs: number;
  wordCount: number;
  utterances: Array<{
    startMs: number;
    endMs: number;
    text: string;
    words?: Array<{ text: string; startMs: number; endMs: number }>;
  }>;
  /** v1.27: true when the word timings are REAL (Groq Whisper). */
  realWordTimings?: boolean;
  providerUsed?: string;
}

/** Stage 1 — audio → word-level transcript. Electron keeps the Groq Whisper
 *  IPC path (key + model live in the main-process config); the web route
 *  runs ffmpeg extraction + ASR server-side ("groq" → Groq Whisper with
 *  REAL word timestamps when a key is set — otherwise the sandbox cloud
 *  fallback). */
export async function dubTranscribe(p: {
  /** Electron sources (absolute paths). */
  segments?: Array<{ videoPath: string; startMs: number; endMs?: number }>;
  /** Web sources (browser File objects). */
  webSources?: WebDubSource[];
  sourceLanguage?: string;
  /** Transcription engine + credentials (web transport). */
  provider?: "builtin" | "groq";
  groqKey?: string;
  groqModel?: string;
  signal?: AbortSignal;
}): Promise<DubTranscriptResult> {
  const api = hasElectronBridge() ? window.electronAPI : undefined;
  if (typeof api?.dubTranscribe === "function" && p.segments && p.segments.length > 0) {
    return api.dubTranscribe({
      segments: p.segments,
      sourceLanguage: p.sourceLanguage,
    });
  }

  const files = p.webSources ?? [];
  if (files.length === 0) {
    throw new Error("No local video clips on the timeline to transcribe");
  }
  const form = new FormData();
  for (const s of files) form.append("files", s.file, s.file.name || "clip.bin");
  form.append(
    "meta",
    JSON.stringify(
      files.map((s) => ({
        startMs: s.startMs,
        endMs: s.endMs ?? null,
      })),
    ),
  );
  if (p.provider === "groq") {
    form.append("provider", "groq");
    form.append("groqKey", p.groqKey ?? "");
    form.append("groqModel", p.groqModel ?? "");
    if (p.sourceLanguage) form.append("sourceLanguage", p.sourceLanguage);
  }
  const r = await postForm<TranscribeResponse>(
    "/api/dub/transcribe",
    form,
    p.signal,
  );
  return {
    language: r.language,
    totalMs: r.totalMs,
    wordCount: r.wordCount,
    utterances: r.utterances ?? [],
    /** v1.27: real per-word timestamps (Groq Whisper) vs estimates. */
    realWordTimings: r.realWordTimings === true,
  };
}

interface ScriptResponse extends ApiEnvelope {
  targetLanguage: string;
  targetLanguageName: string;
  speakerCount: number;
  lines: Array<{
    i: number;
    startMs: number;
    endMs: number;
    speaker: number;
    sourceText: string;
    translatedText: string;
  }>;
  warnings: string[];
  providerUsed?: string;
  modelUsed?: string;
}

/** Stage 2 — transcript → speaker detection + translation → script.
 *  Electron: Groq/Gemini via IPC (the provider+model from the Settings
 *  tab ride the payload; keys live in the main-process key files). Web:
 *  the selected provider via /api/dub/script (keys ride the request). */
export async function dubScript(p: {
  utterances: DubTranscriptResult["utterances"];
  sourceLanguage?: string;
  targetLanguage: string;
  targetLocale?: string;
  voiceMode?: "single" | "multi";
  /** Script-writing provider + model (Settings tab). */
  provider?: "groq" | "gemini";
  model?: string;
  groqKey?: string;
  geminiKey?: string;
  signal?: AbortSignal;
}): Promise<DubScriptResult> {
  const api = hasElectronBridge() ? window.electronAPI : undefined;
  if (typeof api?.dubScript === "function") {
    return api.dubScript({
      utterances: p.utterances,
      sourceLanguage: p.sourceLanguage,
      targetLanguage: p.targetLanguage,
      targetLocale: p.targetLocale ?? "",
      voiceMode: p.voiceMode,
      // v1.28: the Settings tab's provider + model ride the IPC payload —
      // before this they were dropped and the desktop always used its own
      // defaults. Keys are read from the main-process key files.
      textProvider: p.provider === "gemini" ? "gemini" : "groq",
      ...(p.provider !== "gemini" && p.model ? { groqModel: p.model } : {}),
      ...(p.provider === "gemini" && p.model ? { geminiModel: p.model } : {}),
    });
  }
  const r = await postJson<ScriptResponse>(
    "/api/dub/script",
    {
      utterances: p.utterances.map((u) => ({
        startMs: u.startMs,
        endMs: u.endMs,
        text: u.text,
      })),
      sourceLanguage: p.sourceLanguage,
      targetLanguage: p.targetLanguage,
      provider: p.provider ?? "groq",
      ...(p.model ? { model: p.model } : {}),
      ...(p.groqKey ? { groqKey: p.groqKey } : {}),
      ...(p.geminiKey ? { geminiKey: p.geminiKey } : {}),
    },
    p.signal,
  );
  return {
    targetLanguage: r.targetLanguage,
    targetLanguageName: r.targetLanguageName,
    speakerCount: r.speakerCount,
    lines: r.lines ?? [],
    warnings: r.warnings ?? [],
    /** v1.27: which provider actually ran (groq/gemini degrade to builtin
     *  without their key — the UI can show the truth). */
    providerUsed: r.providerUsed,
    modelUsed: r.modelUsed,
  };
}

interface DubSynthResponse extends ApiEnvelope {
  language: string;
  speakers: Array<{ id: number; voice: string; gender: string }>;
  segments: Array<{
    startMs: number;
    endMs: number;
    speaker: number;
    sourceText: string;
    translatedText: string;
    wavPath: string;
    ttsDurMs: number;
    speedApplied: number;
    format?: "wav" | "mp3";
    align?: { applied: boolean; reason?: string; maxDriftMs?: number; globalFactor?: number };
    bytes: string;
  }>;
  wavPaths: string[];
  totalDurationMs: number;
  warnings: string[];
  dubDir: string;
}

/** Stage 3/4 — synthesize the dub. Electron: dubStart IPC (bytes as
 *  ArrayBuffer on segments). Web: the Edge-TTS route (base64 → decoded).
 *  v1.27: `sourceWords` (the stage-1 transcript's word timings per line) +
 *  `wordTiming` enable the word-to-word timing match (WSOLA warp). */
export async function dubSynthesize(p: {
  scriptLines: Array<{
    speaker: number;
    sourceText: string;
    translatedText: string;
    startMs: number;
    endMs: number;
    /** The ORIGINAL utterance's word timings (absolute timeline ms) —
     *  matched line-by-line via the transcript index. */
    sourceWords?: Array<{ startMs: number; endMs: number }>;
  }>;
  scriptVoices?: Record<string, string>;
  scriptLanguage?: string;
  scriptSpeakerCount?: number;
  targetLanguage: string;
  targetLocale?: string;
  voiceMode?: "single" | "multi";
  singleVoice?: string | null;
  femaleVoice?: string;
  maleVoice?: string;
  /** v1.27: word-to-word timing (default true). */
  wordTiming?: boolean;
  signal?: AbortSignal;
}): Promise<DubTrackResult> {
  const api = hasElectronBridge() ? window.electronAPI : undefined;
  if (typeof api?.dubStart === "function") {
    return api.dubStart({
      scriptLines: p.scriptLines,
      scriptVoices: p.scriptVoices,
      scriptLanguage: p.scriptLanguage,
      scriptSpeakerCount: p.scriptSpeakerCount,
      targetLanguage: p.targetLanguage,
      targetLocale: p.targetLocale ?? "",
      voiceMode: p.voiceMode,
      singleVoice: p.singleVoice ?? null,
      femaleVoice: p.femaleVoice || undefined,
      maleVoice: p.maleVoice || undefined,
    });
  }
  const r = await postJson<DubSynthResponse>("/api/dub/synthesize", {
    language: p.scriptLanguage ?? p.targetLanguage,
    targetLocale: p.targetLocale ?? "",
    lines: p.scriptLines.map((l) => ({
      speaker: l.speaker,
      sourceText: l.sourceText,
      translatedText: l.translatedText,
      startMs: l.startMs,
      endMs: l.endMs,
      ...(l.sourceWords && l.sourceWords.length >= 2
        ? { sourceWords: l.sourceWords.map((w) => ({ startMs: w.startMs, endMs: w.endMs })) }
        : {}),
    })),
    voices: p.scriptVoices ?? {},
    singleVoice: p.singleVoice ?? null,
    femaleVoice: p.femaleVoice || undefined,
    maleVoice: p.maleVoice || undefined,
    wordTiming: p.wordTiming !== false,
  });
  const segments = (r.segments ?? []).map((s) => {
    const u8 = base64ToUint8(s.bytes);
    return {
      ...s,
      format: s.format ?? "mp3",
      align: s.align,
      bytes: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer,
    };
  });
  return {
    language: r.language,
    speakers: r.speakers ?? [],
    segments,
    wavPaths: r.wavPaths ?? [],
    totalDurationMs: r.totalDurationMs,
    warnings: r.warnings ?? [],
    dubDir: r.dubDir ?? "",
  };
}
