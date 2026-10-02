// src/lib/merger/whisper.ts — Groq Whisper transcription (Electron desktop).
//
// v1.20 — GROQ CLOUD ONLY:
//   ALL local transcription engines are REMOVED (the onnxruntime
//   utilityProcess service, the faster-whisper Python sidecar, and the
//   browser web worker with @xenova/transformers). Transcription runs in
//   the FrameFuse desktop app's MAIN process via the whisper:transcribe
//   IPC, which calls the Groq Whisper API (electron/groq-whisper.js) with
//   the user's own on-device key. No key saved → a clear actionable error;
//   API failure → the real error message. There is NO fallback chain.
//
// ELECTRON PATH (the only path):
//   transcribeWithWhisper ships the audio (bytes, or a zero-copy on-disk
//   sourcePath) to the main process and relays the Groq run's progress
//   events. The RAW chunks come back over IPC and are parsed HERE into
//   cues with REAL per-word timestamps so the word-by-word caption modes
//   highlight the currently-spoken word exactly when it is spoken.
//
// BROWSER (non-Electron) MODE:
//   Throws — transcription requires the desktop app + a Groq API key.
//
// Node-safety: this module is importable in Node/bun with no side effects —
// every bridge is resolved lazily inside function calls.

import {
  groupWordsIntoCues,
  type RawWord,
  type SubtitleCue,
  type WordTimestamp,
} from "./subtitles";

// v1.7: word grouping moved to ./subtitles (shared with the SRT import
// path); re-exported here so the historical public surface is unchanged.
export { groupWordsIntoCues } from "./subtitles";
export type { RawWord } from "./subtitles";
// v1.15: app-level STT routing (Groq model preference — groq is the only
// engine since v1.20).
import { sttRouting } from "./sttSettings";

/**
 * One raw chunk of Whisper output — the exact `{ chunks }` shape the Groq
 * transcription result returns (previously imported from whisper-worker.ts,
 * which no longer exists).
 */
export interface RawWhisperChunk {
  text: string;
  /** [start, end] in seconds — either may be null (unknown). */
  timestamp: [number | null, number | null];
}

// ---------------------------------------------------------------------------
// Public API (unchanged since v4 — page.tsx imports these exact signatures).
// ---------------------------------------------------------------------------

export interface WhisperProgress {
  /** 0-100 progress for the entire transcription run. */
  progress: number;
  /** Current status message ("Preparing audio…", "Transcribing…"). */
  status: string;
}

export interface WhisperOptions {
  /** Source audio file — any format ffmpeg can decode. */
  audioFile: File;
  /** Optional progress callback. */
  onProgress?: (p: WhisperProgress) => void;
  /** Optional abort signal. */
  signal?: AbortSignal;
  /**
   * Language code for transcription: "auto" (auto-detect), a 2-letter
   * ISO code ("en"), or a full name ("english"). Default "auto".
   */
  language?: string;
  /** v1.3 ZERO-COPY: absolute on-disk path of the source (Electron app,
   *  local file). When set, the native path is shipped to the main process
   *  instead of the whole file's bytes over IPC. */
  sourcePath?: string | null;
}

export interface WhisperResult {
  /** Cues with word-level timestamps (sorted, re-indexed 1..N). */
  cues: SubtitleCue[];
  /** Detected language code (e.g. "en") — null if unknown. */
  language: string | null;
  /** Total transcribed duration in ms. */
  durationMs: number;
  /** True when REAL word-level alignment was produced. */
  wordLevel: boolean;
}

// ---------------------------------------------------------------------------
// Raw-output parsing — converts the Groq run's raw `{ chunks }` output
// into SubtitleCue[]. (Pure, exported for the harness.)
// ---------------------------------------------------------------------------

/**
 * Parse the raw Whisper output (`{ chunks }` — the exact shape the Groq
 * bridge returns) into display cues.
 *
 * wordLevel=true  → each chunk is (usually) one word with exact timing;
 *                   multiple tokens inside one chunk (CJK / compact scripts)
 *                   are distributed across the chunk window. (v4.1 behavior.)
 * wordLevel=false → chunk-level timestamps with even word distribution.
 *                   (v4 fallback behavior.)
 */
