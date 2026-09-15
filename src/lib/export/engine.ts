// src/lib/export/engine.ts — the Export-tab GPU (WebCodecs) engine adapter.
// Task 27-a: makes the v8 pipeline (SourceDecoder → canvas → VideoEncoder →
// mp4-muxer, streamed to disk over IPC) a FIRST-CLASS, user-selectable export
// engine so "FFmpeg Smart" vs "GPU (WebCodecs)" can be A/B tested from the
// Export tab.
//
// This adapter takes the SAME ExportNativeOptions-shaped input exportNative
// takes and renders the FULL timeline exactly like the proven browser path in
// native.ts (exportViaWebCodecs): Ken Burns images + cover-fit videos with
// the same transition/fade treatment → watermark → headlines → captions (all
// word modes + kinetic animations, via the SAME drawCaption) → global fades.
// Differences from the browser path, by design:
//   • FULL output resolution (no 720p cap — that cap is browser-legacy),
//   • VIDEO base-lane segments decode through SourceDecoder (mp4box →
//     VideoDecoder) instead of being rejected,
//   • muxed bytes stream to disk in ~5 MB IPC chunks in Electron (ChunkSink +
//     StreamTarget + fastStart:"fragmented" — the proven append-only contract)
//     instead of an in-memory ArrayBufferTarget,
//   • audio (music + clip audio) mixes through AudioMixer when AAC encode is
//     available; otherwise the export degrades to video-only with
//     audioSkipped:true so the UI can warn.
//
// VRAM RULE (user-mandated, same as the other v8 modules): every VideoFrame
// created, cloned, or received is .close()d immediately after its last use on
// EVERY path (draw-finally, encode-finally, decoder cleanup). Each close site
// is commented with ⚠.

import { Muxer, StreamTarget } from "mp4-muxer";
import type {
  ExportNativeOptions,
  ExportResult,
  MediaSegment,
} from "@/lib/merger/types";
import {
  applyGlobalFade,
  computeGlobalFade,
  computeTransitionFx,
  drawFrameWithTransition,
  drawVideoFrame,
  drawWatermark,
  resolveDimensions,
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
}

/** Result of a GPU-engine export — the ExportResult the UI already renders,
 * plus the frames-encoded count and the audio-degradation flag. */
export interface GpuTimelineExportResult extends ExportResult {
  /** True when audio existed but AAC (mp4a.40.2) encode is unavailable in
   * this runtime (e.g. the open-source Chromium sandbox build) — the export
   * completed VIDEO-ONLY so the UI can toast a warning. */
  audioSkipped?: boolean;
  framesEncoded: number;
}

/**
 * Typed, actionable error for timeline features the GPU engine does not
 * render (yet). The message always tells the user to switch the engine
 * selector back to "FFmpeg Smart" — the FFmpeg engine supports everything.
 */
export class GpuExportUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GpuExportUnsupportedError";
  }
}

/** Encoder backpressure: pause the paint loop above this many queued frames. */
const MAX_ENCODE_QUEUE = 30;

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

