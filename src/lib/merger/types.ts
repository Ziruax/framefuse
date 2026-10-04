// src/lib/merger/types.ts — FrameFuse core type system
//
// v5.0: multi-track timeline data model. Segments now carry resolved
// per-item edit metadata (track / volume / trim / chroma / overlay) and a
// media kind, so video items, overlay lanes and chroma keying flow through
// the SAME MediaSegment shape everywhere (preview, native export, project
// files). Type-only imports keep this module dependency-free at runtime.

import type { ChromaKeySettings } from "./chroma";
import type { SfxItem } from "./sfx";
// v1.17 Stack Text: HeadlineItem's stackLayout/stackStyle ids + the new-item
// defaults (stackTextPresets is pure data+math, zero imports — no cycle).
import {
  STACK_TEXT_DEFAULTS,
  type StackLayoutId,
  type StackStyleId,
} from "./stackTextPresets";
// v1.18 Kinetic Typography: CaptionSettings.kinetic settings block (pure
// data + defaults from the kinetic engine — no runtime cycle).
import { KINETIC_DEFAULTS, type KineticCaptionSettings } from "./kinetic/types";

// Re-export the sibling-lib types so consumers can import the whole data
// model from one place (type-only — no runtime dependency is created).
export type { ChromaKeySettings, SfxItem };
// v1.17: Stack Text ids are part of the headline data model surface.
export type { StackLayoutId, StackStyleId };
// v1.18: kinetic caption settings are part of the caption data model.
export type { KineticCaptionSettings };

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
    // v1.12: matches the backend's social tier (superfast + fastdecode +
    // crf 22) — the throughput push for budget CPUs.
    crf: 22,
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
  /** v5.2: free-form center position, normalized 0..1 against the OUTPUT
   *  frame. When both are finite they OVERRIDE the 9-grid anchor — set by
   *  dragging the overlay directly on the preview canvas (CapCut-style PiP).
   *  Keep optional so v5.0/5.1 project files load unchanged. */
  x?: number;
  y?: number;
  /** v5.6: position keyframes for MOTION PATHS. Local to the overlay's
   *  timeline window (0 = clip start). When ≥2 keyframes exist the
   *  interpolated position overrides the static x/y / 9-grid anchor at
   *  every point in the window (hold-first / hold-last, piecewise linear —
   *  the same curve the FFmpeg export reproduces via overlay x/y time
   *  expressions). 1 keyframe = a pinned position. Absent/empty = static. */
  motion?: OverlayKeyframe[];
}

/** v5.6: one keyframe on an overlay motion path. */
export interface OverlayKeyframe {
  /** Time into the overlay clip's window, ms (≥ 0). */
  tMs: number;
  /** Normalized 0..1 CENTER coordinates (same space as OverlayTransform
   *  x/y — the canvas drag space). */
  x: number;
  y: number;
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
  /** v5.2: loop the overlay source so it spans the full clip window even
   *  when the source is shorter than the timeline duration (green-screen
   *  clips stretched to the whole video). Export uses -stream_loop -1;
   *  preview wraps the video element currentTime. */
  overlayLoop?: boolean;
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
  /** v5.2: true when the overlay source should LOOP to fill its whole
   *  timeline window (short green-screen clip spanning the full video). */
  overlayLoop: boolean;
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
  /** v1.3 ZERO-COPY: absolute on-disk path when the track was picked from a
   * local file inside the Electron app (webUtils.getPathForFile) — export and
   * Whisper hand the PATH to ffmpeg instead of re-uploading bytes over IPC.
   * Null for tracks restored from project files. */
  sourcePath?: string | null;
}

/** v1.25 MULTI-MUSIC: one background-music placement on the (growable,
 *  multi-row) Audio lane. Replaces the v5.2 single `audioTrack` + the
 *  AudioSettings music scalars — N clips each individually draggable,
 *  volume-controlled, loopable and removable; files can be added at any time.
 *  LEGACY MIGRATION: a pre-1.25 session's `audioTrack` +
 *  `audio.{musicStartMs,musicVolume,musicLoop}` converts to musicClips[0]. */
export interface MusicClip {
  /** Placement id — `mus_<ts36>_<seq36>` (unique per import). */
  id: string;
  fileName: string;
  /** Object URL for the preview pool (never revoked mid-session). */
  url: string;
  /** v1.3 ZERO-COPY: absolute on-disk path when picked inside Electron
   *  (export + Whisper address the original file). Null for restored clips. */
  sourcePath?: string | null;
  /** EFFECTIVE clip duration on the timeline (ms) — the probed source length
   *  on import; non-loop clips are trimmable down from it (min 200ms). */
  durationMs: number;
  /** Probed SOURCE length (ms) — the trim ceiling for `durationMs`. Equals
   *  durationMs until the right edge is dragged. 0 while probing. */
  sourceDurationMs: number;
  /** Timeline start (base time — the display layer shifts by the disclaimer). */
  startMs: number;
  /** 0..2 (1 = unity) — the old musicVolume semantics, per clip. */
  volume: number;
  /** Loop the source to fill the remainder of the video (loop-to-fill). */
  loop: boolean;
}

