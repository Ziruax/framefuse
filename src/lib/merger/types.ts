// src/lib/merger/types.ts — FrameFuse core type system
//
// v5.0: multi-track timeline data model. Segments now carry resolved
// per-item edit metadata (track / volume / trim / chroma / overlay) and a
// media kind, so video items, overlay lanes and chroma keying flow through
// the SAME MediaSegment shape everywhere (preview, native export, project
// files). Type-only imports keep this module dependency-free at runtime.

import type { ChromaKeySettings } from "./chroma";
import type { SfxItem } from "./sfx";

// Re-export the sibling-lib types so consumers can import the whole data
// model from one place (type-only — no runtime dependency is created).
export type { ChromaKeySettings, SfxItem };

export type TimelineMode = "absolute" | "sequential";

export type AspectRatio = "16:9" | "9:16" | "1:1" | "4:5";

export type Resolution = "720p" | "1080p";

// ---------------------------------------------------------------------------
// EXPORT QUALITY PROFILES (v4.5) — one-click encode bundles.
// Each profile sets resolution + fps + bitrate + CRF together; tweaking any
// individual field afterwards flips `quality` to "custom" (encoder then uses
// the explicit `crf` value). "social" mirrors v4.4's defaults exactly, so
// old projects/settings keep their behavior.
// ---------------------------------------------------------------------------

export type ExportQuality = "draft" | "social" | "cinema" | "custom";

export interface QualityProfile {
  id: Exclude<ExportQuality, "custom">;
  label: string;
  resolution: Resolution;
  fps: 24 | 30 | 60;
  bitrateMbps: number;
  crf: number;
  /** 1 = slow/best, 3 = fast/rough — drives the speed meter dots. */
  speed: 1 | 2 | 3;
  hint: string;
}

export const QUALITY_PROFILES: QualityProfile[] = [
  {
    id: "draft",
    label: "Draft",
    resolution: "720p",
    fps: 30,
    bitrateMbps: 4,
    crf: 27,
    speed: 3,
    hint: "Fastest rough cut — check the edit before committing to a full render.",
  },
  {
    id: "social",
    label: "Social",
    resolution: "1080p",
    fps: 30,
    bitrateMbps: 8,
    crf: 20,
    speed: 2,
    hint: "The sweet spot for Shorts / Reels / TikTok — sharp at upload bitrates.",
  },
  {
    id: "cinema",
    label: "Cinema",
    resolution: "1080p",
    fps: 60,
    bitrateMbps: 14,
    crf: 17,
    speed: 1,
    hint: "Maximum-quality 60fps master — for archival or re-editing later.",
  },
];

export function qualityProfile(id: ExportQuality): QualityProfile | null {
  return QUALITY_PROFILES.find((p) => p.id === id) ?? null;
}

export type KenBurnsDirection =
  | "in"
  | "out"
  | "left"
  | "right"
  | "up"
  | "down"
  | "random";

export type SegmentKind = "absolute" | "duration" | "beat";

// ---------------------------------------------------------------------------
// v5.0 MULTI-TRACK TIMELINE — media kinds + per-item edits
//
// One flat map `itemEdits: Record<string, ItemEdit>` (keyed by item id)
// carries every user edit for an item: placement, duration, lane, trim,
// volume, chroma key and overlay geometry. buildTimeline resolves each
// field onto the segment (edit wins over parsed filename over defaults).
// ---------------------------------------------------------------------------

/** Kind of a source media file. Audio never becomes a MediaSegment (it is
 *  a separate AudioTrack), but entries/imports are tagged with this union. */
export type MediaKind = "image" | "video" | "audio";

/** 9-grid overlay anchor — identical shape to WatermarkPosition. */
export type OverlayPos = WatermarkPosition;

/** Overlay geometry request resolved per item (scale relative to the OUTPUT
 *  video width, 10–100; 9-grid anchor). renderer.overlayGeometry is the
 *  single source of truth for the actual pixel rect. */
export interface OverlayTransform {
  /** Destination width as a percentage of the video width (10 – 100). */
  scalePercent: number;
  position: OverlayPos;
}