export function parseWhisperOutput(
  output: { chunks?: RawWhisperChunk[] } | null | undefined,
  wordLevel: boolean,
): SubtitleCue[] {
  const rawChunks = output?.chunks;
  const chunks: RawWhisperChunk[] = Array.isArray(rawChunks)
    ? rawChunks
    : [];

  if (wordLevel && chunks.length > 0) {
    // Word mode: each chunk is (usually) one word with exact timing.
    const rawWords: RawWord[] = [];
    let lastEnd = 0;
    for (const chunk of chunks) {
      const text = (chunk.text || "").trim();
      if (!text) continue;
      const [s, e] = chunk.timestamp;
      const startMs = s != null ? Math.round(s * 1000) : lastEnd;
      let endMs =
        e != null ? Math.round(e * 1000) : startMs + Math.max(200, text.length * 90);
      if (endMs <= startMs) endMs = startMs + 200;
      lastEnd = endMs;
      // A chunk may contain multiple tokens for CJK / compact scripts.
      const tokens = text.split(/\s+/).filter(Boolean);
      if (tokens.length <= 1) {
        rawWords.push({ text, startMs, endMs });
      } else {
        // Distribute the chunk window across its tokens.
        const dur = endMs - startMs;
        const per = dur / tokens.length;
        tokens.forEach((t, i) => {
          rawWords.push({
            text: t,
            startMs: startMs + Math.round(per * i),
            endMs: startMs + Math.round(per * (i + 1)),
          });
        });
      }
    }
    return groupWordsIntoCues(rawWords);
  }

  // Fallback: chunk-level timestamps + even word distribution (v4).
  const cues: SubtitleCue[] = [];
  let cueId = 1;
  for (const chunk of chunks) {
    if (!chunk.timestamp) continue;
    const [startSec, endSec] = chunk.timestamp;
    if (startSec == null || endSec == null) continue;
    if (endSec <= startSec) continue;

    const startMs = Math.round(startSec * 1000);
    const endMs = Math.round(endSec * 1000);
    const text = (chunk.text || "").trim();
    if (!text) continue;

    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;

    const dur = endMs - startMs;
    const per = dur / tokens.length;
    const words: WordTimestamp[] = tokens.map((text, i) => ({
      text,
      startMs: startMs + Math.round(per * i),
      endMs: startMs + Math.round(per * (i + 1)),
    }));

    cues.push({ id: cueId++, startMs, endMs, text, words });
  }
  cues.sort((a, b) => a.startMs - b.startMs);
  cues.forEach((c, i) => (c.id = i + 1));
  return cues;
}

/** Clamp a raw percentage into 0–100 (NaN → 0). */
export function clampPercent(progress: number): number {
  const p = Number.isFinite(progress) ? progress : 0;
  return Math.min(100, Math.max(0, Math.round(p)));
}

// ---------------------------------------------------------------------------
// Electron IPC branch — the Groq Whisper API behind the bridge.
// ---------------------------------------------------------------------------

/**
 * Local view of the whisper slice of the Electron bridge. The global Window
 * augmentation lives in types.ts (owned by the data-model layer); the v5.2
 * additions (runId-targeted cancel) are declared here so this module stays
 * self-contained and backward-compatible with old preloads.
 */
interface NativeWhisperBridge {
  whisperTranscribe: (p: {
    name: string;
    bytes?: ArrayBuffer;
    /** v1.3 ZERO-COPY: original on-disk path (Electron, local file) — skips
     *  the renderer→main byte upload entirely. */
    sourcePath?: string;
    language?: string;
    /** v1.20: always "groq" — the only engine. */
    engine?: "groq";
    /** Groq model id (whisper-large-v3-turbo | whisper-large-v3). */
    groqModel?: string;
    /** v5.2 client run id — lets whisperCancel target THIS run only. */
    runId?: string;
  }) => Promise<{
    chunks: Array<{ text: string; timestamp: [number | null, number | null] }> | null;
    language: string | null;
    wordLevel: boolean;
    durationMs: number;
    engine?: string;
  }>;
  /** v5.2: no argument = cancel all (legacy); { runId } = cancel one. */
  whisperCancel: (p?: { runId: string }) => Promise<number>;
  onWhisperProgress: (cb: (d: {
    progress: number;
    status: string;
    /** v5.2 passthrough: "model" | "download" | "transcribe". */
    stage?: string;
    /** v5.2: the file being downloaded (stage "download" only). */
    file?: string;
  }) => void) => () => void;
}

/** The Electron bridge (present only in the desktop app). */
function nativeWhisperBridge(): NativeWhisperBridge | null {
  if (typeof window === "undefined") return null;
  const api = window.electronAPI;
  return api && typeof api.whisperTranscribe === "function"
    ? (api as unknown as NativeWhisperBridge)
    : null;
}

/** Client run ids (v5.2) — prefer crypto.randomUUID, fall back to a
 *  time+counter id for exotic contexts. */
