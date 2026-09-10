// src/lib/merger/renderer.ts — canvas Ken Burns frame renderer + transitions
import type {
  AspectRatio,
  KenBurnsConfig,
  MediaSegment,
  Resolution,
  TransitionSettings,
  TransitionStyle,
} from "./types";
import { TRANSITION_STYLE_INFO, boundaryStyle } from "./types";

/** easeInOutSine: -(cos(PI*t) - 1) / 2 */
export function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

/** Full export resolution for an aspect + resolution pair. */
export function resolveDimensions(
  aspect: AspectRatio,
  resolution: Resolution,
): { w: number; h: number } {
  const is1080 = resolution === "1080p";
  switch (aspect) {
    case "16:9":
      return is1080 ? { w: 1920, h: 1080 } : { w: 1280, h: 720 };
    case "9:16":
      return is1080 ? { w: 1080, h: 1920 } : { w: 720, h: 1280 };
    case "1:1":
      return is1080 ? { w: 1080, h: 1080 } : { w: 720, h: 720 };
    case "4:5":
      // Instagram feed portrait (1080×1350 / 720×900).
      return is1080 ? { w: 1080, h: 1350 } : { w: 720, h: 900 };
    default:
      return { w: 1920, h: 1080 };
  }
}

/** Downscaled preview dimensions that fit a typical panel. */
export function previewDimensions(aspect: AspectRatio): { w: number; h: number } {
  switch (aspect) {
    case "16:9":
      return { w: 960, h: 540 };
    case "9:16":
      return { w: 380, h: 676 };
    case "1:1":
      return { w: 620, h: 620 };
    case "4:5":
      return { w: 496, h: 620 };
    default:
      return { w: 960, h: 540 };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Render a single frame of a segment to a canvas context with Ken Burns motion.
 * Uses object-fit: cover, high-quality smoothing, and sub-pixel transforms.
 */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | HTMLCanvasElement | null,
  seg: MediaSegment,
  currentMs: number,
  cw: number,
  ch: number,
  kb: KenBurnsConfig,
): void {
  // Clear + black background (letterbox fallback).
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, cw, ch);

  if (!img) return;

  const iw =
    (img as HTMLImageElement).naturalWidth ||
    (img as HTMLCanvasElement).width;
  const ih =
    (img as HTMLImageElement).naturalHeight ||
    (img as HTMLCanvasElement).height;
  if (!iw || !ih) return;

  const dur = Math.max(1, seg.durationMs);
  const t = clamp((currentMs - seg.startMs) / dur, 0, 1);
  const eased = easeInOutSine(t);

  const intensity = kb.enabled ? kb.intensity : 0;
  const zoomMax = 1.06 + (intensity / 100) * 0.18;

  // object-fit: cover base scale.
  const cover = Math.max(cw / iw, ch / ih);

  let zoom = 1;
  let ox = 0; // dest-pixel offset from centered position (x)
  let oy = 0; // dest-pixel offset from centered position (y)

  const dir = kb.enabled ? seg.direction : "in";

  switch (dir) {
    case "in": {
      zoom = 1 + eased * (zoomMax - 1);
      break;
    }
    case "out": {
      zoom = zoomMax - eased * (zoomMax - 1);
      break;
    }
    case "right": {
      zoom = zoomMax;
      const dw = iw * cover * zoom;
      const halfX = (dw - cw) / 2;
      ox = -halfX * eased; // push image left → reveal right side
      break;
    }
    case "left": {
      zoom = zoomMax;
      const dw = iw * cover * zoom;
      const halfX = (dw - cw) / 2;
      ox = halfX * eased; // push image right → reveal left side
      break;
    }
    case "down": {
      zoom = zoomMax;
      const dh = ih * cover * zoom;
      const halfY = (dh - ch) / 2;
      oy = -halfY * eased;
      break;
    }
    case "up": {
      zoom = zoomMax;
      const dh = ih * cover * zoom;
      const halfY = (dh - ch) / 2;
      oy = halfY * eased;
      break;
    }
    default: {
      zoom = 1;
    }
  }

  const dw = iw * cover * zoom;
  const dh = ih * cover * zoom;
  const dx = (cw - dw) / 2 + ox;
  const dy = (ch - dh) / 2 + oy;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  // Sub-pixel transform for crisp motion.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(img, dx, dy, dw, dh);
}

