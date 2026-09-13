"use client";

// src/components/TimelineRuler.tsx — FrameFuse timeline (ruler + tracks)
//
// v5.0: 4-LANE multi-track editor (Task 7-a, frozen 5-c spec).
//   VIDEO lane   — the v4.9 filmstrip bars (track 0), transition zones,
//                  headline chips, beat rail — rendering preserved verbatim.
//   OVERLAY lane — track >= 1 clips as compact rounded bars, greedy sub-row
//                  packing (max 3 visible rows), drag to move / edge-trim /
//                  vertical drag >= 24px switches track 1<->0.
//   AUDIO lane   — the v4.7 waveform strip on its own labeled lane.
//   SFX lane     — SfxItem pills (click = seek to start, drag = move,
//                  Alt+click / hover x = remove).
//
// COMPATIBILITY: every new prop is OPTIONAL. When none of them is passed the
// component renders the exact v4.9 single-track layout (base filmstrip +
// waveform + headline markers + beats), so page.tsx keeps compiling and
// behaving unchanged until the 7-d integration wires the v5 state.

import {
  useRef,
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  Type,
  AudioLines,
  Clapperboard,
  Copy,
  Layers,
  Maximize,
  Music2,
  Play,
  Repeat,
  Scissors,
  Timer,
  Trash2,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type {
  HeadlineItem,
  ItemEdit,
  MediaSegment,
  SfxItem,
  TimelineMode,
  TransitionSettings,
  TransitionStyle,
} from "@/lib/merger/types";
import { boundaryStyle } from "@/lib/merger/types";
import { fmtTimecode } from "@/lib/merger/timeline";
import { getSfxDef, sfxDurationMs } from "@/lib/merger/sfx";
import { middleEllipsis } from "@/lib/merger/text";
import type { WaveformData } from "@/lib/merger/waveform";
import { cn } from "@/lib/utils";

interface TimelineRulerProps {
  segments: MediaSegment[];
  totalMs: number;
  currentMs: number;
  mode: TimelineMode | null;
  activeId: string | null;
  /** Headline overlay items → clickable marker chips (v4.3). */
  headlines: HeadlineItem[];
  /** Segment transitions → boundary zone visualization (v4.3). */
  transition: TransitionSettings;
  /** Detected beat times (v4.6) → cyan tick rail + live pulse. */
  beats: number[] | null;
  /** Audio waveform (v4.7) → mirrored peak strip between ruler and bars. */
  waveform: WaveformData | null;
  onSeek: (ms: number) => void;
  /** v4.9: jump to a segment's first frame (filmstrip double-click). */
  onJumpToSegment?: (id: string) => void;
  /** v5: overlay-lane editing — patch an item edit (move/trim/track). */
  onEditItem?: (id: string, patch: Partial<ItemEdit>) => void;
  /** v5: SFX items rendered as draggable pills on their own lane. */
  sfxItems?: SfxItem[];
  /** v5: move an SFX item to a new start time (ms). */
  onMoveSfx?: (id: string, startMs: number) => void;
  /** v5.3: patch an SFX item (duration resize from the pill edges). */
  onEditSfx?: (id: string, patch: Partial<SfxItem>) => void;
  /** v5: remove an SFX item. */
  onRemoveSfx?: (id: string) => void;
  /** v5: video source durations (id → ms) for trim clamping. */
  videoDurations?: Record<string, number>;
  /** v5.1: split the ACTIVE base clip at the playhead (toolbar / S key). */
  onSplit?: () => void;
  /** v5.1: duplicate the active segment (toolbar Copy). */
  onDuplicate?: (id: string) => void;
  /** v5.1: remove the active segment (toolbar Trash / Delete key). */
  onRemove?: (id: string) => void;
  /** v5.1: the active BASE segment (toolbar enable states + duration chip). */
  activeSegment?: MediaSegment | null;
  /** v5.2: background music placement — the audio lane renders a DRAGGABLE
   *  music clip (move to reposition, hover popover for volume + loop). */
  musicStartMs?: number;
  musicLoop?: boolean;
  musicVolume?: number;
  /** Music track duration (audioTrack.durationMs) — drives the clip width. */
  musicDurationMs?: number | null;
  musicName?: string | null;
  onMusicMove?: (startMs: number) => void;
  onMusicLoopChange?: (loop: boolean) => void;
  onMusicVolumeChange?: (volume: number) => void;
  /** v5.4: multi-select — ids of the currently SELECTED clips (base +
   *  overlay lanes). Selection is a user-intent concept (click /
   *  Ctrl-click / Shift-click / marquee drag / Ctrl+A), distinct from the
   *  playhead-derived activeId. Empty/undefined = no selection. */
  selectedIds?: string[];
  /** v5.4: selection changed (plain click selects solo, Ctrl toggles, Shift
   *  ranges, marquee bands select, empty-space clicks clear). */
  onSelectionChange?: (ids: string[]) => void;
  /** v5.4: remove MANY clips in ONE undo step (toolbar trash + Delete key
   *  act on the selection when present). */
  onRemoveMany?: (ids: string[]) => void;
}

// v4.9: bar tints — the segment bar is now a FILMSTRIP (thumbnail shows
// through), so these gradients are translucent kind-tints layered over the
// image instead of opaque fills. Kind still reads at a glance, but the
// actual storyboard content is the hero (VLM: "mystery meat" bars).
const BAR_BG: Record<string, { top: string; bottom: string }> = {
  absolute: {
    top: "rgba(34, 211, 238, 0.30)",
    bottom: "rgba(8, 145, 178, 0.52)",
  },
  beat: {
    top: "rgba(16, 185, 129, 0.28)",
    bottom: "rgba(6, 95, 70, 0.50)",
  },
  duration: {
    top: "rgba(139, 92, 246, 0.28)",
    bottom: "rgba(91, 33, 182, 0.50)",
  },
};

// ---------------------------------------------------------------------------
// v5.0 lane metrics (px) — the 4-lane stack.
// ---------------------------------------------------------------------------
/** Left gutter width for the lane labels (Clapperboard/Layers/AudioLines/Zap). */
const GUTTER_W = 64;
const TICKS_H = 18;
/** Base lane body (v4.9 bar zone height, ~44px of filmstrips + chips strip). */
const BASE_H = 60;
const AUDIO_H = 34;
const SFX_H = 30;
/** Overlay sub-row packing. 3 rows max => lane height 6 + 66 + 4 = 76px. */
const OV_ROW_H = 22;
const OV_GAP = 2;
const OV_PAD = 3;
const OV_EMPTY_H = 28;
const MAX_OV_ROWS = 3;
/** Vertical drag distance that flips a clip between lanes (spec: >= 24px). */
const LANE_SWITCH_PX = 24;
/** Pointer travel before a press becomes a drag (suppresses click seeks). */
const DRAG_DEADZONE_PX = 3;
/** Drag snapping grid (ms). */
const SNAP_MS = 10;
const MIN_DUR_MS = 200;
const MAX_DUR_MS = 300000;

const ROW_BORDER = "rgba(39, 39, 42, 0.55)";
const GUTTER_BORDER = "rgba(39, 39, 42, 0.45)";
/** v5.1 lane banding: subtle alternating #101012 / #0d0d0f so each lane
 *  reads as its own track without hard separators; the audio lane goes
 *  cyan-900/20-tinted while a waveform is loaded. */
const LANE_BG_A = "#101012";
const LANE_BG_B = "#0d0d0f";
const LANE_BG_WAVE = "rgba(22, 78, 99, 0.2)";

function niceStep(totalMs: number): number {
  const totalSec = totalMs / 1000;
  const targets = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const t of targets) {
    if (totalSec / t <= 12) return t * 1000;
  }
  return 600 * 1000;
}

// ---------------------------------------------------------------------------
// v5.1 PIXEL ZOOM — the timeline axis is laid out in px, not percentages.
// ---------------------------------------------------------------------------

/** Zoom range (px per timeline second). */
const ZOOM_MIN = 4;
const ZOOM_MAX = 400;
/** Ruler ticks stay ≥ this many px apart (readable timecodes). */
const TICK_MIN_PX = 70;

function clampPxPerSec(v: number): number {
  const n = Number.isFinite(v) ? v : ZOOM_MIN;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, n));
}

/** v5.1 adaptive ruler step: the first step from the ms ladder whose px
 * spacing is ≥ 70px, so labels never collide at any zoom. */
function niceStepPx(pxPerSec: number): number {
  const steps = [100, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000];
  for (const s of steps) {
    if ((s / 1000) * pxPerSec >= TICK_MIN_PX) return s;
  }
  return 60000;
}

/** Pixel layout mode for the shared lane components: when present, every
 * left/width is computed in px via pxOf() instead of % of the axis. */
interface TimelinePxLayout {
  pxOf: (ms: number) => number;
}

/** Round to the v5 drag snap grid (10 ms). */
function snapMs(v: number): number {
  return Math.round(v / SNAP_MS) * SNAP_MS;
}

/**
 * CSS `left` for a ratio of the TIME AXIS (right of the gutter), positioned
 * inside the full-width lanes wrapper. calc() lets one continuous playhead
 * span all lanes without measuring the axis width from JS.
 */
function axisLeftCss(ratio: number): string {
  const r = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  return `calc(${GUTTER_W}px + (100% - ${GUTTER_W}px) * ${r})`;
}

// ---------------------------------------------------------------------------
// v5.0 drag machinery (types + pure math)
// ---------------------------------------------------------------------------

/** One active pointer gesture. Ref-held; committed on pointerup, aborted on
 *  pointercancel / lostpointercapture. Never touches parent state mid-drag. */
type DragInfo =
  | {
      kind: "clip";
      id: string;
      gesture: "move" | "trim-l" | "trim-r";
      pointerId: number;
      startX: number;
      startY: number;
      msPerPx: number;
      didDrag: boolean;
      origStart: number;
      origDur: number;
      origTrim: number;
      origTrack: number;
      mediaType: "image" | "video";
      sourceDur: number | null;
      /** Base-lane horizontal moves only apply in absolute mode. */
      allowH: boolean;
      /** v5.1: resolved playback speed — durationMs is timeline time, trimInMs
       * is SOURCE time; the trim-l gesture converts between them (× speed). */
      speed: number;
      /** v5.2: looped overlays may extend past the source window (their
       * source repeats to fill the timeline window). */
      overlayLoop: boolean;
      /** v5.3: BASE-lane trim clamps — the trim-l start may not cross the
       * previous base clip's end, and a trim-r extension may not cross the
       * next base clip's start (Infinity / 0 when unbounded). */
      minStartMs: number;
      maxEndMs: number;
    }
  | {
      kind: "sfx";
      id: string;
      /** v5.3: move | resize-l | resize-r (pill edge handles). */
      gesture: "move" | "resize-l" | "resize-r";
      pointerId: number;
      startX: number;
      msPerPx: number;
      didDrag: boolean;
      origStart: number;
      origDur: number;
    };

/** Live drag feedback mirrored into render (local state; parent state only
 *  changes on commit — the v4.9 scrub pattern, no re-render storms). */
type DragPreview =
  | {
      kind: "clip";
      id: string;
      gesture: "move" | "trim-l" | "trim-r";
      startMs: number;
      durationMs: number;
      /** Absolute target lane while a vertical switch is past the threshold. */
      targetTrack: number | undefined;
      /** Track the clip currently lives on (drop-target highlight source). */
      origTrack: number;
    }
  | {
      kind: "sfx";
      id: string;
      gesture: "move" | "resize-l" | "resize-r";
      startMs: number;
      durMs: number;
    };

/** Max trimmable TIMELINE duration for a clip (video: the remaining SOURCE
 * window divided by speed — v5.1 scaled clamp; else 300 s). */
function maxDurFor(d: Extract<DragInfo, { kind: "clip" }>): number {
  if (
    d.mediaType === "video" &&
    d.sourceDur != null &&
    d.sourceDur > 0 &&
    // v5.2: a LOOPED overlay repeats its source, so the timeline window is
    // no longer capped by the source length.
    !d.overlayLoop
  ) {
    const speed = d.speed > 0 ? d.speed : 1;
    return Math.min(
      MAX_DUR_MS,
      Math.max(MIN_DUR_MS, (d.sourceDur - d.origTrim) / speed),
    );
  }
  return MAX_DUR_MS;
}

/**
 * Pure math for one clip gesture at a pointer position — shared by the live
 * preview (pointermove) and the final commit (pointerup), so both always agree.
 *
 *  move    : startMs = orig + dx (snapped, clamped [0, totalMs]); vertical
 *            travel >= 24px flips targetTrack (overlay down -> 0, base up -> 1).
 *  trim-l  : slides the window — startMs + durationMs move together, and for
 *            video trimInMs slides in SOURCE time (delta · speed, v5.1) so the
 *            same footage keeps playing. Constraints: start >= 0, duration in
 *            [200, maxDur] (timeline), trimIn >= 0 (source).
 *  trim-r  : durationMs = orig + dx (snapped, clamped [200, maxDur]).
 */
function computeClipDrag(
  d: Extract<DragInfo, { kind: "clip" }>,
  clientX: number,
  clientY: number,
  totalMs: number,
): {
  startMs: number;
  durationMs: number;
  trimInMs: number;
  targetTrack: number | undefined;
  horizAllowed: boolean;
} {
  const speed = d.mediaType === "video" && d.speed > 0 ? d.speed : 1;
  const dx = clientX - d.startX;
  const dy = clientY - d.startY;
  if (d.gesture === "move") {
    let targetTrack: number | undefined;
    if (d.origTrack >= 1) {
      if (dy >= LANE_SWITCH_PX) targetTrack = 0;
    } else if (dy <= -LANE_SWITCH_PX) {
      targetTrack = 1;
    }
    const horizAllowed = d.origTrack >= 1 || d.allowH;
    let startMs = d.origStart;
    if (horizAllowed) {
      const hi = Math.max(0, totalMs);
      // v5.3: base-lane moves stay clear of the previous clip too (same
      // neighbor rule as trim-l — the base lane is a non-overlap zone).
      const lo = d.origTrack === 0 ? d.minStartMs : 0;
      startMs = Math.max(
        lo,
        Math.min(hi, snapMs(d.origStart + dx * d.msPerPx)),
      );
    }
    return {
      startMs,
      durationMs: d.origDur,
      trimInMs: d.origTrim,
      targetTrack,
      horizAllowed,
    };
  }
  const maxDur = maxDurFor(d);
  if (d.gesture === "trim-l") {
    // delta (TIMELINE ms) moves start+duration together. Constraints:
    //   start >= 0              => delta >= -origStart
    //   duration <= maxDur      => delta >= origDur - maxDur
    //   duration >= 200         => delta <= origDur - 200
    //   video trimIn >= 0       => delta·speed >= -origTrim (source clamp,
    //                             v5.1 — the window slides in source time)
    const deltaMin = Math.max(
      -d.origStart,
      d.origDur - maxDur,
      d.mediaType === "video" ? -d.origTrim / speed : -Infinity,
      // v5.3 base lane: the previous clip's end bounds the slide.
      d.origTrack === 0 ? d.minStartMs - d.origStart : -Infinity,
    );
    const deltaMax = d.origDur - MIN_DUR_MS;
    const rawDelta = Math.min(deltaMax, Math.max(deltaMin, dx * d.msPerPx));
    // Snap the resulting start, then re-clamp (snap can overshoot by <10ms).
    let ns = snapMs(d.origStart + rawDelta);
    ns = Math.max(d.origStart + deltaMin, Math.min(d.origStart + deltaMax, ns));
    const delta = ns - d.origStart;
    return {
      startMs: ns,
      durationMs: d.origDur - delta,
      trimInMs: Math.round(d.origTrim + delta * speed),
      targetTrack: undefined,
      horizAllowed: false,
    };
  }
  // trim-r — v5.3: on the base lane the extension may not cross the NEXT
  // clip's start (a trim never silently swallows a neighbor).
  const neighborCap =
    d.origTrack === 0 && Number.isFinite(d.maxEndMs)
      ? d.maxEndMs - d.origStart
      : Infinity;
  const durHi = Math.min(maxDur, neighborCap);
  const nd = snapMs(d.origDur + dx * d.msPerPx);
  return {
    startMs: d.origStart,
    durationMs: Math.max(MIN_DUR_MS, Math.min(Math.max(MIN_DUR_MS, durHi), nd)),
    trimInMs: d.origTrim,
    targetTrack: undefined,
    horizAllowed: false,
  };
}

/** SFX pill gesture math (v5.3: move + edge resizes).
 *  move     : start = orig + dx, snapped, clamped [0, totalMs].
 *  resize-r : dur = orig + dx, snapped, clamped [MIN_SFX_DUR, MAX_SFX_DUR].
 *  resize-l : start+dur slide together (end pinned) with a MIN duration. */
