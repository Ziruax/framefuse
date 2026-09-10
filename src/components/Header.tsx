"use client";

import { Film, Download, X, Cpu, Clock, ImageIcon, Timer, Undo2, Redo2, Gauge } from "lucide-react";
import type { TimelineMode, ExportProgress, VideoSettings } from "@/lib/merger/types";
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
  /** Undo/Redo (v4.3). */
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** v4.5: export summary (settings + timeline length) for the estimate chip. */
  settings?: VideoSettings;
  totalMs?: number;
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
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  settings,
  totalMs = 0,
}: HeaderProps) {
  const pct = exportProgress?.progress ?? 0;
  // v4.5 export estimate: bitrate × duration / 8 → MB cap (CRF encodes
  // usually come out smaller; NVENC maxrate caps near this).
  const estMb = settings ? (settings.bitrateMbps * (totalMs / 1000)) / 8 : 0;
  const estLabel =
    estMb >= 1024 ? `${(estMb / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(estMb))} MB`;
  const qualityLabel =
    settings?.quality && settings.quality !== "custom"
      ? settings.quality.charAt(0).toUpperCase() + settings.quality.slice(1)
      : "Custom";

  return (
    <header
      className="no-select flex h-14 shrink-0 items-center gap-4 border-b px-5"
      style={{
        borderColor: "#27272a",
        background:
          "linear-gradient(180deg, #121215 0%, #0d0d0d 100%)",
        boxShadow: "0 1px 0 rgba(255,255,255,0.03) inset, 0 8px 24px rgba(0,0,0,0.35)",
      }}
    >
      {/* Brand */}
      <div className="flex items-center gap-3">
        <div
          className="flex size-9 items-center justify-center rounded-lg shadow-lg transition-transform duration-200 hover:scale-105"
          style={{
            backgroundImage: "linear-gradient(135deg, #8b5cf6 0%, #7c3aed 40%, #c026d3 100%)",
            boxShadow: "0 4px 14px rgba(124, 58, 237, 0.4)",
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
              className="whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-bold"
              style={{
                background: "linear-gradient(135deg, rgba(124, 58, 237, 0.35), rgba(192, 38, 211, 0.3))",
                border: "1px solid rgba(139, 92, 246, 0.35)",
                color: "#ddd6fe",
              }}
            >
              v4.9
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
                    borderColor: "rgba(14, 116, 144, 0.55)",
                    backgroundColor: "rgba(8, 51, 68, 0.35)",
                    color: "#67e8f9",
                  }
                : {
                    borderColor: "rgba(109, 40, 217, 0.55)",
                    backgroundColor: "rgba(76, 29, 149, 0.3)",
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

      {/* Undo / Redo (v4.3) */}
      <div className="flex items-center gap-1 rounded-lg border p-0.5" style={{ borderColor: "#27272a", backgroundColor: "#131316" }}>
        <button
          type="button"
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
          aria-label="Undo"
          className={cn(
            "rounded-md p-1.5 transition-all active:scale-90",
            canUndo
              ? "text-zinc-300 hover:bg-white/10 hover:text-white"
              : "cursor-not-allowed text-zinc-600",
          )}
        >
          <Undo2 className="size-4" />
        </button>
        <div className="h-4 w-px" style={{ backgroundColor: "#27272a" }} />
        <button
          type="button"
          onClick={onRedo}
          disabled={!canRedo}
          title="Redo (Ctrl+Shift+Z)"
          aria-label="Redo"
          className={cn(
            "rounded-md p-1.5 transition-all active:scale-90",
            canRedo
              ? "text-zinc-300 hover:bg-white/10 hover:text-white"
              : "cursor-not-allowed text-zinc-600",
          )}
        >
          <Redo2 className="size-4" />
        </button>
      </div>

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
          className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md border px-2.5 py-1 text-[11px]"
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

      {/* v4.5: live export estimate — what the Export button will produce. */}
      {!isExporting && imageCount > 0 && totalMs > 0 && settings && (
        <div
          className="hidden shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1 text-[10px] font-medium tabular-nums md:flex"
          style={{
            borderColor: "rgba(52, 211, 153, 0.25)",
            backgroundColor: "rgba(6, 78, 59, 0.14)",
            color: "#6ee7b7",
          }}
          title={`${qualityLabel} profile · ${settings.resolution} · ${settings.fps}fps · CRF ${settings.crf ?? 20} — the size is a bitrate cap; CRF encodes usually land smaller`}
        >
          <Gauge className="size-3" />
          {settings.resolution} · {settings.fps}fps · {(totalMs / 1000).toFixed(0)}s
          <span style={{ color: "#34d399" }}>≲{estLabel}</span>
        </div>
      )}

      {/* Export button */}
      {!isExporting && (
        <button
          type="button"
          onClick={onExport}
          disabled={imageCount === 0}
          className={cn(
            "ff-btn-primary flex items-center gap-2 rounded-md px-4 py-2 text-[13px] font-semibold transition-all",
            "active:scale-[0.97] active:brightness-90",
            imageCount === 0 && "cursor-not-allowed opacity-50 grayscale",
          )}
        >
          <Download className="size-4" />
          Export MP4
        </button>
      )}

      {/* Method badge (v4.9: icon-only — the text duplicated the subtitle
          and contributed to header "badge soup"; the tooltip carries the
          full explanation). */}
      <span
        className="flex size-8 items-center justify-center rounded-md border"
        style={
          inElectron
            ? {
                borderColor: "rgba(14, 116, 144, 0.6)",
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
            ? "Native FFmpeg encoding (GPU-accelerated when available) — export matches the preview"
            : "Browser preview mode — WebCodecs/MediaRecorder fallback"
        }
        aria-label={inElectron ? "Native FFmpeg export" : "Browser export"}
      >
        <Cpu className="size-4" />
      </span>
    </header>
  );
}