/**
 * Render a still "poster" frame for a segment at its midpoint.
 * Useful for thumbnails / placeholders.
 */
export function drawPoster(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | HTMLCanvasElement | null,
  seg: MediaSegment,
  cw: number,
  ch: number,
  kb: KenBurnsConfig,
): void {
  const mid = seg.startMs + seg.durationMs / 2;
  drawFrame(ctx, img, seg, mid, cw, ch, kb);
}

// ---------------------------------------------------------------------------
// SEGMENT TRANSITIONS (v4.3) — canvas twin of the FFmpeg export pipeline.
//
// Export architecture (electron/main.js):
//   • dissolve/slide/wipe: per-clip HEAD composite via
//       [prevFrozen][cur]xfade=transition=<name>:duration=F:offset=0
//     where prevFrozen = the PREVIOUS segment's Ken Burns end-state (frozen).
//     offset=0 means: output = blend(A,B) for the first F seconds, then B
//     alone — the clip keeps its exact duration, so the timeline, audio and
//     caption timing are untouched.
//   • dip-black / dip-white: linear `fade` filter on the clip head (t=in)
//     and on the PREVIOUS clip's tail (t=out) with color=black/white.
//   • fadeStartEnd: global fade-in on clip 0 + fade-out on the last clip,
//     applied AFTER subtitles (the whole composite fades).
//
// The functions below reproduce those exact composites on canvas — probe-
// verified formulas (all linear) against ffmpeg 7.0.2 xfade output.
// ---------------------------------------------------------------------------

/** Max fraction of a segment's duration a transition may occupy. */
const TRANSITION_MAX_FRACTION = 0.45;

/** Clamp a transition duration to ≤45% of the given segment duration. */
export function clampTransitionMs(durationMs: number, segDurMs: number): number {
  if (durationMs <= 0 || segDurMs <= 200) return 0;
  return Math.min(durationMs, Math.floor(segDurMs * TRANSITION_MAX_FRACTION));
}

/**
 * Effective head-transition duration (ms) for segment `segIdx` — the
 * window at the START of the clip where the transition composite plays.
 * 0 when there is no previous segment or the boundary style is "none"
 * (global OR per-boundary override, v4.5).
 */
export function transitionHeadMs(
  segments: MediaSegment[],
  segIdx: number,
  transition: TransitionSettings | null | undefined,
): number {
  if (segIdx <= 0) return 0;
  const seg = segments[segIdx];
  if (!seg) return 0;
  const style = boundaryStyle(transition, seg.id);
  if (!transition || style === "none") return 0;
  return clampTransitionMs(transition.durationMs, seg.durationMs);
}

/**
 * Effective TAIL dip duration (ms) for segment `segIdx` — dips darken the
 * tail of the PREVIOUS clip, so the style that matters here is the one at
 * the boundary INTO the NEXT segment (v4.5 per-boundary aware). Non-zero
 * only for dip styles on segments that are not the last one.
 */
export function transitionTailMs(
  segments: MediaSegment[],
  segIdx: number,
  transition: TransitionSettings | null | undefined,
): number {
  if (!transition) return 0;
  const next = segments[segIdx + 1];
  if (!next) return 0;
  const nextStyle = boundaryStyle(transition, next.id);
  if (!TRANSITION_STYLE_INFO[nextStyle].dipColor) return 0; // only dips touch the tail
  if (segIdx >= segments.length - 1) return 0;
  const seg = segments[segIdx];
  if (!seg) return 0;
  return clampTransitionMs(transition.durationMs, seg.durationMs);
}

