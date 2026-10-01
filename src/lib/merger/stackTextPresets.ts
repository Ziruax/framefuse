// src/lib/merger/stackTextPresets.ts — Stack Text dynamic typography (v1.17)
//
// Stack Text = the "Headline" hook-title overlays with TWO user-facing axes:
//   LAYOUTS  — how the stacked lines are arranged on the frame (pure geometry).
//   STYLES   — kinetic per-word / per-line choreography (timing + transforms).
//
// This module is the SINGLE SOURCE OF TRUTH for both engines:
//   - native.ts drawHeadline()  → canvas preview  (stackUnitTransforms math)
//   - electron/main.js          → ASS burn-in     (stackAssTagsForUnit tags)
//
// PURE TypeScript: no React, no canvas, no Electron — data + math only, so
// the renderer consumes it directly and the main process mirrors the same
// constants into its ASS builder (main.js keeps a plain-JS twin of the tag
// helpers, mirroring the headlinePresets.ts pattern).
//
// Design rules (mirrors headlinePresets / captionAnimations):
//   - Every number referenced by BOTH the canvas and the ASS path lives here
//     as a spec constant (or a fraction of one) — no magic numbers downstream.
//   - Shared timing model: unit i (word or line, per the style's `unit`)
//     starts at  leadInMs + i × staggerMs  after the item's startMs and
//     animates for durationMs. The canvas and the \t/\k windows agree exactly.
//   - Fractions (offsetYFrac / offsetXPerUnitFrac) are of the LIVE canvas
//     size, so they are resolution-independent. blurPx is 1080p-referenced
//     (the painter scales by canvasH/1080; the ASS emitter by PlayResH/1080).
//   - Easing: the CANVAS interpolates offsets/scale/blur/rotation with the
//     spec's ease curve. libass \t/\move interpolate linearly (no cubic
//     easing in ASS) — the same approximation the shipped slide-up/pop
//     headline animations already use. ALPHA is ramped LINEARLY on BOTH
//     sides over alphaRampFrac × durationMs, so opacity parity is exact.
//   - The universal block fade-out tail is STACK_FADE_OUT_MS — the CALLER
//     applies it to the whole block (canvas: multiply the block alpha;
//     ASS: it is already baked into the per-unit tags as \fad(0,300) for
//     line-unit styles, and into the documented line prefix for word-unit
//     styles). It matches the existing HEADLINE_FADE_MS out behavior.
//   - \blur note: blur-rise is the first \blur user in the pipeline. libass
//     handles it; if a future constrained-CPU path re-enables
//     optimizeAssForConstrainedCpu (main.js), \blur0 degrades gracefully
//     (alpha + rise still carry the entrance).
//
// Usage flow for the twin engines (57-e wiring guide):
//   CANVAS (native.ts): wrap the text into lines → build StackUnits →
//     middleBandActiveLine() when the layout is "middle-band" →
//     stackUnitTransforms() → paint each unit with its transform →
//     multiply the whole block by the STACK_FADE_OUT_MS tail.
//   ASS (main.js): one Dialogue per line for `unit: "line"` styles, one
//     Dialogue for the whole block (words joined with spaces, lines with \N)
//     for `unit: "word"` styles. Per-unit inline tags come from
//     stackAssTagsForUnit(); \k/\kf centisecond sequences come from
//     stackAssWordTimingCs(). STACK_STYLE_ASS_DOC / STACK_LAYOUT_ASS_DOC
//     carry the exact per-style construction recipe.

// ---------------------------------------------------------------------------
// LAYOUTS — geometry only, no timing
// ---------------------------------------------------------------------------

export type StackLayoutId =
  | "center-stack"
  | "top-banner"
  | "bottom-center"
  | "left-stack"
  | "stagger-offset"
  | "middle-band";

export interface StackLayoutSpec {
  /** Horizontal alignment of every line inside the block ("left" = text left edge flush). */
  blockAlignmentX: "center" | "left";
  /**
   * Which block edge `marginYFrac` measures:
   *   anchorY "top"    → blockTop    = marginYFrac × canvasH
   *   anchorY "center" → blockCenter = marginYFrac × canvasH
   *   anchorY "bottom" → blockBottom = canvasH − marginYFrac × canvasH
   */
  anchorY: "top" | "center" | "bottom";
  /** Block anchor position as a fraction of canvas HEIGHT (see anchorY). */
  marginYFrac: number;
  /** Left margin (fraction of canvas WIDTH) for blockAlignmentX "left". */
  leftMarginFrac: number;
  /**
   * Per-line horizontal cascade step (fraction of canvas WIDTH). Line i is
   * drawn at x + lineOffsetX(i) where lineOffsetX uses this fraction (0 = no
   * cascade). See stackLayoutLineOffsetX().
   */
  staggerOffsetXFrac: number;
  /** "middle-band" = only ONE line visible at a time (equal time slices). */
  rotate: "none" | "middle-band";
  /** Line-height multiplier (fontSize × this). Default/stock value 1.22 (matches drawHeadline). */
  lineSpacingFrac?: number;
  /** true = cascade direction alternates per line (even lines step left, odd step right). */
  staggerAlternate?: boolean;
}

export interface StackLayout {
  id: StackLayoutId;
  name: string;
  hint: string;
  spec: StackLayoutSpec;
}

