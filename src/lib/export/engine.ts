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
  drawFrameWithTransition,
  drawVideoFrame,
  drawWatermark,
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
import { renderSfxWav, sfxDurationMs } from "@/lib/merger/sfx";
import { SourceDecoder } from "./SourceDecoder";
import { AudioMixer, isAudioEncoderSupported, type AudioTrackData } from "./AudioMixer";
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
}

/** Overlay-lane items without an explicit geometry render centered at 60%
 * output width — MUST stay in lockstep with PreviewPanel's and page.tsx's
 * DEFAULT_OVERLAY_TRANSFORM (page writes it into the item's edit on every
 * lane switch, so the exported composite matches by construction). */
const DEFAULT_OVERLAY_TRANSFORM: OverlayTransform = {
  scalePercent: 60,
  position: "center",
};

/** Encoder backpressure: pause the paint loop above this many queued frames. */
const MAX_ENCODE_QUEUE = 30;

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

/** Load an image for drawing (same contract as native.ts's helper). */
function loadImageElement(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** The fetchable source URL of a VIDEO segment (page.tsx maps every item's
 * object URL under the segment id — videos included). Null when only the
 * original File exists (AudioMixer cannot fetch a File; the decoder can
 * still read it via arrayBuffer). */
function videoSourceUrl(seg: MediaSegment, imageUrls: Record<string, string>): string | null {
  const url = imageUrls[seg.id];
  return typeof url === "string" && url.length > 0 ? url : null;
}

/**
 * Build the AudioMixer track list from the timeline model — EVERY audio
 * lane (Task 28-a):
 *  (a) the music track — pinned at musicStartMs (v5.2 placement), looping
 *      when the user enabled musicLoop OR the track is shorter than the
 *      timeline; volume = master × music; music-local fade-in/fade-out
 *      automation (the fade-out always ENDS at the video end — FFmpeg
 *      buildAudioMixGraph parity);
 *  (b) every BASE-lane video segment's audio at its timeline position with
 *      its trim offset and per-clip volume (scaled by master); speed≠1
 *      clips time-compress via playbackRate (sync-correct twin of atempo);
 *  (c) every OVERLAY-lane (PIP) video segment's audio — a GPU-engine
 *      SUPERSET: the FFmpeg graph maps overlay inputs video-only, so this
 *      is the only engine that mixes PIP audio. overlayLoop wraps audio
 *      identically to the video arm;
 *  (d) the pre-rendered SFX placements (`sfxTracks` — synthesized WAV blob
 *      URLs, the exact bytes the FFmpeg path uploads as temp files).
 *
 * Video-clip branches are `optional`: an MP4 with no audio track skips with
 * a warn instead of failing the export (the FFmpeg path probe-gates the
 * same case). Known deviations vs the FFmpeg audio bus (documented):
 * normalize/loudnorm is not part of the offline graph; playbackRate
 * pitch-shifts where atempo preserves pitch.
 */
function buildAudioTracks(
  opts: GpuTimelineExportOptions,
  sfxTracks: AudioTrackData[],
): AudioTrackData[] {
  const tracks: AudioTrackData[] = [...sfxTracks];
  const totalSec = opts.totalMs / 1000;
  const masterVolume = clampNum(opts.audio?.masterVolume, 0, 2, 1);

  if (opts.audioTrack) {
    const startSec = Math.max(0, clampNum(opts.audio?.musicStartMs, 0, Infinity, 0) / 1000);
    const trackShorter =
      opts.audioTrack.durationMs != null && opts.audioTrack.durationMs < opts.totalMs;
    const musicVolume = masterVolume * clampNum(opts.audio?.musicVolume, 0, 2, 1);
    const fadeInMs = Math.max(0, clampNum(opts.audio?.fadeInMs, 0, Infinity, 0));
    const fadeOutMs = Math.max(0, clampNum(opts.audio?.fadeOutMs, 0, Infinity, 0));
    tracks.push({
      url: opts.audioTrack.url,
      startSec,
      offsetSec: 0,
      durationSec: Math.max(0.01, totalSec - startSec),
      volume: musicVolume,
      loop: opts.audio?.musicLoop === true || trackShorter,
      // Music-local fades — the fade-out window is absolute and ends at the
      // VIDEO end (the adelay-relative math in buildAudioMixGraph's twin).
      ...(fadeInMs > 0 ? { fadeInSec: fadeInMs / 1000 } : {}),
      ...(fadeOutMs > 0
        ? { fadeOut: { startSec: Math.max(0, totalSec - fadeOutMs / 1000), endSec: totalSec } }
        : {}),
    });
  }

  for (const seg of opts.segments) {
    if (seg.mediaType !== "video") continue;
    if (seg.volume <= 0) continue;
    const url = videoSourceUrl(seg, opts.imageUrls);
    if (!url) continue; // File-only sources are decodable but not fetchable
    if ((seg.track ?? 0) >= 1) {
      // (c) PIP/overlay clip audio — speed-1 by design (the export overlay
      // graph is speed-1), looped when the overlay loops.
      tracks.push({
        url,
        startSec: seg.startMs / 1000,
        offsetSec: (seg.trimInMs || 0) / 1000,
        durationSec: seg.durationMs / 1000,
        volume: masterVolume * seg.volume,
        loop: seg.overlayLoop === true,
        optional: true, // no audio track in the container → skip, not fail
      });
      continue;
    }
    // (b) base-lane clip audio — the source window consumed is
    // durationMs × speed buffer-seconds, played back at `speed` so it lands
    // inside the (shorter) timeline window.
    const speed = seg.speed || 1;
    tracks.push({
      url,
      startSec: seg.startMs / 1000,
      offsetSec: (seg.trimInMs || 0) / 1000,
      durationSec: (seg.durationMs / 1000) * speed,
      volume: masterVolume * seg.volume,
      playbackRate: speed,
      optional: true,
    });
  }
  return tracks;
}

/**
 * Pre-render every SFX placement to a WAV blob URL (Task 28-a) — native.ts
 * IPC parity: one render per unique (sfxId, durMs), cached; failures skip
 * the placement with a console warn instead of failing the export. The
 * caller owns the blob URLs and revokes them when the export finishes.
 */
async function renderSfxTracks(
  opts: GpuTimelineExportOptions,
  masterVolume: number,
  blobUrls: string[],
): Promise<AudioTrackData[]> {
  const tracks: AudioTrackData[] = [];
  if (!opts.sfx || opts.sfx.length === 0) return tracks;
  const wavCache = new Map<string, { url: string; durationSec: number } | null>();
  for (const item of opts.sfx) {
    if (!item || !item.id || !item.sfxId) continue;
    const itemDurMs = sfxDurationMs(item);
    const cacheKey = `${item.sfxId}:${itemDurMs}`;
    if (!wavCache.has(cacheKey)) {
      let entry: { url: string; durationSec: number } | null = null;
      try {
        const rendered = await renderSfxWav(item.sfxId, itemDurMs);
        if (rendered) {
          const url = URL.createObjectURL(rendered.blob);
          blobUrls.push(url);
          entry = { url, durationSec: rendered.durationMs / 1000 };
        } else {
          console.warn(
            `[framefuse] SFX "${item.sfxId}" could not be rendered (Web Audio unavailable?) — skipping placement ${item.id}`,
          );
        }
      } catch (e) {
        console.warn(`[framefuse] SFX "${item.sfxId}" render failed — skipping placement ${item.id}`, e);
      }
      wavCache.set(cacheKey, entry);
    }
    const cached = wavCache.get(cacheKey);
    if (cached) {
      tracks.push({
        url: cached.url,
        startSec: Math.max(0, item.startMs) / 1000,
        offsetSec: 0,
        durationSec: cached.durationSec,
        // FFmpeg parity: the SFX branch rides clamp(volume, 0, 1) with the
        // master volume applied at the mix bus (linearly identical).
        volume: masterVolume * clampNum(item.volume, 0, 1, 1),
      });
    }
  }
  return tracks;
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

  const canvas = document.createElement("canvas");
  canvas.width = dims.w;
  canvas.height = dims.h;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new GpuExportError("failed to acquire a 2d context on the export canvas");

  // ── Audio gate: build the track list, then check AAC support BEFORE the
  // muxer is constructed (an mp4 with a declared-but-empty audio track would
  // be unplayable). Sandbox Chromium has no AAC → video-only + audioSkipped.
  // v1.8.1: the list now includes SFX + PIP (overlay) clip audio too.
  const masterVolume = clampNum(opts.audio?.masterVolume, 0, 2, 1);
  const sfxBlobUrls: string[] = [];
  const sfxTracks = await renderSfxTracks(opts, masterVolume, sfxBlobUrls);
  const audioTracks = buildAudioTracks(opts, sfxTracks);
  const audioSupported = audioTracks.length > 0 ? await isAudioEncoderSupported() : false;
  const audioSkipped = audioTracks.length > 0 && !audioSupported;
  const activeAudioTracks = audioSupported ? audioTracks : [];

  // ── Image preload (imgCache pattern from the browser path). Generalized
  // to VideoFrameSource so the same cache could hold any paint source —
  // here it only ever holds decoded HTMLImageElements (base AND overlay
  // lanes — overlay images resolve through the same map).
  const imgCache = new Map<string, VideoFrameSource>();
  await Promise.all(
    segments
      .filter((seg) => seg.mediaType !== "video")
      .map(
        (seg) =>
          new Promise<void>((resolve) => {
            const url = imageUrls[seg.id] || seg.thumbnailUrl;
            const img = new Image();
            img.onload = () => {
              imgCache.set(seg.id, img);
              resolve();
            };
            img.onerror = () => resolve();
            img.src = url;
          }),
      ),
  );

  // ── Output sink: IPC stream (Electron + outputPath) or in-memory. ──────
  // v1.8.2: the sink (and its exportStart/exportEnd session) is PER ENCODE
  // PASS — the hardware→software retry re-runs bridge.exportStart, and the
  // main-process handler truncates + reopens the file, so a failed pass's
  // partial bytes never leak into the final output.
  const bridge = getExportStreamer();
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
      elapsedSec: Math.round(elapsedSec * 10) / 10,
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
    // browser path's twin).
    const scratch = document.createElement("canvas");
    scratch.width = dims.w;
    scratch.height = dims.h;
    const sctx = scratch.getContext("2d", { alpha: false });

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
    const wmImage = opts.watermark?.imageUrl ? await loadImageElement(opts.watermark.imageUrl) : null;
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
    ): Promise<{ hardware: boolean; byteCount: number; resultPath: string }> => {
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
      const { encoder, hardware } = await configureVideoEncoder(
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

      // Audio renders CONCURRENTLY with the frame loop (runGpuExport's proven
      // pattern): chunks flow straight into the muxer, the promise is awaited
      // after the loop, before flush. v1.8.2: the per-pass AbortSignal lets a
      // retried pass stop this one's AAC encode instead of zombie-ing it.
      if (activeAudioTracks.length > 0) {
        const mixer = new AudioMixer((chunk, meta) => {
          muxer.addAudioChunk(chunk, meta);
        });
        const p = mixer.renderAudio(totalSec, activeAudioTracks, audioCtl.signal);
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
        await delay(10);
      }

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
          const frame = await decoder.getFrameForTimestamp(sourceTimeMs);
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
          let src: VideoFrame | HTMLImageElement | null = null;
          if (ov.mediaType === "video") {
            const decoder = await getOverlayDecoder(ov);
            const speed = ov.speed || 1; // overlays resolve speed 1 by design
            let localMs = (ov.trimInMs || 0) + (currentMs - ov.startMs) * speed;
            if (ov.overlayLoop && ov.sourceDurationMs && ov.sourceDurationMs > 0) {
              const dur = ov.sourceDurationMs;
              localMs = ((localMs % dur) + dur) % dur;
            }
            owned = await decoder.getFrameForTimestamp(Math.max(0, localMs));
            src = owned;
          } else {
            // imgCache only ever holds HTMLImageElements here (built from
            // new Image() above) — the cast is honest and keeps the union
            // narrow for the keyer's TexImageSource parameter.
            src = (imgCache.get(ov.id) as HTMLImageElement | undefined) ?? null;
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
    if (useIpc && outputPath) {
      resultPath = outputPath;
    } else {
      // Plain browser: in-memory accumulation → Blob → download (the same
      // filename pattern + revoke timeout as the legacy browser path).
      // (`.buffer` is the sink's exact-size copy — getBytes() builds a fresh
      // Uint8Array, so the whole buffer IS the file.)
      const bytes = sink.getBytes();
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "video/mp4" });
      const downloadUrl = URL.createObjectURL(blob);
      triggerDownload(downloadUrl, `framefuse_${Date.now()}.mp4`);
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 60000);
      resultPath = "(browser download) framefuse.mp4";
    }
    return { hardware, byteCount: sink.byteCount, resultPath };
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
    let passResult: { hardware: boolean; byteCount: number; resultPath: string };
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
          stage = "preparing";
          emitProgress(true);
          passResult = await runEncodePass(true);
        } else {
          throw e;
        }
      }

      const elapsedSec = Math.max(0.001, (performance.now() - startedAt) / 1000);
      return {
        path: passResult.resultPath,
        size: passResult.byteCount,
        encoder:
          passResult.hardware && !softwareFallback
            ? "WebCodecs H.264 · hardware"
            : "WebCodecs H.264 · software",
        elapsedSec,
        mode: "gpu-webcodecs",
        ...(audioSkipped ? { audioSkipped: true } : {}),
        framesEncoded,
        ...(softwareFallback ? { softwareFallback: true } : {}),
      };
    } finally {
      // Export-level cleanup on EVERY path — success, error, and abort.
      clearInterval(heartbeat);
      cleanupDecoders();
      keyer.dispose(); // drop the export's WebGL context + textures
      for (const url of sfxBlobUrls) URL.revokeObjectURL(url); // SFX WAV blobs
    }
}
