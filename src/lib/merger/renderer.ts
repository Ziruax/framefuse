// src/lib/merger/renderer.ts — canvas Ken Burns frame renderer + transitions
//
// v5.0 additions: overlayGeometry (single source of truth for overlay
// placement, mirrored in plain JS by electron/main.js), drawVideoFrame
// (cover-fit video frames, NO Ken Burns) and the transition VIDEO RULE —
// xfade-family heads are hard cuts whenever either side of a boundary is a
// video segment (dips remain allowed). isXfadeStyle is exported so the
// export pipeline mirror can reuse the exact same definition.
import type {
  AspectRatio,
  KenBurnsConfig,
  MediaSegment,
  OverlayKeyframe,
  OverlayPos,
  OverlayTransform,
  Resolution,
  TransitionSettings,
  TransitionStyle,
} from "./types";
import { TRANSITION_STYLE_INFO, boundaryStyle } from "./types";

/** easeInOutSine: -(cos(PI*t) - 1) / 2 */
export function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

// ---------------------------------------------------------------------------
// v5.6 MOTION PATHS — position keyframes on overlay clips.
//
// One shared contract consumed by the canvas preview, the timeline diamonds
// and the FFmpeg export mirror (electron/export-graph.js builds the exact
// same piecewise-linear curve as overlay x/y time expressions):
//   - keyframe time is OVERLAY-WINDOW-LOCAL (0 = the clip's timeline start);
//   - keyframe x/y are normalized 0..1 CENTER coords (the canvas drag space,
//     identical to OverlayTransform.x/y);
//   - the curve is piecewise LINEAR with HOLD-FIRST / HOLD-LAST ends
//     (a keyframe at the window edges is never required);
//   - 0 keyframes = static transform (x/y or 9-grid anchor as before);
//     1 keyframe = a pinned position; ≥2 = animation.
// ---------------------------------------------------------------------------

/** Snap tolerance: a gesture at most this far from an existing keyframe
 * (ms, window-local) MOVES that keyframe instead of creating a new one. */
export const MOTION_KF_TOLERANCE_MS = 350;

/** Coerce arbitrary user/undo payload into a clean sorted keyframe list:
 * finite tMs ≥ 0, x/y clamped 0..1, sorted by time, exact-time duplicates
 * collapsed (last wins). Returns [] for anything unusable. */
export function sanitizeMotionKeyframes(
  motion: unknown,
): OverlayKeyframe[] {
  if (!Array.isArray(motion)) return [];
  const out: OverlayKeyframe[] = [];
  for (const raw of motion) {
    if (!raw || typeof raw !== "object") continue;
    const tMs = Number((raw as OverlayKeyframe).tMs);
    const x = Number((raw as OverlayKeyframe).x);
    const y = Number((raw as OverlayKeyframe).y);
    if (!Number.isFinite(tMs) || tMs < 0) continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({
      tMs: Math.round(tMs),
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
    });
  }
  out.sort((a, b) => a.tMs - b.tMs);
  const deduped: OverlayKeyframe[] = [];
  for (const kf of out) {
    if (deduped.length > 0 && deduped[deduped.length - 1].tMs === kf.tMs) {
      deduped[deduped.length - 1] = kf; // same-time → replace
    } else {
      deduped.push(kf);
    }
  }
  return deduped;
}

/** Interpolated position at a window-local time, or null when the transform
 * has no motion (caller keeps the static x/y / 9-grid behavior). Hold ends:
 * before the first / after the last keyframe the nearest value is held. */
export function sampleOverlayMotion(
  t: OverlayTransform | null | undefined,
  localMs: number,
): { x: number; y: number } | null {
  const kfs = sanitizeMotionKeyframes(t?.motion);
  if (kfs.length === 0) return null;
  if (kfs.length === 1) return { x: kfs[0].x, y: kfs[0].y };
  const time = Number.isFinite(localMs) ? localMs : 0;
  if (time <= kfs[0].tMs) return { x: kfs[0].x, y: kfs[0].y };
  const last = kfs[kfs.length - 1];
  if (time >= last.tMs) return { x: last.x, y: last.y };
  // Binary search the bracketing pair.
  let lo = 0;
  let hi = kfs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (kfs[mid].tMs <= time) lo = mid;
    else hi = mid;
  }
  const a = kfs[lo];
  const b = kfs[hi];
  const span = b.tMs - a.tMs;
  const p = span > 0 ? (time - a.tMs) / span : 0;
  return {
    x: a.x + (b.x - a.x) * p,
    y: a.y + (b.y - a.y) * p,
  };
}