export const STACK_LAYOUTS: StackLayout[] = [
  {
    id: "center-stack",
    name: "Center Stack",
    hint: "Lines stacked and centered — the classic full-frame hook.",
    spec: {
      blockAlignmentX: "center",
      anchorY: "center",
      marginYFrac: 0.5,
      leftMarginFrac: 0,
      staggerOffsetXFrac: 0,
      rotate: "none",
      lineSpacingFrac: 1.22,
    },
  },
  {
    id: "top-banner",
    name: "Top Banner",
    hint: "Centered block near the top of the frame (positionY-style).",
    spec: {
      blockAlignmentX: "center",
      anchorY: "top",
      // 0.083 × 1080 = ~90 px — the stock headline top margin.
      marginYFrac: 0.083,
      leftMarginFrac: 0,
      staggerOffsetXFrac: 0,
      rotate: "none",
      lineSpacingFrac: 1.22,
    },
  },
  {
    id: "bottom-center",
    name: "Bottom Center",
    hint: "Centered block near the bottom, clear of the caption zone.",
    spec: {
      blockAlignmentX: "center",
      anchorY: "bottom",
      // 0.22 × 1080 = ~238 px clearance from the bottom edge — sits above
      // the bottom-anchored captions.
      marginYFrac: 0.22,
      leftMarginFrac: 0,
      staggerOffsetXFrac: 0,
      rotate: "none",
      lineSpacingFrac: 1.22,
    },
  },
  {
    id: "left-stack",
    name: "Left Stack",
    hint: "Left-flush lines with a fixed margin — editorial lower-third feel.",
    spec: {
      blockAlignmentX: "left",
      anchorY: "center",
      marginYFrac: 0.5,
      // 0.06 × 1920 = ~115 px at 1080p.
      leftMarginFrac: 0.06,
      staggerOffsetXFrac: 0,
      rotate: "none",
      lineSpacingFrac: 1.22,
    },
  },
  {
    id: "stagger-offset",
    name: "Stagger Offset",
    hint: "Each line steps sideways, alternating direction — diagonal cascade.",
    spec: {
      blockAlignmentX: "center",
      anchorY: "center",
      marginYFrac: 0.5,
      leftMarginFrac: 0,
      // line i lands at x + sign(i) × i × 0.04 × canvasW (see
      // stackLayoutLineOffsetX). Long stacks approach the frame edge —
      // keep the preset's maxWidth wrap in mind.
      staggerOffsetXFrac: 0.04,
      staggerAlternate: true,
      rotate: "none",
      lineSpacingFrac: 1.22,
    },
  },
  {
    id: "middle-band",
    name: "Middle Band",
    hint: "One line at a time, rotating through the text in equal time slices.",
    spec: {
      blockAlignmentX: "center",
      anchorY: "center",
      marginYFrac: 0.5,
      leftMarginFrac: 0,
      staggerOffsetXFrac: 0,
      rotate: "middle-band",
      lineSpacingFrac: 1.22,
    },
  },
];

/** Look up a layout by id; unknown ids fall back to center-stack. */
export function getStackLayout(id: string): StackLayout {
  return STACK_LAYOUTS.find((l) => l.id === id) ?? STACK_LAYOUTS[0];
}

/**
 * Per-line horizontal cascade offset (px) for a layout.
 * staggerOffsetXFrac = 0 → always 0. With staggerAlternate, line i's offset
 * direction alternates: even lines step LEFT, odd lines step RIGHT
 * (magnitude i × staggerOffsetXFrac × canvasW); without it the cascade steps
 * monotonically right. Canvas painter + ASS emitter both call this so the
 * diagonal cascade can never drift between preview and export.
 */
export function stackLayoutLineOffsetX(
  layout: StackLayout,
  lineIndex: number,
  canvasW: number,
): number {
  const frac = layout.spec.staggerOffsetXFrac;
  if (!frac || lineIndex <= 0) return 0;
  const sign = layout.spec.staggerAlternate ? (lineIndex % 2 === 0 ? -1 : 1) : 1;
  return sign * lineIndex * frac * canvasW;
}

// ---------------------------------------------------------------------------
// STYLES — kinetic per-word / per-line choreography
// ---------------------------------------------------------------------------

export type StackStyleId =
  | "word-pop"
  | "typewriter"
  | "blur-rise"
  | "line-slide"
  | "mask-wipe"
  | "scale-bounce"
  | "karaoke-fill"
  | "spin-in";

/** One endpoint (from/to) of a style's transform interpolation. */
export interface StackStyleEndpoint {
  /** Alpha 0..1 (1 = opaque). */
  alpha: number;
  /** Scale multiplier (1 = identity). */
  scale: number;
  /** Vertical offset as a fraction of canvas HEIGHT (positive = down). */
  offsetYFrac: number;
  /**
   * Horizontal offset as a fraction of canvas WIDTH, applied per unit.
   * With alternatingX the SIGN alternates by unit index (even = from the
   * left, odd = from the right) — see line-slide.
   */
  offsetXPerUnitFrac: number;
  /** Gaussian blur radius, 1080p-referenced px (canvas: ×canvasH/1080; ASS: \blur). */
  blurPx: number;
  /** Rotation in DEGREES (canvas painter converts to radians; ASS: \frz). */
  rotateDeg: number;
}

export interface StackStyleSpec {
  /** What the animation staggers on: individual words or whole lines. */
  unit: "word" | "line";
  /** Delay between consecutive units (ms). */
  staggerMs: number;
  /** Per-unit entrance length (ms). */
  durationMs: number;
  /** Ease curve used by the CANVAS path (ASS \t/\move are linear). */
  ease: "easeOutCubic" | "easeOutBack" | "easeOutQuart" | "linear";
  /** Initial state of each unit. */
  from: StackStyleEndpoint;
  /** Final state of each unit (normally identity + alpha 1). */
  to: StackStyleEndpoint;
  /** Units revealed by a clip rect sweeping left→right (typewriter / mask-wipe). */
  wipeReveal?: boolean;
  /** Karaoke fill: each unit sweeps with the accent color over its window. */
  fillSweep?: boolean;
  /** true = from.offsetXPerUnitFrac alternates sign by unit index (line-slide). */
  alternatingX?: boolean;
  /** Alpha ramps linearly over this fraction of durationMs (both engines). Default 1. */
  alphaRampFrac?: number;
  /** Blank beat before unit 0 starts (typewriter's initial typing delay). Default 0. */
  leadInMs?: number;
  /** ASS two-phase pop overshoot target (fscx/fscy percent, e.g. 110). */
  overshootPct?: number;
  /** Minimum per-word fill window for karaoke-fill (ms). */
  minFillMs?: number;
}

