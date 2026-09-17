// src/lib/export/ExportOrchestrator.ts — GPU export driver (decode → canvas → encode → mux)
// The central pipeline replacing CPU FFmpeg filtergraph exports for this
// path: one SourceDecoder per clip paints an OffscreenCanvas, captions are
// drawn on top, and a hardware-accelerated VideoEncoder feeds mp4-muxer.
// Muxed bytes stream OUT through a ChunkSink — ~5 MB chunks over IPC to disk
// in Electron (fastStart:false, moov-at-end) or an in-memory buffer in a
// plain browser — so a 19-minute 1080p export never has to fit in RAM/VRAM.
//
// VRAM RULE (user-mandated): every VideoFrame created, cloned, or received
// is .close()d immediately after its last use on EVERY path (draw-finally,
// encode-finally, decoder-owned eviction, cleanup). See the audit notes in
// the worklog — each close site is commented with ⚠.

import { Muxer, StreamTarget } from "mp4-muxer";
import { activeWordIndex, cueAt, type SubtitleCue, type WordTimestamp } from "@/lib/merger/subtitles";
import { SourceDecoder } from "./SourceDecoder";
import { AudioMixer, type AudioTrackData } from "./AudioMixer";

/** Typed error for export-orchestration failures (encoder/config/canvas). */
export class GpuExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GpuExportError";
  }
}

/** Thrown when the caller aborts the export through `GpuExportOptions.signal`. */
export class ExportAbortedError extends Error {
  constructor() {
    super("GPU export aborted");
    this.name = "ExportAbortedError";
  }
}

/** One video placement on the export timeline. */
export interface GpuVideoClip {
  /** Fetchable source URL of an MP4 (H.264/VP9). */
  source: string;
  /** Timeline interval [timelineStartMs, timelineEndMs) this clip paints. */
  timelineStartMs: number;
  timelineEndMs: number;
  /** Source offset at timelineStartMs. */
  sourceInMs: number;
  /** Source-time multiplier (default 1; <1 slows, >1 speeds up). */
  playbackRate?: number;
  /** Fit inside `rect` (default "cover"). */
  fit?: "cover" | "contain";
  /** Destination rectangle in output pixels (default: full canvas). */
  rect?: { x: number; y: number; width: number; height: number };
}

/** Caption rendering options for the export loop. */
export interface GpuCaptionOptions {
  cues: SubtitleCue[];
  /**
   * Font shorthand WITHOUT the size — combined as `` `${font} ${fontSizePx}px` ``.
   * Example: `700 "Inter", sans-serif`.
   */
  font: string;
  fontSizePx: number;
  /** Text fill color (CSS color). */
  color: string;
  /** Optional text stroke color (drawn behind the fill). */
  strokeColor?: string;
  /** Text stroke width in px (requires strokeColor). */
  strokeWidthPx?: number;
  /** Optional background box color behind each caption line block. */
  backgroundColor?: string;
  /**
   * Karaoke highlight color. When set (and a cue carries word timestamps),
   * the full phrase is drawn with the ACTIVE word in this color
   * (activeWordIndex semantics from @/lib/merger/subtitles).
   */
  karaokeHighlight?: string | null;
}

/** Full export request. */
export interface GpuExportOptions {
  width: number;
  height: number;
  fps: number;
  videoBitrate: number;
  /** VideoEncoder codec string (default "avc1.640028" — H.264 High 4:2:0 L4.0). */
  videoCodec?: string;
  /** mp4-muxer container codec (default "avc"; use "vp9" with a "vp09.*" codec). */
  muxerVideoCodec?: "avc" | "vp9";
  /**
   * Absolute output path. When the Electron export-streamer bridge is
   * available, muxed bytes are streamed to this file in ~5 MB chunks; in a
   * plain browser (or without a path) the bytes accumulate in memory so the
   * function stays testable.
   */
  outputPath?: string;
  clips: GpuVideoClip[];
  captions?: GpuCaptionOptions;
  tracks?: AudioTrackData[];
  onProgress?: (frameIndex: number, totalFrames: number) => void;
  signal?: AbortSignal;
}

