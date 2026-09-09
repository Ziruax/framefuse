// src/lib/merger/native.ts — export orchestration
// Primary: native FFmpeg (Electron). Browser preview fallbacks:
//   1. WebCodecs + mp4-muxer (fast MP4)
//   2. MediaRecorder (real-time WebM)
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import type {
  ExportNativeOptions,
  ExportProgress,
  ExportResult,
  MediaSegment,
} from "./types";
import { drawFrame, resolveDimensions } from "./renderer";
import { getCaptionPreset, getFontOption } from "./captionPresets";
import { cueAt, activeWordIndex, type WordTimestamp } from "./subtitles";
import {
  computeWordTransform,
  IDENTITY_TRANSFORM,
  type WordTransform,
} from "./captionAnimations";
import type { CaptionAnimation } from "./types";

/** True when running inside the FrameFuse Electron shell. */
export function isElectron(): boolean {
  return typeof window !== "undefined" && !!window.electronAPI;
}

function fetchBytes(url: string): Promise<ArrayBuffer> {
  return fetch(url).then((r) => r.arrayBuffer());
}

/**
 * Build the FFmpeg force_style string for the active caption settings.
 * Applies font, color, position, and size overrides on top of the preset.
 */
export function buildCaptionFfmpegStyle(opts: {
  presetId: string;
  fontId: string;
  customColor: string | null;
  customPosition: "top" | "center" | "bottom" | null;
  fontSizeScale: number;
  videoHeight: number;
}): string {
  const preset = getCaptionPreset(opts.presetId);
  const font = getFontOption(opts.fontId);

  // Font size: preset.fontSize is a fraction of video height.
  // ASS FontSize is in points; for libass at the canvas resolution we use
  // px = fraction * videoHeight * scale.
  const fontPx = Math.max(
    8,
    Math.round(preset.fontSize * opts.videoHeight * (opts.fontSizeScale || 1)),
  );

  const textColor = opts.customColor || preset.textColor;
  const position = opts.customPosition || preset.position;

  // Position V (margin from the chosen edge). For "center" we use 0; for
  // top/bottom we offset by the preset's positionY so captions aren't flush.
  let marginV = preset.positionY;
  if (position === "center") marginV = 0;

  // Alignment numpad: 1/2/3 = bottom L/C/R, 4/5/6 = middle L/C/R, 7/8/9 = top L/C/R.
  const row = position === "top" ? 7 : position === "center" ? 4 : 1;
  const col =
    preset.alignment === "left" ? 0 : preset.alignment === "right" ? 2 : 1;
  const alignment = row + col;

  // Bold / italic.
  const bold = preset.fontWeight >= 600 ? -1 : 0;
  const italic = preset.fontStyle === "italic" ? -1 : 0;

  // ASS colors: &HAABBGGRR (alpha inverted vs CSS).
  const toAss = (hex: string, alpha = 1): string => {
    const h = hex.replace(/^#/, "");
    const r = h.slice(0, 2);
    const g = h.slice(2, 4);
    const b = h.slice(4, 6);
    const assAlpha = Math.round((1 - alpha) * 255)
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
    return `&H${assAlpha}${b}${g}${r}`.toUpperCase();
  };

  const parts: string[] = [
    `FontName=${font.ffmpegName}`,
    `FontSize=${fontPx}`,
    `PrimaryColour=${toAss(textColor, 1)}`,
    `OutlineColour=${toAss(preset.borderColor || "#000000", 1)}`,
  ];
  if (preset.bgColor) {
    parts.push(`BackColour=${toAss(preset.bgColor, preset.bgAlpha)}`);
  }
  parts.push(`Bold=${bold}`);
  parts.push(`Italic=${italic}`);
  parts.push(`BorderStyle=${preset.bgColor ? 3 : 1}`);
  parts.push(`Outline=${preset.borderWidth}`);
  parts.push(
    `Shadow=${preset.shadow ? Math.max(1, Math.round(preset.shadowBlur)) : 0}`,
  );
  parts.push(`Alignment=${alignment}`);
  parts.push(`MarginL=24`);
  parts.push(`MarginR=24`);
  parts.push(`MarginV=${marginV}`);

  return parts.join(",");
}

// ---------------------------------------------------------------------------
// Native FFmpeg path (Electron)
// ---------------------------------------------------------------------------
async function exportViaFFmpeg(opts: ExportNativeOptions): Promise<ExportResult> {
  const api = window.electronAPI!;
  const {
    segments,
    imageUrls,
    audioTrack,
    settings,
    kenBurns,
    onProgress,
    signal,
    subtitles,
    captionSettings,
  } = opts;

  const dims = resolveDimensions(settings.aspect, settings.resolution);

  // 1. Persist images to temp files.
  // Include absolute startMs/endMs so the main process can map SRT cue
  // timestamps (which are in master-timeline absolute time) onto each
  // per-segment clip (whose internal clock starts at 0). Without this
  // mapping, only cues whose original startMs falls within [0, dur] of
  // every clip would be burned in — i.e. the first caption repeats.
  const segPayload: {
    imagePath: string;
    direction: string;
    durationMs: number;
    startMs: number;
    endMs: number;
  }[] = [];
  for (const seg of segments) {
    const url = imageUrls[seg.id] || seg.thumbnailUrl;
    const bytes = await fetchBytes(url);
    const imagePath = await api.saveTempImage({
      name: seg.fileName || `seg_${seg.id}.jpg`,
      bytes,
    });
    segPayload.push({
      imagePath,
      direction: seg.direction,
      durationMs: seg.durationMs,
      startMs: seg.startMs,
      endMs: seg.endMs,
    });
  }

  // 2. Persist audio if present.
  let audioPath: string | null = null;
  if (audioTrack) {
    const bytes = await fetchBytes(audioTrack.url);
    audioPath = await api.saveTempAudio({
      name: audioTrack.fileName,
      bytes,
    });
  }

  // 3. Build caption payload if captions are enabled.
  let ipcCaptionSettings: Record<string, unknown> | undefined = undefined;
  let ipcSubtitleCues: unknown[] | undefined = undefined;

  if (
    captionSettings?.enabled &&
    subtitles &&
    subtitles.cues.length > 0
  ) {
    const preset = getCaptionPreset(captionSettings.presetId);
    const font = getFontOption(captionSettings.fontId);

    ipcCaptionSettings = {
      enabled: true,
      // Font
      fontName: font.ffmpegName,
      fontSize: preset.fontSize,
      fontSizeScale: captionSettings.fontSizeScale || 1,
      fontWeight: preset.fontWeight,
      fontStyle: preset.fontStyle,
      // Colors
      textColor: captionSettings.customColor || preset.textColor,
      borderColor: preset.borderColor || "#000000",
      borderWidth: preset.borderWidth,
      highlightColor: preset.highlightColor || null,
      // Background
      bgColor: preset.bgColor,
      bgAlpha: preset.bgAlpha,
      bgPadding: preset.bgPadding,
      bgRadius: preset.bgRadius,
      // Shadow
      shadow: preset.shadow,
      shadowColor: preset.shadowColor,
      shadowBlur: preset.shadowBlur,
      // Text
      textTransform: preset.textTransform,
      letterSpacing: preset.letterSpacing,
      alignment: preset.alignment,
      // Position
      position: preset.position,
      positionY: preset.positionY,
      customPosition: captionSettings.customPosition,
      // Word-by-word mode (renderer → main process)
      wordMode: captionSettings.wordMode || "off",
      // Kinetic typography animation (renderer → main process)
      animation: captionSettings.animation || "none",
    };

    // Send per-word timestamps so the main process can build ASS \k
    // karaoke tags / per-word Dialogue lines + \t animation tags. Cues
    // without word timestamps (plain .srt) just carry text + cue times.
    ipcSubtitleCues = subtitles.cues.map((c) => ({
      startMs: c.startMs,
      endMs: c.endMs,
      text: c.text,
      words: c.words
        ? c.words.map((w) => ({
            text: w.text,
            startMs: w.startMs,
            endMs: w.endMs,
          }))
        : undefined,
    }));
  }

  // 4. Choose output path.
  const outputPath = await api.chooseOutput();
  if (!outputPath) {
    await api.cleanupTemp();
    throw new Error("Export cancelled");
  }

  // 5. Subscribe to progress.
  const unsubscribe = api.onExportProgress((d: ExportProgress) => {
    onProgress?.(d);
  });

  const onAbort = () => {
    api.cancelExport();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const result = await api.exportNative({
      outputPath,
      fps: settings.fps,
      width: dims.w,
      height: dims.h,
      bitrateMbps: settings.bitrateMbps,
      kenBurns,
      segments: segPayload,
      audioPath,
      captionSettings: ipcCaptionSettings,
      subtitleCues: ipcSubtitleCues,
    });
    return result;
  } finally {
    unsubscribe();
    if (signal) signal.removeEventListener("abort", onAbort);
    await api.cleanupTemp();
  }
}

// ---------------------------------------------------------------------------
// Browser fallback 1: WebCodecs + mp4-muxer (fast MP4)
// ---------------------------------------------------------------------------
async function exportViaWebCodecs(
  opts: ExportNativeOptions,
): Promise<ExportResult> {
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

  const W = typeof window !== "undefined" ? (window as any) : null;
  const VideoEncoderCtor = W?.VideoEncoder;
  const VideoFrameCtor = W?.VideoFrame;
  if (!VideoEncoderCtor || !VideoFrameCtor) {
    throw new Error("NO_WEBCODECS");
  }

  // Cap browser export at 720p for performance.
  const dims = resolveDimensions(settings.aspect, "720p");
  const fps = settings.fps;
  const totalFrames = Math.max(1, Math.round((totalMs / 1000) * fps));

  const canvas = document.createElement("canvas");
  canvas.width = dims.w;
  canvas.height = dims.h;
  const ctx = canvas.getContext("2d", { alpha: false })!;

  // Preload all images.
  const imgCache = new Map<string, HTMLImageElement>();
  await Promise.all(
    segments.map(
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

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width: dims.w, height: dims.h },
    fastStart: "in-memory",
  });

  const bitrate = Math.round(settings.bitrateMbps * 1_000_000);
  // Pick an H.264 codec string appropriate for the resolution.
  const codec =
    dims.w * dims.h <= 1280 * 720 ? "avc1.42E01E" : "avc1.4D4028";

  let encodeError: any = null;
  const encoder = new VideoEncoderCtor({
    output: (chunk: any, meta: any) => muxer.addVideoChunk(chunk, meta),
    error: (e: any) => {
      encodeError = e;
    },
  });

  encoder.configure({
    codec,
    width: dims.w,
    height: dims.h,
    bitrate,
    framerate: fps,
    avc: { format: "avc" },
  });

  const frameDurationUs = Math.round(1_000_000 / fps);

  // Precompute caption drawing options once.
  const drawCaptions =
    captionSettings?.enabled && subtitles && subtitles.cues.length > 0
      ? (currentMsLocal: number) => {
          const cue = cueAt(subtitles.cues, currentMsLocal);
          if (!cue) return;
          // Pass per-word timestamps + current time + cue window +
          // animation so the word-mode presets and kinetic typography
          // animations render identically to the preview.
          const capCtx = {
            ...captionSettings,
            words: cue.words,
            currentMs: currentMsLocal,
            cueStartMs: cue.startMs,
            cueEndMs: cue.endMs,
          };
          drawCaption(ctx, cue.text, capCtx, dims.w, dims.h);
        }
      : null;

  for (let i = 0; i < totalFrames; i++) {
    if (signal?.aborted) {
      try {
        encoder.close();
      } catch {
        /* noop */
      }
      throw new Error("Export cancelled");
    }
    if (encodeError) throw encodeError;

    const currentMs = (i / fps) * 1000;
    const seg =
      segments.find((s) => currentMs >= s.startMs && currentMs < s.endMs) ||
      segments[segments.length - 1];
    const img = seg ? imgCache.get(seg.id) : null;
    if (seg) drawFrame(ctx, img ?? null, seg, currentMs, dims.w, dims.h, kenBurns);
    if (drawCaptions) drawCaptions(currentMs);

    const frame = new VideoFrameCtor(canvas, {
      timestamp: i * frameDurationUs,
      duration: frameDurationUs,
    });
    encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();

    // Backpressure: don't queue too many frames.
    if (encoder.encodeQueueSize > 8) {
      await new Promise((r) => setTimeout(r, 4));
    }

    onProgress?.({
      progress: ((i + 1) / totalFrames) * 100,
      fps: 0,
      timemark: undefined,
    });
  }

  await encoder.flush();
  if (encodeError) throw encodeError;
  muxer.finalize();
  encoder.close();

  const { buffer } = muxer.target as ArrayBufferTarget;
  const blob = new Blob([buffer], { type: "video/mp4" });

  // Trigger a browser download (no native save dialog).
  const downloadUrl = URL.createObjectURL(blob);
  triggerDownload(downloadUrl, `framefuse_${Date.now()}.mp4`);
  setTimeout(() => URL.revokeObjectURL(downloadUrl), 60000);

  return { path: "(browser download) framefuse.mp4", size: blob.size };
}