export interface StackStyle {
  id: StackStyleId;
  name: string;
  hint: string;
  kind: "kinetic";
  spec: StackStyleSpec;
}

const IDENTITY_ENDPOINT: StackStyleEndpoint = {
  alpha: 1,
  scale: 1,
  offsetYFrac: 0,
  offsetXPerUnitFrac: 0,
  blurPx: 0,
  rotateDeg: 0,
};

export const STACK_STYLES: StackStyle[] = [
  {
    id: "word-pop",
    name: "Word Pop",
    hint: "Words burst in one by one with a springy overshoot.",
    kind: "kinetic",
    spec: {
      unit: "word",
      staggerMs: 90,
      durationMs: 240,
      ease: "easeOutBack",
      alphaRampFrac: 0.5,
      overshootPct: 110,
      from: { alpha: 0, scale: 0.4, offsetYFrac: 0, offsetXPerUnitFrac: 0, blurPx: 0, rotateDeg: 0 },
      to: { ...IDENTITY_ENDPOINT },
    },
  },
  {
    id: "typewriter",
    name: "Typewriter",
    hint: "Words snap on one at a time, like being typed live.",
    kind: "kinetic",
    spec: {
      unit: "word",
      staggerMs: 160,
      durationMs: 1,
      ease: "linear",
      leadInMs: 160,
      wipeReveal: true,
      from: { ...IDENTITY_ENDPOINT, alpha: 0 },
      to: { ...IDENTITY_ENDPOINT },
    },
  },
  {
    id: "blur-rise",
    name: "Blur Rise",
    hint: "Lines drift up out of a soft blur, one after another.",
    kind: "kinetic",
    spec: {
      unit: "line",
      staggerMs: 140,
      durationMs: 320,
      ease: "easeOutCubic",
      from: { alpha: 0, scale: 1, offsetYFrac: 0.045, offsetXPerUnitFrac: 0, blurPx: 10, rotateDeg: 0 },
      to: { ...IDENTITY_ENDPOINT },
    },
  },
  {
    id: "line-slide",
    name: "Line Slide",
    hint: "Lines slide in from alternating sides and settle.",
    kind: "kinetic",
    spec: {
      unit: "line",
      staggerMs: 150,
      durationMs: 300,
      ease: "easeOutCubic",
      alternatingX: true,
      // Even lines start 18% of the frame to the LEFT, odd lines 18% RIGHT.
      from: { alpha: 0, scale: 1, offsetYFrac: 0, offsetXPerUnitFrac: 0.18, blurPx: 0, rotateDeg: 0 },
      to: { ...IDENTITY_ENDPOINT },
    },
  },
  {
    id: "mask-wipe",
    name: "Mask Wipe",
    hint: "A clip bar sweeps left-to-right revealing each line.",
    kind: "kinetic",
    spec: {
      unit: "line",
      staggerMs: 200,
      durationMs: 340,
      ease: "linear",
      wipeReveal: true,
      // Alpha stays 1: the zero-width clip does the hiding before reveal.
      from: { ...IDENTITY_ENDPOINT },
      to: { ...IDENTITY_ENDPOINT },
    },
  },
  {
    id: "scale-bounce",
    name: "Scale Bounce",
    hint: "Lines land oversized, compress, and spring back.",
    kind: "kinetic",
    spec: {
      unit: "line",
      staggerMs: 120,
      durationMs: 300,
      ease: "easeOutBack",
      alphaRampFrac: 0.5,
      from: { alpha: 0, scale: 1.7, offsetYFrac: 0, offsetXPerUnitFrac: 0, blurPx: 0, rotateDeg: 2 },
      to: { ...IDENTITY_ENDPOINT },
    },
  },
  {
    id: "karaoke-fill",
    name: "Karaoke Fill",
    hint: "Words fill with the accent color as the hook plays.",
    kind: "kinetic",
    spec: {
      unit: "word",
      staggerMs: 0,
      // durationMs = the block entrance fade; the fill sweep after it runs
      // across the remaining item duration (see stackUnitTransforms).
      durationMs: 120,
      ease: "linear",
      fillSweep: true,
      minFillMs: 300,
      from: { ...IDENTITY_ENDPOINT, alpha: 0 },
      to: { ...IDENTITY_ENDPOINT },
    },
  },
  {
    id: "spin-in",
    name: "Spin In",
    hint: "Lines rotate in from a tilt and straighten out.",
    kind: "kinetic",
    spec: {
      unit: "line",
      staggerMs: 130,
      durationMs: 320,
      ease: "easeOutCubic",
      from: { alpha: 0, scale: 0.7, offsetYFrac: 0, offsetXPerUnitFrac: 0, blurPx: 0, rotateDeg: -8 },
      to: { ...IDENTITY_ENDPOINT },
    },
  },
];

/** Look up a style by id; unknown ids fall back to word-pop. */
export function getStackStyle(id: string): StackStyle {
  return STACK_STYLES.find((s) => s.id === id) ?? STACK_STYLES[0];
}

/** true when `s` is one of the 8 kinetic StackStyleIds (vs the legacy simple entrances). */
export function isKineticStyle(s: string): boolean {
  return STACK_STYLES.some((st) => st.id === s);
}

// ---------------------------------------------------------------------------
// LEGACY SIMPLE ENTRANCES — the 4 block-level animations that stay in the
// existing pipeline (headlineTransform in native.ts + headlineAnimTags in
// electron/main.js). Exposed here so the picker UI can offer them alongside
// the kinetic styles under one vocabulary.
// ---------------------------------------------------------------------------

export type SimpleStackStyleId = "fade" | "slide-up" | "pop" | "zoom-punch";

