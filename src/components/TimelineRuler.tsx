"use client";

import { useRef, useCallback, type PointerEvent as ReactPointerEvent } from "react";
import type { MediaSegment, TimelineMode } from "@/lib/merger/types";
import { fmtTimecode } from "@/lib/merger/timeline";
import { cn } from "@/lib/utils";

interface TimelineRulerProps {
  segments: MediaSegment[];
  totalMs: number;
  currentMs: number;
  mode: TimelineMode | null;
  activeId: string | null;
  onSeek: (ms: number) => void;
}

const BAR_COLORS: Record<string, string> = {
  absolute: "bg-cyan-500/70 hover:bg-cyan-400",
  beat: "bg-emerald-500/70 hover:bg-emerald-400",
  duration: "bg-violet-500/70 hover:bg-violet-400",
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
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
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
    <div className="border-t border-zinc-800 bg-[#111113] px-4 py-3">
      {/* Header row */}
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          Timeline
          {mode && (
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[9px] font-bold",
                mode === "absolute"
                  ? "bg-cyan-950/50 text-cyan-300"
                  : "bg-violet-950/50 text-violet-300",
              )}
            >
              {mode}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[9px] text-zinc-600">
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-sm bg-cyan-500" /> absolute
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-sm bg-emerald-500" /> beat
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2 rounded-sm bg-violet-500" /> duration
          </span>
        </div>
      </div>

      {segments.length === 0 ? (
        <div className="flex h-14 items-center justify-center rounded-lg border border-dashed border-zinc-800 text-[11px] text-zinc-600">
          Timeline appears once images are added
        </div>
      ) : (
        <div
          ref={trackRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className="relative h-16 w-full cursor-pointer touch-none select-none rounded-lg border border-zinc-800 bg-zinc-950/60"
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
                  <div className="h-2 w-px bg-zinc-700" />
                  <span className="mt-0.5 block -translate-x-1/2 text-[8px] tabular-nums text-zinc-600">
                    {fmtTimecode(t)}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Segment bars */}
          <div className="absolute bottom-1 left-0 right-0 top-5">
            {segments.map((seg) => {
              const left = totalMs > 0 ? (seg.startMs / totalMs) * 100 : 0;
              const width = totalMs > 0 ? (seg.durationMs / totalMs) * 100 : 0;
              const isActive = seg.id === activeId;
              return (
                <div
                  key={seg.id}
                  className={cn(
                    "absolute top-0 flex items-center justify-center overflow-hidden rounded-sm border text-[8px] font-medium text-black/80 transition-all",
                    BAR_COLORS[seg.kind] || BAR_COLORS.duration,
                    isActive
                      ? "border-white ring-1 ring-white/60"
                      : "border-transparent",
                  )}
                  style={{ left: `${left}%`, width: `${Math.max(0.5, width)}%`, height: "70%" }}
                  title={`${seg.fileName} · ${fmtTimecode(seg.startMs)}–${fmtTimecode(seg.endMs)}`}
                >
                  {width > 6 ? idxLabel(segments, seg) : ""}
                </div>
              );
            })}
          </div>

          {/* Playhead */}
          <div
            className="pointer-events-none absolute top-0 z-10 h-full"
            style={{ left: `${playPct}%` }}
          >
            <div className="absolute -left-1.5 top-0 size-3 rounded-full border-2 border-violet-400 bg-violet-500 shadow" />
            <div className="absolute left-0 top-0 h-full w-px bg-violet-400" />
          </div>
        </div>
      )}
    </div>
  );
}

function idxLabel(segments: MediaSegment[], seg: MediaSegment): string {
  return String(segments.findIndex((s) => s.id === seg.id) + 1);
}