/** Load an image for drawing (same contract as native.ts's helper). */
function loadImageElement(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * v5 timeline features the GPU engine cannot render yet → typed error.
 * Supported on purpose: Ken Burns, transitions (incl. the video-boundary
 * hard-cut rule), watermark, headlines, captions with every word mode +
 * kinetic animation, global fades, base-lane video (decode + clip audio).
 */
function assertGpuTimelineSupport(opts: GpuTimelineExportOptions): void {
  const unsupported: string[] = [];
  const overlayCount = (opts.segments || []).filter((s) => (s.track ?? 0) >= 1).length;
  if (overlayCount > 0) unsupported.push(`overlay-lane clips (${overlayCount})`);
  const chromaCount = (opts.segments || []).filter((s) => s.chroma != null).length;
  if (chromaCount > 0) unsupported.push(`chroma-keyed clips (${chromaCount})`);
  if (opts.sfx && opts.sfx.length > 0) unsupported.push(`SFX placements (${opts.sfx.length})`);
  if (unsupported.length > 0) {
    throw new GpuExportUnsupportedError(
      `GPU (WebCodecs) engine beta doesn't support ${unsupported.join(", ")} yet. ` +
        `Switch the engine selector in the Export tab back to "FFmpeg Smart" — ` +
        `the FFmpeg engine renders every feature.`,
    );
  }
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
 * Build the AudioMixer track list from the timeline model:
 *  (a) the music track — pinned at musicStartMs (v5.2 placement), looping
 *      when the user enabled musicLoop OR the track is shorter than the
 *      timeline (the "background music pinned to the whole video" case —
 *      the same fill-the-timeline intent as the FFmpeg path's
 *      `-stream_loop -1` + apad graph); volume = master × music.
 *  (b) every base-lane VIDEO segment's audio at its timeline position with
 *      its trim offset and per-clip volume (scaled by master volume).
 *
 * Known beta limitations vs the FFmpeg audio bus (documented trade-offs):
 * normalize/loudnorm, music-local fades and per-clip speed time-compression
 * (atempo) are not part of the offline graph; volumes >1 are clamped to 1 by
 * the mixer (no limiter needed).
 */
function buildAudioTracks(opts: GpuTimelineExportOptions): AudioTrackData[] {
  const tracks: AudioTrackData[] = [];
  const totalSec = opts.totalMs / 1000;
  const masterVolume = clampNum(opts.audio?.masterVolume, 0, 2, 1);

  if (opts.audioTrack) {
    const startSec = Math.max(0, clampNum(opts.audio?.musicStartMs, 0, Infinity, 0) / 1000);
    const trackShorter =
      opts.audioTrack.durationMs != null && opts.audioTrack.durationMs < opts.totalMs;
    tracks.push({
      url: opts.audioTrack.url,
      startSec,
      offsetSec: 0,
      durationSec: Math.max(0.01, totalSec - startSec),
      volume: masterVolume * clampNum(opts.audio?.musicVolume, 0, 2, 1),
      loop: opts.audio?.musicLoop === true || trackShorter,
    });
  }

  for (const seg of opts.segments) {
    if (seg.mediaType !== "video" || (seg.track ?? 0) >= 1) continue;
    if (seg.volume <= 0) continue;
    const url = videoSourceUrl(seg, opts.imageUrls);
    if (!url) continue; // File-only sources are decodable but not fetchable
    tracks.push({
      url,
      startSec: seg.startMs / 1000,
      offsetSec: (seg.trimInMs || 0) / 1000,
      // Spec: the source-seconds span the clip consumes (speed 1 = the
      // timeline window; speed≠1 audio is NOT time-compressed in the beta).
      durationSec: (seg.durationMs / 1000) * (seg.speed || 1),
      volume: masterVolume * seg.volume,
    });
  }
  return tracks;
}

/**
 * exportTimelineViaGpu — render the whole FrameFuse timeline through the
 * WebCodecs + Canvas pipeline and mux an H.264 MP4.
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
  assertGpuTimelineSupport(opts);

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
  const audioTracks = buildAudioTracks(opts);
  const audioSupported = audioTracks.length > 0 ? await isAudioEncoderSupported() : false;
  const audioSkipped = audioTracks.length > 0 && !audioSupported;
  const activeAudioTracks = audioSupported ? audioTracks : [];

  // ── Image preload (imgCache pattern from the browser path). Generalized
  // to VideoFrameSource so the same cache could hold any paint source —
  // here it only ever holds decoded HTMLImageElements.
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
  const bridge = getExportStreamer();
  const outputPath =
    typeof opts.outputPath === "string" && opts.outputPath.length > 0 ? opts.outputPath : null;
  const useIpc = bridge !== null && outputPath !== null;
  const sink = new ChunkSink(useIpc ? bridge : null);
  if (useIpc && bridge && outputPath) {
    bridge.exportStart(outputPath);
  }

  // One SourceDecoder per UNIQUE video URL (per the v8 architecture doc) —
  // created lazily on first use, released eagerly once no remaining segment
  // needs the source (the loop walks time monotonically; a re-used source
  // simply re-inits through the decoder's rewind path).
  const decoders = new Map<string, SourceDecoder>();
  const decoderKey = (seg: MediaSegment): string | null => {
    const url = videoSourceUrl(seg, imageUrls);
    if (url) return url;
    return seg.file ? `file:${seg.id}` : null;
  };
  const getDecoder = async (seg: MediaSegment): Promise<SourceDecoder> => {
    const key = decoderKey(seg);
    if (!key) {
      throw new GpuExportError(
        `video segment "${seg.fileName || seg.id}" has no readable source (no URL and no File)`,
      );
    }
    const existing = decoders.get(key);
    if (existing) return existing;
    const created =
      videoSourceUrl(seg, imageUrls) != null
        ? await SourceDecoder.fromUrl(videoSourceUrl(seg, imageUrls) as string)
        : await SourceDecoder.fromBuffer(await (seg.file as File).arrayBuffer());
    decoders.set(key, created);
    return created;
  };
  // The LAST segment stays eligible past its end (the browser path's tail
  // fallback freezes on it when totalMs exceeds the last endMs) — its
  // decoder must never be eagerly released.
  const lastSeg = segments[segments.length - 1] ?? null;
  const lastSegKey = lastSeg && lastSeg.mediaType === "video" ? decoderKey(lastSeg) : null;

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

  // ── Encoder: the shared hardware→software ladder, full-res codec string. ──
  const bitrate = Math.round(browserQualityBitrate(settings));
  // H.264 profile for the resolution — the browser path's logic WITHOUT the
  // 720p constraint: Constrained Baseline for small frames, High L4.0 above
  // (the codec ExportOrchestrator proved supported in Chromium).
  const videoCodec = dims.w * dims.h <= 1280 * 720 ? "avc1.42E01E" : "avc1.640028";

  let encoderFatal: unknown = null;
  let videoEncoder: VideoEncoder | null = null;
  let encoderClosed = false;
  let audioPromise: Promise<unknown> | null = null;
  let framesEncoded = 0;

  try {
    const { encoder, hardware } = await configureVideoEncoder(
      { width: dims.w, height: dims.h, fps, videoBitrate: bitrate, videoCodec },
      (chunk, meta) => {
        muxer.addVideoChunk(chunk, meta);
      },
      (e) => {
        encoderFatal = e;
      },
    );
    videoEncoder = encoder;

    // Audio renders CONCURRENTLY with the frame loop (runGpuExport's proven
    // pattern): chunks flow straight into the muxer, the promise is awaited
    // after the loop, before flush.
    if (activeAudioTracks.length > 0) {
      const mixer = new AudioMixer((chunk, meta) => {
        muxer.addAudioChunk(chunk, meta);
      });
      const p = mixer.renderAudio(totalSec, activeAudioTracks);
      // Swallow-side handler: if the video loop aborts/errors BEFORE this
      // promise is awaited, its eventual rejection would otherwise surface
      // as an unhandled rejection. Attaching a catch does not consume the
      // rejection — the success path's `await` still sees and rethrows it.
      p.catch(() => {
        /* surfaced by the awaiting path, or the export already failed */
      });
      audioPromise = p;
    }

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

    for (let i = 0; i < totalFrames; i++) {
      if (signal?.aborted) throw new ExportAbortedError();
      if (encoderFatal) {
        throw new GpuExportError(`video encoder failed: ${errMessage(encoderFatal)}`);
      }

      const currentMs = (i / fps) * 1000;

      // Backpressure: don't let the encoder queue grow without bound.
      while (videoEncoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
        if (signal?.aborted) throw new ExportAbortedError();
        if (encoderFatal) {
          throw new GpuExportError(`video encoder failed: ${errMessage(encoderFatal)}`);
        }
        await delay(10);
      }

      // Active base segment — the browser path's exact resolution (fallback
      // to the last segment in the tail past every end).
      const segIdx = segments.findIndex(
        (s) => currentMs >= s.startMs && currentMs < s.endMs,
      );
      const seg = segIdx >= 0 ? segments[segIdx] : lastSeg;

      if (seg) {
        if (seg.mediaType === "video") {
          // VIDEO base — cover-fit via drawVideoFrame, NO Ken Burns (the
          // video's own motion is the content — the preview + FFmpeg rule).
          // The v5 VIDEO RULE makes xfade heads hard cuts at video
          // boundaries, so only dip heads can be active — composited here
          // manually exactly like PreviewPanel's video-base branch.
          const decoder = await getDecoder(seg);
          const sourceTimeMs =
            (currentMs - seg.startMs) * (seg.speed || 1) + (seg.trimInMs || 0);
          // Caller-owned CLONE — closed immediately after ALL draws for this
          // frame are done (⚠ VRAM rule; finally covers the draw throws).
          const frame = await decoder.getFrameForTimestamp(sourceTimeMs);
          try {
            const fx = computeTransitionFx(segments, Math.max(0, segIdx), currentMs, transition);
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
            Math.max(0, segIdx),
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
      }

      // Paint order mirrors the browser path exactly: base → watermark →
      // headlines → captions → global fades.
      if (wmImage && wmSettings) {
        drawWatermark(ctx, wmImage, dims.w, dims.h, wmSettings);
      }
      if (headlineItems) drawHeadline(ctx, headlineItems, currentMs, dims.w, dims.h);
      if (drawCaptions) drawCaptions(currentMs);
      if (seg) {
        applyGlobalFade(
          ctx,
          scratch,
          computeGlobalFade(
            segments,
            Math.max(0, segments.indexOf(seg)),
            currentMs,
            transition,
          ),
        );
      }

      // Eager decoder release: a source whose every segment window has
      // passed can only be needed again by the tail fallback (lastSeg) —
      // free it now so a 19-min export never holds every source at once.
      if (i % 30 === 0) {
        for (const [key, dec] of decoders) {
          if (key === lastSegKey) continue;
          const stillNeeded = segments.some(
            (s) => s.mediaType === "video" && decoderKey(s) === key && s.endMs > currentMs,
          );
          if (!stillNeeded) {
            dec.cleanup();
            decoders.delete(key);
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
      framesEncoded++;

      const elapsedSec = Math.max(0.001, (performance.now() - startedAt) / 1000);
      onProgress?.({
        progress: ((i + 1) / totalFrames) * 100,
        fps: Math.round((i + 1) / elapsedSec),
      });
    }

    // Audio finish first (its chunks must all reach the muxer), then video.
    if (audioPromise) await audioPromise;
    if (encoderFatal) {
      throw new GpuExportError(`video encoder failed: ${errMessage(encoderFatal)}`);
    }
    try {
      await videoEncoder.flush();
    } catch (e) {
      throw new GpuExportError(`video encoder flush failed: ${errMessage(e)}`);
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

    const elapsedSec = Math.max(0.001, (performance.now() - startedAt) / 1000);
    return {
      path: resultPath,
      size: sink.byteCount,
      encoder: hardware ? "WebCodecs H.264 · hardware" : "WebCodecs H.264 · software",
      elapsedSec,
      mode: "gpu-webcodecs",
      ...(audioSkipped ? { audioSkipped: true } : {}),
      framesEncoded,
    };
  } finally {
    // Cleanup on EVERY path — success, error, and abort.
    for (const decoder of decoders.values()) decoder.cleanup();
    decoders.clear();
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
}
