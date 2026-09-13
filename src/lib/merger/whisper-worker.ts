// src/lib/merger/whisper-worker.ts — Whisper ASR inference Web Worker.
//
// Spawned (once, for the whole app lifetime) by whisper.ts via:
//   new Worker(new URL("./whisper-worker.ts", import.meta.url), { type: "module" })
// webpack 5 (next build --webpack) and the Next 16 dev server both compile
// this pattern into a separately-loadable chunk, so the heavy Transformers.js
// pipeline code (~75 MB of model code + onnxruntime-web) is never part of the
// MAIN-thread bundle — the UI never blocks during caption generation.
//
// Responsibilities:
//  - Own the Xenova/whisper-tiny `automatic-speech-recognition` pipeline and
//    run ALL WASM inference inside this worker.
//  - Download the model once and reuse it forever: `env.useBrowserCache`
//    stores model files in the browser's persistent Cache API storage, which
//    survives app restarts. Internet is only needed for the very FIRST
//    transcription (same behavior as the previous main-thread implementation,
//    whose Cache API entries this worker re-uses directly).
//  - Resolve the SAME ONNX WASM runtime the main thread used before (see
//    configureWasm() below for the exact decision).
//
// Message protocol (exact):
//   main → worker:
//     { type: "preload",    runId: number }
//     { type: "transcribe", runId: number, pcm: Float32Array, sampleRate: number, language: string }
//       — pcm's underlying ArrayBuffer is TRANSFERRED (zero copy).
//     { type: "cancel",     runId: number }
//       — best-effort: lets the worker skip queued-but-unstarted runs after an
//         abort. A run already mid-inference cannot be interrupted (the
//         Transformers.js pipeline has no cancellation API) — its result is
//         simply discarded by the main thread.
//   worker → main:
//     { type: "progress", runId, stage: "model" | "download" | "transcribe",
//       progress: number, status: string, file?: string }
//       — stage "model": raw file-download percent (0–100) from the
//         Transformers.js progress_callback, plus v5.2 host-attempt labels
//         ("Downloading Whisper model…" / "Retrying via mirror …"). The main
//         thread maps this into the 10–25 % band (see mapWorkerProgress in
//         whisper.ts).
//       — stage "download" (v5.2): richer per-file events emitted IN
//         ADDITION to the paired "model" event — carry `file` so the UI can
//         show WHICH file is downloading and how far along it is.
//       — stage "transcribe": absolute values on the 25–80 % band (25 when
//         inference starts, 40 when word-alignment falls back to chunk mode).
//     { type: "result", runId, chunks: RawWhisperChunk[] | null, language: string | null, wordLevel: boolean }
//       — success. For "preload" runs: chunks/language are null, wordLevel is
//         false. For "transcribe" runs: `chunks` is the RAW Transformers.js
//         output (unchanged shape); the main thread parses it into cues.
//     { type: "error", runId, message: string }
//
// Resilience: unknown message types are ignored; every handler is wrapped in
// try/catch and reports failures as { type: "error", runId, message }; work is
// serialized through a promise queue so nothing ever throws synchronously out
// of the message listener. This module is also deliberately importable from
// Node/bun (the top level imports nothing and attaches nothing unless running
// inside a real worker) so the pure helpers exported here can be unit-tested
// by /home/z/harness/whisper-harness.js.

// ---------------------------------------------------------------------------
// Protocol types (single source of truth — whisper.ts imports these
// type-only, so there is no runtime coupling between the two modules).
// ---------------------------------------------------------------------------

/** One raw chunk of Whisper output — the transformers.js `chunks` shape. */
export interface RawWhisperChunk {
  text: string;
  /** [start, end] in seconds — either may be null (unknown). */
  timestamp: [number | null, number | null];
}

/** Progress stages the worker reports to the main thread. */
export type WhisperWorkerStage = "model" | "download" | "transcribe";

/** Messages the MAIN thread sends to the worker. */
export type WhisperWorkerRequest =
  | { type: "preload"; runId: number }
  | {
      type: "transcribe";
      runId: number;
      /** Mono 16 kHz PCM — the ArrayBuffer is transferred, not copied. */
      pcm: Float32Array;
      sampleRate: number;
      /** "auto" or a language code/name. */
      language: string;
    }
  | { type: "cancel"; runId: number };

/** Messages the worker posts back to the main thread. */
export type WhisperWorkerResponse =
  | {
      type: "progress";
      runId: number;
      stage: WhisperWorkerStage;
      /** 0–100: file-download % for "model"/"download", absolute 25–80 for "transcribe". */
      progress: number;
      status: string;
      /** v5.2: the file being downloaded (stage "download" events only). */
      file?: string;
    }
  | {
      type: "result";
      runId: number;
      chunks: RawWhisperChunk[] | null;
      language: string | null;
      wordLevel: boolean;
    }
  | { type: "error"; runId: number; message: string };

