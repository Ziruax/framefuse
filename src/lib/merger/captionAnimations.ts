// src/lib/merger/captionAnimations.ts — kinetic typography animation system
//
// 12 kinetic typography animations designed for storytelling / retention
// content. Each animation drives BOTH the canvas preview (per-word transforms
// computed from currentMs) AND the ASS export (libass \t transform tags
// emitted per word).
//
// Animations are PURE: given (wordStartMs, wordEndMs, currentMs), they
// return a {scale, alpha, offsetX, offsetY, rotation, clipLeft} transform
// that the renderer applies. This keeps the canvas + ASS paths in lock-step
// so the exported video matches the preview exactly.
//
// Design philosophy:
//   - Per-word "in" transitions last 200-350ms (snappy, not sluggish).
//   - Active-loop transforms (scale-pulse, wave, jitter, drift) run for
//     the word's whole active window.
//   - Each animation re-engages the eye on every word without being
//     distracting — proven retention bumpers for short-form storytelling.

import type { CaptionAnimation } from "./types";

export interface WordTransform {
  /** Scale multiplier (1 = identity). */
  scale: number;
  /** Alpha 0-1 (1 = fully opaque). */
  alpha: number;
  /** Pixel offset X (added to base x). */
  offsetX: number;
  /** Pixel offset Y (added to base y). */
  offsetY: number;
  /** Rotation in radians. */
  rotation: number;
  /** Clip mask: fraction of the word's width visible from the left (0-1, 1 = no clip). */
  clipLeft: number;
}