export const SIMPLE_STYLES: {
  id: SimpleStackStyleId;
  name: string;
  hint: string;
}[] = [
  { id: "fade", name: "Simple Fade", hint: "The whole block fades in and out (300 ms)." },
  { id: "slide-up", name: "Simple Slide-Up", hint: "The whole block rises 34 px and fades in." },
  { id: "pop", name: "Simple Pop", hint: "The whole block pops from 60% scale with an overshoot." },
  { id: "zoom-punch", name: "Simple Zoom Punch", hint: "The whole block slams in from 200% scale." },
];

// ---------------------------------------------------------------------------
// STYLE + LAYOUT DEFAULTS on HeadlineItem
// ---------------------------------------------------------------------------

export const STACK_TEXT_DEFAULTS: {
  layout: StackLayoutId;
  style: StackStyleId;
} = {
  layout: "center-stack",
  style: "word-pop",
};

/** A user's layout + style selection (style may be a legacy simple entrance). */
export interface StackStyleChoice {
  layout: StackLayoutId;
  style: StackStyleId | SimpleStackStyleId;
}

// ---------------------------------------------------------------------------
// RUNTIME MATH — the canvas engine calls these every frame
// ---------------------------------------------------------------------------

/**
 * One addressable unit of the stacked text, as laid out by the painter.
 * Word-unit styles produce one StackUnit per WORD (index = GLOBAL word index
 * across all lines, line = parent line index); line-unit styles produce one
 * per LINE (index = line index, width = measured line width). x/y are the
 * unit's final resting position (before any style transform), in whatever
 * scale the painter measures (preview canvas / export PlayRes).
 */
export interface StackUnit {
  text: string;
  x: number;
  y: number;
  width: number;
  line: number;
  index: number;
}

/** Universal block fade-out tail (ms) — the caller applies it to the whole block. */
export const STACK_FADE_OUT_MS = 300;

/**
 * Per-unit visual state at a moment in time. All offsets are in CANVAS px
 * (frac → px conversion done against the canvasH/canvasW you pass in).
 * `rotate` is in DEGREES (the painter converts to radians).
 */
export interface StackUnitTransform {
  alpha: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  blur: number;
  /** Degrees. */
  rotate: number;
  /** false before the unit's start time (painter: skip entirely). */
  visible: boolean;
  /** 0..1 karaoke-fill progress of this word (accent-color sweep). */
  fillProgress: number;
  /**
   * 0..1 clip-from-left fraction for wipeReveal styles (typewriter /
   * mask-wipe): the painter draws the unit clipped to [x, x + reveal×width].
   * 1 for non-wipe styles (fully revealed).
   */
  reveal: number;
}

export interface StackUnitTransformsOpts {
  style: StackStyleId;
  /** Item window on the master timeline. */
  startMs: number;
  endMs: number;
  currentMs: number;
  /** Total units (words for unit:"word" styles, lines for unit:"line"). */
  unitCount: number;
  /** Canvas height in px — frac→px conversion for vertical offsets. */
  canvasH: number;
  /**
   * Canvas width in px (line-slide's X offsets). Defaults to a 16:9 frame
   * derived from canvasH; pass the real width whenever you have it.
   */
  canvasW?: number;
  /**
   * Relative unit weights for karaoke-fill (word char counts or measured
   * widths). Default: equal weights. The ASS side uses the same weights via
   * stackAssWordTimingCs so preview and export agree.
   */
  unitWeights?: number[];
}