/** Factory: fresh placement id (monotonic seq keeps burst imports unique). */
let _musicClipSeq = 0;
export function makeMusicClipId(): string {
  _musicClipSeq += 1;
  return `mus_${Date.now().toString(36)}_${_musicClipSeq.toString(36)}`;
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
    // v1.14.6 (user directive): ON by default — Ken Burns is the ONLY
    // effect enabled by default; every other effect (transitions, captions,
    // watermark, loudnorm, headlines…) stays opt-in. The v1.14.6
    // single-decode image path makes the motion cheap (decode once per
    // image, zoompan emits the frames).
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
  /** v5.2: how the preview draws media whose aspect differs from the output
   *  frame — "cover" crops to fill (export behavior), "contain" letterboxes
   *  so the full frame is visible. Preview-only; export always covers. */
  previewFit?: "cover" | "contain";
  /** v5.2: false until the user manually picks an aspect in Settings —
   *  before that, importing the first video auto-matches the output aspect
   *  to the source (with a toast) so vertical/square video is never
   *  silently center-cropped. */
  aspectTouched?: boolean;
  /** v1.2: export AAC audio bitrate (kbps). Optional — omitted/invalid falls
   *  back to 192 (the v1.1 behavior) so old project files stay byte-compatible.
   *  Drives the desktop FFmpeg -b:a and hints the browser MediaRecorder. */
  audioKbps?: 96 | 128 | 192 | 256 | 320;
  /** v1.14.4: constrained-CPU fast mode (default ON). On Tier-3 machines
   *  (≤3 strong cores / legacy dual-module APUs) a mostly-dirty timeline ≥4
   *  minutes requested at 1080p-class resolution renders at the 720p-class
   *  resolution of the SAME aspect instead — ~2.2× fewer pixels to
   *  encode. The completion toast always says it happened; false keeps the
   *  requested resolution whatever the hardware. */
  constrainedFastMode?: boolean;
  /** v1.14.5: slideshow 24-fps mode (default ON). A pure-image timeline
   *  (no base-lane video segments) renders at 24 instead of 30/25 fps —
   *  the film rate, 20 % fewer frames through every filter + the encoder.
   *  Mixed-video timelines, 60 fps projects and cinema quality are never
   *  touched; the completion toast says it happened. */
  slideshowFps24?: boolean;
  /** v1.15.1 GPU-Shift: opt-in WebCodecs/WebGL export engine (feature
   *  flag — DEFAULT OFF until field-verified). When true AND the timeline
   *  is GPU-routable (no burn-in text removal, no loudness normalization)
   *  AND WebCodecs is available, exports composite on the GPU canvas and
   *  encode through the hardware H.264 encoder, streaming muxed bytes to
   *  disk — any engine failure automatically falls back to the FFmpeg
   *  smart-render pipeline. The result payload carries engine:
   *  "webcodecs-gpu" + frame telemetry for A/B verification. */
  gpuExportEngine?: boolean;
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
  /**
   * v1.14.2 (user directive: "not getting exact time — how long will the
   * export take"): the desktop export progress payload now carries enough
   * context to render an honest time estimate instead of a bare percent:
   *   - elapsed: wall-clock seconds since the export started
   *   - total:   total timeline seconds (the "@ 00:12 / 00:42" denominator)
   *   - phase:   "prepare" | "video" | "audio" | "mux" | "done"
   *   - rate:    overall processing speed in × real-time (content-seconds
   *              per wall-second — the same number ffmpeg prints as speed=)
   */
  elapsed?: number;
  total?: number;
  phase?: string;
  rate?: number;
  /** v1.15.1 GPU-Shift: the WebCodecs engine's stage label
   *  ("preparing" | "encoding" | "finalizing" | "done") — the GPU path's
   *  heartbeat payload carries it the same way the FFmpeg path carries
   *  `phase`. Same contract, distinct name so both engines keep their
   *  vocabularies. */
  stage?: string;
  /** v1.18: WHICH backend is running this export — "rust" (the native
   *  wgpu + dlopen-FFI engine) or "cli" (the FFmpeg-CLI Safe Mode
   *  pipeline). The Header's engine badge renders it live. */
  engine?: "rust" | "cli";
  /** v1.20: WHY the CLI pipeline was chosen ("kinetic-captions",
   *  "stack-text", "transition:slide-left", …) — the router's gate
   *  reason, threaded so the badge can explain the routing instead of a
   *  silent "FFmpeg CLI". Undefined when the engine is eligible or not
   *  installed. */
  engineReason?: string;
  /** v1.15.1 GPU-Shift: the WebCodecs engine's heartbeat frame counters
   *  (framesEncoded of totalFrames — the frame-exact law's live view). */
  framesEncoded?: number;
  totalFrames?: number;
}

