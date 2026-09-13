// src/lib/merger/whisper.ts — OpenAI Whisper-tiny ASR (v5.1 dual-engine).
//
// NATIVE PATH (Electron desktop — the default):
//   The v5.0 renderer Web Worker broke in the PACKAGED app — webpack's
//   worker chunk loader resolved chunk URLs relative to the worker script
//   location and duplicated the `_next/static/chunks` prefix
//   ("…app.asar/out/_next/static/chunks/_next/static/chunks/590caa2a….js"),
//   so importScripts failed and every transcription errored.
//   v5.1 moves ALL inference to the main process: audio is decoded with
//   ffmpeg (native, streamed) and Whisper runs in a utilityProcess with
//   onnxruntime-node (multi-threaded native CPU — several times faster than
//   the single-threaded WASM worker). The model downloads ONCE to
//   <userData>/whisper-models and stays on disk forever.
//
// BROWSER PATH (dev server fallback, unchanged from v5.0):
//   Pure in-browser transcription via the persistent Web Worker
//   (whisper-worker.ts) — this main thread decodes the audio to mono 16 kHz
//   PCM (AudioContext) and TRANSFERS it to the worker.
//
// Both paths return cues with REAL per-word timestamps (Whisper's
// cross-attention alignment, `return_timestamps: "word"`) so the viral
// "word-by-word" caption mode highlights the currently-spoken word exactly
// when it is spoken.
//
// Node-safety: this module is importable in Node/bun with no side effects —
// every bridge/worker is resolved lazily inside function calls.

import type { SubtitleCue, WordTimestamp } from "./subtitles";
import type {
  RawWhisperChunk,
  WhisperWorkerResponse,
} from "./whisper-worker";

// ---------------------------------------------------------------------------
// Public API (unchanged since v4 — page.tsx imports these exact signatures).
// ---------------------------------------------------------------------------

export interface WhisperProgress {
  /** 0-100 progress for the entire transcription run. */
  progress: number;
  /** Current status message ("Loading model…", "Transcribing…"). */
  status: string;
}

export interface WhisperOptions {
  /** Source audio file — any format the browser can decode. */
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
// Audio decoding (main thread only — AudioContext/OfflineAudioContext are
// not available inside workers).
// ---------------------------------------------------------------------------

/**
 * Decode an arbitrary audio File into mono 16 kHz Float32Array PCM
 * suitable for Whisper.
 */
async function decodeAudioToMono16k(
  file: File,
): Promise<{ data: Float32Array; sampleRate: number }> {
  const arrayBuf = await file.arrayBuffer();
  const AudioCtx =
    (typeof window !== "undefined" && (window as any).AudioContext) ||
    (typeof window !== "undefined" && (window as any).webkitAudioContext);
  if (!AudioCtx) throw new Error("NO_AUDIO_CONTEXT");

  const tmpCtx = new AudioCtx();
  const audioBuf = await tmpCtx.decodeAudioData(arrayBuf.slice(0));
  tmpCtx.close?.();

  const srcChannels = audioBuf.numberOfChannels;
  const srcRate = audioBuf.sampleRate;
  const srcLen = audioBuf.length;
  const targetRate = 16000;

  // Mix down to mono first.
  const mono = new Float32Array(srcLen);
  for (let ch = 0; ch < srcChannels; ch++) {
    const data = audioBuf.getChannelData(ch);
    for (let i = 0; i < srcLen; i++) mono[i] += data[i] / srcChannels;
  }

  // Resample to 16 kHz with an OfflineAudioContext.
  const offline = new OfflineAudioContext(
    1,
    Math.ceil(srcLen * (targetRate / srcRate)),
    targetRate,
  );
  const buffer = offline.createBuffer(1, srcLen, srcRate);
  buffer.copyToChannel(mono, 0);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start();

  const rendered = await offline.startRendering();
  return { data: rendered.getChannelData(0), sampleRate: targetRate };
}

// ---------------------------------------------------------------------------
// Word-level cue grouping — turns Whisper's per-word chunks into display
// cues that keep EXACT per-word timings. (Pure, exported for the harness.)
// ---------------------------------------------------------------------------

const MAX_WORDS_PER_CUE = 7;
const MAX_CUE_MS = 3500;
const WORD_GAP_BREAK_MS = 700;

export interface RawWord {
  text: string;
  startMs: number;
  endMs: number;
}

/** Group raw aligned words into cues (sentence-ish windows). */
export function groupWordsIntoCues(words: RawWord[]): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let current: RawWord[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const startMs = current[0].startMs;
    const endMs = current[current.length - 1].endMs;
    const text = current.map((w) => w.text).join(" ");
    cues.push({
      id: cues.length + 1,
      startMs,
      endMs: Math.max(endMs, startMs + 200),
      text,
      words: current.map((w) => ({
        text: w.text,
        startMs: w.startMs,
        endMs: w.endMs,
      })),
    });
    current = [];
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = current[current.length - 1];

    if (prev) {
      const gap = w.startMs - prev.endMs;
      const cueLen = w.endMs - current[0].startMs;
      const endsSentence = /[.!?…。！？]$/.test(prev.text);
      if (
        current.length >= MAX_WORDS_PER_CUE ||
        cueLen >= MAX_CUE_MS ||
        gap > WORD_GAP_BREAK_MS ||
        endsSentence
      ) {
        flush();
      }
    }
    current.push(w);
  }
  flush();

