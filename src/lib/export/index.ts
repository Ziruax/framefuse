// src/lib/export/index.ts — public barrel for the v8 GPU (WebCodecs) export pipeline
// Re-exports the 4-module architecture: IPC file streamer bridge usage,
// SourceDecoder (demux+decode), AudioMixer (offline mixdown+AAC), and the
// ExportOrchestrator driver + E2E smoke test.

export { SourceDecoder, SourceDecoderError } from "./SourceDecoder";
export {
  AudioMixer,
  AudioMixerError,
  isAudioEncoderSupported,
  type AudioTrackData,
  type AudioMixerResult,
} from "./AudioMixer";
export {
  runGpuExport,
  GpuExportError,
  ExportAbortedError,
  configureVideoEncoder,
  getExportStreamer,
  ChunkSink,
  type GpuVideoClip,
  type GpuCaptionOptions,
  type GpuExportOptions,
  type GpuExportResult,
  type VideoEncoderSetup,
  type ConfiguredVideoEncoder,
  type ExportStreamerBridge,
} from "./ExportOrchestrator";
export { runGpuExportSmokeTest, type GpuSmokeTestOptions, type GpuSmokeTestResult } from "./gpu-export-demo";
// v8.1 (Task 27-a): the Export-tab engine adapter — the full-timeline
// WebCodecs renderer behind the "GPU (WebCodecs)" engine selector.
// v1.8.1 (Task 28): full multi-track compositor — overlays, chroma key and
// SFX render natively; the FFmpeg fallback is gone.
export {
  exportTimelineViaGpu,
  type GpuTimelineExportOptions,
  type GpuTimelineExportResult,
} from "./engine";
// v1.15.2 (GPU-Shift worker migration): the worker harness — the router's GPU
// entry. Runs the engine inside the dedicated worker (public/gpu-worker.js);
// the main thread only relays progress/chunks/result. Boot failures fall
// back to the in-page engine; engine failures propagate to the FFmpeg router.
export {
  runGpuTimelineExport,
} from "./gpu-worker-client";
export type {
  GpuWorkerRequest,
  GpuWorkerResponse,
  GpuWorkerRunPayload,
  GpuWorkerSinkMode,
} from "./worker-protocol";
