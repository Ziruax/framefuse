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
    <header
      className="no-select flex h-14 shrink-0 items-center gap-4 border-b px-5"
      style={{ backgroundColor: "#0d0d0d", borderColor: "#27272a" }}
    >
      {/* Brand */}
      <div className="flex items-center gap-3">
        <div
          className="flex size-9 items-center justify-center rounded-lg shadow-lg"
          style={{
            backgroundImage: "linear-gradient(135deg, #7c3aed 0%, #c026d3 100%)",
            boxShadow: "0 4px 12px rgba(124, 58, 237, 0.3)",
          }}
        >
          <Film className="size-5" style={{ color: "#ffffff" }} />
        </div>
        <div className="leading-tight">
          <div className="flex items-center gap-2">
            <span
              className="text-[15px] font-semibold tracking-tight"
              style={{ color: "#e4e4e7" }}
            >
              FrameFuse
            </span>
            <span
              className="rounded px-1.5 py-0.5 text-[10px] font-bold"
              style={{ backgroundColor: "#27272a", color: "#c4b5fd" }}
            >
              v4
            </span>
          </div>
          <div className="text-[11px]" style={{ color: "#71717a" }}>
            Image Merger · Native FFmpeg
          </div>
        </div>
      </div>

      {/* Mode badge */}
      <div className="ml-2 flex items-center gap-2">
        {mode ? (
          <span
            className="rounded-md border px-2.5 py-1 text-[11px] font-semibold tracking-wide"
            style={
              mode === "absolute"
                ? {
                    borderColor: "#0e7490",
                    backgroundColor: "rgba(8, 51, 68, 0.5)",
                    color: "#67e8f9",
                  }
                : {
                    borderColor: "#6d28d9",
                    backgroundColor: "rgba(76, 29, 149, 0.5)",
                    color: "#c4b5fd",
                  }
            }
          >
            {mode === "absolute" ? "ABSOLUTE" : "SEQUENTIAL"}
          </span>
        ) : (
          <span
            className="rounded-md border px-2.5 py-1 text-[11px] font-semibold"
            style={{
              borderColor: "#27272a",
              backgroundColor: "#18181b",
              color: "#71717a",
            }}
          >
            NO TIMELINE
          </span>
        )}
        <span
          className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px]"
          style={{
            borderColor: "#27272a",
            backgroundColor: "#18181b",
            color: "#a1a1aa",
          }}
        >
          <ImageIcon className="size-3" />
          {imageCount}
        </span>
      </div>

      <div className="flex-1" />

      {/* Export progress (when exporting) */}
      {isExporting && (
        <div className="flex items-center gap-3">
          <div
            className="flex items-center gap-2 text-[11px]"
            style={{ color: "#a1a1aa" }}
          >
            <Timer
              className="size-3.5 animate-pulse"
              style={{ color: "#a78bfa" }}
            />
            <span
              className="font-mono tabular-nums"
              style={{ color: "#e4e4e7" }}
            >
              {pct.toFixed(0)}%
            </span>
            {exportProgress?.fps ? (
              <span style={{ color: "#71717a" }}>
                {exportProgress.fps.toFixed(0)} fps
              </span>
            ) : null}
            {exportProgress?.timemark ? (
              <span style={{ color: "#71717a" }}>
                @ {fmtTimecode(parseTimemark(exportProgress.timemark))}
              </span>
            ) : null}
            {exportProgress?.eta ? (
              <span style={{ color: "#71717a" }}>ETA {exportProgress.eta}s</span>
            ) : null}
          </div>
          <div
            className="h-1.5 w-40 overflow-hidden rounded-full"
            style={{ backgroundColor: "#27272a" }}
          >
            <div
              className="h-full rounded-full transition-[width] duration-200"
              style={{
                width: `${pct}%`,
                backgroundImage:
                  "linear-gradient(to right, #8b5cf6, #d946ef)",
              }}
            />
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors"
            style={{
              borderColor: "#7f1d1d",
              backgroundColor: "rgba(127, 29, 29, 0.4)",
              color: "#fca5a5",
            }}
          >
            <X className="size-3.5" /> Cancel
          </button>
        </div>
      )}

      {/* Last export summary */}
      {!isExporting && lastExport && (
        <div
          className="flex items-center gap-2 rounded-md border px-2.5 py-1 text-[11px]"
          style={{
            borderColor: "#27272a",
            backgroundColor: "rgba(24, 24, 27, 0.6)",
            color: "#a1a1aa",
          }}
        >
          <Clock className="size-3" style={{ color: "#71717a" }} />
          <span className="font-medium" style={{ color: "#d4d4d8" }}>
            {fmtBytes(lastExport.size)}
          </span>
          <span style={{ color: "#52525b" }}>·</span>
          <span>{lastExport.method}</span>
          <span style={{ color: "#52525b" }}>·</span>
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
            "flex items-center gap-2 rounded-md px-4 py-2 text-[13px] font-semibold shadow-lg transition-all",
            imageCount === 0 && "cursor-not-allowed",
          )}
          style={
            imageCount === 0
              ? {
                  backgroundColor: "#27272a",
                  color: "#52525b",
                  boxShadow: "none",
                }
              : {
                  backgroundColor: "#7c3aed",
                  color: "#ffffff",
                  boxShadow: "0 4px 12px rgba(124, 58, 237, 0.3)",
                }
          }
        >
          <Download className="size-4" />
          Export MP4
        </button>
      )}

      {/* Method badge */}
      <span
        className="flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-medium"
        style={
          inElectron
            ? {
                borderColor: "#0e7490",
                backgroundColor: "rgba(8, 51, 68, 0.3)",
                color: "#67e8f9",
              }
            : {
                borderColor: "#27272a",
                backgroundColor: "#18181b",
                color: "#71717a",
              }
        }
        title={
          inElectron
            ? "Native FFmpeg encoding via fluent-ffmpeg + ffmpeg-static"
            : "Browser preview mode — WebCodecs/MediaRecorder fallback"
        }
      >
        <Cpu className="size-3" />
        {inElectron ? "Native FFmpeg" : "Browser"}
      </span>
    </header>
  );
}
