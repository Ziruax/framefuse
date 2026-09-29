// src/lib/export/engine.ts — the Export-tab GPU (WebCodecs) engine adapter.
// Task 27-a: makes the v8 pipeline (SourceDecoder → canvas → VideoEncoder →
// mp4-muxer, streamed to disk over IPC) a FIRST-CLASS, user-selectable export
// engine so "FFmpeg Smart" vs "GPU (WebCodecs)" can be A/B tested from the
// Export tab.
//
// v1.8.1 (Task 28-c) — FULL multi-track compositor: the overlay/SFX/chroma
// FFmpeg fallback is GONE. The engine now renders every timeline feature
// natively in the GPU Canvas loop, exactly mirroring PreviewPanel's paint
// order (base → overlay lanes → watermark → headlines → captions → global
// fades):
//   • overlay-lane clips (video through per-segment SourceDecoder streams,
//     images through the shared cache) at the overlayGeometry rect, with
//     motion-keyframe sampling and overlayLoop source-time wrapping;
//   • chroma keying through the SAME WebGL ChromaKeyer the preview uses
//     (VideoFrames feed texImage2D directly — zero-copy on the GPU);
//   • SFX + overlay (PIP) audio in the AudioMixer multi-lane mixdown.
//
// This adapter takes the SAME ExportNativeOptions-shaped input exportNative
// takes and renders the FULL timeline exactly like the proven browser path in
// native.ts (exportViaWebCodecs): Ken Burns images + cover-fit videos with
// the same transition/fade treatment → overlays → watermark → headlines →
// captions (all word modes + kinetic animations, via the SAME drawCaption) →
// global fades. Differences from the browser path, by design:
//   • FULL output resolution (no 720p cap — that cap is browser-legacy),
//   • VIDEO segments decode through SourceDecoder (mp4box → VideoDecoder)
//     instead of HTMLVideoElement replay,
//   • muxed bytes stream to disk in ~5 MB IPC chunks in Electron (ChunkSink +
//     StreamTarget + fastStart:"fragmented" — the proven append-only contract)
//     instead of an in-memory ArrayBufferTarget,
//   • audio (music + clip audio + PIP audio + SFX) mixes through AudioMixer
//     when AAC encode is available; otherwise the export degrades to
//     video-only with audioSkipped:true so the UI can warn.
//
// v1.15.2 (GPU-Shift worker migration): this module now executes INSIDE a
// dedicated Web Worker (gpu-export-worker.ts bundles it to the
// self-contained public/gpu-worker.js) — compositing, VideoDecoder and the
// VideoEncoder all run OFF the main thread; the page only receives progress
// ticks, muxed chunks and the result via postMessage (gpu-worker-client.ts).
// Thread abstractions: createPaintSurface/OffscreenCanvas, ImageBitmap image decode
// (fetch + createImageBitmap — no HTMLImageElement in workers), the
// injected `streamer` relay (opts.streamer overrides the window probe),
// browserDelivery:"bytes" (the main thread triggers the download), the
// PREBUILT audio track list + the cross-thread `audioProvider` (Web Audio
// is [Exposed=Window] — the mixdown + AAC encode run on the main thread
// with async boundaries, chunks stream back into this muxer). The engine
// STILL runs on the main thread as the documented fallback when the worker
// bundle cannot be constructed.
//
// VRAM RULE (user-mandated, same as the other v8 modules): every VideoFrame
// created, cloned, or received is .close()d immediately after its last use on
// EVERY path (draw-finally, encode-finally, decoder cleanup). Each close site
// is commented with ⚠.

import { Muxer, StreamTarget } from "mp4-muxer";
import type {
  ExportNativeOptions,
  ExportProgress,
  ExportResult,
  MediaSegment,
  OverlayTransform,
} from "@/lib/merger/types";
import {
  applyGlobalFade,
  computeGlobalFade,
  computeTransitionFx,
  createPaintSurface,
  drawFrameWithTransition,
  drawVideoFrame,
  drawWatermark,
  get2DContext,
  overlayGeometry,
  paintSourceSize,
  resolveDimensions,
  sampleOverlayMotion,
  type VideoFrameSource,
} from "@/lib/merger/renderer";
import {
  browserQualityBitrate,
  drawCaption,
  drawHeadline,
  triggerDownload,
  type CanvasCaptionCtx,
} from "@/lib/merger/native";
import { cueAt } from "@/lib/merger/subtitles";
import { segmentAtTime, overlaySegmentsAt } from "@/lib/merger/timeline";
import { ChromaKeyer } from "@/lib/merger/chroma";
import { SourceDecoder } from "./SourceDecoder";
import { AudioMixer, isAudioEncoderSupported, type AudioTrackData } from "./AudioMixer";
import { buildAudioTracks, renderSfxTracks, videoSourceUrl, type PrebuiltAudio } from "./audio-tracks";
import type { GpuTimelineAudioProvider } from "./worker-protocol";
import {
  ChunkSink,
  ExportAbortedError,
  GpuExportError,
  configureVideoEncoder,
  getExportStreamer,
} from "./ExportOrchestrator";

/** Full export request: the exact shape `exportNative` takes, plus the
 * Electron output path (chooseOutput). In a plain browser `outputPath` is
 * null/undefined and the muxed bytes are delivered as a download instead. */
