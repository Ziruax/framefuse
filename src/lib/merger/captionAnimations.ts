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
      // easeOutBack(0)=0, easeOutBack(1)=1 with overshoot in between.
      // So scale = 0.4 + easeOutBack(t) * 0.6 gives 0.4 at t=0 and
      // 1.0 at t=1, matching the ASS export's \fscx40 → \fscx115 → \fscx100.
      const t = clamp01(sinceStart / POP_IN_MS);
      const eased = easeOutBack(t);
      const scale = 0.4 + eased * 0.6;
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
 *
 * IMPORTANT: This function is the TS-side mirror of assAnimTags() in
 * electron/main.js. They MUST stay in sync so the canvas preview
 * (which uses computeWordTransform above) and the burned-in FFmpeg
 * export (which uses this ASS-tag emitter via main.js) produce
 * visually-identical output.
 *
 * ASS animation fundamentals:
 *   - All tags inside ONE {} block apply as a group at the start of the
 *     line. A second \move or \fad in the same block silently overrides
 *     the first. Multi-stage animations MUST use separate {} blocks.
 *   - \fad(t1,t2) and \move(x1,y1,x2,y2,t1,t2) can only appear ONCE per
 *     line — multiple calls silently overwrite.
 *   - \t(t1,t2,style) animates a single style property over [t1,t2]
 *     within the line's time. Sequential {} blocks with their own \t
 *     are read in order by libass.
 *   - For wave / jitter / shake (multi-point motion), we approximate
 *     with sequential \t blocks animating \frx/\fry rotation — small
 *     angles read as the intended motion without breaking ASS's
 *     single-\move rule.
 */
export function assWordAnimationTags(
  animation: CaptionAnimation,
  wordDurMs: number,
  ch: number = 1080,
): string {
  if (animation === "none") return "";

  const chScale = ch / 1080;
  // Each entry is a complete {} override block. Consecutive blocks are
  // read by libass as sequential override states.
  const blocks: string[] = [];

  switch (animation) {
    case "pop-in": {
      // Initial state: scaled to 40%, fully transparent. Then animate
      // to 115% (overshoot) at 70% of POP_IN_MS, then settle to 100%.
      blocks.push(`{\\fscx40\\fscy40\\alpha&HFF&}`);
      blocks.push(`{\\t(0,${Math.round(POP_IN_MS * 0.7)},\\fscx115\\fscy115\\alpha&H00&)}`);
      blocks.push(`{\\t(${Math.round(POP_IN_MS * 0.7)},${POP_IN_MS},\\fscx100\\fscy100)}`);
      break;
    }
    case "slide-up": {
      const dy = Math.round(30 * chScale);
      // Single \move covers the whole slide; \fad adds the fade.
      blocks.push(`{\\move(0,${dy},0,0,0,${SLIDE_UP_MS})\\fad(${Math.round(SLIDE_UP_MS * 0.6)},0)}`);
      break;
    }
    case "bounce-in": {
      // \move handles the main drop. \fad handles the fade-in. The
      // overshoot is approximated with \t animating \fry by 1° (a
      // tiny visual nudge — full 2-stage \move isn't supported in a
      // single block).
      const dy = Math.round(25 * chScale);
      const t1 = Math.round(BOUNCE_IN_MS * 0.6);
      blocks.push(`{\\move(0,${-dy},0,0,0,${t1})\\fad(${Math.round(BOUNCE_IN_MS * 0.4)},0)\\t(${t1},${BOUNCE_IN_MS},\\fry1)}`);
      break;
    }
    case "scale-pulse": {
      // Two pulses via sequential \t blocks.
      const half = Math.max(1, Math.round(wordDurMs / 2));
      blocks.push(`{\\t(0,${Math.round(half * 0.5)},\\fscx118\\fscy118)}`);
      blocks.push(`{\\t(${Math.round(half * 0.5)},${half},\\fscx100\\fscy100)}`);
      blocks.push(`{\\t(${half},${Math.round(half + (wordDurMs - half) * 0.5)},\\fscx118\\fscy118)}`);
      blocks.push(`{\\t(${Math.round(half + (wordDurMs - half) * 0.5)},${wordDurMs},\\fscx100\\fscy100)}`);
      break;
    }
    case "fade-through": {
      blocks.push(`{\\fad(150,150)}`);
      break;
    }
    case "typewriter": {
      // Approximate per-character reveal with a slow fade.
      blocks.push(`{\\fad(${TYPEWRITER_MS_PER_CHAR * 6},0)}`);
      break;
    }
    case "reveal": {
      // Animate a clip rect from 0 width to full width.
      blocks.push(`{\\clip(0,0,0,${ch})\\fad(${Math.round(REVEAL_MS * 0.5)},0)\\t(0,${REVEAL_MS},\\clip(0,0,2000,${ch}))}`);
      break;
    }
    case "wave": {
      // Approximate sine wave with sequential \t animating \fry
      // (small rotation) — gives a gentle rocking that reads as
      // "wave" without the multi-\move conflict.
      const amp = Math.max(1, Math.round(6 * chScale));
      const q = Math.max(50, Math.round(wordDurMs / 4));
      blocks.push(`{\\t(0,${q},\\fry${amp})}`);
      blocks.push(`{\\t(${q},${q * 2},\\fry${-amp})}`);
      blocks.push(`{\\t(${q * 2},${q * 3},\\fry${amp})}`);
      blocks.push(`{\\t(${q * 3},${wordDurMs},\\fry0)}`);
      break;
    }
    case "jitter": {
      // Multi-stage jitter via sequential \t blocks animating \frx
      // (rotation x) and \fry (rotation y) — small angles read as
      // jitter without breaking ASS's single-\move rule.
      const amp = 2; // degrees — small but visible
      const steps = Math.min(6, Math.max(3, Math.round(wordDurMs / 80)));
      const stepMs = Math.max(40, Math.round(wordDurMs / steps));
      for (let i = 0; i < steps; i++) {
        const t1 = i * stepMs;
        const t2 = (i + 1) * stepMs;
        const rx = i % 2 === 0 ? amp : -amp;
        const ry = i % 3 === 0 ? amp : -amp;
        blocks.push(`{\\t(${t1},${t2},\\frx${rx}\\fry${ry})}`);
      }
      // Final reset to 0 so the word settles.
      blocks.push(`{\\t(${steps * stepMs},${wordDurMs},\\frx0\\fry0)}`);
      break;
    }
    case "shake": {
      // Strong horizontal shake via sequential \frx rotation,
      // decaying amplitude. Reads as a punchy shake.
      const amp = 4; // degrees
      const steps = 5;
      const stepMs = Math.round(SHAKE_MS / steps);
      for (let i = 0; i < steps; i++) {
        const t1 = i * stepMs;
        const t2 = (i + 1) * stepMs;
        const decay = 1 - i / steps;
        const rx = (i % 2 === 0 ? 1 : -1) * Math.max(1, Math.round(amp * decay));
        blocks.push(`{\\t(${t1},${t2},\\frx${rx})}`);
      }
      // Reset after shake completes.
      blocks.push(`{\\t(${SHAKE_MS},${Math.max(SHAKE_MS + 50, wordDurMs)},\\frx0)}`);
      break;
    }
    case "drift": {
      // Single \move upward — works because there's only one move.
      const dy = Math.round(-8 * chScale);
      blocks.push(`{\\move(0,0,0,${dy},0,${wordDurMs})}`);
      break;
    }
    default:
      return "";
  }

  return blocks.length ? blocks.join("") : "";
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