const MIN_SFX_DUR_MS = 40;
const MAX_SFX_DUR_MS = 10000;
function computeSfxDrag(
  d: Extract<DragInfo, { kind: "sfx" }>,
  clientX: number,
  totalMs: number,
): { startMs: number; durMs: number } {
  const hi = Math.max(0, totalMs);
  const dx = clientX - d.startX;
  if (d.gesture === "resize-r") {
    const nd = snapMs(d.origDur + dx * d.msPerPx);
    return {
      startMs: d.origStart,
      durMs: Math.min(MAX_SFX_DUR_MS, Math.max(MIN_SFX_DUR_MS, nd)),
    };
  }
  if (d.gesture === "resize-l") {
    // End pinned: newStart = orig + delta, newDur = origDur - delta.
    let ns = snapMs(d.origStart + dx * d.msPerPx);
    ns = Math.max(
      Math.min(hi - MIN_SFX_DUR_MS, d.origStart + d.origDur - MIN_SFX_DUR_MS),
      Math.max(0, ns),
    );
    const delta = ns - d.origStart;
    return {
      startMs: ns,
      durMs: Math.min(
        MAX_SFX_DUR_MS,
        Math.max(MIN_SFX_DUR_MS, d.origDur - delta),
      ),
    };
  }
  // move
  return {
    startMs: Math.max(
      0,
      Math.min(hi, snapMs(d.origStart + dx * d.msPerPx)),
    ),
    durMs: d.origDur,
  };
}

interface OverlayLayoutEntry {
  seg: MediaSegment;
  row: number;
}

/**
 * Greedy sub-row packing for the overlay lane (by start time, then order).
 * Overlapping overlays stack in rows; at most MAX_OV_ROWS rows — anything
 * beyond packs into the densest (min-end) row and visually overlaps, which
 * keeps every clip visible and the lane height capped.
 */
function packOverlayRows(segs: MediaSegment[]): {
  entries: OverlayLayoutEntry[];
  rows: number;
} {
  const sorted = [...segs].sort(
    (a, b) => a.startMs - b.startMs || a.order - b.order,
  );
  const rowEnds: number[] = [];
  const entries: OverlayLayoutEntry[] = [];
  for (const seg of sorted) {
    let row = rowEnds.findIndex((end) => seg.startMs >= end);
    if (row === -1) {
      if (rowEnds.length < MAX_OV_ROWS) {
        rowEnds.push(seg.endMs);
        row = rowEnds.length - 1;
      } else {
        row = 0;
        for (let i = 1; i < rowEnds.length; i++) {
          if (rowEnds[i] < rowEnds[row]) row = i;
        }
        rowEnds[row] = Math.max(rowEnds[row], seg.endMs);
      }
    } else {
      rowEnds[row] = Math.max(rowEnds[row], seg.endMs);
    }
    entries.push({ seg, row });
  }
  return { entries, rows: Math.max(1, rowEnds.length) };
}

// ---------------------------------------------------------------------------
// Shared visuals (used by BOTH the v4.9 single-track path and the v5 lanes —
// extracted verbatim so the legacy rendering is pixel-identical).
// ---------------------------------------------------------------------------

/** Legend dot — v4.7: larger + ringed so colors read on any background. */
function LegendDot({ color, gradient }: { color?: string; gradient?: string }) {
  return (
    <span
      className="size-2.5 shrink-0 rounded-[3px] ring-1 ring-inset"
      style={{
        backgroundColor: color,
        backgroundImage: gradient,
        // @ts-expect-error CSS custom prop for the ring tint
        "--tw-ring-color": "rgba(255,255,255,0.18)",
        boxShadow: "0 1px 2px rgba(0,0,0,0.5)",
      }}
    />
  );
}

/**
 * Waveform strip (v4.7) — canvas-rendered mirrored peaks.
 * Static pass (dim bars) is cached in an offscreen canvas keyed by
 * waveform+width; per-frame work is one blit + bright bars up to the
 * playhead — safe to redraw at 30–60 fps during playback.
 * v5: optional `className` repositions the strip (the audio lane mounts it
 * edge-to-edge); the default keeps the exact v4.9 placement.
 */
