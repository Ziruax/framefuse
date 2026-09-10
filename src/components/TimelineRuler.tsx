"use client";

import {
  useRef,
  useCallback,
  useEffect,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Type, AudioLines } from "lucide-react";
import type {
  HeadlineItem,
  MediaSegment,
  TimelineMode,
  TransitionSettings,
} from "@/lib/merger/types";
import { boundaryStyle } from "@/lib/merger/types";
import { fmtTimecode } from "@/lib/merger/timeline";
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
}

// v4.7: desaturated bar gradients (VLM feedback — the neon green fatigued;
// bright color is now reserved for playhead + active segment).
const BAR_BG: Record<string, { top: string; bottom: string }> = {
  absolute: {
    top: "rgba(34, 211, 238, 0.62)",
    bottom: "rgba(8, 145, 178, 0.55)",
  },
  beat: {
    top: "rgba(16, 185, 129, 0.58)",
    bottom: "rgba(6, 95, 70, 0.52)",
  },
  duration: {
    top: "rgba(139, 92, 246, 0.58)",
    bottom: "rgba(91, 33, 182, 0.52)",
  },
};

function niceStep(totalMs: number): number {
  const totalSec = totalMs / 1000;
  const targets = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const t of targets) {
    if (totalSec / t <= 12) return t * 1000;
  }
  return 600 * 1000;
}

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
 */
function WaveformStrip({
  data,
  totalMs,
  currentMs,
}: {
  data: WaveformData;
  totalMs: number;
  currentMs: number;
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
          octx.fillStyle = "#67e8f9";
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
      ctx.globalAlpha = 0.42;
      ctx.drawImage(off, 0, 0, cssW, cssH);
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(103, 232, 249, 0.55)";

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
      className="pointer-events-none absolute left-1.5 right-1.5 top-[16px] h-[26px]"
      title="Audio waveform — bright bars show playback progress"
    >
      <canvas ref={canvasRef} className="block size-full" />
    </div>
  );
}

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
}: TimelineRulerProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

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
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    onSeek(xToMs(e.clientX));
  };
  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    onSeek(xToMs(e.clientX));
  };
  const handlePointerUp = () => {
    dragging.current = false;
  };

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

  return (
    <div
      className="border-t px-4 py-3"
      style={{
        borderColor: "#27272a",
        backgroundColor: "#111113",
        height: hasWave ? "140px" : "120px",
        transition: "height 200ms ease",
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
        </div>
      </div>

      {segments.length === 0 ? (
        <div
          className="flex h-14 items-center justify-center rounded-lg border border-dashed text-[11px]"
          style={{ borderColor: "#27272a", color: "#52525b" }}
        >
          Timeline appears once images are added
        </div>
      ) : (
        <div
          ref={trackRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
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
                    className="h-2 w-px"
                    style={{ backgroundColor: "#3f3f46" }}
                  />
                  <span
                    className="mt-0.5 block -translate-x-1/2 text-[8px] tabular-nums"
                    style={{ color: "#71717a" }}
                  >
                    {fmtTimecode(t)}
                  </span>
                </div>
              );
            })}
          </div>

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
            {segments.map((seg, idx) => {
              const left = totalMs > 0 ? (seg.startMs / totalMs) * 100 : 0;
              const width =
                totalMs > 0 ? (seg.durationMs / totalMs) * 100 : 0;
              const isActive = seg.id === activeId;
              const colors = BAR_BG[seg.kind] || BAR_BG.duration;
              return (
                <div
                  key={seg.id}
                  className={cn(
                    "absolute top-0 flex items-center justify-center overflow-hidden rounded-[3px] text-[8px] font-semibold tabular-nums transition-all duration-150",
                    seg.kind === "beat" && !isActive && "ff-beat-pulse",
                    isActive && "scale-[1.02]",
                  )}
                  style={{
                    left: `${left}%`,
                    width: `${Math.max(0.5, width)}%`,
                    height: "70%",
                    backgroundImage: `linear-gradient(180deg, ${colors.top} 0%, ${colors.bottom} 100%)`,
                    boxShadow: isActive
                      ? "0 0 0 1.5px rgba(255,255,255,0.75), 0 0 14px rgba(255,255,255,0.3)"
                      : "inset 0 -1px 0 rgba(0,0,0,0.3)",
                    color: "rgba(24, 24, 27, 0.95)",
                  }}
                  title={`${seg.fileName} · ${fmtTimecode(seg.startMs)}–${fmtTimecode(seg.endMs)}`}
                >
                  {width > 6 ? idx + 1 : ""}
                </div>
              );
            })}

            {/* Transition zones (v4.3) — the head window of every segment
                after the first, drawn as a diagonal-hatch gradient strip.
                v4.5: per-boundary overrides tint AMBER + show the boundary's
                own style; only boundaries with an effective style ≠ none
                are drawn. */}
            {txActive || txOverridesActive
              ? segments.map((seg, idx) => {
                  if (idx === 0) return null;
                  const effStyle = boundaryStyle(transition, seg.id);
                  if (effStyle === "none") return null;
                  const pinned =
                    !!transition.overrides &&
                    Object.prototype.hasOwnProperty.call(
                      transition.overrides,
                      seg.id,
                    );
                  const durMs = Math.min(
                    transition.durationMs,
                    Math.floor(seg.durationMs * 0.45),
                  );
                  if (durMs <= 0 || seg.durationMs <= 200) return null;
                  const left =
                    totalMs > 0 ? (seg.startMs / totalMs) * 100 : 0;
                  const width = totalMs > 0 ? (durMs / totalMs) * 100 : 0;
                  const inPlay =
                    currentMs >= seg.startMs &&
                    currentMs < seg.startMs + durMs;
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
                })
              : null}
          </div>

          {/* Headline marker chips (v4.3) — amber bars on the top edge,
              click to jump to the headline. */}
          {headlines.map((h) => {
            if (totalMs <= 0) return null;
            const left = (h.startMs / totalMs) * 100;
            const width = Math.max(
              0.8,
              ((h.endMs - h.startMs) / totalMs) * 100,
            );
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

          {/* Beat rail (v4.6) — cyan ticks at the bottom edge; the beat
              under the playhead pulses brighter (play-along feel). */}
          {beats && beats.length > 0 && totalMs > 0 && (
            <div className="pointer-events-none absolute bottom-[3px] left-0 right-0 h-[5px]">
              {beats.map((b, i) => {
                if (b > totalMs) return null;
                const left = (b / totalMs) * 100;
                const live =
                  beatNearest != null && Math.abs(b - beatNearest) < 1;
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
                      backgroundColor: live
                        ? "#67e8f9"
                        : "rgba(34, 211, 238, 0.55)",
                      boxShadow: live
                        ? "0 0 6px rgba(103, 232, 249, 0.9)"
                        : "none",
                    }}
                  />
                );
              })}
            </div>
          )}

          {/* Playhead (violet line + glowing dot + grab cap) — v4.7: dark
              drop shadow keeps it readable over bars and waveform. */}
          <div
            className="pointer-events-none absolute top-0 z-10 h-full"
            style={{ left: `${playPct}%` }}
          >
            {/* v4.6: grab cap — a brighter pill above the dot that reads as
                a draggable handle. */}
            <div
              className="absolute -left-2 -top-[4px] h-[5px] w-4 rounded-full"
              style={{
                backgroundImage:
                  "linear-gradient(90deg, #8b5cf6, #d946ef, #8b5cf6)",
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
        </div>
      )}
    </div>
  );
}