/** Export result. In IPC (streamed) mode `bytes` is a zero-length stub — the file lives on disk. */
export interface GpuExportResult {
  bytes: Uint8Array;
  framesEncoded: number;
  durationMs: number;
}

/** The preload-bridge surface the renderer uses for streamed exports. */
export interface ExportStreamerBridge {
  exportStart: (filePath: string) => void;
  exportChunk: (buffer: Uint8Array) => void;
  exportEnd: () => void;
}

/** Encoder backpressure: pause the paint loop above this many queued frames. */
const MAX_ENCODE_QUEUE = 30;
/** Flush threshold for the IPC chunk sink (~5 MB, per the export architecture). */
const IPC_CHUNK_BYTES = 5 * 1024 * 1024;
/** Keyframe interval: 2 seconds of output. */
function keyframeIntervalFrames(fps: number): number {
  return Math.max(1, Math.round(fps * 2));
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Read the optional Electron export-streamer bridge (browser-safe).
 *  Exported since v8: the timeline adapter (src/lib/export/engine.ts) uses
 *  the same bridge detection for its streamed-to-disk mode. */
export function getExportStreamer(): ExportStreamerBridge | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & {
    electronAPI?: {
      exportStart?: (filePath: string) => void;
      exportChunk?: (buffer: Uint8Array) => void;
      exportEnd?: () => void;
    };
  };
  const api = w.electronAPI;
  if (!api) return null;
  const start = typeof api.exportStart === "function" ? api.exportStart : null;
  const chunk = typeof api.exportChunk === "function" ? api.exportChunk : null;
  const end = typeof api.exportEnd === "function" ? api.exportEnd : null;
  if (!start || !chunk || !end) return null;
  return { exportStart: start, exportChunk: chunk, exportEnd: end };
}

/**
 * ChunkSink — byte sink for the muxer's StreamTarget.
 *
 * IPC mode: incoming muxed bytes accumulate in a local flush buffer; once it
 * crosses ~5 MB it is concatenated and a COPY (`slice(0)` — IPC serializes
 * its argument) is sent over `export-chunk`, then the local buffer resets.
 * The muxed file never has to fit in RAM. (5 MB ≈ 40–80 KB/s-of-video worth
 * of VP9/H.264 at FrameFuse bitrates — dozens of chunks per minute, each a
 * single IPC message.)
 *
 * Memory mode (browser/dev): chunks accumulate for `getBytes()` — the whole
 * output in RAM, acceptable for tests and short previews only.
 *
 * Exported since v8: the timeline adapter (engine.ts) reuses this exact sink
 * for its mp4-muxer StreamTarget — one implementation of the proven
 * append-only IPC contract.
 */
export class ChunkSink {
  private readonly bridge: ExportStreamerBridge | null;
  private readonly memoryChunks: Uint8Array[] = [];
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private totalBytes = 0;
  private finalized = false;

  constructor(bridge: ExportStreamerBridge | null) {
    this.bridge = bridge;
  }

  get ipcMode(): boolean {
    return this.bridge !== null;
  }

  /**
   * StreamTarget.onData — append-only (mp4-muxer writes sequentially with
   * fastStart:false, so `position` always equals the bytes written so far;
   * a non-sequential write would corrupt an append-only stream — fail loud
   * instead of writing garbage to disk).
   */
  push(data: Uint8Array, position: number): void {
    if (this.finalized) return;
    if (position !== this.totalBytes) {
      throw new GpuExportError(
        `mp4-muxer emitted a non-sequential write (position ${position} ≠ ${this.totalBytes} bytes written) — the append-only export stream cannot seek`,
      );
    }
    this.totalBytes += data.byteLength;
    if (!this.bridge) {
      this.memoryChunks.push(data);
      return;
    }
    this.pending.push(data);
    this.pendingBytes += data.byteLength;
    if (this.pendingBytes >= IPC_CHUNK_BYTES) {
      this.flushIpc();
    }
  }

  /** Concatenate + send the pending ~5 MB over IPC (copy — IPC serializes). */
  private flushIpc(): void {
    if (!this.bridge || this.pending.length === 0) return;
    const combined = new Uint8Array(this.pendingBytes);
    let offset = 0;
    for (const part of this.pending) {
      combined.set(part, offset);
      offset += part.byteLength;
    }
    this.pending = [];
    this.pendingBytes = 0;
    // ⚠ slice(0): the IPC layer serializes (copies) its argument — we hand
    // it a private copy so the accumulator is never aliased.
    this.bridge.exportChunk(combined.slice(0));
  }