export type TransitionFxKind =
  | "none"
  | "dissolve"
  | "dip-head"
  | "slide"
  | "wipe";

/** Per-frame transition effect descriptor (pure — shared with tests). */
export interface TransitionFx {
  kind: TransitionFxKind;
  /** 0 → 1 progress through the head window (linear, matches xfade). */
  p: number;
  /** xfade name for slide/wipe styles; null otherwise. */
  style: TransitionStyle | null;
  /** dip color for dip-head; null otherwise. */
  dipColor: "black" | "white" | null;
  /** Effective head window length in ms (0 = no head effect). */
  headMs: number;
}

/**
 * Compute the head-transition effect active at `currentMs` for segment
 * `segIdx` — mirrors the FFmpeg per-clip graph exactly.
 */
export function computeTransitionFx(
  segments: MediaSegment[],
  segIdx: number,
  currentMs: number,
  transition: TransitionSettings | null | undefined,
): TransitionFx {
  const none: TransitionFx = { kind: "none", p: 0, style: null, dipColor: null, headMs: 0 };
  if (!transition) return none;
  const seg = segments[segIdx];
  if (!seg || segIdx <= 0) return none;
  const style = boundaryStyle(transition, seg.id);
  if (style === "none") return none;
  const headMs = transitionHeadMs(segments, segIdx, transition);
  if (headMs <= 0) return none;
  const local = currentMs - seg.startMs;
  if (local < 0 || local >= headMs) return none;
  const p = Math.min(1, Math.max(0, local / headMs));
  if (style === "dissolve") {
    return { kind: "dissolve", p, style, dipColor: null, headMs };
  }
  if (style === "dip-black" || style === "dip-white") {
    return {
      kind: "dip-head",
      p,
      style,
      dipColor: style === "dip-white" ? "white" : "black",
      headMs,
    };
  }
  if (style === "slide-left" || style === "slide-right" || style === "wipe-left" || style === "wipe-right") {
    return { kind: style.startsWith("slide") ? "slide" : "wipe", p, style, dipColor: null, headMs };
  }
  return none;
}

/**
 * Global fade (applied AFTER captions, matching fade-after-subtitles in the
 * export): start fade-in on clip 0, end fade-out on the last clip, dip tails.
 * Returns the frame opacity (1 = untouched) + dip color for tail dips.
 */
export function computeGlobalFade(
  segments: MediaSegment[],
  segIdx: number,
  currentMs: number,
  transition: TransitionSettings | null | undefined,
): { alpha: number; color: "black" | "white" | null } {
  if (!transition) return { alpha: 1, color: null };
  const seg = segments[segIdx];
  if (!seg) return { alpha: 1, color: null };

  // Start fade-in (clip 0 only).
  if (segIdx === 0 && transition.fadeStartEnd) {
    const f = clampTransitionMs(transition.durationMs, seg.durationMs);
    if (f > 0 && currentMs - seg.startMs < f) {
      const p = Math.max(0, (currentMs - seg.startMs) / f);
      return { alpha: p, color: "black" };
    }
  }

  // End fade-out (last clip only).
  if (segIdx === segments.length - 1 && transition.fadeStartEnd) {
    const f = clampTransitionMs(transition.durationMs, seg.durationMs);
    if (f > 0 && seg.endMs - currentMs < f) {
      const p = Math.max(0, (seg.endMs - currentMs) / f);
      return { alpha: p, color: "black" };
    }
  }

  // Dip tails (dip styles, all but the last clip) — colored by the style at
  // the boundary into the NEXT segment (v4.5 per-boundary aware).
  const tailMs = transitionTailMs(segments, segIdx, transition);
  if (tailMs > 0) {
    const intoTail = currentMs - (seg.endMs - tailMs);
    if (intoTail >= 0) {
      const p = Math.min(1, intoTail / tailMs); // 0 → 1 as we approach the end
      const nextStyle = boundaryStyle(transition, segments[segIdx + 1]?.id);
      const color =
        nextStyle === "dip-white" ? "white" : "black";
      return { alpha: 1 - p, color };
    }
  }

  return { alpha: 1, color: null };
}