  cues.sort((a, b) => a.startMs - b.startMs);
  cues.forEach((c, i) => (c.id = i + 1));
  return cues;
}

// ---------------------------------------------------------------------------
// Raw-output parsing — converts the worker's raw Transformers.js output
// into SubtitleCue[]. (Pure, exported for the harness.)
// ---------------------------------------------------------------------------

/**
 * Parse the raw Whisper output (`{ chunks }` — the exact shape the worker
 * returns) into display cues.
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

// ---------------------------------------------------------------------------
// Progress curve mapping (pure, exported for the harness).
//
// Overall curve: decode 2 % → model download 10–25 % → transcribing 25–80 %
// → parsing 80–100 %. Worker "model" events carry the raw file-download
// percent; worker "transcribe" events already carry absolute 25–80 values.
// ---------------------------------------------------------------------------

/** Clamp a raw percentage into 0–100 (NaN → 0). */
export function clampPercent(progress: number): number {
  const p = Number.isFinite(progress) ? progress : 0;
  return Math.min(100, Math.max(0, Math.round(p)));
}

/** Map a worker progress event onto the overall transcribeWithWhisper curve.
 *  v5.2: "download" events (per-file, emitted alongside the paired "model"
 *  event with the same percent) share the model 10–25 % band so the bar
 *  never jitters — the file name rides along in the status message. */
export function mapWorkerProgress(
  stage: "model" | "download" | "transcribe",
  progress: number,
): number {
  const pct = clampPercent(progress);
  if (stage === "model" || stage === "download") {
    // Model download occupies the 10–25 % band.
    return Math.round(10 + 15 * (pct / 100));
  }
  // Transcription-stage events already carry absolute 25–80 % values.
  return Math.min(80, Math.max(25, pct));
}

// ---------------------------------------------------------------------------
// v5.1 NATIVE branch — Electron desktop: Whisper behind IPC.
// ---------------------------------------------------------------------------

/** v5.2 model-cache diagnostics (main-process whisper:status handler). */
export interface WhisperModelStatus {
  /** Absolute path of the persistent model cache folder. */
  cacheDir: string;
  /** Host that served the model files ("https://huggingface.co/" or the
   *  "https://hf-mirror.com/" mirror) — null before the first build. */
  hostUsed: string | null;
  /** Heuristic: ONNX encoder+decoder + config/tokenizer files present. */
  modelReady: boolean;
  /** Files currently in the cache (posix-relative names + sizes). */
  cacheFiles: Array<{ name: string; sizeBytes: number }>;
  /** Sum of all cached file sizes. */
  totalCacheBytes: number;
  /** Last error message recorded by the main process (null = healthy). */
  lastError: string | null;
  /** True when the whisper utilityProcess is alive. */
  childAlive: boolean;
  /** Number of transcription/preload runs currently in flight. */
  activeRuns: number;
}

/**
 * Local view of the whisper slice of the Electron bridge. The global Window
 * augmentation lives in types.ts (owned by the data-model layer) — the v5.2
 * additions (runId-targeted cancel, status) are declared here so this module
 * stays self-contained and backward-compatible with old preloads.
 */