/**
 * v5.6: the authored CENTER of an overlay at a window-local time — the
 * position a keyframe gesture (HUD button / timeline menu) pins. Exact
 * when a motion path exists (sampled) or the overlay was dragged (x/y);
 * the 9-grid anchor falls back to the anchor-cell center (x exact by
 * scalePercent; y assumes a 16:9 source aspect for dh — documented
 * approximation, only reachable for never-dragged corner-anchored
 * overlays; the preview canvas draws the exact rect regardless).
 */
export function overlayAnchorCenter(
  t: OverlayTransform | null | undefined,
  localMs: number,
): { x: number; y: number } {
  if (!t) return { x: 0.5, y: 0.5 };
  const sampled = sampleOverlayMotion(t, localMs);
  if (sampled) return sampled;
  if (Number.isFinite(t.x) && Number.isFinite(t.y)) {
    return {
      x: Math.max(0, Math.min(1, t.x as number)),
      y: Math.max(0, Math.min(1, t.y as number)),
    };
  }
  const sp = Number.isFinite(t.scalePercent)
    ? Math.max(10, Math.min(100, t.scalePercent))
    : 60;
  const col = t.position.endsWith("left") ? 0 : t.position.endsWith("right") ? 2 : 1;
  const row = t.position.startsWith("top") ? 0 : t.position.startsWith("bottom") ? 2 : 1;
  const halfX = sp / 200;
  const halfY = (sp * (9 / 16)) / 200;
  return {
    x: col === 0 ? 0.02 + halfX : col === 2 ? 0.98 - halfX : 0.5,
    y: row === 0 ? 0.02 + halfY : row === 2 ? 0.98 - halfY : 0.5,
  };
}

/**
 * v5.6: edit a motion path at a window-local time — the ONE rule every
 * keyframe gesture (HUD button, canvas drag, timeline menu) shares:
 * a keyframe within MOTION_KF_TOLERANCE_MS of `localMs` MOVES to the new
 * position; otherwise a NEW keyframe is inserted at `localMs`. When the
 * transform has no motion yet, the first keyframe is created from the
 * given position. Pure — returns a new OverlayTransform, never mutates.
 */
export function applyMotionKeyframe(
  t: OverlayTransform,
  localMs: number,
  x: number,
  y: number,
): OverlayTransform {
  const nx = Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0.5));
  const ny = Math.max(0, Math.min(1, Number.isFinite(y) ? y : 0.5));
  const at = Math.max(0, Math.round(Number.isFinite(localMs) ? localMs : 0));
  const kfs = sanitizeMotionKeyframes(t?.motion);
  const next: OverlayKeyframe[] = [];
  let replaced = false;
  for (const kf of kfs) {
    if (Math.abs(kf.tMs - at) <= MOTION_KF_TOLERANCE_MS) {
      // Nearest-in-tolerance wins; earlier duplicates fall through.
      if (!replaced) {
        next.push({ tMs: at, x: nx, y: ny });
        replaced = true;
      }
      continue;
    }
    next.push(kf);
  }
  if (!replaced) next.push({ tMs: at, x: nx, y: ny });
  next.sort((a, b) => a.tMs - b.tMs);
  // Keep the static x/y in sync with the FIRST keyframe so the transform
  // stays self-consistent when motion is later cleared / trimmed away.
  const first = next[0];
  return { ...t, x: first.x, y: first.y, motion: next };
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

/** Downscaled preview dimensions that fit a typical panel. The v5.2 preview
 *  stage is fully responsive (a ResizeObserver letterboxes it inside the
 *  available panel space), so these are only the CANVAS BUFFER resolution —
 *  the on-screen size is decoupled from the buffer. */
export function previewDimensions(aspect: AspectRatio): { w: number; h: number } {
  switch (aspect) {
    case "16:9":
      return { w: 960, h: 540 };
    case "9:16":
      return { w: 540, h: 960 };
    case "1:1":
      return { w: 620, h: 620 };
    case "4:5":
      return { w: 620, h: 775 };
    default:
      return { w: 960, h: 540 };
  }
}

/** v5.2: map an intrinsic source aspect ratio (w/h) to the closest supported
 *  output AspectRatio. Used to auto-match the project aspect when the first
 *  video is imported so vertical/square sources are never silently cropped,
 *  and by the preview "Match source" button. */
