// electron/whisper-core.js — Whisper-tiny ASR core for Node environments.
//
// Runs INSIDE the Electron utilityProcess (whisper-child.js shell) but is a
// plain Node module with zero Electron imports, so it can be smoke-tested
// directly with node/bun:
//   node -e "require('./electron/whisper-core').buildPipeline({...}).then(...)"
//
// v5.2 ROBUSTNESS (fixes "whisper tiny is not working"):
//   - sharp guard: transformers.js STATICALLY imports `sharp` (image
//     processing — never used for ASR). When the installed sharp package has
//     a missing/broken native binding (offline installs, skipped postinstall
//     scripts), the ENTIRE transformers import died with the cryptic
//     "Something went wrong installing the sharp module" error. We probe
//     sharp BEFORE importing transformers and, when the probe fails, replace
//     the cached module with a no-op stub so the import succeeds.
//   - Mirror + retry: the pipeline is attempted against
//     https://huggingface.co first; on failure (network/timeout/HTTP error)
//     retried via the https://hf-mirror.com mirror (same repository layout),
//     then against huggingface.co once more. Files already downloaded stay in
//     the disk cache, so each attempt CONTINUES where the previous stopped.
//     The active host is reported through the progress callback.
//   - Error classification: build/transcription failures are wrapped into
//     friendly, actionable messages (network vs rate-limit vs server error vs
//     native runtime) with the underlying message as a "[…]" suffix.
//
// v5.1 ARCHITECTURE (replaces the renderer Web Worker for the desktop app):
//   - Transformers.js + ONNX Runtime NODE (native CPU, multi-threaded) —
//     several times faster than the single-threaded WASM worker and immune
//     to the packaged-app worker-chunk path bug
//     ("file://…/app.asar/out/_next/static/chunks/_next/static/chunks/….js").
//   - The model is downloaded ONCE to a persistent DISK folder
//     (app.getPath("userData")/whisper-models) and reused forever — survives
//     app restarts and updates; internet is only required for the first
//     transcription.
//   - Progress protocol mirrors the old web worker exactly: model-download
//     events carry raw 0–100 file percentages ("stage":"model"); transcribe
//     events carry absolute 25–80 values. The host maps them onto the same
//     overall curve the UI already renders. The raw progress_callback info
//     object is forwarded as a second argument so the host can emit richer
//     file-level "download" events.
//
// Pipeline options are IDENTICAL to the worker implementation (chunk 30 s,
// stride 5 s, no previous-text conditioning, word-level timestamps with a
// chunk-level fallback) so transcription output is byte-compatible.
//
// onnxruntime-node is pinned at 1.14.0 (package.json) — the
// process.release.name patch below keeps transformers' backend selection on
// the native node runtime inside Electron's utilityProcess.

"use strict";

const MODEL_ID = "Xenova/whisper-tiny";

// Hosts tried in order when building the pipeline: the official HuggingFace
// Hub first; on failure the hf-mirror.com mirror (identical repository
// layout, same remotePathTemplate); then the official host once more —
// transient network errors often clear within seconds.
const DEFAULT_REMOTE_HOST = "https://huggingface.co/";
const MIRROR_REMOTE_HOST = "https://hf-mirror.com/";
const PIPELINE_HOSTS = [
  DEFAULT_REMOTE_HOST,
  MIRROR_REMOTE_HOST,
  DEFAULT_REMOTE_HOST,
];

// Approximate quantized whisper-tiny download size (measured: encoder
// 10.1 MB + decoder 30.7 MB + tokenizer ~2.8 MB ≈ 42 MB).
const MODEL_SIZE_HINT = "~42 MB";

// ---------------------------------------------------------------------------
// sharp guard (v5.2) — MUST run before `import("@xenova/transformers")`.
// ---------------------------------------------------------------------------

/** One-shot flag so the (cheap) probe runs at most once per process. */
let sharpChecked = false;