// ---------------------------------------------------------------------------
// Pure helpers (exported for the bun harness — no DOM/worker APIs needed).
// ---------------------------------------------------------------------------

/**
 * Convert a Transformers.js `progress_callback` info object into a
 * user-facing { progress, status } pair, or null when the status should be
 * ignored (e.g. "ready"). Mirrors the previous main-thread relay logic
 * exactly: initiate → "Preparing …", progress → "Downloading …",
 * done → "Loaded …".
 */
export function toModelProgress(
  info: unknown,
): { progress: number; status: string } | null {
  if (!info || typeof info !== "object") return null;
  const i = info as { status?: unknown; file?: unknown; progress?: unknown };
  const file = typeof i.file === "string" && i.file ? i.file : "model";
  switch (i.status) {
    case "progress":
      return {
        progress: Math.round(typeof i.progress === "number" ? i.progress : 0),
        status: `Downloading ${file}…`,
      };
    case "done":
      return { progress: 100, status: `Loaded ${file}` };
    case "initiate":
      return { progress: 0, status: `Preparing ${file}…` };
    default:
      return null;
  }
}

/**
 * Build the Whisper pipeline call options — IDENTICAL to the options the
 * previous main-thread implementation passed (chunk 30 s, stride 5 s, no
 * previous-text conditioning to avoid the Whisper repetition loop; language
 * key only when not "auto"). `return_timestamps` is added by the caller:
 * "word" first (DTW cross-attention alignment), `true` as the fallback.
 */
export function buildPipeOptions(language: string): Record<string, unknown> {
  const options: Record<string, unknown> = {
    chunk_length_s: 30,
    stride_length_s: 5,
    task: "transcribe",
    // Disables conditioning on previous text — prevents the classic Whisper
    // repetition loop on long/degraded audio.
    condition_on_previous_text: false,
  };
  if (language && language !== "auto") options.language = language;
  return options;
}

// ---------------------------------------------------------------------------
// Worker plumbing (structurally typed — no `lib: webworker` needed; the DOM
// lib types `self`, and inside a dedicated worker these calls target the
// worker scope. In Node/bun the guard leaves everything inert.)
// ---------------------------------------------------------------------------

interface WorkerSelf {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  location: { href: string; protocol: string };
}

/**
 * The dedicated-worker global scope, or null when not running inside a real
 * worker (Node/bun main thread). Bun aliases `self` to globalThis and even
 * defines `self.postMessage` there, so the constructor-name check is what
 * keeps this module inert outside a worker — attaching a "message" listener
 * to bun's main-thread `self` would pin its event loop forever. In a real
 * dedicated worker (Chromium/Electron/Firefox/Safari, classic or module),
 * `self.constructor.name` is "DedicatedWorkerGlobalScope".
 */
const workerSelf: WorkerSelf | null = (() => {
  if (typeof self === "undefined") return null;
  const scope = self as unknown as WorkerSelf;
  if (typeof scope.postMessage !== "function") return null;
  const ctorName =
    (self as unknown as { constructor?: { name?: string } })?.constructor
      ?.name ?? "";
  if (!/DedicatedWorkerGlobalScope/.test(ctorName)) return null;
  return scope;
})();

const MODEL_ID = "Xenova/whisper-tiny";

// v5.2 mirror + retry (same strategy as the native whisper-core.js): try the
// official HuggingFace Hub, then the hf-mirror.com mirror (identical repo
// layout), then the official host once more. Completed files persist in the
// browser cache, so each attempt CONTINUES where the previous stopped.
const DEFAULT_REMOTE_HOST = "https://huggingface.co/";
const MIRROR_REMOTE_HOST = "https://hf-mirror.com/";
const PIPELINE_HOSTS: readonly string[] = [
  DEFAULT_REMOTE_HOST,
  MIRROR_REMOTE_HOST,
  DEFAULT_REMOTE_HOST,
];

/** v5.2: map a pipeline-build failure onto a friendly message, or null to
 *  surface the raw error verbatim. Mirrors whisper-core.js — the underlying
 *  message always rides along as a bracketed suffix. */