/**
 * Render the current frame with the head-transition composite applied.
 * `scratch` must be the same size as the target canvas (module-level reuse
 * keeps allocations zero). Captions/headlines are drawn by the caller AFTER
 * this (matching the export: subtitles burn after xfade).
 */
export function drawFrameWithTransition(
  ctx: CanvasRenderingContext2D,
  scratch: HTMLCanvasElement,
  seg: MediaSegment,
  segIdx: number,
  segments: MediaSegment[],
  img: HTMLImageElement | HTMLCanvasElement | null,
  images: Record<string, HTMLImageElement> | Map<string, HTMLImageElement>,
  currentMs: number,
  cw: number,
  ch: number,
  kb: KenBurnsConfig,
  transition: TransitionSettings | null | undefined,
): void {
  const fx = computeTransitionFx(segments, segIdx, currentMs, transition);

  if (fx.kind === "none") {
    drawFrame(ctx, img, seg, currentMs, cw, ch, kb);
    return;
  }

  const sctx = scratch.getContext("2d", { alpha: false });
  if (!sctx) {
    drawFrame(ctx, img, seg, currentMs, cw, ch, kb);
    return;
  }
  const prevSeg = segments[segIdx - 1] ?? null;
  const prevImg = prevSeg
    ? (images instanceof Map ? images.get(prevSeg.id) : images[prevSeg.id]) ?? null
    : null;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  if (fx.kind === "dip-head") {
    // color*(1-p) + cur*p — fill the dip color, draw cur with alpha p.
    ctx.fillStyle = fx.dipColor === "white" ? "#ffffff" : "#000000";
    ctx.fillRect(0, 0, cw, ch);
    drawFrame(sctx, img, seg, currentMs, cw, ch, kb);
    ctx.globalAlpha = fx.p;
    ctx.drawImage(scratch, 0, 0);
    ctx.globalAlpha = 1;
    return;
  }

  if (fx.kind === "dissolve") {
    // out = cur + (1-p)·prevFrozen on top (canvas source-over with alpha
    // equals the linear blend (1-p)·A + p·B for opaque layers).
    drawFrame(ctx, img, seg, currentMs, cw, ch, kb);
    if (prevSeg) {
      drawFrame(sctx, prevImg, prevSeg, prevSeg.endMs, cw, ch, kb);
      ctx.globalAlpha = 1 - fx.p;
      ctx.drawImage(scratch, 0, 0);
      ctx.globalAlpha = 1;
    }
    return;
  }

  // slide / wipe: prev frozen BELOW, cur composited on top with offset/clip.
  if (prevSeg) {
    drawFrame(ctx, prevImg, prevSeg, prevSeg.endMs, cw, ch, kb);
  } else {
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, cw, ch);
  }
  drawFrame(sctx, img, seg, currentMs, cw, ch, kb);

  ctx.save();
  if (fx.kind === "slide") {
    // slide-left: B enters from the right edge (dx = +W·(1-p) → 0).
    // slide-right: B enters from the left edge (dx = −W·(1-p) → 0).
    const dx =
      fx.style === "slide-left"
        ? cw * (1 - fx.p)
        : -cw * (1 - fx.p);
    ctx.drawImage(scratch, dx, 0);
  } else if (fx.kind === "wipe") {
    // wipe-left: B region = [W·(1-p), W] (revealed from the right edge).
    // wipe-right: B region = [0, W·p] (revealed from the left edge).
    if (fx.style === "wipe-left") {
      ctx.beginPath();
      ctx.rect(cw * (1 - fx.p), 0, cw, ch);
    } else {
      ctx.beginPath();
      ctx.rect(0, 0, cw * fx.p, ch);
    }
    ctx.clip();
    ctx.drawImage(scratch, 0, 0);
  }
  ctx.restore();
}