export interface GpuTimelineExportOptions extends ExportNativeOptions {
  outputPath?: string | null;
  /** v1.8.2: skip the prefer-hardware encoder rung (Export-tab diagnostics
   * toggle — mirrors the FFmpeg force-encoder bypass for driver stalls). */
  forceSoftware?: boolean;
  /** v1.15.2 (worker migration): the INJECTED byte streamer. When defined
   * (bridge or null) it overrides the window.electronAPI probe — the worker
   * harness passes a postMessage relay shim (Electron) or null (browser
   * memory mode). Undefined = probe the window (main-thread runs). */
  streamer?: ExportStreamerBridge | null;
  /** v1.15.2: "bytes" returns the muxed MP4 in result.bytes (worker browser
   * mode — the MAIN thread performs the download); "download" (default)
   * triggers the download inside the engine (main-thread fallback runs). */
  browserDelivery?: "download" | "bytes";
  /** v1.15.2 (worker path): the track list + SFX blob URLs PREBUILT on the
   * main thread — Web Audio is [Exposed=Window] (OfflineAudioContext and
   * decodeAudioData do not exist in workers; spec-verified), so SFX
   * rendering and track-list construction run where Web Audio lives. The
   * CLIENT owns + revokes the sfxBlobUrls; the engine consumes the tracks
   * without re-computing. Absent (main-thread fallback) → the engine
   * computes them itself, exactly as in v1.15.1. */
  prebuiltAudio?: PrebuiltAudio | null;
  /** v1.15.2 (worker path): the CROSS-THREAD audio arm — the mixdown + AAC
   * encode run on the MAIN thread (AudioMixer; async boundaries: the
   * OfflineAudioContext render + the AudioEncoder ride their own native
   * threads, the main thread only relays chunks) and the encoded chunks
   * stream back here into the muxer. Absent → the engine runs the
   * in-context AudioMixer (the v1.15.1 direct path). */
  audioProvider?: GpuTimelineAudioProvider;
}

/** Result of a GPU-engine export — the ExportResult the UI already renders,
 * plus the frames-encoded count and the audio-degradation flag. */
export interface GpuTimelineExportResult extends ExportResult {
  /** True when audio existed but AAC (mp4a.40.2) encode is unavailable in
   * this runtime (e.g. the open-source Chromium sandbox build) — the export
   * completed VIDEO-ONLY so the UI can toast a warning. */
  audioSkipped?: boolean;
  framesEncoded: number;
  /** v1.8.2: true when the HARDWARE encoder accepted the stream but produced
   * no output (driver stall) and the engine automatically restarted the whole
   * pass on the software rung — the UI explains instead of failing. */
  softwareFallback?: boolean;
  /** v1.15.2: the muxed MP4 when browserDelivery:"bytes" (worker browser
   * mode — a TRANSFERABLE that rode the 'done' message, zero-copied). */
  bytes?: ArrayBuffer;
  /** v1.15.2: mean ms/frame of PURE JS compositing (the paint wall minus
   * decoder waits — drawImage blends, Ken Burns math, text raster). This is
   * the number a GLSL/WebGPU shader migration (v1.16) would attack; high on
   * complex timelines = the shader migration pays. */
  jsCompositorOverheadMs?: number;
  /** v1.15.2: mean ms/frame spent AWAITING decoded source frames (the
   * mp4box→VideoDecoder arm) — the decode-side twin of the compositor cost. */
  gpuDecodeWaitMs?: number;
  /** v1.15.2: which execution context ran the engine — set by the worker
   * client ("worker" | "main-thread"), surfaced for telemetry + E2E. */
  workerRuntime?: "worker" | "main-thread";
  /** v1.15.3 (lie detector): which encoder rung ACTUALLY ran —
   * "require-hardware" = a hardware encoder is PROVEN in use (the platform
   * answered the probe); "prefer-hardware" = hardware requested but
   * unverifiable (legacy runtime without the require-hardware enum);
   * "software"/"plain" = software by construction. The A/B bench, toast and
   * Header tooltip carry it — "WebCodecs is slow" reports become
   * diagnosable at a glance. */
  hwEncoder?: "require-hardware" | "prefer-hardware" | "software" | "plain";
  /** v1.15.3: the platform's own rejection reason when the require-hardware
   * probe failed (harvested DOMException message) — the field diagnostic. */
  hwRejectReason?: string;
}

/** Overlay-lane items without an explicit geometry render centered at 60%
 * output width — MUST stay in lockstep with PreviewPanel's and page.tsx's
 * DEFAULT_OVERLAY_TRANSFORM (page writes it into the item's edit on every
 * lane switch, so the exported composite matches by construction). */
const DEFAULT_OVERLAY_TRANSFORM: OverlayTransform = {
  scalePercent: 60,
  position: "center",
};

/** Encoder backpressure: pause the paint loop above this many queued
 * frames. v1.15.3 (user directive, Step 4): 30 → 5 — a deep queue only
 * inflates memory pressure (each queued VideoFrame is 1920×1080 of pixel
 * storage) without adding throughput; with a hardware encoder the queue
 * drains at ASIC speed and never reaches 5, with a slow software encoder
 * the loop is encoder-bound either way — the lower cap just stops the
 * balloon. The watchdog below still catches a wedged driver. */
const MAX_ENCODE_QUEUE = 5;

/**
 * v1.8.2 — encoder-output watchdog: a hardware VideoEncoder that ACCEPTS
 * frames but never emits chunks (broken iGPU driver — exactly what the forced
 * GPU flags can expose on old Intel boxes) used to spin the backpressure loop
 * at 0% FOREVER with no error. If the encoder produces no output for this
 * long while frames are queued, the pass fails — and at frame 0 the engine
 * retries once on the software rung before giving up.
 */
const ENCODER_STALL_MS = 12_000;

/**
 * v1.8.2 — internal: an encode-pass failure carrying the context the retry
 * rule needs (which rung was active, whether anything was already muxed —
 * a restart is only lossless while ZERO frames reached the muxer).
 */