/**
 * Make sure a broken `sharp` install cannot kill the transformers import.
 *
 * transformers.js's `src/utils/image.js` does `import sharp from 'sharp'`
 * unconditionally, so a sharp package whose native binding is missing makes
 * EVERY `import("@xenova/transformers")` fail before any of our code runs.
 * The ESM→CJS interop consults require.cache, so pre-populating the cache
 * entry for the resolved sharp path with a stub function is enough (verified
 * against Node 24 and Electron 33's embedded Node 20 via ELECTRON_RUN_AS_NODE).
 *
 * When sharp is healthy (or already the packaged stub from
 * scripts/stage-whisper-service.js) it is left untouched. Image pipelines are
 * never used by the Whisper service, so the stub is never exercised.
 */
function neutralizeSharp() {
  if (sharpChecked) return;
  sharpChecked = true;
  const Module = require("module");
  let sharpPath;
  try {
    sharpPath = require.resolve("sharp");
  } catch (_) {
    // No sharp package at all — the ESM import would fail at link time with
    // ERR_MODULE_NOT_FOUND; classified by the caller's error handling.
    return;
  }
  try {
    require(sharpPath); // healthy sharp (or the staged stub) — keep it.
    return;
  } catch (_) {
    // Broken native binding — replace the (partial) cache entry with a stub.
  }
  const stub = function sharpStub() {
    throw new Error(
      "sharp is stubbed out inside the Whisper service — image processing is unavailable",
    );
  };
  stub.format = {};
  stub.interpolators = {};
  stub.versions = {};
  try {
    const mod = new Module(sharpPath, null);
    mod.exports = stub;
    mod.loaded = true;
    require.cache[sharpPath] = mod;
  } catch (_) {
    // Even a failed stub install is non-fatal — the original error surfaces.
  }
}

// ---------------------------------------------------------------------------
// Error classification (v5.2).
// ---------------------------------------------------------------------------

/**
 * Map a pipeline-build / transcription error onto a friendly, actionable
 * message, or return null when the raw message should pass through as-is.
 * The underlying message is always kept as a bracketed suffix.
 */
function classifyWhisperError(err) {
  const raw = err instanceof Error ? err.message : String(err);
  const m = String(raw).toLowerCase();

  // Local disk / cache permission problems (distinct from server 403s).
  if (/eacces|eperm\b/.test(m)) {
    return `Could not write to the Whisper model cache folder — check disk permissions and free space. [${raw}]`;
  }

  // Network / DNS / TLS / firewall — the model could not be fetched.
  if (
    /fetch failed|failed to fetch|enotfound|etimedout|timeout|timed out|econnrefused|econnreset|econnaborted|eai_again|getaddrinfo|socket hang up|network|tls|certificate|self-signed|hostname\/ip|und_err_|other side closed|terminated/.test(
      m,
    )
  ) {
    return `Could not download the Whisper model. Check your internet connection or firewall (the model is fetched once from huggingface.co, ${MODEL_SIZE_HINT}, with an automatic mirror retry). [${raw}]`;
  }

  if (/rate limit|error \(429\)/.test(m)) {
    return `HuggingFace is rate-limiting downloads from your network. Wait a minute and try again — the app also retries automatically via the hf-mirror.com mirror. [${raw}]`;
  }

  if (/file does not exist|could not locate file/.test(m)) {
    return `A Whisper model file was not found on the server — the Xenova/whisper-tiny repository may have changed. [${raw}]`;
  }

  if (/internal server error|bad gateway|service unavailable|gateway timeout|error \(5\d\d\)/.test(m)) {
    return `The model server reported an error. This is usually temporary — try again; already-downloaded files are kept, so a retry continues where it stopped. [${raw}]`;
  }

  if (/permission denied|unauthorized access|forbidden access/.test(m)) {
    return `Access to the model file was denied by the server. [${raw}]`;
  }

  if (/something went wrong installing the "sharp" module|cannot find module.*sharp/.test(m)) {
    return `Whisper's optional image library (sharp) could not be loaded. Reinstall the app dependencies to fix it. [${raw}]`;
  }

  if (/onnxruntime|\.node\b/.test(m)) {
    return `The native ONNX runtime could not be loaded. Try reinstalling the app (onnxruntime-node dependency). [${raw}]`;
  }

  return null; // no friendly mapping — surface the raw message verbatim
}