export function closestAspectForRatio(ratio: number): AspectRatio {
  if (!Number.isFinite(ratio) || ratio <= 0) return "16:9";
  const candidates: Array<{ id: AspectRatio; r: number }> = [
    { id: "16:9", r: 16 / 9 },
    { id: "9:16", r: 9 / 16 },
    { id: "1:1", r: 1 },
    { id: "4:5", r: 4 / 5 },
  ];
  let best = candidates[0];
  for (const c of candidates) {
    if (Math.abs(Math.log(c.r / ratio)) < Math.abs(Math.log(best.r / ratio))) best = c;
  }
  return best.id;
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
  img: VideoFrameSource | null,
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

  // v8: one shared dimension read — images (naturalWidth), canvases
  // (width) and WebCodecs VideoFrames (displayWidth) all resolve here.
  const { w: iw, h: ih } = paintSourceSize(img);
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
 * v5.0: true for the xfade-family styles (dissolve / slide / wipe) — the
 * ones FFmpeg composites via the `xfade` filter. Dip-to-black/white and the
 * hard cut are NOT xfade. Exported so the Electron export pipeline (plain
 * JS mirror) can apply the exact same video-boundary rule.
 */
export function isXfadeStyle(style: TransitionStyle): boolean {
  return TRANSITION_STYLE_INFO[style]?.xfade != null;
}

/** v5.0: does the boundary entering `segIdx` touch a VIDEO segment on
 * either side? (Segments without a mediaType — hand-built / legacy — are
 * treated as images.) */
function videoAtBoundary(segments: MediaSegment[], segIdx: number): boolean {
  return (
    segments[segIdx]?.mediaType === "video" ||
    segments[segIdx - 1]?.mediaType === "video"
  );
}

/**
 * Effective head-transition duration (ms) for segment `segIdx` — the
 * window at the START of the clip where the transition composite plays.
 * 0 when there is no previous segment or the boundary style is "none"
 * (global OR per-boundary override, v4.5).
 *
 * v5.0 VIDEO RULE: an xfade-family head (dissolve / slide / wipe) is
 * forced to a hard cut (0) when EITHER side of the boundary is a VIDEO
 * segment — xfade needs both inputs as full-frame streams and video clips
 * carry their own motion. Dip-to-black / dip-to-white heads remain allowed
 * at video boundaries.
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
  if (isXfadeStyle(style) && videoAtBoundary(segments, segIdx)) return 0;
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
  | "wipe"
  | "circle";

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
  // v5.0 VIDEO RULE — xfade heads are hard cuts at video boundaries
  // (redundant with the transitionHeadMs check below, but explicit here so
  // the rule can never be bypassed by future refactors of headMs).
  if (isXfadeStyle(style) && videoAtBoundary(segments, segIdx)) return none;
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
  if (style === "circleopen") {
    return { kind: "circle", p, style, dipColor: null, headMs };
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
  img: VideoFrameSource | null,
  images: Record<string, VideoFrameSource> | Map<string, VideoFrameSource>,
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

  // slide / wipe / circle: prev frozen BELOW, cur composited on top with
  // offset / clip / growing-circle reveal.
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
  } else if (fx.kind === "circle") {
    // circleopen (v5.1): cur reveals through a circle expanding from the
    // center — the autoeditor painter: radius = (hypot/2)·p reaches the
    // corners exactly at p = 1, matching ffmpeg xfade circleopen's reveal.
    const maxR = Math.hypot(cw, ch) / 2;
    ctx.beginPath();
    ctx.arc(cw / 2, ch / 2, maxR * fx.p, 0, Math.PI * 2);
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

// ---------------------------------------------------------------------------
// v5.0 MULTI-TRACK OVERLAYS — video frames + overlay geometry.
//
// Base VIDEO segments and overlay items are drawn WITHOUT Ken Burns: the
// video's own motion is the content. drawVideoFrame is the cover-fit twin
// of drawFrame (zoom locked to 1); overlayGeometry is the single source of
// truth for the overlay rect on a videoW×videoH frame — the canvas preview,
// and the FFmpeg overlay filter chain (mirrored in plain JS in
// electron/main.js) both consume these exact numbers so they can never
// drift. Geometry follows the watermark contract: width percent of the
// VIDEO width (clamped 10..100), aspect preserved, 2% margin, 9-grid
// anchor.
// ---------------------------------------------------------------------------

/** Anything drawImage accepts that exposes intrinsic dimensions — real
 *  video elements (videoWidth/videoHeight), images (naturalWidth/Height),
 *  canvases/bitmaps (width/height) and WebCodecs VideoFrames
 *  (displayWidth/displayHeight — the VISIBLE, aspect-corrected size, as
 *  opposed to codedWidth which may include alignment padding) all satisfy
 *  this shape. */
export type VideoFrameSource = CanvasImageSource & {
  displayWidth?: number;
  displayHeight?: number;
  videoWidth?: number;
  videoHeight?: number;
  naturalWidth?: number;
  naturalHeight?: number;
  width?: number;
  height?: number;
};

/**
 * Intrinsic (visible) size of any {@link VideoFrameSource} — the ONE
 * dimension read shared by every paint path so HTMLImageElement
 * (naturalWidth), HTMLVideoElement (videoWidth), canvas (width) and
 * WebCodecs VideoFrame (displayWidth) all resolve through the same helper.
 * Unreadable/missing metadata resolves to 0 so callers can skip the draw.
 */
export function paintSourceSize(src: VideoFrameSource): { w: number; h: number } {
  const w =
    src.displayWidth ?? src.videoWidth ?? src.naturalWidth ?? src.width;
  const h =
    src.displayHeight ?? src.videoHeight ?? src.naturalHeight ?? src.height;
  return {
    w: typeof w === "number" && Number.isFinite(w) ? w : 0,
    h: typeof h === "number" && Number.isFinite(h) ? h : 0,
  };
}

/**
 * v5.0: destination rect for an overlay item on a videoW×videoH frame.
 * dw = videoW·scalePercent/100 (clamped 10–100), dh aspect-preserved
 * (both rounded to int), margin = 2% of videoW, 9-grid anchor with the
 * exact col/row logic of watermarkGeometry. Degenerate inputs (any
 * dimension ≤ 0 / non-finite, or a missing transform) → all zeros so
 * callers can skip the draw. A non-finite scalePercent degrades to 100
 * (full width) instead of poisoning the rect with NaN.
 */
export function overlayGeometry(
  videoW: number,
  videoH: number,
  srcW: number,
  srcH: number,
  t: OverlayTransform,
): { dx: number; dy: number; dw: number; dh: number } {
  if (
    !t ||
    !Number.isFinite(videoW) ||
    !Number.isFinite(videoH) ||
    !Number.isFinite(srcW) ||
    !Number.isFinite(srcH) ||
    videoW <= 0 ||
    videoH <= 0 ||
    srcW <= 0 ||
    srcH <= 0
  ) {
    return { dx: 0, dy: 0, dw: 0, dh: 0 };
  }
  const sp = Number.isFinite(t.scalePercent)
    ? clamp(t.scalePercent, 10, 100)
    : 100;
  const dw = Math.max(1, Math.round((videoW * sp) / 100));
  const dh = Math.max(1, Math.round((dw * srcH) / srcW)); // aspect preserved
  const m = Math.round(videoW * 0.02);

  const pos: OverlayPos = t.position;
  // Horizontal anchor: left column / center column / right column.
  const col = pos.endsWith("left") ? 0 : pos.endsWith("right") ? 2 : 1;
  // Vertical anchor: top row / middle row / bottom row.
  const row = pos.startsWith("top") ? 0 : pos.startsWith("bottom") ? 2 : 1;

  // v5.2: free-form placement (dragged on the preview canvas) overrides the
  // 9-grid anchor. x/y are normalized 0..1 center coordinates against the
  // OUTPUT frame; at least 8% of the overlay stays visible on every edge so
  // a drag can never strand the clip completely off-canvas.
  if (Number.isFinite(t.x) && Number.isFinite(t.y)) {
    const cx = clamp(t.x as number, 0, 1) * videoW;
    const cy = clamp(t.y as number, 0, 1) * videoH;
    const fx = Math.round(clamp(cx - dw / 2, -dw * 0.92, videoW - dw * 0.08));
    const fy = Math.round(clamp(cy - dh / 2, -dh * 0.92, videoH - dh * 0.08));
    return { dx: fx, dy: fy, dw, dh };
  }

  const dx =
    col === 0 ? m : col === 2 ? Math.round(videoW - dw - m) : Math.round((videoW - dw) / 2);
  const dy =
    row === 0 ? m : row === 2 ? Math.round(videoH - dh - m) : Math.round((videoH - dh) / 2);

  return { dx, dy, dw, dh };
}

/**
 * v5.0: draw the current frame of a VIDEO source, cover-fit into cw×ch —
 * the drawFrame twin with zoom locked to 1 and no Ken Burns (video motion
 * is the content). Black letterbox fill first, identity transform, high
 * smoothing. Sources without intrinsic dimensions yet (metadata not
 * loaded) leave the black frame.
 *
 * v5.2: `fit` = "contain" letterboxes instead of cover-cropping (preview
 * toggle — the full source frame stays visible with black bars). Export
 * keeps the default cover behavior so the output frame is always filled.
 */
export function drawVideoFrame(
  ctx: CanvasRenderingContext2D,
  source: VideoFrameSource | null | undefined,
  cw: number,
  ch: number,
  fit: "cover" | "contain" = "cover",
): void {
  // Clear + black background (letterbox fallback).
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, cw, ch);
  if (!source) return;

  // v8: displayWidth first — WebCodecs VideoFrames expose the VISIBLE
  // (aspect-corrected) size there; every other source kind is unchanged.
  const { w: iw, h: ih } = paintSourceSize(source);
  if (!iw || !ih) return;

  // object-fit: cover / contain base scale.
  const scale = fit === "contain" ? Math.min(cw / iw, ch / ih) : Math.max(cw / iw, ch / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = (cw - dw) / 2;
  const dy = (ch - dh) / 2;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, dx, dy, dw, dh);
}
