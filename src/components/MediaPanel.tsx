"use client";

import { memo, useState, type DragEvent } from "react";
import {
  Plus,
  Upload,
  Music,
  Trash2,
  Pencil,
  Check,
  X,
  ArrowUp,
  ArrowDown,
  AlertTriangle,
  Info,
  GripVertical,
} from "lucide-react";
import type {
  MediaSegment,
  TimelineMode,
  AudioTrack,
  OverlapWarning,
} from "@/lib/merger/types";
import { fmtTimecode } from "@/lib/merger/timeline";
import { cn } from "@/lib/utils";

interface MediaPanelProps {
  segments: MediaSegment[];
  mode: TimelineMode | null;
  audioTrack: AudioTrack | null;
  skipped: string[];
  warnings: OverlapWarning[];
  onAddFiles: (files: File[]) => void;
  onLoadSamples: () => void;
  openImagePicker: () => void;
  openAudioPicker: () => void;
  onRemoveAudio: () => void;
  onRemove: (id: string) => void;
  onOverride: (id: string, durationMs: number) => void;
  onClearOverride: (id: string) => void;
  onReorder: (id: string, dir: -1 | 1) => void;
}

const KIND_STYLES: Record<string, string> = {
  absolute: "border-cyan-700/50 bg-cyan-950/40 text-cyan-300",
  beat: "border-emerald-700/50 bg-emerald-950/40 text-emerald-300",
  duration: "border-violet-700/50 bg-violet-950/40 text-violet-300",
};

