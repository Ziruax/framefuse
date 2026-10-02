// src/lib/merger/kinetic/types.ts — Professional kinetic typography caption
// system (v1.18). Data model per the FINAL IMPLEMENTATION DIRECTIVE:
// composition + hierarchy + semantic emphasis + motion choreography, not
// "subtitles with animation added afterward".
//
// This file is the SHARED CONTRACT for:
//   - presets.ts / semantic.ts / classify.ts / engine.ts / motion.ts (renderer)
//   - render.ts (canvas painter + export geometry measurement)
//   - electron/kinetic-ass.js (plain-JS ASS mirror — keep in sync)
//
// Zero imports (pure TS, renderer-usable, mirror-portable to plain JS).

// ── Narrative classification (§15) ─────────────────────────────────────────

export type NarrativeLabel =
  | "NORMAL_NARRATION"
  | "SETUP"
  | "SUSPENSE"
  | "REVELATION"
  | "SHOCK"
  | "CONFLICT"
  | "ACCUSATION"
  | "REALIZATION"
  | "EMOTIONAL"
  | "REFLECTION"
  | "TRANSITION"
  | "CLIMAX";

export type KineticFamily =
  | "cinematic"
  | "dramatic"
  | "conflict"
  | "conversational"
  | "intensity";

/** Typography mode (§10–§13). */
export type KineticMode = "auto" | "single" | "manual" | "all";

/** Variation control (§14). Affects style-switch frequency + penalties. */
export type KineticVariation = "low" | "medium" | "high" | "extreme";

/** User intensity preference (§33). "auto" follows semantic scoring. */
export type KineticIntensityLevel = "auto" | "low" | "medium" | "high";

/** Word density target (§3): composition length. */
export type KineticDensity = "auto" | "short" | "medium" | "long";

/** Motion energy multiplier (§33). */
export type KineticMotionLevel = "subtle" | "balanced" | "dynamic" | "extreme";

/** Per-word hierarchy role (§5). */
export type KineticRole = "primary" | "secondary" | "supporting";

// ── User settings (persisted inside CaptionSettings.kinetic) ───────────────

export interface KineticManualWeight {
  presetId: string;
  /** 0-100 preference weight. 0 = disabled. */
  weight: number;
}

export interface KineticCaptionSettings {
  enabled: boolean;
  mode: KineticMode;
  /** single mode: the pinned preset. */
  presetId: string;
  /** manual mode: selected presets + weights. */
  manualMix: KineticManualWeight[];
  variation: KineticVariation;
  intensity: KineticIntensityLevel;
  density: KineticDensity;
  motion: KineticMotionLevel;
  /** Deterministic seed (§36) — same video + settings + seed = same output. */
  seed: number;
  /** Optional font override (wins over every preset's fontId). */
  fontOverride?: string | null;
  /** Optional accent color override (wins over every preset accent). */
  accentOverride?: string | null;
  /** Per-cue style locks (§35): cue startMs → presetId. */
  locks?: Record<number, string>;
}

export const KINETIC_DEFAULTS: KineticCaptionSettings = {
  enabled: false,
  mode: "auto",
  presetId: "editorial-stack",
  manualMix: [
    { presetId: "editorial-stack", weight: 20 },
    { presetId: "kinetic-sentence", weight: 20 },
    { presetId: "highlight-stack", weight: 20 },
    { presetId: "punch-stack", weight: 15 },
    { presetId: "progressive-stack", weight: 15 },
    { presetId: "split-stack", weight: 10 },
  ],
  variation: "high",
  intensity: "auto",
  density: "auto",
  motion: "dynamic",
  seed: 1337,
  fontOverride: null,
  accentOverride: null,
  locks: {},
};

// ── Preset spec (§7, §8) ───────────────────────────────────────────────────