/**
 * Apply a global fade to the WHOLE composite (frame + captions), mirroring
 * the export's fade-after-subtitles. Copies the canvas to `scratch`, clears,
 * fills the fade color and blits back at `alpha`.
 */
export function applyGlobalFade(
  ctx: CanvasRenderingContext2D,
  scratch: HTMLCanvasElement,
  fade: { alpha: number; color: "black" | "white" | null },
): void {
  if (fade.alpha >= 1 || fade.color == null) return;
  const sctx = scratch.getContext("2d", { alpha: false });
  if (!sctx) return;
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.globalAlpha = 1;
  sctx.drawImage(ctx.canvas, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = fade.color === "white" ? "#ffffff" : "#000000";
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.globalAlpha = Math.max(0, Math.min(1, fade.alpha));
  ctx.drawImage(scratch, 0, 0);
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// WATERMARK / LOGO OVERLAY (v4.4) — canvas twin of the FFmpeg overlay chain.
//
// Export (electron/main.js): the watermark is an extra input per clip:
//   [wm:v]scale=w:h:flags=bilinear,format=rgba,colorchannelmixer=aa=<op>[wm]
//   [base][wm]overlay=<x>:<y>:eof_action=repeat
// applied AFTER zoompan/xfade and BEFORE subtitles — the exact order of the
// canvas draw calls below. Geometry comes from watermarkGeometry() so the
// preview and the export can never disagree.
// ---------------------------------------------------------------------------

import type { WatermarkSettings } from "./types";

/**
 * Destination rect for the watermark on a videoW×videoH frame.
 * Shared by the canvas preview, the browser exporters and (via the IPC
 * payload) the FFmpeg overlay filter — the single source of truth.
 */
export function watermarkGeometry(
  videoW: number,
  videoH: number,
  imgW: number,
  imgH: number,
  settings: WatermarkSettings,
): { dx: number; dy: number; dw: number; dh: number } {
  if (imgW <= 0 || imgH <= 0 || videoW <= 0 || videoH <= 0) {
    return { dx: 0, dy: 0, dw: 0, dh: 0 };
  }
  const dw = Math.max(1, Math.round((videoW * settings.sizePercent) / 100));
  const dh = Math.max(1, Math.round((dw * imgH) / imgW)); // aspect preserved
  const m = Math.round((videoW * settings.marginPercent) / 100);

  const pos = settings.position;
  // Horizontal anchor: left column / center column / right column.
  const col = pos.endsWith("left") ? 0 : pos.endsWith("right") ? 2 : 1;
  // Vertical anchor: top row / middle row / bottom row.
  const row = pos.startsWith("top") ? 0 : pos.startsWith("bottom") ? 2 : 1;

  const dx =
    col === 0 ? m : col === 2 ? Math.round(videoW - dw - m) : Math.round((videoW - dw) / 2);
  const dy =
    row === 0 ? m : row === 2 ? Math.round(videoH - dh - m) : Math.round((videoH - dh) / 2);

  return { dx, dy, dw, dh };
}

/** Draw the watermark with opacity (mirrors colorchannelmixer=aa). */
export function drawWatermark(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | null,
  videoW: number,
  videoH: number,
  settings: WatermarkSettings | null | undefined,
): void {
  if (!img || !settings) return;
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const g = watermarkGeometry(videoW, videoH, iw, ih, settings);
  if (g.dw <= 0 || g.dh <= 0) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.globalAlpha = Math.max(0.05, Math.min(1, settings.opacity / 100));
  ctx.drawImage(img, g.dx, g.dy, g.dw, g.dh);
  ctx.globalAlpha = 1;
}
