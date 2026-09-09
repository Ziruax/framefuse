// src/lib/merger/types.ts — FrameFuse core type system

export type TimelineMode = "absolute" | "sequential";

export type AspectRatio = "16:9" | "9:16" | "1:1";

export type Resolution = "720p" | "1080p";

export type KenBurnsDirection =
  | "in"
  | "out"
  | "left"
  | "right"
  | "up"
  | "down"
  | "random";

export type SegmentKind = "absolute" | "duration" | "beat";

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
  direction: KenBurnsDirection;
}

export interface VideoSettings {
  aspect: AspectRatio;
  resolution: Resolution;
  bitrateMbps: number;
  fps: 24 | 30 | 60;
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
   * Default "off". When enabled, cues MUST carry `words[]`; cues without
   * word timestamps fall back to full-text rendering.
   */
  wordMode: "off" | "word" | "word-only";
  /**
   * Kinetic typography animation. Per-word when words[] are available,
   * whole-cue otherwise. Drives the per-word "in" transition plus an
   * optional active-loop transform (e.g. scale-pulse, wave).
   */
  animation: CaptionAnimation;
}

/**
 * Kinetic typography animations. Each one is designed for the
 * storytelling/retention niche — they re-engage the viewer's eye on
 * every word without being distracting.
 *
 *   none         — no animation (static text)
 *   pop-in       — word scales 0.4 → 1 with overshoot bounce (200ms)
 *   slide-up     — word slides up 30px → 0 with fade-in (250ms)
 *   bounce-in    — word drops from -25px → 0 with spring ease (350ms)
 *   scale-pulse  — active word pulses 1 → 1.18 → 1 (continuous)
 *   fade-through — word alpha 0 → 1, with next word fading in as prev fades
 *   typewriter   — characters reveal one-by-one (50ms each)
 *   reveal       — word clipped-from-left + alpha 0.4 → 1 (300ms)
 *   wave         — word y-offset oscillates with sine while active
 *   jitter       — small random shake while active (attention)
 *   shake        — strong horizontal shake for 250ms on word start
 *   drift        — word slowly drifts upward by 8px while active
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
  | "drift";

export function defaultCaptionSettings(): CaptionSettings {
  return {
    enabled: false,
    presetId: "viral-drift",
    fontId: "roboto",
    customColor: null,
    customPosition: "center",
    fontSizeScale: 1,
    balancedWrap: true,
    wordMode: "off",
    animation: "none",
  };
}

export interface SubtitleFile {
  fileName: string;
  /** Parsed cues (already sorted by start time). */
  cues: import("./subtitles").SubtitleCue[];
  /** Original raw text — used when writing the temp .srt for FFmpeg. */
  rawText: string;
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
  onProgress?: (p: ExportProgress) => void;
  /** When aborted, the export stops as soon as possible. */
  signal?: AbortSignal;
}

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
      saveTempSrt: (p: { name: string; text: string }) => Promise<string>;
      chooseOutput: () => Promise<string | null>;
      cleanupTemp: () => Promise<boolean>;
      cancelExport: () => Promise<boolean>;
      onExportProgress: (cb: (d: ExportProgress) => void) => () => void;
      onMenu: (channel: string, cb: (d?: unknown) => void) => () => void;
    };
  }
}
