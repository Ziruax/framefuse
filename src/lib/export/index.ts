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
  type GpuVideoClip,
  type GpuCaptionOptions,
  type GpuExportOptions,
  type GpuExportResult,
} from "./ExportOrchestrator";
export { runGpuExportSmokeTest, type GpuSmokeTestOptions, type GpuSmokeTestResult } from "./gpu-export-demo";
