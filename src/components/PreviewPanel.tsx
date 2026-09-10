"use client";

import { useEffect, useRef } from "react";
import { Play, Pause, SkipBack, SkipForward, ImageOff, Type, ArrowLeftRight, BadgeCheck } from "lucide-react";
import type {
  AspectRatio,
  CaptionSettings,
  HeadlineItem,
  KenBurnsConfig,
  MediaSegment,
  SubtitleFile,
  TransitionSettings,
  WatermarkSettings,
} from "@/lib/merger/types";
import {
  computeTransitionFx,
  computeGlobalFade,
  applyGlobalFade,
  drawFrameWithTransition,
  drawWatermark,
  previewDimensions,
} from "@/lib/merger/renderer";
import { drawCaption, drawHeadline } from "@/lib/merger/native";
import { cueAt } from "@/lib/merger/subtitles";
import { fmtTimecode } from "@/lib/merger/timeline";

interface PreviewPanelProps {
  segments: MediaSegment[];
  images: Record<string, HTMLImageElement>;
  totalMs: number;
  currentMs: number;
  isPlaying: boolean;
  kenBurns: KenBurnsConfig;
  aspect: AspectRatio;
  activeSegment: MediaSegment | null;
  subtitles: SubtitleFile | null;
  captionSettings: CaptionSettings;
  /** Headline overlay items (v4.2). */
  headlineItems: HeadlineItem[];
  /** Segment transitions (v4.3). */
  transition: TransitionSettings;
  /** Watermark image element + settings (v4.4). */
  watermarkImage: HTMLImageElement | null;
  watermarkSettings: WatermarkSettings | null;
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
  subtitles,
  captionSettings,
  headlineItems,
  transition,
  watermarkImage,
  watermarkSettings,
  onSeek,
  onTogglePlay,
  onStep,
}: PreviewPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scratchRef = useRef<HTMLCanvasElement | null>(null);
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
      // v4.3: transition head composite (dissolve/slide/wipe/dip) with
      // EXACT export parity, then captions, then the global fades.
      if (!scratchRef.current) scratchRef.current = document.createElement("canvas");
      if (scratchRef.current.width !== dims.w || scratchRef.current.height !== dims.h) {
        scratchRef.current.width = dims.w;
        scratchRef.current.height = dims.h;
      }
      const segIdx = segments.findIndex((s) => s.id === seg.id);
      drawFrameWithTransition(
        ctx, scratchRef.current, seg, Math.max(0, segIdx), segments,
        img, images, currentMs, dims.w, dims.h, kenBurns, transition,
      );
    } else {
      ctx.fillStyle = "#0a0a0a";
      ctx.fillRect(0, 0, dims.w, dims.h);
    }

    // Watermark overlay (v4.4) — UNDER headlines + captions, exactly like
    // the export z-order (overlay filter before subtitles).
    if (watermarkImage && watermarkSettings) {
      drawWatermark(ctx, watermarkImage, dims.w, dims.h, watermarkSettings);
    }

    // Headline overlay (v4.2) — under captions so center captions sit on top.
    if (headlineItems && headlineItems.length > 0) {
      drawHeadline(ctx, headlineItems, currentMs, dims.w, dims.h);
    }

    // Overlay caption if enabled + active cue exists.
    if (
      captionSettings?.enabled &&
      subtitles &&
      subtitles.cues.length > 0
    ) {
      const cue = cueAt(subtitles.cues, currentMs);
      if (cue) {
        // Pass per-word timestamps + current time + cue window +
        // animation so the word-mode presets and kinetic typography
        // animations render identically to the export.
        const capCtx = {
          ...captionSettings,
          words: cue.words,
          currentMs,
          cueStartMs: cue.startMs,
          cueEndMs: cue.endMs,
        };
        drawCaption(ctx, cue.text, capCtx, dims.w, dims.h);
      }
    }

    // v4.3: global fades AFTER captions — mirrors fade-after-subtitles
    // in the FFmpeg export (start/end fades + dip tails).
    if (seg && scratchRef.current) {
      const segIdx = Math.max(0, segments.findIndex((s) => s.id === seg.id));
      applyGlobalFade(
        ctx,
        scratchRef.current,
        computeGlobalFade(segments, segIdx, currentMs, transition),
      );
    }
  }, [
    currentMs,
    activeSegment,
    images,
    kenBurns,
    dims.w,
    dims.h,
    subtitles,
    captionSettings,
    headlineItems,
    segments,
    transition,
    watermarkImage,
    watermarkSettings,
  ]);

  const pct = totalMs > 0 ? (currentMs / totalMs) * 100 : 0;

  // v4.3: is the playhead inside a transition window right now?
  const activeTxFx = (() => {
    if (!activeSegment || transition.style === "none") return null;
    const idx = segments.findIndex((s) => s.id === activeSegment.id);
    if (idx <= 0) return null;
    const fx = computeTransitionFx(segments, idx, currentMs, transition);
    return fx.kind === "none" ? null : fx;
  })();
  const txLabel =
    activeTxFx && activeTxFx.kind !== "none"
      ? transition.style === "dissolve"
        ? "dissolve"
        : transition.style === "dip-black"
          ? "dip"
          : transition.style === "dip-white"
            ? "flash"
            : transition.style.replace("-", " ")
      : null;

  return (
    <div
      className="flex h-full flex-col overflow-hidden"
      style={{ backgroundColor: "#0c0c0e" }}
    >
      {/* Canvas stage */}
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4"
        style={{
          background:
            "radial-gradient(ellipse at 50% 20%, rgba(124, 58, 237, 0.07) 0%, rgba(12, 12, 14, 0) 65%)",
        }}
      >
        {segments.length === 0 ? (
          <div
            className="ff-grid-bg flex h-full w-full flex-col items-center justify-center rounded-xl border text-center transition-colors"
            style={{ borderColor: "#27272a" }}
          >
            <ImageOff className="mb-3 size-8" style={{ color: "#3f3f46" }} />
            <p className="text-[13px] font-medium" style={{ color: "#a1a1aa" }}>
              No images yet
            </p>
            <p className="mt-1 text-[11px]" style={{ color: "#52525b" }}>
              Add images from the left panel to begin
            </p>
          </div>
        ) : (
          <div
            className="relative rounded-lg border shadow-2xl transition-shadow duration-300"
            style={{
              borderColor: "#27272a",
              backgroundColor: "#000000",
              boxShadow:
                "0 25px 50px -12px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(124, 58, 237, 0.08)",
              aspectRatio: `${dims.w} / ${dims.h}`,
              maxWidth: "100%",
              maxHeight: "100%",
              width: dims.w,
            }}
          >
            <canvas
              ref={canvasRef}
              width={dims.w}
              height={dims.h}
              className="block size-full rounded-lg"
            />
            {/* Segment label overlay */}
            {activeSegment && (
              <div
                className="pointer-events-none absolute left-2 top-2 rounded-md px-2 py-1 backdrop-blur-sm"
                style={{
                  backgroundColor: "rgba(0, 0, 0, 0.6)",
                  border: "1px solid rgba(255, 255, 255, 0.06)",
                }}
              >
                <div
                  className="max-w-[280px] truncate text-[11px] font-medium"
                  style={{ color: "#e4e4e7" }}
                >
                  {activeSegment.fileName}
                </div>
                <div className="text-[9px]" style={{ color: "#a1a1aa" }}>
                  {fmtTimecode(activeSegment.startMs)} –{" "}
                  {fmtTimecode(activeSegment.endMs)}
                </div>
              </div>
            )}
            {/* Direction badge */}
            {activeSegment && kenBurns.enabled && (
              <div
                className="pointer-events-none absolute right-2 top-2 rounded px-1.5 py-0.5 text-[9px] capitalize backdrop-blur-sm"
                style={{
                  backgroundColor: "rgba(0, 0, 0, 0.6)",
                  color: "#c4b5fd",
                  border: "1px solid rgba(196, 181, 253, 0.15)",
                }}
              >
                ⟶ {activeSegment.direction}
              </div>
            )}
            {/* Active transition indicator (v4.3) */}
            {txLabel && (
              <div
                className="pointer-events-none absolute bottom-2 right-2 flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium capitalize backdrop-blur-sm ff-tx-live"
                style={{
                  backgroundColor: "rgba(0, 0, 0, 0.55)",
                  color: "#f0abfc",
                  border: "1px solid rgba(240, 171, 252, 0.25)",
                }}
                title={`Transition playing — ${(activeTxFx?.p ?? 0).toFixed(2)} progress`}
              >
                <ArrowLeftRight className="size-3" />
                {txLabel}
              </div>
            )}
            {/* Watermark indicator (v4.4) */}
            {watermarkImage && watermarkSettings && (
              <div
                className="pointer-events-none absolute left-2 top-12 flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] backdrop-blur-sm"
                style={{
                  backgroundColor: "rgba(0, 0, 0, 0.55)",
                  color: "#86efac",
                  border: "1px solid rgba(134, 239, 172, 0.22)",
                }}
                title={`Watermark active — ${watermarkSettings.position}, ${watermarkSettings.sizePercent}% width, ${watermarkSettings.opacity}% opacity`}
              >
                <BadgeCheck className="size-3" />
                watermark
              </div>
            )}
            {/* Headline indicator (v4.2) */}
            {headlineItems.length > 0 && (
              <div
                className="pointer-events-none absolute bottom-2 left-2 flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] backdrop-blur-sm"
                style={{
                  backgroundColor: "rgba(0, 0, 0, 0.55)",
                  color: "#fbbf24",
                  border: "1px solid rgba(251, 191, 36, 0.2)",
                }}
                title={`${headlineItems.length} headline overlay item${
                  headlineItems.length === 1 ? "" : "s"
                } on the timeline`}
              >
                <Type className="size-3" />
                {headlineItems.length} headline
                {headlineItems.length === 1 ? "" : "s"}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Transport */}
      <div
        className="border-t px-4 py-3"
        style={{
          borderColor: "#27272a",
          backgroundColor: "#111113",
          boxShadow: "0 -8px 24px rgba(0, 0, 0, 0.35)",
        }}
      >
        <div className="mb-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => onStep(-1)}
            disabled={segments.length === 0}
            className="rounded-md p-1.5 transition-all hover:bg-white/10 hover:text-zinc-200 disabled:opacity-30"
            style={{ color: "#a1a1aa" }}
            title="Previous segment (Shift+←)"
          >
            <SkipBack className="size-4" />
          </button>
          <button
            type="button"
            onClick={onTogglePlay}
            disabled={segments.length === 0}
            className="flex size-10 items-center justify-center rounded-full text-white shadow-lg transition-all duration-150 hover:scale-105 active:scale-95 disabled:opacity-30 disabled:hover:scale-100"
            style={{
              background: "linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%)",
              boxShadow: "0 4px 16px rgba(124, 58, 237, 0.45)",
            }}
            title={isPlaying ? "Pause (Space)" : "Play (Space)"}
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
            className="rounded-md p-1.5 transition-all hover:bg-white/10 hover:text-zinc-200 disabled:opacity-30"
            style={{ color: "#a1a1aa" }}
            title="Next segment (Shift+→)"
          >
            <SkipForward className="size-4" />
          </button>

          <div className="ml-2 flex-1" />

          <div className="rounded-md border border-transparent bg-black/30 px-2 py-0.5 font-mono text-[12px] tabular-nums">
            <span style={{ color: "#e4e4e7" }}>
              {fmtTimecode(currentMs)}
            </span>
            <span style={{ color: "#52525b" }}>
              {" "}
              / {fmtTimecode(totalMs)}
            </span>
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
              background: `linear-gradient(to right, #8b5cf6 ${pct}%, #d946ef ${Math.min(
                100,
                pct + 8,
              )}%, #3f3f46 ${Math.min(100, pct + 8)}%)`,
            }}
            aria-label="Timeline scrubber"
          />
        </div>
      </div>
    </div>
  );
}
