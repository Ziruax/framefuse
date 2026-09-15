// src/lib/export/gpu-export-demo.ts — E2E smoke test for the GPU export pipeline
// Verifies the whole v8 chain in one call: mp4box demux + VideoDecoder
// configure/description (phase 1 pulls frames one per output-frame time and
// closes each immediately), then a real runGpuExport over the source as a
// single clip with a 2-cue karaoke caption fixture (phase 2 exercises canvas
// painting, caption drawing, VideoEncoder, mp4-muxer, and the ChunkSink).
// NEVER throws — always returns { ok, error? } with diagnostics. The first
// 12 muxed bytes come back so the E2E can assert the `ftyp` box signature
// (headBytes[4..8] === 'f','t','y','p').

import type { SubtitleCue, WordTimestamp } from "@/lib/merger/subtitles";
import { runGpuExport } from "./ExportOrchestrator";
import { SourceDecoder } from "./SourceDecoder";

/** Smoke-test knobs. Defaults: 24 frames @ 30 fps, VP9 encode, 640×360. */
export interface GpuSmokeTestOptions {
  frames?: number;
  videoCodec?: string;
  fps?: number;
  width?: number;
  height?: number;
}

/** Smoke-test report. `headBytes` = first 12 bytes of the muxed MP4. */
export interface GpuSmokeTestResult {
  ok: boolean;
  error?: string;
  framesDecoded: number;
  framesEncoded: number;
  muxerBytes: number;
  durationMs: number;
  headBytes: number[];
}

const DEFAULT_CODEC = "vp09.00.10.08";
const DEFAULT_FRAMES = 24;
const DEFAULT_FPS = 30;
const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 360;

function errMessage(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/** Derive the mp4-muxer container codec from a WebCodecs codec string. */
function muxerCodecFor(videoCodec: string): "avc" | "vp9" {
  return videoCodec.startsWith("vp09") || videoCodec.startsWith("vp08") ? "vp9" : "avc";
}

/**
 * Two-cue caption fixture with word timestamps so BOTH plain and karaoke
 * caption rendering are exercised across the test window.
 */
function buildCaptionFixture(durationMs: number): SubtitleCue[] {
  const mid = durationMs / 2;
  const spread = (fromMs: number, toMs: number, words: string[]): WordTimestamp[] => {
    const per = (toMs - fromMs) / words.length;
    return words.map((text, i) => ({
      text,
      startMs: fromMs + per * i,
      endMs: fromMs + per * (i + 1),
    }));
  };
  return [
    {
      id: 1,
      startMs: 0,
      endMs: mid,
      text: "GPU decode smoke test",
      words: spread(0, mid, ["GPU", "decode", "smoke", "test"]),
    },
    {
      id: 2,
      startMs: mid,
      endMs: durationMs,
      text: "WebCodecs canvas export",
      words: spread(mid, durationMs, ["WebCodecs", "canvas", "export"]),
    },
  ];
}

/**
 * Run the GPU-export smoke test against one MP4 URL. Phase 1 proves the
 * source demuxes + DECODES (the empirical validation the description builder
 * needs: zero decoded frames ⇒ the avcC description / codec config is wrong).
 * Phase 2 runs the full export pipeline and inspects the muxed head bytes.
 * All frames/decoders are closed on every exit path.
 */
export async function runGpuExportSmokeTest(
  url: string,
  opts?: GpuSmokeTestOptions,
): Promise<GpuSmokeTestResult> {
  const frames = Math.max(1, Math.round(opts?.frames ?? DEFAULT_FRAMES));
  const fps = Math.max(1, opts?.fps ?? DEFAULT_FPS);
  const videoCodec = opts?.videoCodec ?? DEFAULT_CODEC;
  const width = Math.max(2, Math.round(opts?.width ?? DEFAULT_WIDTH));
  const height = Math.max(2, Math.round(opts?.height ?? DEFAULT_HEIGHT));

  let framesDecoded = 0;
  let framesEncoded = 0;
  let muxerBytes = 0;
  let headBytes: number[] = [];

  try {
    // ── Phase 1: demux + decode probe ─────────────────────────────────────
    let sourceDurationMs = 0;
    const probe = await SourceDecoder.fromUrl(url);
    try {
      sourceDurationMs = Math.max(1, probe.durationMs);
      const testDurationMs = Math.min(sourceDurationMs, (frames / fps) * 1000);
      for (let i = 0; i < frames; i++) {
        // Clamp into the source; each request is monotonic per decoder.
        const t = Math.min((i / fps) * 1000, Math.max(0, probe.durationMs - 1));
        const frame = await probe.getFrameForTimestamp(t);
        try {
          // Touch the frame so the pull is real, then close IMMEDIATELY (the
          // user-mandated VRAM rule — exercised here too).
          if (frame.displayWidth <= 0 || frame.displayHeight <= 0) {
            throw new Error("decoded frame has no dimensions");
          }
        } finally {
          frame.close();
        }
        framesDecoded++;
      }
      if (framesDecoded === 0) {
        throw new Error("decode probe produced no frames (decoder config/description rejected?)");
      }
    } finally {
      probe.cleanup();
    }

    // ── Phase 2: full pipeline export ─────────────────────────────────────
    const clipDurationMs = Math.min(sourceDurationMs, (frames / fps) * 1000);

    const startedAt = performance.now();
    const result = await runGpuExport({
      width,
      height,
      fps,
      videoBitrate: 2_000_000,
      videoCodec,
      muxerVideoCodec: muxerCodecFor(videoCodec),
      // No outputPath ⇒ browser/dev memory mode, so result.bytes is the
      // actual muxed file (needed for the ftyp head-byte assertion).
      clips: [
        {
          source: url,
          timelineStartMs: 0,
          timelineEndMs: clipDurationMs,
          sourceInMs: 0,
        },
      ],
      captions: {
        cues: buildCaptionFixture(clipDurationMs),
        font: "700 'Arial', sans-serif",
        fontSizePx: 28,
        color: "#ffffff",
        strokeColor: "#000000",
        strokeWidthPx: 3,
        backgroundColor: "rgba(0, 0, 0, 0.55)",
        karaokeHighlight: "#ffe14d",
      },
      onProgress: (frameIndex) => {
        framesEncoded = Math.max(framesEncoded, frameIndex + 1);
      },
    });
    const durationMs = Math.round(performance.now() - startedAt);

    framesEncoded = result.framesEncoded;
    muxerBytes = result.bytes.byteLength;
    headBytes = Array.from(result.bytes.subarray(0, 12));

    if (framesEncoded < 1) throw new Error("export encoded zero frames");
    if (muxerBytes < 12) throw new Error(`muxed output too small (${muxerBytes} bytes)`);
    // ftyp box: bytes[4..8] must be the fourcc 'ftyp'.
    if (
      headBytes[4] !== 0x66 || // 'f'
      headBytes[5] !== 0x74 || // 't'
      headBytes[6] !== 0x79 || // 'y'
      headBytes[7] !== 0x70 // 'p'
    ) {
      throw new Error("muxed output does not start with an ftyp box");
    }

    return { ok: true, framesDecoded, framesEncoded, muxerBytes, durationMs, headBytes };
  } catch (e) {
    return {
      ok: false,
      error: errMessage(e),
      framesDecoded,
      framesEncoded,
      muxerBytes,
      durationMs: 0,
      headBytes,
    };
  }
}