class GpuEncodePassError extends GpuExportError {
  constructor(
    message: string,
    readonly hardware: boolean,
    readonly framesEncoded: number,
  ) {
    super(message);
    this.name = "GpuEncodePassError";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function clampNum(v: number | undefined, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.max(lo, Math.min(hi, n));
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Load an image as a drawable ImageBitmap (v1.15.2 worker migration).
 * Works on BOTH threads: the worker has no HTMLImageElement, so fetch +
 * createImageBitmap is the thread-neutral twin of the browser path's
 * `new Image()`. ImageBitmap satisfies both drawImage (CanvasImageSource)
 * and the chroma keyer's texImage2D (TexImageSource). */
async function loadImageBitmap(url: string): Promise<ImageBitmap | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

/**
 * exportTimelineViaGpu — render the whole FrameFuse timeline (base lane +
 * overlay lanes + chroma + SFX) through the WebCodecs + Canvas pipeline and
 * mux an H.264 MP4. Never falls back to FFmpeg.
 */
export async function exportTimelineViaGpu(
  opts: GpuTimelineExportOptions,
): Promise<GpuTimelineExportResult> {
  const startedAt = performance.now();
  const {
    segments,
    imageUrls,
    settings,
    kenBurns,
    totalMs,
    onProgress,
    signal,
    subtitles,
    captionSettings,
  } = opts;

  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") {
    throw new GpuExportError(
      "WebCodecs (VideoEncoder/VideoFrame) is unavailable in this runtime — " +
        "the GPU engine needs a Chromium-based browser or the FrameFuse desktop app",
    );
  }
  if (!segments || segments.length === 0) {
    throw new GpuExportError("GPU export needs at least one segment");
  }

  // FULL output resolution — no 720p cap (that cap is browser-legacy).
  const dims = resolveDimensions(settings.aspect, settings.resolution);
  const fps = settings.fps;
  const totalSec = totalMs / 1000;
  if (!(totalSec > 0)) throw new GpuExportError("GPU export timeline is empty (totalMs ≤ 0)");
  const totalFrames = Math.max(1, Math.round(totalSec * fps));
  const frameDurationUs = Math.round(1e6 / fps);
  const keyInterval = Math.max(1, Math.round(fps * 2));

  const canvas = createPaintSurface(dims.w, dims.h);
  // v1.15.3 (user directive, Step 3 — the canvas readback penalty):
  // desynchronized + willReadFrequently:false + alpha:false (the default)
  // request the GPU-resident low-latency path for the export stage — the
  // browser skips unnecessary sync fences and never CPU-readies the surface
  // for getImageData we never do. The VideoFrame(canvas) construction below
  // is the only read, and it takes the fast texture path.
  const ctx = get2DContext(canvas, false, { desynchronized: true, willReadFrequently: false });
  if (!ctx) throw new GpuExportError("failed to acquire a 2d context on the export canvas");

  // ── Audio gate: build the track list, then check AAC support BEFORE the
  // muxer is constructed (an mp4 with a declared-but-empty audio track would
  // be unplayable). Sandbox Chromium has no AAC → video-only + audioSkipped.
  // v1.8.1: the list includes SFX + PIP (overlay) clip audio.
  // v1.15.2 (worker path): the list + SFX WAVs are PREBUILT on the main
  // thread (Web Audio is [Exposed=Window] — spec-verified; workers have no
  // OfflineAudioContext/decodeAudioData, so renderSfxTracks cannot run
  // here). The engine recomputes them only on the main-thread fallback run.
  const masterVolume = clampNum(opts.audio?.masterVolume, 0, 2, 1);
  const sfxBlobUrls: string[] = []; // engine-owned URLs (compute branch only)
  let audioTracks: AudioTrackData[];
  if (opts.prebuiltAudio) {
    audioTracks = opts.prebuiltAudio.tracks;
  } else {
    const sfxTracks = await renderSfxTracks(opts, masterVolume, sfxBlobUrls);
    audioTracks = buildAudioTracks(opts, sfxTracks);
  }
  const audioSupported = audioTracks.length > 0 ? await isAudioEncoderSupported() : false;
  const audioSkipped = audioTracks.length > 0 && !audioSupported;
  const activeAudioTracks = audioSupported ? audioTracks : [];

  // ── Image preload (imgCache pattern from the browser path). v1.15.2:
  // decoded to ImageBitmaps — fetchable + decodable on BOTH threads (the
  // worker has no `new Image()`), and ImageBitmap feeds drawImage AND the
  // chroma keyer's texImage2D. blob: URLs created on the main thread are
  // fetchable from same-agent-cluster dedicated workers in Chromium.
  const imgCache = new Map<string, VideoFrameSource>();
  await Promise.all(
    segments
      .filter((seg) => seg.mediaType !== "video")
      .map(async (seg) => {
        const url = imageUrls[seg.id] || seg.thumbnailUrl;
        if (typeof url !== "string" || url.length === 0) return;
        const bmp = await loadImageBitmap(url);
        if (bmp) imgCache.set(seg.id, bmp);
        else
          console.warn(
            `[framefuse] GPU export: image "${seg.fileName || seg.id}" failed to decode — its frames render as the dark backdrop`,
          );
      }),
  );

  // ── Output sink: IPC stream (Electron + outputPath) or in-memory. ──────
  // v1.8.2: the sink (and its exportStart/exportEnd session) is PER ENCODE
  // PASS — the hardware→software retry re-runs bridge.exportStart, and the
  // main-process handler truncates + reopens the file, so a failed pass's
  // partial bytes never leak into the final output.
  // v1.15.2: `opts.streamer` (when defined) overrides the window probe — the
  // worker harness injects its postMessage relay shim; null = memory mode.
  const bridge = opts.streamer !== undefined ? opts.streamer : getExportStreamer();
  const outputPath =
    typeof opts.outputPath === "string" && opts.outputPath.length > 0 ? opts.outputPath : null;
  const useIpc = bridge !== null && outputPath !== null;

  // ── Source decoders — TWO maps so concurrent consumers never interleave
  // requests on ONE SourceDecoder (v1.8.1): the base lane and an overlay
  // lane are active at the SAME timestamp, and interleaved non-monotonic
  // requests would rewind-storm a shared decoder (rewind = full re-decode).
  //   • base: shared per unique source URL/File — base windows are
  //     sequential, so exactly one consumer is active at a time; a re-used
  //     source rewinds ONCE on re-entry (the documented SourceDecoder path);
  //   • overlays: one decoder per SEGMENT — stacked overlay lanes of the
  //     same source each get their own monotonic decode stream.
  // Both are created lazily on first use and released eagerly once no
  // remaining segment window needs them (the loop walks time monotonically).
  const baseDecoders = new Map<string, SourceDecoder>();
  const overlayDecoders = new Map<string, SourceDecoder>();
  const sourceKeyOf = (seg: MediaSegment): string | null => {
    const url = videoSourceUrl(seg, imageUrls);
    if (url) return url;
    return seg.file ? `file:${seg.id}` : null;
  };
  const createDecoder = async (seg: MediaSegment): Promise<SourceDecoder> => {
    const url = videoSourceUrl(seg, imageUrls);
    // v1.8.2: a URL that EXISTS but can't be fetched (a revoked object URL —
    // dev-server HMR remounts do exactly this) falls back to the item's File
    // instead of failing the whole export.
    if (url != null) {
      try {
        return await SourceDecoder.fromUrl(url);
      } catch (e) {
        if (!seg.file) throw e;
        console.warn(
          `[framefuse] GPU export: source URL unfetchable (${errMessage(e)}) — decoding "${seg.fileName || seg.id}" from its File instead`,
        );
      }
    }
    if (seg.file) return SourceDecoder.fromBuffer(await (seg.file as File).arrayBuffer());
    throw new GpuExportError(
      `video segment "${seg.fileName || seg.id}" has no readable source (no URL and no File)`,
    );
  };
  const getBaseDecoder = async (seg: MediaSegment): Promise<SourceDecoder> => {
    const key = sourceKeyOf(seg);
    if (!key) return createDecoder(seg); // error path (no source) — throws above
    const existing = baseDecoders.get(key);
    if (existing) return existing;
    const created = await createDecoder(seg);
    baseDecoders.set(key, created);
    return created;
  };
  const getOverlayDecoder = async (seg: MediaSegment): Promise<SourceDecoder> => {
    const key = `ov:${seg.id}`;
    const existing = overlayDecoders.get(key);
    if (existing) return existing;
    const created = await createDecoder(seg);
    overlayDecoders.set(key, created);
    return created;
  };
  // The LAST BASE segment stays eligible past its end (segmentAtTime's tail
  // fallback freezes on it when totalMs exceeds the last base endMs — totalMs
  // spans ALL lanes, so overlay windows can extend past the base end) — its
  // decoder must never be eagerly released.
  const lastBaseSeg =
    [...segments].reverse().find((s) => (s.track ?? 0) === 0 && s.mediaType === "video") ?? null;
  const lastBaseKey = lastBaseSeg ? sourceKeyOf(lastBaseSeg) : null;

  // ── Encoder: the shared hardware→software ladder, full-res codec string. ──
  const bitrate = Math.round(browserQualityBitrate(settings));
  // H.264 profile for the resolution — the browser path's logic WITHOUT the
  // 720p constraint: Constrained Baseline (L3.0) for frames STRICTLY below
  // 720p, High L4.0 at 720p and above (v1.8.1 fix: exactly-1280x720@30
  // exceeds L3.0's macroblock budget — 42E01E there is out-of-spec and some
  // runtimes correctly refuse it; 640028 is the level-correct choice).
  const videoCodec = dims.w * dims.h < 1280 * 720 ? "avc1.42E01E" : "avc1.640028";

  // v1.8.1: ONE shared WebGL chroma keyer for the whole export (the
  // preview's pattern — composite() reconfigures its offscreen canvas to
  // the dest rect per call). Disposed in the finally below.
  const keyer = new ChromaKeyer();

  // ── v1.8.2 progress plumbing: stage-aware heartbeat. ────────────────────
  // A 19-minute timeline spends real seconds BEFORE the first frame encodes
  // (source fetch + demux + first-frame decode, encoder setup) — an
  // integer-percent bar showed a frozen "0%" the whole time, which read as
  // "not working". The heartbeat re-emits at ~1.4 Hz whenever the frame loop
  // goes quiet, carrying the coarse stage + frame counter + elapsed so the
  // UI can always show life (and the header now shows decimals below 10%).
  let stage: ExportProgress["stage"] = "preparing";
  let framesEncoded = 0;
  // v1.15.1 GPU-Shift telemetry: per-frame composite + encode-submit cost
  // (ms, summed over the FINAL pass only — the software-rung retry resets
  // it alongside framesEncoded). This is the number the FFmpeg CPU pipeline
  // must lose to: mean frame cost × total frames ≈ the GPU render wall.
  let framePaintMs = 0;
  // v1.15.2 telemetry split (user directive: "add a telemetry metric
  // specifically for jsCompositorOverheadMs"): the paint wall decomposed
  // into PURE JS compositing (drawImage blends, Ken Burns math, text
  // raster — the number the v1.16 GLSL/WebGPU shader migration attacks) and
  // decoder waits (mp4box→VideoDecoder arms). gpuFrameRenderMs keeps its
  // v1.15.1 meaning: composite + encode-submit, backpressure excluded.
  let frameCompositeMs = 0;
  let frameDecodeMs = 0;
  let lastEmitAt = 0;
  const emitProgress = (force = false): void => {
    const now = performance.now();
    if (!force && now - lastEmitAt < 200) return;
    lastEmitAt = now;
    const elapsedSec = Math.max(0.001, (now - startedAt) / 1000);
    onProgress?.({
      progress: Math.min(100, (framesEncoded / totalFrames) * 100),
      ...(framesEncoded > 0 ? { fps: Math.round(framesEncoded / elapsedSec) } : {}),
      stage,
      framesEncoded,
      totalFrames,
      // v1.15.1: renamed to `elapsed` — the v1.14.2 ExportProgress contract
      // the FFmpeg path already speaks (same seconds, same UI consumer).
      elapsed: Math.round(elapsedSec * 10) / 10,
    });
  };
  const heartbeat = setInterval(() => {
    if (performance.now() - lastEmitAt > 650) emitProgress(true);
  }, 700);

  const cleanupDecoders = (): void => {
    for (const decoder of baseDecoders.values()) decoder.cleanup();
    baseDecoders.clear();
    for (const decoder of overlayDecoders.values()) decoder.cleanup();
    overlayDecoders.clear();
  };
    // Scratch canvas for the transition composite + global fades (the
    // browser path's twin). v1.15.2: OffscreenCanvas inside the worker.
    const scratch = createPaintSurface(dims.w, dims.h);
    const sctx = get2DContext(scratch, false, { desynchronized: true, willReadFrequently: false });

    // Caption draw closure — the SAME capCtx construction as the browser
    // path (word modes + kinetic animations render identically).
    const drawCaptions =
      captionSettings?.enabled && subtitles && subtitles.cues.length > 0
        ? (currentMsLocal: number) => {
            const cue = cueAt(subtitles.cues, currentMsLocal);
            if (!cue) return;
            const capCtx: CanvasCaptionCtx = {
              ...captionSettings,
              words: cue.words,
              currentMs: currentMsLocal,
              cueStartMs: cue.startMs,
              cueEndMs: cue.endMs,
            };
            drawCaption(ctx, cue.text, capCtx, dims.w, dims.h);
          }
        : null;
    const headlineItems =
      opts.headlines && opts.headlines.length > 0 ? opts.headlines : null;
    const transition = opts.transition ?? null;
    const wmImage = opts.watermark?.imageUrl
      ? await loadImageBitmap(opts.watermark.imageUrl)
      : null;
    const wmSettings = opts.watermark?.settings ?? null;

    /**
     * v1.8.2 — ONE complete encode pass: sink → muxer → encoder ladder →
     * concurrent audio → frame loop → flush → finalize. Called up to twice:
     * pass 1 rides the ladder's hardware rung (unless `forceSoftware`), and
     * when the HARDWARE encoder stalls or fatals while ZERO frames have been
     * muxed, the engine retries the whole pass on the software rung — a
     * lossless restart (nothing reached the output; bridge.exportStart
     * truncates + reopens the file on disk).
     */
    const runEncodePass = async (
      passForceSoftware: boolean,
    ): Promise<{
      hardware: boolean;
      rung: "require-hardware" | "prefer-hardware" | "software" | "plain";
      hwRejectReason?: string;
      byteCount: number;
      resultPath: string;
      bytes?: ArrayBuffer;
    }> => {
    const sink = new ChunkSink(useIpc ? bridge : null);
    if (useIpc && bridge && outputPath) {
      bridge.exportStart(outputPath);
    }

    // ── Muxer (the PROVEN streamable config from ExportOrchestrator). ──────
    // fastStart:"fragmented" (NOT false): mp4-muxer's finalize() backward-
    // patches the mdat size with fastStart:false — un-streamable over the
    // append-only IPC file stream. Fragmented MP4 is strictly append-only.
    const muxer = new Muxer({
      target: new StreamTarget({
        // ⚠ mp4-muxer 5.2.2 arity-validates onData — it MUST declare BOTH
        // (data, position) parameters or the constructor throws a TypeError.
        onData: (data: Uint8Array, position: number): void => {
          sink.push(data, position);
        },
      }),
      video: { codec: "avc", width: dims.w, height: dims.h, frameRate: fps },
      audio:
        activeAudioTracks.length > 0
          ? { codec: "aac", numberOfChannels: 2, sampleRate: 48000 }
          : undefined,
      fastStart: "fragmented",
      minFragmentDuration: 1,
    });

    let encoderFatal: unknown = null;
    let videoEncoder: VideoEncoder | null = null;
    let encoderClosed = false;
    // v1.15.3 lie-detector state — which rung configured THIS pass's encoder
    // (pass 2 after a GPU-stall retry reports its own, software, rung).
    let passRung: "require-hardware" | "prefer-hardware" | "software" | "plain" = "software";
    let passHwRejectReason: string | undefined;
    let audioPromise: Promise<unknown> | null = null;
    let audioCompleted = false;
    const audioCtl = new AbortController();
    // v1.8.2 watchdog state — refreshed on EVERY encoder output chunk. A
    // hardware encoder that accepts frames but never emits (broken iGPU
    // driver) is indistinguishable from a slow one WITHOUT this counter.
    let outputCount = 0;
    let lastOutputAt = performance.now();
    const passStartedAt = lastOutputAt;

    try {
      const { encoder, hardware, rung, hwRejectReason } = await configureVideoEncoder(
        { width: dims.w, height: dims.h, fps, videoBitrate: bitrate, videoCodec, forceSoftware: passForceSoftware },
        (chunk, meta) => {
          muxer.addVideoChunk(chunk, meta);
          outputCount++;
          lastOutputAt = performance.now();
        },
        (e) => {
          encoderFatal = e;
        },
      );
      videoEncoder = encoder;
      passRung = rung;
      passHwRejectReason = hwRejectReason;

      // Audio renders CONCURRENTLY with the frame loop (runGpuExport's proven
      // pattern): chunks flow straight into the muxer, the promise is awaited
      // after the loop, before flush. v1.8.2: the per-pass AbortSignal lets a
      // retried pass stop this one's AAC encode instead of zombie-ing it.
      // v1.15.2 (worker path): `opts.audioProvider` runs the mixdown + AAC
      // encode on the MAIN THREAD (Web Audio is Window-only) and streams the
      // encoded chunks back into this muxer — the async-boundary rule: the
      // video loop here never waits on main-thread JS, and the main thread
      // never runs the engine.
      if (activeAudioTracks.length > 0) {
        const onChunk = (chunk: EncodedAudioChunk, meta: EncodedAudioChunkMetadata | undefined) => {
          muxer.addAudioChunk(chunk, meta);
        };
        const p = opts.audioProvider
          ? opts.audioProvider(totalSec, activeAudioTracks, onChunk, audioCtl.signal)
          : new AudioMixer(onChunk).renderAudio(totalSec, activeAudioTracks, audioCtl.signal);
        // Swallow-side handler: if the video loop aborts/errors BEFORE this
        // promise is awaited, its eventual rejection would otherwise surface
        // as an unhandled rejection. Attaching a catch does not consume the
        // rejection — the success path's `await` still sees and rethrows it.
        p.catch(() => {
          /* surfaced by the awaiting path, or the pass already failed */
        });
        audioPromise = p;
      }

      stage = "encoding";
      emitProgress(true);

    for (let i = 0; i < totalFrames; i++) {
      if (signal?.aborted) throw new ExportAbortedError();
      if (encoderFatal) {
        throw new GpuEncodePassError(
          `video encoder failed: ${errMessage(encoderFatal)}`,
          hardware,
          framesEncoded,
        );
      }
      // v1.8.2 watchdog (case 1): frames are flowing into the encoder but
      // NOTHING has come out since the pass began — a wedged hardware
      // encoder. Only armed once a few frames are queued so a slow FIRST
      // decode (deep trims) can't false-positive it.
      if (
        outputCount === 0 &&
        framesEncoded >= 8 &&
        performance.now() - passStartedAt > ENCODER_STALL_MS
      ) {
        throw new GpuEncodePassError(
          `the ${hardware ? "hardware" : "software"} video encoder accepted frames but produced no output for ${Math.round(ENCODER_STALL_MS / 1000)}s` +
            (hardware ? " (GPU driver stall)" : ""),
          hardware,
          framesEncoded,
        );
      }

      // v1.15.1: yield to the event loop every few frames — the canvas
      // paint + encode submit run in the GPU process, but a fully-synchronous
      // loop (pure-image timelines touch no await between frames) would
      // freeze the renderer UI for the whole export. 1 ms every 4 frames.
      if ((i & 3) === 0) await delay(0);

      const currentMs = (i / fps) * 1000;

      // Backpressure: don't let the encoder queue grow without bound.
      while (videoEncoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
        if (signal?.aborted) throw new ExportAbortedError();
        if (encoderFatal) {
          throw new GpuEncodePassError(
            `video encoder failed: ${errMessage(encoderFatal)}`,
            hardware,
            framesEncoded,
          );
        }
        // v1.8.2 watchdog (case 2): the queue is full AND the encoder
        // hasn't emitted a chunk in ENCODER_STALL_MS — without this check
        // a wedged driver spun here FOREVER at 0% with no error.
        if (performance.now() - lastOutputAt > ENCODER_STALL_MS) {
          throw new GpuEncodePassError(
            `the ${hardware ? "hardware" : "software"} video encoder stalled — no output for ${Math.round(ENCODER_STALL_MS / 1000)}s while ${videoEncoder.encodeQueueSize} frames were queued` +
              (hardware ? " (GPU driver stall)" : ""),
            hardware,
            framesEncoded,
          );
        }
        await delay(2); // v1.15.3 (user directive, Step 4): tight 2 ms yield — the encoder drains on its own threads
      }

      // v1.15.1 telemetry: the paint clock starts AFTER backpressure — only
      // composite + encode-submit time counts (waiting on a slow encoder is
      // not "rendering" cost). v1.15.2: the wall is decomposed into pure
      // compositing vs decoder waits (jsCompositorOverheadMs / gpuDecodeWaitMs).
      const framePaintT0 = performance.now();
      let decodeMsThisFrame = 0;

      // Active BASE segment — the preview's exact track-aware resolution
      // (segmentAtTime: base lane only, tail fallback to the last base
      // segment — overlays never leak into the base paint).
      const seg = segmentAtTime(segments, currentMs);
      const segIdx = seg ? Math.max(0, segments.findIndex((s) => s.id === seg.id)) : -1;

      if (seg) {
        if (seg.mediaType === "video") {
          // VIDEO base — cover-fit via drawVideoFrame, NO Ken Burns (the
          // video's own motion is the content — the preview + FFmpeg rule).
          // The v5 VIDEO RULE makes xfade heads hard cuts at video
          // boundaries, so only dip heads can be active — composited here
          // manually exactly like PreviewPanel's video-base branch.
          const decoder = await getBaseDecoder(seg);
          const sourceTimeMs =
            (currentMs - seg.startMs) * (seg.speed || 1) + (seg.trimInMs || 0);
          // Caller-owned CLONE — closed immediately after ALL draws for this
          // frame are done (⚠ VRAM rule; finally covers the draw throws).
          // v1.15.2: the decode await counts toward gpuDecodeWaitMs, not the
          // compositor bucket.
          const decodeT0 = performance.now();
          const frame = await decoder.getFrameForTimestamp(sourceTimeMs);
          decodeMsThisFrame += performance.now() - decodeT0;
          try {
            const fx = computeTransitionFx(segments, segIdx, currentMs, transition);
            if (fx.kind === "dip-head" && sctx) {
              drawVideoFrame(sctx, frame, dims.w, dims.h, "cover");
              ctx.setTransform(1, 0, 0, 1, 0, 0);
              ctx.fillStyle = fx.dipColor === "white" ? "#ffffff" : "#000000";
              ctx.fillRect(0, 0, dims.w, dims.h);
              ctx.globalAlpha = fx.p;
              ctx.drawImage(scratch, 0, 0);
              ctx.globalAlpha = 1;
            } else {
              drawVideoFrame(ctx, frame, dims.w, dims.h, "cover");
            }
          } finally {
            frame.close(); // ⚠ immediately after last use — no path leaks it
          }
        } else {
          // IMAGE base — Ken Burns + the full transition composite (during a
          // crossfade window drawFrameWithTransition also sources the PREVIOUS
          // segment's image from imgCache; video neighbors are hard cuts per
          // the v5 VIDEO RULE, so the neighbor is always an image).
          const img = imgCache.get(seg.id) ?? null;
          drawFrameWithTransition(
            ctx,
            scratch,
            seg,
            segIdx,
            segments,
            img,
            imgCache,
            currentMs,
            dims.w,
            dims.h,
            kenBurns,
            transition,
          );
        }
      } else {
        // No base segment at this time (an all-overlay timeline, or a base
        // gap before the first beat) — the preview's dark-gray backdrop.
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = "#0a0a0a";
        ctx.fillRect(0, 0, dims.w, dims.h);
      }

      // ── OVERLAY lanes (v1.8.1) — the preview's exact z-order: every
      // active overlay paints on top of the base in track→start order.
      // Video overlays decode through their own per-segment SourceDecoder
      // stream (concurrent with the base decoder); image overlays come from
      // imgCache. Motion keyframes animate the rect; overlayLoop wraps
      // source time modulo the source duration (the -stream_loop -1 twin).
      // Chroma-keyed clips run through the SAME WebGL keyer the preview
      // uses (VideoFrame feeds texImage2D directly); composite() false →
      // plain drawImage fallback. Every decoded frame is closed in the
      // finally below on EVERY path (⚠ VRAM rule).
      const activeOverlays = overlaySegmentsAt(segments, currentMs);
      for (const ov of activeOverlays) {
        let owned: VideoFrame | null = null;
        try {
          // Paint source union: every member satisfies BOTH CanvasImageSource
          // (drawImage) and TexImageSource (the keyer's texImage2D).
          let src: VideoFrameSource | null = null;
          if (ov.mediaType === "video") {
            const ovDecodeT0 = performance.now();
            const decoder = await getOverlayDecoder(ov);
            const speed = ov.speed || 1; // overlays resolve speed 1 by design
            let localMs = (ov.trimInMs || 0) + (currentMs - ov.startMs) * speed;
            if (ov.overlayLoop && ov.sourceDurationMs && ov.sourceDurationMs > 0) {
              const dur = ov.sourceDurationMs;
              localMs = ((localMs % dur) + dur) % dur;
            }
            owned = await decoder.getFrameForTimestamp(Math.max(0, localMs));
            decodeMsThisFrame += performance.now() - ovDecodeT0; // v1.15.2
            src = owned;
          } else {
            // v1.15.2: imgCache holds ImageBitmaps (worker-safe decode) — a
            // first-class VideoFrameSource member, no cast needed.
            src = imgCache.get(ov.id) ?? null;
          }
          if (!src) continue; // image not decoded / video frame unavailable
          const sd = paintSourceSize(src);
          if (sd.w <= 0 || sd.h <= 0) continue;
          const base: OverlayTransform = ov.overlay ?? DEFAULT_OVERLAY_TRANSFORM;
          // Motion keyframes interpolate the rect through the window
          // (hold-first / hold-last) — the preview's exact sampling.
          const sample = sampleOverlayMotion(base, currentMs - ov.startMs);
          const transform: OverlayTransform = sample
            ? { ...base, x: clamp01(sample.x), y: clamp01(sample.y) }
            : base;
          const g = overlayGeometry(dims.w, dims.h, sd.w, sd.h, transform);
          if (g.dw <= 0 || g.dh <= 0) continue;
          const keyed =
            ov.chroma != null &&
            keyer.composite(ctx, src, ov.chroma, g.dx, g.dy, g.dw, g.dh);
          if (!keyed) {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(src, g.dx, g.dy, g.dw, g.dh);
          }
        } finally {
          owned?.close(); // ⚠ immediately after last use — draw, key, or skip
        }
      }

      // Paint order mirrors the preview exactly: base → overlays →
      // watermark → headlines → captions → global fades.
      if (wmImage && wmSettings) {
        drawWatermark(ctx, wmImage, dims.w, dims.h, wmSettings);
      }
      if (headlineItems) drawHeadline(ctx, headlineItems, currentMs, dims.w, dims.h);
      if (drawCaptions) drawCaptions(currentMs);
      if (seg) {
        applyGlobalFade(
          ctx,
          scratch,
          computeGlobalFade(segments, segIdx, currentMs, transition),
        );
      }

      // Eager decoder release: sources whose every segment window has
      // passed can only be needed again by the base tail fallback (lastSeg)
      // — free them now so a 19-min export never holds every source at once.
      if (i % 30 === 0) {
        for (const [key, dec] of baseDecoders) {
          if (key === lastBaseKey) continue;
          const stillNeeded = segments.some(
            (s) =>
              (s.track ?? 0) === 0 &&
              s.mediaType === "video" &&
              sourceKeyOf(s) === key &&
              s.endMs > currentMs,
          );
          if (!stillNeeded) {
            dec.cleanup();
            baseDecoders.delete(key);
          }
        }
        for (const [ovKey, dec] of overlayDecoders) {
          const segId = ovKey.slice(3);
          const s = segments.find((x) => x.id === segId);
          if (!s || s.endMs <= currentMs) {
            dec.cleanup();
            overlayDecoders.delete(ovKey);
          }
        }
      }

      // v1.15.2: the composite clock ends here — the JS paint wall (minus
      // decode waits) IS jsCompositorOverheadMs.
      const compositeT1 = performance.now();

      const outFrame = new VideoFrame(canvas, {
        timestamp: Math.round(currentMs * 1000),
        duration: frameDurationUs,
      });
      try {
        videoEncoder.encode(outFrame, { keyFrame: i % keyInterval === 0 });
      } finally {
        outFrame.close(); // ⚠ immediately after last use — no path leaks it
      }
      framesEncoded = i + 1;
      framePaintMs += performance.now() - framePaintT0; // v1.15.1 telemetry
      frameCompositeMs += compositeT1 - framePaintT0 - decodeMsThisFrame; // v1.15.2
      frameDecodeMs += decodeMsThisFrame; // v1.15.2
      emitProgress();
    }

    stage = "finalizing";
    emitProgress(true);

    // Audio finish first (its chunks must all reach the muxer), then video.
    audioCompleted = true;
    if (audioPromise) await audioPromise;
    if (encoderFatal) {
      throw new GpuEncodePassError(
        `video encoder failed: ${errMessage(encoderFatal)}`,
        hardware,
        framesEncoded,
      );
    }
    try {
      await videoEncoder.flush();
    } catch (e) {
      throw new GpuEncodePassError(
        `video encoder flush failed: ${errMessage(e)}`,
        hardware,
        framesEncoded,
      );
    }
    videoEncoder.close();
    encoderClosed = true;

    muxer.finalize();
    await sink.finalize();

    let resultPath: string;
    let resultBytes: ArrayBuffer | undefined;
    if (useIpc && outputPath) {
      resultPath = outputPath;
    } else {
      // Plain browser: in-memory accumulation → Blob → download (the same
      // filename pattern + revoke timeout as the legacy browser path).
      // (`.buffer` is the sink's exact-size copy — getBytes() builds a fresh
      // Uint8Array, so the whole buffer IS the file.)
      // v1.15.2 "bytes" mode (worker browser export): the muxed MP4 rides
      // the 'done' message back to the MAIN thread as a transferable — the
      // download triggers there (the worker has no DOM to click an <a>).
      const bytes = sink.getBytes();
      if (opts.browserDelivery === "bytes") {
        resultBytes = bytes.buffer as ArrayBuffer;
      } else {
        const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "video/mp4" });
        const downloadUrl = URL.createObjectURL(blob);
        triggerDownload(downloadUrl, `framefuse_${Date.now()}.mp4`);
        setTimeout(() => URL.revokeObjectURL(downloadUrl), 60000);
      }
      resultPath = "(browser download) framefuse.mp4";
    }
    return {
      hardware,
      rung: passRung,
      ...(passHwRejectReason ? { hwRejectReason: passHwRejectReason } : {}),
      byteCount: sink.byteCount,
      resultPath,
      ...(resultBytes ? { bytes: resultBytes } : {}),
    };
    } finally {
      // Per-pass cleanup on EVERY path — success, error, and abort.
      if (!audioCompleted) audioCtl.abort(); // stop a zombie AAC render
      if (videoEncoder && !encoderClosed) {
        // Abort/error mid-encode: close() to release encoder-held GPU frames
        // (try/catch — the encoder may already be in a failed state).
        try {
          videoEncoder.close();
        } catch {
          /* encoder already closed or fatally reset */
        }
        encoderClosed = true;
      }
      // Still call exportEnd so a streamed file on disk is closed cleanly
      // (partial file, moov missing — documented abort semantics).
      try {
        await sink.finalize();
      } catch {
        /* the sink never throws, but never block cleanup */
      }
    }
    };