  /** Flush the remainder + close the stream (exportEnd). Idempotent. */
  async finalize(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    if (this.bridge) {
      this.flushIpc();
      this.bridge.exportEnd();
    }
  }

  /**
   * The muxed file bytes — the full in-memory copy in browser mode, a
   * zero-length stub in IPC mode (the bytes live in the file on disk).
   */
  getBytes(): Uint8Array {
    if (this.bridge) return new Uint8Array(0);
    const out = new Uint8Array(this.totalBytes);
    let offset = 0;
    for (const part of this.memoryChunks) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }

  get byteCount(): number {
    return this.totalBytes;
  }
}

/** destination rect for a source frame under cover/contain fit. */
function fitRect(
  srcW: number,
  srcH: number,
  dest: { x: number; y: number; width: number; height: number },
  fit: "cover" | "contain",
): { x: number; y: number; width: number; height: number } {
  if (srcW <= 0 || srcH <= 0 || dest.width <= 0 || dest.height <= 0) {
    return { x: dest.x, y: dest.y, width: dest.width, height: dest.height };
  }
  const scale =
    fit === "cover"
      ? Math.max(dest.width / srcW, dest.height / srcH)
      : Math.min(dest.width / srcW, dest.height / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return {
    x: dest.x + (dest.width - w) / 2,
    y: dest.y + (dest.height - h) / 2,
    width: w,
    height: h,
  };
}

/** One wrapped caption line (words or plain text). */
interface CaptionLine {
  /** Word segments with resolved colors; text may contain spaces. */
  words: Array<{ text: string; highlight: boolean }>;
  width: number;
}

/**
 * Draw the active caption cue at `currentTimeMs` (timeline time). Wraps at
 * ~80% of the canvas width (measureText), draws the background box first,
 * then stroke, then fill; karaoke mode highlights the active word.
 */
function drawGpuCaptions(
  ctx: OffscreenCanvasRenderingContext2D,
  captions: GpuCaptionOptions,
  currentTimeMs: number,
  canvasW: number,
  canvasH: number,
): void {
  const cue = cueAt(captions.cues, currentTimeMs);
  if (!cue) return;

  ctx.save();
  try {
    ctx.font = `${captions.font} ${Math.round(captions.fontSizePx)}px`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const maxTextWidth = canvasW * 0.8;
    const words = cue.words;
    const highlightColor = captions.karaokeHighlight;
    const karaoke = highlightColor != null && words != null && words.length > 0;
    const activeIdx = karaoke ? activeWordIndex(words, currentTimeMs) : -1;

    // Greedy word wrap at ~80% canvas width (measureText-based).
    const lines: CaptionLine[] = [];
    const spaceWidth = ctx.measureText(" ").width;
    let current: CaptionLine = { words: [], width: 0 };
    const appendToken = (text: string, highlight: boolean): void => {
      const w = ctx.measureText(text).width;
      if (current.words.length > 0 && current.width + spaceWidth + w > maxTextWidth) {
        lines.push(current);
        current = { words: [], width: 0 };
      }
      current.width = current.words.length === 0 ? w : current.width + spaceWidth + w;
      current.words.push({ text, highlight });
    };

    if (karaoke) {
      // Word-level cues (Whisper): the full phrase, active word highlighted.
      for (let i = 0; i < (words as WordTimestamp[]).length; i++) {
        appendToken((words as WordTimestamp[])[i].text, i === activeIdx);
      }
    } else {
      for (const token of cue.text.split(/\s+/).filter(Boolean)) {
        appendToken(token, false);
      }
    }
    if (current.words.length > 0) lines.push(current);
    if (lines.length === 0) return; // nothing drawable (e.g. whitespace cue)

    const lineHeight = captions.fontSizePx * 1.3;
    const blockHeight = lines.length * lineHeight;
    const maxLineWidth = Math.max(...lines.map((l) => l.width));
    const bottomMargin = captions.fontSizePx * 2;
    const blockTop = Math.max(0, canvasH - bottomMargin - blockHeight);

    // Background box behind the whole wrapped block (with padding).
    if (captions.backgroundColor) {
      const padX = captions.fontSizePx * 0.6;
      const padY = captions.fontSizePx * 0.35;
      ctx.fillStyle = captions.backgroundColor;
      ctx.fillRect(
        (canvasW - maxLineWidth) / 2 - padX,
        blockTop - padY,
        maxLineWidth + padX * 2,
        blockHeight + padY * 2,
      );
    }

    const strokeColor = captions.strokeColor;
    const strokeWidth = captions.strokeWidthPx ?? 0;
    const doStroke = strokeColor != null && strokeWidth > 0;

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const lineCenterY = blockTop + lineHeight * (li + 0.5);
      let x = (canvasW - line.width) / 2; // left edge of the centered line
      for (const seg of line.words) {
        const w = ctx.measureText(seg.text).width;
        const cx = x + w / 2;
        if (doStroke) {
          ctx.strokeStyle = strokeColor as string;
          ctx.lineWidth = strokeWidth;
          ctx.lineJoin = "round";
          ctx.strokeText(seg.text, cx, lineCenterY);
        }
        ctx.fillStyle = seg.highlight && highlightColor != null ? highlightColor : captions.color;
        ctx.fillText(seg.text, cx, lineCenterY);
        x += w + spaceWidth;
      }
    }
  } finally {
    ctx.restore();
  }
}

