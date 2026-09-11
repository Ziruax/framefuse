// electron/whisper-core.js — Whisper-tiny ASR core for Node environments.
//
// Runs INSIDE the Electron utilityProcess (whisper-child.js shell) but is a
// plain Node module with zero Electron imports, so it can be smoke-tested
// directly with node/bun:
//   node -e "require('./electron/whisper-core').buildPipeline({...}).then(...)"
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
//     overall curve the UI already renders.
//
// Pipeline options are IDENTICAL to the worker implementation (chunk 30 s,
// stride 5 s, no previous-text conditioning, word-level timestamps with a
// chunk-level fallback) so transcription output is byte-compatible.

"use strict";

const MODEL_ID = "Xenova/whisper-tiny";

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

/**
 * Build (or return) the singleton Whisper pipeline.
 *
 * @param {object} o
 * @param {string} o.cacheDir  Persistent on-disk model cache (userData).
 * @param {(p:{progress:number,status:string})=>void} [o.onModelProgress]
 *        Raw model-download progress relay (0–100 per file).
 */
async function buildPipeline(o) {
  if (pipelinePromise) return pipelinePromise;
  const cacheDir = o && o.cacheDir;

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

    const mod = await import("@xenova/transformers");
    const { pipeline, env } = mod;

    env.allowRemoteModels = true;
    env.allowLocalModels = false;
    if (cacheDir) {
      env.cacheDir = cacheDir;
      env.localModelPath = cacheDir;
    }

    const progress_callback = (info) => {
      const p = toModelProgress(info);
      if (p && o && typeof o.onModelProgress === "function") o.onModelProgress(p);
    };

    return await pipeline("automatic-speech-recognition", MODEL_ID, {
      progress_callback,
    });
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
    output = await pipe(pcm, { ...baseOptions, return_timestamps: true });
  }

  const detectedLanguage =
    language === "auto" ? (output && output.language) || null : language;
  const chunks = output && Array.isArray(output.chunks) ? output.chunks : [];
  return { chunks, language: detectedLanguage, wordLevel };
}

module.exports = {
  MODEL_ID,
  toModelProgress,
  buildPipeOptions,
  buildPipeline,
  resetPipeline,
  transcribePcm,
};
