// src/lib/merger/captionAnimations.ts — kinetic typography animation system
//
// 21 kinetic typography animations designed for storytelling / retention
// content. Each animation drives BOTH the canvas preview (per-word transforms
// computed from currentMs) AND the ASS export (libass \t transform tags
// emitted per word).
//
// Animations are PURE: given (wordStartMs, wordEndMs, currentMs), they
// return a WordTransform that the renderer applies. This keeps the canvas
// + ASS paths in lock-step so the exported video matches the preview.
//
// Design philosophy:
//   - Per-word "in" transitions last 150-350ms (snappy, not sluggish).
//   - Active-loop transforms (scale-pulse, wave, swing, jitter) run for
//     the word's whole active window.
//   - Each animation re-engages the eye on every word without being
//     distracting — proven retention bumpers for short-form storytelling.
//
// ASS export notes:
//   - Karaoke ("word") mode lines are ONE Dialogue with \k tags, so
//     per-word tags there must be karaoke-safe: \fscx/\fscy/\frz/\frx/\fry/
//     \alpha/\1c/\2c/\t. \move and \fad are line-global and would break.
//     assWordAnimationTags(animation, dur, ch, { karaoke: true }) emits
//     only line-safe approximations for that mode.
//   - word-only / stack / per-cue lines get the full tag set (\move, \fad).

import type { CaptionAnimation } from "./types";

export interface WordTransform {
  /** Scale multiplier (1 = identity). */
  scale: number;
  /** Extra horizontal scale multiplier (for squash & stretch, glitch). */
  scaleX: number;
  /** Extra vertical scale multiplier (for squash & stretch, flip). */
  scaleY: number;
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
  /**
   * Per-word color override (hex #RRGGBB) — used by color-cycle.
   * Null = use the preset/word color.
   */
  colorOverride: string | null;
  /**
   * Glitch intensity 0-1 — the renderer draws RGB-split copies at this
   * strength (red shifted -x, cyan shifted +x).
   */
  glitchAmount: number;
  /**
   * Draw a highlight box behind this word (spotlight). Rendered by the
   * canvas path as a rounded box in the accent color; ASS approximates
   * via BorderStyle 3 per-line (word-only/stack) or a bold pop (karaoke).
   */
  highlightBox: boolean;
}

