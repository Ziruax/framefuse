"use client";

import { useRef, useCallback, type PointerEvent as ReactPointerEvent } from "react";
import type { MediaSegment, TimelineMode } from "@/lib/merger/types";
import { fmtTimecode } from "@/lib/merger/timeline";

interface TimelineRulerProps {
  segments: MediaSegment[];
  totalMs: number;
  currentMs: number;
  mode: TimelineMode | null;
  activeId: string | null;
  onSeek: (ms: number) => void;
}

const BAR_BG: Record<string, string> = {
  absolute: "rgba(6, 182, 212, 0.7)",
  beat: "rgba(16, 185, 129, 0.7)",
  duration: "rgba(139, 92, 246, 0.7)",
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

          {/* Segment bars */}
          <div className="absolute bottom-1 left-0 right-0 top-5">
            {segments.map((seg, idx) => {
              const left = totalMs > 0 ? (seg.startMs / totalMs) * 100 : 0;
              const width =
                totalMs > 0 ? (seg.durationMs / totalMs) * 100 : 0;
              const isActive = seg.id === activeId;
              const bg = BAR_BG[seg.kind] || BAR_BG.duration;
              return (
                <div
                  key={seg.id}
                  className="absolute top-0 flex items-center justify-center overflow-hidden rounded-sm border text-[8px] font-medium transition-all"
                  style={{
                    left: `${left}%`,
                    width: `${Math.max(0.5, width)}%`,
                    height: "70%",
                    backgroundColor: bg,
                    borderColor: isActive ? "#ffffff" : "transparent",
                    boxShadow: isActive
                      ? "0 0 0 1px rgba(255,255,255,0.6)"
                      : "none",
                    color: "rgba(0, 0, 0, 0.8)",
                  }}
                  title={`${seg.fileName} · ${fmtTimecode(seg.startMs)}–${fmtTimecode(seg.endMs)}`}
                >
                  {width > 6 ? idx + 1 : ""}
                </div>
              );
            })}
          </div>

          {/* Playhead (vertical white line) */}
          <div
            className="pointer-events-none absolute top-0 z-10 h-full"
            style={{ left: `${playPct}%` }}
          >
            <div
              className="absolute -left-1.5 top-0 size-3 rounded-full border-2 shadow"
              style={{
                borderColor: "#a78bfa",
                backgroundColor: "#8b5cf6",
              }}
            />
            <div
              className="absolute left-0 top-0 h-full w-px"
              style={{ backgroundColor: "#ffffff" }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