/** The encoder-setup request shared by runGpuExport and the v8 timeline
 * adapter — GpuExportOptions satisfies it structurally. */
export interface VideoEncoderSetup {
  width: number;
  height: number;
  fps: number;
  videoBitrate: number;
  /** VideoEncoder codec string (default "avc1.640028" — H.264 High 4:2:0 L4.0). */
  videoCodec?: string;
  /** v1.8.2: skip the prefer-hardware rung entirely (diagnostics toggle /
   * the engine's automatic stall retry — the ladder then starts at software). */
  forceSoftware?: boolean;
}

/** Which rung of the hardware→software ladder configured the encoder. */
export interface ConfiguredVideoEncoder {
  encoder: VideoEncoder;
  /** True = the prefer-hardware rung; false = the software fallback. */
  hardware: boolean;
}

/**
 * Configure the export VideoEncoder with a hardware→software fallback ladder:
 * 1. prefer-hardware + quality latency (the GPU path this module exists for),
 * 2. same codec, software, still quality latency,
 * 3. same codec, PLAIN config (no latencyMode — the native.ts-proven shape
 *    some runtimes require near level-boundary frame budgets),
 * 4. unsupported codec → GpuExportError carrying the platform's
 *    DOMException message (harvested from a real configure() attempt).
 *
 * v8: exported (the timeline adapter reuses the identical ladder) and now
 * reports which rung won via `hardware`, so callers can label the export
 * "hardware" vs "software" truthfully. H.264 codecs additionally pin
 * `avc: { format: "avc" }` (the AVCC box format mp4-muxer expects — the
 * WebCodecs default, now explicit like the browser path in native.ts).
 */