export const IDENTITY_TRANSFORM: WordTransform = {
  scale: 1,
  scaleX: 1,
  scaleY: 1,
  alpha: 1,
  offsetX: 0,
  offsetY: 0,
  rotation: 0,
  clipLeft: 1,
  colorOverride: null,
  glitchAmount: 0,
  highlightBox: false,
};

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4);
const easeOutBack = (t: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
const easeOutElastic = (t: number) => {
  const c4 = (2 * Math.PI) / 3;
  if (t === 0) return 0;
  if (t === 1) return 1;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
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

/** Viral color palette used by color-cycle (electric, high-contrast). */
export const COLOR_CYCLE_PALETTE = [
  "#FDE047", // electric yellow
  "#22D3EE", // cyan
  "#F472B6", // hot pink
  "#A3E635", // lime
];

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
const SLAM_MS = 180;
const GLITCH_MS = 220;
const SPIN_IN_MS = 300;
const FLIP_IN_MS = 260;
const ELASTIC_MS = 450;
const ZOOM_WORDS_MS = 160;
const SQUASH_MS = 340;

// ---------------------------------------------------------------------------
// computeWordTransform — the heart of the system. Given an animation id,
// the word's [start,end] window, and the current time, return the visual
// transform the renderer should apply.
//
// `wordIndex` is the index of this word within its cue (for staggered
// animations + deterministic seeded jitter + color-cycle palette).
// `ch` is the canvas height for resolution-independent offsets.
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
      const t = clamp01(sinceStart / POP_IN_MS);
      const eased = easeOutBack(t);
      const scale = 0.4 + eased * 0.6;
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
      if (!active) return IDENTITY_TRANSFORM;
      const phase = (currentMs - wordStartMs) / dur;
      const pulse = Math.sin(phase * Math.PI * 4); // 2 cycles
      const scale = 1 + pulse * 0.09;
      return { ...IDENTITY_TRANSFORM, scale };
    }
    case "fade-through": {
      const inT = clamp01(sinceStart / 150);
      const remaining = wordEndMs - currentMs;
      const outT = clamp01(remaining / 150);
      return { ...IDENTITY_TRANSFORM, alpha: Math.min(inT, outT) };
    }
    case "typewriter": {
      const revealed = Math.floor(sinceStart / TYPEWRITER_MS_PER_CHAR);
      const estChars = 6;
      const frac = clamp01(revealed / estChars);
      return {
        ...IDENTITY_TRANSFORM,
        clipLeft: frac,
        alpha: frac > 0 ? 1 : 0,
      };
    }
    case "reveal": {
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
      const phase = (currentMs - wordStartMs) / dur;
      const y = Math.sin(phase * Math.PI * 4) * 6 * chScale;
      return { ...IDENTITY_TRANSFORM, offsetY: y };
    }
    case "jitter": {
      if (!active) return IDENTITY_TRANSFORM;
      const bucket = Math.floor(sinceStart / 80);
      const seed = wordIndex * 1000 + bucket;
      const rx = (seededRand(seed) - 0.5) * 4 * chScale;
      const ry = (seededRand(seed + 1) - 0.5) * 4 * chScale;
      return { ...IDENTITY_TRANSFORM, offsetX: rx, offsetY: ry };
    }
    case "shake": {
      const t = clamp01(sinceStart / SHAKE_MS);
      if (t >= 1) return IDENTITY_TRANSFORM;
      const decay = 1 - t;
      const seed = wordIndex * 100 + Math.floor(sinceStart / 40);
      const shake = (seededRand(seed) - 0.5) * 12 * chScale * decay;
      return { ...IDENTITY_TRANSFORM, offsetX: shake, alpha: clamp01(t * 3) };
    }
    case "drift": {
      if (!active) return IDENTITY_TRANSFORM;
      const phase = clamp01(sinceStart / dur);
      return { ...IDENTITY_TRANSFORM, offsetY: -phase * 8 * chScale };
    }

    // ── v4.1 viral kinetic pack ──────────────────────────────────────
    case "slam": {
      // Machine-gun slam: scale 2.4 → 1 (fast, quartic) + micro-shake tail.
      const t = clamp01(sinceStart / SLAM_MS);
      const e = easeOutQuart(t);
      const scale = 2.4 - 1.4 * e;
      let shakeX = 0;
      if (t >= 1 && sinceStart < SLAM_MS + 120) {
        // Tail micro-shake for punch.
        const seed = wordIndex * 77 + Math.floor(sinceStart / 40);
        shakeX = (seededRand(seed) - 0.5) * 5 * chScale;
      }
      return {
        ...IDENTITY_TRANSFORM,
        scale: t >= 1 ? 1 : Math.max(0.01, scale),
        offsetX: shakeX,
        alpha: clamp01(t * 2.5),
      };
    }
    case "glitch": {
      // Digital glitch: rgb-split flicker + x-jumps during first GLITCH_MS,
      // with periodic re-glitch every ~500ms while active.
      let inWindow = sinceStart < GLITCH_MS;
      let rel = sinceStart;
      if (!inWindow && active) {
        // Periodic re-glitch pulse.
        const cycle = (sinceStart - GLITCH_MS) % 500;
        if (cycle < 90) {
          inWindow = true;
          rel = cycle;
        }
      }
      if (!inWindow) return IDENTITY_TRANSFORM;
      const bucket = Math.floor(rel / 60);
      const seed = wordIndex * 977 + bucket;
      const jump = (seededRand(seed) - 0.5) * 14 * chScale;
      // Flicker alpha between 0.6 and 1.
      const flick = 0.6 + 0.4 * Math.round(seededRand(seed + 3));
      return {
        ...IDENTITY_TRANSFORM,
        offsetX: jump,
        alpha: flick,
        glitchAmount: clamp01(1 - rel / GLITCH_MS) * 0.9,
      };
    }
    case "spin-in": {
      // Rot -14° → 0 + scale 0.6 → 1.
      const t = clamp01(sinceStart / SPIN_IN_MS);
      const e = easeOutBack(t);
      const rot = (-14 * (1 - e) * Math.PI) / 180;
      const scale = 0.6 + 0.4 * e;
      return {
        ...IDENTITY_TRANSFORM,
        rotation: rot,
        scale: t >= 1 ? 1 : Math.max(0.01, scale),
        alpha: clamp01(t * 1.6),
      };
    }
    case "flip-in": {
      // 3D flip: scaleY 0 → 1 (cos-like) + alpha.
      const t = clamp01(sinceStart / FLIP_IN_MS);
      const e = easeOutCubic(t);
      return {
        ...IDENTITY_TRANSFORM,
        scaleY: Math.max(0.02, e),
        alpha: clamp01(t * 1.8),
      };
    }
    case "elastic": {
      // Juicy elastic: 0.3 → overshoot ~1.06 → 1.
      const t = clamp01(sinceStart / ELASTIC_MS);
      const e = easeOutElastic(t);
      const scale = 0.3 + 0.7 * e;
      return {
        ...IDENTITY_TRANSFORM,
        scale: t >= 1 ? 1 : Math.max(0.01, scale),
        alpha: clamp01(t * 2),
      };
    }
    case "color-cycle": {
      // Static per-word viral palette color. Words pop slightly on entry.
      const t = clamp01(sinceStart / 160);
      const e = easeOutCubic(t);
      const color = COLOR_CYCLE_PALETTE[wordIndex % COLOR_CYCLE_PALETTE.length];
      return {
        ...IDENTITY_TRANSFORM,
        colorOverride: color,
        scale: 0.85 + 0.15 * e,
        alpha: clamp01(t * 2),
      };
    }
    case "spotlight": {
      // Active word pops with a colored highlight box; entry = quick pop.
      const t = clamp01(sinceStart / 200);
      const e = easeOutBack(t);
      const scale = 0.7 + 0.3 * e;
      return {
        ...IDENTITY_TRANSFORM,
        scale: t >= 1 ? 1 : Math.max(0.01, scale),
        alpha: clamp01(t * 2),
        highlightBox: active,
      };
    }
    case "swing": {
      // Pendulum: rotation swings ±8° while active (2 cycles).
      if (!active) return IDENTITY_TRANSFORM;
      const phase = (currentMs - wordStartMs) / dur;
      const rotDeg = Math.sin(phase * Math.PI * 4) * 8;
      return {
        ...IDENTITY_TRANSFORM,
        rotation: (rotDeg * Math.PI) / 180,
      };
    }
    case "squash": {
      // Squash & stretch entry: squashed tall-narrow → wide-short → settle.
      const t = clamp01(sinceStart / SQUASH_MS);
      if (t >= 1) return IDENTITY_TRANSFORM;
      if (t < 0.6) {
        const k = t / 0.6; // 0→1
        return {
          ...IDENTITY_TRANSFORM,
          scaleY: Math.max(0.05, 1 - 0.6 * k),
          scaleX: 1 + 0.35 * k,
          offsetY: (0.3 * k) * 12 * chScale,
          alpha: clamp01(t * 3),
        };
      }
      // Stretch back with overshoot.
      const k = (t - 0.6) / 0.4; // 0→1
      const e = easeOutBack(k);
      return {
        ...IDENTITY_TRANSFORM,
        scaleY: Math.max(0.05, 0.4 + 0.6 * e),
        scaleX: 1.35 - 0.35 * e,
        alpha: 1,
      };
    }
    case "zoom-words": {
      // Fast-cut: 1.6 → 1 + quick fade.
      const t = clamp01(sinceStart / ZOOM_WORDS_MS);
      const e = easeOutQuart(t);
      const scale = 1.6 - 0.6 * e;
      return {
        ...IDENTITY_TRANSFORM,
        scale: t >= 1 ? 1 : Math.max(0.01, scale),
        alpha: clamp01(t * 2.2),
      };
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
// `karaoke: true` (word mode) RESTRICTS the emitted tags to the
// line-safe set (\fscx/\fscy/\frz/\alpha/\1c/\2c/\t only) because \move
// and \fad are once-per-line globals that would animate the ENTIRE line.
// Word-only / stack / per-cue lines pass karaoke: false and may use
// \move + \fad for faithful motion.
// ---------------------------------------------------------------------------

export interface AssTagOptions {
  /** True when the tags live inside a single \k karaoke Dialogue line. */
  karaoke?: boolean;
  /** Word index within the cue (color-cycle palette, seeded jitter). */
  wordIndex?: number;
  /** Highlight color (hex) — used by spotlight/color flicker in karaoke. */
  highlightColor?: string | null;
}

/** #RRGGBB → ASS &HBBGGRR (no alpha). */
function hexToAss(hex: string): string {
  const h = hex.replace(/^#/, "");
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

export function assWordAnimationTags(
  animation: CaptionAnimation,
  wordDurMs: number,
  ch: number = 1080,
  opts: AssTagOptions = {},
): string {
  if (animation === "none") return "";

  const karaoke = !!opts.karaoke;
  const wordIndex = opts.wordIndex ?? 0;
  const chScale = ch / 1080;
  const blocks: string[] = [];

  switch (animation) {
    case "pop-in": {
      blocks.push(`{\\fscx40\\fscy40\\alpha&HFF&}`);
      blocks.push(`{\\t(0,${Math.round(POP_IN_MS * 0.7)},\\fscx115\\fscy115\\alpha&H00&)}`);
      blocks.push(`{\\t(${Math.round(POP_IN_MS * 0.7)},${POP_IN_MS},\\fscx100\\fscy100)}`);
      break;
    }
    case "slide-up": {
      if (karaoke) {
        // Line-safe: vertical motion approximated with \fry tilt + fade.
        blocks.push(`{\\alpha&HFF&\\fry-4}`);
        blocks.push(`{\\t(0,${SLIDE_UP_MS},\\alpha&H00&\\fry0)}`);
      } else {
        const dy = Math.round(30 * chScale);
        blocks.push(`{\\move(0,${dy},0,0,0,${SLIDE_UP_MS})\\fad(${Math.round(SLIDE_UP_MS * 0.6)},0)}`);
      }
      break;
    }
    case "bounce-in": {
      if (karaoke) {
        // Line-safe: elastic scale bounce reads as the spring drop.
        blocks.push(`{\\fscx60\\fscy60\\alpha&HFF&}`);
        blocks.push(`{\\t(0,${Math.round(BOUNCE_IN_MS * 0.6)},\\fscx112\\fscy112\\alpha&H00&)}`);
        blocks.push(`{\\t(${Math.round(BOUNCE_IN_MS * 0.6)},${BOUNCE_IN_MS},\\fscx100\\fscy100)}`);
      } else {
        const dy = Math.round(25 * chScale);
        const t1 = Math.round(BOUNCE_IN_MS * 0.6);
        blocks.push(`{\\move(0,${-dy},0,0,0,${t1})\\fad(${Math.round(BOUNCE_IN_MS * 0.4)},0)\\t(${t1},${BOUNCE_IN_MS},\\fry1)}`);
      }
      break;
    }
    case "scale-pulse": {
      const half = Math.max(1, Math.round(wordDurMs / 2));
      blocks.push(`{\\t(0,${Math.round(half * 0.5)},\\fscx118\\fscy118)}`);
      blocks.push(`{\\t(${Math.round(half * 0.5)},${half},\\fscx100\\fscy100)}`);
      blocks.push(`{\\t(${half},${Math.round(half + (wordDurMs - half) * 0.5)},\\fscx118\\fscy118)}`);
      blocks.push(`{\\t(${Math.round(half + (wordDurMs - half) * 0.5)},${wordDurMs},\\fscx100\\fscy100)}`);
      break;
    }
    case "fade-through": {
      if (karaoke) {
        // \fad is line-global in karaoke; approximate per-word with alpha \t.
        blocks.push(`{\\alpha&HFF&}`);
        blocks.push(`{\\t(0,150,\\alpha&H00&)}`);
      } else {
        blocks.push(`{\\fad(150,150)}`);
      }
      break;
    }
    case "typewriter": {
      blocks.push(karaoke
        ? `{\\alpha&HFF&\\t(0,${TYPEWRITER_MS_PER_CHAR * 6},\\alpha&H00&)}`
        : `{\\fad(${TYPEWRITER_MS_PER_CHAR * 6},0)}`);
      break;
    }
    case "reveal": {
      if (karaoke) {
        // Line-safe: alpha ramp + slight rotation reads as the reveal.
        blocks.push(`{\\alpha&HC0&}`);
        blocks.push(`{\\t(0,${REVEAL_MS},\\alpha&H00&)}`);
      } else {
        blocks.push(`{\\clip(0,0,0,${ch})\\fad(${Math.round(REVEAL_MS * 0.5)},0)\\t(0,${REVEAL_MS},\\clip(0,0,2000,${ch}))}`);
      }
      break;
    }
    case "wave": {
      const amp = Math.max(1, Math.round(6 * chScale));
      const q = Math.max(50, Math.round(wordDurMs / 4));
      blocks.push(`{\\t(0,${q},\\fry${amp})}`);
      blocks.push(`{\\t(${q},${q * 2},\\fry${-amp})}`);
      blocks.push(`{\\t(${q * 2},${q * 3},\\fry${amp})}`);
      blocks.push(`{\\t(${q * 3},${wordDurMs},\\fry0)}`);
      break;
    }
    case "jitter": {
      const amp = 2;
      const steps = Math.min(6, Math.max(3, Math.round(wordDurMs / 80)));
      const stepMs = Math.max(40, Math.round(wordDurMs / steps));
      for (let i = 0; i < steps; i++) {
        const t1 = i * stepMs;
        const t2 = (i + 1) * stepMs;
        const rx = i % 2 === 0 ? amp : -amp;
        const ry = i % 3 === 0 ? amp : -amp;
        blocks.push(`{\\t(${t1},${t2},\\frx${rx}\\fry${ry})}`);
      }
      blocks.push(`{\\t(${steps * stepMs},${wordDurMs},\\frx0\\fry0)}`);
      break;
    }
    case "shake": {
      const amp = 4;
      const steps = 5;
      const stepMs = Math.round(SHAKE_MS / steps);
      for (let i = 0; i < steps; i++) {
        const t1 = i * stepMs;
        const t2 = (i + 1) * stepMs;
        const decay = 1 - i / steps;
        const rx = (i % 2 === 0 ? 1 : -1) * Math.max(1, Math.round(amp * decay));
        blocks.push(`{\\t(${t1},${t2},\\frx${rx})}`);
      }
      blocks.push(`{\\t(${SHAKE_MS},${Math.max(SHAKE_MS + 50, wordDurMs)},\\frx0)}`);
      break;
    }
    case "drift": {
      if (karaoke) {
        // Line-safe: slow scale-up + fade-down reads as drifting away.
        blocks.push(`{\\t(0,${wordDurMs},\\fscx96\\fscy96\\alpha&H30&)}`);
      } else {
        const dy = Math.round(-8 * chScale);
        blocks.push(`{\\move(0,0,0,${dy},0,${wordDurMs})}`);
      }
      break;
    }

    // ── v4.1 viral kinetic pack ──────────────────────────────────────
    case "slam": {
      // Scale 240 → 115 → 100, fast.
      blocks.push(`{\\fscx240\\fscy240\\alpha&HFF&}`);
      blocks.push(`{\\t(0,${Math.round(SLAM_MS * 0.5)},\\fscx115\\fscy115\\alpha&H00&)}`);
      blocks.push(`{\\t(${Math.round(SLAM_MS * 0.5)},${SLAM_MS},\\fscx100\\fscy100)}`);
      // Punch micro-shake after landing.
      blocks.push(`{\\t(${SLAM_MS},${SLAM_MS + 80},\\frz2)}`);
      blocks.push(`{\\t(${SLAM_MS + 80},${SLAM_MS + 140},\\frz0)}`);
      break;
    }
    case "glitch": {
      // Flicker alpha + rotation jitter + color flick to highlight.
      const hl = opts.highlightColor ? hexToAss(opts.highlightColor) : null;
      blocks.push(`{\\alpha&HA0&\\frz-3}`);
      blocks.push(`{\\t(0,60,\\alpha&H40&\\frz3)}`);
      if (hl) blocks.push(`{\\1c${hl}}`);
      blocks.push(`{\\t(60,120,\\alpha&H00&\\frz-2)}`);
      blocks.push(`{\\t(120,${GLITCH_MS},\\alpha&H00&\\frz0)}`);
      break;
    }
    case "spin-in": {
      blocks.push(`{\\frz-14\\fscx60\\fscy60\\alpha&HFF&}`);
      blocks.push(`{\\t(0,${SPIN_IN_MS},\\frz0\\fscx100\\fscy100\\alpha&H00&)}`);
      break;
    }
    case "flip-in": {
      // \fscy flip: 5% → 100 with slight overshoot.
      blocks.push(`{\\fscy5\\alpha&HFF&}`);
      blocks.push(`{\\t(0,${Math.round(FLIP_IN_MS * 0.8)},\\fscy108\\alpha&H00&)}`);
      blocks.push(`{\\t(${Math.round(FLIP_IN_MS * 0.8)},${FLIP_IN_MS},\\fscy100)}`);
      break;
    }
    case "elastic": {
      blocks.push(`{\\fscx30\\fscy30\\alpha&HFF&}`);
      blocks.push(`{\\t(0,${Math.round(ELASTIC_MS * 0.55)},\\fscx106\\fscy106\\alpha&H00&)}`);
      blocks.push(`{\\t(${Math.round(ELASTIC_MS * 0.55)},${Math.round(ELASTIC_MS * 0.8)},\\fscx97\\fscy97)}`);
      blocks.push(`{\\t(${Math.round(ELASTIC_MS * 0.8)},${ELASTIC_MS},\\fscx100\\fscy100)}`);
      break;
    }
    case "color-cycle": {
      // Static per-word palette color + quick pop.
      const color = COLOR_CYCLE_PALETTE[wordIndex % COLOR_CYCLE_PALETTE.length];
      const ass = hexToAss(color);
      blocks.push(`{\\1c${ass}\\fscx85\\fscy85\\alpha&HFF&}`);
      blocks.push(`{\\t(0,160,\\fscx100\\fscy100\\alpha&H00&)}`);
      break;
    }
    case "spotlight": {
      // Pop-in + pulse; the highlight box itself comes from BorderStyle 3
      // (word-only/stack lines) or the highlight color (karaoke \1c pop).
      blocks.push(`{\\fscx70\\fscy70\\alpha&HFF&}`);
      blocks.push(`{\\t(0,140,\\fscx112\\fscy112\\alpha&H00&)}`);
      blocks.push(`{\\t(140,200,\\fscx100\\fscy100)}`);
      const half = Math.max(1, Math.round(wordDurMs / 2));
      blocks.push(`{\\t(200,${Math.round(200 + half * 0.4)},\\fscx106\\fscy106)}`);
      blocks.push(`{\\t(${Math.round(200 + half * 0.4)},${Math.max(200 + half, 201)},\\fscx100\\fscy100)}`);
      break;
    }
    case "swing": {
      const amp = 8;
      const q = Math.max(50, Math.round(wordDurMs / 4));
      blocks.push(`{\\frz${amp}}`);
      blocks.push(`{\\t(0,${q},\\frz${-amp})}`);
      blocks.push(`{\\t(${q},${q * 2},\\frz${amp})}`);
      blocks.push(`{\\t(${q * 2},${q * 3},\\frz${-amp})}`);
      blocks.push(`{\\t(${q * 3},${wordDurMs},\\frz0)}`);
      break;
    }
    case "squash": {
      // Squash tall-narrow → stretch wide-short → settle.
      blocks.push(`{\\fscy40\\fscx135\\alpha&HFF&}`);
      blocks.push(`{\\t(0,${Math.round(SQUASH_MS * 0.6)},\\fscy40\\fscx135\\alpha&H00&)}`);
      blocks.push(`{\\t(${Math.round(SQUASH_MS * 0.6)},${Math.round(SQUASH_MS * 0.85)},\\fscy108\\fscx92)}`);
      blocks.push(`{\\t(${Math.round(SQUASH_MS * 0.85)},${SQUASH_MS},\\fscy100\\fscx100)}`);
      break;
    }
    case "zoom-words": {
      blocks.push(`{\\fscx160\\fscy160\\alpha&HFF&}`);
      blocks.push(`{\\t(0,${ZOOM_WORDS_MS},\\fscx100\\fscy100\\alpha&H00&)}`);
      break;
    }
    default:
      return "";
  }

  return blocks.length ? blocks.join("") : "";
}

/** Human-readable labels for the animation selector UI. */
export const ANIMATION_LABELS: {
  value: CaptionAnimation;
  label: string;
  hint: string;
  group: "classic" | "viral";
}[] = [
  { value: "none", label: "None", hint: "Static text (no motion)", group: "classic" },
  { value: "pop-in", label: "Pop-In", hint: "Scale 0.4 → 1 with bounce (220ms)", group: "classic" },
  { value: "slide-up", label: "Slide-Up", hint: "Words slide up from below (280ms)", group: "classic" },
  { value: "bounce-in", label: "Bounce-In", hint: "Spring drop from above (380ms)", group: "classic" },
  { value: "scale-pulse", label: "Scale-Pulse", hint: "Active word pulses 1.18× (loop)", group: "classic" },
  { value: "fade-through", label: "Fade-Through", hint: "Smooth fade in / out per word", group: "classic" },
  { value: "typewriter", label: "Typewriter", hint: "Characters reveal one-by-one", group: "classic" },
  { value: "reveal", label: "Reveal", hint: "Clip from left + fade (320ms)", group: "classic" },
  { value: "wave", label: "Wave", hint: "Sine y-oscillation while active", group: "classic" },
  { value: "jitter", label: "Jitter", hint: "Small random shake (attention)", group: "classic" },
  { value: "shake", label: "Shake", hint: "Strong horizontal shake on word start", group: "classic" },
  { value: "drift", label: "Drift", hint: "Slow upward drift while active", group: "classic" },
  { value: "slam", label: "Slam", hint: "Machine-gun 2.4× → 1 + punch shake", group: "viral" },
  { value: "glitch", label: "Glitch", hint: "RGB-split digital flicker", group: "viral" },
  { value: "spin-in", label: "Spin-In", hint: "Spin -14° → 0 + scale-up", group: "viral" },
  { value: "flip-in", label: "Flip-In", hint: "3D flip scaleY 0 → 1", group: "viral" },
  { value: "elastic", label: "Elastic", hint: "Juicy elastic 0.3 → 1.06 → 1", group: "viral" },
  { value: "color-cycle", label: "Color-Cycle", hint: "Per-word electric palette", group: "viral" },
  { value: "spotlight", label: "Spotlight", hint: "Active word pops in highlight box", group: "viral" },
  { value: "swing", label: "Swing", hint: "Pendulum ±8° while active", group: "viral" },
  { value: "squash", label: "Squash", hint: "Squash & stretch entry", group: "viral" },
  { value: "zoom-words", label: "Zoom-Words", hint: "Fast-cut zoom 1.6 → 1 (160ms)", group: "viral" },
];
