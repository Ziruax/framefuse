// src/lib/export/gpu-worker-client.ts — the MAIN-THREAD harness for the GPU
// export worker (v1.15.2 GPU-Shift worker migration).
//
// Contract: the ENTIRE VIDEO engine (compositor, VideoEncoder/VideoDecoder,
// muxer) runs inside the dedicated worker public/gpu-worker.js (bundled by
// scripts/build-gpu-worker.js); this module only (a) spawns the worker,
// (b) forwards throttled progress ticks to opts.onProgress, (c) relays muxed
// chunks to the preload gpu-export-* IPC bridge (Electron), (d) wires abort,
// (e) reconstructs the engine's typed errors, and (f) runs the AUDIO ARM —
// Web Audio is [Exposed=Window] (spec-verified; no OfflineAudioContext in
// workers), so the SFX pre-render + the OfflineAudioContext mixdown + AAC
// encode run HERE, on the main thread, with async boundaries (the mixdown
// renders in the audio thread pool, the encoder rides its own threads; the
// only main-thread JS is the chunk relay, batched at ~48 chunks / 25 ms).
// UI lag during export is unacceptable — nothing engine-shaped runs here.
//
// Fallback ladder (honest): if the worker cannot even be constructed/loaded
// (missing bundle in a dev checkout, exotic runtime) the engine runs on the
// MAIN THREAD exactly as in v1.15.1 — warn + workerRuntime:"main-thread"
// telemetry. Once the worker is up and running, an engine failure propagates
// to the router (which falls back to FFmpeg in Electron).

import {
  exportTimelineViaGpu,
  type GpuTimelineExportOptions,
  type GpuTimelineExportResult,
} from "./engine";
import { ExportAbortedError, GpuExportError, getExportStreamer } from "./ExportOrchestrator";
import { AudioMixer, type AudioTrackData } from "./AudioMixer";
import { buildAudioTracks, renderSfxTracks, type PrebuiltAudio } from "./audio-tracks";
import {
  GPU_WORKER_PROTOCOL,
  type AudioChunkWire,
  type GpuWorkerRequest,
  type GpuWorkerResponse,
  type GpuWorkerRunPayload,
  type GpuWorkerSinkMode,
} from "./worker-protocol";

/** Boot timeout: 'ready' must arrive within this window or the worker is
 * considered un-loadable (the script failed before the handler installed). */
const WORKER_BOOT_TIMEOUT_MS = 15_000;
/** Progress forwarding floor (ms) — the page's export-progress state drives
 * a full re-render of the studio page; ~3 Hz keeps the bar lively while
 * keeping the main thread's re-render longtask budget in check. */
const PROGRESS_FORWARD_MS = 330;
/** Audio chunk relay batching: flush a batch when it holds this many chunks
 * (~1 s of AAC at 1024-frame/48 kHz chunks) … */
const AUDIO_BATCH_CHUNKS = 48;
/** … or when this much time passed since the last flush (tail latency). */
const AUDIO_BATCH_MS = 25;

function spawnGpuExportWorker(): Worker | null {
  if (typeof document === "undefined") return null;
  try {
    // Relative to the DOCUMENT: the dev server root (public/) in
    // development; out/index.html's directory in the packaged file://
    // build. NEVER an absolute /_next path — webpack worker chunk URLs are
    // the documented v5.0 whisper-worker asar landmine, which the
    // self-contained bundle sidesteps entirely.
    const url = new URL("gpu-worker.js", document.baseURI);
    return new Worker(url.href, { name: "framefuse-gpu-export" });
  } catch (e) {
    console.warn(
      "[framefuse] GPU export worker could not be constructed — the engine will run on the main thread (UI may lag):",
      e,
    );
    return null;
  }
}

/** The worker outcome — never rejects; failures are discriminated by kind so
 * the caller can fall back ONLY for boot-phase failures. */
type WorkerOutcome =
  | { kind: "result"; result: GpuTimelineExportResult }
  | { kind: "boot-failure"; reason: string }
  | { kind: "error"; error: Error };

function reconstructWorkerError(name: string, message: string): Error {
  if (name === "ExportAbortedError") return new ExportAbortedError(message);
  if (name === "GpuExportError") return new GpuExportError(message);
  return new Error(`${name}: ${message}`);
}