/** Per-item user edits (all optional; absent fields keep their defaults). */
export interface ItemEdit {
  /** Absolute start on the master timeline (overlay lane; base lane follows
   *  the filename timing / sequential stacking). */
  startMs?: number;
  durationMs?: number;
  /** 0 = base lane (default), 1 = first overlay lane, 2+ stack above. */
  track?: number;
  /** Video source trim offset (ms into the source, applied before the
   *  timeline window). */
  trimInMs?: number;
  /** Playback volume 0..2, 1 = unity. */
  volume?: number;
  /** v5.1: playback speed for VIDEO clips, 0.25..4 (default undefined = 1).
   *  The timeline duration is the SOURCE window divided by speed — a 10s
   *  source window at 2× becomes a 5s timeline clip. Images and overlay-lane
   * clips resolve speed 1 (the export overlay graph is speed-1 by design). */
  speed?: number;
  /** Chroma key settings — stored RAW here; chroma.ts owns sanitization
   *  (sanitizeChromaKeySettings) at the UI boundary. */
  chroma?: ChromaKeySettings;
  overlay?: OverlayTransform;
}

/** A resolved media segment placed on the timeline. */
export interface MediaSegment {
  id: string;
  fileName: string;
  /** Original File (browser) — kept for image loading / temp export. */
  file?: File;
  kind: SegmentKind;
  /** Resolved absolute start (ms) on the master timeline. */
  startMs: number;
  /** Resolved absolute end (ms) on the master timeline. */
  endMs: number;
  /** Resolved duration (ms) = endMs - startMs. */
  durationMs: number;
  /** Parsed start (ms) for absolute/beat segments, null for duration/sequential. */
  rawStartMs: number | null;
  /** Parsed duration (ms) for duration segments, null otherwise. */
  rawDurationMs: number | null;
  /** Parsed end (ms) for absolute segments, null otherwise. */
  rawEndMs: number | null;
  /** Ken Burns direction assigned to this segment. */
  direction: KenBurnsDirection;
  /** Object URL for thumbnail / image loading. */
  thumbnailUrl: string;
  /** Index of the source file in the original upload order. */
  order: number;
  // --- v5.0 resolved edit fields (present on every segment) ---
  /** Source media kind (audio never lands on a segment). */
  mediaType: "image" | "video";
  /** Resolved lane: 0 = base, >= 1 = overlay (drawn on top, track order). */
  track: number;
  /** Resolved volume 0..2 (1 = unity; edit wins, default 1). */
  volume: number;
  /** Resolved video trim offset (ms into the source; default 0). */
  trimInMs: number;
  /** Full source duration for video items when known, else null. */
  sourceDurationMs: number | null;
  /** v5.1: resolved playback speed (videos on the base lane, 0.25..4;
   *  images / overlays = 1). durationMs = sourceWindow / speed. */
  speed: number;
  /** Resolved chroma key settings or null. NOT sanitized in the timeline —
   *  chroma.ts owns sanitization at the UI boundary. */
  chroma: ChromaKeySettings | null;
  /** Resolved overlay geometry request or null (base-lane default). */
  overlay: OverlayTransform | null;
}

export interface AudioTrack {
  fileName: string;
  url: string;
  durationMs: number | null;
}

export interface OverlapWarning {
  message: string;
  segments: [string, string];
}

export interface KenBurnsConfig {
  enabled: boolean;
  /** 0 - 100, controls zoom amplitude. */
  intensity: number;
  /**
   * Primary direction. When "random", each segment picks one effect from
   * `directionPool` (deterministically, hashed by segment id) — the pool
   * lets creators limit random motion to 2+ preferred effects only.
   */
  direction: KenBurnsDirection;
  /**
   * Effects the "random" mode is allowed to pick from (v4.1).
   * E.g. ["in", "left", "up"] → segments randomly get one of those 3.
   * Defaults to all 6. Ignored when direction is a concrete effect.
   */
  directionPool: KenBurnsDirection[];
}

export function defaultKenBurnsConfig(): KenBurnsConfig {
  return {
    enabled: true,
    intensity: 35,
    direction: "random",
    directionPool: ["in", "out", "left", "right", "up", "down"],
  };
}

export interface VideoSettings {
  aspect: AspectRatio;
  resolution: Resolution;
  bitrateMbps: number;
  fps: 24 | 30 | 60;
  /** Encode quality profile (v4.5). "custom" = user tuned the fields below. */
  quality?: ExportQuality;
  /** Constant-quality target (CRF / cq / QP). Used when quality="custom",
   * otherwise the profile's value wins. 18 – 28, lower = better. */
  crf?: number;
}