export interface ExportResult {
  path: string;
  size: number;
  /** v1.15.1 GPU-Shift: human label of the engine that produced this file
   *  ("WebCodecs GPU" | "Native FFmpeg") — set by the export router. */
  method?: string;
  /**
   * v1.1 TURBO export telemetry (desktop FFmpeg path only; browser
   * fallbacks omit them). encoder = the detected hardware/CPU encoder
   * label, elapsedSec = wall-clock export time, copiedClips/encodedClips
   * = how many clips took the stream-copy fast path vs a re-encode.
   * v1.4.1: keyframeCuts = copied clips that entered the fast path via a
   * keyframe-aligned head trim (requested cut within one frame of a
   * source keyframe).
   * v1.4.2: chunkedClips/totalChunks = the chunked parallel encode (long
   * re-encode clips split into frame-aligned chunks across the pool — the
   * fix for multi-hour single-clip exports); hwDecodeClips = sources
   * riding the throughput-probed hardware decode path.
   */
  encoder?: string;
  /** v1.15.1 GPU-Shift: which export engine actually ran.
   *  "webcodecs-gpu" = the WebCodecs/WebGL pipeline (GPU canvas
   *  compositing + hardware H.264, streamed muxing, frame-pooled memory
   *  discipline); "ffmpeg-smart" = the native FFmpeg True Smart Rendering
   *  pipeline. Carried on every result so the completion toast + LastExport
   *  tooltip make A/B verification explicit. */
  engine?: "webcodecs-gpu" | "ffmpeg-smart" | "rust-native";
  /** v1.15.1 GPU-Shift telemetry (webcodecs-gpu path): framesEncoded =
   *  emitted H.264 frames (must equal totalFrames — frame-exact law);
   *  audioSkipped = audio existed but AAC encode is unavailable in this
   *  runtime (video-only result, the UI warns); softwareFallback = the
   *  hardware encoder wedged before frame 0 and the pass auto-restarted
   *  on the software rung; gpuFrameRenderMs = mean per-frame composite +
   *  encode-submit cost (the number the CPU pipeline must lose to). */
  framesEncoded?: number;
  audioSkipped?: boolean;
  softwareFallback?: boolean;
  gpuFrameRenderMs?: number;
  /** v1.15.2 (worker migration): jsCompositorOverheadMs = mean per-frame
   *  PURE JS compositing cost (paint wall minus decode waits — the number a
   *  v1.16 GLSL/WebGPU shader migration would attack); gpuDecodeWaitMs =
   *  mean per-frame decoder wait (the mp4box→VideoDecoder arm);
   *  workerRuntime = "worker" | "main-thread" — which execution context ran
   *  the GPU engine (the UI thread stays free on "worker"). */
  jsCompositorOverheadMs?: number;
  gpuDecodeWaitMs?: number;
  workerRuntime?: "worker" | "main-thread";
  /** v1.15.3 (lie detector): which encoder rung actually ran —
   *  "require-hardware" = PROVEN hardware (the platform answered the probe),
   *  "prefer-hardware" = hardware requested but unverifiable (legacy
   *  runtime), "software"/"plain" = software by construction; +
   *  hwRejectReason = the platform's own rejection message when hardware
   *  was refused. The toast/tooltip/bench carry it so a "slow WebCodecs"
   *  report is diagnosable at a glance. */
  hwEncoder?: "require-hardware" | "prefer-hardware" | "software" | "plain";
  hwRejectReason?: string;
  elapsedSec?: number;
  copiedClips?: number;
  encodedClips?: number;
  keyframeCuts?: number;
  chunkedClips?: number;
  totalChunks?: number;
  hwDecodeClips?: number;
  /** v1.5: the export pipeline that actually ran. "parallel-pass" = the
   *  v1.10 high-accuracy multi-process chunking (a ≥70 %-dirty timeline
   *  split into W equal temporal windows rendered CONCURRENTLY — each a
   *  video-only single-pass graph with hardware decode, 1 encode thread —
   *  plus ONE full-timeline audio pass, stitched losslessly via the concat
   *  demuxer); "single-pass" = one process for the whole timeline (GPU
   *  boxes / short timelines); "two-step" = the per-clip pool fallback;
   *  "smart-render" = v9 True Smart Rendering (clean time-ranges
   *  stream-copied at TURBO speed, only the dirty windows re-encoded,
   *  stitched via the concat demuxer). */
  mode?: "single-pass" | "parallel-pass" | "two-step" | "smart-render" | "gpu-webcodecs";
  /** v1.12.1: the ACTUAL max-concurrent ffmpeg processes during the encode
   *  stage — the Task-Manager-check number. Telemetry can never claim
   *  parallelism that did not run (a 1-process fallback shows as 1). */
  poolWorkers?: number;
  /** v1.12.1: the machine's CPU core count (the pool-width input) — lets
   *  the UI flag a single-process run on a ≥4-core box. v1.14.1: this is
   *  the LOGICAL thread count; cpuPhysicalCores/cpuLogicalCores carry the
   *  measured topology. */
  cpus?: number;
  /** v1.14.1: the measured topology — strong physical cores + logical
   *  threads (e.g. "2 modules · 4 threads" on a dual-module AMD APU,
   *  "4 cores · 8 threads (SMT)" on a modern laptop) + filterPool = the
   *  widened process count that filter-dominated (image-heavy) exports
   *  actually ran. */
  cpuPhysicalCores?: number;
  cpuLogicalCores?: number;
  cpuTopology?: string;
  filterPool?: boolean;
  /** v1.13: the Adaptive Hardware Matrix tier that ran this export —
   *  "TIER_1_GPU" (ASIC encode), "TIER_2_MODERN_CPU" (≥4 strong physical
   *  cores) or "TIER_3_CONSTRAINED_CPU" (≤3 strong cores / legacy
   *  dual-module APUs: 2 × 2-thread encode workers, ultrafast + no
   *  B-frames, low-cost subtitle rasterization; image-heavy exports widen
   *  to min(4, logical) single-thread filter workers). */
  tier?: string;
  /** v1.13: human-readable tier label for the completion toast
   *  ("Tier 3 · constrained CPU"). */
  tierLabel?: string;
  /** v1.13: the encoder speed point actually used ("ultrafast",
   *  "superfast", "faster", or a GPU preset like "p4"). */
  enginePreset?: string;
  /** v9: True Smart Rendering telemetry — seconds of the timeline that
   *  rode the stream-copy fast path vs the re-encode windows. */
  smartCleanSec?: number;
  smartDirtySec?: number;
  /** v1.10: WHY the timeline was dirty — the primary human-readable reason
   *  (largest dirty-time share), e.g. "subtitles from 0:00 to 19:00",
   *  "watermark over the full timeline", "framerate resample 29.97 -> 30fps".
   *  When the copy ratio is 0 % the completion toast surfaces it as
   *  "Full re-encode required: [reason]". */
  smartDirtyReason?: string;
  /** v1.5: W — the number of parallel single-pass windows (parallel-pass
   *  only; aliases totalChunks for that mode). */
  parallelChunks?: number;
  /** v1.14.4: the constrained-CPU fast resolution ran — the export rendered
   *  at the 720p-class resolution of the requested aspect (fastModeFrom →
   *  fastModeTo) on a Tier-3 machine with a mostly-dirty ≥4-min timeline.
   *  Never silent: the completion toast + Export tab surface it. */
  fastMode?: boolean;
  fastModeFrom?: string;
  fastModeTo?: string;
  outputWidth?: number;
  outputHeight?: number;
  /** v1.14.5 (Release A — the export-speed plan): the fps the export
   *  actually rendered at, the slideshow 24-fps downgrade flag, the
   *  render-cost strategy that drove the speed levers, the encoder speed
   *  profile, whether the simple-audio fast path ran, the ffmpeg hardware
   *  capability matrix, and the per-export performance profile (stage +
   *  worker telemetry; `profile.file` is the full JSON on disk). */
  outputFps?: number;
  slideshowFps?: boolean;
  slideshowFpsFrom?: number;
  slideshowFpsTo?: number;
  costStrategy?: "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH";
  renderCost?: { score: number; pixelCost: number; effectCost: number };
  encoderSpeedProfile?: "fast" | "balanced";
  audioFastGain?: boolean;
  /** v1.14.6: the audio-normalize state that actually ran — false means
   *  loudnorm was fully bypassed (0 measurement spawns, 0 filters). Surfaced
   *  in the completion toast so the setting can never act silently. */
  audioNormalize?: boolean;
  hwCaps?: { hwaccels?: string[]; gpuFilters?: string[] };
  profile?: {
    file?: string | null;
    totalMs?: number;
    stages?: Record<string, number>;
    classWallMs?: Record<string, number>;
    framesEncoded?: number;
    contentSec?: number;
    speedX?: number | null;
    cpuBusyPct?: number | null;
    loudnessCache?: { hits?: number; misses?: number };
    pool?: { width?: number; jobs?: number; copyJobs?: number; dirtyJobs?: number; threadsPerWorker?: number };
  };
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
  /**
   * v1.18 Kinetic Typography engine (the professional stack-caption system:
   * semantic segmentation → narrative classification → 24-preset library →
   * style memory → motion choreography). When `kinetic.enabled` is true and
   * word timestamps exist, drawCaption dispatches to the kinetic painter
   * INSTEAD of the wordMode/animation paths (they resume when disabled —
   * full backward compatibility, directive §38). Absent on legacy projects.
   */
  kinetic?: KineticCaptionSettings;
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
    // v1.18: kinetic engine present-but-disabled by default (§38 — the
    // legacy caption behavior is untouched until the user opts in).
    kinetic: { ...KINETIC_DEFAULTS },
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
  /** Entrance animation (legacy simple styles — dead when stackStyle is set). */
  animation: HeadlineAnimation;
  /** Font size multiplier 0.5 - 2.0. */
  sizeScale: number;
  /** v1.17 Stack Text LAYOUT (geometry of the stacked lines). Absent on
   *  legacy items → derived from `position`: top→top-banner,
   *  center→center-stack, bottom→bottom-center. Optional so every old
   *  project file loads unchanged. */
  stackLayout?: StackLayoutId;
  /** v1.17 Stack Text kinetic STYLE. Absent → the legacy `animation` path
   *  renders exactly as before (byte-identical for old projects). */
  stackStyle?: StackStyleId;
}