export async function configureVideoEncoder(
  opts: VideoEncoderSetup,
  onChunk: (chunk: EncodedVideoChunk, meta: EncodedVideoChunkMetadata | undefined) => void,
  onError: (e: DOMException) => void,
): Promise<ConfiguredVideoEncoder> {
  const codec = opts.videoCodec ?? "avc1.640028";
  const common: VideoEncoderConfig = {
    codec,
    width: opts.width,
    height: opts.height,
    bitrate: opts.videoBitrate,
    framerate: opts.fps,
    ...(codec.startsWith("avc1") ? { avc: { format: "avc" as const } } : {}),
  };
  const configs: VideoEncoderConfig[] = [
    // Rung 1: the GPU path this module exists for.
    { ...common, latencyMode: "quality" as const, hardwareAcceleration: "prefer-hardware" },
    // Rung 2: software encode, still quality latency.
    { ...common, latencyMode: "quality" as const },
    // Rung 3 (v1.8.1): the native.ts-proven PLAIN shape (no latencyMode).
    // Empirically required: some runtimes reject latencyMode:"quality" for
    // codecs whose H.264 level sits exactly at the frame-size/fps budget
    // (e.g. Constrained Baseline L3.0 at 1280x720@30 — headless Chromium
    // reports isConfigSupported:false there while the plain config works,
    // which is how the legacy browser path always encoded 720p).
    { ...common },
  ];

  for (let rung = opts.forceSoftware === true ? 1 : 0; rung < configs.length; rung++) {
    const config = configs[rung];
    let supported = false;
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      supported = support.supported === true;
    } catch {
      supported = false;
    }
    if (!supported) continue;
    const encoder = new VideoEncoder({ output: onChunk, error: onError });
    try {
      encoder.configure(config);
    } catch {
      // configure() rejected despite isConfigSupported — try the next rung.
      try { encoder.close(); } catch { /* already closed by the throw */ }
      continue;
    }
    return { encoder, hardware: rung === 0 };
  }

  // No config worked — harvest the platform's own DOMException message via a
  // real configure() attempt so the caller sees WHY (codec, not just "no").
  let detail = "";
  try {
    const probe = new VideoEncoder({ output: () => {}, error: () => {} });
    try {
      probe.configure(configs[configs.length - 1]);
      probe.close();
      detail = "runtime reported the codec as unsupported";
    } catch (e) {
      try { probe.close(); } catch { /* already closed */ }
      detail = e instanceof DOMException ? e.message : String(e);
    }
  } catch (e) {
    detail = e instanceof DOMException ? e.message : String(e);
  }
  throw new GpuExportError(
    `VideoEncoder does not support ${codec} at ${opts.width}x${opts.height}@${opts.fps}: ${detail}`,
  );
}

/**
 * runGpuExport — the full GPU export pipeline.
 *
 * Timeline model: the export duration is the max of all clip ends and audio
 * track ends. Every output frame at `t = frameIndex / fps`:
 *   1. black opaque base (clearRect + fillRect — alpha must be opaque or the
 *      encoder ghosts transparency),
 *   2. every clip active at `t` (start ≤ t < end) paints its decoded source
 *      frame (fit into its rect),
 *   3. captions draw on top,
 *   4. the canvas becomes a VideoFrame (timestamp µs, duration 1/fps) and is
 *      encoded — then closed IMMEDIATELY.
 *
 * One SourceDecoder per clip (lazy on first use, eagerly cleaned up once its
 * clip ends): the simplest ownership model — each decoder exclusively owns
 * its source bytes and frame queue. Repeated sources intentionally get one
 * decoder per clip (documented trade-off: RAM = N × source size while
 * overlapping; sequential timelines free each source as its clip passes).
 *
 * Audio (when `tracks` is non-empty) renders CONCURRENTLY with the frame
 * loop — both feed the muxer; audio is awaited after the loop.
 */