/** Wrap an error with its classified message (or rethrow the original). */
function toClassifiedError(err) {
  const classified = classifyWhisperError(err);
  if (classified) return new Error(classified);
  return err instanceof Error ? err : new Error(String(err));
}

// ---------------------------------------------------------------------------
// Progress mapping (mirrors whisper-worker.ts toModelProgress).
// ---------------------------------------------------------------------------

/**
 * Convert a Transformers.js `progress_callback` info object into a
 * { progress, status } pair, or null when it should be ignored.
 */
function toModelProgress(info) {
  if (!info || typeof info !== "object") return null;
  const i = info;
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
 * Whisper pipeline call options — identical to the worker's buildPipeOptions.
 */
function buildPipeOptions(language) {
  const options = {
    chunk_length_s: 30,
    stride_length_s: 5,
    task: "transcribe",
    condition_on_previous_text: false,
  };
  if (language && language !== "auto") options.language = language;
  return options;
}

// ---------------------------------------------------------------------------
// Pipeline singleton.
// ---------------------------------------------------------------------------

/** Singleton pipeline promise (module scope — the model is built ONCE). */
let pipelinePromise = null;

/** Host that actually served model bytes over the network for the most
 *  recent build that fetched something (diagnostics). Stays null when every
 *  file came from the local disk cache — the UI then omits the "via …"
 *  suffix instead of guessing. */
let lastHostUsed = null;

// ── v5.2 fetch origin tracking ─────────────────────────────────────────────
// transformers.js gives no signal for "served from cache" vs "fetched", so a
// transparent pass-through wrapper around globalThis.fetch records the origin
// of successful model-file responses. The child process does nothing but
// Whisper work, so leaving the wrapper installed is harmless.
let fetchTrackingInstalled = false;
let lastFetchedHost = null;

function installFetchTracking() {
  if (fetchTrackingInstalled) return;
  const orig = globalThis.fetch;
  if (typeof orig !== "function") return; // exotic runtime — skip diagnostics
  fetchTrackingInstalled = true;
  globalThis.fetch = async function whisperTrackedFetch(input, init) {
    const res = await orig.call(this, input, init);
    try {
      const url =
        typeof input === "string"
          ? input
          : input && typeof input.url === "string"
            ? input.url
            : "";
      if (url.includes(MODEL_ID) && res && res.ok) {
        lastFetchedHost = new URL(url).origin + "/";
      }
    } catch (_) {
      /* diagnostics only — never fail a fetch for this */
    }
    return res;
  };
}

/**
 * Build (or return) the singleton Whisper pipeline.
 *
 * The whole host-retry sequence lives INSIDE the singleton promise: callers
 * await one promise and see the final success/failure. Between attempts only
 * the per-attempt pipeline() construction is reset — transformers.js keeps no
 * model singleton of its own, and completed files persist in the disk cache
 * so the next attempt resumes the download instead of restarting it.
 *
 * @param {object} o
 * @param {string} o.cacheDir  Persistent on-disk model cache (userData).
 * @param {(p:{progress:number,status:string}, info:?object)=>void} [o.onModelProgress]
 *        Raw model-download progress relay (0–100 per file). `info` is the
 *        original transformers.js progress_callback object (file/loaded/
 *        total) so the host can emit richer file-level download events.
 */
async function buildPipeline(o) {
  if (pipelinePromise) return pipelinePromise;
  const cacheDir = o && o.cacheDir;
  const onModelProgress =
    o && typeof o.onModelProgress === "function" ? o.onModelProgress : null;

  pipelinePromise = (async () => {
    // Force the Node branch of transformers' ONNX backend selection. Utility
    // processes are real Node environments, but the check is
    // `process.release.name === "node"` — patch defensively (the property is
    // writable) so onnxruntime-node is ALWAYS the backend, never wasm.
    try {
      if (process.release && process.release.name !== "node") {
        process.release.name = "node";
      }
    } catch (_) { /* read-only in some runtimes — selection still works */ }

    // v5.2: a broken sharp install must not kill the import (see above).
    neutralizeSharp();

    const mod = await import("@xenova/transformers");
    const { pipeline, env } = mod;

    env.allowRemoteModels = true;
    env.allowLocalModels = false;
    if (cacheDir) {
      env.cacheDir = cacheDir;
      env.localModelPath = cacheDir;
    }
    installFetchTracking();

    const progress_callback = (info) => {
      const p = toModelProgress(info);
      if (p && onModelProgress) onModelProgress(p, info);
    };

    let lastError = null;
    for (let attempt = 0; attempt < PIPELINE_HOSTS.length; attempt++) {
      const host = PIPELINE_HOSTS[attempt];
      env.remoteHost = host;
      lastFetchedHost = null; // per-build: which origin actually served bytes
      const label =
        attempt === 0
          ? "Downloading Whisper model…"
          : host === MIRROR_REMOTE_HOST
            ? "Retrying via mirror (hf-mirror.com)…"
            : "Retrying download (huggingface.co)…";
      if (onModelProgress) onModelProgress({ progress: 0, status: label }, null);
      try {
        // NOTE: no explicit per-attempt timeout — Node's undici fetch fails
        // hung connections on its own (300 s headers/body timeouts), and an
        // artificial race would leave a zombie download writing into the
        // shared cache concurrently with the retry.
        const pipe = await pipeline("automatic-speech-recognition", MODEL_ID, {
          progress_callback,
        });
        // Only claim a host when bytes were actually fetched this build —
        // a fully cache-served build keeps the previous (historical) origin.
        if (lastFetchedHost) lastHostUsed = lastFetchedHost;
        return pipe;
      } catch (err) {
        lastError = err;
        // Files completed so far stay cached — the next attempt continues.
      }
    }

    // All attempts failed — start the NEXT build on the default host again.
    env.remoteHost = DEFAULT_REMOTE_HOST;
    throw toClassifiedError(lastError);
  })();

  // Reset on failure so a later call can retry (the awaiting caller still
  // sees the original rejection).
  pipelinePromise.catch(() => { pipelinePromise = null; });
  return pipelinePromise;
}

/** Test/diagnostic hook: drop the singleton so the next call rebuildes. */
function resetPipeline() {
  pipelinePromise = null;
}

// ---------------------------------------------------------------------------
// Transcription.
// ---------------------------------------------------------------------------

/**
 * Transcribe mono 16 kHz Float32 PCM.
 *
 * Pass 1 requests REAL word-level alignment (DTW cross-attention,
 * `return_timestamps: "word"`); on failure falls back to chunk-level
 * timestamps — exactly the worker's two-pass behavior.
 *
 * @returns {{ chunks: Array, language: string|null, wordLevel: boolean }}
 */
async function transcribePcm(pipe, pcm, language) {
  if (!(pcm instanceof Float32Array)) {
    throw new Error("Invalid PCM payload — expected a Float32Array");
  }
  const baseOptions = buildPipeOptions(language);

  let output = null;
  let wordLevel = false;
  try {
    output = await pipe(pcm, { ...baseOptions, return_timestamps: "word" });
    wordLevel = true;
  } catch (_) {
    wordLevel = false;
  }
  if (!wordLevel) {
    try {
      output = await pipe(pcm, { ...baseOptions, return_timestamps: true });
    } catch (err) {
      // Genuine inference failure — classify (e.g. native runtime problems)
      // or surface the raw message verbatim.
      throw toClassifiedError(err);
    }
  }

  const detectedLanguage =
    language === "auto" ? (output && output.language) || null : language;
  const chunks = output && Array.isArray(output.chunks) ? output.chunks : [];
  return { chunks, language: detectedLanguage, wordLevel };
}

module.exports = {
  MODEL_ID,
  MODEL_SIZE_HINT,
  DEFAULT_REMOTE_HOST,
  MIRROR_REMOTE_HOST,
  PIPELINE_HOSTS,
  toModelProgress,
  buildPipeOptions,
  buildPipeline,
  resetPipeline,
  transcribePcm,
  classifyWhisperError,
  toClassifiedError,
  neutralizeSharp,
  getLastHostUsed: () => lastHostUsed,
};