export function makeHeadlineItem(partial: Partial<HeadlineItem> = {}): HeadlineItem {
  return {
    id: `hl_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`,
    text: "YOUR HOOK HERE",
    startMs: 0,
    endMs: 3000,
    presetId: "impact",
    position: "top",
    // v1.17 Stack Text: new items are kinetic by default (center-stack ×
    // word-pop). `animation` stays "none" — the legacy entrance is only set
    // when the user picks a Simple style in the Stack Text picker (which
    // clears stackStyle). Both fields never fight: stackStyle wins when set.
    stackLayout: STACK_TEXT_DEFAULTS.layout,
    stackStyle: STACK_TEXT_DEFAULTS.style,
    animation: "none",
    sizeScale: 1,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// DISCLAIMER / INTRO CARD (v1.14) — a lead-in image or video clip.
//
// The user picks ONE file with ANY filename (it is never run through the
// placement naming parser) and a hold duration. It occupies the very start of
// the output — [0, durationMs) — and the WHOLE existing timeline (segments,
// music, SFX, subtitles, headlines) shifts back together by the same offset,
// so image↔audio sync is preserved by construction. The disclaimer itself
// has no link to the audio track (the music does not start until it ends).
// Implementation: a virtual MediaSegment (DISCLAIMER_ID) is prepended at the
// export payload + preview layer, so every FFmpeg path handles it like any
// other clip with zero main-process changes.
// ---------------------------------------------------------------------------

/** Stable virtual segment id for the disclaimer clip. */
export const DISCLAIMER_ID = "__ff_disclaimer__";

/** Hold-duration presets for the disclaimer card (ms). */
export const DISCLAIMER_PRESETS_MS = [1000, 2000, 3000, 5000, 10000] as const;

export interface DisclaimerClip {
  fileName: string;
  /** Source kind — images are held, videos play (optionally trimmed). */
  kind: "image" | "video";
  /** The picked File (any name — placement naming rules NEVER apply). */
  file: File;
  /** Object URL for the preview + export byte fallback. */
  url: string;
  /** Probed video poster (96×54 JPEG dataURL) for cards / filmstrips. */
  thumbUrl?: string | null;
  /** Probed native video duration (null for images / unknown). */
  sourceDurationMs?: number | null;
  /**
   * Video only: ride the FULL source length (durationMs tracks the probe).
   * When false, durationMs is the preset clamped to the source length.
   */
  videoFull?: boolean;
  /** Effective lead-in duration (ms) — the amount everything else shifts. */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// v1.17 VOICEOVER / DUB (Edge TTS) — narration items + dub track segments.
//
// Items live in BASE timeline time (like SfxItem — the disclaimer shifts
// them only at render/export). The AUDIO BYTES never live here: they sit in
// a page-level Map (id → Blob) so undo snapshots and project files stay
// small — bytes regenerate at export via the stored text/voice/prosody, and
// dub bytes arrive with the dub result. The export payload carries only
// { wavPath, startMs, volume } per placement.
// ---------------------------------------------------------------------------

/** One synthesized voice placement on the master timeline. */
export interface VoiceoverItem {
  /** Instance id — unique per placement (see makeVoiceoverItem). */
  id: string;
  /** "narration" = a single TTS clip; "dub" = one segment of a dub track. */
  kind: "narration" | "dub";
  /** Position on the master (base) timeline, ms. */
  startMs: number;
  /** Actual audio duration, ms (measured by ffprobe at synthesis time). */
  durationMs: number;
  /** Playback volume 0..1. */
  volume: number;
  /** Short UI label (first words of the text — timeline chip). */
  label: string;
  /** Full text — persists in project files and drives regeneration. */
  text: string;
  /** Edge TTS voice ShortName, e.g. "hi-IN-SwaraNeural". */
  voice: string;
  /** Prosody deltas captured at synthesis time (regeneration parity). */
  ratePct?: number;
  pitchHz?: number;
  /** Dub items: which speaker this segment belongs to (0-based). */
  speaker?: number;
  /** Dub items: the source utterance window end (ms) — diagnostics. */
  endMs?: number;
}

/** v1.17 dub run configuration (the Translate & Dub card's knobs — a
 *  MACHINE-level localStorage preference, never a project-file field). */
export interface DubSettings {
  targetLanguage: string;
  targetLocale: string;
  groqModel: string;
  /** v1.22: which cloud LLM runs the dub's speaker-detection + translation
   *  phases — "groq" (default) or "gemini" (needs the Gemini key saved in
   *  Settings → Script Writer; Whisper transcription stays Groq either
   *  way). Absent (old persisted prefs) reads as "groq". */
  textProvider: "groq" | "gemini";
  /** v1.22: the Gemini model id used when textProvider === "gemini". */
  geminiModel: string;
  femaleVoice: string;
  maleVoice: string;
  /** v1.20: "single" = one voice reads the whole dub (speaker detection
   *  is skipped entirely); "multi" = per-speaker voices (legacy behavior).
   *  Absent (old persisted prefs) reads as "multi" at the call sites. */
  voiceMode: "single" | "multi";
  /** v1.20 single-voice mode: the Edge-TTS voice ShortName that reads
   *  every line. null = auto (the locale pair's default female voice). */
  singleVoice: string | null;
  /** Original-audio level under the dub (0..1) — the duck. */
  originalVolume: number;
}

/** Renderer-side view of DUB.runDub's result (the main process returns it
 *  from dub:start; wav BYTES arrive in-memory — paths are transient). */
export interface DubSegmentResult {
  /** Fitted placement start (base timeline ms). */
  startMs: number;
  /** Source utterance end (ms). */
  endMs: number;
  speaker: number;
  sourceText: string;
  translatedText: string;
  wavPath: string;
  /** Final (probed) audio duration, ms — post atempo fit. */
  ttsDurMs: number;
  speedApplied: number;
  /** The wav bytes (present on the dub:start result). */
  bytes?: ArrayBuffer;
}

export interface DubSpeakerResult {
  id: number;
  voice: string;
  gender: string;
}

export interface DubTrackResult {
  language: string;
  speakers: DubSpeakerResult[];
  segments: DubSegmentResult[];
  wavPaths: string[];
  totalDurationMs: number;
  warnings: string[];
  dubDir: string;
}

/** Monotonic sequence for instance ids (unique within the same ms). */
let voSeq = 0;

/**
 * Factory for voiceover placements. Ids follow the makeSfxItem/makeHeadlineItem
 * house style (`vo_<ts36>_<seq36>`). `volume` clamps to 0..1; non-finite
 * numbers fall back to the defaults; optional fields pass through only when
 * finite so JSON round-trips stay clean.
 */
export function makeVoiceoverItem(
  partial: Partial<VoiceoverItem> = {},
): VoiceoverItem {
  voSeq += 1;
  const num = (v: unknown, dflt: number, lo: number, hi: number) =>
    typeof v === "number" && Number.isFinite(v)
      ? Math.min(hi, Math.max(lo, v))
      : dflt;
  const kind: VoiceoverItem["kind"] = partial.kind === "dub" ? "dub" : "narration";
  const text = typeof partial.text === "string" ? partial.text : "";
  return {
    id: partial.id ?? `vo_${Date.now().toString(36)}_${voSeq.toString(36)}`,
    kind,
    startMs: num(partial.startMs, 0, 0, Number.MAX_SAFE_INTEGER),
    durationMs: num(partial.durationMs, 0, 0, Number.MAX_SAFE_INTEGER),
    volume: num(partial.volume, 1, 0, 1),
    label:
      typeof partial.label === "string" && partial.label
        ? partial.label
        : text.slice(0, 28) || (kind === "dub" ? "Dub segment" : "Voiceover"),
    text,
    voice: typeof partial.voice === "string" ? partial.voice : "",
    ...(typeof partial.ratePct === "number" && Number.isFinite(partial.ratePct)
      ? { ratePct: partial.ratePct }
      : {}),
    ...(typeof partial.pitchHz === "number" && Number.isFinite(partial.pitchHz)
      ? { pitchHz: partial.pitchHz }
      : {}),
    ...(typeof partial.speaker === "number" && Number.isFinite(partial.speaker)
      ? { speaker: partial.speaker }
      : {}),
    ...(typeof partial.endMs === "number" && Number.isFinite(partial.endMs)
      ? { endMs: partial.endMs }
      : {}),
  };
}

export interface ExportNativeOptions {
  segments: MediaSegment[];
  /** segId -> object URL (or data URL) for the image. */
  imageUrls: Record<string, string>;
  audioTrack?: AudioTrack | null;
  /** v1.25 MULTI-MUSIC: N background-music placements (the audioTrack
   *  successor — preferred when present). startMs here is DISPLAY time (the
   *  caller shifts by the disclaimer lead-in exactly like the legacy
   *  musicStartMs shift); each clip resolves to a real file in native.ts
   *  (sourcePath direct or a saveTempAudio upload). */
  musicClips?: MusicClip[] | null;
  settings: VideoSettings;
  kenBurns: KenBurnsConfig;
  totalMs: number;
  /** Optional subtitle track + caption styling for burn-in. */
  subtitles?: SubtitleFile | null;
  captionSettings?: CaptionSettings;
  /** Headline overlay items for burn-in (v4.2). */
  headlines?: HeadlineItem[] | null;
  /** v1.17 Stack Text: renderer-measured headline geometry (wrapped lines,
   *  word widths, block position at the export resolution) for kinetic
   *  stackStyle items — guarantees canvas/export line-break parity. Absent
   *  → the main process falls back to the legacy ASS emitter. */
  headlineGeometry?: import("./native").HeadlineExportGeometry[] | null;
  /** Audio post-processing (normalize / fades). v4.1 */
  audio?: AudioSettings;
  /** Segment transitions (v4.3). */
  transition?: TransitionSettings;
  /** Watermark / logo overlay (v4.4). */
  watermark?: WatermarkExportOptions | null;
  /** v5.0: SFX placements mixed into the export audio chain. */
  sfx?: SfxItem[];
  /** v1.17: voiceover/dub placements — the renderer uploads each item's
   *  bytes via saveTempAudio and passes only { wavPath, startMs, volume }.
   *  Omitted when empty so legacy payloads stay byte-identical. */
  voiceovers?: { wavPath: string; startMs: number; volume: number }[];
  /** v1.17: original-audio level under a dub track (0..1, sent only when a
   *  dub track exists — the MAIN process scales the base segments' volume
   *  by it; the renderer never pre-scales). */
  dubOriginalVolume?: number;
  /** v1.15: burn-in text detection & removal (default OFF — the renderer
   *  passes the setting through to the main process, which sanitizes it). */
  textRemoval?: TextRemovalSettings | null;
  onProgress?: (p: ExportProgress) => void;
  /** When aborted, the export stops as soon as possible. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// v1.15 — BURN-IN TEXT DETECTION & REMOVAL (default OFF, purely opt-in).
//
// The renderer's OCR detector (tesseract.js) samples frames from the first
// video source and stores word-box clusters as SOURCE-normalized rects
// (0..1 of the source frame), so the same region applies to every video
// segment regardless of output resolution — the filters run BEFORE the
// cover-fit scale/crop in every export path and the preview mirrors the
// same math, so framing can never diverge.
// ---------------------------------------------------------------------------

export type TextRemovalMode = "inpaint" | "blur" | "cover";

export interface TextRemovalRegion {
  id: string;
  /** 0..1 of the SOURCE frame width. */
  x: number;
  /** 0..1 of the SOURCE frame height. */
  y: number;
  /** 0..1 of the SOURCE frame width. */
  w: number;
  /** 0..1 of the SOURCE frame height. */
  h: number;
  /** Where this region came from (auto-detect vs hand-drawn). */
  source: "ocr" | "manual";
  /** OCR excerpt for display (auto-detected regions only). */
  label?: string;
}

export interface TextRemovalSettings {
  /** OFF unless the user turns it on (the shipped default). */
  enabled: boolean;
  mode: TextRemovalMode;
  regions: TextRemovalRegion[];
}

export function defaultTextRemovalSettings(): TextRemovalSettings {
  return { enabled: false, mode: "inpaint", regions: [] };
}

/** Audio post-processing options for export (v4.1). v5.2 adds background
 *  music placement controls — the music track is now a first-class timeline
 *  citizen (draggable on the audio lane, volume, loop-to-fill).
 *  v1.25 MULTI-MUSIC: the three music* scalars below are LEGACY — new code
 *  reads per-clip state from MusicClip[] (musicClips) instead; they stay for
 *  old project files + the single-music FFmpeg back-compat branch and are
 *  still written (from clip 0) on save for older builds. */
export interface AudioSettings {
  /** Normalize loudness to -16 LUFS (social-media standard) via ffmpeg loudnorm. */
  normalize: boolean;
  /** v1.3: master output volume 0..2 (1 = unity) — scales the SUMMED mix
   *  (clip audio + music + SFX) after per-source volumes, before the
   *  limiter. Optional; omitted/invalid → 1 (v1.2 behavior). */
  masterVolume?: number;
  /** Fade-in duration in ms (0 = off). */
  fadeInMs: number;
  /** Fade-out duration in ms (0 = off). */
  fadeOutMs: number;
  /** v5.2: background music volume 0..2 (1 = unity, 0 = muted). */
  musicVolume: number;
  /** v5.2: background music start offset on the master timeline (ms). */
  musicStartMs: number;
  /** v5.2: loop the music so it spans the ENTIRE video duration — background
   *  tracks are usually 2+ minutes while the edit is shorter. */
  musicLoop: boolean;
}

export function defaultAudioSettings(): AudioSettings {
  return {
    normalize: false,
    masterVolume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    musicVolume: 1,
    musicStartMs: 0,
    musicLoop: false,
  };
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
  none: { label: "None", hint: "No transition — a hard cut between segments." },
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

/** v1.15: Groq Whisper API config payload returned by the Electron bridge.
 *  The raw API key NEVER crosses the bridge — only this masked/device-local
 *  view of it. */
export interface GroqConfigPayload {
  hasKey: boolean;
  maskedKey: string;
  model: string;
  models: Array<{ id: string; label: string; hint: string }>;
}

/** v1.20: masked Gemini key state (the same discipline as
 *  GroqConfigPayload — hasKey + maskedKey only, never the raw key). */
export interface GeminiConfigPayload {
  hasKey: boolean;
  maskedKey: string;
}

/** v1.20: one selectable text model in the Script Writer picker. */
export interface ScriptModelInfo {
  id: string;
  label: string;
  hint?: string;
}

/** v1.20: the Script Writer's provider/model catalog (script:models IPC). */
export interface ScriptModelCatalog {
  gemini: { models: ScriptModelInfo[]; default: string; hasKey: boolean };
  groq: { models: ScriptModelInfo[]; default: string; hasKey: boolean };
}

// Augment the window with the Electron bridge (optional, only present in app).
declare global {
  interface Window {
    electronAPI?: {
      isElectron: () => Promise<boolean>;
      /** v1.12.1: the REAL running-exe facts — app.getVersion() reads the
       *  rcedit-stamped version resource of the actual executable (stale
       *  installs disagree with the renderer's build constant) + the CPU
       *  topology that decides the parallel-pool width. v1.14.1: physical
       *  cores AND logical threads (cpus stays the logical count for
       *  compatibility — it was mislabeled "cores" on SMT machines). */
      appInfo: () => Promise<{
        version: string;
        electron?: string;
        node?: string;
        platform?: string;
        cpus?: number;
        cpuPhysicalCores?: number;
        cpuLogicalCores?: number;
        cpuModel?: string;
        cpuTopology?: string;
      }>;
      ffmpegStatus: () => Promise<{
        ok: boolean;
        path: string;
        version: string | null;
        error: string | null;
        /** v1.5: which ffmpeg build is in use + its compiled capabilities —
         *  the facts that decide export speed on an install (full build →
         *  NVENC/QSV/AMF possible + ffprobe-backed fast probes). */
        build?: "bundled-full" | "ffmpeg-static" | "system-path";
        hasFfprobe?: boolean;
        hasNvenc?: boolean;
        hasQsv?: boolean;
        hasAmf?: boolean;
        hasLibass?: boolean;
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
      /** v5.1: result of the async GPU-encoder probe (export-tab badge).
       *  v8.1 (Task 27-b): `forced` is true when a force-encoder override
       *  bypassed the probe (Export-tab diagnostics dropdown).
       *  v1.13: also carries the Adaptive Hardware Matrix tier (workers ×
       *  threads, CPU model, subtitle treatment) for the Export-tab tier
       *  chip + the About strip. */
      getExportInfo: () => Promise<{
        encoder: string;
        encoderName: string;
        forced?: boolean;
        tier?: string;
        tierLabel?: string;
        workers?: number;
        threadsPerWorker?: number;
        filterWorkers?: number;
        cpuCount?: number;
        cpuLogical?: number;
        cpuPhysical?: number;
        cpuTopology?: string;
        cpuModel?: string;
        optimizeSubtitles?: boolean;
        /** v1.18: the native Rust engine's load status (version/binary or
         *  the load error) — the engine badge + diagnostics line. v1.22:
         *  lastFailure = the most recent reason an export bypassed the
         *  engine (gate / timeline / runtime). */
        rustEngine?: {
          loaded: boolean;
          version?: string | null;
          binary?: string | null;
          error?: string | null;
          lastFailure?: { at: number; stage: string; reason: string } | null;
        };
      }>;
      /** ── v1.22 NATIVE ENGINE DIAGNOSTICS ── */
      /** The Rust engine's load state + the LAST bypass reason + the loader's
       *  candidate-path diagnostics — the "why is it falling back" answer. */
      engineStatus?: () => Promise<{
        loaded: boolean;
        version?: string | null;
        binary?: string | null;
        from?: string | null;
        error?: string | null;
        lastFailure?: { at: number; stage: string; reason: string } | null;
        diagnostics?: {
          binary: string;
          platform: string;
          electron: boolean;
          attempts: Array<{ path: string; ok: boolean; error?: string }>;
          loadError: string | null;
        } | null;
      }>;
      /** Runs a REAL 36-frame mini export through the Rust engine in THIS
       *  runtime — the definitive health check (engineUsed/encoder/adapter
       *  + wall time on pass, the exact error + stage on fail). */
      engineSelfTest?: () => Promise<{
        ok: boolean;
        stage?: string;
        error?: string;
        engineUsed?: string;
        encoderName?: string;
        adapter?: string;
        ffmpegFamily?: string;
        frames?: number;
        wallMs?: number;
        outputBytes?: number;
        dllDir?: string;
        status?: unknown;
      }>;
      /** v8.1 (Task 27-b): force-encoder probe bypass (diagnostics).
       *  key ∈ null | "nvenc" | "qsv" | "amf" | "x264"; null restores the
       *  auto-probe. Returns the re-resolved encoder for one round trip. */
      setForceEncoder?: (key: string | null) => Promise<{
        ok: boolean;
        forced: string | null;
        encoder: string;
        encoderName: string;
        error?: string;
      }>;
      /** ── v1.20 Whisper (Groq Cloud — the ONLY transcription engine) ──
       * transcribe: main extracts compact audio via ffmpeg and calls the Groq
       * Whisper API (user's on-device key); progress streams via
       * onWhisperProgress. v1.3: `sourcePath` (zero-copy local file). No key
       * saved → a clear actionable error (no local fallback exists). */
      whisperTranscribe: (p: {
        name: string;
        bytes?: ArrayBuffer;
        sourcePath?: string;
        language?: string;
        runId?: string;
        /** v1.20: STT routing — always "groq" (the only engine). */
        engine?: "groq";
        /** v1.15: Groq model override (whisper-large-v3-turbo | whisper-large-v3). */
        groqModel?: string;
      }) => Promise<{
        chunks: Array<{ text: string; timestamp: [number | null, number | null] }> | null;
        language: string | null;
        wordLevel: boolean;
        durationMs: number;
        engine?: string;
      }>;
      whisperCancel: () => Promise<number>;
      onWhisperProgress: (cb: (d: { progress: number; status: string }) => void) => () => void;
      /** v1.15: Groq Whisper API configuration. The key is the USER'S OWN and
       *  lives only on this device (userData/groq.json, 0600) — the bridge
       *  returns a MASKED form only, never the raw key. */
      whisperGroqGet?: () => Promise<GroqConfigPayload>;
      /** { apiKey?: string ("" clears), model?: string } → same payload as get. */
      whisperGroqSet?: (p: { apiKey?: string; model?: string }) => Promise<GroqConfigPayload>;
      /** { apiKey?: string } → { ok, message, whisperModels } — key check. */
      whisperGroqTest?: (p: { apiKey?: string }) => Promise<{
        ok: boolean;
        message: string;
        whisperModels: string[];
      }>;
      /** ── v1.17 Edge TTS (voiceover + dubbing) ── */
      /** Voice catalog + per-locale female/male default pairs. */
      ttsVoices?: () => Promise<{
        voices: Array<{
          shortName: string;
          gender: string;
          locale: string;
          friendlyName: string;
          displayName: string;
          /** v1.25: advertised express-as styles (rare on the free endpoint). */
          styleList?: string[];
        }>;
        pairs: Record<string, { female: string; male: string }>;
      }>;
      /** Short sample of a voice, played back in the pickers BEFORE the
       *  user commits to it. Single-flight: a new preview cancels the old. */
      ttsPreview?: (p: {
        voice: string;
        text?: string;
        style?: string;
      }) => Promise<{ bytes: ArrayBuffer; bytesLen: number }>;
      /** Full narration synthesis → MP3 bytes + measured duration.
       *  v1.25: returns WORD-LEVEL timings too. */
      ttsSynthesize?: (p: {
        text: string;
        voice: string;
        ratePct?: number;
        pitchHz?: number;
        volumePct?: number;
        style?: string;
      }) => Promise<{
        filePath: string;
        bytes: ArrayBuffer;
        durationMs: number;
        words?: Array<{ text: string; offsetMs: number; durationMs: number }>;
      }>;
      /** v1.25 LONG-FORM TTS: up to ~200,000 words are chunked main-side
       *  (sentence-aware, 3 in flight) and merged into ONE MP3; `words`
       *  carry GLOBAL timings. The merged bytes stay main-side — fetch them
       *  for playback with ttsReadAudio. ONE long run at a time; progress
       *  arrives via onTtsProgress; cancel with ttsCancelLong(runId). */
      ttsSynthesizeLong?: (p: {
        runId: string;
        text: string;
        voice: string;
        ratePct?: number;
        pitchHz?: number;
        volumePct?: number;
        style?: string;
      }) => Promise<{
        filePath: string;
        fileName: string;
        bytesLen: number;
        durationMs: number;
        chunkCount: number;
        words: Array<{ text: string; offsetMs: number; durationMs: number }>;
      }>;
      /** Aborts the active long run (no-op when none / id mismatch). */
      ttsCancelLong?: (runId: string) => Promise<{ ok: boolean; running: boolean }>;
      /** Reads an MP3 the main process wrote into its temp dir (path
       *  guarded, ≤200 MB) so the renderer can build a playback Blob. */
      ttsReadAudio?: (p: {
        filePath: string;
      }) => Promise<{ bytes: ArrayBuffer; bytesLen: number }>;
      /** Long-run progress events (filter by runId). */
      onTtsProgress?: (cb: (d: {
        runId: string;
        phase: "synth" | "probe" | "done";
        chunkIndex?: number;
        chunkCount?: number;
        charsDone?: number;
        totalChars?: number;
        status: string;
        durationMs?: number;
      }) => void) => () => void;
      /** ── v1.17 Groq dubbing (transcribe → speakers → translate → TTS) ── */
      dubStart?: (p: {
        segments: Array<{ videoPath: string; startMs: number; endMs?: number }>;
        sourceLanguage?: string;
        targetLanguage: string;
        targetLocale: string;
        groqModel?: string;
        /** v1.22: "gemini" routes the speaker/translation phases through
         *  the Gemini key (geminiModel); "groq" (default) uses groqModel.
         *  Whisper transcription is always Groq. */
        textProvider?: "groq" | "gemini";
        geminiModel?: string;
        femaleVoice?: string;
        maleVoice?: string;
        /** v1.20: "single" = one voice for every line (skips speaker
         *  detection); "multi"/absent = per-speaker voices. */
        voiceMode?: "single" | "multi";
        /** v1.20 single-voice mode: Edge-TTS ShortName for the one voice
         *  (empty/null = the locale pair's default female). */
        singleVoice?: string | null;
        ttsRatePct?: number;
      }) => Promise<DubTrackResult>;
      dubCancel?: () => Promise<{ ok: boolean; running: boolean }>;
      /** Free-tier chat model list + defaults (no key needed). v1.22 adds
       *  the Gemini list + key presence for the provider picker. */
      dubModels?: () => Promise<{
        models: Array<{ id: string; label: string; hint: string }>;
        default: string;
        langNames: Record<string, string>;
        gemini?: {
          models: Array<{ id: string; label: string; hint: string }>;
          default: string;
          hasKey: boolean;
        };
      }>;
      onDubProgress?: (cb: (d: {
        phase: string;
        progress: number;
        status: string;
      }) => void) => () => void;
      /** ── v1.20 AI script writing (Gemini default + Groq) ── */
      /** Masked Gemini key state — the raw key never crosses the bridge
       *  (userData/gemini.json, 0600, device-local only). */
      geminiGet?: () => Promise<GeminiConfigPayload>;
      /** Stores the key on-device → the masked payload. */
      geminiSet?: (p: { apiKey: string }) => Promise<GeminiConfigPayload>;
      /** { apiKey? } → { ok, message, modelCount, models? } — key check
       *  (saved or candidate) against GET /v1beta/models. v1.22: `models`
       *  is the LIVE generateContent-capable list the key can see. */
      geminiTest?: (p: {
        apiKey?: string;
      }) => Promise<{
        ok: boolean;
        message: string;
        modelCount: number;
        models?: Array<{ id: string; label: string }>;
      }>;
      /** Removes the stored Gemini key → { ok }. */
      geminiClear?: () => Promise<{ ok: boolean }>;
      /** Generates one narration script with the selected provider/model.
       *  Never rejects with a user-facing failure — { ok:false, error } is
       *  the failure path and the renderer shows `error` inline. */
      scriptGenerate?: (p: {
        provider: "gemini" | "groq";
        model: string;
        prompt: string;
        tone?: string;
        durationSec?: number;
        language?: string;
      }) => Promise<
        | { ok: true; text: string; model: string; provider: "gemini" | "groq" }
        | { ok: false; error: string }
      >;
      /** Script Writer model picker data (both providers + key presence). */
      scriptModels?: () => Promise<ScriptModelCatalog>;
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