function WaveformStrip({
  data,
  totalMs,
  currentMs,
  startMs = 0,
  loop = false,
  className = "pointer-events-none absolute left-1.5 right-1.5 top-[16px] h-[26px]",
}: {
  data: WaveformData;
  totalMs: number;
  currentMs: number;
  /** v5.2: timeline offset where the music starts (draggable clip). */
  startMs?: number;
  /** v5.2: repeat the waveform to fill the whole timeline (loop-to-fill). */
  loop?: boolean;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cacheRef = useRef<{ key: string; off: HTMLCanvasElement | null }>({
    key: "",
    off: null,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const draw = () => {
      const cssW = parent.clientWidth;
      const cssH = parent.clientHeight;
      if (cssW <= 0 || cssH <= 0) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      // v5.2: the wave is anchored at startMs and spans either one pass of
      // the track (startMs + durationMs, clamped to the timeline) or — when
      // looping — repeats until the timeline end. Legacy callers (startMs 0,
      // no loop) keep the exact v4.9 mapping.
      const durMs = Math.max(0, data.durationMs);
      const msToPx = totalMs > 0 ? cssW / totalMs : 0;
      const x0 = Math.max(0, Math.min(cssW, startMs * msToPx));
      const spanMs = loop ? Math.max(0, totalMs - startMs) : Math.min(durMs, Math.max(0, totalMs - startMs));
      const waveW = Math.max(8, Math.min(cssW - x0, spanMs * msToPx));
      const reps = loop && durMs > 0 ? Math.max(1, Math.ceil(spanMs / durMs)) : 1;
      const repW = durMs > 0 ? Math.min(waveW, durMs * msToPx) : waveW;
      const mid = cssH / 2;
      const maxBar = cssH / 2 - 1;

      // Static pass → offscreen cache (peaks don't change with the playhead).
      // Key includes the decode id — two tracks with identical bucket count
      // and duration must never share a stale bitmap.
      const key = `${data.id}:${repW.toFixed(1)}:${cssH}:${dpr}`;
      let off = cacheRef.current.key === key ? cacheRef.current.off : null;
      if (!off) {
        off = document.createElement("canvas");
        off.width = Math.max(1, Math.round(repW * dpr));
        off.height = canvas.height;
        const octx = off.getContext("2d");
        if (octx) {
          octx.setTransform(dpr, 0, 0, dpr, 0, 0);
          // Full-brightness bars — the blit below applies the dim alpha.
          // v4.8: desaturated sky (VLM: bright cyan strobed).
          octx.fillStyle = "#7dd3fc";
          const n = data.peaks.length;
          const barW = repW / n;
          for (let i = 0; i < n; i++) {
            const h = Math.max(1, data.peaks[i] * maxBar);
            const x = i * barW;
            octx.fillRect(x, mid - h, Math.max(0.8, barW - 0.5), h * 2);
          }
        }
        cacheRef.current = { key, off };
      }

      // Blit the dim pass (repeat for each loop iteration).
      ctx.globalAlpha = 0.3;
      for (let r = 0; r < reps; r++) {
        ctx.drawImage(off, x0 + r * repW, 0, repW, cssH);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(125, 211, 252, 0.48)";

      // Bright pass: bars up to the playhead, AUDIO-relative (the wave maps
      // 0..durationMs → 0..repW; looping wraps at each iteration boundary).
      const relMs = currentMs - startMs;
      const brightPx =
        relMs <= 0
          ? 0
          : loop && durMs > 0
            ? ((relMs % durMs) / durMs) * repW + Math.floor(relMs / durMs) * repW
            : (Math.max(0, Math.min(1, relMs / (durMs || 1))) * repW);
      const n = data.peaks.length;
      const barW = repW / n;
      for (let r = 0; r < reps; r++) {
        const base = r * repW;
        // Bars bright within this rep = how far brightPx reaches into it.
        const upto = Math.max(
          0,
          Math.min(n, Math.floor(((brightPx - base) / Math.max(1, repW)) * n)),
        );
        for (let i = 0; i < upto; i++) {
          const h = Math.max(1, data.peaks[i] * maxBar);
          const x = x0 + base + i * barW;
          ctx.fillRect(x, mid - h, Math.max(0.8, barW - 0.5), h * 2);
        }
      }

      // Hairline baseline.
      ctx.globalAlpha = 0.25;
      ctx.fillRect(x0, mid - 0.5, waveW, 1);
      ctx.globalAlpha = 1;
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [data, totalMs, currentMs, startMs, loop]);

  return (
    <div
      className={className}
      title="Audio waveform — bright bars show playback progress"
    >
      <canvas ref={canvasRef} className="block size-full" />
    </div>
  );
}

/** Ruler ticks + timecode labels (v4.9 markup, shared by both layouts).
 *  v5.1: `layout` switches positions to px (adaptive step spacing); the
 *  default keeps the v4.9 %-of-axis placement. */
function TickRow({
  ticks,
  totalMs,
  layout,
}: {
  ticks: number[];
  totalMs: number;
  layout?: TimelinePxLayout;
}) {
  return (
    <div className="absolute inset-0">
      {ticks.map((t) => {
        const left = layout
          ? layout.pxOf(t)
          : totalMs > 0
            ? (t / totalMs) * 100
            : 0;
        return (
          <div
            key={t}
            className="absolute top-0 h-full"
            style={layout ? { left } : { left: `${left}%` }}
          >
          <div
            className="h-1.5 w-px"
            style={{ backgroundColor: "#52525b" }}
          />
          <span
            className="mt-0.5 block -translate-x-1/2 text-[10px] font-medium leading-none tabular-nums"
            style={{ color: "#a1a1aa" }}
          >
            {fmtTimecode(t)}
          </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Playhead — v5.1 CapCut look: ONE continuous 2px cyan line spanning all
 * lanes plus a small glowing triangle grabber at the top (clip-path). Dark
 * side shadows keep it readable over bars and waveform (v4.7 heritage).
 * `grab` (optional) hands the ruler's OWN scrub handlers to the triangle:
 * pressing it seeks and dragging scrubs through the exact same code path —
 * no new interaction logic, the grabber is simply part of the ruler.
 */
function Playhead({
  leftCss,
  grab,
}: {
  leftCss: CSSProperties;
  /** Partial scrub-handler set — the ruler passes its own scrubHandlers so
   *  the triangle seeks/scrubs through the existing code path. */
  grab?: Partial<FilmstripBarDrag>;
}) {
  return (
    <div
      className="pointer-events-none absolute top-0 z-10 h-full"
      style={leftCss}
    >
      {/* Triangle grabber — 12×9px, centered on the line, poking into the
                7px scrollport rail above the ruler; glows via the
                .ff-playhead-grab soft pulse in globals.css. */}
      <div
        {...(grab ?? {})}
        aria-hidden
        title={grab ? "Playhead — press and drag to scrub" : undefined}
        className={cn(
          "ff-playhead-grab absolute -top-[7px] h-[9px] w-[12px]",
          grab && "pointer-events-auto cursor-ew-resize touch-none",
        )}
        style={{
          left: -5,
          clipPath: "polygon(50% 0%, 100% 100%, 0% 100%)",
          backgroundColor: "#22d3ee",
          boxShadow:
            "0 0 8px rgba(34, 211, 238, 0.75), 0 1px 2px rgba(0,0,0,0.6)",
        }}
      />
      {/* The 2px cyan spine. */}
      <div
        className="absolute left-0 top-0 h-full w-0.5"
        style={{
          backgroundColor: "#22d3ee",
          boxShadow:
            "0 0 6px rgba(34, 211, 238, 0.65), 1px 0 3px rgba(0,0,0,0.65), -1px 0 3px rgba(0,0,0,0.65)",
        }}
      />
    </div>
  );
}

/**
 * v4.8: hover ghost — dashed hairline + timecode chip previewing where a
 * click/scrub would land (hidden while dragging: the real playhead is
 * already under the cursor then). v5: spans all lanes via `leftCss`.
 */
function HoverGhost({
  leftCss,
  top,
  label,
}: {
  leftCss: CSSProperties;
  top: number;
  label: string;
}) {
  return (
    <div
      className="pointer-events-none absolute top-0 z-10 h-full"
      style={leftCss}
    >
      <div
        className="absolute left-0 top-0 h-full w-px"
        style={{
          backgroundColor: "rgba(228, 228, 231, 0.35)",
          backgroundImage:
            "linear-gradient(to bottom, rgba(228,228,231,0.55) 40%, transparent 40%)",
          backgroundSize: "1px 5px",
        }}
      />
      <div
        className="absolute -translate-x-1/2 whitespace-nowrap rounded px-1.5 py-0.5 text-[9px] font-semibold tabular-nums backdrop-blur-sm"
        style={{
          top,
          backgroundColor: "rgba(0, 0, 0, 0.78)",
          color: "#e4e4e7",
          border: "1px solid rgba(228, 228, 231, 0.18)",
          boxShadow: "0 2px 8px rgba(0,0,0,0.5)",
        }}
      >
        {label}
      </div>
    </div>
  );
}

/** Headline marker chips (v4.3) — amber bars on the top edge of the video
 *  lane, click to jump to the headline. Markup verbatim from v4.9; v5.1
 *  `layout` positions them in px. */
function HeadlineChips({
  headlines,
  totalMs,
  currentMs,
  onSeek,
  layout,
}: {
  headlines: HeadlineItem[];
  totalMs: number;
  currentMs: number;
  onSeek: (ms: number) => void;
  layout?: TimelinePxLayout;
}) {
  return (
    <>
      {headlines.map((h) => {
        if (totalMs <= 0) return null;
        const inPlay = currentMs >= h.startMs && currentMs < h.endMs;
        if (layout) {
          const w = Math.max(2, layout.pxOf(h.endMs) - layout.pxOf(h.startMs));
          return (
            <button
              key={h.id}
              type="button"
              onPointerDown={(e) => {
                e.stopPropagation();
                onSeek(h.startMs + 100);
              }}
              aria-label={`Headline "${h.text}" — jump to ${fmtTimecode(h.startMs)}`}
              className={cn(
                "absolute top-0 z-[5] flex h-[10px] items-center justify-start overflow-hidden rounded-sm px-1 text-[7px] font-bold uppercase tracking-wide transition-all duration-150 hover:brightness-125",
                inPlay && "ff-hl-live",
              )}
              style={{
                left: layout.pxOf(h.startMs),
                width: w,
                backgroundImage: inPlay
                  ? "linear-gradient(90deg, #fbbf24, #f59e0b)"
                  : "linear-gradient(90deg, rgba(251, 191, 36, 0.75), rgba(245, 158, 11, 0.55))",
                color: "#422006",
                boxShadow: inPlay
                  ? "0 0 8px rgba(251, 191, 36, 0.7)"
                  : "0 1px 2px rgba(0,0,0,0.4)",
              }}
              title={`Title: "${h.text}" · ${fmtTimecode(h.startMs)}–${fmtTimecode(h.endMs)} (click to jump)`}
            >
              {w > 5 ? (
                <span className="pointer-events-none flex items-center gap-0.5 truncate">
                  <Type className="size-[8px] shrink-0" />
                  {h.text.replace(/\n/g, " ").slice(0, 30)}
                </span>
              ) : (
                <Type className="pointer-events-none size-[8px]" />
              )}
            </button>
          );
        }
        const left = (h.startMs / totalMs) * 100;
        const width = Math.max(0.8, ((h.endMs - h.startMs) / totalMs) * 100);
        return (
          <button
            key={h.id}
            type="button"
            onPointerDown={(e) => {
              e.stopPropagation();
              onSeek(h.startMs + 100);
            }}
            aria-label={`Headline "${h.text}" — jump to ${fmtTimecode(h.startMs)}`}
            className={cn(
              "absolute top-0 z-[5] flex h-[10px] items-center justify-start overflow-hidden rounded-sm px-1 text-[7px] font-bold uppercase tracking-wide transition-all duration-150 hover:brightness-125",
              inPlay && "ff-hl-live",
            )}
            style={{
              left: `${Math.max(0, Math.min(98, left))}%`,
              width: `${Math.min(99 - Math.max(0, left), Math.max(1, width))}%`,
              backgroundImage: inPlay
                ? "linear-gradient(90deg, #fbbf24, #f59e0b)"
                : "linear-gradient(90deg, rgba(251, 191, 36, 0.75), rgba(245, 158, 11, 0.55))",
              color: "#422006",
              boxShadow: inPlay
                ? "0 0 8px rgba(251, 191, 36, 0.7)"
                : "0 1px 2px rgba(0,0,0,0.4)",
            }}
            title={`Title: "${h.text}" · ${fmtTimecode(h.startMs)}–${fmtTimecode(h.endMs)} (click to jump)`}
          >
            {width > 5 ? (
              <span className="pointer-events-none flex items-center gap-0.5 truncate">
                <Type className="size-[8px] shrink-0" />
                {h.text.replace(/\n/g, " ").slice(0, 30)}
              </span>
            ) : (
              <Type className="pointer-events-none size-[8px]" />
            )}
          </button>
        );
      })}
    </>
  );
}

/** Beat rail (v4.6) — cyan ticks at the bottom edge of the video lane; the
 *  beat under the playhead pulses brighter (play-along feel). Verbatim;
 *  v5.1 `layout` positions ticks in px. */
function BeatRail({
  beats,
  totalMs,
  beatNearest,
  layout,
}: {
  beats: number[] | null;
  totalMs: number;
  beatNearest: number | null;
  layout?: TimelinePxLayout;
}) {
  if (!beats || beats.length === 0 || totalMs <= 0) return null;
  return (
    <div className="pointer-events-none absolute bottom-[3px] left-0 right-0 h-[5px]">
      {beats.map((b, i) => {
        if (b > totalMs) return null;
        const live = beatNearest != null && Math.abs(b - beatNearest) < 1;
        const left = layout ? layout.pxOf(b) : (b / totalMs) * 100;
        return (
          <div
            key={`beat-${i}`}
            className={cn(
              "absolute bottom-0 w-px rounded-full transition-all duration-150",
              live && "ff-beat-tick-live",
            )}
            style={{
              ...(layout ? { left } : { left: `${left}%` }),
              height: live ? "6px" : "4px",
              backgroundColor: live ? "#67e8f9" : "rgba(34, 211, 238, 0.55)",
              boxShadow: live ? "0 0 6px rgba(103, 232, 249, 0.9)" : "none",
            }}
          />
        );
      })}
    </div>
  );
}

/**
 * Transition zones (v4.3) — the head window of every segment after the
 * first, drawn as a diagonal-hatch gradient strip. v4.5: per-boundary
 * overrides tint AMBER + show the boundary's own style; only boundaries
 * with an effective style ≠ none are drawn. v5: `segs` is the BASE lane.
 * Markup verbatim from v4.9.
 */
function TransitionZones({
  segs,
  transition,
  totalMs,
  currentMs,
  txActive,
  txOverridesActive,
  layout,
}: {
  segs: MediaSegment[];
  transition: TransitionSettings;
  totalMs: number;
  currentMs: number;
  txActive: boolean;
  txOverridesActive: boolean;
  layout?: TimelinePxLayout;
}) {
  if (!txActive && !txOverridesActive) return null;
  return (
    <>
      {segs.map((seg, idx) => {
        if (idx === 0) return null;
        const effStyle = boundaryStyle(transition, seg.id);
        if (effStyle === "none") return null;
        const pinned =
          !!transition.overrides &&
          Object.prototype.hasOwnProperty.call(transition.overrides, seg.id);
        const durMs = Math.min(
          transition.durationMs,
          Math.floor(seg.durationMs * 0.45),
        );
        if (durMs <= 0 || seg.durationMs <= 200) return null;
        const inPlay =
          currentMs >= seg.startMs && currentMs < seg.startMs + durMs;
        const zoneStyle: CSSProperties & { left: number | string; width: number | string } =
          layout
            ? {
                left: layout.pxOf(seg.startMs),
                width: Math.max(0.4, layout.pxOf(durMs)),
              }
            : {
                left: `${totalMs > 0 ? (seg.startMs / totalMs) * 100 : 0}%`,
                width: `${totalMs > 0 ? Math.max(0.4, (durMs / totalMs) * 100) : 0}%`,
              };
        return (
          <div
            key={`tx-${seg.id}`}
            className={cn(
              "absolute bottom-0 rounded-[2px] transition-all duration-200",
              inPlay && "ff-tx-zone-live",
            )}
            style={{
              ...zoneStyle,
              height: "30%",
              backgroundImage: pinned
                ? "repeating-linear-gradient(135deg, rgba(251, 191, 36, 0.6) 0 3px, rgba(245, 158, 11, 0.28) 3px 6px)"
                : "repeating-linear-gradient(135deg, rgba(217, 70, 239, 0.55) 0 3px, rgba(139, 92, 246, 0.25) 3px 6px)",
              boxShadow: inPlay
                ? pinned
                  ? "0 0 8px rgba(251, 191, 36, 0.55)"
                  : "0 0 8px rgba(217, 70, 239, 0.55)"
                : "none",
              border: pinned
                ? "1px solid rgba(251, 191, 36, 0.4)"
                : "1px solid rgba(217, 70, 239, 0.35)",
            }}
            title={`${effStyle}${pinned ? " (custom)" : ""} transition · ${fmtTimecode(seg.startMs)}+${(durMs / 1000).toFixed(1)}s`}
          />
        );
      })}
    </>
  );
}

/** v5.1 CapCut: transition boundary diamonds — an 8px rotated square
 *  centered on every boundary between base clips, tinted by that
 *  boundary's EFFECTIVE style (dip-black dark, dip-white light, any
 *  xfade-family move violet, none a dim zinc stub). PURE VISUAL layer: it
 *  mounts inside the axis cell, so presses bubble to the axis's own
 *  press-to-seek handlers (pressing a diamond jumps to the cut) and the
 *  title tooltip carries the boundary detail — zero new interaction code. */
const DIAMOND_LOOK: Record<TransitionStyle, { bg: string; border: string; glow: string }> = {
  none: { bg: "#27272a", border: "#3f3f46", glow: "none" },
  "dip-black": { bg: "#18181b", border: "#71717a", glow: "none" },
  "dip-white": { bg: "#f4f4f5", border: "#a1a1aa", glow: "0 0 6px rgba(244, 244, 245, 0.35)" },
  dissolve: { bg: "#8b5cf6", border: "rgba(196, 181, 253, 0.9)", glow: "0 0 8px rgba(139, 92, 246, 0.65)" },
  "slide-left": { bg: "#8b5cf6", border: "rgba(196, 181, 253, 0.9)", glow: "0 0 8px rgba(139, 92, 246, 0.65)" },
  "slide-right": { bg: "#8b5cf6", border: "rgba(196, 181, 253, 0.9)", glow: "0 0 8px rgba(139, 92, 246, 0.65)" },
  "wipe-left": { bg: "#8b5cf6", border: "rgba(196, 181, 253, 0.9)", glow: "0 0 8px rgba(139, 92, 246, 0.65)" },
  "wipe-right": { bg: "#8b5cf6", border: "rgba(196, 181, 253, 0.9)", glow: "0 0 8px rgba(139, 92, 246, 0.65)" },
  circleopen: { bg: "#8b5cf6", border: "rgba(196, 181, 253, 0.9)", glow: "0 0 8px rgba(139, 92, 246, 0.65)" },
};

function TransitionDiamonds({
  segs,
  transition,
  layout,
}: {
  segs: MediaSegment[];
  transition: TransitionSettings;
  layout?: TimelinePxLayout;
}) {
  if (segs.length < 2 || layout == null) return null;
  // Bar-zone geometry: filmstrips live at top 12 / bottom 4 of the 60px
  // lane → vertical center ≈ 34; the 8px diamond centers on that.
  return (
    <>
      {segs.map((seg, idx) => {
        if (idx === 0) return null;
        const style = boundaryStyle(transition, seg.id);
        const pinned =
          !!transition.overrides &&
          Object.prototype.hasOwnProperty.call(transition.overrides, seg.id);
        const look = DIAMOND_LOOK[style];
        return (
          <div
            key={`dia-${seg.id}`}
            className="pointer-events-auto absolute z-[4] cursor-pointer"
            title={`${style === "none" ? "Hard cut" : `${style.replace("-", " ")} transition`}${pinned ? " (custom)" : ""} · boundary at ${fmtTimecode(seg.startMs)} — click to jump to this cut`}
            style={{
              left: layout.pxOf(seg.startMs),
              top: 30,
              width: 8,
              height: 8,
              transform: "translateX(-50%) rotate(45deg)",
              borderRadius: 1.5,
              backgroundColor: look.bg,
              boxShadow: `inset 0 0 0 1px ${look.border}${look.glow !== "none" ? `, ${look.glow}` : ""}`,
              opacity: style === "none" ? 0.45 : 1,
            }}
          />
        );
      })}
    </>
  );
}

/** Pointer handlers v5 attaches to a draggable base filmstrip bar. */
interface FilmstripBarDrag {
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onLostPointerCapture: (e: ReactPointerEvent<HTMLDivElement>) => void;
}

/**
 * v4.9 filmstrip bar — thumbnail shows through a kind-tint gradient. All
 * rendering verbatim; v5 adds OPTIONAL drag hooks (move / lane-switch),
 * live preview overrides and focus/keyboard access when draggable.
 */
function FilmstripBar({
  seg,
  idx,
  totalMs,
  isActive,
  selected,
  onActivate,
  onContextMenu,
  drag,
  trim,
  previewStartMs,
  previewDurationMs,
  dragging,
  layout,
}: {
  seg: MediaSegment;
  idx: number;
  totalMs: number;
  isActive: boolean;
  /** v5.4: user-selected (amber ring) — distinct from isActive (cyan,
   *  playhead-derived). */
  selected?: boolean;
  /** Double-click (and Enter/Space when draggable) — jump to first frame. */
  onActivate: (e: { stopPropagation: () => void }) => void;
  /** v5.4.1: right-click → timeline context menu. */
  onContextMenu?: (e: ReactMouseEvent<HTMLDivElement>) => void;
  /** v5: pointer drag handlers (press-seek + move/lane-switch gestures). */
  drag?: FilmstripBarDrag;
  /** v5.3: base-lane trim handle gestures (edges). The shared move/up
   *  handlers live on the clip root and receive the captured edge events
   *  via bubbling — the same pattern the overlay clips use. */
  trim?: {
    onTrimStart: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onTrimEnd: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onLostPointerCapture: (e: ReactPointerEvent<HTMLDivElement>) => void;
  };
  /** v5: live drag preview overrides (local state; commit on release). */
  previewStartMs?: number;
  previewDurationMs?: number;
  dragging?: boolean;
  /** v5.1: pixel layout (zoom) — positions in px instead of %. */
  layout?: TimelinePxLayout;
}) {
  const startMs = previewStartMs ?? seg.startMs;
  const durMs = previewDurationMs ?? seg.durationMs;
  const posStyle =
    layout != null
      ? {
          left: layout.pxOf(startMs),
          width: Math.max(4, layout.pxOf(startMs + durMs) - layout.pxOf(startMs)),
        }
      : {
          left: `${totalMs > 0 ? (startMs / totalMs) * 100 : 0}%`,
          width: `${totalMs > 0 ? Math.max(0.5, (durMs / totalMs) * 100) : 0}%`,
        };
  const widthPxish = layout != null ? posStyle.width : (totalMs > 0 ? (durMs / totalMs) * 100 : 0);
  const colors = BAR_BG[seg.kind] || BAR_BG.duration;
  return (
    <div
      {...(drag ?? {})}
      onDoubleClick={onActivate}
      onContextMenu={onContextMenu}
      onKeyDown={
        drag
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onActivate(e);
              }
            }
          : undefined
      }
      role={drag ? "button" : undefined}
      tabIndex={drag ? 0 : undefined}
      aria-label={
        drag
          ? `${seg.fileName}, base clip ${idx + 1}, ${fmtTimecode(startMs)} to ${fmtTimecode(startMs + durMs)}`
          : undefined
      }
      className={cn(
        // v5.1 CapCut clip card: 6px radius + 1px #27272a hairline + sheen,
        // with the .ff-clip family in globals.css carrying hover (cyan
        // hairline + 1px lift), active (2px cyan ring + raise) and drag
        // states — previously inline filter/box-shadow, now CSS so hover
        // works. v5.3: real interactive trim handles replace the old
        // ::before/::after visual-only edge zones (group-hover drives them).
        "ff-clip group absolute top-0 overflow-hidden rounded-md text-[8px] font-semibold tabular-nums",
        drag
          ? "cursor-grab touch-none select-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-300/70"
          : "cursor-pointer",
        // Kill the hover transition while dragging so the bar tracks the
        // pointer 1:1 (the v4.9 transition would rubber-band left/width).
        dragging ? "ff-clip-drag transition-none" : "transition-all duration-150",
        seg.kind === "beat" && !isActive && "ff-beat-pulse",
        isActive && "ff-clip-active",
        selected && "ff-clip-selected",
        dragging && "cursor-grabbing",
      )}
      style={{
        ...posStyle,
        height: "100%",
        // v4.9 FILMSTRIP: the segment's own thumbnail shows through a
        // kind-tint gradient (triple background — v5.1 adds a subtle top
        // sheen so the card reads as a physical tile; the tint paints over
        // the image).
        backgroundImage: `linear-gradient(180deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0.02) 35%, rgba(0,0,0,0.22) 100%), linear-gradient(180deg, ${colors.top} 0%, ${colors.bottom} 100%), url(${seg.thumbnailUrl})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
      title={`${seg.fileName} · ${fmtTimecode(seg.startMs)}–${fmtTimecode(seg.endMs)} · ${(seg.durationMs / 1000).toFixed(1)}s · motion ${seg.direction}\ndouble-click jumps to this clip's first frame${trim ? " · drag edges to trim" : ""}`}
    >
      {/* v5.3: interactive trim handles — 6px cyan zones that fade in on
          hover, wired to the shared clip gesture machinery ("trim-l" /
          "trim-r"). Mirrors the overlay-clip handles exactly. */}
      {trim && (
        <>
          <div
            className="absolute inset-y-0 left-0 z-[2] w-[7px] cursor-ew-resize touch-none bg-cyan-400/25 opacity-0 shadow-[inset_1px_0_0_rgba(34,211,238,0.65)] transition-opacity duration-100 group-hover:opacity-100"
            title="Drag to trim the start (slides the source window)"
            aria-hidden
            onPointerDown={trim.onTrimStart}
            onLostPointerCapture={trim.onLostPointerCapture}
          />
          <div
            className="absolute inset-y-0 right-0 z-[2] w-[7px] cursor-ew-resize touch-none bg-cyan-400/25 opacity-0 shadow-[inset_-1px_0_0_rgba(34,211,238,0.65)] transition-opacity duration-100 group-hover:opacity-100"
            title="Drag to trim the end"
            aria-hidden
            onPointerDown={trim.onTrimEnd}
            onLostPointerCapture={trim.onLostPointerCapture}
          />
        </>
      )}
      {/* Index chip — scrimmed so it reads over any footage. */}
      {(layout != null ? (widthPxish as number) > 14 : (widthPxish as number) > 3) ? (
        <span
          className="absolute left-0 top-0 flex h-[13px] min-w-[13px] items-center justify-center rounded-br-[5px] px-1 text-[8px] font-bold"
          style={{
            backgroundColor: "rgba(0, 0, 0, 0.75)",
            color: "#f4f4f5",
            textShadow: "0 1px 1px rgba(0,0,0,0.9)",
          }}
        >
          {idx + 1}
        </span>
      ) : null}
      {/* Duration tag on wide strips. */}
      {(layout != null ? (widthPxish as number) > 34 : (widthPxish as number) > 14) ? (
        <span
          className="absolute bottom-0.5 right-1 rounded-sm px-1 py-px text-[8px] font-semibold"
          style={{
            backgroundColor: "rgba(0, 0, 0, 0.62)",
            color: "rgba(244, 244, 245, 0.95)",
          }}
        >
          {(durMs / 1000).toFixed(1)}s
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// v5 lane chrome
// ---------------------------------------------------------------------------

/** Left gutter cell: lucide icon + tiny caps label, vertically centered.
 *  v5.1: `sticky` pins the cell to the left edge of the horizontal scroll
 *  viewport (labels stay visible while the timeline pans) with an opaque
 *  background so scrolling media never bleeds through. */
function LaneLabel({
  icon: Icon,
  text,
  accent,
  sticky,
}: {
  icon: LucideIcon;
  text: string;
  accent: string;
  sticky?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-full w-16 shrink-0 select-none items-center justify-center gap-1 border-r",
        sticky && "sticky left-0 z-[7]",
      )}
      style={{
        borderColor: GUTTER_BORDER,
        ...(sticky ? { backgroundColor: "#0c0c0e" } : {}),
      }}
    >
      <Icon className="size-3 shrink-0" style={{ color: accent }} aria-hidden />
      <span className="truncate text-[9px] font-bold uppercase tracking-wider text-zinc-500">
        {text}
      </span>
    </div>
  );
}

/** Tiny centered muted hint for an empty lane — never blocks interaction. */
function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-2 text-center text-[9px] font-medium text-zinc-600">
      {children}
    </div>
  );
}

/** v5.1: MM:SS.d — sub-second precision for the ruler readout chip. */
function fmtTcTenths(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, "0")}:${r < 10 ? "0" : ""}${r.toFixed(1)}`;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function TimelineRuler({
  segments,
  totalMs,
  currentMs,
  mode,
  activeId,
  headlines,
  transition,
  beats,
  waveform,
  onSeek,
  onJumpToSegment,
  onEditItem,
  sfxItems,
  onMoveSfx,
  onEditSfx,
  onRemoveSfx,
  videoDurations,
  onSplit,
  onDuplicate,
  onRemove,
  activeSegment,
  musicStartMs = 0,
  musicLoop = false,
  musicVolume = 1,
  musicDurationMs = null,
  musicName = null,
  onMusicMove,
  onMusicLoopChange,
  onMusicVolumeChange,
  selectedIds: selectedIdsProp,
  onSelectionChange,
  onRemoveMany,
}: TimelineRulerProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  // v4.8: mirror of `dragging` for render (refs must not be read during
  // render — this flips exactly twice per scrub, so rerenders are cheap).
  const [scrubbing, setScrubbing] = useState(false);
  // v4.8: hover position for the ghost-time tooltip, stored as a NORMALIZED
  // ratio (computed in the handler where ref access is legal — the render
  // path then derives ms arithmetically, no ref reads).
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);

  // v5: active gesture (ref) + live preview (state). The preview is the ONLY
  // render feedback while dragging; the parent state is patched once, on
  // pointerup — the same shape as the v4.9 scrub pattern.
  const dragRef = useRef<DragInfo | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);

  // v5.4 multi-select -------------------------------------------------------
  // Click-selection anchor (for Shift ranges) + marquee (rubber-band) gesture
  // state. The SELECTION SET itself lives in the parent (page.tsx) so the
  // Delete key, Ctrl+A and future group ops share one source of truth.
  const anchorIdRef = useRef<string | null>(null);
  const marqueeOriginRef = useRef<{
    x: number;
    y: number;
    pointerId: number;
    additive: boolean;
  } | null>(null);
  const marqueeActiveRef = useRef(false);
  const marqueeBaseSelRef = useRef<string[]>([]);
  const marqueeRectRef = useRef<DOMRect | null>(null);
  /** Rubber band in CONTENT-LOCAL px (render-ready; null when idle). */
  const [marquee, setMarquee] = useState<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  } | null>(null);
  const baseAxisRef = useRef<HTMLDivElement>(null);
  const overlayAxisRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // v5.4.1 right-click CONTEXT MENU -------------------------------------
  // Target descriptor + open state. The menu is a fixed-position card
  // rendered at the click point (viewport-clamped), with keyboard navigation
  // and a transparent backdrop that closes on outside press.
  type CtxTarget =
    | { kind: "clip"; id: string; x: number; y: number }
    | { kind: "sfx"; id: string; x: number; y: number }
    | { kind: "music"; id: ""; x: number; y: number }
    | { kind: "empty"; id: ""; x: number; y: number };
  const [ctxMenu, setCtxMenu] = useState<CtxTarget | null>(null);
  const [ctxIdx, setCtxIdx] = useState(0);
  const ctxListRef = useRef<HTMLDivElement>(null);

  /** Right-click on a clip: standard editor semantics — keep a multi-
   *  selection that CONTAINS the clip (menu acts on the whole set), else
   *  select it solo first. */
  const openClipMenu = (e: ReactMouseEvent, seg: MediaSegment) => {
    e.preventDefault();
    e.stopPropagation();
    if (
      onSelectionChange &&
      !(selectedIdsProp ?? []).includes(seg.id)
    ) {
      onSelectionChange([seg.id]);
      anchorIdRef.current = seg.id;
    }
    setCtxIdx(0);
    setCtxMenu({ kind: "clip", id: seg.id, x: e.clientX, y: e.clientY });
  };

  const openSfxMenu = (e: ReactMouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxIdx(0);
    setCtxMenu({ kind: "sfx", id, x: e.clientX, y: e.clientY });
  };

  const openMusicMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxIdx(0);
    setCtxMenu({ kind: "music", id: "", x: e.clientX, y: e.clientY });
  };

  const openLaneMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxIdx(0);
    setCtxMenu({ kind: "empty", id: "", x: e.clientX, y: e.clientY });
  };

  // v5 mode: ANY new prop present => render the 4-lane editor; otherwise the
  // exact v4.9 single-track layout (page.tsx keeps working unchanged).
  const isV5 =
    onEditItem != null ||
    sfxItems != null ||
    onMoveSfx != null ||
    onRemoveSfx != null ||
    videoDurations != null;
  const sfxList = sfxItems ?? [];

  // ------------------------------------------------------------------
  // v5.1 PIXEL ZOOM state (4..400 px per timeline second).
  // ------------------------------------------------------------------
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pxPerSec, setPxPerSec] = useState(60);
  const [viewportW, setViewportW] = useState(0);
  /** One-shot "fit" on the first usable layout (spec default). */
  const didInitialFitRef = useRef(false);
  /** Zoom anchor set by zoomTo(); applied in the layout effect below so the
   *  content width re-renders BEFORE scrollLeft is set. */
  const zoomAnchorRef = useRef<{ viewportX: number; timeMs: number } | null>(null);

  const totalSec = Math.max(0, totalMs) / 1000;
  const axisW = Math.max(1, totalSec * pxPerSec);
  const pxOf = useCallback(
    (ms: number) => (Math.max(0, ms) / 1000) * pxPerSec,
    [pxPerSec],
  );
  const layout: TimelinePxLayout | undefined = isV5
    ? { pxOf }
    : undefined;

  const fitPxPerSec = useCallback(
    () =>
      clampPxPerSec(
        (viewportW > GUTTER_W ? viewportW - GUTTER_W : 800) /
          Math.max(0.001, totalSec),
      ),
    [viewportW, totalSec],
  );

  /** Zoom with an anchor: keep the timeline time under `viewportX` stable
   *  after the new pxPerSec lands (wheel = cursor, buttons/slider = view
   *  center). The actual scrollLeft lands in the layout effect. */
  const zoomTo = useCallback(
    (next: number, viewportX: number) => {
      const el = scrollRef.current;
      const n = clampPxPerSec(next);
      if (el && pxPerSec > 0) {
        const contentX = el.scrollLeft + viewportX;
        const t = Math.max(0, ((contentX - GUTTER_W) / pxPerSec) * 1000);
        zoomAnchorRef.current = { viewportX, timeMs: t };
      }
      setPxPerSec(n);
    },
    [pxPerSec],
  );

  // Viewport width tracker (drives "fit" + the shrink clamp below).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      setViewportW((prev) =>
        el.clientWidth > 0 && el.clientWidth !== prev ? el.clientWidth : prev,
      );
    });
    ro.observe(el);
    setViewportW((prev) => (el.clientWidth > 0 ? el.clientWidth : prev));
    return () => ro.disconnect();
  }, [isV5]);

  // One-shot initial "fit": the default zoom equals the viewport (first
  // layout with actual media on the timeline).
  useEffect(() => {
    if (
      isV5 &&
      !didInitialFitRef.current &&
      viewportW > GUTTER_W &&
      totalMs > 0
    ) {
      didInitialFitRef.current = true;
      setPxPerSec(fitPxPerSec());
    }
  }, [isV5, viewportW, totalMs, fitPxPerSec]);

  // Drastic-change clamp: when the timeline SHRINKS below the viewport
  // (deleting clips), zoom up so it still fills the lane (never jumps zoom
  // when the timeline grows — that just scrolls). Capped at ZOOM_MAX.
  useEffect(() => {
    if (!isV5 || viewportW <= GUTTER_W || totalMs <= 0) return;
    if (axisW < viewportW - GUTTER_W && fitPxPerSec() > pxPerSec) {
      // Lift AFTER paint (rAF): a synchronous setState inside the effect
      // body trips react-hooks/set-state-in-effect; one frame of the old
      // zoom after a delete is imperceptible.
      const fit = fitPxPerSec();
      const raf = requestAnimationFrame(() => setPxPerSec(fit));
      return () => cancelAnimationFrame(raf);
    }
  }, [isV5, axisW, viewportW, totalMs, fitPxPerSec, pxPerSec]);

  // Apply a pending zoom anchor once the new content width is committed.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = zoomAnchorRef.current;
    if (!el || !a) return;
    zoomAnchorRef.current = null;
    el.scrollLeft = Math.max(
      0,
      GUTTER_W + (a.timeMs / 1000) * pxPerSec - a.viewportX,
    );
  }, [pxPerSec]);

  // Ctrl/Cmd+wheel zoom (native listener — React wheel handlers are passive
  // and cannot preventDefault the browser's page pinch-zoom).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isV5) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const viewportX = Math.max(0, e.clientX - rect.left);
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      zoomTo(pxPerSec * factor, viewportX);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [isV5, pxPerSec, zoomTo]);

  const xToMs = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el || totalMs <= 0) return 0;
      const rect = el.getBoundingClientRect();
      if (isV5) {
        // v5.1 px layout: ms = (clientX − axis left) / pxPerSec · 1000.
        const ms = ((clientX - rect.left) / pxPerSec) * 1000;
        return Math.round(Math.max(0, Math.min(totalMs, ms)));
      }
      const ratio = Math.max(
        0,
        Math.min(1, (clientX - rect.left) / rect.width),
      );
      return Math.round(ratio * totalMs);
    },
    [totalMs, isV5, pxPerSec],
  );

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    setScrubbing(true);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    onSeek(xToMs(e.clientX));
  };
  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    // v4.8: ghost tooltip tracks the cursor while NOT scrubbing.
    // v5: also skip while a clip/sfx drag owns the pointer (its events
    // bubble through here — the ghost is hidden for the whole gesture).
    if (!dragging.current && !dragRef.current && e.pointerType === "mouse") {
      const el = trackRef.current;
      if (el && el.clientWidth > 0) {
        const rect = el.getBoundingClientRect();
        setHoverRatio(
          Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
        );
      }
    }
    if (!dragging.current) return;
    onSeek(xToMs(e.clientX));
  };
  const handlePointerUp = () => {
    dragging.current = false;
    setScrubbing(false);
  };

  // ------------------------------------------------------------------
  // v5 drag handlers (pointer capture, deadzone, didDrag, commit-on-release)
  // ------------------------------------------------------------------

  /** px->ms scale measured at gesture start from the ticks axis cell.
   *  v5.1 px layout: exactly 1000/pxPerSec (the axis cell IS axisW wide).
   *  Legacy % layout keeps the measured width. */
  const msPerPxNow = useCallback(() => {
    if (isV5) return pxPerSec > 0 ? 1000 / pxPerSec : 0;
    const el = trackRef.current;
    const w = el ? el.getBoundingClientRect().width : 0;
    return w > 0 && totalMs > 0 ? totalMs / w : 0;
  }, [totalMs, isV5, pxPerSec]);

  const clipPreviewFor = (id: string) =>
    dragPreview && dragPreview.kind === "clip" && dragPreview.id === id
      ? dragPreview
      : null;
  const sfxPreviewFor = (id: string) =>
    dragPreview && dragPreview.kind === "sfx" && dragPreview.id === id
      ? dragPreview
      : null;

  // ---- v5.2: MUSIC clip drag (self-contained gesture — no lane switching,
  // no shared DragInfo: the music track is a singleton on the audio lane).
  // Press seeks to the music start (SFX pill parity); drag previews locally
  // and commits once on pointerup. Snapped to the same 10ms grid.
  const [musicDrag, setMusicDrag] = useState<{
    pointerId: number;
    startX: number;
    origStart: number;
    startMs: number;
    didDrag: boolean;
  } | null>(null);
  /** Effective (preview-aware) music start. */
  const musicStart = Math.max(
    0,
    Math.min(totalMs, musicDrag?.startMs ?? musicStartMs),
  );

  const beginMusicDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !onMusicMove) return;
    e.stopPropagation();
    onSeek(Math.max(0, musicStartMs));
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // best-effort
    }
    setMusicDrag({
      pointerId: e.pointerId,
      startX: e.clientX,
      origStart: Math.max(0, musicStartMs),
      startMs: Math.max(0, musicStartMs),
      didDrag: false,
    });
  };

  const handleMusicPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = musicDrag;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    if (!d.didDrag) {
      if (Math.abs(dx) <= DRAG_DEADZONE_PX) return;
    }
    const msPerPx = msPerPxNow();
    const maxStart = Math.max(0, totalMs - 200);
    const ns = Math.max(
      0,
      Math.min(maxStart, snapMs(d.origStart + dx * msPerPx)),
    );
    setMusicDrag((prev) =>
      prev && prev.pointerId === e.pointerId
        ? { ...prev, didDrag: true, startMs: ns }
        : prev,
    );
  };

  const handleMusicPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = musicDrag;
    if (!d || d.pointerId !== e.pointerId) return;
    setMusicDrag(null);
    if (d.didDrag && onMusicMove) onMusicMove(d.startMs);
  };

  const handleMusicDragAbort = () => setMusicDrag(null);

  // v5.2: music-clip hover state drives the volume/loop popover. React state
  // (not CSS group-hover): Tailwind's `pointer-events-none` and the
  // `group-hover:pointer-events-auto` variant share specificity, so cascade
  // order decides — inline styles are deterministic. The popover is a DOM
  // descendant of the clip, so moving the pointer from the clip into the
  // (flush, top-0) popover never fires pointerleave — the chain is unbroken.
  const [musicHover, setMusicHover] = useState(false);

  /**
   * Begin a clip gesture (body = move, edges = trim). Guards: only when the
   * parent accepts edits (onEditItem) and only for the primary pointer — any
   * other press falls through to the lane's v4.9 press-to-seek. Body presses
   * keep the v4.9 press-seek parity (the playhead lands under the cursor the
   * instant you grab a clip); edge presses do NOT seek (trim intent).
   */
  const beginClipDrag = (
    e: ReactPointerEvent<HTMLDivElement>,
    seg: MediaSegment,
    gesture: "move" | "trim-l" | "trim-r",
  ) => {
    if (!onEditItem || e.button !== 0) return;
    e.stopPropagation();
    if (gesture === "move") onSeek(xToMs(e.clientX));
    // v5.3: base-lane neighbor clamps — the previous clip's end bounds any
    // start slide, the next clip's start bounds any end extension. (Overlays
    // overlap freely, so they stay unbounded.)
    let minStartMs = 0;
    let maxEndMs = Infinity;
    if (seg.track === 0) {
      const neighbors = segments
        .filter((s) => s.track === 0 && s.id !== seg.id)
        .sort((a, b) => a.startMs - b.startMs);
      const prev = neighbors
        .filter((s) => s.startMs < seg.startMs)
        .pop();
      const next = neighbors.find((s) => s.startMs > seg.startMs);
      if (prev) minStartMs = prev.startMs + prev.durationMs;
      if (next) maxEndMs = next.startMs;
    }
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Capture is best-effort — bubbling still delivers the events.
    }
    dragRef.current = {
      kind: "clip",
      id: seg.id,
      gesture,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      msPerPx: msPerPxNow(),
      didDrag: false,
      origStart: seg.startMs,
      origDur: seg.durationMs,
      origTrim: seg.trimInMs,
      origTrack: seg.track,
      mediaType: seg.mediaType,
      sourceDur: seg.sourceDurationMs ?? videoDurations?.[seg.id] ?? null,
      allowH: mode === "absolute",
      // v5.1: resolved playback speed (trim math converts timeline↔source).
      speed:
        seg.mediaType === "video" &&
        seg.speed != null &&
        Number.isFinite(seg.speed) &&
        seg.speed > 0
          ? seg.speed
          : 1,
      // v5.2: looped overlays trim beyond the source window.
      overlayLoop: seg.overlayLoop === true,
      minStartMs,
      maxEndMs,
    };
  };

  /**
   * Begin an SFX pill gesture. Press always seeks to the pill's start (the
   * brief's "click = seek to its start"); Alt+press is reserved for remove
   * (no drag, no seek — the click handler performs the removal).
   */
  const beginSfxDrag = (
    e: ReactPointerEvent<HTMLDivElement>,
    item: SfxItem,
    gesture: "move" | "resize-l" | "resize-r" = "move",
  ) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (e.altKey && onRemoveSfx) return;
    // Press-seek only for the pill body (edge presses carry trim intent).
    if (gesture === "move") onSeek(Math.max(0, item.startMs));
    if (!onMoveSfx) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // best-effort
    }
    dragRef.current = {
      kind: "sfx",
      id: item.id,
      gesture,
      pointerId: e.pointerId,
      startX: e.clientX,
      msPerPx: msPerPxNow(),
      didDrag: false,
      origStart: Math.max(0, item.startMs),
      origDur: sfxDurationMs(item),
    };
  };

  const handleClipPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.kind !== "clip" || d.pointerId !== e.pointerId) return;
    if (!d.didDrag) {
      if (
        Math.abs(e.clientX - d.startX) <= DRAG_DEADZONE_PX &&
        Math.abs(e.clientY - d.startY) <= DRAG_DEADZONE_PX
      ) {
        return;
      }
      d.didDrag = true;
    }
    const r = computeClipDrag(d, e.clientX, e.clientY, totalMs);
    setDragPreview({
      kind: "clip",
      id: d.id,
      gesture: d.gesture,
      startMs: r.startMs,
      durationMs: r.durationMs,
      targetTrack: r.targetTrack,
      origTrack: d.origTrack,
    });
  };

  /**
   * v5.4: compute the NEXT selection for a plain CLICK on a clip.
   *   Shift       → contiguous range from the anchor clip (full segment
   *                 order — stable across lanes; no anchor yet = solo).
   *   Ctrl / Cmd  → toggle this clip in/out of the current set.
   *   plain       → solo-select (the standard "click = select" contract).
   */
  const clickSelectionFor = (
    id: string,
    e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  ): string[] => {
    const cur = selectedIdsProp ?? [];
    if (e.shiftKey) {
      const anchor = anchorIdRef.current;
      if (anchor && anchor !== id) {
        const idxOf = new Map(segments.map((s, i) => [s.id, i] as const));
        const a = idxOf.get(anchor);
        const b = idxOf.get(id);
        if (a != null && b != null) {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          return segments.slice(lo, hi + 1).map((s) => s.id);
        }
      }
      return [id];
    }
    if (e.ctrlKey || e.metaKey) {
      return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    }
    return cur.length === 1 && cur[0] === id ? cur : [id];
  };

  const handleClipPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.kind !== "clip" || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDragPreview(null);
    // v5.4: plain click (no drag) = selection. The press already sought
    // (v4.9 parity) — the click ALSO selects, so the amber selection ring
    // follows user intent while the cyan active ring keeps tracking the
    // playhead. Drags (didDrag) edit, not select.
    if (!d.didDrag) {
      if (onSelectionChange) {
        onSelectionChange(clickSelectionFor(d.id, e));
        anchorIdRef.current = d.id;
      }
      return;
    }
    if (!onEditItem) return;
    const r = computeClipDrag(d, e.clientX, e.clientY, totalMs);
    const patch: Partial<ItemEdit> = {};
    if (d.gesture === "move") {
      if (r.targetTrack != null && r.targetTrack !== d.origTrack) {
        // Lane switch — carries startMs so a base->overlay switch keeps the
        // clip visually in place (overlay placement honors edit.startMs);
        // overlay->base retains it harmlessly (base ignores startMs).
        patch.track = r.targetTrack;
        patch.startMs = r.startMs;
      } else if ((d.origTrack >= 1 || d.allowH) && r.startMs !== d.origStart) {
        patch.startMs = r.startMs;
      }
    } else {
      if (r.startMs !== d.origStart) patch.startMs = r.startMs;
      if (r.durationMs !== d.origDur) patch.durationMs = r.durationMs;
      if (d.mediaType === "video" && r.trimInMs !== d.origTrim) {
        patch.trimInMs = r.trimInMs;
      }
    }
    if (Object.keys(patch).length > 0) onEditItem(d.id, patch);
  };

  const handleSfxPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.kind !== "sfx" || d.pointerId !== e.pointerId) return;
    if (!d.didDrag) {
      if (Math.abs(e.clientX - d.startX) <= DRAG_DEADZONE_PX) return;
      d.didDrag = true;
    }
    const r = computeSfxDrag(d, e.clientX, totalMs);
    setDragPreview({
      kind: "sfx",
      id: d.id,
      gesture: d.gesture,
      startMs: r.startMs,
      durMs: r.durMs,
    });
  };

  const handleSfxPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.kind !== "sfx" || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDragPreview(null);
    if (!d.didDrag) return;
    const r = computeSfxDrag(d, e.clientX, totalMs);
    if (d.gesture === "move") {
      onMoveSfx?.(d.id, r.startMs);
    } else {
      // v5.3: edge resize — commit the new duration (and, for the left
      // edge, the pinned-end start) as a patch.
      const patch: Partial<SfxItem> = { durMs: Math.round(r.durMs) };
      if (d.gesture === "resize-l" && r.startMs !== d.origStart) {
        patch.startMs = Math.round(r.startMs);
      }
      onEditSfx?.(d.id, patch);
    }
  };

  /** Abort the active gesture WITHOUT committing (pointercancel / capture
   *  loss). Idempotent — the implicit release after pointerup is a no-op. */
  const handleDragAbort = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (d && d.pointerId === e.pointerId) {
      dragRef.current = null;
      setDragPreview(null);
    }
  };

  // ------------------------------------------------------------------
  // Shared derived values (v4.9 code paths, unchanged)
  // ------------------------------------------------------------------

  const playPct = totalMs > 0 ? Math.min(100, (currentMs / totalMs) * 100) : 0;
  // v5.1: ruler ticks — the px layout uses the adaptive step (labels ≥70px
  // apart at the current zoom; count-capped so huge zoomed-out timelines
  // never render thousands of tick divs).
  let step = layout ? niceStepPx(pxPerSec) : niceStep(totalMs);
  if (totalMs > 0) {
    while (totalMs / step > 600) step *= 2;
  }
  const ticks: number[] = [];
  for (let t = 0; t <= totalMs; t += step) ticks.push(t);
  if (ticks[ticks.length - 1] < totalMs) ticks.push(totalMs);

  const txActive = transition && transition.style !== "none";
  // v4.5: boundaries can also be active purely via overrides even when the
  // global style is "none" — the zone strip then only shows the pinned ones.
  const txOverridesActive =
    !txActive &&
    !!transition.overrides &&
    Object.keys(transition.overrides).length > 0;

  // v4.6 beat rail: the beat closest to the playhead lights up (live pulse).
  const beatNearest = (() => {
    if (!beats || beats.length === 0 || totalMs <= 0) return null;
    let best = Infinity;
    let bestMs = 0;
    for (const b of beats) {
      const d = Math.abs(b - currentMs);
      if (d < best) {
        best = d;
        bestMs = b;
      }
    }
    return best <= 140 ? bestMs : null;
  })();

  const hasWave = !!waveform && totalMs > 0;
  // v4.8: hover timecode for the ghost tooltip (null when outside).
  const hoverMs =
    hoverRatio != null && totalMs > 0 ? Math.round(hoverRatio * totalMs) : null;
  const hoverPct = hoverRatio != null ? hoverRatio * 100 : 0;

  // ------------------------------------------------------------------
  // v5 derived: lane partition + overlay packing
  // ------------------------------------------------------------------

  // The v5.0 segments array mixes lanes (base first, overlays after — 6-a).
  // Both render paths draw the BASE lane; without itemEdits every segment
  // is track 0, so this filter is an identity for v4.9 callers.
  const baseSegs = segments.filter((s) => s.track === 0);
  const overlaySegs = segments.filter((s) => s.track >= 1);
  const overlayPack = packOverlayRows(overlaySegs);
  const overlayLaneH =
    overlaySegs.length === 0
      ? OV_EMPTY_H
      : OV_PAD * 2 +
        overlayPack.rows * OV_ROW_H +
        (overlayPack.rows - 1) * OV_GAP;

  // Lane y-offsets inside the lanes wrapper (for the drop-target highlight).
  const laneTop = {
    base: TICKS_H,
    overlay: TICKS_H + BASE_H,
    audio: TICKS_H + BASE_H + overlayLaneH,
  };
  const dropTarget = (() => {
    if (
      dragPreview == null ||
      dragPreview.kind !== "clip" ||
      dragPreview.targetTrack == null ||
      dragPreview.targetTrack === dragPreview.origTrack
    ) {
      return null;
    }
    return dragPreview.targetTrack === 0
      ? {
          top: laneTop.base,
          height: BASE_H,
          borderColor: "rgba(52, 211, 153, 0.55)",
          backgroundColor: "rgba(16, 185, 129, 0.08)",
        }
      : {
          top: laneTop.overlay,
          height: overlayLaneH,
          borderColor: "rgba(167, 139, 250, 0.55)",
          backgroundColor: "rgba(139, 92, 246, 0.10)",
        };
  })();

  // ------------------------------------------------------------------
  // v5.4 MARQUEE (rubber-band) selection — base + overlay lanes.
  // Press on empty lane space keeps the v4.9 seek parity; moving past the
  // deadzone CONVERTS the gesture into a rubber band that live-selects
  // intersecting clips (both lanes; pointer capture keeps events flowing
  // across lane borders). Shift-drag ADDS to the existing selection; a plain
  // click on empty space clears it (editor standard).
  // ------------------------------------------------------------------

  /** Clip ids whose [start,end] window intersects the marquee band. Lane
   *  participation is vertical: a lane is scanned only when the band reaches
   *  into its own row band (client-space rects of the lane axis divs). */
  const marqueeClipIds = (
    x0: number,
    x1: number,
    y0: number,
    y1: number,
  ): string[] => {
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);
    const ids: string[] = [];
    const scan = (axisEl: HTMLElement | null, segs: MediaSegment[]) => {
      if (!axisEl || segs.length === 0) return;
      const r = axisEl.getBoundingClientRect();
      if (maxY < r.top || minY > r.bottom) return; // lane untouched
      for (const s of segs) {
        const sx0 =
          r.left +
          (layout
            ? layout.pxOf(s.startMs)
            : (s.startMs / Math.max(1, totalMs)) * r.width);
        const sx1 =
          r.left +
          (layout
            ? layout.pxOf(s.endMs)
            : (s.endMs / Math.max(1, totalMs)) * r.width);
        if (sx1 >= minX && sx0 <= maxX) ids.push(s.id);
      }
    };
    scan(baseAxisRef.current, baseSegs);
    scan(overlayAxisRef.current, overlaySegs);
    return ids;
  };

  const handleLaneMarqueeDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Press = v4.9 seek parity (scrub may still happen below deadzone)…
    dragging.current = true;
    setScrubbing(true);
    try {
      // Capture on the LANE AXIS itself — empty-space targets (hints, lane
      // background) are not stable drag surfaces.
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // best-effort — bubbling still delivers the events
    }
    onSeek(xToMs(e.clientX));
    // …and record the origin so a move can convert into a rubber band.
    marqueeOriginRef.current = {
      x: e.clientX,
      y: e.clientY,
      pointerId: e.pointerId,
      additive: e.shiftKey,
    };
  };

  const handleLaneMarqueeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const o = marqueeOriginRef.current;
    if (o && o.pointerId === e.pointerId) {
      const dx = e.clientX - o.x;
      const dy = e.clientY - o.y;
      if (
        marqueeActiveRef.current ||
        Math.abs(dx) > DRAG_DEADZONE_PX ||
        Math.abs(dy) > DRAG_DEADZONE_PX
      ) {
        if (!marqueeActiveRef.current) {
          // Convert: stop scrubbing, snapshot the additive base selection and
          // the content rect (client → content-local mapping for the band).
          marqueeActiveRef.current = true;
          dragging.current = false;
          setScrubbing(false);
          marqueeBaseSelRef.current = o.additive ? selectedIdsProp ?? [] : [];
          marqueeRectRef.current =
            contentRef.current?.getBoundingClientRect() ?? null;
        }
        const cr = marqueeRectRef.current;
        if (cr) {
          setMarquee({
            x0: o.x - cr.left,
            y0: o.y - cr.top,
            x1: e.clientX - cr.left,
            y1: e.clientY - cr.top,
          });
        }
        const band = marqueeClipIds(o.x, e.clientX, o.y, e.clientY);
        const next =
          marqueeBaseSelRef.current.length > 0
            ? Array.from(new Set([...marqueeBaseSelRef.current, ...band]))
            : band;
        onSelectionChange?.(next);
        return;
      }
    }
    // Deadzone not passed (or not our gesture) — legacy scrub + hover ghost.
    handlePointerMove(e);
  };

  const handleLaneMarqueeUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const o = marqueeOriginRef.current;
    // A pointerup is a LANE gesture only when THIS lane received the matching
    // pointerdown (clip pills stopPropagation on the way DOWN, but their UP
    // events bubble here — treating those as empty-space clicks would wipe
    // the selection the clip's own handler just committed).
    const wasLaneGesture = o != null && o.pointerId === e.pointerId;
    const wasMarquee = marqueeActiveRef.current;
    marqueeOriginRef.current = null;
    marqueeActiveRef.current = false;
    if (!wasLaneGesture) return; // bubbled release from a clip above — ignore
    if (wasMarquee) {
      setMarquee(null);
      return; // selection already committed live during the drag
    }
    // Plain click on empty lane space clears the selection.
    if (onSelectionChange && (selectedIdsProp?.length ?? 0) > 0) {
      onSelectionChange([]);
    }
    handlePointerUp();
  };

  const handleLaneMarqueeAbort = (e: ReactPointerEvent<HTMLDivElement>) => {
    const o = marqueeOriginRef.current;
    if (o == null || o.pointerId !== e.pointerId) return; // not our gesture
    const wasMarquee = marqueeActiveRef.current;
    marqueeOriginRef.current = null;
    marqueeActiveRef.current = false;
    if (wasMarquee) setMarquee(null);
    handlePointerUp();
  };

  const scrubHandlers = {
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
    onPointerCancel: handlePointerUp,
  };

  /** v5.4: base + overlay lane axes use the marquee-aware handlers (press
   *  still seeks; drag past the deadzone rubber-bands). The ruler strip,
   *  playhead grabber, audio + SFX lanes keep the pure scrub handlers. */
  const laneMarqueeHandlers = {
    onPointerDown: handleLaneMarqueeDown,
    onPointerMove: handleLaneMarqueeMove,
    onPointerUp: handleLaneMarqueeUp,
    onPointerCancel: handleLaneMarqueeAbort,
  };

  const empty = segments.length === 0 && (!isV5 || sfxList.length === 0);

  const jumpToSeg =
    (seg: MediaSegment) => (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      onSeek(seg.startMs + 5);
      onJumpToSegment?.(seg.id);
    };

  // ------------------------------------------------------------------
  // v5.1 toolbar state: split needs the playhead strictly inside the active
  // clip (>100ms from both edges — the page-level splitAtPlayhead contract);
  // copy/trash need any active segment.
  // ------------------------------------------------------------------
  const hasActive = isV5 && activeSegment != null;
  const canSplit =
    isV5 &&
    activeSegment != null &&
    onSplit != null &&
    currentMs > activeSegment.startMs + 100 &&
    currentMs < activeSegment.endMs - 100;

  // v5.4 selection derived (kept cheap — these arrays are tiny).
  const selCount = selectedIdsProp?.length ?? 0;
  const isSel = (id: string) =>
    !!selectedIdsProp && selectedIdsProp.includes(id);

  /** Small icon button (28px, header undo/redo styling — v5.1: disabled
   *  reads at 40% opacity, danger hovers red, tooltip + aria-label). */
  const toolBtn = (
    icon: ReactNode,
    label: string,
    onClick: (() => void) | undefined,
    disabled: boolean,
    opts?: { danger?: boolean },
  ) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || onClick == null}
      title={label}
      aria-label={label}
      className={cn(
        "flex size-7 items-center justify-center rounded-md transition-all active:scale-90",
        disabled || onClick == null
          ? "cursor-not-allowed text-zinc-600 opacity-40"
          : opts?.danger
            ? "text-zinc-300 hover:bg-red-500/15 hover:text-red-300"
            : "text-zinc-300 hover:bg-white/10 hover:text-white",
      )}
    >
      {icon}
    </button>
  );

  // ------------------------------------------------------------------
  // v5.4.1 CONTEXT MENU — items (built per target) + rendering.
  // ------------------------------------------------------------------
  /** Total BASE-lane extent (the "entire video" target for overlays). */
  const baseTotalMs = baseSegs.reduce(
    (a, s) => Math.max(a, s.startMs + s.durationMs),
    0,
  );

  interface CtxItem {
    icon?: LucideIcon;
    label: string;
    kbd?: string;
    onClick?: () => void;
    /** Data-only action for the ONE item whose handler reads a ref — keeps
     *  the items array free of ref-reading closures (react-hooks/refs). */
    action?: "fit";
    disabled?: boolean;
    danger?: boolean;
    sep?: boolean;
  }

  const ctxClose = () => setCtxMenu(null);

  /** Fit action as a stable callback (the react-hooks/refs rule forbids
   *  ref reads inside render-built closures — same pattern as zoomTo). */
  const fitTimeline = useCallback(() => {
    const el = scrollRef.current;
    setPxPerSec(fitPxPerSec());
    if (el) el.scrollLeft = 0;
  }, [fitPxPerSec]);

  const ctxItems: CtxItem[] = (() => {
    if (!ctxMenu) return [];
    if (ctxMenu.kind === "clip") {
      const seg = segments.find((s) => s.id === ctxMenu.id);
      if (!seg) return [];
      const sel = selectedIdsProp ?? [];
      const multi = sel.length > 1 && sel.includes(seg.id);
      const isOverlay = seg.track >= 1;
      const canSplitHere =
        onSplit != null &&
        currentMs > seg.startMs + 100 &&
        currentMs < seg.endMs - 100;
      const items: CtxItem[] = [
        {
          icon: Play,
          label: "Jump to clip",
          kbd: "dbl-click",
          onClick: () => {
            onSeek(seg.startMs + 5);
            onJumpToSegment?.(seg.id);
          },
        },
        {
          icon: Scissors,
          label: "Split at playhead",
          kbd: "S",
          disabled: !canSplitHere,
          onClick: onSplit,
        },
        {
          icon: Copy,
          label: "Duplicate",
          onClick: onDuplicate ? () => onDuplicate(seg.id) : undefined,
          disabled: onDuplicate == null,
        },
        { sep: true, label: "" },
      ];
      if (isOverlay) {
        const startMs = Math.max(0, seg.startMs);
        items.push({
          icon: Clapperboard,
          label: "Move to Video track",
          onClick: onEditItem
            ? () => onEditItem(seg.id, { track: 0, startMs })
            : undefined,
          disabled: onEditItem == null,
        });
        if (seg.mediaType === "video") {
          items.push(
            {
              icon: Repeat,
              label: "Span entire video",
              disabled: baseTotalMs <= 0,
              onClick: onEditItem
                ? () =>
                    onEditItem(seg.id, {
                      durationMs: Math.max(
                        200,
                        Math.round(baseTotalMs - startMs),
                      ),
                      overlayLoop: true,
                    })
                : undefined,
            },
            {
              icon: Repeat,
              label: seg.overlayLoop ? "Stop looping source" : "Loop source",
              onClick: onEditItem
                ? () =>
                    onEditItem(seg.id, {
                      overlayLoop: seg.overlayLoop === true ? undefined : true,
                    })
                : undefined,
            },
          );
        }
      } else {
        items.push({
          icon: Layers,
          label: "Move to Overlay track",
          onClick: onEditItem
            ? () => onEditItem(seg.id, { track: 1, startMs: seg.startMs })
            : undefined,
          disabled: onEditItem == null,
        });
      }
      items.push(
        { sep: true, label: "" },
        {
          icon: Trash2,
          label: multi ? `Delete ${sel.length} clips` : "Delete",
          kbd: "Del",
          danger: true,
          onClick: multi
            ? onRemoveMany
              ? () => onRemoveMany(sel)
              : undefined
            : onRemove
              ? () => onRemove(seg.id)
              : undefined,
          disabled:
            (multi && onRemoveMany == null) || (!multi && onRemove == null),
        },
      );
      return items;
    }
    if (ctxMenu.kind === "sfx") {
      const item = sfxList.find((s) => s.id === ctxMenu.id);
      if (!item) return [];
      const def = getSfxDef(item.sfxId);
      return [
        {
          icon: Play,
          label: `Jump to ${def?.label ?? "effect"}`,
          onClick: () => onSeek(Math.max(0, item.startMs)),
        },
        {
          icon: Timer,
          label: "Edit duration",
          onClick: undefined,
          disabled: true,
        },
        { sep: true, label: "" },
        {
          icon: Trash2,
          label: "Remove effect",
          kbd: "Alt+click",
          danger: true,
          onClick: onRemoveSfx ? () => onRemoveSfx(item.id) : undefined,
          disabled: onRemoveSfx == null,
        },
      ];
    }
    if (ctxMenu.kind === "music") {
      return [
        {
          icon: Play,
          label: "Jump to music start",
          onClick: () => onSeek(Math.max(0, musicStart)),
        },
        {
          icon: Maximize,
          label: "Move to 00:00",
          onClick: onMusicMove ? () => onMusicMove(0) : undefined,
          disabled: onMusicMove == null || musicStart <= 0,
        },
        {
          icon: Repeat,
          label: musicLoop ? "Stop looping" : "Loop full video",
          onClick: onMusicLoopChange
            ? () => onMusicLoopChange(!musicLoop)
            : undefined,
          disabled: onMusicLoopChange == null,
        },
      ];
    }
    // Empty lane space
    return [
      {
        icon: Layers,
        label: "Select all clips",
        kbd: "Ctrl+A",
        disabled: segments.length === 0,
        onClick: onSelectionChange
          ? () => onSelectionChange(segments.map((s) => s.id))
          : undefined,
      },
      {
        icon: X,
        label: "Clear selection",
        kbd: "Esc",
        disabled: selCount === 0 || onSelectionChange == null,
        onClick: onSelectionChange ? () => onSelectionChange([]) : undefined,
      },
      { sep: true, label: "" },
      {
        icon: Maximize,
        label: "Fit timeline to panel",
        disabled: totalMs <= 0,
        action: "fit",
      },
    ];
  })();

  /** Indices of actionable rows (for keyboard navigation). */
  const ctxEnabled = ctxItems
    .map((it, i) => ({ it, i }))
    .filter(
      ({ it }) =>
        !it.sep && !it.disabled && (it.onClick != null || it.action != null),
    );

  const ctxMove = (dir: 1 | -1) => {
    if (ctxEnabled.length === 0) return;
    const pos = ctxEnabled.findIndex(({ i }) => i === ctxIdx);
    const next =
      ctxEnabled[(pos + dir + ctxEnabled.length) % ctxEnabled.length];
    setCtxIdx(next.i);
  };
  const ctxActivate = () => {
    const row = ctxItems[ctxIdx];
    if (!row || row.sep || row.disabled) return;
    if (row.action === "fit") {
      fitTimeline();
      setCtxMenu(null);
      return;
    }
    if (row.onClick) {
      row.onClick();
      setCtxMenu(null);
    }
  };

  // Viewport clamp: measure the open menu and keep it fully on-screen.
  useLayoutEffect(() => {
    const el = ctxListRef.current;
    if (!el || !ctxMenu) return;
    const maxX = window.innerWidth - el.offsetWidth - 8;
    const maxY = window.innerHeight - el.offsetHeight - 8;
    el.style.left = Math.max(8, Math.min(ctxMenu.x, Math.max(8, maxX))) + "px";
    el.style.top = Math.max(8, Math.min(ctxMenu.y, Math.max(8, maxY))) + "px";
  }, [ctxMenu, ctxItems.length]);

  // Focus the menu when it opens (keyboard flow); the backdrop handles
  // outside clicks. Both stopPropagation so page-level shortcuts (Esc =
  // clear selection) never fire while the menu is open.
  useEffect(() => {
    if (ctxMenu) ctxListRef.current?.focus();
  }, [ctxMenu]);

  return (
    <div
      className="border-t px-4 py-3"
      style={{
        borderColor: "#27272a",
        backgroundColor: "#111113",
        ...(isV5
          ? {}
          : {
              height: hasWave ? "140px" : "120px",
              transition: "height 200ms ease",
            }),
      }}
    >
      {/* Header row 1: label + mode + active-clip duration chip | legend */}
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          Timeline
          {mode && (
            <span
              className="rounded px-1.5 py-0.5 text-[9px] font-bold"
              style={
                mode === "absolute"
                  ? {
                      backgroundColor: "rgba(8, 51, 68, 0.5)",
                      color: "#67e8f9",
                    }
                  : {
                      backgroundColor: "rgba(76, 29, 149, 0.5)",
                      color: "#c4b5fd",
                    }
              }
            >
              {mode}
            </span>
          )}
          {/* v5.1 CapCut: playhead position readout chip — a cyan mono chip
              with a tiny playhead tick, 1:1 with the line on the ruler. */}
          {isV5 && totalMs > 0 && (
            <span
              className="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[9px] font-bold tabular-nums normal-case"
              style={{
                backgroundColor: "rgba(8, 51, 68, 0.45)",
                color: "#67e8f9",
              }}
              title="Playhead position — drag the ruler or the playhead grabber to move it"
            >
              <span
                className="h-2 w-0.5 rounded-full"
                style={{
                  backgroundColor: "#22d3ee",
                  boxShadow: "0 0 4px rgba(34, 211, 238, 0.8)",
                }}
                aria-hidden
              />
              {fmtTcTenths(currentMs)}
            </span>
          )}
          {/* v5.1: 1:1 active-clip duration chip (visible while a segment
              is selected — playhead inside it). */}
          {isV5 && activeSegment != null && (
            <span
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-bold tabular-nums normal-case"
              style={{ backgroundColor: "rgba(39, 39, 42, 0.55)", color: "#a1a1aa" }}
              title={`Active clip — ${fmtTimecode(activeSegment.startMs)} to ${fmtTimecode(activeSegment.endMs)} · ${(activeSegment.durationMs / 1000).toFixed(2)}s`}
            >
              <Timer className="size-2.5" aria-hidden />
              {fmtTimecode(activeSegment.durationMs)}
              <span className="font-medium opacity-70">
                · {(activeSegment.durationMs / 1000).toFixed(1)}s
              </span>
            </span>
          )}
          {/* v5.4: multi-select count chip — amber accent (distinct from the
              cyan playhead-position chip). X clears; Esc does the same. */}
          {isV5 && selCount > 0 && (
            <span
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-bold tabular-nums normal-case"
              style={{ backgroundColor: "rgba(69, 26, 3, 0.55)", color: "#fcd34d" }}
              title="Selected clips — Del removes all of them, Esc clears · click, Ctrl-click, Shift-click or drag a band on an empty lane to select"
            >
              <Layers className="size-2.5" aria-hidden />
              {selCount} selected
              {onSelectionChange && (
                <button
                  type="button"
                  onClick={() => onSelectionChange([])}
                  aria-label="Clear selection (Esc)"
                  title="Clear selection (Esc)"
                  className="-mr-0.5 rounded p-0.5 transition-colors hover:bg-amber-400/25"
                >
                  <X className="size-2.5" aria-hidden />
                </button>
              )}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[9px] text-zinc-500">
          <span className="flex items-center gap-1">
            <LegendDot color="#06b6d4" /> absolute
          </span>
          <span className="flex items-center gap-1">
            <LegendDot color="#10b981" /> beat
          </span>
          <span className="flex items-center gap-1">
            <LegendDot color="#8b5cf6" /> duration
          </span>
          {txActive && (
            <span className="flex items-center gap-1">
              <LegendDot gradient="linear-gradient(135deg, #8b5cf6, #d946ef)" />{" "}
              transition
            </span>
          )}
          {headlines.length > 0 && (
            <span className="flex items-center gap-1">
              <LegendDot color="#fbbf24" /> title
            </span>
          )}
          {beats && beats.length > 0 && (
            <span className="flex items-center gap-1">
              <LegendDot color="#22d3ee" /> beats
            </span>
          )}
          {hasWave && (
            <span className="flex items-center gap-1">
              <AudioLines className="size-2.5 text-cyan-300" /> audio
            </span>
          )}
          {isV5 && overlaySegs.length > 0 && (
            <span className="flex items-center gap-1">
              <Layers className="size-2.5 text-violet-300" aria-hidden />{" "}
              overlay
            </span>
          )}
          {isV5 && sfxList.length > 0 && (
            <span className="flex items-center gap-1">
              <Zap className="size-2.5 text-amber-300" aria-hidden /> sfx
            </span>
          )}
        </div>
      </div>

      {/* v5.1 row 2: clip tools (split / duplicate / delete) + zoom controls —
          both groups sit in matching #18181b toolbar strips. */}
      {isV5 && !empty && (
        <div className="mb-2 flex items-center justify-between gap-2">
          <div
            className="flex items-center gap-1 rounded-lg border p-0.5"
            style={{ borderColor: "#27272a", backgroundColor: "#18181b" }}
            role="group"
            aria-label="Clip tools"
          >
            {toolBtn(
              <Scissors className="size-4" />,
              "Split at playhead (S)",
              onSplit,
              !canSplit,
            )}
            <div className="h-4 w-px" style={{ backgroundColor: "#27272a" }} />
            {toolBtn(
              <Copy className="size-4" />,
              "Duplicate clip",
              hasActive && onDuplicate && activeSegment
                ? () => onDuplicate(activeSegment.id)
                : undefined,
              !hasActive,
            )}
            {toolBtn(
              <Trash2 className="size-4" />,
              selCount > 1
                ? `Delete ${selCount} selected clips (Del)`
                : "Delete (Del)",
              selCount > 0 && onRemoveMany && selectedIdsProp
                ? () => onRemoveMany(selectedIdsProp)
                : hasActive && onRemove && activeSegment
                  ? () => onRemove(activeSegment.id)
                  : undefined,
              selCount === 0 && !hasActive,
              { danger: true },
            )}
          </div>
          {/* v5.1 CapCut: compact zoom strip — 28px icon buttons, an 80px
              slim slider, and a small text "Fit" button, all in one rounded
              toolbar strip (matching the clip tools). */}
          <div
            className="flex items-center gap-0.5 rounded-lg border p-0.5"
            style={{ borderColor: "#27272a", backgroundColor: "#18181b" }}
            role="group"
            aria-label="Timeline zoom"
          >
            <button
              type="button"
              onClick={() => zoomTo(pxPerSec / 1.15, viewportW / 2)}
              title="Zoom out (Ctrl+scroll on the timeline)"
              aria-label="Zoom out"
              className="flex size-7 items-center justify-center rounded-md text-zinc-300 transition-all hover:bg-white/10 hover:text-white active:scale-90"
            >
              <ZoomOut className="size-3.5" />
            </button>
            <input
              type="range"
              min={ZOOM_MIN}
              max={ZOOM_MAX}
              step={1}
              value={Math.round(pxPerSec)}
              onChange={(e) => zoomTo(Number(e.target.value), viewportW / 2)}
              aria-label="Timeline zoom (pixels per second)"
              title={`Timeline zoom — ${Math.round(pxPerSec)} px/s (Ctrl+scroll on the timeline)`}
              className="w-20 accent-cyan-500"
            />
            <button
              type="button"
              onClick={() => zoomTo(pxPerSec * 1.15, viewportW / 2)}
              title="Zoom in (Ctrl+scroll on the timeline)"
              aria-label="Zoom in"
              className="flex size-7 items-center justify-center rounded-md text-zinc-300 transition-all hover:bg-white/10 hover:text-white active:scale-90"
            >
              <ZoomIn className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                const el = scrollRef.current;
                setPxPerSec(fitPxPerSec());
                if (el) el.scrollLeft = 0;
              }}
              title="Fit timeline to the panel"
              aria-label="Fit timeline"
              className="rounded-md px-1.5 py-1 text-[10px] font-semibold text-cyan-300 transition-all hover:bg-cyan-500/15 hover:text-cyan-200 active:scale-95"
            >
              Fit
            </button>
          </div>
        </div>
      )}

      {empty ? (
        <div
          className="flex h-14 items-center justify-center rounded-lg border border-dashed text-[11px]"
          style={{ borderColor: "#27272a", color: "#52525b" }}
        >
          Timeline appears once images are added
        </div>
      ) : isV5 ? (
        /* ---------------------------------------------------------------
           v5.0 — 4-LANE EDITOR. Rows: [64px sticky label gutter | time axis].
           v5.1 — the axis is PIXEL laid-out (pxPerSec) inside a horizontal
           scroll container: content width = gutter + totalSec·pxPerSec.
           The playhead / hover ghost / drag tooltip are absolutely
           positioned on the CONTENT wrapper, so each is one continuous
           element spanning every lane that scrolls with the media.
           --------------------------------------------------------------- */
        <div
          className="relative w-full touch-none select-none rounded-lg border"
          style={{
            borderColor: "#27272a",
            backgroundColor: "rgba(9, 9, 11, 0.6)",
          }}
          onPointerLeave={() => setHoverRatio(null)}
        >
          {/* v5.1: horizontal scroll viewport. The 7px top padding is the
              rail the playhead grab cap pokes into (it must stay inside the
              scrollport or overflow-y-hidden would clip it). */}
          <div
            ref={scrollRef}
            className="overflow-x-auto overflow-y-hidden"
            style={{ paddingTop: 7 }}
            onScroll={() => {
              // Panning the timeline closes the menu (its anchor is
              // viewport-fixed and would visually detach).
              if (ctxMenu != null) setCtxMenu(null);
            }}
          >
          <div
            ref={contentRef}
            className="relative flex flex-col"
            style={{
              width: Math.max(GUTTER_W + axisW, viewportW || GUTTER_W + axisW),
            }}
          >
          {/* Ruler */}
          <div
            className="flex shrink-0 border-b"
            style={{ height: TICKS_H, borderColor: ROW_BORDER }}
          >
            <div
              className="sticky left-0 z-[7] w-16 shrink-0 border-r"
              style={{ borderColor: GUTTER_BORDER, backgroundColor: "#0c0c0e" }}
            />
            <div
              ref={trackRef}
              className="relative min-w-0 shrink-0 cursor-pointer"
              style={{ width: axisW }}
              {...scrubHandlers}
            >
              <TickRow ticks={ticks} totalMs={totalMs} layout={layout} />
            </div>
          </div>

          {/* LANE 1 — VIDEO (base filmstrips; all v4.9 rendering) */}
          <div
            role="group"
            aria-label="Video lane"
            className="flex shrink-0 border-b"
            style={{ height: BASE_H, borderColor: ROW_BORDER, backgroundColor: LANE_BG_A }}
          >
            <LaneLabel icon={Clapperboard} text="Video" accent="#22d3ee" sticky />
            <div
              ref={baseAxisRef}
              className="relative min-w-0 shrink-0 transition-colors hover:bg-white/[0.02]"
              style={{ width: axisW }}
              onContextMenu={openLaneMenu}
              {...laneMarqueeHandlers}
            >
              {baseSegs.length === 0 ? (
                <EmptyHint>No base clips — media stacks here</EmptyHint>
              ) : (
                <>
                  <HeadlineChips
                    headlines={headlines}
                    totalMs={totalMs}
                    currentMs={currentMs}
                    onSeek={onSeek}
                    layout={layout}
                  />
                  <div
                    className="absolute left-0 right-0"
                    style={{ top: 12, bottom: 4 }}
                  >
                    {baseSegs.map((seg, idx) => {
                      const preview = clipPreviewFor(seg.id);
                      return (
                        <FilmstripBar
                          key={seg.id}
                          seg={seg}
                          idx={idx}
                          totalMs={totalMs}
                          isActive={seg.id === activeId}
                          selected={isSel(seg.id)}
                          onActivate={jumpToSeg(seg)}
                          onContextMenu={
                            isV5 ? (e) => openClipMenu(e, seg) : undefined
                          }
                          drag={
                            onEditItem
                              ? {
                                  onPointerDown: (e) =>
                                    beginClipDrag(e, seg, "move"),
                                  onPointerMove: handleClipPointerMove,
                                  onPointerUp: handleClipPointerUp,
                                  onPointerCancel: handleDragAbort,
                                  onLostPointerCapture: handleDragAbort,
                                }
                              : undefined
                          }
                          // v5.3: base-lane trim handles — same gesture
                          // machinery as the overlay clips (edge divs press
                          // "trim-l" / "trim-r"; the root carries move/up).
                          trim={
                            onEditItem
                              ? {
                                  onTrimStart: (e) =>
                                    beginClipDrag(e, seg, "trim-l"),
                                  onTrimEnd: (e) =>
                                    beginClipDrag(e, seg, "trim-r"),
                                  onLostPointerCapture: handleDragAbort,
                                }
                              : undefined
                          }
                          previewStartMs={preview?.startMs}
                          previewDurationMs={preview?.durationMs}
                          dragging={preview != null}
                          layout={layout}
                        />
                      );
                    })}
                    <TransitionZones
                      segs={baseSegs}
                      transition={transition}
                      totalMs={totalMs}
                      currentMs={currentMs}
                      txActive={txActive}
                      txOverridesActive={txOverridesActive}
                      layout={layout}
                    />
                    {/* v5.1 CapCut: boundary diamonds above the filmstrips. */}
                    <TransitionDiamonds
                      segs={baseSegs}
                      transition={transition}
                      layout={layout}
                    />
                  </div>
                  <BeatRail
                    beats={beats}
                    totalMs={totalMs}
                    beatNearest={beatNearest}
                    layout={layout}
                  />
                </>
              )}
            </div>
          </div>

          {/* LANE 2 — OVERLAY (track >= 1, greedy sub-row packing) */}
          <div
            role="group"
            aria-label="Overlay lane"
            className="flex shrink-0 border-b"
            style={{
              height: overlayLaneH,
              borderColor: ROW_BORDER,
              backgroundColor: LANE_BG_B,
            }}
          >
            <LaneLabel icon={Layers} text="OVL" accent="#a78bfa" sticky />
            <div
              ref={overlayAxisRef}
              className="relative min-w-0 shrink-0 transition-colors hover:bg-white/[0.02]"
              style={{ width: axisW }}
              onContextMenu={openLaneMenu}
              {...laneMarqueeHandlers}
            >
              {overlaySegs.length === 0 ? (
                <EmptyHint>
                  No overlay clips — drop media on the Overlay track
                </EmptyHint>
              ) : (
                overlayPack.entries.map(({ seg, row }) => {
                  const pv = clipPreviewFor(seg.id);
                  const startMs = pv?.startMs ?? seg.startMs;
                  const durMs = pv?.durationMs ?? seg.durationMs;
                  const pos =
                    layout != null
                      ? {
                          left: layout.pxOf(startMs),
                          width: Math.max(
                            2,
                            layout.pxOf(startMs + durMs) - layout.pxOf(startMs),
                          ),
                        }
                      : {
                          left: `${totalMs > 0 ? (startMs / totalMs) * 100 : 0}%`,
                          width: `${totalMs > 0 ? Math.max(0.4, (durMs / totalMs) * 100) : 0}%`,
                        };
                  const isVideo = seg.mediaType === "video";
                  const draggable = !!onEditItem;
                  const ovSelected = isSel(seg.id);
                  return (
                    <div
                      key={seg.id}
                      role={draggable ? "button" : undefined}
                      tabIndex={draggable ? 0 : undefined}
                      aria-label={`${seg.fileName}, overlay clip, ${fmtTimecode(startMs)} to ${fmtTimecode(startMs + durMs)}${ovSelected ? ", selected" : ""}`}
                      className={cn(
                        // v5.1 CapCut card: 6px radius, hover lift + cyan
                        // hairline outline, edge-trim zones (below) glow
                        // cyan on group hover. Transition killed while
                        // dragging (the preview must track 1:1).
                        "group absolute flex select-none items-center gap-1 overflow-hidden rounded-md border pl-[2px] pr-2 text-[8px] font-semibold text-zinc-200",
                        draggable
                          ? "cursor-grab touch-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-300/70"
                          : "cursor-pointer",
                        // v5.4: amber selection ring (outline — never fights the
                        // inline boxShadow states below).
                        ovSelected && "ff-clip-selected",
                        pv != null
                          ? "z-[3] cursor-grabbing transition-none"
                          : "transition-all duration-150 hover:-translate-y-px hover:outline hover:outline-1 hover:outline-cyan-500/40",
                      )}
                      style={{
                        ...pos,
                        minWidth: 16,
                        top: OV_PAD + row * (OV_ROW_H + OV_GAP),
                        height: OV_ROW_H,
                        // Video overlays tint amber, image overlays violet —
                        // kind at a glance over a dark surface, app palette.
                        // v5.4: a SELECTED clip swaps its kind tint for the
                        // amber selection accent so the ring reads instantly.
                        backgroundColor: ovSelected
                          ? "rgba(245, 158, 11, 0.22)"
                          : isVideo
                            ? "rgba(251, 191, 36, 0.15)"
                            : "rgba(139, 92, 246, 0.20)",
                        borderColor: ovSelected
                          ? "rgba(245, 158, 11, 0.85)"
                          : isVideo
                            ? "rgba(251, 191, 36, 0.42)"
                            : "rgba(139, 92, 246, 0.55)",
                        boxShadow:
                          pv != null
                            ? "0 0 0 1.5px rgba(255,255,255,0.65), 0 4px 12px rgba(0,0,0,0.6)"
                            : ovSelected
                              ? "0 0 0 1px rgba(245,158,11,0.4), 0 0 12px rgba(245,158,11,0.22), 0 1px 3px rgba(0,0,0,0.45)"
                              : "0 1px 3px rgba(0,0,0,0.45)",
                      }}
                      title={`${seg.fileName} · overlay T${seg.track} · ${fmtTimecode(startMs)}–${fmtTimecode(startMs + durMs)} · ${(durMs / 1000).toFixed(1)}s${draggable ? "\ndrag to move · edges trim · drag down to the Video lane" : ""}\ndouble-click jumps to this clip's first frame\nright-click for actions`}
                      onContextMenu={(e) => openClipMenu(e, seg)}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        onSeek(startMs + 5);
                        onJumpToSegment?.(seg.id);
                      }}
                      onKeyDown={
                        draggable
                          ? (e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                e.stopPropagation();
                                onSeek(startMs + 5);
                                onJumpToSegment?.(seg.id);
                              }
                            }
                          : undefined
                      }
                      onPointerDown={
                        draggable
                          ? (e) => beginClipDrag(e, seg, "move")
                          : undefined
                      }
                      onPointerMove={handleClipPointerMove}
                      onPointerUp={handleClipPointerUp}
                      onPointerCancel={handleDragAbort}
                      onLostPointerCapture={handleDragAbort}
                    >
                      {/* Tiny thumbnail — the storyboard content chip. */}
                      <span
                        aria-hidden
                        className="size-4 shrink-0 rounded-[3px]"
                        style={{
                          backgroundImage: `url(${seg.thumbnailUrl})`,
                          backgroundSize: "cover",
                          backgroundPosition: "center",
                          backgroundColor: "rgba(0,0,0,0.4)",
                        }}
                      />
                      <span className="min-w-0 flex-1 truncate text-zinc-100/90">
                        {seg.fileName.replace(/\.[^.]+$/, "")}
                      </span>
                      <span className="shrink-0 tabular-nums text-zinc-300/80">
                        {(durMs / 1000).toFixed(1)}s
                      </span>
                      {/* Trim handles — v5.1 CapCut: fixed 6px cyan zones that
                          fade in on clip hover (group-hover). The shared
                          move/up handlers live on the clip root and receive
                          the captured edge events via bubbling — interaction
                          UNCHANGED, visuals only. */}
                      {draggable && (
                        <>
                          <div
                            className="absolute inset-y-0 left-0 z-[2] w-[6px] cursor-ew-resize touch-none bg-cyan-400/25 opacity-0 shadow-[inset_1px_0_0_rgba(34,211,238,0.6)] transition-opacity duration-100 group-hover:opacity-100"
                            title="Drag to trim the start"
                            onPointerDown={(e) =>
                              beginClipDrag(e, seg, "trim-l")
                            }
                            onLostPointerCapture={handleDragAbort}
                          />
                          <div
                            className="absolute inset-y-0 right-0 z-[2] w-[6px] cursor-ew-resize touch-none bg-cyan-400/25 opacity-0 shadow-[inset_-1px_0_0_rgba(34,211,238,0.6)] transition-opacity duration-100 group-hover:opacity-100"
                            title="Drag to trim the end"
                            onPointerDown={(e) =>
                              beginClipDrag(e, seg, "trim-r")
                            }
                            onLostPointerCapture={handleDragAbort}
                          />
                        </>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* LANE 3 — AUDIO (v5.2: DRAGGABLE background-music clip with volume
              + loop controls — a first-class timeline citizen instead of a
              read-only strip). Cyan-900/20-tinted while a waveform is loaded. */}
          <div
            role="group"
            aria-label="Audio lane"
            className="flex shrink-0 border-b"
            style={{
              height: AUDIO_H,
              borderColor: ROW_BORDER,
              backgroundColor: hasWave ? LANE_BG_WAVE : LANE_BG_A,
            }}
          >
            <LaneLabel icon={AudioLines} text="Audio" accent="#67e8f9" sticky />
            <div
              className="relative min-w-0 shrink-0 transition-colors hover:bg-white/[0.02]"
              style={{ width: axisW }}
              {...scrubHandlers}
            >
              {hasWave && waveform ? (
                <>
                  {/* Waveform anchored at the music start; repeats when the
                      loop-to-fill mode is on (progress stays audio-relative). */}
                  <WaveformStrip
                    data={waveform}
                    totalMs={totalMs}
                    currentMs={currentMs}
                    startMs={musicStart}
                    loop={musicLoop}
                    className="pointer-events-none absolute inset-x-1 inset-y-0"
                  />
                  {/* The music CLIP — drag to reposition; hover reveals the
                      volume slider + loop toggle popover. */}
                  {(() => {
                    const durMs =
                      musicDurationMs && musicDurationMs > 0
                        ? musicDurationMs
                        : waveform.durationMs;
                    const endMs = musicLoop
                      ? Math.max(totalMs, musicStart + 200)
                      : Math.min(totalMs, musicStart + durMs);
                    const left = layout ? layout.pxOf(musicStart) : 0;
                    const width = Math.max(
                      24,
                      layout
                        ? layout.pxOf(endMs) - left
                        : axisW * (endMs / Math.max(1, totalMs)),
                    );
                    const volPct = Math.round(
                      Math.max(0, Math.min(2, musicVolume)) * 100,
                    );
                    return (
                      <div
                        role="button"
                        tabIndex={0}
                        aria-label={`Background music clip starting at ${fmtTimecode(musicStart)}${musicLoop ? ", looping to fill the video" : ""}`}
                        className={cn(
                          // NOTE: no overflow-hidden AND no z-index — the
                          // hover popover (volume + loop) floats ABOVE the
                          // 34px lane and its z-[60] must escape this clip's
                          // subtree (a z here would create a stacking context
                          // that traps the popover under the video lane's
                          // z-[3] filmstrip bars). The clip still paints over
                          // the waveform strip (later absolute sibling).
                          "group absolute top-1 bottom-1 flex select-none items-center gap-1 rounded-md border pl-1.5 text-[8px] font-semibold",
                          onMusicMove
                            ? "cursor-grab touch-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-300/70"
                            : "cursor-pointer",
                          musicDrag && "cursor-grabbing",
                        )}
                        style={{
                          left,
                          width,
                          backgroundColor: musicDrag
                            ? "rgba(14, 165, 233, 0.30)"
                            : "rgba(14, 165, 233, 0.16)",
                          borderColor: musicLoop
                            ? "rgba(56, 189, 248, 0.75)"
                            : "rgba(56, 189, 248, 0.45)",
                          color: "#bae6fd",
                          boxShadow: musicDrag
                            ? "0 0 0 1.5px rgba(255,255,255,0.55), 0 3px 10px rgba(0,0,0,0.55)"
                            : "0 1px 2px rgba(0,0,0,0.45)",
                        }}
                        title={`Background music · starts ${fmtTimecode(musicStart)}${musicLoop ? " · loops to fill the video" : ` · ${fmtTimecode(durMs)} long`}${onMusicMove ? " · drag to reposition" : ""}\nright-click for actions`}
                        onContextMenu={openMusicMenu}
                        onPointerDown={beginMusicDrag}
                        onPointerMove={handleMusicPointerMove}
                        onPointerUp={handleMusicPointerUp}
                        onPointerCancel={handleMusicDragAbort}
                        onLostPointerCapture={handleMusicDragAbort}
                        onPointerEnter={() => setMusicHover(true)}
                        onPointerLeave={() => setMusicHover(false)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            onSeek(Math.max(0, musicStart));
                          }
                        }}
                      >
                        <Music2 className="size-2.5 shrink-0" aria-hidden />
                        <span className="min-w-0 flex-1 truncate">
                          {musicName
                            ? middleEllipsis(musicName, 28)
                            : "Background music"}
                        </span>
                        {musicLoop && (
                          <span
                            className="flex shrink-0 items-center gap-0.5 rounded px-1 py-px"
                            style={{
                              backgroundColor: "rgba(56, 189, 248, 0.22)",
                              border: "1px solid rgba(56, 189, 248, 0.4)",
                            }}
                            title="Looping — the track repeats to cover the ENTIRE video"
                          >
                            <Repeat className="size-2.5" aria-hidden />
                            loop
                          </span>
                        )}
                        <span
                          className="flex shrink-0 items-center gap-0.5 tabular-nums opacity-80"
                          title={`Music volume — ${volPct}% (adjust in the hover controls or Settings → Audio)`}
                        >
                          {volPct === 0 ? (
                            <VolumeX className="size-2.5" aria-hidden />
                          ) : (
                            <Volume2 className="size-2.5" aria-hidden />
                          )}
                          {volPct}%
                        </span>
                        {/* Hover popover: volume slider + loop toggle (floats
                            ABOVE the 34px lane so nothing is crammed).
                            top-0 + -translate-y-full keeps the popover's
                            bottom edge FLUSH with the clip's top edge — a
                            gap would break the pointer chain (the pointer
                            would fall through to the lane above and the
                            popover would close before the click lands). */}
                        {(onMusicVolumeChange || onMusicLoopChange) && (
                          <div
                            className="absolute top-0 left-1/2 z-[60] -translate-x-1/2 -translate-y-full transition-opacity duration-100"
                            style={{
                              opacity: musicHover || musicDrag ? 1 : 0,
                              pointerEvents: musicHover || musicDrag ? "auto" : "none",
                            }}
                          >
                            <div
                              className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 shadow-xl backdrop-blur-md"
                              style={{
                                backgroundColor: "rgba(24, 24, 27, 0.96)",
                                borderColor: "rgba(63, 63, 70, 0.9)",
                              }}
                              onPointerDown={(e) => e.stopPropagation()}
                            >
                              {onMusicVolumeChange && (
                                <label className="flex items-center gap-1.5 text-[9px] font-medium text-zinc-300">
                                  <Volume2 className="size-3 text-sky-300" aria-hidden />
                                  <input
                                    type="range"
                                    min={0}
                                    max={200}
                                    step={5}
                                    value={volPct}
                                    aria-label="Background music volume"
                                    className="w-24 accent-sky-400"
                                    onChange={(e) =>
                                      onMusicVolumeChange(
                                        Math.max(
                                          0,
                                          Math.min(2, Number(e.target.value) / 100),
                                        ),
                                      )
                                    }
                                  />
                                  <span className="w-8 tabular-nums text-zinc-400">
                                    {volPct}%
                                  </span>
                                </label>
                              )}
                              {onMusicLoopChange && (
                                <button
                                  type="button"
                                  aria-pressed={musicLoop}
                                  className={cn(
                                    "flex cursor-pointer items-center gap-1 rounded-md border px-1.5 py-1 text-[9px] font-semibold transition-colors",
                                    musicLoop
                                      ? "border-sky-400/70 bg-sky-500/25 text-sky-200"
                                      : "border-zinc-700 bg-zinc-800/70 text-zinc-300 hover:border-sky-400/50 hover:text-sky-200",
                                  )}
                                  title={
                                    musicLoop
                                      ? "Looping ON — the music repeats to cover the entire video length"
                                      : "Loop to fill the ENTIRE video — background tracks are usually longer than the edit"
                                  }
                                  onClick={() => onMusicLoopChange(!musicLoop)}
                                >
                                  <Repeat className="size-3" aria-hidden />
                                  {musicLoop ? "Looping" : "Loop full video"}
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </>
              ) : (
                <EmptyHint>
                  No music track — load audio from the Media tab
                </EmptyHint>
              )}
            </div>
          </div>

          {/* LANE 4 — SFX (draggable pills) */}
          <div
            role="group"
            aria-label="Sound effects lane"
            className="flex shrink-0 rounded-b-[7px]"
            style={{ height: SFX_H, backgroundColor: LANE_BG_B }}
          >
            <LaneLabel icon={Zap} text="SFX" accent="#fbbf24" sticky />
            <div
              className="relative min-w-0 shrink-0 transition-colors hover:bg-white/[0.02]"
              style={{ width: axisW }}
              {...scrubHandlers}
            >
              {sfxList.length === 0 ? (
                <EmptyHint>No sound effects — add from the Media tab</EmptyHint>
              ) : (
                sfxList.map((item) => {
                  const def = getSfxDef(item.sfxId);
                  const pv = sfxPreviewFor(item.id);
                  const startMs = Math.max(0, pv?.startMs ?? item.startMs);
                  // v5.3: width follows the EFFECTIVE duration (custom durMs
                  // override + live resize preview) — longer effects read as
                  // longer pills on the lane.
                  const durMs = pv?.durMs ?? sfxDurationMs(item);
                  const pos =
                    layout != null
                      ? {
                          left: layout.pxOf(startMs),
                          width: Math.max(
                            2,
                            layout.pxOf(startMs + durMs) - layout.pxOf(startMs),
                          ),
                        }
                      : {
                          left: `${
                            totalMs > 0
                              ? Math.max(0, Math.min(100, (startMs / totalMs) * 100))
                              : 0
                          }%`,
                          width: `${totalMs > 0 ? Math.max(0.2, (durMs / totalMs) * 100) : 0}%`,
                        };
                  return (
                    <div
                      key={item.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`${def?.label ?? "Sound effect"} effect at ${fmtTimecode(startMs)}`}
                      className={cn(
                        "group absolute select-none rounded-full border pl-1.5 pr-2 text-[8px] font-semibold",
                        onMoveSfx
                          ? "cursor-grab touch-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-300/70"
                          : "cursor-pointer",
                        pv != null && "z-[3] cursor-grabbing",
                      )}
                      style={{
                        ...pos,
                        minWidth: 28,
                        top: 4,
                        height: 22,
                        // v5.1 CapCut: violet pills (overlay-lane accent),
                        // hot-tracked while dragging.
                        backgroundColor:
                          pv != null
                            ? "rgba(139, 92, 246, 0.34)"
                            : "rgba(139, 92, 246, 0.16)",
                        borderColor: "rgba(167, 139, 250, 0.5)",
                        color: "#ddd6fe",
                        boxShadow:
                          pv != null
                            ? "0 0 0 1.5px rgba(255,255,255,0.55), 0 3px 10px rgba(0,0,0,0.55)"
                            : "0 1px 2px rgba(0,0,0,0.45)",
                      }}
                      title={`${def?.label ?? item.sfxId} · ${fmtTimecode(startMs)} · ${(durMs / 1000).toFixed(2)}s · click to seek${onMoveSfx ? ", drag to move" : ""}${onEditSfx ? ", drag edges to resize" : ""}${onRemoveSfx ? ", Alt+click or x to remove" : ""}\nright-click for actions`}
                      onContextMenu={(e) => openSfxMenu(e, item.id)}
                      onPointerDown={(e) => beginSfxDrag(e, item)}
                      onPointerMove={handleSfxPointerMove}
                      onPointerUp={handleSfxPointerUp}
                      onPointerCancel={handleDragAbort}
                      onLostPointerCapture={handleDragAbort}
                      onClick={(e) => {
                        if (e.altKey && onRemoveSfx) {
                          e.stopPropagation();
                          onRemoveSfx(item.id);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onSeek(Math.max(0, item.startMs));
                        } else if (
                          (e.key === "Delete" || e.key === "Backspace") &&
                          onRemoveSfx
                        ) {
                          e.preventDefault();
                          onRemoveSfx(item.id);
                        }
                      }}
                    >
                      <span
                        className="flex shrink-0 items-center"
                        aria-hidden
                      >
                        <Zap className="size-2.5" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {def?.label ?? item.sfxId}
                      </span>
                      <span className="shrink-0 tabular-nums opacity-70">
                        {(durMs / 1000).toFixed(durMs < 1000 ? 2 : 1)}s
                      </span>
                      {/* v5.3: edge resize handles — amber (SFX accent) 5px
                          zones fading in on hover, same gesture plumbing as
                          the clip trim handles. */}
                      {onEditSfx && (
                        <>
                          <div
                            className="absolute inset-y-0 left-0 z-[2] w-[5px] cursor-ew-resize touch-none bg-amber-400/30 opacity-0 shadow-[inset_1px_0_0_rgba(251,191,36,0.7)] transition-opacity duration-100 group-hover:opacity-100"
                            title="Drag to lengthen/shorten the effect (start pinned)"
                            aria-hidden
                            onPointerDown={(e) =>
                              beginSfxDrag(e, item, "resize-l")
                            }
                            onLostPointerCapture={handleDragAbort}
                          />
                          <div
                            className="absolute inset-y-0 right-0 z-[2] w-[5px] cursor-ew-resize touch-none bg-amber-400/30 opacity-0 shadow-[inset_-1px_0_0_rgba(251,191,36,0.7)] transition-opacity duration-100 group-hover:opacity-100"
                            title="Drag to lengthen/shorten the effect"
                            aria-hidden
                            onPointerDown={(e) =>
                              beginSfxDrag(e, item, "resize-r")
                            }
                            onLostPointerCapture={handleDragAbort}
                          />
                        </>
                      )}
                      {onRemoveSfx && (
                        <button
                          type="button"
                          aria-label={`Remove ${def?.label ?? "sound effect"}`}
                          className="absolute -right-1 -top-1 z-[2] flex size-[14px] cursor-pointer items-center justify-center rounded-full border opacity-0 transition-opacity hover:border-red-400/60 hover:bg-red-500/70 focus-visible:opacity-100 group-hover:opacity-100"
                          style={{
                            borderColor: "rgba(63, 63, 70, 0.9)",
                            backgroundColor: "#27272a",
                            color: "#d4d4d8",
                          }}
                          onPointerDown={(e) => {
                            // Don't start a pill drag / press-seek from the x.
                            e.stopPropagation();
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemoveSfx(item.id);
                          }}
                        >
                          <X className="size-2.5" aria-hidden />
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* v5.4: marquee rubber band (content-local px) — amber tint to
              match the selection accent; lives above the clips (z-8), below
              the playhead, and never intercepts pointer events. */}
          {marquee != null && (
            <div
              className="ff-marquee pointer-events-none absolute z-[8]"
              style={{
                left: Math.min(marquee.x0, marquee.x1),
                top: Math.min(marquee.y0, marquee.y1),
                width: Math.abs(marquee.x1 - marquee.x0),
                height: Math.abs(marquee.y1 - marquee.y0),
              }}
              aria-hidden
            />
          )}

          {/* Drop-target highlight while a vertical lane switch is past the
              threshold (emerald = Video lane, violet = Overlay lane). */}
          {dropTarget && (
            <div
              className="pointer-events-none absolute z-[6] rounded-md border border-dashed"
              style={{
                left: GUTTER_W,
                width: axisW,
                top: dropTarget.top,
                height: dropTarget.height,
                borderColor: dropTarget.borderColor,
                backgroundColor: dropTarget.backgroundColor,
              }}
            />
          )}

          {/* Playhead — ONE continuous line spanning every lane, positioned
              in px on the content wrapper (scrolls with the media). The
              triangle grabber reuses the ruler's scrub handlers (v5.1). */}
          <Playhead
            leftCss={{
              left: layout
                ? GUTTER_W + layout.pxOf(currentMs)
                : axisLeftCss(playPct / 100),
            }}
            grab={isV5 ? scrubHandlers : undefined}
          />

          {/* Hover ghost — hidden while scrubbing, dragging or marqueeing. */}
          {hoverMs != null && !scrubbing && dragPreview == null && marquee == null && (
            <HoverGhost
              leftCss={{
                left: layout
                  ? GUTTER_W + layout.pxOf(hoverMs)
                  : axisLeftCss(hoverRatio ?? 0),
              }}
              top={2}
              label={fmtTimecode(hoverMs)}
            />
          )}

          {/* Floating drag tooltip (reuse of the hover timecode chip style):
              position for moves, position + duration for trims. */}
          {dragPreview != null && totalMs > 0 && (
            <div
              className="pointer-events-none absolute top-0 z-20 -translate-x-1/2"
              style={{
                left: layout
                  ? GUTTER_W +
                    layout.pxOf(
                      Math.max(
                        totalMs * 0.02,
                        Math.min(totalMs * 0.98, dragPreview.startMs),
                      ),
                    )
                  : axisLeftCss(
                      Math.max(0.02, Math.min(0.98, dragPreview.startMs / totalMs)),
                    ),
              }}
            >
              <div
                className="whitespace-nowrap rounded px-1.5 py-0.5 text-[9px] font-semibold tabular-nums backdrop-blur-sm"
                style={{
                  backgroundColor: "rgba(0, 0, 0, 0.78)",
                  color: "#e4e4e7",
                  border: "1px solid rgba(228, 228, 231, 0.18)",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.5)",
                }}
              >
                {dragPreview.kind === "clip" && dragPreview.gesture !== "move"
                  ? `${fmtTimecode(dragPreview.startMs)} · ${(dragPreview.durationMs / 1000).toFixed(1)}s`
                  : dragPreview.kind === "sfx" && dragPreview.gesture !== "move"
                    ? `${(dragPreview.durMs / 1000).toFixed(2)}s`
                    : fmtTimecode(dragPreview.startMs)}
              </div>
            </div>
          )}
          </div>
          </div>
        </div>
      ) : (
        /* ---------------------------------------------------------------
           v4.9 LEGACY TRACK — rendered when no v5 prop is passed.
           Markup identical to v4.9 (extracted shared components).
           --------------------------------------------------------------- */
        <div
          ref={trackRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={() => setHoverRatio(null)}
          className={cn(
            "relative w-full cursor-pointer touch-none select-none rounded-lg border",
            hasWave ? "h-[92px]" : "h-16",
          )}
          style={{
            borderColor: "#27272a",
            backgroundColor: "rgba(9, 9, 11, 0.6)",
            transition: "height 200ms ease",
          }}
        >
          {/* Ticks */}
          <TickRow ticks={ticks} totalMs={totalMs} />

          {/* Waveform strip (v4.7) — sits between the ruler numbers and the
              segment bars; bright cyan bars mark playback progress. */}
          {hasWave && waveform && (
            <WaveformStrip
              data={waveform}
              totalMs={totalMs}
              currentMs={currentMs}
            />
          )}

          {/* Segment bars — gradient tracks, active glows, beats pulse */}
          <div
            className={cn(
              "absolute bottom-1 left-0 right-0",
              hasWave ? "top-[46px]" : "top-5",
            )}
            style={{ transition: "top 200ms ease" }}
          >
            {baseSegs.map((seg, idx) => (
              <FilmstripBar
                key={seg.id}
                seg={seg}
                idx={idx}
                totalMs={totalMs}
                isActive={seg.id === activeId}
                onActivate={jumpToSeg(seg)}
              />
            ))}
            <TransitionZones
              segs={baseSegs}
              transition={transition}
              totalMs={totalMs}
              currentMs={currentMs}
              txActive={txActive}
              txOverridesActive={txOverridesActive}
            />
          </div>

          {/* Headline marker chips (v4.3) — on the track's top edge. */}
          <HeadlineChips
            headlines={headlines}
            totalMs={totalMs}
            currentMs={currentMs}
            onSeek={onSeek}
          />

          <BeatRail beats={beats} totalMs={totalMs} beatNearest={beatNearest} />

          <Playhead leftCss={{ left: `${playPct}%` }} />

          {/* v4.8: hover ghost (see v5 branch). */}
          {hoverMs != null && !scrubbing && (
            <HoverGhost
              leftCss={{ left: `${hoverPct}%` }}
              top={hasWave ? 48 : 26}
              label={fmtTimecode(hoverMs)}
            />
          )}
        </div>
      )}

      {/* v5.4.1: right-click context menu — fixed-position card + a
          transparent backdrop that closes on outside press. Rendered at the
          ROOT level (position:fixed escapes every scroll container). */}
      {ctxMenu != null && (
        <>
          <div
            className="fixed inset-0 z-[90]"
            onPointerDown={ctxClose}
            onContextMenu={(e) => {
              e.preventDefault();
              ctxClose();
            }}
            aria-hidden
          />
          <div
            ref={ctxListRef}
            role="menu"
            tabIndex={-1}
            aria-label="Clip actions"
            className="ff-ctx-menu"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
            onKeyDown={(e) => {
              // Swallow everything at the menu level so page shortcuts
              // (Esc = clear selection, S = split, Del…) never co-fire.
              e.stopPropagation();
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                ctxMove(e.key === "ArrowDown" ? 1 : -1);
              } else if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                ctxActivate();
              } else if (e.key === "Escape") {
                e.preventDefault();
                ctxClose();
              } else if (e.key === "Home") {
                e.preventDefault();
                if (ctxEnabled.length) setCtxIdx(ctxEnabled[0].i);
              } else if (e.key === "End") {
                e.preventDefault();
                if (ctxEnabled.length)
                  setCtxIdx(ctxEnabled[ctxEnabled.length - 1].i);
              }
            }}
          >
            {ctxItems.map((item, i) =>
              item.sep ? (
                <div key={i} className="ff-ctx-sep" role="separator" />
              ) : (
                <button
                  key={i}
                  type="button"
                  role="menuitem"
                  disabled={
                    item.disabled ||
                    (item.onClick == null && item.action == null)
                  }
                  onMouseEnter={() => setCtxIdx(i)}
                  onClick={() => {
                    if (item.disabled) return;
                    if (item.action === "fit") {
                      fitTimeline();
                      setCtxMenu(null);
                      return;
                    }
                    if (item.onClick) {
                      item.onClick();
                      setCtxMenu(null);
                    }
                  }}
                  className={cn(
                    "ff-ctx-item",
                    i === ctxIdx && !item.disabled && "ff-ctx-item-active",
                    item.danger && "ff-ctx-item-danger",
                  )}
                >
                  {item.icon && <item.icon className="size-3.5 shrink-0" aria-hidden />}
                  <span className="min-w-0 flex-1 truncate text-left">
                    {item.label}
                  </span>
                  {item.kbd && <span className="ff-ctx-kbd">{item.kbd}</span>}
                </button>
              ),
            )}
          </div>
        </>
      )}
    </div>
  );
}