/** How phrases are arranged + which phrase dominates (§5 hierarchy). */
export type HierarchyPattern =
  | "first-primary" //    phrase 0 dominant, rest supporting (Editorial)
  | "last-primary" //     final phrase dominant
  | "emphasis-primary" // phrase containing the emphasis word dominates
  | "uniform" //         equal scale; emphasis is inline (Mixed Weight)
  | "split-sides" //     phrases alternate left/right (Split Stack)
  | "diagonal" //        progressive indent + rotate (Diagonal Stack)
  | "depth" //           ascending scale front→back (Perspective)
  | "progressive" //     each phrase larger (Progressive / Build)
  | "impact" //          one huge phrase, others tiny (Impact / Full Screen)
  | "opposing" //        first top-left, last bottom-right (Opposing)
  | "center-band"; //    single readable band (Kinetic Sentence / Whisper)

export type EntranceType =
  | "fade-rise" //     alpha 0→1 + y offset up
  | "word-pop" //      scale 0.4→1 overshoot
  | "scale-slam" //    scale 2.4→1 + shake
  | "slide-x" //       x offset toward final (direction per phrase side)
  | "slide-y" //       y offset down/up
  | "clip-wipe" //     left→right clip reveal
  | "blur-focus" //    blur 10→0 + scale 1.12→1
  | "burst" //         words from radial directions
  | "converge" //      words toward common anchor
  | "push" //          new phrase pushes previous up
  | "flash" //         near-instant alpha + scale punch
  | "typewriter"; //    sequential per-word alpha

export type ExitType =
  | "fade"
  | "slide-down"
  | "scale-out"
  | "collapse"
  | "push-out";

export type HoldMotion =
  | "none"
  | "drift" //         slow upward drift while held
  | "pulse" //         emphasis word subtle pulse
  | "active-word" //    spoken word scale 1.06
  | "active-accent"; //  spoken word accent color

export interface KineticPresetSpec {
  id: string;
  name: string;
  family: KineticFamily;
  description: string;
  // Typography (§9)
  fontId: string;
  baseWeight: number;
  emphasisWeight: number;
  /** Base font size as a fraction of video height (1080p-referenced). */
  baseSizeFrac: number;
  /** Scale multiplier for the PRIMARY phrase. */
  emphasisScale: number;
  /** Scale multiplier for SUPPORTING phrases. */
  supportScale: number;
  lineHeightFrac: number;
  /** Letter spacing as fraction of fontPx (negative = tight). */
  trackingFrac: number;
  casing: "upper" | "none";
  serifAccent: boolean;
  // Layout / composition
  hierarchy: HierarchyPattern;
  anchorY: "top" | "center" | "bottom";
  /** Anchor margin as fraction of height (inward from the anchor edge). */
  marginYFrac: number;
  /** Left/right safe margin as fraction of width. */
  marginXFrac: number;
  maxWidthFrac: number;
  blockRotateDeg: number;
  /** split-sides: gap between left/right groups (fraction of width). */
  sideGapFrac: number;
  // Segmentation targets (§3)
  preferredWords: [number, number];
  maxWords: number;
  maxChars: number;
  // Motion (§20)
  entrance: EntranceType;
  entranceMs: number;
  staggerMs: number;
  overshoot: number;
  emphasisMotion: "scale-punch" | "pulse" | "shake" | "hold";
  hold: HoldMotion;
  exit: ExitType;
  exitMs: number;
  // Visual (§26, §27)
  accentColor: string;
  shadow: boolean;
  outline: boolean;
  /** Supporting words render at this alpha (muted tier, §27). */
  supportAlpha: number;
  // Compatibility metadata (§31)
  intensityRange: [number, number];
  classificationBias: NarrativeLabel[];
  /** Base preference weight in auto/all scoring. */
  autoWeight: number;
  /** Full-screen compositions — never repeat back-to-back (§17). */
  fullScreen: boolean;
}

// ── Plan (built deterministically by engine.ts) ────────────────────────────