/** Result of parsing a single filename. */
export interface ParsedName {
  kind: SegmentKind;
  startMs: number | null;
  endMs: number | null;
  durationMs: number | null;
  raw: string;
}

/** Result of building the master timeline from parsed files. */
export interface BuildTimelineResult {
  segments: MediaSegment[];
  mode: TimelineMode;
  totalMs: number;
  warnings: OverlapWarning[];
  skipped: string[];
}

export interface ExportProgress {
  progress: number;
  fps?: number;
  eta?: number;
  timemark?: string;
}

export interface ExportResult {
  path: string;
  size: number;
}

export interface CaptionSettings {
  enabled: boolean;
  presetId: string;
  fontId: string;
  /** Override the preset's text color (hex) or null to use the preset. */
  customColor: string | null;
  /** Override the preset's position or null to use the preset. */
  customPosition: "top" | "center" | "bottom" | null;
  /** Font size multiplier 0.5 - 2.0. */
  fontSizeScale: number;
  /** Balanced text wrapping (triangle shape: line1 > line2 > line3). Default true. */
  balancedWrap: boolean;
  /**
   * Word-by-word rendering mode.
   * - "off"      : show the full cue text at once (standard subtitle behavior).
   * - "word"     : show the full cue text, but highlight the currently-spoken word
   *                (viral karaoke style — requires per-word timestamps from Whisper).
   * - "word-only": show only the currently-spoken word (Hormozi/attention style).
   * - "stack"    : words stack vertically as they are spoken — each new word pops
   *                into a growing centered stack, previous words stay dim above
   *                (viral quote-builder / motivational-shorts style).
   * Default "off". When enabled, cues MUST carry `words[]`; cues without
   * word timestamps fall back to full-text rendering.
   */
  wordMode: "off" | "word" | "word-only" | "stack";
  /**
   * Kinetic typography animation. Per-word when words[] are available,
   * whole-cue otherwise. Drives the per-word "in" transition plus an
   * optional active-loop transform (e.g. scale-pulse, wave).
   * `null` means "follow the preset's default animation" — the preset's
   * chosen motion applies until the user picks one explicitly.
   */
  animation: CaptionAnimation | null;
  /**
   * True once the user manually picks an animation — preset switches then
   * keep the user's choice instead of overriding it.
   */
  animationPinned?: boolean;
}

/**
 * Kinetic typography animations. Each one is designed for the
 * storytelling/retention niche — they re-engage the viewer's eye on
 * every word without being distracting.
 *
 *   none         — no animation (static text)
 *   pop-in       — word scales 0.4 → 1 with overshoot bounce (220ms)
 *   slide-up     — word slides up 30px → 0 with fade-in (280ms)
 *   bounce-in    — word drops from -25px → 0 with spring ease (380ms)
 *   scale-pulse  — active word pulses 1 → 1.18 → 1 (continuous)
 *   fade-through — word alpha 0 → 1, with next word fading in as prev fades
 *   typewriter   — characters reveal one-by-one (45ms each)
 *   reveal       — word clipped-from-left + alpha 0.4 → 1 (320ms)
 *   wave         — word y-offset oscillates with sine while active
 *   jitter       — small random shake while active (attention)
 *   shake        — strong horizontal shake for 280ms on word start
 *   drift        — word slowly drifts upward by 8px while active
 *   ── v4.1 viral kinetic pack ──
 *   slam         — machine-gun slam: scale 2.4 → 1 + micro-shake (180ms)
 *   glitch       — digital glitch: rgb-split flicker + x-jumps (220ms)
 *   spin-in      — word spins in: rot -14° → 0 + scale 0.6 → 1 (300ms)
 *   flip-in      — 3D flip: scaleY 0 → 1 + alpha (260ms)
 *   elastic      — juicy elastic scale 0.3 → 1.06 → 1 (450ms)
 *   color-cycle  — per-word viral palette (yellow/cyan/magenta/lime)
 *   spotlight    — active word pops with a colored highlight box
 *   swing        — pendulum: rot swings ±8° while active
 *   squash       — squash & stretch entry: fscy 40% → 110% → 100%
 *   zoom-words   — fast-cut: word zooms 1.6 → 1 + quick fade (160ms)
 *   ── v4.2 viral kinetic pack ──
 *   tracking-in  — letters slide together: spacing 8px → 0 + fade (300ms)
 *   blur-in      — focus pull: scale 1.18 → 1 + fade-in (260ms)
 *   heartbeat    — double-beat pulse 1 → 1.14 → 1 → 1.08 → 1 (640ms)
 */