    // ── v1.8.2: run the pass, retrying ONCE on the software rung when the
    // hardware encoder wedged before ANY frame was muxed (lossless restart).
    let softwareFallback = false;
    let passResult: {
      hardware: boolean;
      rung: "require-hardware" | "prefer-hardware" | "software" | "plain";
      hwRejectReason?: string;
      byteCount: number;
      resultPath: string;
      bytes?: ArrayBuffer;
    };
    try {
      emitProgress(true);
      try {
        passResult = await runEncodePass(opts.forceSoftware === true);
      } catch (e) {
        if (
          e instanceof GpuEncodePassError &&
          e.hardware &&
          e.framesEncoded === 0 &&
          opts.forceSoftware !== true
        ) {
          softwareFallback = true;
          console.warn(
            `[framefuse] GPU export: ${e.message} — restarting the export on the software encoder rung`,
          );
          cleanupDecoders(); // pass 2 re-creates them lazily from the same sources
          framesEncoded = 0;
          framePaintMs = 0; // v1.15.1: telemetry tracks the FINAL pass only
          frameCompositeMs = 0; // v1.15.2: both halves reset with it
          frameDecodeMs = 0;
          stage = "preparing";
          emitProgress(true);
          passResult = await runEncodePass(true);
        } else {
          throw e;
        }
      }

      const elapsedSec = Math.max(0.001, (performance.now() - startedAt) / 1000);
      // v1.15.3: the encoder label states the rung TRUTH — only
      // require-hardware is proven hardware; prefer-hardware is requested
      // but unverifiable; software/plain are software.
      const rungLabel =
        passResult.rung === "require-hardware"
          ? "hardware (require-hardware)"
          : passResult.rung === "prefer-hardware"
            ? "hardware (prefer-hardware, unverified)"
            : "software";
      return {
        path: passResult.resultPath,
        size: passResult.byteCount,
        encoder: `WebCodecs H.264 · ${rungLabel}`,
        elapsedSec,
        mode: "gpu-webcodecs",
        engine: "webcodecs-gpu",
        method: "WebCodecs GPU",
        ...(audioSkipped ? { audioSkipped: true } : {}),
        framesEncoded,
        gpuFrameRenderMs: Math.round((framePaintMs / Math.max(1, framesEncoded)) * 10) / 10,
        // v1.15.2 telemetry split (user directive): the pure-JS compositor
        // cost — the number that decides whether the v1.16 GLSL/WebGPU
        // shader migration pays — plus the decode-side twin.
        jsCompositorOverheadMs:
          Math.round((frameCompositeMs / Math.max(1, framesEncoded)) * 10) / 10,
        gpuDecodeWaitMs: Math.round((frameDecodeMs / Math.max(1, framesEncoded)) * 10) / 10,
        ...(softwareFallback ? { softwareFallback: true } : {}),
        // v1.15.3 lie-detector telemetry: the rung that ran + the platform's
        // rejection reason when hardware was refused (survives the retry —
        // it explains WHY hardware did not run).
        hwEncoder: passResult.rung,
        ...(passResult.hwRejectReason ? { hwRejectReason: passResult.hwRejectReason } : {}),
        ...(passResult.bytes ? { bytes: passResult.bytes } : {}),
      };
    } finally {
      // Export-level cleanup on EVERY path — success, error, and abort.
      clearInterval(heartbeat);
      cleanupDecoders();
      keyer.dispose(); // drop the export's WebGL context + textures
      for (const url of sfxBlobUrls) URL.revokeObjectURL(url); // SFX WAV blobs
    }
}
