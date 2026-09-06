// src/lib/merger/renderer.ts — canvas Ken Burns frame renderer
import type {
  AspectRatio,
  KenBurnsConfig,
  MediaSegment,
  Resolution,
} from "./types";

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