export function classifyWhisperError(err: unknown): string | null {
  const raw = err instanceof Error ? err.message : String(err);
  const m = raw.toLowerCase();
  if (
    /fetch failed|failed to fetch|enotfound|etimedout|timeout|timed out|econnrefused|econnreset|econnaborted|eai_again|getaddrinfo|socket hang up|network|tls|certificate|self-signed|hostname\/ip|und_err_|other side closed|terminated/.test(
      m,
    )
  ) {
    return `Could not download the Whisper model. Check your internet connection or firewall (the model is fetched once from huggingface.co, ~42 MB, with an automatic mirror retry). [${raw}]`;
  }
  if (/rate limit|error \(429\)/.test(m)) {
    return `HuggingFace is rate-limiting downloads right now. Wait a minute and try again — the app also retries automatically via the hf-mirror.com mirror. [${raw}]`;
  }
  if (/file does not exist|could not locate file/.test(m)) {
    return `A Whisper model file was not found on the server — the Xenova/whisper-tiny repository may have changed. [${raw}]`;
  }
  if (
    /internal server error|bad gateway|service unavailable|gateway timeout|error \(5\d\d\)/.test(
      m,
    )
  ) {
    return `The model server reported an error. This is usually temporary — try again; already-downloaded files are kept, so a retry continues where it stopped. [${raw}]`;
  }
  if (/permission denied|unauthorized access|forbidden access/.test(m)) {
    return `Access to the model file was denied by the server. [${raw}]`;
  }
  return null;
}

/** Singleton pipeline promise (module scope — the model is built ONCE). */
let pipelinePromise: Promise<any> | null = null;

/** runId whose pipeline-build progress should be relayed right now. */
let progressRunId: number | null = null;

/** runIds cancelled by the main thread before their work finished. */
const cancelledRuns = new Set<number>();

/** Serializes work: one preload/transcribe at a time on this worker thread. */
let queue: Promise<void> = Promise.resolve();

