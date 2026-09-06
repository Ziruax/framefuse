"use client";

import { useEffect, useRef } from "react";
import { Play, Pause, SkipBack, SkipForward, ImageOff } from "lucide-react";
import type {
  AspectRatio,
  KenBurnsConfig,
  MediaSegment,
} from "@/lib/merger/types";
import { drawFrame, previewDimensions } from "@/lib/merger/renderer";
import { fmtTimecode } from "@/lib/merger/timeline";
import { cn } from "@/lib/utils";

interface PreviewPanelProps {
  segments: MediaSegment[];
  images: Record<string, HTMLImageElement>;
  totalMs: number;
  currentMs: number;
  isPlaying: boolean;
  kenBurns: KenBurnsConfig;
  aspect: AspectRatio;
  activeSegment: MediaSegment | null;
  onSeek: (ms: number) => void;
  onTogglePlay: () => void;
  onStep: (dir: -1 | 1) => void;
}

export function PreviewPanel({
  segments,
  images,
  totalMs,
  currentMs,
  isPlaying,
  kenBurns,
  aspect,
  activeSegment,
  onSeek,
  onTogglePlay,
  onStep,
}: PreviewPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dims = previewDimensions(aspect);

  // Redraw whenever the playhead or inputs change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    const seg = activeSegment;
    const img = seg ? images[seg.id] ?? null : null;
    if (seg) {
      drawFrame(ctx, img, seg, currentMs, dims.w, dims.h, kenBurns);
    } else {
      ctx.fillStyle = "#0a0a0a";
      ctx.fillRect(0, 0, dims.w, dims.h);
    }
  }, [currentMs, activeSegment, images, kenBurns, dims.w, dims.h]);

  const pct = totalMs > 0 ? (currentMs / totalMs) * 100 : 0;

  return (
    <div className="flex h-full flex-col bg-[#0c0c0e]">
      {/* Canvas stage */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
        {segments.length === 0 ? (
          <div className="ff-grid-bg flex h-full w-full flex-col items-center justify-center rounded-xl border border-zinc-800 text-center">
            <ImageOff className="mb-3 size-8 text-zinc-700" />
            <p className="text-[13px] font-medium text-zinc-400">No images yet</p>
            <p className="mt-1 text-[11px] text-zinc-600">
              Add images from the left panel to begin
            </p>
          </div>
        ) : (
          <div
            className="relative rounded-lg border border-zinc-800 bg-black shadow-2xl shadow-black/50"
            style={{ aspectRatio: `${dims.w} / ${dims.h}`, maxWidth: "100%", maxHeight: "100%", width: dims.w }}
          >
            <canvas
              ref={canvasRef}
              width={dims.w}
              height={dims.h}
              className="block size-full rounded-lg"
            />
            {/* Segment label overlay */}
            {activeSegment && (
              <div className="pointer-events-none absolute left-2 top-2 rounded-md bg-black/60 px-2 py-1 backdrop-blur-sm">
                <div className="max-w-[280px] truncate text-[11px] font-medium text-zinc-200">
                  {activeSegment.fileName}
                </div>
                <div className="text-[9px] text-zinc-400">
                  {fmtTimecode(activeSegment.startMs)} –{" "}
                  {fmtTimecode(activeSegment.endMs)}
                </div>
              </div>
            )}
            {/* Direction badge */}
            {activeSegment && kenBurns.enabled && (
              <div className="pointer-events-none absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[9px] capitalize text-violet-300 backdrop-blur-sm">
                ⟶ {activeSegment.direction}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Transport */}
      <div className="border-t border-zinc-800 bg-[#111113] px-4 py-3">
        <div className="mb-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => onStep(-1)}
            disabled={segments.length === 0}
            className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30"
            title="Previous segment"
          >
            <SkipBack className="size-4" />
          </button>
          <button
            type="button"
            onClick={onTogglePlay}
            disabled={segments.length === 0}
            className={cn(
              "flex size-10 items-center justify-center rounded-full text-white shadow-lg transition-all disabled:opacity-30",
              "bg-violet-600 shadow-violet-900/30 hover:bg-violet-500",
            )}
            title={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? (
              <Pause className="size-5" />
            ) : (
              <Play className="size-5 translate-x-0.5" />
            )}
          </button>
          <button
            type="button"
            onClick={() => onStep(1)}
            disabled={segments.length === 0}
            className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-30"
            title="Next segment"
          >
            <SkipForward className="size-4" />
          </button>

          <div className="ml-2 flex-1" />

          <div className="font-mono text-[12px] tabular-nums text-zinc-300">
            <span className="text-zinc-100">{fmtTimecode(currentMs)}</span>
            <span className="text-zinc-600"> / {fmtTimecode(totalMs)}</span>
          </div>
        </div>

        {/* Scrubber */}
        <div className="group relative flex items-center">
          <input
            type="range"
            min={0}
            max={Math.max(1, totalMs)}
            step={10}
            value={Math.min(currentMs, totalMs)}
            onChange={(e) => onSeek(Number(e.target.value))}
            disabled={segments.length === 0}
            className="w-full"
            style={{
              background: `linear-gradient(to right, oklch(0.541 0.281 293) ${pct}%, #3f3f46 ${pct}%)`,
            }}
          />
        </div>
      </div>
    </div>
  );
}