export function MediaPanelBase({
  segments,
  mode,
  audioTrack,
  skipped,
  warnings,
  onAddFiles,
  onLoadSamples,
  openImagePicker,
  openAudioPicker,
  onRemoveAudio,
  onRemove,
  onOverride,
  onClearOverride,
  onReorder,
}: MediaPanelProps) {
  const [dragOver, setDragOver] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    const arr = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (arr.length) onAddFiles(arr);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  };

  const startEdit = (seg: MediaSegment) => {
    setEditingId(seg.id);
    setEditValue((seg.durationMs / 1000).toFixed(1));
  };

  const commitEdit = () => {
    if (editingId == null) return;
    const v = parseFloat(editValue);
    if (!Number.isNaN(v) && v > 0) {
      onOverride(editingId, Math.round(v * 1000));
    }
    setEditingId(null);
  };

  return (
    <div className="flex h-full flex-col bg-[#111113]">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
        <button
          type="button"
          onClick={openImagePicker}
          className="flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-violet-500"
        >
          <Plus className="size-4" /> Add Images
        </button>
        <button
          type="button"
          onClick={openAudioPicker}
          className="flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-[12px] font-medium text-zinc-200 transition-colors hover:bg-zinc-700"
        >
          <Music className="size-3.5" /> Audio
        </button>
        <div className="flex-1" />
        <span className="text-[11px] text-zinc-500">
          {segments.length} segment{segments.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {segments.length === 0 && (
          <div className="p-4">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={openImagePicker}
              className={cn(
                "ff-grid-bg flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors",
                dragOver
                  ? "border-violet-500 bg-violet-950/20"
                  : "border-zinc-700 hover:border-zinc-600 hover:bg-zinc-900/40",
              )}
            >
              <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-zinc-800">
                <Upload className="size-5 text-zinc-400" />
              </div>
              <p className="text-[13px] font-medium text-zinc-200">
                Drop images or click to browse
              </p>
              <p className="mt-1 text-[11px] text-zinc-500">
                Filenames encode timing — see the guide below
              </p>
            </div>
            <button
              type="button"
              onClick={onLoadSamples}
              className="mt-3 w-full rounded-lg border border-violet-900/50 bg-violet-950/30 py-2 text-[12px] font-medium text-violet-300 transition-colors hover:bg-violet-900/30"
            >
              ✨ Load sample storyboard (9 beats)
            </button>
          </div>
        )}

        {/* Segment list */}
        {segments.length > 0 && (
          <div className="space-y-1.5 p-3">
            {/* Dropzone (compact) when segments exist */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={openImagePicker}
              className={cn(
                "mb-2 flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed py-2 text-[11px] transition-colors",
                dragOver
                  ? "border-violet-500 bg-violet-950/20 text-violet-300"
                  : "border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-400",
              )}
            >
              <Plus className="size-3.5" /> Add more images
            </div>

            {segments.map((seg, idx) => {
              const overridden =
                seg.rawDurationMs != null &&
                Math.abs(seg.rawDurationMs - seg.durationMs) > 50;
              return (
                <div
                  key={seg.id}
                  className="group flex items-center gap-2.5 rounded-lg border border-zinc-800 bg-[#18181b] p-2 transition-colors hover:border-zinc-700"
                >
                  {/* Thumbnail */}
                  <div className="relative size-14 shrink-0 overflow-hidden rounded-md bg-black">
                    <img
                      src={seg.thumbnailUrl}
                      alt={seg.fileName}
                      className="size-full object-cover"
                      draggable={false}
                    />
                    <span className="absolute bottom-0 right-0 rounded-tl bg-black/70 px-1 text-[9px] font-medium text-zinc-300">
                      {idx + 1}
                    </span>
                  </div>

                  {/* Info */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          "rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide",
                          KIND_STYLES[seg.kind] || KIND_STYLES.duration,
                        )}
                      >
                        {seg.kind}
                      </span>
                      {editingId === seg.id ? (
                        <span className="flex items-center gap-1">
                          <input
                            autoFocus
                            type="number"
                            step="0.1"
                            min="0.1"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitEdit();
                              if (e.key === "Escape") setEditingId(null);
                            }}
                            className="w-14 rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-[11px] text-zinc-100 outline-none focus:border-violet-500"
                          />
                          <span className="text-[10px] text-zinc-500">s</span>
                          <button
                            type="button"
                            onClick={commitEdit}
                            className="text-emerald-400 hover:text-emerald-300"
                          >
                            <Check className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            className="text-zinc-500 hover:text-zinc-300"
                          >
                            <X className="size-3.5" />
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => startEdit(seg)}
                          className={cn(
                            "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono tabular-nums transition-colors",
                            overridden
                              ? "bg-amber-950/40 text-amber-300 hover:bg-amber-900/40"
                              : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200",
                          )}
                          title="Edit duration (seconds)"
                        >
                          {mode === "absolute"
                            ? `${fmtTimecode(seg.startMs)}–${fmtTimecode(seg.endMs)}`
                            : fmtTimecode(seg.durationMs)}
                          <Pencil className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
                        </button>
                      )}
                      {overridden && (
                        <button
                          type="button"
                          onClick={() => onClearOverride(seg.id)}
                          className="text-[9px] text-amber-500 hover:text-amber-400"
                          title="Reset to parsed duration"
                        >
                          reset
                        </button>
                      )}
                    </div>
                    <div
                      className="mt-0.5 truncate text-[11px] text-zinc-400"
                      title={seg.fileName}
                    >
                      {seg.fileName}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[9px] text-zinc-600">
                      <span>dur {(seg.durationMs / 1000).toFixed(1)}s</span>
                      <span className="text-zinc-700">·</span>
                      <span className="capitalize">{seg.direction}</span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex shrink-0 flex-col items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => onReorder(seg.id, -1)}
                      disabled={idx === 0}
                      className="text-zinc-600 transition-colors hover:text-zinc-300 disabled:opacity-30"
                      title="Move up"
                    >
                      <ArrowUp className="size-3.5" />
                    </button>
                    <GripVertical className="size-3 text-zinc-700" />
                    <button
                      type="button"
                      onClick={() => onReorder(seg.id, 1)}
                      disabled={idx === segments.length - 1}
                      className="text-zinc-600 transition-colors hover:text-zinc-300 disabled:opacity-30"
                      title="Move down"
                    >
                      <ArrowDown className="size-3.5" />
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemove(seg.id)}
                    className="shrink-0 rounded p-1 text-zinc-600 transition-colors hover:bg-red-950/40 hover:text-red-400"
                    title="Remove"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              );
            })}

            {/* Audio track chip */}
            {audioTrack && (
              <div className="flex items-center gap-2.5 rounded-lg border border-zinc-800 bg-[#18181b] p-2">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-fuchsia-950/40">
                  <Music className="size-4 text-fuchsia-300" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[11px] text-zinc-300" title={audioTrack.fileName}>
                    {audioTrack.fileName}
                  </div>
                  <div className="text-[9px] text-zinc-600">
                    audio track
                    {audioTrack.durationMs
                      ? ` · ${fmtTimecode(audioTrack.durationMs)}`
                      : ""}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onRemoveAudio}
                  className="shrink-0 rounded p-1 text-zinc-600 hover:bg-red-950/40 hover:text-red-400"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            )}

            {/* Warnings */}
            {warnings.length > 0 && (
              <div className="mt-2 space-y-1 rounded-lg border border-amber-900/40 bg-amber-950/10 p-2">
                {warnings.map((w, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-[10px] text-amber-300">
                    <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                    <span>{w.message}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Skipped */}
            {skipped.length > 0 && (
              <div className="mt-2 space-y-1 rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
                {skipped.map((s, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-[10px] text-zinc-500">
                    <Info className="mt-0.5 size-3 shrink-0" />
                    <span className="truncate" title={s}>
                      Skipped: {s}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Naming guide */}
        <NamingGuide />
      </div>
    </div>
  );
}

export const MediaPanel = memo(MediaPanelBase);

function NamingGuide() {
  const examples = [
    {
      label: "Absolute",
      color: "text-cyan-300",
      pattern: "[00:00:00 - 00:00:06] beach.jpg",
      desc: "Explicit start → end timecode",
    },
    {
      label: "Beat-sheet",
      color: "text-emerald-300",
      pattern: "001__Beat_1_0s_description.jpg",
      desc: "Start at 0s, auto-extends to next beat",
    },
    {
      label: "Duration",
      color: "text-violet-300",
      pattern: "10s_beach.jpg",
      desc: "Sequential 10-second clip",
    },
  ];
  return (
    <div className="m-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
        Filename Naming Guide
      </div>
      <div className="space-y-2">
        {examples.map((ex) => (
          <div key={ex.label}>
            <div className="flex items-center gap-2">
              <span className={cn("text-[10px] font-bold uppercase", ex.color)}>
                {ex.label}
              </span>
              <code className="rounded bg-zinc-950 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300">
                {ex.pattern}
              </code>
            </div>
            <div className="mt-0.5 pl-1 text-[10px] text-zinc-500">{ex.desc}</div>
          </div>
        ))}
      </div>
      <div className="mt-2 text-[9px] text-zinc-600">
        Timecodes accept SS, MM:SS, or HH:MM:SS.
      </div>
    </div>
  );
}