export type CaptionAnimation =
  | "none"
  | "pop-in"
  | "slide-up"
  | "bounce-in"
  | "scale-pulse"
  | "fade-through"
  | "typewriter"
  | "reveal"
  | "wave"
  | "jitter"
  | "shake"
  | "drift"
  | "slam"
  | "glitch"
  | "spin-in"
  | "flip-in"
  | "elastic"
  | "color-cycle"
  | "spotlight"
  | "swing"
  | "squash"
  | "zoom-words"
  | "tracking-in"
  | "blur-in"
  | "heartbeat";

export function defaultCaptionSettings(): CaptionSettings {
  return {
    enabled: false,
    presetId: "viral-hormozi",
    fontId: "montserrat",
    customColor: null,
    customPosition: null,
    fontSizeScale: 1,
    balancedWrap: true,
    wordMode: "off",
    animation: null,
  };
}

export interface SubtitleFile {
  fileName: string;
  /** Parsed cues (already sorted by start time). */
  cues: import("./subtitles").SubtitleCue[];
  /** Original raw text — used when writing the temp .srt for FFmpeg. */
  rawText: string;
}

// ---------------------------------------------------------------------------
// HEADLINE OVERLAY (v4.2) — viral hook titles independent of captions.
// A list of timed text items, each styled by a headline preset, drawn on the
// canvas preview and burned into the export via extra ASS Dialogue lines.
// ---------------------------------------------------------------------------

/** Entrance animation for headline items. */
export type HeadlineAnimation = "none" | "fade" | "slide-up" | "pop" | "zoom-punch";

/** Vertical anchor for a headline item. */
export type HeadlinePosition = "top" | "center" | "bottom";

/** One timed headline/title item on the master timeline. */
export interface HeadlineItem {
  id: string;
  /** The text (supports \n for manual line breaks). */
  text: string;
  /** Master-timeline window. */
  startMs: number;
  endMs: number;
  /** Headline preset id (headlinePresets.ts). */
  presetId: string;
  position: HeadlinePosition;
  /** Entrance animation. */
  animation: HeadlineAnimation;
  /** Font size multiplier 0.5 - 2.0. */
  sizeScale: number;
}

export function makeHeadlineItem(partial: Partial<HeadlineItem> = {}): HeadlineItem {
  return {
    id: `hl_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`,
    text: "YOUR HOOK HERE",
    startMs: 0,
    endMs: 3000,
    presetId: "impact",
    position: "top",
    animation: "pop",
    sizeScale: 1,
    ...partial,
  };
}

export interface ExportNativeOptions {
  segments: MediaSegment[];
  /** segId -> object URL (or data URL) for the image. */
  imageUrls: Record<string, string>;
  audioTrack?: AudioTrack | null;
  settings: VideoSettings;
  kenBurns: KenBurnsConfig;
  totalMs: number;
  /** Optional subtitle track + caption styling for burn-in. */
  subtitles?: SubtitleFile | null;
  captionSettings?: CaptionSettings;
  /** Headline overlay items for burn-in (v4.2). */
  headlines?: HeadlineItem[] | null;
  /** Audio post-processing (normalize / fades). v4.1 */
  audio?: AudioSettings;
  /** Segment transitions (v4.3). */
  transition?: TransitionSettings;
  /** Watermark / logo overlay (v4.4). */
  watermark?: WatermarkExportOptions | null;
  /** v5.0: SFX placements mixed into the export audio chain. */
  sfx?: SfxItem[];
  onProgress?: (p: ExportProgress) => void;
  /** When aborted, the export stops as soon as possible. */
  signal?: AbortSignal;
}

/** Audio post-processing options for export (v4.1). */
export interface AudioSettings {
  /** Normalize loudness to -16 LUFS (social-media standard) via ffmpeg loudnorm. */
  normalize: boolean;
  /** Fade-in duration in ms (0 = off). */
  fadeInMs: number;
  /** Fade-out duration in ms (0 = off). */
  fadeOutMs: number;
}

export function defaultAudioSettings(): AudioSettings {
  return { normalize: false, fadeInMs: 0, fadeOutMs: 0 };
}