interface NativeWhisperBridge {
  whisperTranscribe: (p: {
    name: string;
    bytes: ArrayBuffer;
    language?: string;
    /** v5.2 client run id — lets whisperCancel target THIS run only. */
    runId?: string;
  }) => Promise<{
    chunks: Array<{ text: string; timestamp: [number | null, number | null] }> | null;
    language: string | null;
    wordLevel: boolean;
    durationMs: number;
  }>;
  whisperPreload: () => Promise<{ ok: boolean }>;
  /** v5.2: no argument = cancel all (legacy); { runId } = cancel one. */
  whisperCancel: (p?: { runId: string }) => Promise<number>;
  /** Present since the v5.2 preload — optional so old builds still typecheck. */
  whisperStatus?: () => Promise<WhisperModelStatus>;
  onWhisperProgress: (cb: (d: {
    progress: number;
    status: string;
    /** v5.2 passthrough: "model" | "download" | "transcribe". */
    stage?: string;
    /** v5.2: the file being downloaded (stage "download" only). */
    file?: string;
  }) => void) => () => void;
}

/** The v5.1 Electron bridge (present only in the packaged/dev app with the
 *  whisper service wired). Also guards against OLD packaged builds: an app
 *  whose preload lacks whisperTranscribe falls through to the worker path. */
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

/** Transcribe via the main-process Whisper service (ffmpeg decode +
 *  utilityProcess inference). The parse/grouping still happens HERE — the
 *  service returns the RAW chunks (same shape as the web worker). */
