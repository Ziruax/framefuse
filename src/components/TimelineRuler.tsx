"use client";

import { useRef, useCallback, type PointerEvent as ReactPointerEvent } from "react";
import { Type } from "lucide-react";
import type {
  HeadlineItem,
  MediaSegment,
  TimelineMode,
  TransitionSettings,
} from "@/lib/merger/types";
import { boundaryStyle } from "@/lib/merger/types";
import { fmtTimecode } from "@/lib/merger/timeline";
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
  onSeek: (ms: number) => void;
}

const BAR_BG: Record<string, { top: string; bottom: string; base: string }> = {
  absolute: {
    top: "rgba(34, 211, 238, 0.85)",
    bottom: "rgba(8, 145, 178, 0.75)",
    base: "rgba(6, 182, 212, 0.7)",
  },
  beat: {
    top: "rgba(52, 211, 153, 0.85)",
    bottom: "rgba(5, 150, 105, 0.75)",
    base: "rgba(16, 185, 129, 0.7)",
  },
  duration: {
    top: "rgba(167, 139, 250, 0.85)",
    bottom: "rgba(109, 40, 217, 0.75)",
    base: "rgba(139, 92, 246, 0.7)",
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

export function TimelineRuler({
  segments,
  totalMs,
  currentMs,
  mode,
  activeId,
  headlines,
  transition,
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

  return (
    <div
      className="border-t px-4 py-3"
      style={{
        borderColor: "#27272a",
        backgroundColor: "#111113",
        height: "120px",
      }}
    >
      {/* Header row */}
      <div className="mb-2 flex items-center justify-between">
        <div
          className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider"
          style={{ color: "#71717a" }}
        >
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
        <div
          className="flex items-center gap-3 text-[9px]"
          style={{ color: "#52525b" }}
        >
          <span className="flex items-center gap-1">
            <span
              className="size-2 rounded-sm"
              style={{ backgroundColor: "#06b6d4" }}
            />{" "}
            absolute
          </span>
          <span className="flex items-center gap-1">
            <span
              className="size-2 rounded-sm"
              style={{ backgroundColor: "#10b981" }}
            />{" "}
            beat
          </span>
          <span className="flex items-center gap-1">
            <span
              className="size-2 rounded-sm"
              style={{ backgroundColor: "#8b5cf6" }}
            />{" "}
            duration
          </span>
          {txActive && (
            <span className="flex items-center gap-1">
              <span
                className="size-2 rounded-sm"
                style={{
                  backgroundImage:
                    "linear-gradient(135deg, #8b5cf6, #d946ef)",
                }}
              />{" "}
              transition
            </span>
          )}
          {headlines.length > 0 && (
            <span className="flex items-center gap-1">
              <span
                className="size-2 rounded-sm"
                style={{ backgroundColor: "#fbbf24" }}
              />{" "}
              title
            </span>
          )}
        </div>
      </div>

      {segments.length === 0 ? (
        <div
          className="flex h-14 items-center justify-center rounded-lg border border-dashed text-[11px]"
          style={{
            borderColor: "#27272a",
            color: "#52525b",
          }}
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
          className="relative h-16 w-full cursor-pointer touch-none select-none rounded-lg border"
          style={{
            borderColor: "#27272a",
            backgroundColor: "rgba(9, 9, 11, 0.6)",
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
                  <div className="h-2 w-px" style={{ backgroundColor: "#3f3f46" }} />
                  <span
                    className="mt-0.5 block -translate-x-1/2 text-[8px] tabular-nums"
                    style={{ color: "#52525b" }}
                  >
                    {fmtTimecode(t)}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Segment bars — gradient tracks, active glows, beats pulse */}
          <div className="absolute bottom-1 left-0 right-0 top-5">
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
                      ? "0 0 0 1.5px rgba(255,255,255,0.75), 0 0 14px rgba(255,255,255,0.25)"
                      : "inset 0 -1px 0 rgba(0,0,0,0.25)",
                    color: "rgba(9, 9, 11, 0.92)",
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
            {txActive || txOverridesActive ?
              segments.map((seg, idx) => {
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
              }) : null}
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
                title={`Title: “${h.text}” · ${fmtTimecode(h.startMs)}–${fmtTimecode(h.endMs)} (click to jump)`}
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

          {/* Playhead (violet line + glowing dot) */}
          <div
            className="pointer-events-none absolute top-0 z-10 h-full"
            style={{ left: `${playPct}%` }}
          >
            <div
              className="absolute -left-1.5 top-0 size-3 rounded-full border-2"
              style={{
                borderColor: "#ffffff",
                backgroundColor: "#8b5cf6",
                boxShadow: "0 0 10px rgba(139, 92, 246, 0.8)",
              }}
            />
            <div
              className="absolute left-0 top-0 h-full w-px"
              style={{
                backgroundColor: "#c4b5fd",
                boxShadow: "0 0 6px rgba(139, 92, 246, 0.6)",
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
