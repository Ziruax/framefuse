// src/lib/export/gpu-export-worker.ts — the GPU export engine's Web Worker
// ENTRY POINT (v1.15.2 GPU-Shift worker migration).
//
// This file is NOT part of the Next.js module graph. It is bundled by
// scripts/build-gpu-worker.js (bun build --format=iife) into the
// SELF-CONTAINED classic-worker script public/gpu-worker.js, which
// gpu-worker-client.ts spawns relative to the document. The bundler-free
// load path is deliberate: the packaged app serves the page over file://
// with a RELATIVE assetPrefix, and webpack's worker chunk resolution is the
// documented v5.0 whisper-worker landmine (chunk URLs duplicating the
// _next/static prefix inside asar). One iife file, zero runtime imports.
//
// Inside the worker: compositing (OffscreenCanvas 2D + the WebGL chroma
// keyer), VideoDecoder/VideoEncoder, and mp4-muxer — the ENTIRE VIDEO
// engine runs here, off the main thread. The main thread only receives
// progress ticks, relayed muxed chunks, logs, and the result
// (worker-protocol.ts is the contract).
//
// THE AUDIO ARM (instruction #4): Web Audio is [Exposed=Window] per spec —
// OfflineAudioContext/decodeAudioData do NOT exist in workers (verified
// live: "OfflineAudioContext is not defined"). The mixdown + AAC encode
// therefore run on the MAIN thread: the engine's audioProvider (below)
// requests the mix via 'audio-mix', the main-thread AudioMixer streams
// reconstructed-able chunk batches back ('audio-chunks'), and this side
// rebuilds EncodedAudioChunks + feeds the muxer. Async boundaries hold on
// both sides — the frame loop here never blocks on main-thread JS.
//
// Memory discipline is unchanged (the VRAM RULE sites live in engine.ts /
// SourceDecoder.ts / AudioMixer.ts — every VideoFrame/AudioData is closed on
// every path; encoder queue backpressure is enforced in the engine loop).

import { exportTimelineViaGpu, type GpuTimelineExportResult } from "./engine";
import { AudioMixerError, type AudioMixerResult } from "./AudioMixer";
import {
  GPU_WORKER_PROTOCOL,
  type GpuWorkerRequest,
  type GpuWorkerResponse,
  type GpuWorkerRunPayload,
  type GpuTimelineAudioProvider,
} from "./worker-protocol";

/** postMessage without lib.dom's Window-typed overload. */
const workerScope = self as unknown as {
  postMessage: (message: GpuWorkerResponse, transfer?: Transferable[]) => void;
  onmessage: ((ev: MessageEvent<GpuWorkerRequest>) => void) | null;
};

function post(msg: GpuWorkerResponse, transfer?: Transferable[]): void {
  workerScope.postMessage(msg, transfer ?? []);
}

/** Relay the engine's console output to the page console (prefixed) — the
 * worker's own console is invisible unless devtools attach to it directly. */
function relayConsole(): void {
  for (const level of ["info", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      original(...args);
      try {
        const text = args
          .map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a)))
          .join(" ");
        post({ type: "log", level, text });
      } catch {
        /* never let logging break the export */
      }
    };
  }
}

// The Electron sink relay: muxed bytes postMessage back to the client, which
// forwards them to the preload gpu-export-* IPC bridge. Per-worker message
// order is guaranteed, matching the append-only ChunkSink contract.
const sinkRelayBridge = {
  exportStart: (filePath: string): void => {
    post({ type: "sink-start", path: filePath });
  },
  exportChunk: (buffer: Uint8Array): void => {
    // ChunkSink hands us a private exact-size copy — transfer its buffer
    // zero-copy (defensive slice if a view ever rides through instead).
    const transferable: ArrayBuffer =
      buffer.buffer.byteLength === buffer.byteLength
        ? (buffer.buffer as ArrayBuffer)
        : (buffer.slice().buffer as ArrayBuffer);
    post({ type: "sink-chunk", bytes: transferable }, [transferable]);
  },
  exportEnd: (): void => {
    post({ type: "sink-end" });
  },
};

// ── The cross-thread audio arm (the engine's opts.audioProvider). ─────────
interface ActiveMix {
  mixId: number;
  onChunk: (chunk: EncodedAudioChunk, meta: EncodedAudioChunkMetadata | undefined) => void;
  resolve: (r: AudioMixerResult) => void;
  reject: (e: Error) => void;
}
let activeMix: ActiveMix | null = null;
let mixSeq = 0;