let clientRunSeq = 0;
function newClientRunId(): string {
  const uuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : null;
  if (uuid) return uuid;
  clientRunSeq += 1;
  return `run-${Date.now().toString(36)}-${clientRunSeq}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/** Transcribe via the main-process Groq engine. The parse/grouping still
 *  happens HERE — the main process returns the RAW chunks. */
async function transcribeWithWhisperNative(
  opts: WhisperOptions,
): Promise<WhisperResult> {
  const { audioFile, onProgress, signal } = opts;
  const api = nativeWhisperBridge();
  if (!api) throw new Error("Native Whisper bridge unavailable");

  onProgress?.({ progress: 2, status: "Decoding audio…" });
  if (signal?.aborted) throw new Error("Transcription cancelled");

  // v1.3 ZERO-COPY: a local on-disk source ships its PATH — the whole-file
  // byte upload over IPC is skipped (multi-GB videos used to spend minutes
  // just crossing the bridge before decoding even started).
  const sourcePath =
    typeof opts.sourcePath === "string" && opts.sourcePath ? opts.sourcePath : null;
  let bytes: ArrayBuffer | undefined;
  if (!sourcePath) {
    try {
      bytes = await audioFile.arrayBuffer();
    } catch (err) {
      throw new Error(
        `Could not read audio: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // v5.2: a client run id lets the cancel below target THIS run only —
  // other queued runs are unaffected.
  const runId = newClientRunId();

  // Progress events already carry the mapped overall curve (prep 2–12 →
  // transcribe → align 80) — relay them verbatim (clamped).
  const unsubscribe = api.onWhisperProgress((d) => {
    if (d && typeof d.progress === "number") {
      onProgress?.({ progress: clampPercent(d.progress), status: d.status || "" });
    }
  });

  // v5.2 snappy cancel: the signal rejects the await IMMEDIATELY (no
  // "Working…" zombie while a hung upload eventually resolves), and the
  // main process cancels exactly this runId (aborting the in-flight Groq
  // HTTPS request). The in-flight IPC promise is raced — its late result
  // is simply discarded.
  let rejectOnAbort: ((err: Error) => void) | null = null;
  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        rejectOnAbort = reject;
      })
    : null;
  const onAbort = () => {
    api.whisperCancel({ runId }).catch(() => {});
    rejectOnAbort?.(new Error("Transcription cancelled"));
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const invoke = api.whisperTranscribe({
      name: audioFile.name || "audio",
      ...(bytes ? { bytes } : {}),
      ...(sourcePath ? { sourcePath } : {}),
      language: opts.language || "auto",
      runId,
      // v1.15/v1.20: engine routing — always "groq" (the only engine); the
      // Groq model comes from the app-level preference / saved config.
      ...sttRouting(),
    });
    // Error messages propagate VERBATIM — page.tsx shows them in the
    // failure toast, so users see the actionable text from the Groq
    // engine (missing key, invalid key, rate limit, file too large…).
    const raw = abortPromise
      ? await Promise.race([invoke, abortPromise])
      : await invoke;
    if (signal?.aborted) throw new Error("Transcription cancelled");

    onProgress?.({ progress: 80, status: "Aligning word timestamps…" });

    const rawChunks: RawWhisperChunk[] = Array.isArray(raw?.chunks)
      ? raw.chunks
      : [];
    const cues = parseWhisperOutput({ chunks: rawChunks }, !!raw?.wordLevel);

    onProgress?.({ progress: 100, status: "Done" });

    const durationMs =
      typeof raw?.durationMs === "number" && raw.durationMs > 0
        ? raw.durationMs
        : cues.length
          ? cues[cues.length - 1].endMs
          : 0;

    return {
      cues,
      language: raw?.language ?? null,
      durationMs,
      wordLevel: !!raw?.wordLevel,
    };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    unsubscribe?.();
  }
}

// ---------------------------------------------------------------------------
// Public functions.
// ---------------------------------------------------------------------------

/**
 * Transcribe the given audio file with the Groq Whisper API (the ONLY
 * engine since v1.20) and return cues with per-word timestamps.
 *
 * Runs entirely in the desktop app's main process (ffmpeg audio extraction
 * + the Groq HTTPS call); progress streams back over the bridge. In the
 * browser (non-Electron) this throws — transcription needs the desktop app.
 */
export async function transcribeWithWhisper(
  opts: WhisperOptions,
): Promise<WhisperResult> {
  if (!nativeWhisperBridge()) {
    throw new Error(
      "Transcription runs in the FrameFuse desktop app with a Groq API key.",
    );
  }
  return transcribeWithWhisperNative(opts);
}

/** True if Whisper transcription is available in this environment (the
 *  Electron bridge exists — Groq runs main-side). */
export function isWhisperAvailable(): boolean {
  return !!nativeWhisperBridge();
}