// ---------------------------------------------------------------------------
// Browser fallback 2: MediaRecorder (real-time WebM)
// ---------------------------------------------------------------------------
async function exportViaMediaRecorder(
  opts: ExportNativeOptions,
): Promise<ExportResult> {
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

  const dims = resolveDimensions(settings.aspect, "720p");
  const fps = settings.fps;

  const canvas = document.createElement("canvas");
  canvas.width = dims.w;
  canvas.height = dims.h;
  const ctx = canvas.getContext("2d", { alpha: false })!;

  const imgCache = new Map<string, HTMLImageElement>();
  await Promise.all(
    segments.map(
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

  const stream = (canvas as any).captureStream(fps) as MediaStream;
  const mimeType = pickMime();
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: settings.bitrateMbps * 1_000_000,
  });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const done = new Promise<ExportResult>((resolve) => {
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      triggerDownload(
        url,
        `framefuse_${Date.now()}.${mimeType.includes("mp4") ? "mp4" : "webm"}`,
      );
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      resolve({ path: "(browser download)", size: blob.size });
    };
  });

  recorder.start();
  const start = performance.now();

  const drawCaptionsMR =
    captionSettings?.enabled && subtitles && subtitles.cues.length > 0
      ? (currentMsLocal: number) => {
          const cue = cueAt(subtitles.cues, currentMsLocal);
          if (!cue) return;
          const capCtx = {
            ...captionSettings,
            words: cue.words,
            currentMs: currentMsLocal,
            cueStartMs: cue.startMs,
            cueEndMs: cue.endMs,
          };
          drawCaption(ctx, cue.text, capCtx, dims.w, dims.h);
        }
      : null;

  await new Promise<void>((resolve) => {
    const tick = () => {
      const elapsed = performance.now() - start;
      const currentMs = Math.min(elapsed, totalMs);
      const seg =
        segments.find((s) => currentMs >= s.startMs && currentMs < s.endMs) ||
        segments[segments.length - 1];
      const img = seg ? imgCache.get(seg.id) : null;
      if (seg)
        drawFrame(ctx, img ?? null, seg, currentMs, dims.w, dims.h, kenBurns);
      if (drawCaptionsMR) drawCaptionsMR(currentMs);

      onProgress?.({
        progress: Math.min(100, (currentMs / totalMs) * 100),
        fps,
      });

      if (signal?.aborted || currentMs >= totalMs) {
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  recorder.stop();
  return done;
}

function pickMime(): string {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
  ];
  for (const c of candidates) {
    if (
      typeof MediaRecorder !== "undefined" &&
      MediaRecorder.isTypeSupported(c)
    ) {
      return c;
    }
  }
  return "video/webm";
}

function triggerDownload(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ---------------------------------------------------------------------------
// Canvas caption drawing — used by both the preview and the WebCodecs /
// MediaRecorder browser exporters. The Electron FFmpeg path uses libass
// instead (see buildCaptionFfmpegStyle).
// ---------------------------------------------------------------------------

interface CanvasCaptionCtx {
  enabled: boolean;
  presetId: string;
  fontId: string;
  customColor: string | null;
  customPosition: "top" | "center" | "bottom" | null;
  fontSizeScale: number;
  /** Balanced text wrapping (only used in standard full-text mode). */
  balancedWrap?: boolean;
  /**
   * Word-by-word rendering mode. When "word" or "word-only" is set,
   * `drawCaption` expects `words` + `currentMs` so it can highlight or
   * show only the currently-spoken word. Cues without word timestamps
   * always fall back to full-text rendering.
   */
  wordMode?: "off" | "word" | "word-only";
  /** Per-word timestamps for the current cue (only present when ASR-generated). */
  words?: WordTimestamp[];
  /** Master-timeline time (ms) used to find the active word. */
  currentMs?: number;
  /** Kinetic typography animation. Drives per-word transforms. */
  animation?: CaptionAnimation;
  /** Absolute startMs of the current cue (for whole-cue animation fallback). */
  cueStartMs?: number;
  /** Absolute endMs of the current cue (for whole-cue animation fallback). */
  cueEndMs?: number;
}

/**
 * Draw a caption text onto a 2D canvas context using the active preset.
 *
 * Layout strategy (full-text mode):
 *   1. Apply text-transform (uppercase/lowercase).
 *   2. Wrap text using measureText to fit maxWidth.
 *   3. Compute total text block height.
 *   4. Compute anchor Y based on preset.position + positionY.
 *   5. If preset.bgColor → draw a rounded rect behind the text.
 *   6. If preset.borderColor → stroke the text.
 *   7. If preset.shadow → enable ctx.shadowBlur/shadowColor before fill.
 *   8. fillText each wrapped line.
 *
 * Word-by-word modes (require cue.words[]):
 *   - "word": all words rendered with `textColor`, the currently-spoken
 *     word re-rendered on top with `highlightColor` (or scaled+bolder
 *     when no highlight color is set). Reads as a karaoke highlight.
 *   - "word-only": only the currently-spoken word is rendered, centered,
 *     large. Hormozi/attention-grabber style.
 *
 * Kinetic typography animations (animation != "none"):
 *   Each word's transform is computed via computeWordTransform() and
 *   applied as scale / alpha / offset / clip before rendering. This
 *   works in all three word modes (off / word / word-only). When the
 *   cue has no word timestamps, the animation falls back to a whole-
 *   cue fade/scale using cue.startMs → cue.endMs (best-effort).
 */
export function drawCaption(
  ctx: CanvasRenderingContext2D,
  rawText: string,
  caption: CanvasCaptionCtx,
  cw: number,
  ch: number,
): void {
  if (!caption?.enabled) return;
  const text = rawText ?? "";
  if (!text) return;

  const preset = getCaptionPreset(caption.presetId);
  const font = getFontOption(caption.fontId);
  const textColor = caption.customColor || preset.textColor;
  const position = caption.customPosition || preset.position;
  const scale = caption.fontSizeScale || 1;

  // Resolve the active animation: explicit override > preset default.
  const animation: CaptionAnimation =
    caption.animation || preset.animation || "none";

  // ── Word-by-word modes short-circuit the standard flow ──
  const wordMode = caption.wordMode ?? "off";
  const words = caption.words;
  const hasWords = words && words.length > 0;
  if ((wordMode === "word" || wordMode === "word-only") && hasWords) {
    if (wordMode === "word-only") {
      drawWordOnly(ctx, text, caption, preset, font, textColor, cw, ch, animation);
      return;
    }
    drawWordHighlight(ctx, text, caption, preset, font, textColor, cw, ch, animation);
    return;
  }

  // ── Standard full-text mode (with optional whole-cue animation) ──
  // If an animation is active and we don't have word timestamps,
  // apply the animation transform to the whole cue (fade-through /
  // pop-in / drift) using cue start/end as the time window. This is
  // a best-effort fallback so animations don't visually break when
  // a user picks an animation but loads a plain .srt.
  if (animation !== "none" && hasWords) {
    drawWordAnimated(ctx, text, caption, preset, font, textColor, cw, ch, animation);
    return;
  }

  // Font size: fraction of canvas height.
  const fontPx = Math.max(8, Math.round(preset.fontSize * ch * scale));
  const weight = preset.fontWeight;
  const italic = preset.fontStyle === "italic" ? "italic " : "";
  ctx.font = `${italic}${weight} ${fontPx}px ${font.stack}`;
  ctx.textBaseline = "top";

  // Whole-cue animation fallback (no word timestamps).
  // Used when an animation is active but the cue has no per-word
  // timestamps (e.g. user loaded a plain .srt). We apply the animation
  // transform to the whole cue using the cue's actual [start, end]
  // window so the "in" transition plays correctly.
  let cueTransform: WordTransform = IDENTITY_TRANSFORM;
  if (animation !== "none" && !hasWords) {
    const cueStart = caption.cueStartMs ?? 0;
    const cueEnd = caption.cueEndMs ?? (cueStart + 200);
    const current = caption.currentMs ?? cueStart;
    cueTransform = computeWordTransform(
      animation,
      cueStart,
      cueEnd,
      current,
      0,
      0,
      0,
      ch,
    );
  }

  // Letter spacing (modern canvas API — guarded).
  try {
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing =
      `${preset.letterSpacing}px`;
  } catch {
    /* not supported — ignore */
  }

  // Text transform.
  let display = text;
  if (preset.textTransform === "uppercase") display = text.toUpperCase();
  else if (preset.textTransform === "lowercase") display = text.toLowerCase();

  // Wrap.
  const maxW = Math.max(40, preset.maxWidth * cw);
  const lineHeight = Math.round(fontPx * 1.25);
  const lines = caption.balancedWrap
    ? balancedWrapText(ctx, display, maxW)
    : wrapText(ctx, display, maxW);
  if (lines.length === 0) return;

  const blockH = lines.length * lineHeight;
  const padding = Math.round((preset.bgPadding / 1080) * ch);
  const radius = Math.round((preset.bgRadius / 1080) * ch);
  const maxWidthLine = Math.max(...lines.map((l) => ctx.measureText(l).width));

  // Anchor Y for the text block (top of block).
  const positionYpx = Math.round((preset.positionY / 1080) * ch);
  let blockTop: number;
  if (position === "top") {
    blockTop = positionYpx;
  } else if (position === "center") {
    blockTop = (ch - blockH) / 2 + positionYpx;
  } else {
    blockTop = ch - blockH - positionYpx;
  }

  // Horizontal anchor.
  const blockLeft = (cw - maxWidthLine) / 2;
  const blockRight = blockLeft + maxWidthLine;

  // Alignment per-line (left/center/right).
  const alignLineX = (line: string): number => {
    const w = ctx.measureText(line).width;
    if (preset.alignment === "left") return blockLeft;
    if (preset.alignment === "right") return blockRight - w;
    return (cw - w) / 2;
  };

  // Background box.
  if (preset.bgColor) {
    const boxX = blockLeft - padding;
    const boxY = blockTop - padding;
    const boxW = maxWidthLine + padding * 2;
    const boxH = blockH + padding * 2;
    ctx.save();
    ctx.globalAlpha = preset.bgAlpha * cueTransform.alpha;
    ctx.fillStyle = preset.bgColor;
    drawRoundedRect(ctx, boxX, boxY, boxW, boxH, radius);
    ctx.fill();
    ctx.restore();
  }

  // Shadow + border + fill per line, with whole-cue transform applied.
  // The transform (scale/offset/clip) is applied around the text block's
  // center so the animation visibly plays in preview. Without this, only
  // the alpha would animate and the preview wouldn't match the export.
  ctx.save();
  ctx.globalAlpha = cueTransform.alpha;
  if (preset.shadow) {
    ctx.shadowColor = preset.shadowColor;
    ctx.shadowBlur = preset.shadowBlur * (ch / 540);
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }
  // Apply the whole-cue transform (scale/offset/clip) around the text
  // block's center. clipLeft is applied via a rect clip over the full
  // text block width.
  if (
    cueTransform.scale !== 1 ||
    cueTransform.offsetX !== 0 ||
    cueTransform.offsetY !== 0 ||
    cueTransform.rotation !== 0
  ) {
    const cx = blockLeft + maxWidthLine / 2;
    const cy = blockTop + blockH / 2;
    ctx.translate(cx + cueTransform.offsetX, cy + cueTransform.offsetY);
    ctx.rotate(cueTransform.rotation);
    ctx.scale(cueTransform.scale, cueTransform.scale);
    ctx.translate(-cx, -cy);
  }
  if (cueTransform.clipLeft < 1) {
    ctx.beginPath();
    ctx.rect(blockLeft, blockTop, maxWidthLine * cueTransform.clipLeft, blockH);
    ctx.clip();
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const x = alignLineX(line);
    const y = blockTop + i * lineHeight;

    if (preset.borderColor && preset.borderWidth > 0) {
      ctx.lineJoin = "round";
      ctx.strokeStyle = preset.borderColor;
      ctx.lineWidth = Math.max(
        1,
        (preset.borderWidth / 1080) * ch * 2,
      );
      ctx.strokeText(line, x, y);
    }

    ctx.fillStyle = textColor;
    ctx.fillText(line, x, y);
  }
  ctx.restore();

  // Reset letterSpacing to avoid leaking into other draws.
  try {
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing =
      "0px";
  } catch {
    /* noop */
  }
}

// ---------------------------------------------------------------------------
// Word-by-word rendering helpers — used when captionSettings.wordMode is
// "word" (full text + highlighted active word) or "word-only" (only the
// currently-spoken word). Both need per-word timestamps from Whisper.
// Kinetic typography animations are applied per-word in both modes.
// ---------------------------------------------------------------------------

function setupWordFont(
  ctx: CanvasRenderingContext2D,
  preset: ReturnType<typeof getCaptionPreset>,
  font: ReturnType<typeof getFontOption>,
  ch: number,
  scale: number,
): { fontPx: number; lineHeight: number } {
  const fontPx = Math.max(8, Math.round(preset.fontSize * ch * scale));
  const italic = preset.fontStyle === "italic" ? "italic " : "";
  ctx.font = `${italic}${preset.fontWeight} ${fontPx}px ${font.stack}`;
  ctx.textBaseline = "top";
  try {
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing =
      `${preset.letterSpacing}px`;
  } catch {
    /* noop */
  }
  return { fontPx, lineHeight: Math.round(fontPx * 1.25) };
}

function applyTransformText(
  text: string,
  preset: ReturnType<typeof getCaptionPreset>,
): string {
  if (preset.textTransform === "uppercase") return text.toUpperCase();
  if (preset.textTransform === "lowercase") return text.toLowerCase();
  return text;
}

/**
 * Apply a WordTransform to the canvas state before drawing a word.
 * Returns a save/restore pair via the caller's ctx.save()/ctx.restore().
 */
function applyWordTransform(
  ctx: CanvasRenderingContext2D,
  t: WordTransform,
  wordX: number,
  wordY: number,
  wordW: number,
  wordH: number,
): void {
  // Alpha
  ctx.globalAlpha *= t.alpha;
  // Translation + scale around the word's center
  if (t.scale !== 1 || t.offsetX !== 0 || t.offsetY !== 0 || t.rotation !== 0) {
    const cx = wordX + wordW / 2;
    const cy = wordY + wordH / 2;
    ctx.translate(cx + t.offsetX, cy + t.offsetY);
    ctx.rotate(t.rotation);
    ctx.scale(t.scale, t.scale);
    ctx.translate(-cx, -cy);
  }
  // Clip mask: only show the left `clipLeft` fraction of the word.
  // Used by typewriter (per-character reveal) and reveal (clip-from-
  // left) animations. Must match the ASS export's \\clip() tag so the
  // preview and export render identically.
  if (t.clipLeft < 1) {
    ctx.beginPath();
    ctx.rect(wordX, wordY, wordW * t.clipLeft, wordH);
    ctx.clip();
  }
}

/**
 * Word mode — render the full cue text, then re-render the active word
 * on top in the preset's highlight color (or scaled+bolder when the
 * preset doesn't define a highlightColor). Each word gets its kinetic
 * typography animation transform applied independently.
 */
function drawWordHighlight(
  ctx: CanvasRenderingContext2D,
  text: string,
  caption: CanvasCaptionCtx,
  preset: ReturnType<typeof getCaptionPreset>,
  font: ReturnType<typeof getFontOption>,
  textColor: string,
  cw: number,
  ch: number,
  animation: CaptionAnimation,
): void {
  const scale = caption.fontSizeScale || 1;
  const position = caption.customPosition || preset.position;
  const { fontPx, lineHeight } = setupWordFont(ctx, preset, font, ch, scale);

  const words = caption.words!;
  const currentMs = caption.currentMs ?? 0;
  const activeIdx = activeWordIndex(words, currentMs);

  const display = applyTransformText(text, preset);
  const displayWords = display.split(/\s+/).filter(Boolean);
  if (displayWords.length === 0) return;

  // Wrap (greedy — balanced wrap is less useful for highlight mode).
  const maxW = Math.max(40, preset.maxWidth * cw);
  const lines: string[][] = [];
  let curLine: string[] = [];
  let curWidth = 0;
  const spaceW = ctx.measureText(" ").width;
  for (const w of displayWords) {
    const wWidth = ctx.measureText(w).width;
    const candidate = curWidth === 0 ? wWidth : curWidth + spaceW + wWidth;
    if (candidate > maxW && curLine.length > 0) {
      lines.push(curLine);
      curLine = [w];
      curWidth = wWidth;
    } else {
      curLine.push(w);
      curWidth = candidate;
    }
  }
  if (curLine.length) lines.push(curLine);

  const blockH = lines.length * lineHeight;
  const padding = Math.round((preset.bgPadding / 1080) * ch);
  const radius = Math.round((preset.bgRadius / 1080) * ch);
  const maxWidthLine = Math.max(
    ...lines.map((l) => ctx.measureText(l.join(" ")).width),
  );

  const positionYpx = Math.round((preset.positionY / 1080) * ch);
  let blockTop: number;
  if (position === "top") blockTop = positionYpx;
  else if (position === "center") blockTop = (ch - blockH) / 2 + positionYpx;
  else blockTop = ch - blockH - positionYpx;

  const blockLeft = (cw - maxWidthLine) / 2;
  const blockRight = blockLeft + maxWidthLine;

  const alignLineX = (lineStr: string): number => {
    const w = ctx.measureText(lineStr).width;
    if (preset.alignment === "left") return blockLeft;
    if (preset.alignment === "right") return blockRight - w;
    return (cw - w) / 2;
  };

  // Background box.
  if (preset.bgColor) {
    const boxX = blockLeft - padding;
    const boxY = blockTop - padding;
    const boxW = maxWidthLine + padding * 2;
    const boxH = blockH + padding * 2;
    ctx.save();
    ctx.globalAlpha = preset.bgAlpha;
    ctx.fillStyle = preset.bgColor;
    drawRoundedRect(ctx, boxX, boxY, boxW, boxH, radius);
    ctx.fill();
    ctx.restore();
  }

  // First pass — render every line with the base text color, applying
  // each word's animation transform. We split each visual line into
  // words and draw them one at a time so we can apply per-word transforms.
  ctx.save();
  if (preset.shadow) {
    ctx.shadowColor = preset.shadowColor;
    ctx.shadowBlur = preset.shadowBlur * (ch / 540);
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }

  let wordCursor = 0;
  for (let li = 0; li < lines.length; li++) {
    const lineWords = lines[li];
    const lineStr = lineWords.join(" ");
    const lineX = alignLineX(lineStr);
    const lineY = blockTop + li * lineHeight;

    // Compute x offsets of each word within the line.
    let xOffset = 0;
    for (let k = 0; k < lineWords.length; k++) {
      const w = lineWords[k];
      const wordX = lineX + xOffset;
      const wordW = ctx.measureText(w).width;
      const wordH = lineHeight;
      const wordIdx = wordCursor + k;
      const wordTs = words[wordIdx];

      // Compute the animation transform for this word.
      let t: WordTransform = IDENTITY_TRANSFORM;
      if (animation !== "none" && wordTs) {
        t = computeWordTransform(
          animation,
          wordTs.startMs,
          wordTs.endMs,
          currentMs,
          wordIdx,
          wordX,
          lineY,
          ch,
        );
      }

      ctx.save();
      applyWordTransform(ctx, t, wordX, lineY, wordW, wordH);
      if (preset.borderColor && preset.borderWidth > 0) {
        ctx.lineJoin = "round";
        ctx.strokeStyle = preset.borderColor;
        ctx.lineWidth = Math.max(1, (preset.borderWidth / 1080) * ch * 2);
        ctx.strokeText(w, wordX, lineY);
      }
      ctx.fillStyle = textColor;
      ctx.fillText(w, wordX, lineY);
      ctx.restore();

      xOffset += wordW + spaceW;
    }
    wordCursor += lineWords.length;
  }

  // Second pass — re-render only the active word in the highlight color,
  // so it visually pops above the base text. We apply the animation
  // transform too (so a "pop-in" highlight also pops).
  if (activeIdx >= 0 && activeIdx < displayWords.length) {
    wordCursor = 0;
    for (let li = 0; li < lines.length; li++) {
      const lineWords = lines[li];
      if (activeIdx >= wordCursor && activeIdx < wordCursor + lineWords.length) {
        const lineStr = lineWords.join(" ");
        const lineX = alignLineX(lineStr);

        const idxInLine = activeIdx - wordCursor;
        let xOffset = 0;
        for (let k = 0; k < idxInLine; k++) {
          xOffset += ctx.measureText(lineWords[k]).width + spaceW;
        }

        const activeWord = lineWords[idxInLine];
        const wordX = lineX + xOffset;
        const wordY = blockTop + li * lineHeight;
        const wordW = ctx.measureText(activeWord).width;
        const wordH = lineHeight;
        const wordTs = words[activeIdx];
        const highlightColor = preset.highlightColor || textColor;

        let t: WordTransform = IDENTITY_TRANSFORM;
        if (animation !== "none" && wordTs) {
          t = computeWordTransform(
            animation,
            wordTs.startMs,
            wordTs.endMs,
            currentMs,
            activeIdx,
            wordX,
            wordY,
            ch,
          );
        }

        ctx.save();
        applyWordTransform(ctx, t, wordX, wordY, wordW, wordH);
        ctx.fillStyle = highlightColor;
        if (preset.borderColor && preset.borderWidth > 0) {
          ctx.lineJoin = "round";
          ctx.strokeStyle = preset.borderColor;
          ctx.lineWidth = Math.max(1, (preset.borderWidth / 1080) * ch * 2);
          ctx.strokeText(activeWord, wordX, wordY);
        }
        ctx.fillText(activeWord, wordX, wordY);
        ctx.restore();
        break;
      }
      wordCursor += lineWords.length;
    }
  }
  ctx.restore();

  try {
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing =
      "0px";
  } catch {
    /* noop */
  }
}

/**
 * Word-only mode — render ONLY the currently-spoken word, large and
 * centered. Kinetic typography animation applied to the single word.
 */
function drawWordOnly(
  ctx: CanvasRenderingContext2D,
  _text: string,
  caption: CanvasCaptionCtx,
  preset: ReturnType<typeof getCaptionPreset>,
  font: ReturnType<typeof getFontOption>,
  textColor: string,
  cw: number,
  ch: number,
  animation: CaptionAnimation,
): void {
  const words = caption.words!;
  const currentMs = caption.currentMs ?? 0;
  const activeIdx = activeWordIndex(words, currentMs);
  if (activeIdx < 0 || activeIdx >= words.length) return;

  const scale = caption.fontSizeScale || 1;
  const position = caption.customPosition || preset.position;
  const fontPx = Math.max(
    8,
    Math.round(preset.fontSize * ch * scale * 1.15),
  );
  const italic = preset.fontStyle === "italic" ? "italic " : "";
  ctx.font = `${italic}${preset.fontWeight} ${fontPx}px ${font.stack}`;
  ctx.textBaseline = "top";
  try {
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing =
      `${preset.letterSpacing}px`;
  } catch {
    /* noop */
  }

  const rawWord = words[activeIdx].text;
  const display = applyTransformText(rawWord, preset);
  const maxW = Math.max(40, preset.maxWidth * cw);
  let wordWidth = ctx.measureText(display).width;
  if (wordWidth > maxW) {
    const shrink = maxW / wordWidth;
    const shrunkPx = Math.max(8, Math.round(fontPx * shrink));
    ctx.font = `${italic}${preset.fontWeight} ${shrunkPx}px ${font.stack}`;
    wordWidth = ctx.measureText(display).width;
  }
  const lineHeight = Math.round(fontPx * 1.25);

  // Compute animation transform for this word.
  const t: WordTransform =
    animation !== "none"
      ? computeWordTransform(
          animation,
          words[activeIdx].startMs,
          words[activeIdx].endMs,
          currentMs,
          activeIdx,
          0,
          0,
          ch,
        )
      : IDENTITY_TRANSFORM;

  const padding = Math.round((preset.bgPadding / 1080) * ch);
  const radius = Math.round((preset.bgRadius / 1080) * ch);
  const positionYpx = Math.round((preset.positionY / 1080) * ch);

  let blockTop: number;
  if (position === "top") blockTop = positionYpx;
  else if (position === "center") blockTop = (ch - lineHeight) / 2 + positionYpx;
  else blockTop = ch - lineHeight - positionYpx;

  const blockLeft = (cw - wordWidth) / 2;

  if (preset.bgColor) {
    const boxX = blockLeft - padding;
    const boxY = blockTop - padding;
    const boxW = wordWidth + padding * 2;
    const boxH = lineHeight + padding * 2;
    ctx.save();
    ctx.globalAlpha = preset.bgAlpha * t.alpha;
    ctx.fillStyle = preset.bgColor;
    drawRoundedRect(ctx, boxX, boxY, boxW, boxH, radius);
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  if (preset.shadow) {
    ctx.shadowColor = preset.shadowColor;
    ctx.shadowBlur = preset.shadowBlur * (ch / 540);
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }
  applyWordTransform(ctx, t, blockLeft, blockTop, wordWidth, lineHeight);
  if (preset.borderColor && preset.borderWidth > 0) {
    ctx.lineJoin = "round";
    ctx.strokeStyle = preset.borderColor;
    ctx.lineWidth = Math.max(1, (preset.borderWidth / 1080) * ch * 2);
    ctx.strokeText(display, blockLeft, blockTop);
  }
  ctx.fillStyle = preset.highlightColor || textColor;
  ctx.fillText(display, blockLeft, blockTop);
  ctx.restore();

  try {
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing =
      "0px";
  } catch {
    /* noop */
  }
}

/**
 * Word-animated mode — render the full cue text (like the standard
 * path), but apply the kinetic typography animation transform to each
 * word independently. Used when wordMode is "off" but an animation is
 * active AND the cue has word timestamps. Falls back to the standard
 * full-text path (with whole-cue animation) when no word timestamps.
 */
function drawWordAnimated(
  ctx: CanvasRenderingContext2D,
  text: string,
  caption: CanvasCaptionCtx,
  preset: ReturnType<typeof getCaptionPreset>,
  font: ReturnType<typeof getFontOption>,
  textColor: string,
  cw: number,
  ch: number,
  animation: CaptionAnimation,
): void {
  const scale = caption.fontSizeScale || 1;
  const position = caption.customPosition || preset.position;
  const { fontPx, lineHeight } = setupWordFont(ctx, preset, font, ch, scale);

  const words = caption.words!;
  const currentMs = caption.currentMs ?? 0;

  const display = applyTransformText(text, preset);
  const displayWords = display.split(/\s+/).filter(Boolean);
  if (displayWords.length === 0) return;

  // Wrap (greedy).
  const maxW = Math.max(40, preset.maxWidth * cw);
  const lines: string[][] = [];
  let curLine: string[] = [];
  let curWidth = 0;
  const spaceW = ctx.measureText(" ").width;
  for (const w of displayWords) {
    const wWidth = ctx.measureText(w).width;
    const candidate = curWidth === 0 ? wWidth : curWidth + spaceW + wWidth;
    if (candidate > maxW && curLine.length > 0) {
      lines.push(curLine);
      curLine = [w];
      curWidth = wWidth;
    } else {
      curLine.push(w);
      curWidth = candidate;
    }
  }
  if (curLine.length) lines.push(curLine);

  const blockH = lines.length * lineHeight;
  const padding = Math.round((preset.bgPadding / 1080) * ch);
  const radius = Math.round((preset.bgRadius / 1080) * ch);
  const maxWidthLine = Math.max(
    ...lines.map((l) => ctx.measureText(l.join(" ")).width),
  );

  const positionYpx = Math.round((preset.positionY / 1080) * ch);
  let blockTop: number;
  if (position === "top") blockTop = positionYpx;
  else if (position === "center") blockTop = (ch - blockH) / 2 + positionYpx;
  else blockTop = ch - blockH - positionYpx;

  const blockLeft = (cw - maxWidthLine) / 2;
  const blockRight = blockLeft + maxWidthLine;

  const alignLineX = (lineStr: string): number => {
    const w = ctx.measureText(lineStr).width;
    if (preset.alignment === "left") return blockLeft;
    if (preset.alignment === "right") return blockRight - w;
    return (cw - w) / 2;
  };

  // Background box (no animation — keeps the box stable).
  if (preset.bgColor) {
    const boxX = blockLeft - padding;
    const boxY = blockTop - padding;
    const boxW = maxWidthLine + padding * 2;
    const boxH = blockH + padding * 2;
    ctx.save();
    ctx.globalAlpha = preset.bgAlpha;
    ctx.fillStyle = preset.bgColor;
    drawRoundedRect(ctx, boxX, boxY, boxW, boxH, radius);
    ctx.fill();
    ctx.restore();
  }

  // Render each word with its animation transform applied.
  ctx.save();
  if (preset.shadow) {
    ctx.shadowColor = preset.shadowColor;
    ctx.shadowBlur = preset.shadowBlur * (ch / 540);
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }

  let wordCursor = 0;
  for (let li = 0; li < lines.length; li++) {
    const lineWords = lines[li];
    const lineStr = lineWords.join(" ");
    const lineX = alignLineX(lineStr);
    const lineY = blockTop + li * lineHeight;

    let xOffset = 0;
    for (let k = 0; k < lineWords.length; k++) {
      const w = lineWords[k];
      const wordX = lineX + xOffset;
      const wordW = ctx.measureText(w).width;
      const wordH = lineHeight;
      const wordIdx = wordCursor + k;
      const wordTs = words[wordIdx];

      let t: WordTransform = IDENTITY_TRANSFORM;
      if (animation !== "none" && wordTs) {
        t = computeWordTransform(
          animation,
          wordTs.startMs,
          wordTs.endMs,
          currentMs,
          wordIdx,
          wordX,
          lineY,
          ch,
        );
      }

      ctx.save();
      applyWordTransform(ctx, t, wordX, lineY, wordW, wordH);
      if (preset.borderColor && preset.borderWidth > 0) {
        ctx.lineJoin = "round";
        ctx.strokeStyle = preset.borderColor;
        ctx.lineWidth = Math.max(1, (preset.borderWidth / 1080) * ch * 2);
        ctx.strokeText(w, wordX, lineY);
      }
      ctx.fillStyle = textColor;
      ctx.fillText(w, wordX, lineY);
      ctx.restore();

      xOffset += wordW + spaceW;
    }
    wordCursor += lineWords.length;
  }
  ctx.restore();

  try {
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing =
      "0px";
  } catch {
    /* noop */
  }
}

/** Word-wrap text to fit within maxW using the current ctx font. */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
): string[] {
  const out: string[] = [];
  const paragraphs = text.split("\n");
  for (const para of paragraphs) {
    if (!para) {
      out.push("");
      continue;
    }
    const words = para.split(/\s+/);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      const w = ctx.measureText(candidate).width;
      if (w > maxW && line) {
        out.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/**
 * Balanced text wrapping — creates a triangle/pyramid shape where
 * line 1 is longest, line 2 is shorter, line 3 is shortest.
 * This looks much better typographically than greedy wrapping.
 */
function balancedWrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  maxLines: number = 3,
): string[] {
  const paragraphs = text.split("\n");
  const result: string[] = [];

  for (const para of paragraphs) {
    if (!para) {
      result.push("");
      continue;
    }

    const words = para.split(/\s+/);
    if (words.length <= 1) {
      result.push(para);
      continue;
    }

    // Check if it all fits on one line
    const fullWidth = ctx.measureText(para).width;
    if (fullWidth <= maxW) {
      result.push(para);
      continue;
    }

    let bestSplit: string[] = [para];
    let bestScore = Infinity;

    // Try 2-line splits
    for (let i = 1; i < words.length; i++) {
      const line1 = words.slice(0, i).join(" ");
      const line2 = words.slice(i).join(" ");
      const w1 = ctx.measureText(line1).width;
      const w2 = ctx.measureText(line2).width;

      if (w1 > maxW || w2 > maxW) continue;

      // Prefer triangle (line1 > line2) — give penalty for inverted
      const triangleBonus = w1 > w2 ? 0 : 50;
      const score = Math.abs(w1 - w2) + triangleBonus;

      if (score < bestScore) {
        bestScore = score;
        bestSplit = [line1, line2];
      }
    }

    // Try 3-line splits if text is long enough
    if (words.length >= 5 && maxLines >= 3) {
      for (let i = 1; i < words.length - 1; i++) {
        for (let j = i + 1; j < words.length; j++) {
          const line1 = words.slice(0, i).join(" ");
          const line2 = words.slice(i, j).join(" ");
          const line3 = words.slice(j).join(" ");
          const w1 = ctx.measureText(line1).width;
          const w2 = ctx.measureText(line2).width;
          const w3 = ctx.measureText(line3).width;

          if (w1 > maxW || w2 > maxW || w3 > maxW) continue;

          // Prefer triangle (w1 > w2 > w3)
          const triangleBonus = (w1 > w2 && w2 > w3) ? 0 : 100;
          const score = Math.abs(w1 - w2) + Math.abs(w2 - w3) + triangleBonus;

          if (score < bestScore) {
            bestScore = score;
            bestSplit = [line1, line2, line3];
          }
        }
      }
    }

    result.push(...bestSplit);
  }

  return result;
}

/** Cross-browser rounded-rect path helper. */
function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  // Prefer the modern roundRect when available.
  const anyCtx = ctx as CanvasRenderingContext2D & {
    roundRect?: (x: number, y: number, w: number, h: number, r: number) => void;
  };
  if (typeof anyCtx.roundRect === "function") {
    ctx.beginPath();
    anyCtx.roundRect(x, y, w, h, radius);
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/**
 * Export the timeline to video.
 * - Inside Electron: native FFmpeg (MP4).
 * - In a browser: WebCodecs MP4 (fast), falling back to MediaRecorder WebM.
 */
export async function exportNative(
  opts: ExportNativeOptions,
): Promise<ExportResult> {
  if (isElectron()) {
    return exportViaFFmpeg(opts);
  }
  try {
    return await exportViaWebCodecs(opts);
  } catch (err: any) {
    if (err?.message === "Export cancelled") throw err;
    if (err?.message === "NO_WEBCODECS") {
      return exportViaMediaRecorder(opts);
    }
    // WebCodecs encoding failure → fall back to MediaRecorder.
    try {
      return await exportViaMediaRecorder(opts);
    } catch (err2: any) {
      throw new Error(
        `Export failed: ${err2?.message || err2}. WebCodecs error: ${err?.message || err}`,
      );
    }
  }
}

/** Convenience: find the active segment for a time (re-exported helper). */
export function activeSegmentAt(
  segments: MediaSegment[],
  tMs: number,
): MediaSegment | null {
  return (
    segments.find((s) => tMs >= s.startMs && tMs < s.endMs) ||
    (segments.length && tMs >= segments[segments.length - 1].endMs
      ? segments[segments.length - 1]
      : null)
  );
}
