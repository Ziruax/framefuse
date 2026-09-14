"use client";

import {
  Film,
  Download,
  X,
  Cpu,
  Clock,
  FileJson,
  ImageIcon,
  Timer,
  Undo2,
  Redo2,
  Gauge,
  Keyboard,
} from "lucide-react";
import type { TimelineMode, ExportProgress, VideoSettings } from "@/lib/merger/types";
import { fmtBytes, fmtTimecode } from "@/lib/merger/timeline";
import { cn } from "@/lib/utils";

export interface LastExport {
  path: string;
  size: number;
  method: string;
  at: number;
  /** v1.1 TURBO telemetry (desktop FFmpeg path only). */
  encoder?: string;
  elapsedSec?: number;
  copiedClips?: number;
  encodedClips?: number;
  /** v1.4.1: copied clips that entered the fast path via a keyframe-aligned head trim. */
  keyframeCuts?: number;
  /** v1.4.2: chunked parallel encode + probe-gated hardware decode. */
  chunkedClips?: number;
  totalChunks?: number;
  hwDecodeClips?: number;
  /** v1.5: parallel single-pass windows (CPU-first chunked export). */
  parallelChunks?: number;
  mode?: "single-pass" | "parallel-pass" | "two-step";
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
  /** v1.2: opens the keyboard-shortcuts overlay. */
  onShowShortcuts: () => void;
  /** v4.5: export summary (settings + timeline length) for the estimate chip. */
  settings?: VideoSettings;
  totalMs?: number;
  /** v5.1: name of the project file on disk (native save/open); null while
   *  the session is unsaved / browser-only. Rendered as a chip next to the
   *  version badge. */
  projectName?: string | null;
}