async function transcribeWithWhisperNative(
  opts: WhisperOptions,
): Promise<WhisperResult> {
  const { audioFile, onProgress, signal } = opts;
  const api = nativeWhisperBridge();
  if (!api) throw new Error("Native Whisper bridge unavailable");

  onProgress?.({ progress: 2, status: "Decoding audio…" });
  if (signal?.aborted) throw new Error("Transcription cancelled");

  let bytes: ArrayBuffer;
  try {
    bytes = await audioFile.arrayBuffer();
  } catch (err) {
    throw new Error(
      `Could not read audio: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // v5.2: a client run id lets the cancel below target THIS run only —
  // other queued runs (e.g. a parallel pre-download) are unaffected.
  const runId = newClientRunId();

  // Progress events already carry the mapped overall curve (decode 2 →
  // model/download 10–25 → transcribe 25–80) — relay them verbatim
  // (clamped). The v5.2 stage/file passthrough is consumed by
  // preloadWhisper for the standalone pre-download UI.
  const unsubscribe = api.onWhisperProgress((d) => {
    if (d && typeof d.progress === "number") {
      onProgress?.({ progress: clampPercent(d.progress), status: d.status || "" });
    }
  });

  // v5.2 snappy cancel: the signal rejects the await IMMEDIATELY (no
  // "Working…" zombie while a hung download eventually resolves), and the
  // main process cancels exactly this runId. The in-flight IPC promise is
  // raced — its late result is simply discarded.
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
      bytes,
      language: opts.language || "auto",
      runId,
    });
    // Classified/native error messages propagate VERBATIM — page.tsx shows
    // them in the failure toast, so users see the actionable text from
    // whisper-core's error classification, not a generic wrapper.
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
// Persistent worker singleton + run bookkeeping (browser fallback path).
// ---------------------------------------------------------------------------

interface WorkerTranscription {
  chunks: RawWhisperChunk[] | null;
  language: string | null;
  wordLevel: boolean;
}

interface PendingRun {
  mode: "transcribe" | "preload";
  resolve: (result: WorkerTranscription) => void;
  reject: (error: Error) => void;
  onProgress?: (p: WhisperProgress) => void;
}

/** One persistent worker for the whole app lifetime (created lazily). */
let workerInstance: Worker | null = null;

const pendingRuns = new Map<number, PendingRun>();
let runCounter = 0;

function getWorker(): Worker {
  if (typeof window === "undefined") {
    throw new Error("Whisper is only available in the browser");
  }
  if (typeof Worker === "undefined") {
    throw new Error("Web Workers are not available in this environment");
  }
  if (workerInstance) return workerInstance;
  try {
    // webpack 5 (next build --webpack) and the Next 16 dev server both
    // compile this exact pattern into a separately-loadable worker chunk.
    workerInstance = new Worker(
      new URL("./whisper-worker.ts", import.meta.url),
      { type: "module" },
    );
  } catch (err) {
    throw new Error(
      `Could not start the Whisper worker: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  workerInstance.addEventListener("message", onWorkerMessage);
  workerInstance.addEventListener("error", onWorkerError);
  workerInstance.addEventListener("messageerror", onWorkerMessageError);
  return workerInstance;
}

function failAllPending(message: string): void {
  for (const [runId, run] of pendingRuns) {
    pendingRuns.delete(runId);
    run.reject(new Error(message));
  }
}

function disposeWorker(): void {
  if (!workerInstance) return;
  workerInstance.removeEventListener("message", onWorkerMessage);
  workerInstance.removeEventListener("error", onWorkerError);
  workerInstance.removeEventListener("messageerror", onWorkerMessageError);
  workerInstance.terminate();
  workerInstance = null;
}

function onWorkerMessage(event: MessageEvent): void {
  const data = event.data as WhisperWorkerResponse | null | undefined;
  if (!data || typeof data !== "object" || typeof data.type !== "string") {
    return; // unknown message — ignore
  }
  if (typeof data.runId !== "number") return;
  const run = pendingRuns.get(data.runId);
  if (!run) return; // stale (aborted or already settled) — discard

  switch (data.type) {
    case "progress": {
      const progress =
        run.mode === "transcribe"
          ? mapWorkerProgress(data.stage, data.progress)
          : clampPercent(data.progress);
      run.onProgress?.({ progress, status: data.status });
      break;
    }
    case "result":
      pendingRuns.delete(data.runId);
      run.resolve({
        chunks: data.chunks ?? null,
        language: data.language ?? null,
        wordLevel: !!data.wordLevel,
      });
      break;
    case "error":
      pendingRuns.delete(data.runId);
      run.reject(new Error(data.message || "Whisper worker failed"));
      break;
    default:
      break; // unknown type — ignore (forward compatible)
  }
}

/**
 * The worker itself failed to load or crashed with an uncaught error: no
 * result will ever arrive for pending runs, so reject them all (the UI must
 * never hang) and drop the dead worker so the next call spawns a fresh one
 * (the model itself is re-read from the persistent cache, not re-downloaded).
 */
function onWorkerError(): void {
  failAllPending("Whisper worker crashed or failed to load");
  disposeWorker();
}

/** Structured-clone failure: the protocol only sends plain objects — if
 * deserialization ever breaks, fail fast instead of hanging forever. */
function onWorkerMessageError(): void {
  failAllPending("Whisper worker sent an unreadable message");
}

// ---------------------------------------------------------------------------
// Public functions.
// ---------------------------------------------------------------------------

/**
 * Transcribe the given audio file with Whisper-tiny and return cues
 * with per-word timestamps.
 *
 * v5.0: the audio is decoded here (main thread) and the PCM is TRANSFERRED
 * to the persistent Whisper Web Worker, which runs all inference off the UI
 * thread (chunk_length_s 30 / stride_length_s 5, word-level timestamps via
 * `return_timestamps: "word"` with a chunk-level fallback — identical
 * pipeline options to v4). Raw output chunks come back and are parsed into
 * display cues (max ~7 words / sentence punctuation / natural pauses) while
 * preserving exact per-word timing.
 *
 * Aborting rejects immediately and marks the run stale (late worker results
 * are discarded); the worker is NOT terminated so the model stays warm.
 */
export async function transcribeWithWhisper(
  opts: WhisperOptions,
): Promise<WhisperResult> {
  const { audioFile, onProgress, signal } = opts;

  // v5.1: the desktop app ALWAYS takes the native service path (ffmpeg
  // decode + utilityProcess inference) — no renderer worker exists there.
  if (nativeWhisperBridge()) {
    return transcribeWithWhisperNative(opts);
  }

  if (typeof window === "undefined") {
    throw new Error("Whisper transcription is only available in the browser");
  }

  onProgress?.({ progress: 2, status: "Decoding audio…" });
  if (signal?.aborted) throw new Error("Transcription cancelled");

  let pcm: Float32Array;
  let sampleRate = 16000;
  try {
    const decoded = await decodeAudioToMono16k(audioFile);
    pcm = decoded.data;
    sampleRate = decoded.sampleRate;
  } catch (err) {
    throw new Error(
      `Could not decode audio: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (pcm.length === 0) throw new Error("Audio file is empty or silent");

  // Computed BEFORE the transfer — the transfer neuters this buffer.
  const pcmDurationMs = Math.round((pcm.length / sampleRate) * 1000);

  onProgress?.({ progress: 10, status: "Loading Whisper-tiny model…" });
  if (signal?.aborted) throw new Error("Transcription cancelled");

  const worker = getWorker();
  const runId = ++runCounter;
  const lang = opts.language || "auto";

  const onAbort = () => {
    const run = pendingRuns.get(runId);
    if (!run) return;
    pendingRuns.delete(runId);
    // Best-effort: lets the worker skip this run if it has not started yet.
    // A run already mid-inference finishes in the background and its result
    // is discarded here (stale runId). The worker is NOT terminated.
    try {
      worker.postMessage({ type: "cancel", runId });
    } catch {
      // Worker already gone — nothing to cancel.
    }
    run.reject(new Error("Transcription cancelled"));
  };

  try {
    const raw = await new Promise<WorkerTranscription>((resolve, reject) => {
      pendingRuns.set(runId, { resolve, reject, onProgress, mode: "transcribe" });
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        // Zero-copy: transfer the PCM buffer to the worker.
        worker.postMessage(
          { type: "transcribe", runId, pcm, sampleRate, language: lang },
          [pcm.buffer],
        );
      } catch (err) {
        pendingRuns.delete(runId);
        reject(
          new Error(
            `Could not send audio to the Whisper worker: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      }
    });

    if (signal?.aborted) throw new Error("Transcription cancelled");

    onProgress?.({ progress: 80, status: "Aligning word timestamps…" });

    const cues = parseWhisperOutput(
      { chunks: raw.chunks ?? [] },
      raw.wordLevel,
    );
    const detectedLang = raw.language;

    onProgress?.({ progress: 100, status: "Done" });

    return {
      cues,
      language: detectedLang,
      durationMs: cues.length ? cues[cues.length - 1].endMs : pcmDurationMs,
      wordLevel: raw.wordLevel,
    };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    pendingRuns.delete(runId);
  }
}

