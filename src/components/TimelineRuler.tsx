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
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  Type,
  AudioLines,
  Clapperboard,
  Layers,
  Zap,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  HeadlineItem,
  ItemEdit,
  MediaSegment,
  SfxItem,
  TimelineMode,
  TransitionSettings,
} from "@/lib/merger/types";
import { boundaryStyle } from "@/lib/merger/types";
import { fmtTimecode } from "@/lib/merger/timeline";
import { getSfxDef } from "@/lib/merger/sfx";
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
  /** v5: remove an SFX item. */
  onRemoveSfx?: (id: string) => void;
  /** v5: video source durations (id → ms) for trim clamping. */
  videoDurations?: Record<string, number>;
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
/** Alternating lane banding (overlay + sfx rows; video/audio stay dark). */
const LANE_BAND_BG = "rgba(24, 24, 27, 0.16)";

function niceStep(totalMs: number): number {
  const totalSec = totalMs / 1000;
  const targets = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const t of targets) {
    if (totalSec / t <= 12) return t * 1000;
  }
  return 600 * 1000;
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
    }
  | {
      kind: "sfx";
      id: string;
      pointerId: number;
      startX: number;
      msPerPx: number;
      didDrag: boolean;
      origStart: number;
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
  | { kind: "sfx"; id: string; startMs: number };

/** Max trimmable duration for a clip (video: source window, else 300 s). */
function maxDurFor(d: Extract<DragInfo, { kind: "clip" }>): number {
  if (d.mediaType === "video" && d.sourceDur != null && d.sourceDur > 0) {
    return Math.min(MAX_DUR_MS, Math.max(MIN_DUR_MS, d.sourceDur - d.origTrim));
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
 *            video trimInMs slides with them (same source window, later part).
 *            Constraints: start >= 0, duration in [200, maxDur], trimIn >= 0.
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
      startMs = Math.max(0, Math.min(hi, snapMs(d.origStart + dx * d.msPerPx)));
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
    // delta = newStart - origStart. Constraints:
    //   start >= 0            => delta >= -origStart
    //   duration <= maxDur    => delta >= origDur - maxDur
    //   duration >= 200       => delta <= origDur - 200
    //   video trimIn >= 0     => delta >= -origTrim
    const deltaMin = Math.max(
      -d.origStart,
      d.origDur - maxDur,
      d.mediaType === "video" ? -d.origTrim : -Infinity,
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
      trimInMs: d.origTrim + delta,
      targetTrack: undefined,
      horizAllowed: false,
    };
  }
  // trim-r
  const nd = snapMs(d.origDur + dx * d.msPerPx);
  return {
    startMs: d.origStart,
    durationMs: Math.min(maxDur, Math.max(MIN_DUR_MS, nd)),
    trimInMs: d.origTrim,
    targetTrack: undefined,
    horizAllowed: false,
  };
}

/** SFX pill move math: start = orig + dx, snapped, clamped [0, totalMs]. */
function computeSfxDrag(
  d: Extract<DragInfo, { kind: "sfx" }>,
  clientX: number,
  totalMs: number,
): number {
  const hi = Math.max(0, totalMs);
  return Math.max(
    0,
    Math.min(hi, snapMs(d.origStart + (clientX - d.startX) * d.msPerPx)),
  );
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
  className = "pointer-events-none absolute left-1.5 right-1.5 top-[16px] h-[26px]",
}: {
  data: WaveformData;
  totalMs: number;
  currentMs: number;
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
      // Clear first — drawImage composites, so without this the dim blit
      // would accumulate alpha over previous frames and bars could never
      // dim back down after a seek.
      ctx.clearRect(0, 0, cssW, cssH);

      // Audio occupies this fraction of track width (audio may be shorter
      // or longer than the timeline; clamped, tail truncated).
      const frac = totalMs > 0 ? Math.min(1, data.durationMs / totalMs) : 1;
      const waveW = Math.max(8, cssW * frac);
      const mid = cssH / 2;
      const maxBar = cssH / 2 - 1;

      // Static pass → offscreen cache (peaks don't change with the playhead).
      // Key includes the decode id — two tracks with identical bucket count
      // and duration must never share a stale bitmap.
      const key = `${data.id}:${waveW.toFixed(1)}:${cssH}:${dpr}`;
      let off = cacheRef.current.key === key ? cacheRef.current.off : null;
      if (!off) {
        off = document.createElement("canvas");
        off.width = canvas.width;
        off.height = canvas.height;
        const octx = off.getContext("2d");
        if (octx) {
          octx.setTransform(dpr, 0, 0, dpr, 0, 0);
          // Full-brightness bars — the blit below applies the dim alpha.
          // v4.8: desaturated sky (VLM: bright cyan strobed).
          octx.fillStyle = "#7dd3fc";
          const n = data.peaks.length;
          const barW = waveW / n;
          for (let i = 0; i < n; i++) {
            const h = Math.max(1, data.peaks[i] * maxBar);
            const x = i * barW;
            octx.fillRect(x, mid - h, Math.max(0.8, barW - 0.5), h * 2);
          }
        }
        cacheRef.current = { key, off };
      }

      // Blit the dim pass with a unipolar alpha tint.
      // v4.8: 0.30 (was 0.42) + desaturated slate-cyan — VLM flagged the
      // wave as louder than the clip segments; the audio data should recede
      // while the bright pass keeps progress contrast.
      ctx.globalAlpha = 0.3;
      ctx.drawImage(off, 0, 0, cssW, cssH);
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(125, 211, 252, 0.48)";

      // Bright pass: bars up to the playhead. Progress is AUDIO-relative
      // (wave maps 0..durationMs → 0..waveW); when the video outlives the
      // audio the whole wave ends up bright, when audio outlives the
      // timeline the tail stays dim.
      const audioProg =
        data.durationMs > 0
          ? Math.max(0, Math.min(1, currentMs / data.durationMs))
          : 0;
      const n = data.peaks.length;
      const barW = waveW / n;
      const cutoffIdx = Math.floor(audioProg * n);
      for (let i = 0; i < cutoffIdx; i++) {
        const h = Math.max(1, data.peaks[i] * maxBar);
        const x = i * barW;
        ctx.fillRect(x, mid - h, Math.max(0.8, barW - 0.5), h * 2);
      }

      // Hairline baseline.
      ctx.globalAlpha = 0.25;
      ctx.fillRect(0, mid - 0.5, waveW, 1);
      ctx.globalAlpha = 1;
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [data, totalMs, currentMs]);

  return (
    <div
      className={className}
      title="Audio waveform — bright bars show playback progress"
    >
      <canvas ref={canvasRef} className="block size-full" />
    </div>
  );
}

