// electron/whisper-child.js — Whisper service child (Electron utilityProcess).
//
// Forked by electron/main.js via utilityProcess.fork(). Runs the whole
// Transformers.js + onnxruntime-node pipeline OFF both the renderer AND the
// main process — the UI never blocks during caption generation (the v5.0
// worker did this in the renderer; the v5.1 native service fixes the
// packaged-app worker-chunk path bug AND gets native-threaded inference).
//
// Staged for packaging by scripts/stage-whisper-service.js into
//   <resources>/whisper-service/{whisper-child.js, whisper-core.js, node_modules/…}
// where the staged node_modules contains @xenova/transformers (ESM src),
// onnxruntime-node (win32 native binding), onnxruntime-web (loader used by
// the import chain) and a tiny sharp stub (image processing is never used
// for Whisper — stubbing it keeps ~10 MB of cross-platform binaries out of
// the installer).
//
// Message protocol (mirrors the old web worker, documented in
// src/lib/merger/whisper-worker.ts):
//   host → child:
//     { type: "preload",    runId: number, cacheDir?: string }
//     { type: "transcribe", runId: number, pcm: Float32Array,
//       sampleRate: number, language: string, cacheDir?: string }
//     { type: "cancel",     runId: number }
//   child → host:
//     { type: "progress", runId, stage: "model" | "transcribe",
//       progress: number, status: string }
//     { type: "result", runId, chunks: Array|null, language: string|null,
//       wordLevel: boolean }
//     { type: "error",   runId, message: string }
//
// PCM arrives via structured clone (the host transfers the underlying
// ArrayBuffer). Work is serialized through a promise queue — one
// preload/transcribe at a time — and every handler reports failures as
// { type: "error" } so the host can never hang waiting.

"use strict";

const core = require("./whisper-core");

/** Default persistent model cache (host passes userData path via env). */
const DEFAULT_CACHE_DIR =
  process.env.FRAMEFUSE_WHISPER_DIR || null;

const port = process.parentPort || null;

/** runIds cancelled by the host before their work finished. */
const cancelledRuns = new Set();

/** Serializes work: one job at a time on this thread. */
let queue = Promise.resolve();

function post(message) {
  try {
    if (port) port.postMessage(message);
  } catch (_) {
    // A relay failure must never kill the service.
  }
}

/** Current model-download progress relay target. */
let modelProgressRunId = null;

async function ensurePipeline(runId, cacheDir) {
  modelProgressRunId = runId;
  const dir = cacheDir || DEFAULT_CACHE_DIR;
  return core.buildPipeline({
    cacheDir: dir,
    onModelProgress: (p) => {
      if (modelProgressRunId == null) return;
      post({
        type: "progress",
        runId: modelProgressRunId,
        stage: "model",
        progress: p.progress,
        status: p.status,
      });
    },
  });
}

async function handleTranscribe(msg) {
  const { runId, pcm, sampleRate, language } = msg;

  if (!(pcm instanceof Float32Array)) {
    throw new Error("Invalid PCM payload — expected a Float32Array");
  }
  if (typeof sampleRate === "number" && sampleRate !== 16000) {
    throw new Error(`Expected 16 kHz PCM, got ${sampleRate} Hz`);
  }

  const pipe = await ensurePipeline(runId, msg.cacheDir);
  if (cancelledRuns.has(runId)) return; // aborted while the model was loading

  post({
    type: "progress",
    runId,
    stage: "transcribe",
    progress: 25,
    status: "Transcribing audio…",
  });

  // Pass 1: word-level alignment; Pass 2: chunk-level fallback (core handles).
  let out;
  try {
    out = await core.transcribePcm(pipe, pcm, language);
  } catch (err) {
    // Word alignment failing at the OUTER level still ran pass 2 — only a
    // genuine inference error lands here.
    throw err;
  }
  // Word-alignment fallback notice (mirrors the worker's 40 marker).
  if (!out.wordLevel) {
    post({
      type: "progress",
      runId,
      stage: "transcribe",
      progress: 40,
      status: "Word alignment unavailable — falling back…",
    });
  }

  if (cancelledRuns.has(runId)) return; // aborted mid-inference — discard

  post({
    type: "result",
    runId,
    chunks: out.chunks,
    language: out.language,
    wordLevel: out.wordLevel,
  });
}

async function run(request) {
  const runId = request.runId;
  try {
    if (cancelledRuns.has(runId)) return;
    if (request.type === "preload") {
      await ensurePipeline(runId, request.cacheDir);
      post({ type: "result", runId, chunks: null, language: null, wordLevel: false });
    } else if (request.type === "transcribe") {
      await handleTranscribe(request);
    }
    // "cancel" is handled synchronously in dispatch(); anything else is an
    // unknown message type — ignore it.
  } catch (err) {
    post({
      type: "error",
      runId,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    cancelledRuns.delete(runId);
  }
}

function dispatch(request) {
  if (!request || typeof request !== "object" || typeof request.type !== "string") {
    return;
  }
  if (request.type === "cancel") {
    if (typeof request.runId === "number") cancelledRuns.add(request.runId);
    return;
  }
  if (typeof request.runId !== "number") return;
  // Serialize: one job at a time. Rejections are reported via post() in run().
  queue = queue.then(() => run(request)).catch(() => {});
}

if (port) {
  port.on("message", (event) => {
    const data = event && event.data;
    if (!data || typeof data !== "object") return;
    dispatch(data);
  });
  post({ type: "progress", runId: -1, stage: "model", progress: 0, status: "service-ready" });
} else {
  // Not running under utilityProcess (direct node smoke test) — warn loudly.
  console.warn("[whisper-child] no process.parentPort — messages disabled");
}

module.exports = { dispatch, post };
