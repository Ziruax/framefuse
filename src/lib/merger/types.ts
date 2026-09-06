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

export interface ExportNativeOptions {
  segments: MediaSegment[];
  /** segId -> object URL (or data URL) for the image. */
  imageUrls: Record<string, string>;
  audioTrack?: AudioTrack | null;
  settings: VideoSettings;
  kenBurns: KenBurnsConfig;
  totalMs: number;
  onProgress?: (p: ExportProgress) => void;
  /** When aborted, the export stops as soon as possible. */
  signal?: AbortSignal;
}

// Augment the window with the Electron bridge (optional, only present in app).
declare global {
  interface Window {
    electronAPI?: {
      isElectron: () => Promise<boolean>;
      exportNative: (opts: unknown) => Promise<ExportResult>;
      saveTempImage: (p: { name: string; bytes: ArrayBuffer }) => Promise<string>;
      saveTempAudio: (p: { name: string; bytes: ArrayBuffer }) => Promise<string>;
      chooseOutput: () => Promise<string | null>;
      cleanupTemp: () => Promise<boolean>;
      cancelExport: () => Promise<boolean>;
      onExportProgress: (cb: (d: ExportProgress) => void) => () => void;
      onMenu: (channel: string, cb: (d?: unknown) => void) => () => void;
    };
  }
}
