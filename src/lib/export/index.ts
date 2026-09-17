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