const audioProvider: GpuTimelineAudioProvider = (timelineSec, tracks, onChunk, signal) =>
  new Promise<AudioMixerResult>((resolve, reject) => {
    const mixId = ++mixSeq;
    const onAbort = (): void => {
      post({ type: "audio-mix-abort", mixId });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    activeMix = {
      mixId,
      onChunk,
      resolve: (r) => {
        signal.removeEventListener("abort", onAbort);
        resolve(r);
      },
      reject: (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    };
    // The main thread owns OfflineAudioContext + AudioEncoder — request the
    // mix; chunks arrive as 'audio-chunks' batches below.
    post({ type: "audio-mix", mixId, timelineSec, tracks });
  });

/** Rebuild an EncodedAudioChunk + metadata from the wire format (the client
 * sends raw bytes + fields — no reliance on chunk transferability across
 * runtimes; the byte counts are trivial at AAC 128 kbps). */
function rebuildAudioChunk(w: {
  type: "key" | "delta";
  timestamp: number;
  duration?: number;
  data: ArrayBuffer;
  meta?: {
    decoderConfig?: {
      codec: string;
      sampleRate: number;
      numberOfChannels: number;
      description?: ArrayBuffer;
    };
  };
}): { chunk: EncodedAudioChunk; meta: EncodedAudioChunkMetadata | undefined } {
  const chunk = new EncodedAudioChunk({
    type: w.type,
    timestamp: w.timestamp,
    ...(w.duration != null ? { duration: w.duration } : {}),
    data: new Uint8Array(w.data),
  });
  const meta: EncodedAudioChunkMetadata | undefined = w.meta
    ? {
        ...(w.meta.decoderConfig
          ? {
              decoderConfig: {
                codec: w.meta.decoderConfig.codec,
                sampleRate: w.meta.decoderConfig.sampleRate,
                numberOfChannels: w.meta.decoderConfig.numberOfChannels,
                ...(w.meta.decoderConfig.description
                  ? { description: new Uint8Array(w.meta.decoderConfig.description) }
                  : {}),
              },
            }
          : {}),
      }
    : undefined;
  return { chunk, meta };
}

let busy = false;
let activeController: AbortController | null = null;

async function runExport(payload: GpuWorkerRunPayload): Promise<void> {
  const { sinkMode, ...engineOpts } = payload;
  const controller = new AbortController();
  activeController = controller;
  const relay = sinkMode === "relay";
  try {
    const result: GpuTimelineExportResult = await exportTimelineViaGpu({
      ...engineOpts,
      streamer: relay ? sinkRelayBridge : null,
      // relay → the IPC path ignores browserDelivery; memory → the muxed
      // MP4 rides home as a transferable and the MAIN thread downloads it.
      browserDelivery: relay ? "download" : "bytes",
      audioProvider, // the cross-thread audio arm (main-thread mixdown)
      onProgress: (p) => post({ type: "progress", progress: p }),
      signal: controller.signal,
    });
    const transfer = result.bytes ? [result.bytes] : [];
    post({ type: "done", result }, transfer);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    post({ type: "error", name: err.name || "Error", message: err.message || String(e) });
  } finally {
    activeController = null;
    activeMix = null;
  }
}

relayConsole();
workerScope.onmessage = (ev: MessageEvent<GpuWorkerRequest>): void => {
  const msg = ev.data;
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "abort":
      activeController?.abort();
      return;
    case "audio-chunks": {
      const mix = activeMix;
      if (!mix || mix.mixId !== msg.mixId) return; // stale batch (aborted pass)
      for (const w of msg.chunks) {
        try {
          const { chunk, meta } = rebuildAudioChunk(w);
          mix.onChunk(chunk, meta);
        } catch (e) {
          mix.reject(
            e instanceof Error ? e : new Error(`audio chunk rebuild failed: ${String(e)}`),
          );
          return;
        }
      }
      return;
    }
    case "audio-complete": {
      const mix = activeMix;
      if (!mix || mix.mixId !== msg.mixId) return;
      mix.resolve(msg.result);
      return;
    }
    case "audio-error": {
      const mix = activeMix;
      if (!mix || mix.mixId !== msg.mixId) return;
      mix.reject(new AudioMixerError(msg.message));
      return;
    }
    case "run":
      if (busy) {
        post({ type: "error", name: "GpuExportError", message: "GPU export worker is already running" });
        return;
      }
      busy = true;
      void runExport(msg.payload).finally(() => {
        busy = false;
      });
      return;
  }
};

// The handshake: the client checks the protocol version and logs the
// ready line (E2E asserts on it).
post({ type: "ready", protocol: GPU_WORKER_PROTOCOL });