/**
 * Prebuild the audio arm on the MAIN thread (instruction #4: Web Audio is
 * Window-only — renderSfxTracks synthesizes WAVs through OfflineAudioContext,
 * and buildAudioTracks is pure data). The worker consumes `tracks` directly
 * and the mixdown is requested back here at pass time ('audio-mix').
 */
async function prebuildAudio(
  opts: GpuTimelineExportOptions,
): Promise<PrebuiltAudio> {
  const sfxBlobUrls: string[] = [];
  const masterVolume =
    typeof opts.audio?.masterVolume === "number" && Number.isFinite(opts.audio.masterVolume)
      ? Math.max(0, Math.min(2, opts.audio.masterVolume))
      : 1;
  const sfxTracks = await renderSfxTracks(opts, masterVolume, sfxBlobUrls);
  const tracks = buildAudioTracks(opts, sfxTracks);
  return { tracks, sfxBlobUrls };
}

/** Serialize one encoded chunk + metadata to the wire format (raw bytes +
 * fields — no reliance on chunk transferability; trivial at 128 kbps). */
function chunkToWire(
  chunk: EncodedAudioChunk,
  meta: EncodedAudioChunkMetadata | undefined,
): AudioChunkWire {
  const data = new ArrayBuffer(chunk.byteLength);
  chunk.copyTo(data);
  const dc = meta?.decoderConfig;
  return {
    type: chunk.type,
    timestamp: chunk.timestamp,
    ...(chunk.duration != null ? { duration: chunk.duration } : {}),
    data,
    ...(dc
      ? {
          meta: {
            ...(dc
              ? {
                  decoderConfig: {
                    codec: dc.codec,
                    sampleRate: dc.sampleRate,
                    numberOfChannels: dc.numberOfChannels,
                    ...(dc.description
                      ? {
                          description:
                            dc.description instanceof ArrayBuffer
                              ? (dc.description.slice(0) as ArrayBuffer)
                              : new Uint8Array(dc.description as BufferSource).buffer,
                        }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

/** Run the engine INSIDE the worker and settle the outcome. */
function runInWorker(
  worker: Worker,
  opts: GpuTimelineExportOptions,
  prebuilt: PrebuiltAudio,
): Promise<WorkerOutcome> {
  return new Promise<WorkerOutcome>((resolve) => {
    // Strip every un-cloneable field — the payload is structured-clone
    // (segments carry File objects natively; blob: URLs stay fetchable from
    // same-agent-cluster dedicated workers in Chromium).
    const {
      onProgress,
      signal,
      streamer: _streamer,
      browserDelivery: _delivery,
      audioProvider: _provider,
      prebuiltAudio: _prebuilt,
      ...payloadBase
    } = opts;

    // Electron with an output path → relay the muxed chunks to the preload
    // sink; plain browser → in-worker memory, the MP4 rides home as bytes.
    const bridge = getExportStreamer();
    const outputPath =
      typeof opts.outputPath === "string" && opts.outputPath.length > 0 ? opts.outputPath : null;
    const sinkMode: GpuWorkerSinkMode = bridge !== null && outputPath !== null ? "relay" : "memory";

    const payload: GpuWorkerRunPayload = {
      ...payloadBase,
      outputPath,
      sinkMode,
      prebuiltAudio: prebuilt,
    };

    let phase: "boot" | "running" | "settled" = "boot";
    let ready = false;
    let bootTimer: ReturnType<typeof setTimeout> | null = null;

    // ── Progress coalescing: the page re-renders the whole studio on every
    // tick — forward at ~3 Hz (stage changes + the final 100% jump always
    // go through immediately).
    let lastForwardAt = 0;
    let lastStage: string | undefined;
    const forwardProgress = (p: {
      progress?: number;
      stage?: string;
      [k: string]: unknown;
    }): void => {
      const now = performance.now();
      const stageChanged = p.stage !== undefined && p.stage !== lastStage;
      if (p.stage !== undefined) lastStage = p.stage;
      const finalTick = p.progress != null && p.progress >= 100;
      if (finalTick || stageChanged || now - lastForwardAt >= PROGRESS_FORWARD_MS) {
        lastForwardAt = now;
        onProgress?.(p as Parameters<NonNullable<typeof onProgress>>[0]);
      }
    };

    // ── The main-thread audio arm state ('audio-mix' requests). ──────────
    interface ActiveMixRun {
      mixId: number;
      abort: AbortController;
      batch: AudioChunkWire[];
      batchTimer: ReturnType<typeof setInterval> | null;
      lastFlushAt: number;
      settled: boolean;
    }
    let activeMixRun: ActiveMixRun | null = null;

    const postRequest = (msg: GpuWorkerRequest, transfer?: Transferable[]): void => {
      try {
        worker.postMessage(msg, transfer ?? []);
      } catch {
        /* worker already dead — the error path settles the promise */
      }
    };

    const flushAudioBatch = (): void => {
      const run = activeMixRun;
      if (!run || run.batch.length === 0 || run.settled) return;
      const chunks = run.batch;
      run.batch = [];
      run.lastFlushAt = performance.now();
      const transfer = chunks.flatMap((c) => {
        const t: Transferable[] = [c.data];
        const desc = c.meta?.decoderConfig?.description;
        if (desc) t.push(desc);
        return t;
      });
      postRequest({ type: "audio-chunks", mixId: run.mixId, chunks }, transfer);
    };

    const startAudioMix = (mixId: number, timelineSec: number, tracks: AudioTrackData[]): void => {
      // A new request implicitly supersedes any prior mix (the engine's
      // hardware→software retry aborts the old pass first — its abort
      // message may simply not have raced here yet).
      activeMixRun?.abort.abort();
      if (activeMixRun?.batchTimer) clearInterval(activeMixRun.batchTimer);
      const run: ActiveMixRun = {
        mixId,
        abort: new AbortController(),
        batch: [],
        batchTimer: null,
        lastFlushAt: performance.now(),
        settled: false,
      };
      activeMixRun = run;
      const mixer = new AudioMixer((chunk, meta) => {
        if (activeMixRun !== run || run.settled) return;
        run.batch.push(chunkToWire(chunk, meta));
        if (run.batch.length >= AUDIO_BATCH_CHUNKS) flushAudioBatch();
      });
      run.batchTimer = setInterval(() => {
        if (activeMixRun !== run) return;
        if (performance.now() - run.lastFlushAt >= AUDIO_BATCH_MS) flushAudioBatch();
      }, AUDIO_BATCH_MS);
      console.info(
        `[gpu-worker] audio arm: mixing ${tracks.length} track(s) (${timelineSec.toFixed(1)}s) on the main thread — chunks relay to the worker muxer`,
      );
      mixer
        .renderAudio(timelineSec, tracks, run.abort.signal)
        .then((result) => {
          if (activeMixRun !== run) return; // superseded
          run.settled = true;
          flushAudioBatch();
          if (run.batchTimer) clearInterval(run.batchTimer);
          postRequest({ type: "audio-complete", mixId, result });
        })
        .catch((e) => {
          if (activeMixRun !== run) return; // superseded
          run.settled = true;
          flushAudioBatch(); // best-effort: drain what encoded before the error
          if (run.batchTimer) clearInterval(run.batchTimer);
          postRequest({
            type: "audio-error",
            mixId,
            message: e instanceof Error ? e.message : String(e),
          });
        });
    };

    const settle = (outcome: WorkerOutcome): void => {
      if (phase === "settled") return;
      phase = "settled";
      if (bootTimer !== null) clearTimeout(bootTimer);
      signal?.removeEventListener("abort", onAbort);
      activeMixRun?.abort.abort();
      if (activeMixRun?.batchTimer) clearInterval(activeMixRun.batchTimer);
      activeMixRun = null;
      try {
        worker.terminate();
      } catch {
        /* already gone */
      }
      resolve(outcome);
    };

    const onAbort = (): void => {
      postRequest({ type: "abort" });
      activeMixRun?.abort.abort();
    };

    worker.onmessage = (ev: MessageEvent<GpuWorkerResponse>): void => {
      const msg = ev.data;
      if (!msg || typeof msg !== "object") return;
      switch (msg.type) {
        case "ready": {
          ready = true;
          if (phase === "boot") phase = "running";
          if (msg.protocol !== GPU_WORKER_PROTOCOL) {
            console.warn(
              `[framefuse] GPU worker protocol mismatch (page ${GPU_WORKER_PROTOCOL} vs worker ${msg.protocol}) — rebuild with "npm run build:gpu-worker"`,
            );
          }
          console.info(
            "[framefuse] GPU export worker ready — compositing + encode run off the main thread",
          );
          break;
        }
        case "progress":
          forwardProgress(msg.progress);
          break;
        case "sink-start":
          bridge?.exportStart(msg.path);
          break;
        case "sink-chunk":
          bridge?.exportChunk(new Uint8Array(msg.bytes));
          break;
        case "sink-end":
          bridge?.exportEnd();
          break;
        case "log": {
          const line = `[gpu-worker] ${msg.text}`;
          if (msg.level === "error") console.error(line);
          else if (msg.level === "warn") console.warn(line);
          else console.info(line);
          break;
        }
        case "audio-mix":
          startAudioMix(msg.mixId, msg.timelineSec, msg.tracks);
          break;
        case "done":
          settle({ kind: "result", result: { ...msg.result, workerRuntime: "worker" } });
          break;
        case "error":
          settle({ kind: "error", error: reconstructWorkerError(msg.name, msg.message) });
          break;
      }
    };

    worker.onerror = (ev: ErrorEvent): void => {
      const detail = ev.message || "unknown worker error";
      if (phase === "boot" && !ready) {
        settle({ kind: "boot-failure", reason: `worker failed to load: ${detail}` });
      } else {
        settle({ kind: "error", error: new GpuExportError(`GPU export worker crashed: ${detail}`) });
      }
    };

    bootTimer = setTimeout(() => {
      if (phase === "boot") {
        settle({ kind: "boot-failure", reason: "worker did not initialize within 15 s" });
      }
    }, WORKER_BOOT_TIMEOUT_MS);

    signal?.addEventListener("abort", onAbort);
    try {
      worker.postMessage({ type: "run", payload } satisfies GpuWorkerRequest);
    } catch (e) {
      settle({ kind: "boot-failure", reason: `payload could not be cloned: ${String(e)}` });
    }
  });
}

/** The documented safety net — only used when the worker could not be
 * constructed/loaded at all. The UI may lag here; the worker is the
 * production path. The engine computes its own audio (main thread HAS Web
 * Audio) and downloads in-engine (browserDelivery default). */
async function runOnMainThread(opts: GpuTimelineExportOptions): Promise<GpuTimelineExportResult> {
  const { streamer: _s, browserDelivery: _d, audioProvider: _p, ...rest } = opts;
  const result = await exportTimelineViaGpu(rest);
  return { ...result, workerRuntime: "main-thread" };
}

/**
 * runGpuTimelineExport — the export router's GPU entry (native.ts). Runs the
 * engine in the dedicated worker; falls back to the main thread ONLY for
 * worker boot failures; propagates engine failures (the router's FFmpeg
 * fallback handles those).
 */
export async function runGpuTimelineExport(
  opts: GpuTimelineExportOptions,
): Promise<GpuTimelineExportResult> {
  const worker = spawnGpuExportWorker();
  if (!worker) return runOnMainThread(opts);
  // The audio arm is PREBUILT here (Web Audio is Window-only — SFX synthesis
  // + the track list). The blob URLs are owned by THIS function and revoked
  // after the run settles (the worker fetches them during the mix).
  const prebuilt = await prebuildAudio(opts);
  try {
    const outcome = await runInWorker(worker, opts, prebuilt);
    if (outcome.kind === "result") return outcome.result;
    if (outcome.kind === "boot-failure") {
      console.warn(
        `[framefuse] GPU export worker unavailable (${outcome.reason}) — running the engine on the main thread; rebuild with "npm run build:gpu-worker".`,
      );
      return runOnMainThread(opts);
    }
    throw outcome.error;
  } finally {
    for (const url of prebuilt.sfxBlobUrls) URL.revokeObjectURL(url);
  }
}