/** Ruler ticks + timecode labels (v4.9 markup, shared by both layouts). */
function TickRow({ ticks, totalMs }: { ticks: number[]; totalMs: number }) {
  return (
    <div className="absolute inset-0">
      {ticks.map((t) => {
        const left = totalMs > 0 ? (t / totalMs) * 100 : 0;
        return (
          <div
            key={t}
            className="absolute top-0 h-full"
            style={{ left: `${left}%` }}
          >
            <div
              className="h-1.5 w-px"
              style={{ backgroundColor: "#3f3f46" }}
            />
            <span
              className="mt-0.5 block -translate-x-1/2 text-[8px] font-semibold tabular-nums"
              style={{ color: "#7f7f87" }}
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
 * Playhead (violet line + glowing dot + grab cap) — v4.7: dark drop shadow
 * keeps it readable over bars and waveform. v5: `leftCss` positions it via
 * calc() so ONE continuous line spans all lanes.
 */
function Playhead({ leftCss }: { leftCss: CSSProperties }) {
  return (
    <div
      className="pointer-events-none absolute top-0 z-10 h-full"
      style={leftCss}
    >
      {/* v4.6: grab cap — a brighter pill above the dot that reads as
                a draggable handle. v4.8: it now pokes ABOVE the track edge
                (VLM: needs a clear anchor for precise scrubbing). */}
      <div
        className="absolute -left-2.5 -top-[7px] h-[6px] w-5 rounded-full"
        style={{
          backgroundImage: "linear-gradient(90deg, #8b5cf6, #d946ef, #8b5cf6)",
          boxShadow: "0 0 8px rgba(217, 70, 239, 0.75)",
        }}
      />
      <div
        className="absolute -left-1.5 top-0 size-3 rounded-full border-2"
        style={{
          borderColor: "#ffffff",
          backgroundColor: "#8b5cf6",
          boxShadow:
            "0 0 10px rgba(139, 92, 246, 0.8), 0 1px 3px rgba(0,0,0,0.6)",
        }}
      />
      <div
        className="absolute left-0 top-0 h-full w-px"
        style={{
          backgroundColor: "#c4b5fd",
          boxShadow:
            "0 0 6px rgba(139, 92, 246, 0.6), 1px 0 3px rgba(0,0,0,0.65), -1px 0 3px rgba(0,0,0,0.65)",
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
 *  lane, click to jump to the headline. Markup verbatim from v4.9. */
function HeadlineChips({
  headlines,
  totalMs,
  currentMs,
  onSeek,
}: {
  headlines: HeadlineItem[];
  totalMs: number;
  currentMs: number;
  onSeek: (ms: number) => void;
}) {
  return (
    <>
      {headlines.map((h) => {
        if (totalMs <= 0) return null;
        const left = (h.startMs / totalMs) * 100;
        const width = Math.max(0.8, ((h.endMs - h.startMs) / totalMs) * 100);
        const inPlay = currentMs >= h.startMs && currentMs < h.endMs;
        return (
          <button
            key={h.id}
            type="button"
            onPointerDown={(e) => {
              e.stopPropagation();
              onSeek(h.startMs + 100);
            }}
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
 *  beat under the playhead pulses brighter (play-along feel). Verbatim. */
function BeatRail({
  beats,
  totalMs,
  beatNearest,
}: {
  beats: number[] | null;
  totalMs: number;
  beatNearest: number | null;
}) {
  if (!beats || beats.length === 0 || totalMs <= 0) return null;
  return (
    <div className="pointer-events-none absolute bottom-[3px] left-0 right-0 h-[5px]">
      {beats.map((b, i) => {
        if (b > totalMs) return null;
        const left = (b / totalMs) * 100;
        const live = beatNearest != null && Math.abs(b - beatNearest) < 1;
        return (
          <div
            key={`beat-${i}`}
            className={cn(
              "absolute bottom-0 w-px rounded-full transition-all duration-150",
              live && "ff-beat-tick-live",
            )}
            style={{
              left: `${left}%`,
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
}: {
  segs: MediaSegment[];
  transition: TransitionSettings;
  totalMs: number;
  currentMs: number;
  txActive: boolean;
  txOverridesActive: boolean;
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
        const left = totalMs > 0 ? (seg.startMs / totalMs) * 100 : 0;
        const width = totalMs > 0 ? (durMs / totalMs) * 100 : 0;
        const inPlay =
          currentMs >= seg.startMs && currentMs < seg.startMs + durMs;
        return (
          <div
            key={`tx-${seg.id}`}
            className={cn(
              "absolute bottom-0 rounded-[2px] transition-all duration-200",
              inPlay && "ff-tx-zone-live",
            )}
            style={{
              left: `${left}%`,
              width: `${Math.max(0.4, width)}%`,
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
  onActivate,
  drag,
  previewStartMs,
  previewDurationMs,
  dragging,
}: {
  seg: MediaSegment;
  idx: number;
  totalMs: number;
  isActive: boolean;
  /** Double-click (and Enter/Space when draggable) — jump to first frame. */
  onActivate: (e: { stopPropagation: () => void }) => void;
  /** v5: pointer drag handlers (press-seek + move/lane-switch gestures). */
  drag?: FilmstripBarDrag;
  /** v5: live drag preview overrides (local state; commit on release). */
  previewStartMs?: number;
  previewDurationMs?: number;
  dragging?: boolean;
}) {
  const startMs = previewStartMs ?? seg.startMs;
  const durMs = previewDurationMs ?? seg.durationMs;
  const left = totalMs > 0 ? (startMs / totalMs) * 100 : 0;
  const width = totalMs > 0 ? (durMs / totalMs) * 100 : 0;
  const colors = BAR_BG[seg.kind] || BAR_BG.duration;
  return (
    <div
      {...(drag ?? {})}
      onDoubleClick={onActivate}
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
        "absolute top-0 overflow-hidden rounded-[4px] text-[8px] font-semibold tabular-nums hover:outline hover:outline-1 hover:outline-white/35",
        drag
          ? "cursor-grab touch-none select-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-300/70"
          : "cursor-pointer",
        // Kill the hover transition while dragging so the bar tracks the
        // pointer 1:1 (the v4.9 transition would rubber-band left/width).
        dragging ? "transition-none" : "transition-all duration-150",
        seg.kind === "beat" && !isActive && "ff-beat-pulse",
        isActive && "scale-[1.02] z-[1]",
        dragging && "z-[2] cursor-grabbing",
      )}
      style={{
        left: `${left}%`,
        width: `${Math.max(0.5, width)}%`,
        height: "100%",
        // v4.9 FILMSTRIP: the segment's own thumbnail shows through a
        // kind-tint gradient (double background — the tint paints on top
        // of the image).
        backgroundImage: `linear-gradient(180deg, ${colors.top} 0%, ${colors.bottom} 100%), url(${seg.thumbnailUrl})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        // Inactive strips recede (dim + desaturate) so the active clip pops
        // without extra chrome. v4.9 VLM pass: 0.82/0.78 — 0.72 made dark
        // footage vanish into the track background.
        filter: isActive
          ? "saturate(1.15) brightness(1.08)"
          : "saturate(0.78) brightness(0.82)",
        boxShadow: isActive
          ? "0 0 0 1.5px rgba(255,255,255,0.9), 0 0 14px rgba(167,139,250,0.45), 0 2px 8px rgba(0,0,0,0.55)"
          : "inset 0 -1px 0 rgba(0,0,0,0.35), 0 1px 3px rgba(0,0,0,0.4)",
      }}
      title={`${seg.fileName} · ${fmtTimecode(seg.startMs)}–${fmtTimecode(seg.endMs)} · ${(seg.durationMs / 1000).toFixed(1)}s · motion ${seg.direction}\ndouble-click jumps to this clip's first frame`}
    >
      {/* Index chip — scrimmed so it reads over any footage. */}
      {width > 3 ? (
        <span
          className="absolute left-0 top-0 flex h-[13px] min-w-[13px] items-center justify-center rounded-br-[4px] px-1 text-[8px] font-bold"
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
      {width > 14 ? (
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

/** Left gutter cell: lucide icon + tiny caps label, vertically centered. */
function LaneLabel({
  icon: Icon,
  text,
  accent,
}: {
  icon: LucideIcon;
  text: string;
  accent: string;
}) {
  return (
    <div
      className="flex h-full w-16 shrink-0 select-none items-center justify-center gap-1 border-r"
      style={{ borderColor: GUTTER_BORDER }}
    >
      <Icon className="size-3 shrink-0" style={{ color: accent }} aria-hidden />
      <span className="truncate text-[7px] font-bold uppercase tracking-widest text-zinc-500">
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
  onRemoveSfx,
  videoDurations,
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

  // v5 mode: ANY new prop present => render the 4-lane editor; otherwise the
  // exact v4.9 single-track layout (page.tsx keeps working unchanged).
  const isV5 =
    onEditItem != null ||
    sfxItems != null ||
    onMoveSfx != null ||
    onRemoveSfx != null ||
    videoDurations != null;
  const sfxList = sfxItems ?? [];

  const xToMs = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el || totalMs <= 0) return 0;
      const rect = el.getBoundingClientRect();
      const ratio = Math.max(
        0,
        Math.min(1, (clientX - rect.left) / rect.width),
      );
      return Math.round(ratio * totalMs);
    },
    [totalMs],
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

  /** px->ms scale measured at gesture start from the ticks axis cell. */
  const msPerPxNow = useCallback(() => {
    const el = trackRef.current;
    const w = el ? el.getBoundingClientRect().width : 0;
    return w > 0 && totalMs > 0 ? totalMs / w : 0;
  }, [totalMs]);

  const clipPreviewFor = (id: string) =>
    dragPreview && dragPreview.kind === "clip" && dragPreview.id === id
      ? dragPreview
      : null;
  const sfxPreviewFor = (id: string) =>
    dragPreview && dragPreview.kind === "sfx" && dragPreview.id === id
      ? dragPreview
      : null;

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
  ) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (e.altKey && onRemoveSfx) return;
    onSeek(Math.max(0, item.startMs));
    if (!onMoveSfx) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // best-effort
    }
    dragRef.current = {
      kind: "sfx",
      id: item.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      msPerPx: msPerPxNow(),
      didDrag: false,
      origStart: Math.max(0, item.startMs),
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

  const handleClipPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.kind !== "clip" || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDragPreview(null);
    // No drag = plain click; the press already sought (v4.9 parity).
    if (!d.didDrag || !onEditItem) return;
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
    setDragPreview({
      kind: "sfx",
      id: d.id,
      startMs: computeSfxDrag(d, e.clientX, totalMs),
    });
  };

  const handleSfxPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.kind !== "sfx" || d.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDragPreview(null);
    if (d.didDrag) onMoveSfx?.(d.id, computeSfxDrag(d, e.clientX, totalMs));
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
  const step = niceStep(totalMs);
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

  const scrubHandlers = {
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
    onPointerCancel: handlePointerUp,
  };

  const empty = segments.length === 0 && (!isV5 || sfxList.length === 0);

  const jumpToSeg =
    (seg: MediaSegment) => (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      onSeek(seg.startMs + 5);
      onJumpToSegment?.(seg.id);
    };

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
      {/* Header row */}
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

      {empty ? (
        <div
          className="flex h-14 items-center justify-center rounded-lg border border-dashed text-[11px]"
          style={{ borderColor: "#27272a", color: "#52525b" }}
        >
          Timeline appears once images are added
        </div>
      ) : isV5 ? (
        /* ---------------------------------------------------------------
           v5.0 — 4-LANE EDITOR. Rows: [64px label gutter | time axis].
           The playhead / hover ghost / drag tooltip are absolutely
           positioned on the WRAPPER (calc() left), so each is one
           continuous element spanning every lane.
           --------------------------------------------------------------- */
        <div
          className="relative flex w-full touch-none select-none flex-col rounded-lg border"
          style={{
            borderColor: "#27272a",
            backgroundColor: "rgba(9, 9, 11, 0.6)",
          }}
          onPointerLeave={() => setHoverRatio(null)}
        >
          {/* Ruler */}
          <div
            className="flex shrink-0 border-b"
            style={{ height: TICKS_H, borderColor: ROW_BORDER }}
          >
            <div
              className="w-16 shrink-0 border-r"
              style={{ borderColor: GUTTER_BORDER }}
            />
            <div
              ref={trackRef}
              className="relative min-w-0 flex-1"
              {...scrubHandlers}
            >
              <TickRow ticks={ticks} totalMs={totalMs} />
            </div>
          </div>

          {/* LANE 1 — VIDEO (base filmstrips; all v4.9 rendering) */}
          <div
            role="group"
            aria-label="Video lane"
            className="flex shrink-0 border-b"
            style={{ height: BASE_H, borderColor: ROW_BORDER }}
          >
            <LaneLabel icon={Clapperboard} text="Video" accent="#22d3ee" />
            <div
              className="relative min-w-0 flex-1 transition-colors hover:bg-white/[0.02]"
              {...scrubHandlers}
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
                          onActivate={jumpToSeg(seg)}
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
                          previewStartMs={preview?.startMs}
                          previewDurationMs={preview?.durationMs}
                          dragging={preview != null}
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
                    />
                  </div>
                  <BeatRail
                    beats={beats}
                    totalMs={totalMs}
                    beatNearest={beatNearest}
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
              backgroundColor: LANE_BAND_BG,
            }}
          >
            <LaneLabel icon={Layers} text="Overlay" accent="#a78bfa" />
            <div
              className="relative min-w-0 flex-1 transition-colors hover:bg-white/[0.02]"
              {...scrubHandlers}
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
                  const left = totalMs > 0 ? (startMs / totalMs) * 100 : 0;
                  const width = totalMs > 0 ? (durMs / totalMs) * 100 : 0;
                  const isVideo = seg.mediaType === "video";
                  const draggable = !!onEditItem;
                  return (
                    <div
                      key={seg.id}
                      role={draggable ? "button" : undefined}
                      tabIndex={draggable ? 0 : undefined}
                      aria-label={`${seg.fileName}, overlay clip, ${fmtTimecode(startMs)} to ${fmtTimecode(startMs + durMs)}`}
                      className={cn(
                        "absolute flex select-none items-center gap-1 overflow-hidden rounded-[5px] border pl-[2px] pr-2 text-[8px] font-semibold text-zinc-200",
                        draggable
                          ? "cursor-grab touch-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-300/70"
                          : "cursor-pointer",
                        pv != null && "z-[3] cursor-grabbing",
                      )}
                      style={{
                        left: `${left}%`,
                        width: `${Math.max(0.4, width)}%`,
                        minWidth: 16,
                        top: OV_PAD + row * (OV_ROW_H + OV_GAP),
                        height: OV_ROW_H,
                        // Video overlays tint amber, image overlays violet —
                        // kind at a glance over a dark surface, app palette.
                        backgroundColor: isVideo
                          ? "rgba(251, 191, 36, 0.15)"
                          : "rgba(139, 92, 246, 0.20)",
                        borderColor: isVideo
                          ? "rgba(251, 191, 36, 0.42)"
                          : "rgba(139, 92, 246, 0.55)",
                        boxShadow:
                          pv != null
                            ? "0 0 0 1.5px rgba(255,255,255,0.65), 0 4px 12px rgba(0,0,0,0.6)"
                            : "0 1px 3px rgba(0,0,0,0.45)",
                      }}
                      title={`${seg.fileName} · overlay T${seg.track} · ${fmtTimecode(startMs)}–${fmtTimecode(startMs + durMs)} · ${(durMs / 1000).toFixed(1)}s${draggable ? "\ndrag to move · edges trim · drag down to the Video lane" : ""}\ndouble-click jumps to this clip's first frame`}
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
                      {/* Trim handles: 4px hit zones, wider on hover. The
                          shared move/up handlers live on the clip root and
                          receive the captured edge events via bubbling. */}
                      {draggable && (
                        <>
                          <div
                            className="absolute inset-y-0 left-0 z-[2] w-[4px] cursor-ew-resize touch-none transition-[width] duration-100 hover:w-[8px]"
                            title="Drag to trim the start"
                            onPointerDown={(e) =>
                              beginClipDrag(e, seg, "trim-l")
                            }
                            onLostPointerCapture={handleDragAbort}
                          />
                          <div
                            className="absolute inset-y-0 right-0 z-[2] w-[4px] cursor-ew-resize touch-none transition-[width] duration-100 hover:w-[8px]"
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

          {/* LANE 3 — AUDIO (music waveform; visual + click-to-seek only) */}
          <div
            role="group"
            aria-label="Audio lane"
            className="flex shrink-0 border-b"
            style={{ height: AUDIO_H, borderColor: ROW_BORDER }}
          >
            <LaneLabel icon={AudioLines} text="Audio" accent="#67e8f9" />
            <div
              className="relative min-w-0 flex-1 transition-colors hover:bg-white/[0.02]"
              {...scrubHandlers}
            >
              {hasWave && waveform ? (
                <WaveformStrip
                  data={waveform}
                  totalMs={totalMs}
                  currentMs={currentMs}
                  className="pointer-events-none absolute inset-x-1 inset-y-0"
                />
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
            style={{ height: SFX_H, backgroundColor: LANE_BAND_BG }}
          >
            <LaneLabel icon={Zap} text="SFX" accent="#fbbf24" />
            <div
              className="relative min-w-0 flex-1 transition-colors hover:bg-white/[0.02]"
              {...scrubHandlers}
            >
              {sfxList.length === 0 ? (
                <EmptyHint>No sound effects — add from the Media tab</EmptyHint>
              ) : (
                sfxList.map((item) => {
                  const def = getSfxDef(item.sfxId);
                  const pv = sfxPreviewFor(item.id);
                  const startMs = Math.max(0, pv?.startMs ?? item.startMs);
                  const durMs = def?.defaultDurMs ?? 0;
                  const left =
                    totalMs > 0
                      ? Math.max(0, Math.min(100, (startMs / totalMs) * 100))
                      : 0;
                  const width = totalMs > 0 ? (durMs / totalMs) * 100 : 0;
                  return (
                    <div
                      key={item.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`${def?.label ?? "Sound effect"} effect at ${fmtTimecode(startMs)}`}
                      className={cn(
                        "group absolute select-none rounded-full border pl-1.5 pr-2 text-[8px] font-semibold",
                        onMoveSfx
                          ? "cursor-grab touch-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-300/70"
                          : "cursor-pointer",
                        pv != null && "z-[3] cursor-grabbing",
                      )}
                      style={{
                        left: `${left}%`,
                        // Duration-proportional width with a fixed floor.
                        width: `${Math.max(0.2, width)}%`,
                        minWidth: 28,
                        top: 4,
                        height: 22,
                        backgroundColor:
                          pv != null
                            ? "rgba(251, 191, 36, 0.30)"
                            : "rgba(251, 191, 36, 0.15)",
                        borderColor: "rgba(251, 191, 36, 0.45)",
                        color: "#fde68a",
                        boxShadow:
                          pv != null
                            ? "0 0 0 1.5px rgba(255,255,255,0.55), 0 3px 10px rgba(0,0,0,0.55)"
                            : "0 1px 2px rgba(0,0,0,0.45)",
                      }}
                      title={`${def?.label ?? item.sfxId} · ${fmtTimecode(startMs)} · click to seek${onMoveSfx ? ", drag to move" : ""}${onRemoveSfx ? ", Alt+click or x to remove" : ""}`}
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
                        className="shrink-0 text-[9px] leading-none"
                        aria-hidden
                      >
                        {def ? (
                          def.emoji
                        ) : (
                          <Zap className="size-2.5" aria-hidden />
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {def?.label ?? item.sfxId}
                      </span>
                      <span className="shrink-0 tabular-nums opacity-70">
                        {fmtTimecode(startMs)}
                      </span>
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

          {/* Drop-target highlight while a vertical lane switch is past the
              threshold (emerald = Video lane, violet = Overlay lane). */}
          {dropTarget && (
            <div
              className="pointer-events-none absolute z-[6] rounded-md border border-dashed"
              style={{
                left: GUTTER_W,
                right: 0,
                top: dropTarget.top,
                height: dropTarget.height,
                borderColor: dropTarget.borderColor,
                backgroundColor: dropTarget.backgroundColor,
              }}
            />
          )}

          {/* Playhead — ONE continuous line spanning every lane. */}
          <Playhead leftCss={{ left: axisLeftCss(playPct / 100) }} />

          {/* Hover ghost — hidden while scrubbing OR dragging. */}
          {hoverMs != null && !scrubbing && dragPreview == null && (
            <HoverGhost
              leftCss={{ left: axisLeftCss(hoverRatio ?? 0) }}
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
                left: axisLeftCss(
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
                  : fmtTimecode(dragPreview.startMs)}
              </div>
            </div>
          )}
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
    </div>
  );
}
