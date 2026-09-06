"use client";

import { Film, Download, X, Cpu, Clock, ImageIcon, Timer } from "lucide-react";
import type { TimelineMode, ExportProgress } from "@/lib/merger/types";
import { fmtBytes, fmtTimecode } from "@/lib/merger/timeline";
import { cn } from "@/lib/utils";

export interface LastExport {
  path: string;
  size: number;
  method: string;
  at: number;
}

interface HeaderProps {
  mode: TimelineMode | null;
  imageCount: number;
  isExporting: boolean;
  exportProgress: ExportProgress | null;
  lastExport: LastExport | null;
  inElectron: boolean;
  onExport: () => void;
  onCancel: () => void;
}

function timeAgo(at: number): string {
  const s = Math.floor((Date.now() - at) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

/** Parse an ffmpeg timemark "HH:MM:SS.xx" into milliseconds. */
function parseTimemark(tm: string): number {
  const parts = tm.split(":").map(Number);
  let h = 0,
    m = 0,
    s = 0;
  if (parts.length === 3) [h, m, s] = parts;
  else if (parts.length === 2) [m, s] = parts;
  else if (parts.length === 1) [s] = parts;
  return ((h * 60 + m) * 60 + s) * 1000;
}

export function Header({
  mode,
  imageCount,
  isExporting,
  exportProgress,
  lastExport,
  inElectron,
  onExport,
  onCancel,
}: HeaderProps) {
  const pct = exportProgress?.progress ?? 0;

  return (
    <header className="no-select flex h-16 shrink-0 items-center gap-4 border-b border-zinc-800 bg-[#0d0d0d] px-5">
      {/* Brand */}
      <div className="flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-lg bg-gradient-to-br from-violet-600 to-fuchsia-600 shadow-lg shadow-violet-900/30">
          <Film className="size-5 text-white" />
        </div>
        <div className="leading-tight">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold tracking-tight text-zinc-100">
              FrameFuse
            </span>
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-bold text-violet-300">
              v4
            </span>
          </div>
          <div className="text-[11px] text-zinc-500">Image Merger · Native FFmpeg</div>
        </div>
      </div>

      {/* Mode badge */}
      <div className="ml-2 flex items-center gap-2">
        {mode ? (
          <span
            className={cn(
              "rounded-md border px-2.5 py-1 text-[11px] font-semibold tracking-wide",
              mode === "absolute"
                ? "border-cyan-700/50 bg-cyan-950/40 text-cyan-300"
                : "border-violet-700/50 bg-violet-950/40 text-violet-300",
            )}
          >
            {mode === "absolute" ? "ABSOLUTE" : "SEQUENTIAL"}
          </span>
        ) : (
          <span className="rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[11px] font-semibold text-zinc-500">
            NO TIMELINE
          </span>
        )}
        <span className="flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-400">
          <ImageIcon className="size-3" />
          {imageCount}
        </span>
      </div>

      <div className="flex-1" />

      {/* Export progress (when exporting) */}
      {isExporting && (
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-[11px] text-zinc-400">
            <Timer className="size-3.5 animate-pulse text-violet-400" />
            <span className="font-mono tabular-nums text-zinc-200">
              {pct.toFixed(0)}%
            </span>
            {exportProgress?.fps ? (
              <span className="text-zinc-500">
                {exportProgress.fps.toFixed(0)} fps
              </span>
            ) : null}
            {exportProgress?.timemark ? (
              <span className="text-zinc-500">@ {fmtTimecode(parseTimemark(exportProgress.timemark))}</span>
            ) : null}
            {exportProgress?.eta ? (
              <span className="text-zinc-500">ETA {exportProgress.eta}s</span>
            ) : null}
          </div>
          <div className="h-1.5 w-40 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-[width] duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="flex items-center gap-1.5 rounded-md border border-red-900/60 bg-red-950/50 px-3 py-1.5 text-[12px] font-medium text-red-300 transition-colors hover:bg-red-900/40"
          >
            <X className="size-3.5" /> Cancel
          </button>
        </div>
      )}

      {/* Last export summary */}
      {!isExporting && lastExport && (
        <div className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1 text-[11px] text-zinc-400">
          <Clock className="size-3 text-zinc-500" />
          <span className="font-medium text-zinc-300">{fmtBytes(lastExport.size)}</span>
          <span className="text-zinc-600">·</span>
          <span>{lastExport.method}</span>
          <span className="text-zinc-600">·</span>
          <span>{timeAgo(lastExport.at)}</span>
        </div>
      )}

      {/* Export button */}
      {!isExporting && (
        <button
          type="button"
          onClick={onExport}
          disabled={imageCount === 0}
          className={cn(
            "flex items-center gap-2 rounded-md px-4 py-2 text-[13px] font-semibold text-white shadow-lg transition-all",
            imageCount === 0
              ? "cursor-not-allowed bg-zinc-800 text-zinc-600 shadow-none"
              : "bg-violet-600 shadow-violet-900/30 hover:bg-violet-500 hover:shadow-violet-700/40",
          )}
        >
          <Download className="size-4" />
          Export MP4
        </button>
      )}

      {/* Method badge */}
      <span
        className={cn(
          "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium",
          inElectron
            ? "border-cyan-800/60 bg-cyan-950/30 text-cyan-300"
            : "border-amber-800/50 bg-amber-950/30 text-amber-300",
        )}
        title={
          inElectron
            ? "Native FFmpeg encoding via fluent-ffmpeg + ffmpeg-static"
            : "Browser preview mode — WebCodecs/MediaRecorder fallback"
        }
      >
        <Cpu className="size-3" />
        {inElectron ? "Native FFmpeg" : "Browser Preview"}
      </span>
    </header>
  );
}