// ---------------------------------------------------------------------------
// SEGMENT TRANSITIONS (v4.3) — pro slideshow polish between segments.
//
// Architecture: every transition is a per-clip HEAD composite (the first
// `durationMs` of each clip blends the frozen end-frame of the previous
// segment with the current segment's animating frames) plus optional tail
// dips. Because the composite happens INSIDE each clip, the master timeline
// duration never changes — audio sync, caption timing and the instant
// `-c copy` concat are all untouched. FFmpeg side: `xfade` with offset=0
// for dissolve/slide/wipe (verified exactly linear), and the linear `fade`
// filter for dip-to-black / dip-to-white heads+tails.
// ---------------------------------------------------------------------------

export type TransitionStyle =
  | "none"
  | "dissolve"
  | "dip-black"
  | "dip-white"
  | "slide-left"
  | "slide-right"
  | "wipe-left"
  | "wipe-right"
  | "circleopen";

export interface TransitionSettings {
  style: TransitionStyle;
  /** Transition duration in ms (200 – 1500). Clamped per segment to ≤45% of
   *  the segment duration so a clip is never all-transition. */
  durationMs: number;
  /** Fade the whole video in from black at the start and out to black at the
   *  end (applied after captions, like a real video opener/outro). */
  fadeStartEnd: boolean;
  /**
   * Per-boundary style overrides (v4.5). Keyed by the id of the segment the
   * transition ENTERS. A value of "none" = explicit hard cut at that
   * boundary even when a global style is active; an absent key = follow the
   * global `style`. Everything (preview canvas, WebCodecs/MediaRecorder and
   * the FFmpeg xfade/fade graphs) resolves through boundaryStyle().
   */
  overrides?: Record<string, TransitionStyle>;
}

/**
 * Effective transition style at the boundary ENTERING the segment with the
 * given id — override wins over the global style. THE single resolution
 * point shared by the canvas preview, browser exports and (mirrored, since
 * main.js is plain JS) the FFmpeg graph builder.
 */
export function boundaryStyle(
  transition: TransitionSettings | null | undefined,
  segId: string | undefined | null,
): TransitionStyle {
  if (!transition) return "none";
  if (segId == null) return transition.style;
  const ov = transition.overrides ? transition.overrides[segId] : undefined;
  return ov ?? transition.style;
}

export function defaultTransitionSettings(): TransitionSettings {
  return { style: "none", durationMs: 500, fadeStartEnd: false };
}

// ---------------------------------------------------------------------------
// WATERMARK / LOGO OVERLAY (v4.4) — brand every frame.
//
// A single image (PNG with transparency works best) overlaid on every frame
// of the video, under captions. The preview draws it with canvas globalAlpha;
// the export uses ffmpeg `scale + format=rgba + colorchannelmixer=aa +
// overlay=eof_action=repeat` — the exact same linear blend (probe-verified).
// Geometry is computed by ONE shared function (watermarkGeometry in
// renderer.ts) so the canvas and the FFmpeg overlay x/y/w/h can never drift.
// ---------------------------------------------------------------------------

export type WatermarkPosition =
  | "top-left"
  | "top"
  | "top-right"
  | "left"
  | "center"
  | "right"
  | "bottom-left"
  | "bottom"
  | "bottom-right";

export interface WatermarkSettings {
  position: WatermarkPosition;
  /** Destination width as a percentage of the video width (5 – 50). */
  sizePercent: number;
  /** Opacity 10 – 100. */
  opacity: number;
  /** Margin as a percentage of the video width (0 – 10), applied to both
   *  axes (derived from width so it stays proportional on every aspect). */
  marginPercent: number;
}

export function defaultWatermarkSettings(): WatermarkSettings {
  return {
    position: "bottom-right",
    sizePercent: 12,
    opacity: 80,
    marginPercent: 3,
  };
}

/** The watermark payload handed to the export orchestration. */
export interface WatermarkExportOptions {
  /** Object URL / data URL of the watermark image. */
  imageUrl: string;
  settings: WatermarkSettings;
}

/** Human labels + hints for the transition styles (UI + a11y). */
export const TRANSITION_STYLE_INFO: Record<
  TransitionStyle,
  { label: string; hint: string; xfade?: string; dipColor?: "black" | "white" }