/**
 * Pre-load the Whisper-tiny model into the persistent worker. Call this on
 * app idle to avoid the model-download latency on the first "Generate" click.
 * The model is stored in the browser's persistent cache — download once,
 * reuse forever.
 */
export async function preloadWhisper(
  onProgress?: (p: WhisperProgress) => void,
): Promise<void> {
  // v5.1 native path: warm the service + disk model cache.
  const api = nativeWhisperBridge();
  if (api) {
    onProgress?.({ progress: 0, status: "Loading Whisper-tiny model…" });
    const unsubscribe = api.onWhisperProgress((d) => {
      if (d && typeof d.progress === "number") {
        // Standalone pre-download: the main process maps model/download
        // events onto the 10–25 % band of the TRANSCRIPTION curve — rescale
        // onto 0–100 so the pre-download button's own bar reflects the
        // download itself.
        const p = clampPercent(d.progress);
        const scaled =
          d.stage === "model" || d.stage === "download"
            ? clampPercent(((p - 10) / 15) * 100)
            : p;
        onProgress?.({ progress: scaled, status: d.status || "" });
      }
    });
    try {
      await api.whisperPreload();
      onProgress?.({ progress: 100, status: "Ready" });
    } finally {
      unsubscribe?.();
    }
    return;
  }

  onProgress?.({ progress: 0, status: "Loading Whisper-tiny model…" });
  const worker = getWorker(); // throws a clear error outside the browser
  const runId = ++runCounter;

  try {
    await new Promise<void>((resolve, reject) => {
      pendingRuns.set(runId, {
        mode: "preload",
        resolve: () => resolve(),
        reject,
        onProgress,
      });
      try {
        worker.postMessage({ type: "preload", runId });
      } catch (err) {
        pendingRuns.delete(runId);
        reject(
          new Error(
            `Could not reach the Whisper worker: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
      }
    });
    onProgress?.({ progress: 100, status: "Ready" });
  } finally {
    pendingRuns.delete(runId);
  }
}

/** True if Whisper transcription is available in this environment. */
export function isWhisperAvailable(): boolean {
  if (nativeWhisperBridge()) return true;
  return (
    typeof window !== "undefined" &&
    !!(window as any).AudioContext &&
    typeof OfflineAudioContext !== "undefined" &&
    typeof Worker !== "undefined"
  );
}