// Easing — internal consts (easeOutQuart is referenced by the resolver so
// every curve in the spec vocabulary is live).
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4);
const easeOutBack = (t: number) => {
  const c1 = 1.70158; // same c1 as captionAnimations / headlineTransform
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
const linear = (t: number) => t;

function resolveEase(ease: StackStyleSpec["ease"]): (t: number) => number {
  switch (ease) {
    case "easeOutCubic":
      return easeOutCubic;
    case "easeOutBack":
      return easeOutBack;
    case "easeOutQuart":
      return easeOutQuart;
    case "linear":
    default:
      return linear;
  }
}

// easeOutBack overshoot facts (used ONLY by the ASS approximation of
// back-eased styles — the canvas path uses the real curve):
// peak overshoot value ≈ 1.10 at t ≈ 0.58 (derived from c1 = 1.70158).
const EASE_OUT_BACK_OVERSHOOT = 1.1;
const EASE_OUT_BACK_PEAK_FRAC = 0.58;

const clamp01 = (v: number) => (v >= 1 ? 1 : v <= 0 ? 0 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function hiddenUnitState(wipe: boolean): StackUnitTransform {
  return {
    alpha: 0,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    blur: 0,
    rotate: 0,
    visible: false,
    fillProgress: 0,
    reveal: wipe ? 0 : 1,
  };
}

/** Normalize optional weights to a per-unit weight array (default: equal). */
function normalizeWeights(weights: number[] | undefined, count: number): number[] {
  if (weights && weights.length > 0) {
    const out = weights.slice(0, count);
    while (out.length < count) out.push(0);
    return out.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  }
  return new Array(count).fill(1);
}

/**
 * Sequential fill windows for karaoke-fill, relative to the SWEEP start
 * (= the entrance's end): word i fills during [start_i, start_i + dur_i].
 * Each dur is max(minFillMs, share) where share = window × weight/total;
 * when the floored windows do not fit the available window the floor is
 * dropped (proportional shares) so the whole sweep completes inside the item.
 */
function fillWindows(
  windowMs: number,
  weights: number[],
  minFillMs: number,
): Array<{ start: number; dur: number }> {
  const total = weights.reduce((a, b) => a + b, 0);
  const shares =
    total > 0
      ? weights.map((w) => (windowMs * w) / total)
      : weights.map(() => windowMs / Math.max(1, weights.length));
  let durs = shares.map((s) => Math.max(minFillMs, s));
  const sum = durs.reduce((a, b) => a + b, 0);
  if (sum > windowMs) durs = shares;
  let acc = 0;
  return durs.map((d) => {
    const w = { start: acc, dur: d };
    acc += d;
    return w;
  });
}

/**
 * Per-unit transform state for one stack-text item at currentMs.
 *
 * Timing model (shared with the ASS path): unit i starts at
 * leadInMs + i × staggerMs after startMs and animates for durationMs.
 * Alpha ramps LINEARLY over alphaRampFrac × durationMs (matching the ASS
 * \t alpha windows). Wipe styles gate visibility + reveal per unit;
 * karaoke-fill returns fillProgress per word.
 *
 * NOTE: the caller still applies the STACK_FADE_OUT_MS block tail (and any
 * preset-level block entrance for the legacy simple styles) on top.
 */
export function stackUnitTransforms(opts: StackUnitTransformsOpts): StackUnitTransform[] {
  const { style, startMs, endMs, currentMs, unitCount } = opts;
  const spec = getStackStyle(style).spec;
  const canvasH = opts.canvasH;
  const canvasW = opts.canvasW ?? Math.round(canvasH * (16 / 9));
  const count = Math.max(0, Math.floor(unitCount));
  const wipe = !!spec.wipeReveal;

  const itemActive = currentMs >= startMs && currentMs < endMs;
  if (count === 0 || !itemActive) {
    return new Array(count).fill(null).map(() => hiddenUnitState(wipe));
  }

  const rel = currentMs - startMs;

  // ── karaoke-fill: block entrance fade + sequential accent sweep ──
  if (spec.fillSweep) {
    const entranceMs = Math.max(1, spec.durationMs);
    const entranceAlpha = clamp01(rel / entranceMs);
    const windowMs = Math.max(0, endMs - startMs - entranceMs);
    const weights = normalizeWeights(opts.unitWeights, count);
    const windows = fillWindows(windowMs, weights, spec.minFillMs ?? 0);
    return windows.map((w) => {
      // Windows are relative to the sweep start (= entrance end); rel is
      // relative to the item start — offset by the entrance.
      const sweepRel = rel - entranceMs;
      const fp =
        w.dur > 0
          ? clamp01((sweepRel - w.start) / w.dur)
          : sweepRel >= w.start
            ? 1
            : 0;
      return {
        alpha: entranceAlpha,
        scale: 1,
        offsetX: 0,
        offsetY: 0,
        blur: 0,
        rotate: 0,
        visible: true,
        fillProgress: fp,
        reveal: 1,
      };
    });
  }

  // ── generic entrance interpolation (all styles except karaoke-fill) ──
  const easeFn = resolveEase(spec.ease);
  const durMs = Math.max(1, spec.durationMs);
  const alphaRampMs = Math.max(1, Math.round(durMs * (spec.alphaRampFrac ?? 1)));
  const leadIn = spec.leadInMs ?? 0;

  const out: StackUnitTransform[] = [];
  for (let i = 0; i < count; i++) {
    const unitStart = leadIn + i * spec.staggerMs;
    const since = rel - unitStart;
    const visible = since >= 0;
    const t = clamp01(since / durMs);
    const e = easeFn(t);
    const tAlpha = clamp01(since / alphaRampMs);

    // from-X sign: alternating styles flip per unit (even = from the left).
    const xSign = spec.alternatingX ? (i % 2 === 0 ? -1 : 1) : 1;
    const fromXpx = spec.from.offsetXPerUnitFrac * xSign * canvasW;
    const toXpx = spec.to.offsetXPerUnitFrac * canvasW;

    out.push({
      alpha: lerp(spec.from.alpha, spec.to.alpha, tAlpha), // linear both sides
      scale: Math.max(0.01, lerp(spec.from.scale, spec.to.scale, e)),
      offsetX: lerp(fromXpx, toXpx, e),
      offsetY: lerp(spec.from.offsetYFrac * canvasH, spec.to.offsetYFrac * canvasH, e),
      blur: Math.max(0, lerp(spec.from.blurPx, spec.to.blurPx, e)),
      rotate: lerp(spec.from.rotateDeg, spec.to.rotateDeg, e),
      visible,
      fillProgress: 0,
      reveal: wipe ? e : 1,
    });
  }
  return out;
}

/**
 * "middle-band" layout timing: which line is on screen at currentMs.
 * Line i owns the equal time slice [start + i×slice, start + (i+1)×slice)
 * where slice = (endMs − startMs) / lineCount. Returns -1 when the item is
 * inactive or lineCount ≤ 0.
 *
 * COMPOSITION with a kinetic style: re-invoke stackUnitTransforms per slice
 * with startMs = this slice's start, endMs = this slice's end, and the
 * ACTIVE line's unit count — the entrant line then plays the style's
 * entrance at its slice start (the natural "rotating one-liner" feel).
 */
export function middleBandActiveLine(
  startMs: number,
  endMs: number,
  currentMs: number,
  lineCount: number,
): number {
  if (lineCount <= 0) return -1;
  if (currentMs < startMs || currentMs >= endMs) return -1;
  const durMs = endMs - startMs;
  if (durMs <= 0) return 0;
  const slice = durMs / lineCount;
  if (slice <= 0) return 0;
  const idx = Math.floor((currentMs - startMs) / slice);
  return Math.min(lineCount - 1, Math.max(0, idx));
}

// ---------------------------------------------------------------------------
// ASS EMISSION — the main-process twin consumes these
// (mirror-portable: no imports, plain string building, all numbers from the
//  specs above — a plain-JS copy in electron/main.js stays in lock-step)
// ---------------------------------------------------------------------------

/**
 * Extra geometry for complete tag emission. All fields optional — without
 * them the helper returns the timing core and the caller interpolates the
 * geometry itself (exact recipe per style in STACK_STYLE_ASS_DOC).
 */
export interface StackAssUnitHints {
  /** Index of this unit within the block — alternating-X styles (line-slide). */
  unitIndex?: number;
  /** PlayRes height (px) — enables the relative \move for blur-rise + blur scaling. */
  canvasH?: number;
  /** PlayRes width (px) — enables the relative \move for line-slide. */
  canvasW?: number;
  /** Measured line rect at PlayRes scale — required for mask-wipe's animated \clip. */
  rect?: { x1: number; y1: number; x2: number; y2: number };
}

/**
 * Inline ASS tag block for ONE unit of a stack style.
 *
 * `unitDelayMs` is the unit's start offset from the Dialogue's start time
 * (= leadInMs + i × staggerMs for unit i of an item that starts the
 * Dialogue). Times are emitted literally (placeholder-free). `spec`
 * defaults to getStackStyle(style).
 *
 * WHAT THE CALLER MUST SUPPLY (per style — full recipes in
 * STACK_STYLE_ASS_DOC):
 *   - word-pop / typewriter / karaoke-fill (unit:"word"): ONE Dialogue for
 *     the whole block. Call with d = i × stagger (global word index across
 *     lines, words joined with spaces, lines separated with \N). The caller
 *     adds the line-level out-tail \fad(0,300) ONCE (word-pop: prefix the
 *     text; typewriter/karaoke-fill: already inside the returned prefix).
 *   - blur-rise / line-slide / mask-wipe / scale-bounce / spin-in
 *     (unit:"line"): ONE Dialogue PER LINE, each spanning the item's full
 *     window, with the line's own \pos/anchor geometry. Pass hints
 *     (canvasH / canvasW+unitIndex / rect) and the \move or \clip geometry
 *     is emitted for you; otherwise add it yourself:
 *       blur-rise  → prepend \move(0,round(0.045×H),0,0,d,d+320) [relative]
 *       line-slide → prepend \move(±round(0.18×W),0,0,0,d,d+300)
 *         (even lines −, odd +)
 *       mask-wipe  → prepend \clip(x1,y1,x1,y2)\t(d,d+340,\clip(x1,y1,x2,y2))
 *         where (x1,y1,x2,y2) is the line's measured rect (the sweep
 *         animates the RIGHT edge from x1 → x2).
 *     The returned tags for these styles already carry \fad(0,300).
 */
export function stackAssTagsForUnit(
  style: StackStyleId,
  unitDelayMs: number,
  spec?: StackStyle,
  hints?: StackAssUnitHints,
): string {
  const st = spec ?? getStackStyle(style);
  const s = st.spec;
  const d = Math.max(0, Math.round(unitDelayMs));
  const dur = Math.max(1, Math.round(s.durationMs));
  const alphaDur = Math.max(1, Math.round(dur * (s.alphaRampFrac ?? 1)));

  switch (style) {
    case "word-pop": {
      // Two-phase pop: scale 40 → 110 (overshoot) → settle 100, alpha over
      // the first alphaRampFrac of the window. Karaoke-safe tags only.
      const fromPct = Math.max(1, Math.round(s.from.scale * 100));
      const toPct = Math.max(1, Math.round(s.to.scale * 100));
      const overPct = Math.max(1, Math.round(s.overshootPct ?? toPct));
      return (
        `{\\alpha&HFF&\\fscx${fromPct}\\fscy${fromPct}` +
        `\\t(${d},${d + alphaDur},\\alpha&H00&)` +
        `\\t(${d},${d + dur},\\fscx${overPct}\\fscy${overPct})` +
        `\\t(${d + alphaDur},${d + dur},\\fscx${toPct}\\fscy${toPct})}`
      );
    }

    case "typewriter":
      // Line prefix (call ONCE with d = 0): transparent SecondaryColour so
      // unrevealed words are invisible; the per-word {\k<cs>} sequence from
      // stackAssWordTimingCs reveals them. Out-tail included.
      return `{\\2a&HFF&\\fad(0,${STACK_FADE_OUT_MS})}`;

    case "blur-rise": {
      // Per-line Dialogue. Relative \move (0,dy → 0,0) when canvasH is
      // known; dy = round(from.offsetYFrac × H). Blur scales by H/1080
      // (PlayRes-referenced). Alpha+blur tween over the same window.
      const hScale = hints?.canvasH != null ? hints.canvasH / 1080 : 1;
      const blurFrom = Math.max(0, Math.round(s.from.blurPx * hScale));
      const blurTo = Math.max(0, Math.round(s.to.blurPx * hScale));
      const move =
        hints?.canvasH != null
          ? `\\move(0,${Math.round(s.from.offsetYFrac * hints.canvasH)},0,0,${d},${d + dur})`
          : "";
      return (
        `{\\blur${blurFrom}\\alpha&HFF&${move}` +
        `\\t(${d},${d + dur},\\alpha&H00&\\blur${blurTo})\\fad(0,${STACK_FADE_OUT_MS})`
      );
    }

    case "line-slide": {
      // Per-line Dialogue. Relative \move from ±offsetXPerUnitFrac × W when
      // canvasW + unitIndex are known (even units slide from the LEFT).
      let move = "";
      if (hints?.canvasW != null) {
        const idx = hints.unitIndex ?? 0;
        const sign = s.alternatingX ? (idx % 2 === 0 ? -1 : 1) : 1;
        const sx = Math.round(s.from.offsetXPerUnitFrac * sign * hints.canvasW);
        move = `\\move(${sx},0,0,0,${d},${d + dur})`;
      }
      return `{\\alpha&HFF&${move}\\t(${d},${d + dur},\\alpha&H00&)\\fad(0,${STACK_FADE_OUT_MS})}`;
    }

    case "mask-wipe": {
      // Per-line Dialogue. The clip rect's RIGHT edge sweeps x1 → x2
      // (zero-width → full line width). rect = the line's measured PlayRes
      // rect; without it the caller adds the \clip pair itself.
      let clip = "";
      const r = hints?.rect;
      if (r) {
        const x1 = Math.round(r.x1);
        const y1 = Math.round(r.y1);
        const y2 = Math.round(r.y2);
        const x2 = Math.round(r.x2);
        clip =
          `\\clip(${x1},${y1},${x1},${y2})` +
          `\\t(${d},${d + dur},\\clip(${x1},${y1},${x2},${y2}))`;
      }
      return `{${clip}\\fad(0,${STACK_FADE_OUT_MS})}`;
    }

    case "scale-bounce": {
      // Per-line Dialogue. Two-phase scale approximation of easeOutBack:
      // from% → undershoot% at t≈0.58 → 100%; rotation tweens over the full
      // window; alpha over the first alphaRampFrac.
      const fromPct = Math.max(1, Math.round(s.from.scale * 100));
      const toPct = Math.max(1, Math.round(s.to.scale * 100));
      const midPct = Math.max(
        1,
        Math.round((s.from.scale + (s.to.scale - s.from.scale) * EASE_OUT_BACK_OVERSHOOT) * 100),
      );
      const peakAt = Math.max(1, Math.round(dur * EASE_OUT_BACK_PEAK_FRAC));
      const fromRot = Math.round(s.from.rotateDeg);
      const toRot = Math.round(s.to.rotateDeg);
      return (
        `{\\alpha&HFF&\\fscx${fromPct}\\fscy${fromPct}\\frz${fromRot}` +
        `\\t(${d},${d + alphaDur},\\alpha&H00&)` +
        `\\t(${d},${d + dur},\\frz${toRot})` +
        `\\t(${d},${d + peakAt},\\fscx${midPct}\\fscy${midPct})` +
        `\\t(${d + peakAt},${d + dur},\\fscx${toPct}\\fscy${toPct})` +
        `\\fad(0,${STACK_FADE_OUT_MS})}`
      );
    }

    case "karaoke-fill": {
      // Line prefix (call ONCE with d = 0): the 120 ms block entrance fade
      // + out-tail. The {\k12} delays the \kf sweep start until the entrance
      // completes (round(durationMs/10) centiseconds).
      const leadKf = Math.max(1, Math.round(dur / 10));
      return (
        `{\\alpha&HFF&\\t(${d},${d + dur},\\alpha&H00&)\\fad(0,${STACK_FADE_OUT_MS})}` +
        `{\\k${leadKf}}`
      );
    }

    case "spin-in": {
      // Per-line Dialogue: single linear \t carrying alpha + scale + rotation.
      const fromPct = Math.max(1, Math.round(s.from.scale * 100));
      const toPct = Math.max(1, Math.round(s.to.scale * 100));
      const fromRot = Math.round(s.from.rotateDeg);
      const toRot = Math.round(s.to.rotateDeg);
      return (
        `{\\alpha&HFF&\\fscx${fromPct}\\fscy${fromPct}\\frz${fromRot}` +
        `\\t(${d},${d + dur},\\alpha&H00&\\fscx${toPct}\\fscy${toPct}\\frz${toRot})` +
        `\\fad(0,${STACK_FADE_OUT_MS})}`
      );
    }
  }
}

/**
 * Per-word \k / \kf centisecond values for the karaoke-timing styles.
 *
 *  - typewriter: entry i = the {\k} that PRECEDES word i (word i appears
 *    once entries 0..i have elapsed). All entries = round(staggerMs/10);
 *    the FIRST entry is the initial beat (matching spec.leadInMs) — the
 *    canvas path reveals word i at leadInMs + i×staggerMs, so parity is
 *    exact when you pass the spec's staggerMs (160).
 *  - karaoke-fill: `staggerMs` is REPURPOSED as the TOTAL sweep window (ms)
 *    = item duration − entrance (120). Entry i = round(fillDur_i/10) where
 *    fillDur_i = max(300, share_i) (share ∝ word length), dropping the
 *    300 ms floor when the floored windows do not fit the window.
 *    Emit as {\kf<cs>} per word AFTER the line prefix (which carries the
 *    {\k12} entrance gap).
 *  - other styles: [] (no karaoke timing).
 *
 * IMPORTANT \k semantics (libass): the durations ACCUMULATE from the
 * Dialogue's start; a word is SecondaryColour (unswept) until its window
 * opens. typewriter hides unswept words via the {\2a&HFF&} prefix;
 * karaoke-fill SHOWS them in the base color (Secondary) and sweeps the
 * accent (Primary) with \kf.
 */
export function stackAssWordTimingCs(
  style: StackStyleId,
  text: string,
  staggerMs: number,
): number[] {
  const words = String(text ?? "")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return [];

  if (style === "typewriter") {
    const cs = Math.max(0, Math.round(staggerMs / 10));
    return words.map(() => cs);
  }

  if (style === "karaoke-fill") {
    const st = getStackStyle("karaoke-fill");
    const minFillMs = st.spec.minFillMs ?? 0;
    const windowMs = Math.max(0, staggerMs);
    const weights = words.map((w) => Math.max(1, w.length));
    const total = weights.reduce((a, b) => a + b, 0);
    const shares = weights.map((w) => (windowMs * w) / total);
    let durs = shares.map((s) => Math.max(minFillMs, s));
    const sum = durs.reduce((a, b) => a + b, 0);
    if (sum > windowMs) durs = shares; // floor doesn't fit: stay proportional
    return durs.map((d) => Math.max(1, Math.round(d / 10)));
  }

  return [];
}

/**
 * One-line-per-style ASS construction notes for the main-process dev.
 * (LAYOUT notes: STACK_LAYOUT_ASS_DOC.)
 */
export const STACK_STYLE_ASS_DOC: Record<StackStyleId, string> = {
  "word-pop":
    'ONE Dialogue for the whole block (words joined with spaces, lines with \\N). Per word i (GLOBAL index across all lines): stackAssTagsForUnit("word-pop", i*90) immediately before the word. Prefix the text ONCE with {\\fad(0,300)} for the out-tail. Tags are karaoke-safe (\\t/\\alpha/\\fscx/\\fscy) — safe even inside \\k lines.',
  typewriter:
    'ONE Dialogue. Line prefix = stackAssTagsForUnit("typewriter", 0) → {\\2a&HFF&\\fad(0,300)} (transparent Secondary). Then per word: {\\k<cs>} + the word, cs from stackAssWordTimingCs("typewriter", text, 160) — all entries 16; word i appears at (i+1)*160 ms (the canvas path reveals word i at leadInMs + i*staggerMs = 160 + i*160 — exact parity).',
  "blur-rise":
    'ONE Dialogue PER LINE (line i spans the item window; d = i*140). Full tag with hints.canvasH: {\\blur10\\alpha&HFF&\\move(0,DY,0,0,d,d+320)\\t(d,d+320,\\alpha&H00&\\blur0)\\fad(0,300)} — DY = round(0.045*H), blur = round(10*H/1080). Without hints the helper omits the (relative) \\move — prepend \\move(0,DY,0,0,d,d+320) yourself. Anchor each line with \\an5 + \\pos (no measurement needed).',
  "line-slide":
    'ONE Dialogue PER LINE (d = i*150). Pass hints {unitIndex, canvasW} → {\\alpha&HFF&\\move(SX,0,0,0,d,d+300)\\t(d,d+300,\\alpha&H00&)\\fad(0,300)} with SX = ±round(0.18*W) (even lines −, odd +). Without hints prepend the \\move yourself. \\an5 + \\pos anchoring.',
  "mask-wipe":
    'ONE Dialogue PER LINE (d = i*200). Pass hints {rect} (the line\'s measured PlayRes rect x1,y1,x2,y2) → {\\clip(x1,y1,x1,y2)\\t(d,d+340,\\clip(x1,y1,x2,y2))\\fad(0,300)} — the clip RIGHT edge sweeps x1→x2 (zero-width start = hidden; canvas parity: reveal = clip fraction). \\t animates \\clip rects natively. Estimate the rect in main via W ≈ 0.6 × fontPx × charCount for a centered line, or measure in the renderer and pass it through the export payload.',
  "scale-bounce":
    'ONE Dialogue PER LINE (d = i*120): {\\alpha&HFF&\\fscx170\\fscy170\\frz2\\t(d,d+150,\\alpha&H00&)\\t(d,d+300,\\frz0)\\t(d,d+174,\\fscx93\\fscy93)\\t(d+174,d+300,\\fscx100\\fscy100)\\fad(0,300)} — two-phase easeOutBack approximation (undershoot 93% at t≈0.58); numbers all derived from the spec (emit via stackAssTagsForUnit("scale-bounce", d)).',
  "karaoke-fill":
    'ONE Dialogue. Line prefix = stackAssTagsForUnit("karaoke-fill", 0) → {\\alpha&HFF&\\t(0,120,\\alpha&H00&)\\fad(0,300)}{\\k12} (entrance fade + sweep gap). Then per word: {\\kf<cs>} + the word, cs from stackAssWordTimingCs("karaoke-fill", text, sweepWindowMs) where sweepWindowMs = itemDuration − 120. Set colors: Primary (\\1c) = accent, Secondary (\\2c) = base text color — inline in the prefix or on the Style line. \\kf sweeps Primary across each word; unswept words show Secondary.',
  "spin-in":
    'ONE Dialogue PER LINE (d = i*130): {\\alpha&HFF&\\fscx70\\fscy70\\frz-8\\t(d,d+320,\\alpha&H00&\\fscx100\\fscy100\\frz0)\\fad(0,300)} (emit via stackAssTagsForUnit("spin-in", d)). \\an5 + \\pos anchoring.',
};

/**
 * One-line-per-layout ASS construction notes (geometry + timing of WHO is
 * on screen). The line-level anchoring trick used by every kinetic layout:
 * alignment \\an5 (middle-center) + \\pos(x, y) per line — x = canvasW/2 +
 * stackLayoutLineOffsetX(layout, i, W) (centered layouts) or leftMargin +
 * offset (left-stack), y = blockAnchorY + (i − (lineCount−1)/2) ×
 * lineSpacingFrac × fontPx — all computable WITHOUT text measurement.
 */
export const STACK_LAYOUT_ASS_DOC: Record<StackLayoutId, string> = {
  "center-stack":
    "One Dialogue per unit (line-unit styles) anchored \\an5 + \\pos(W/2, H*0.5 + (i-(n-1)/2)*1.22*fontPx); word-unit styles: one Dialogue for the block, layout handled by the Style's Alignment+Margins (center/middle = 5).",
  "top-banner":
    "Same as center-stack but the block anchor sits at marginYFrac*H from the TOP: blockTop = 0.083*H, then y_i = blockTop + (i+0.5)*1.22*fontPx (\\an5 centers each line on its pos). Style path: Alignment 8 + MarginV = round(0.083*H).",
  "bottom-center":
    "Block BOTTOM at H − 0.22*H: blockBottom = 0.78*H, y_i = blockBottom − (n−i−0.5)*1.22*fontPx. Style path: Alignment 2 + MarginV = round(0.22*H).",
  "left-stack":
    "Left-flush: \\an4 (top-left anchor) or \\an5 with x_i = 0.06*W (all lines share it — text extends right). Style path: Alignment 1/4/7 + MarginL = round(0.06*W).",
  "stagger-offset":
    "Centered lines with the diagonal cascade: x_i = W/2 + stackLayoutLineOffsetX(layout, i, W) (line i at ±i*0.04*W, even left / odd right). \\an5 + \\pos per line.",
  "middle-band":
    "ONE line on screen at a time: line i's Dialogue spans [itemStart + i*slice, itemStart + (i+1)*slice) with slice = duration/lineCount (middleBandActiveLine is the canvas twin). Center it with \\an5 + \\pos(W/2, H*0.5); re-trigger the style's entrance per slice (stackUnitTransforms with the slice as the window).",
};