> = {
  none: { label: "Hard Cut", hint: "No transition — instant cuts between segments." },
  dissolve: {
    label: "Dissolve",
    hint: "Classic crossfade — the previous frame melts into the next.",
    xfade: "fade",
  },
  "dip-black": {
    label: "Dip Black",
    hint: "Fades through black at every boundary — cinematic slideshow feel.",
    dipColor: "black",
  },
  "dip-white": {
    label: "Flash",
    hint: "Fades through white — punchy, high-energy segment swaps.",
    dipColor: "white",
  },
  "slide-left": {
    label: "Slide ←",
    hint: "The next segment slides in from the right.",
    xfade: "slideleft",
  },
  "slide-right": {
    label: "Slide →",
    hint: "The next segment slides in from the left.",
    xfade: "slideright",
  },
  "wipe-left": {
    label: "Wipe ←",
    hint: "The next segment is wiped in from the right edge.",
    xfade: "wipeleft",
  },
  "wipe-right": {
    label: "Wipe →",
    hint: "The next segment is wiped in from the left edge.",
    xfade: "wiperight",
  },
  circleopen: {
    label: "Circle",
    hint: "The next segment reveals through an expanding circle from the center.",
    xfade: "circleopen",
  },
};

// Augment the window with the Electron bridge (optional, only present in app).
declare global {
  interface Window {
    electronAPI?: {
      isElectron: () => Promise<boolean>;
      ffmpegStatus: () => Promise<{
        ok: boolean;
        path: string;
        version: string | null;
        error: string | null;
      }>;
      exportNative: (opts: unknown) => Promise<ExportResult>;
      saveTempImage: (p: { name: string; bytes: ArrayBuffer }) => Promise<string>;
      saveTempAudio: (p: { name: string; bytes: ArrayBuffer }) => Promise<string>;
      /** v5.0: video sources for the multi-track timeline (same shape as
       *  saveTempAudio — bytes land in a temp file, path comes back). */
      saveTempVideo: (p: { name: string; bytes: ArrayBuffer }) => Promise<string>;
      saveTempSrt: (p: { name: string; text: string }) => Promise<string>;
      chooseOutput: () => Promise<string | null>;
      cleanupTemp: () => Promise<boolean>;
      cancelExport: () => Promise<boolean>;
      onExportProgress: (cb: (d: ExportProgress) => void) => () => void;
      onMenu: (channel: string, cb: (d?: unknown) => void) => () => void;
      /** v5.1: result of the async GPU-encoder probe (export-tab badge). */
      getExportInfo: () => Promise<{ encoder: string; encoderName: string }>;
      /** ── v5.1 Native Whisper (utilityProcess service) ──
       * transcribe: main decodes via ffmpeg + runs onnxruntime-node; progress
       * streams via onWhisperProgress. */
      whisperTranscribe: (p: {
        name: string;
        bytes: ArrayBuffer;
        language?: string;
      }) => Promise<{
        chunks: Array<{ text: string; timestamp: [number | null, number | null] }> | null;
        language: string | null;
        wordLevel: boolean;
        durationMs: number;
      }>;
      whisperPreload: () => Promise<{ ok: boolean }>;
      whisperCancel: () => Promise<number>;
      onWhisperProgress: (cb: (d: { progress: number; status: string }) => void) => () => void;
      /** ── v5.1 native project files (dialog-backed) ── */
      saveProject: (p: { doc: unknown; currentPath?: string | null }) => Promise<{ path: string; name: string } | null>;
      saveProjectAs: (p: { doc: unknown }) => Promise<{ path: string; name: string } | null>;
      openProject: () => Promise<{ path: string; name: string; doc: unknown } | null>;
      recentProjects: () => Promise<Array<{ path: string; name: string; savedAt: number }>>;
      removeRecentProject: (p: { path: string }) => Promise<boolean>;
      /** v5.1: absolute path of a picked File (Electron ≥ 32 removed File.path). */
      getFilePath: (file: File) => string | null;
      /** Export the full-timeline ASS subtitle file (sidecar). v4.1 */
      exportAssFile: (opts: {
        cues: unknown[];
        captionSettings: unknown;
        width: number;
        height: number;
        /** Optional headline overlay items to include in the sidecar. v4.2 */
        headlines?: unknown[];
      }) => Promise<{ path: string; size: number } | null>;
    };
  }
}
