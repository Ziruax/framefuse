// src/lib/export/worker-protocol.ts — the message contract between
// gpu-worker-client.ts (main thread) and gpu-export-worker.ts (worker).
//
// v1.15.2 GPU-Shift worker migration: the ENTIRE VIDEO engine (compositor,
// VideoEncoder/VideoDecoder, muxer) runs in a dedicated Web Worker; the
// main thread only receives progress ticks, muxed byte chunks (relayed to
// the preload IPC sink in Electron), logs, and the final result.
//
// THE AUDIO EXCEPTION (instruction #4 — "Audio Context Worker Check"):
// the W3C Web Audio spec exposes every Web Audio interface as
// [Exposed=Window] — OfflineAudioContext and decodeAudioData do NOT exist
// in workers (verified live in Chromium: "OfflineAudioContext is not
// defined" in a dedicated worker). So the audio arm — SFX pre-render
// (renderSfxTracks) AND the mixdown+AAC encode (AudioMixer) — runs on the
// MAIN thread with async boundaries (startRendering + the encoder's own
// threads; the video loop in the worker never waits on main-thread JS).
// The worker requests the mix ("audio-mix"); the client streams
// EncodedAudioChunk batches back ("audio-chunks", wire format — see
// AudioChunkWire) and settles with "audio-complete"/"audio-error".
//
// This module is TYPE-ONLY for the main-thread bundle (plus one protocol
// constant) so importing it costs nothing at runtime.

import type { ExportProgress } from "@/lib/merger/types";
import type { GpuTimelineExportOptions, GpuTimelineExportResult } from "./engine";
import type { AudioMixerResult, AudioTrackData } from "./AudioMixer";
import type { PrebuiltAudio } from "./audio-tracks";

/** Bump on any breaking change to this protocol (checked on 'ready'). */
export const GPU_WORKER_PROTOCOL = 2;

/**
 * Where the worker's muxed bytes go:
 *  - "relay"  — Electron with an output path: chunks postMessage back to the
 *    client, which forwards them to the preload gpu-export-* IPC sink (the
 *    append-only stream contract; ordering is guaranteed per worker).
 *  - "memory" — plain browser: the sink accumulates in worker memory and the
 *    final MP4 arrives as a transferable ArrayBuffer on 'done' (the main
 *    thread then triggers the download).
 */
export type GpuWorkerSinkMode = "relay" | "memory";

/**
 * The structured-cloneable export request: the engine options minus every
 * un-cloneable field (callbacks, AbortSignal, the injected streamer and the
 * injected cross-thread audio provider). The worker harness re-attaches
 * progress/signal/streamer shims before invoking the engine. File objects
 * inside `segments` clone natively; the prebuilt audio track list is plain
 * data computed on the MAIN thread (Web Audio is Window-only).
 */
export type GpuWorkerRunPayload = Omit<
  GpuTimelineExportOptions,
  "onProgress" | "signal" | "streamer" | "browserDelivery" | "audioProvider"
> & {
  sinkMode: GpuWorkerSinkMode;
};

/**
 * One AAC chunk over the wire — the fields needed to RECONSTRUCT an
 * EncodedAudioChunk in the worker (the chunk objects themselves are not
 * relied upon to be transferable across runtimes; the byte counts are
 * trivial at 128 kbps). `meta` mirrors EncodedAudioChunkMetadata (the first
 * chunk carries the decoderConfig with the ASC description).
 */
export interface AudioChunkWire {
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
}

/**
 * The cross-thread audio arm the worker harness injects into the engine
 * (opts.audioProvider): request the mix from the main thread, feed the
 * arriving chunks into the muxer, settle on completion. Implemented over
 * the audio-mix / audio-chunks / audio-complete / audio-error messages.
 */
export type GpuTimelineAudioProvider = (
  timelineSec: number,
  tracks: AudioTrackData[],
  onChunk: (chunk: EncodedAudioChunk, meta: EncodedAudioChunkMetadata | undefined) => void,
  signal: AbortSignal,
) => Promise<AudioMixerResult>;

/** Main thread → worker (run control + the streamed audio mix results). */
export type GpuWorkerRequest =
  | { type: "run"; payload: GpuWorkerRunPayload }
  | { type: "abort" }
  | { type: "audio-chunks"; mixId: number; chunks: AudioChunkWire[] }
  | { type: "audio-complete"; mixId: number; result: AudioMixerResult }
  | { type: "audio-error"; mixId: number; message: string };

/** Worker → main thread (progress, sink relay, logs, mix requests, result). */
export type GpuWorkerResponse =
  | { type: "ready"; protocol: number }
  | { type: "progress"; progress: ExportProgress }
  | { type: "sink-start"; path: string }
  | { type: "sink-chunk"; bytes: ArrayBuffer }
  | { type: "sink-end" }
  | { type: "log"; level: "info" | "warn" | "error"; text: string }
  | { type: "done"; result: GpuTimelineExportResult }
  | { type: "error"; name: string; message: string }
  | { type: "audio-mix"; mixId: number; timelineSec: number; tracks: AudioTrackData[] }
  | { type: "audio-mix-abort"; mixId: number };

/** Re-export so the client/worker share one PrebuiltAudio shape. */
export type { PrebuiltAudio } from "./audio-tracks";