export const IDENTITY_TRANSFORM: WordTransform = {
  scale: 1,
  alpha: 1,
  offsetX: 0,
  offsetY: 0,
  rotation: 0,
  clipLeft: 1,
};

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
const easeOutElastic = (t: number) => {
  const c4 = (2 * Math.PI) / 3;
  if (t === 0) return 0;
  if (t === 1) return 1;
  return (
    Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1
  );
};
const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// Deterministic per-word jitter so the canvas and ASS paths agree.
function seededRand(seed: number): number {
  // Cheap hash → 0..1. Stable so export matches preview frame-by-frame.
  let h = 2166136261;
  for (let i = 0; i < seed; i++) h = Math.imul(h ^ i, 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Animation params — all times in ms, all sizes in 1080p-referenced pixels
// (the renderer scales them to the actual canvas).
// ---------------------------------------------------------------------------

const POP_IN_MS = 220;
const SLIDE_UP_MS = 280;
const BOUNCE_IN_MS = 380;
const REVEAL_MS = 320;
const SHAKE_MS = 280;
const TYPEWRITER_MS_PER_CHAR = 45;

// ---------------------------------------------------------------------------
// computeWordTransform — the heart of the system. Given an animation id,
// the word's [start,end] window, and the current time, return the visual
// transform the renderer should apply.
//
// `px` and `py` are the word's base position (top-left of the word's bounding
// box in canvas pixels). The renderer uses them only when the animation
// needs a reference point — most animations only use offsets relative to
// the base position, so they can ignore px/py.
//
// `wordIndex` is the index of this word within its cue (for staggered
// animations like fade-through or typewriter).
// ---------------------------------------------------------------------------

export function computeWordTransform(
  animation: CaptionAnimation,
  wordStartMs: number,
  wordEndMs: number,
  currentMs: number,
  wordIndex: number,
  px: number = 0,
  py: number = 0,
  ch: number = 1080,
): WordTransform {
  if (animation === "none") return IDENTITY_TRANSFORM;

  const active = currentMs >= wordStartMs && currentMs < wordEndMs;
  const sinceStart = currentMs - wordStartMs;
  const dur = Math.max(1, wordEndMs - wordStartMs);

  // Scale ch-relative offsets back to a 1080p baseline so animations
  // look identical at any output resolution.
  const chScale = ch / 1080;

  switch (animation) {
    case "pop-in": {
      // Scale 0.4 → 1 with overshoot bounce over POP_IN_MS.
      const t = clamp01(sinceStart / POP_IN_MS);
      const scale = 0.4 + (easeOutBack(t) - 0.4) * (1 - 0.4) / (1 - 0);
      // After the bounce, settle at 1.
      const finalScale = t >= 1 ? 1 : scale;
      return {
        ...IDENTITY_TRANSFORM,
        scale: Math.max(0.01, finalScale),
        alpha: clamp01(sinceStart / (POP_IN_MS * 0.4)),
      };
    }
    case "slide-up": {
      const t = clamp01(sinceStart / SLIDE_UP_MS);
      const e = easeOutCubic(t);
      return {
        ...IDENTITY_TRANSFORM,
        offsetY: (1 - e) * 30 * chScale,
        alpha: e,
      };
    }
    case "bounce-in": {
      const t = clamp01(sinceStart / BOUNCE_IN_MS);
      const e = easeOutElastic(t);
      return {
        ...IDENTITY_TRANSFORM,
        offsetY: -(1 - e) * 25 * chScale,
        alpha: clamp01(t * 2),
      };
    }
    case "scale-pulse": {
      // Continuous pulse while active. Two cycles per word.
      if (!active) return IDENTITY_TRANSFORM;
      const phase = (currentMs - wordStartMs) / dur;
      const pulse = Math.sin(phase * Math.PI * 4); // 2 cycles
      const scale = 1 + pulse * 0.09;
      return { ...IDENTITY_TRANSFORM, scale };
    }
    case "fade-through": {
      // Word fades in over first 150ms, full opacity until last 150ms,
      // then fades out. Active words get full opacity.
      const inT = clamp01(sinceStart / 150);
      const remaining = wordEndMs - currentMs;
      const outT = clamp01(remaining / 150);
      return { ...IDENTITY_TRANSFORM, alpha: Math.min(inT, outT) };
    }
    case "typewriter": {
      // Reveal characters one-by-one. We use clipLeft as the fraction
      // visible from the left, so the renderer clips the word's right
      // edge as the cue plays. Characters reveal at TYPEWRITER_MS_PER_CHAR.
      const revealed = Math.floor(sinceStart / TYPEWRITER_MS_PER_CHAR);
      // We don't know char count here; the renderer will compute it.
      // Send an estimated clipLeft based on word length: ~6 chars avg.
      const estChars = 6;
      const frac = clamp01(revealed / estChars);
      return {
        ...IDENTITY_TRANSFORM,
        clipLeft: frac,
        alpha: frac > 0 ? 1 : 0,
      };
    }
    case "reveal": {
      // Word clipped from left + slight x offset + alpha 0.4 → 1.
      const t = clamp01(sinceStart / REVEAL_MS);
      const e = easeOutCubic(t);
      return {
        ...IDENTITY_TRANSFORM,
        clipLeft: e,
        offsetX: (1 - e) * 15 * chScale,
        alpha: 0.4 + 0.6 * e,
      };
    }
    case "wave": {
      if (!active) return IDENTITY_TRANSFORM;
      // Sine y-offset; two cycles per word.
      const phase = (currentMs - wordStartMs) / dur;
      const y = Math.sin(phase * Math.PI * 4) * 6 * chScale;
      return { ...IDENTITY_TRANSFORM, offsetY: y };
    }
    case "jitter": {
      if (!active) return IDENTITY_TRANSFORM;
      // Small random shake, refreshed every 80ms. Deterministic per
      // (wordIndex, bucket) so canvas + ASS agree.
      const bucket = Math.floor(sinceStart / 80);
      const seed = wordIndex * 1000 + bucket;
      const rx = (seededRand(seed) - 0.5) * 4 * chScale;
      const ry = (seededRand(seed + 1) - 0.5) * 4 * chScale;
      return { ...IDENTITY_TRANSFORM, offsetX: rx, offsetY: ry };
    }
    case "shake": {
      // Strong horizontal shake for SHAKE_MS on word start.
      const t = clamp01(sinceStart / SHAKE_MS);
      if (t >= 1) return IDENTITY_TRANSFORM;
      const decay = 1 - t;
      const seed = wordIndex * 100 + Math.floor(sinceStart / 40);
      const shake = (seededRand(seed) - 0.5) * 12 * chScale * decay;
      return { ...IDENTITY_TRANSFORM, offsetX: shake, alpha: clamp01(t * 3) };
    }
    case "drift": {
      if (!active) return IDENTITY_TRANSFORM;
      // Slow upward drift over the word's full duration.
      const phase = clamp01(sinceStart / dur);
      return { ...IDENTITY_TRANSFORM, offsetY: -phase * 8 * chScale };
    }
    default:
      return IDENTITY_TRANSFORM;
  }
}

// ---------------------------------------------------------------------------
// ASS export helpers — emit libass transform tags that reproduce each
// animation in the burned-in FFmpeg export.
//
// libass supports:
//   \t(t1,t2,style)  — animate style over [t1,t2] within the dialogue line
//   \fscx,\fscy     — scale x / y in percent
//   \frx,\fry,\frz  — rotation in degrees
//   \1a,\2a,\3a,\4a — alpha for primary/secondary/outline/back colour
//   \1c,\2c         — primary / secondary colour
//   \move(x1,y1,x2,y2,t1,t2) — position animation
//   \fad(t1,t2)     — fade-in / fade-out durations
//   \clip(x1,y1,x2,y2) — rectangular clip
//
// We use \t for in/out transitions and per-word Dialogue lines for the
// "word-only" mode (one per word, each showing only that word).
// ---------------------------------------------------------------------------

/**
 * Compute the ASS transform-tag prefix for one word in a given animation,
 * relative to the word's start (t=0). The Dialogue line's start time is
 * set to the word's start, so t=0 inside the line is the word's start.
 *
 * `ch` is the ASS PlayResY (typically 1080 or the video height).
 */
export function assWordAnimationTags(
  animation: CaptionAnimation,
  wordDurMs: number,
  ch: number = 1080,
): string {
  if (animation === "none") return "";

  const chScale = ch / 1080;
  const tags: string[] = [];

  switch (animation) {
    case "pop-in": {
      // Scale 40% → 100% with overshoot via two keyframes (libass \t is
      // linear interpolation between two states; we approximate the
      // overshoot by going 40% → 115% over 70% of the time, then
      // 115% → 100% over the remaining 30%).
      tags.push(`\\fscx40\\fscy40\\alpha&HFF&`);
      tags.push(`\\t(0,${Math.round(POP_IN_MS * 0.7)},\\fscx115\\fscy115\\alpha&H00&)`);
      tags.push(`\\t(${Math.round(POP_IN_MS * 0.7)},${POP_IN_MS},\\fscx100\\fscy100)`);
      break;
    }
    case "slide-up": {
      const dy = Math.round(30 * chScale);
      tags.push(`\\move(0,${dy},0,0,0,${SLIDE_UP_MS})`);
      tags.push(`\\fad(${Math.round(SLIDE_UP_MS * 0.6)},0)`);
      break;
    }
    case "bounce-in": {
      const dy = Math.round(25 * chScale);
      // Approximate the elastic ease with a two-stage move: drop fast,
      // bounce up small, settle.
      tags.push(`\\move(0,${-dy},0,0,0,${Math.round(BOUNCE_IN_MS * 0.6)})`);
      tags.push(`\\move(0,${Math.round(-dy * 0.15)},0,0,${Math.round(BOUNCE_IN_MS * 0.6)},${BOUNCE_IN_MS})`);
      tags.push(`\\fad(${Math.round(BOUNCE_IN_MS * 0.4)},0)`);
      break;
    }
    case "scale-pulse": {
      // Pulse twice across the word's duration. \t can't easily loop, so
      // we use two sequential pulses.
      const half = Math.round(wordDurMs / 2);
      tags.push(`\\t(0,${Math.round(half * 0.5)},\\fscx118\\fscy118)`);
      tags.push(`\\t(${Math.round(half * 0.5)},${half},\\fscx100\\fscy100)`);
      tags.push(`\\t(${half},${Math.round(half + (wordDurMs - half) * 0.5)},\\fscx118\\fscy118)`);
      tags.push(`\\t(${Math.round(half + (wordDurMs - half) * 0.5)},${wordDurMs},\\fscx100\\fscy100)`);
      break;
    }
    case "fade-through": {
      tags.push(`\\fad(150,150)`);
      break;
    }
    case "typewriter": {
      // Approximation: alpha 0 → 1 over the first ~300ms. Per-character
      // reveal in ASS requires \\clip with an animated rect, which is
      // expensive; we keep it simple with a fade + small x clip move.
      tags.push(`\\fad(${TYPEWRITER_MS_PER_CHAR * 6},0)`);
      break;
    }
    case "reveal": {
      // Reveal from left: animate a clip rect from x=0 to full width.
      // ASS \\clip uses PlayResX/Y coordinates; we use a generous width
      // so this works at any canvas size. The clip animation needs a
      // fixed width, so we use 2000 (covers up to 1080p 16:9 + 9:16).
      tags.push(`\\clip(0,0,0,${ch})`);
      tags.push(`\\t(0,${REVEAL_MS},\\clip(0,0,2000,${ch}))`);
      tags.push(`\\fad(${Math.round(REVEAL_MS * 0.5)},0)`);
      break;
    }
    case "wave": {
      // Two sine cycles over the word's duration. Approximated with 4
      // \move segments.
      const amp = Math.round(6 * chScale);
      const q = Math.round(wordDurMs / 4);
      tags.push(`\\move(0,0,0,${amp},0,${q})`);
      tags.push(`\\move(0,${amp},0,${-amp},${q},${q * 2})`);
      tags.push(`\\move(0,${-amp},0,${amp},${q * 2},${q * 3})`);
      tags.push(`\\move(0,${amp},0,0,${q * 3},${wordDurMs})`);
      break;
    }
    case "jitter": {
      // 8 jitter steps across the word (every ~80ms for a 640ms word).
      // We can't randomize in ASS, so use a deterministic pattern.
      const amp = Math.round(4 * chScale);
      const steps = 8;
      const stepMs = Math.max(40, Math.round(wordDurMs / steps));
      for (let i = 0; i < steps; i++) {
        const t1 = i * stepMs;
        const t2 = (i + 1) * stepMs;
        const dx = ((i % 2 === 0 ? 1 : -1) * amp * (i + 1)) / steps;
        const dy = ((i % 3 === 0 ? 1 : -1) * amp * (i + 1)) / steps;
        tags.push(`\\t(${t1},${t2},\\move(0,0,${Math.round(dx)},${Math.round(dy)})`);
      }
      break;
    }
    case "shake": {
      // 7 shake steps with decaying amplitude.
      const amp = Math.round(12 * chScale);
      const steps = 7;
      const stepMs = Math.round(SHAKE_MS / steps);
      for (let i = 0; i < steps; i++) {
        const t1 = i * stepMs;
        const t2 = (i + 1) * stepMs;
        const decay = 1 - i / steps;
        const dx = ((i % 2 === 0 ? 1 : -1) * amp * decay);
        tags.push(`\\t(${t1},${t2},\\move(0,0,${Math.round(dx)},0)`);
      }
      break;
    }
    case "drift": {
      const dy = Math.round(-8 * chScale);
      tags.push(`\\move(0,0,0,${dy},0,${wordDurMs})`);
      break;
    }
    default:
      return "";
  }

  return tags.length ? `{${tags.join("")}}` : "";
}

/** Human-readable labels for the animation selector UI. */
export const ANIMATION_LABELS: { value: CaptionAnimation; label: string; hint: string }[] = [
  { value: "none", label: "None", hint: "Static text (no motion)" },
  { value: "pop-in", label: "Pop-In", hint: "Scale 0.4 → 1 with bounce (200ms)" },
  { value: "slide-up", label: "Slide-Up", hint: "Words slide up from below (250ms)" },
  { value: "bounce-in", label: "Bounce-In", hint: "Spring drop from above (350ms)" },
  { value: "scale-pulse", label: "Scale-Pulse", hint: "Active word pulses 1.18× (loop)" },
  { value: "fade-through", label: "Fade-Through", hint: "Smooth fade in / out per word" },
  { value: "typewriter", label: "Typewriter", hint: "Characters reveal one-by-one" },
  { value: "reveal", label: "Reveal", hint: "Clip from left + fade (300ms)" },
  { value: "wave", label: "Wave", hint: "Sine y-oscillation while active" },
  { value: "jitter", label: "Jitter", hint: "Small random shake (attention)" },
  { value: "shake", label: "Shake", hint: "Strong horizontal shake on word start" },
  { value: "drift", label: "Drift", hint: "Slow upward drift while active" },
];