export async function runGpuExport(opts: GpuExportOptions): Promise<GpuExportResult> {
  if (opts.width <= 0 || opts.height <= 0) {
    throw new GpuExportError(`invalid output dimensions ${opts.width}x${opts.height}`);
  }
  if (opts.fps <= 0) throw new GpuExportError(`invalid fps ${opts.fps}`);
  if (opts.videoBitrate <= 0) throw new GpuExportError("videoBitrate must be positive");
  if (typeof OffscreenCanvas === "undefined") {
    throw new GpuExportError("OffscreenCanvas is unavailable in this runtime");
  }
  if (typeof VideoEncoder === "undefined") {
    throw new GpuExportError("WebCodecs VideoEncoder is unavailable in this runtime");
  }
  if ((!opts.clips || opts.clips.length === 0) && (!opts.tracks || opts.tracks.length === 0)) {
    throw new GpuExportError("GPU export needs at least one video clip or audio track");
  }
  const clips = opts.clips ?? [];

  // Export duration: max over clip ends + audio ends (audio-only exports are
  // allowed — the video track then renders black frames under the captions).
  let durationMs = 0;
  for (const clip of clips) durationMs = Math.max(durationMs, clip.timelineEndMs);
  for (const track of opts.tracks ?? []) {
    durationMs = Math.max(durationMs, (track.startSec + track.durationSec) * 1000);
  }
  if (durationMs <= 0) throw new GpuExportError("GPU export timeline is empty (no positive clip/track durations)");

  const totalFrames = Math.max(1, Math.round((durationMs / 1000) * opts.fps));
  const frameDurationUs = Math.round(1e6 / opts.fps);
  const keyInterval = keyframeIntervalFrames(opts.fps);

  const bridge = getExportStreamer();
  const outputPath =
    typeof opts.outputPath === "string" && opts.outputPath.length > 0 ? opts.outputPath : null;
  const useIpc = bridge !== null && outputPath !== null;
  const sink = new ChunkSink(useIpc ? bridge : null);
  if (useIpc && bridge && outputPath) {
    bridge.exportStart(outputPath);
  }

  const canvas = new OffscreenCanvas(opts.width, opts.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    await sink.finalize();
    throw new GpuExportError("failed to acquire a 2d context on the OffscreenCanvas");
  }

  // One decoder per clip — created lazily, released eagerly (see doc note).
  const decoders = new Map<number, SourceDecoder>();
  let videoEncoder: VideoEncoder | null = null;
  let encoderClosed = false;
  let sinkFinalized = false;
  let audioPromise: Promise<unknown> | null = null;
  let framesEncoded = 0;

  try {
    // NOTE (deviation from the task's literal ArrayBufferTarget wording):
    // StreamTarget is used instead — ArrayBufferTarget only exposes bytes
    // AFTER finalize() (mid-mux extraction is impossible), which would keep
    // the whole file in RAM.
    //
    // NOTE (deviation #2, EMPIRICALLY FORCED): the task prescribed
    // `fastStart: false` (moov-at-end), but mp4-muxer 5.2.2 PATCHES the mdat
    // box size at finalize() — a BACKWARD write (16 bytes at position
    // ftypSize) that an append-only IPC stream cannot apply (verified live in
    // the browser E2E: "position 24 ≠ N bytes written"). `fastStart:
    // "fragmented"` is the one mode whose ENTIRE byte stream is strictly
    // append-only: moov rides at the START (fragment #1), each moof+mdat
    // fragment is written with its final size (no patches), and the single
    // 4-byte mfra trailer patch is merged by the muxer's own section flush
    // into one final contiguous chunk. The ChunkSink asserts sequential
    // positions and fails loud if that contract ever breaks. fMP4 plays in
    // Chrome/VLC/WMP/ffmpeg and keeps RAM bounded at ~1 s of media per
    // fragment — the streaming-native MP4 profile.
    const muxer = new Muxer({
      target: new StreamTarget({
        // ⚠ mp4-muxer 5.2.2 arity-validates onData — it MUST declare BOTH
        // (data, position) parameters or the constructor throws a TypeError.
        onData: (data: Uint8Array, position: number): void => {
          sink.push(data, position);
        },
      }),
      video: {
        codec: opts.muxerVideoCodec ?? "avc",
        width: opts.width,
        height: opts.height,
        frameRate: opts.fps,
      },
      audio:
        opts.tracks && opts.tracks.length > 0
          ? { codec: "aac", numberOfChannels: 2, sampleRate: 48000 }
          : undefined,
      fastStart: "fragmented", // append-only-safe (see NOTE #2 above)
      minFragmentDuration: 1, // 1 s fragments: ~200 KB moof overhead for 19 min
    });

    let encoderFatal: unknown = null;
    videoEncoder = (
      await configureVideoEncoder(
        opts,
        (chunk, meta) => {
          muxer.addVideoChunk(chunk, meta);
        },
        (e) => {
          encoderFatal = e;
        },
      )
    ).encoder;

    // Audio renders concurrently with the frame loop — chunks flow straight
    // into the muxer; the promise is awaited after the loop, before flush.
    if (opts.tracks && opts.tracks.length > 0) {
      const mixer = new AudioMixer((chunk, meta) => {
        muxer.addAudioChunk(chunk, meta);
      });
      const p = mixer.renderAudio(durationMs / 1000, opts.tracks);
      // Swallow-side handler: if the video loop aborts/errors BEFORE this
      // promise is awaited, its eventual rejection would otherwise surface as
      // an unhandled rejection. Attaching a catch does not consume the
      // rejection — the success path's `await` still sees and rethrows it.
      p.catch(() => {
        /* surfaced by the awaiting path, or the export already failed */
      });
      audioPromise = p;
    }

    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
      if (opts.signal?.aborted) throw new ExportAbortedError();
      if (encoderFatal) {
        throw new GpuExportError(`video encoder failed: ${errMessage(encoderFatal)}`);
      }

      const currentTimeMs = (frameIndex / opts.fps) * 1000;

      // Backpressure: don't let the encoder queue grow without bound.
      while (videoEncoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
        if (opts.signal?.aborted) throw new ExportAbortedError();
        if (encoderFatal) {
          throw new GpuExportError(`video encoder failed: ${errMessage(encoderFatal)}`);
        }
        await delay(10);
      }

      // Opaque black base — a transparent canvas would encode ghosting.
      ctx.clearRect(0, 0, opts.width, opts.height);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, opts.width, opts.height);

      for (let clipIndex = 0; clipIndex < clips.length; clipIndex++) {
        const clip = clips[clipIndex];
        if (!(currentTimeMs >= clip.timelineStartMs && currentTimeMs < clip.timelineEndMs)) {
          continue;
        }
        let decoder = decoders.get(clipIndex) ?? null;
        if (!decoder) {
          decoder = await SourceDecoder.fromUrl(clip.source);
          decoders.set(clipIndex, decoder);
        }
        const sourceTimeMs =
          clip.sourceInMs + (currentTimeMs - clip.timelineStartMs) * (clip.playbackRate ?? 1);
        // Caller-owned CLONE — closed immediately after the draw (⚠ VRAM rule).
        const frame = await decoder.getFrameForTimestamp(sourceTimeMs);
        try {
          const dest = fitRect(
            frame.displayWidth,
            frame.displayHeight,
            clip.rect ?? { x: 0, y: 0, width: opts.width, height: opts.height },
            clip.fit ?? "cover",
          );
          // Draw the VISIBLE rect only (coded padding excluded).
          const vr = frame.visibleRect;
          if (vr) {
            ctx.drawImage(
              frame,
              vr.x,
              vr.y,
              vr.width,
              vr.height,
              dest.x,
              dest.y,
              dest.width,
              dest.height,
            );
          } else {
            ctx.drawImage(frame, dest.x, dest.y, dest.width, dest.height);
          }
        } finally {
          frame.close(); // ⚠ immediately after last use — no path leaks it
        }
      }

      if (opts.captions) {
        drawGpuCaptions(ctx, opts.captions, currentTimeMs, opts.width, opts.height);
      }

      // Eager release: a clip whose window has passed can never be requested
      // again (the loop walks time monotonically) — free its source bytes.
      for (let clipIndex = 0; clipIndex < clips.length; clipIndex++) {
        if (clips[clipIndex].timelineEndMs <= currentTimeMs) {
          const finished = decoders.get(clipIndex);
          if (finished) {
            finished.cleanup();
            decoders.delete(clipIndex);
          }
        }
      }

      const newFrame = new VideoFrame(canvas, {
        timestamp: Math.round(currentTimeMs * 1000),
        duration: frameDurationUs,
      });
      try {
        videoEncoder.encode(newFrame, { keyFrame: frameIndex % keyInterval === 0 });
      } finally {
        newFrame.close(); // ⚠ immediately after last use — no path leaks it
      }
      framesEncoded++;

      if (frameIndex % 30 === 0) {
        opts.onProgress?.(frameIndex, totalFrames);
      }
    }
    opts.onProgress?.(totalFrames, totalFrames);

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
    sinkFinalized = true;
    await sink.finalize();

    return {
      // IPC mode: zero-length stub — the bytes live in the file on disk.
      bytes: sink.getBytes(),
      framesEncoded,
      durationMs,
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
    if (!sinkFinalized) {
      // Still call exportEnd so the streamed file on disk is closed cleanly
      // (partial file, moov missing — documented abort semantics).
      try {
        await sink.finalize();
      } catch {
        /* the sink never throws, but never block cleanup */
      }
      sinkFinalized = true;
    }
  }
}