export interface KineticWordPlan {
  text: string;
  startMs: number;
  endMs: number;
  role: KineticRole;
  /** Receives the emphasis visual event (semantic winner). */
  emphasis: boolean;
  phraseIndex: number;
}

export interface KineticPhrasePlan {
  index: number;
  words: KineticWordPlan[];
  role: KineticRole;
  /** Font scale multiplier (typographic hierarchy). */
  scale: number;
  weight: number;
  align: "left" | "center" | "right";
  /** Extra x indent as fraction of canvas width. */
  indentFrac: number;
}

export interface KineticComposition {
  /** Index of the FIRST source cue this composition covers. */
  cueIndex: number;
  startMs: number;
  endMs: number;
  presetId: string;
  classification: NarrativeLabel;
  /** 0-100 narrative intensity (§16). */
  intensity: number;
  words: KineticWordPlan[];
  phrases: KineticPhrasePlan[];
}

export interface KineticPlan {
  compositions: KineticComposition[];
  /** Lookup: composition active at a given master-timeline ms. */
  compositionAt(ms: number): KineticComposition | null;
}

// ── Runtime word transform (render + ASS mirror) ───────────────────────────

export interface KineticWordTransform {
  alpha: number;
  scale: number;
  offsetX: number; // px, 1080p-referenced (scale by ch/1080)
  offsetY: number;
  rotate: number; // deg
  blur: number; // px, 1080p-referenced
  clipLeft: number; // 0-1 wipe reveal
  colorOverride: string | null;
}

export const KINETIC_IDENTITY: KineticWordTransform = {
  alpha: 1,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  rotate: 0,
  blur: 0,
  clipLeft: 1,
  colorOverride: null,
};

// ── Export geometry (measured in the renderer, consumed by the ASS mirror
// AND — since v1.21 — the NATIVE Rust kinetic renderer) ─────────────────────

export interface KineticGeoWord {
  text: string;
  /** Absolute x of the word's left edge (px at export dims). */
  x: number;
  y: number;
  w: number;
  h: number;
  fontPx: number;
  /** Index into the composition's flat word list. */
  wordIdx: number;
  // ── v1.21 native Rust render fields (self-contained payload: the Rust
  // engine needs per-word timing + semantics + weight but does NOT
  // re-derive layout — the rects above are the canvas-measured truth) ──
  /** Effective font weight (inline emphasis may bump it). */
  weight?: number;
  emphasis?: boolean;
  /** "primary" | "secondary" | "supporting". */
  role?: KineticRole;
  phraseIndex?: number;
  startMs?: number;
  endMs?: number;
}

export interface KineticGeoLine {
  role: KineticRole;
  fontPx: number;
  y: number;
  h: number;
  align: "left" | "center" | "right";
}

export interface KineticGeoPhrase {
  role: KineticRole;
  align: "left" | "center" | "right";
}

export interface KineticGeoComposition {
  cueStartMs: number;
  presetId: string;
  fontPx: number;
  lineHeight: number;
  blockLeft: number;
  blockTop: number;
  blockW: number;
  blockH: number;
  blockRotateDeg: number;
  lines: KineticGeoLine[];
  words: KineticGeoWord[];
  /** v1.21: per-phrase role/align (indexed by word.phraseIndex) — the Rust
   * motion solver needs the phrase alignment (slide-x direction) and the
   * push-out grouping without re-deriving the semantic plan. */
  phrases?: KineticGeoPhrase[];
}

/** Serialized per-cue composition payload (renderer → main, §36 parity). */
export interface KineticCuePayload {
  presetId: string;
  classification: NarrativeLabel;
  intensity: number;
  startMs: number;
  endMs: number;
  words: {
    text: string;
    startMs: number;
    endMs: number;
    role: KineticRole;
    emphasis: boolean;
    phraseIndex: number;
  }[];
  phrases: {
    role: KineticRole;
    scale: number;
    weight: number;
    align: "left" | "center" | "right";
    indentFrac: number;
  }[];
}