function post(message: WhisperWorkerResponse): void {
  try {
    workerSelf?.postMessage(message);
  } catch {
    // A relay failure must never kill the worker.
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * WASM path decision (documented for the worklog):
 *  - transformers.js itself sets `env.backends.onnx.wasm.wasmPaths` to its
 *    jsdelivr CDN dist folder whenever it is bundled for the browser (fs/path
 *    are stubbed by the package `browser` field). That is exactly how the
 *    previous MAIN-thread implementation loaded the runtime, and CDN fetches
 *    work from worker contexts — so by default this worker resolves the SAME
 *    wasm path as before, with no override required.
 *  - When running from file:// (packaged Electron static export), we point
 *    wasmPaths at this worker's own directory instead. scripts/copy-wasm.js
 *    already copies every ort-wasm-*.wasm variant into out/_next/static/chunks/
 *    — the same directory webpack emits this worker chunk into — so offline
 *    Electron builds load the wasm worker-relative instead of hitting the CDN.
 *  - numThreads is pinned to 1: this is a MODULE worker (no importScripts, and
 *    SharedArrayBuffer is unavailable without crossOriginIsolated), so ORT's
 *    threaded path cannot be used — matching the single-threaded execution
 *    the app had on the main thread.
 */
function configureWasm(env: any): void {
  const wasm = env?.backends?.onnx?.wasm;
  if (!wasm) return;
  if (workerSelf && workerSelf.location.protocol === "file:") {
    // Trailing slash matters: ORT concatenates wasmPaths + file name.
    wasm.wasmPaths = new URL(".", workerSelf.location.href).href;
  }
  wasm.numThreads = 1;
}

/**
 * Get (or build) the singleton Whisper pipeline. The whole v5.2 host-retry
 * sequence lives inside the singleton promise: on total failure the singleton
 * is cleared so a later call can retry from the default host, while completed
 * model files stay in the browser cache (downloads resume, never restart).
 */
async function getPipeline(runId: number): Promise<any> {
  progressRunId = runId;
  if (!pipelinePromise) {
    const build = (async () => {
      const { pipeline, env } = await import("@xenova/transformers");
      env.allowRemoteModels = true;
      env.allowLocalModels = false;
      // Persistent across sessions (Cache API storage): download once, reuse
      // forever. Defaults to true in workers anyway — set explicitly.
      env.useBrowserCache = true;
      configureWasm(env);

      const progress_callback = (info: unknown) => {
        if (progressRunId == null) return;
        const p = toModelProgress(info);
        if (!p) return;
        post({
          type: "progress",
          runId: progressRunId,
          stage: "model",
          progress: p.progress,
          status: p.status,
        });
        // v5.2: richer file-level download events — emitted in addition to
        // the "model" event above so the UI can show the exact file + %.
        const i = info as { status?: unknown; file?: unknown } | null;
        if (
          i &&
          typeof i === "object" &&
          i.status === "progress" &&
          typeof i.file === "string" &&
          i.file
        ) {
          post({
            type: "progress",
            runId: progressRunId,
            stage: "download",
            progress: p.progress,
            file: i.file,
            status: `${p.status} ${p.progress}%`,
          });
        }
      };

      let lastError: unknown = null;
      for (let attempt = 0; attempt < PIPELINE_HOSTS.length; attempt++) {
        const host = PIPELINE_HOSTS[attempt];
        env.remoteHost = host;
        const label =
          attempt === 0
            ? "Downloading Whisper model…"
            : host === MIRROR_REMOTE_HOST
              ? "Retrying via mirror (hf-mirror.com)…"
              : "Retrying download (huggingface.co)…";
        if (progressRunId != null) {
          post({
            type: "progress",
            runId: progressRunId,
            stage: "model",
            progress: 0,
            status: label,
          });
        }
        try {
          return await pipeline("automatic-speech-recognition", MODEL_ID, {
            progress_callback,
          });
        } catch (err) {
          lastError = err;
          // Completed files stay in the browser cache — the next attempt
          // continues the download instead of restarting it.
        }
      }
      // All attempts failed — start the NEXT build on the default host again.
      env.remoteHost = DEFAULT_REMOTE_HOST;
      const classified = classifyWhisperError(lastError);
      throw new Error(
        classified ??
          (lastError instanceof Error
            ? lastError.message
            : String(lastError)),
      );
    })();
    // Reset on failure so a retry can rebuild; the awaiting caller still sees
    // the original rejection and reports it as { type: "error" }.
    build.catch(() => {
      pipelinePromise = null;
    });
    pipelinePromise = build;
  }
  return pipelinePromise;
}

async function handleTranscribe(
  msg: Extract<WhisperWorkerRequest, { type: "transcribe" }>,
): Promise<void> {
  const { runId, pcm, sampleRate, language } = msg;

  if (!(pcm instanceof Float32Array)) {
    throw new Error("Invalid PCM payload — expected a Float32Array");
  }
  if (typeof sampleRate === "number" && sampleRate !== 16000) {
    throw new Error(`Expected 16 kHz PCM, got ${sampleRate} Hz`);
  }

  const pipe = await getPipeline(runId);
  if (cancelledRuns.has(runId)) return; // aborted while the model was loading

  post({
    type: "progress",
    runId,
    stage: "transcribe",
    progress: 25,
    status: "Transcribing audio…",
  });

  const baseOptions = buildPipeOptions(language);

  // ── Pass 1: REAL word-level alignment (DTW cross-attention) ──
  let output: any = null;
  let wordLevel = false;
  try {
    output = await pipe(pcm, {
      ...baseOptions,
      return_timestamps: "word",
    });
    wordLevel = true;
  } catch {
    // Word alignment unsupported → chunk-level fallback below.
    wordLevel = false;
  }

  if (!wordLevel) {
    post({
      type: "progress",
      runId,
      stage: "transcribe",
      progress: 40,
      status: "Word alignment unavailable — falling back…",
    });
    output = await pipe(pcm, {
      ...baseOptions,
      return_timestamps: true,
    });
  }

  if (cancelledRuns.has(runId)) return; // aborted mid-inference — discard

  const detectedLanguage =
    language === "auto" ? (output?.language ?? null) : language;
  const chunks: RawWhisperChunk[] = Array.isArray(output?.chunks)
    ? output.chunks
    : [];

  post({
    type: "result",
    runId,
    chunks,
    language: detectedLanguage,
    wordLevel,
  });
}

async function run(request: WhisperWorkerRequest): Promise<void> {
  const runId = request.runId;
  try {
    if (cancelledRuns.has(runId)) return;
    if (request.type === "preload") {
      await getPipeline(runId);
      post({ type: "result", runId, chunks: null, language: null, wordLevel: false });
    } else if (request.type === "transcribe") {
      await handleTranscribe(request);
    }
    // "cancel" is handled synchronously in dispatch(); anything else is an
    // unknown message type — ignore it.
  } catch (err) {
    post({ type: "error", runId, message: errorMessage(err) });
  } finally {
    cancelledRuns.delete(runId);
  }
}

function dispatch(request: WhisperWorkerRequest): void {
  if (request.type === "cancel") {
    cancelledRuns.add(request.runId);
    return;
  }
  // Serialize: one job at a time (inference is synchronous WASM between
  // awaits). Rejections are already reported via post() inside run().
  queue = queue.then(() => run(request)).catch(() => {});
}

if (workerSelf) {
  workerSelf.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as WhisperWorkerRequest | undefined | null;
    if (
      !data ||
      typeof data !== "object" ||
      typeof data.type !== "string" ||
      typeof data.runId !== "number"
    ) {
      return; // unknown/malformed message — ignore, stay alive
    }
    dispatch(data);
  });
}