function timeAgo(at: number): string {
  const s = Math.floor((Date.now() - at) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

/** v1.1 TURBO: compact elapsed-time label ("42s", "4m 12s", "1h 03m"). */
function fmtElapsed(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
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
  onShowShortcuts,
  settings,
  totalMs = 0,
  projectName,
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
      {/* Brand — v5.1 CapCut: compact 8px-rounded gradient mark. */}
      <div className="flex items-center gap-3">
        <div
          className="flex size-8 shrink-0 items-center justify-center rounded-[8px] transition-transform duration-200 hover:scale-105"
          style={{
            backgroundImage: "linear-gradient(135deg, #8b5cf6 0%, #7c3aed 40%, #c026d3 100%)",
            boxShadow: "0 4px 14px rgba(124, 58, 237, 0.4)",
          }}
        >
          <Film className="size-4" style={{ color: "#ffffff" }} />
        </div>
        <div className="leading-tight">
          <div className="flex items-center gap-2">
            <span
              className="text-[15px] font-semibold tracking-tight"
              style={{ color: "#e4e4e7" }}
            >
              FrameFuse
            </span>
            {/* v1.2: quiet mono version chip (was a violet gradient badge). */}
            <span
              className="whitespace-nowrap rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium"
              style={{
                borderColor: "#27272a",
                backgroundColor: "#18181b",
                color: "#a1a1aa",
              }}
              title="FrameFuse v1.6.0 — multi-track video studio · hybrid smart-render export: chunked parallel single-pass + stream-copy TURBO + iGPU (QSV/AMF/NVENC) when available"
            >
              v1.6.0
            </span>
            {/* v5.1: on-disk project file chip (native save/open sessions). */}
            {projectName && (
              <span
                className="flex max-w-[220px] items-center gap-1 truncate rounded border px-1.5 py-0.5 text-[10px] font-medium"
                style={{
                  borderColor: "#27272a",
                  backgroundColor: "#18181b",
                  color: "#a1a1aa",
                }}
                title={`Saved project — ${projectName}`}
              >
                <FileJson className="size-2.5 shrink-0 text-zinc-500" aria-hidden />
                <span className="truncate">{projectName}</span>
              </span>
            )}
          </div>
          <div className="text-[11px]" style={{ color: "#71717a" }}>
            Multi-Track Video Studio · Native FFmpeg
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

      {/* Undo / Redo (v4.3) — v5.1: 28px icon-only buttons. */}
      <div className="flex items-center gap-1 rounded-lg border p-0.5" style={{ borderColor: "#27272a", backgroundColor: "#131316" }}>
        <button
          type="button"
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
          aria-label="Undo"
          className={cn(
            "flex size-7 items-center justify-center rounded-md transition-all active:scale-90",
            canUndo
              ? "text-zinc-300 hover:bg-white/10 hover:text-white"
              : "cursor-not-allowed text-zinc-600 opacity-40",
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
            "flex size-7 items-center justify-center rounded-md transition-all active:scale-90",
            canRedo
              ? "text-zinc-300 hover:bg-white/10 hover:text-white"
              : "cursor-not-allowed text-zinc-600 opacity-40",
          )}
        >
          <Redo2 className="size-4" />
        </button>
        {/* v1.2: shortcuts overlay toggle */}
        <div className="h-4 w-px" style={{ backgroundColor: "#27272a" }} />
        <button
          type="button"
          onClick={onShowShortcuts}
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
          className="flex size-7 items-center justify-center rounded-md text-zinc-400 transition-all hover:bg-white/10 hover:text-white active:scale-90"
        >
          <Keyboard className="size-4" />
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
              <span style={{ color: "#71717a" }}>
                ETA {fmtElapsed(exportProgress.eta)}
              </span>
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
          title={
            lastExport.elapsedSec != null
              ? `Exported in ${fmtElapsed(lastExport.elapsedSec)}${
                  lastExport.encoder ? ` · ${lastExport.encoder}` : ""
                }${
                  lastExport.totalChunks && lastExport.totalChunks > 1
                    ? ` · ${lastExport.totalChunks} chunks encoded in parallel`
                    : ""
                }${
                  lastExport.hwDecodeClips
                    ? ` · ${lastExport.hwDecodeClips} source${lastExport.hwDecodeClips === 1 ? "" : "s"} on hardware decode`
                    : ""
                }${
                  lastExport.copiedClips
                    ? ` · ${lastExport.copiedClips} clip${lastExport.copiedClips === 1 ? "" : "s"} stream-copied (no re-encode)` +
                      (lastExport.keyframeCuts
                        ? ` · ${lastExport.keyframeCuts} keyframe-aligned cut${lastExport.keyframeCuts === 1 ? "" : "s"}`
                        : "")
                    : ""
                }`
              : undefined
          }
        >
          <Clock className="size-3" style={{ color: "#71717a" }} />
          <span className="font-medium" style={{ color: "#d4d4d8" }}>
            {fmtBytes(lastExport.size)}
          </span>
          <span style={{ color: "#52525b" }}>·</span>
          <span>{lastExport.method}</span>
          {lastExport.elapsedSec != null && (
            <>
              <span style={{ color: "#52525b" }}>·</span>
              <span
                className="flex items-center gap-1 tabular-nums"
                style={{ color: "#f59e0b" }}
                title="Wall-clock export time"
              >
                <Gauge className="size-3" />
                {fmtElapsed(lastExport.elapsedSec)}
              </span>
            </>
          )}
          {lastExport.totalChunks != null && lastExport.totalChunks > 1 && (
            <>
              <span style={{ color: "#52525b" }}>·</span>
              <span
                className="rounded px-1 py-px font-medium"
                style={{ backgroundColor: "rgba(139, 92, 246, 0.12)", color: "#a78bfa" }}
                title={
                  lastExport.mode === "parallel-pass"
                    ? `Parallel single-pass: the timeline was split into ${lastExport.totalChunks} frame-aligned windows, each rendered by its own ffmpeg process (CPU-first), plus one audio pass — concatenated losslessly`
                    : "Parallel chunks: long re-encode clips were split into frame-aligned chunks and encoded concurrently" +
                      (lastExport.hwDecodeClips
                        ? ` · ${lastExport.hwDecodeClips} source${lastExport.hwDecodeClips === 1 ? "" : "s"} decoded in hardware (probe-gated)`
                        : "")
                }
              >
                ⧉ {lastExport.totalChunks} parallel
              </span>
            </>
          )}
          {lastExport.copiedClips != null && lastExport.copiedClips > 0 && (
            <>
              <span style={{ color: "#52525b" }}>·</span>
              <span
                className="rounded px-1 py-px font-medium"
                style={{ backgroundColor: "rgba(16, 185, 129, 0.12)", color: "#34d399" }}
                title={
                  "Turbo export: these clips were remuxed without decoding or re-encoding" +
                  (lastExport.keyframeCuts
                    ? ` — ${lastExport.keyframeCuts} via keyframe-aligned trim`
                    : "")
                }
              >
                turbo ×{lastExport.copiedClips}
                {lastExport.keyframeCuts ? ` · ${lastExport.keyframeCuts}kf` : ""}
              </span>
            </>
          )}
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

      {/* Export button — v5.1 CapCut: cyan→emerald gradient primary action
          (hover brightness, desaturated while disabled). */}
      {!isExporting && (
        <button
          type="button"
          onClick={onExport}
          disabled={imageCount === 0}
          className={cn(
            "ff-btn-export flex h-10 items-center gap-2 rounded-lg px-4 text-[13px] font-semibold transition-all",
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
