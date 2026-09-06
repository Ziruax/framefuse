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
  ChevronDown,
  ChevronRight,
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

const KIND_STYLES: Record<
  string,
  { border: string; bg: string; text: string }
> = {
  absolute: { border: "#0e7490", bg: "rgba(8, 51, 68, 0.5)", text: "#67e8f9" },
  beat: { border: "#047857", bg: "rgba(6, 78, 59, 0.5)", text: "#6ee7b7" },
  duration: {
    border: "#6d28d9",
    bg: "rgba(76, 29, 149, 0.5)",
    text: "#c4b5fd",
  },
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
    <div
      className="flex h-full flex-col overflow-hidden"
      style={{ backgroundColor: "#111113" }}
    >
      {/* Toolbar */}
      <div
        className="flex items-center gap-2 border-b px-4 py-3"
        style={{ borderColor: "#27272a" }}
      >
        <button
          type="button"
          onClick={openImagePicker}
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-semibold transition-colors"
          style={{ backgroundColor: "#7c3aed", color: "#ffffff" }}
        >
          <Plus className="size-4" /> Add Images
        </button>
        <button
          type="button"
          onClick={openAudioPicker}
          className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors"
          style={{
            borderColor: "#3f3f46",
            backgroundColor: "#27272a",
            color: "#e4e4e7",
          }}
        >
          <Music className="size-3.5" /> Add Audio
        </button>
        <div className="flex-1" />
        <span className="text-[11px]" style={{ color: "#71717a" }}>
          {segments.length} segment{segments.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Scrollable content area */}
      <div className="ff-scroll flex-1 overflow-y-auto">
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
              )}
              style={{
                borderColor: dragOver ? "#7c3aed" : "#3f3f46",
                backgroundColor: dragOver ? "rgba(124, 58, 237, 0.1)" : "transparent",
              }}
            >
              <div
                className="mb-3 flex size-12 items-center justify-center rounded-full"
                style={{ backgroundColor: "#27272a" }}
              >
                <Upload className="size-5" style={{ color: "#a1a1aa" }} />
              </div>
              <p
                className="text-[13px] font-medium"
                style={{ color: "#e4e4e7" }}
              >
                Drop images or click to browse
              </p>
              <p className="mt-1 text-[11px]" style={{ color: "#71717a" }}>
                Filenames encode timing — see the guide below
              </p>
            </div>
            <button
              type="button"
              onClick={onLoadSamples}
              className="mt-3 w-full rounded-lg border py-2 text-[12px] font-medium transition-colors"
              style={{
                borderColor: "#6d28d9",
                backgroundColor: "rgba(76, 29, 149, 0.3)",
                color: "#c4b5fd",
              }}
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
              )}
              style={{
                borderColor: dragOver ? "#7c3aed" : "#27272a",
                color: dragOver ? "#c4b5fd" : "#71717a",
                backgroundColor: dragOver
                  ? "rgba(124, 58, 237, 0.1)"
                  : "transparent",
              }}
            >
              <Plus className="size-3.5" /> Add more images
            </div>

            {segments.map((seg, idx) => {
              const overridden =
                seg.rawDurationMs != null &&
                Math.abs(seg.rawDurationMs - seg.durationMs) > 50;
              const kindStyle =
                KIND_STYLES[seg.kind] || KIND_STYLES.duration;
              return (
                <div
                  key={seg.id}
                  className="group flex items-center gap-2.5 rounded-lg border p-2 transition-colors"
                  style={{
                    borderColor: "#27272a",
                    backgroundColor: "#18181b",
                  }}
                >
                  {/* Thumbnail (48x48) */}
                  <div
                    className="relative size-12 shrink-0 overflow-hidden rounded-md"
                    style={{ backgroundColor: "#000000" }}
                  >
                    <img
                      src={seg.thumbnailUrl}
                      alt={seg.fileName}
                      className="size-full object-cover"
                      draggable={false}
                    />
                    <span
                      className="absolute bottom-0 right-0 rounded-tl px-1 text-[9px] font-medium"
                      style={{
                        backgroundColor: "rgba(0, 0, 0, 0.7)",
                        color: "#d4d4d8",
                      }}
                    >
                      {idx + 1}
                    </span>
                  </div>

                  {/* Info */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span
                        className="rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide"
                        style={{
                          borderColor: kindStyle.border,
                          backgroundColor: kindStyle.bg,
                          color: kindStyle.text,
                        }}
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
                            className="w-14 rounded border px-1 py-0.5 text-[11px] outline-none"
                            style={{
                              borderColor: "#3f3f46",
                              backgroundColor: "#09090b",
                              color: "#e4e4e7",
                            }}
                          />
                          <span className="text-[10px]" style={{ color: "#71717a" }}>
                            s
                          </span>
                          <button
                            type="button"
                            onClick={commitEdit}
                            style={{ color: "#34d399" }}
                          >
                            <Check className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            style={{ color: "#71717a" }}
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
                          )}
                          style={{
                            backgroundColor: overridden
                              ? "rgba(120, 53, 15, 0.4)"
                              : "transparent",
                            color: overridden ? "#fcd34d" : "#a1a1aa",
                          }}
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
                          className="text-[9px] transition-colors"
                          style={{ color: "#f59e0b" }}
                          title="Reset to parsed duration"
                        >
                          reset
                        </button>
                      )}
                    </div>
                    <div
                      className="mt-0.5 truncate text-[11px]"
                      style={{ color: "#a1a1aa" }}
                      title={seg.fileName}
                    >
                      {seg.fileName}
                    </div>
                    <div
                      className="mt-0.5 flex items-center gap-2 text-[9px]"
                      style={{ color: "#52525b" }}
                    >
                      <span>dur {(seg.durationMs / 1000).toFixed(1)}s</span>
                      <span style={{ color: "#3f3f46" }}>·</span>
                      <span className="capitalize">{seg.direction}</span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex shrink-0 flex-col items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => onReorder(seg.id, -1)}
                      disabled={idx === 0}
                      className="transition-colors disabled:opacity-30"
                      style={{ color: "#52525b" }}
                      title="Move up"
                    >
                      <ArrowUp className="size-3.5" />
                    </button>
                    <GripVertical className="size-3" style={{ color: "#3f3f46" }} />
                    <button
                      type="button"
                      onClick={() => onReorder(seg.id, 1)}
                      disabled={idx === segments.length - 1}
                      className="transition-colors disabled:opacity-30"
                      style={{ color: "#52525b" }}
                      title="Move down"
                    >
                      <ArrowDown className="size-3.5" />
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => onRemove(seg.id)}
                    className="shrink-0 rounded p-1 transition-colors"
                    style={{ color: "#52525b" }}
                    title="Remove"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              );
            })}

            {/* Audio track chip */}
            {audioTrack && (
              <div
                className="flex items-center gap-2.5 rounded-lg border p-2"
                style={{
                  borderColor: "#27272a",
                  backgroundColor: "#18181b",
                }}
              >
                <div
                  className="flex size-10 shrink-0 items-center justify-center rounded-md"
                  style={{ backgroundColor: "rgba(112, 26, 117, 0.4)" }}
                >
                  <Music className="size-4" style={{ color: "#f0abfc" }} />
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className="truncate text-[11px]"
                    style={{ color: "#d4d4d8" }}
                    title={audioTrack.fileName}
                  >
                    {audioTrack.fileName}
                  </div>
                  <div className="text-[9px]" style={{ color: "#52525b" }}>
                    audio track
                    {audioTrack.durationMs
                      ? ` · ${fmtTimecode(audioTrack.durationMs)}`
                      : ""}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onRemoveAudio}
                  className="shrink-0 rounded p-1 transition-colors"
                  style={{ color: "#52525b" }}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            )}

            {/* Warnings */}
            {warnings.length > 0 && (
              <div
                className="mt-2 space-y-1 rounded-lg border p-2"
                style={{
                  borderColor: "rgba(146, 64, 14, 0.5)",
                  backgroundColor: "rgba(120, 53, 15, 0.15)",
                }}
              >
                {warnings.map((w, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-1.5 text-[10px]"
                    style={{ color: "#fcd34d" }}
                  >
                    <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                    <span>{w.message}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Skipped */}
            {skipped.length > 0 && (
              <div
                className="mt-2 space-y-1 rounded-lg border p-2"
                style={{
                  borderColor: "#27272a",
                  backgroundColor: "rgba(24, 24, 27, 0.5)",
                }}
              >
                {skipped.map((s, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-1.5 text-[10px]"
                    style={{ color: "#71717a" }}
                  >
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

        {/* Naming guide (collapsible) */}
        <NamingGuide />
      </div>
    </div>
  );
}

export const MediaPanel = memo(MediaPanelBase);

function NamingGuide() {
  const [open, setOpen] = useState(false);
  const examples = [
    {
      label: "Absolute",
      color: "#22d3ee",
      pattern: "[00:00:00 - 00:00:06] beach.jpg",
      desc: "Explicit start → end timecode",
    },
    {
      label: "Beat-sheet",
      color: "#34d399",
      pattern: "001__Beat_1_0s_description.jpg",
      desc: "Start at 0s, auto-extends to next beat",
    },
    {
      label: "Duration",
      color: "#a78bfa",
      pattern: "10s_beach.jpg",
      desc: "Sequential 10-second clip",
    },
  ];
  return (
    <div
      className="m-3 rounded-lg border p-3"
      style={{
        borderColor: "#27272a",
        backgroundColor: "rgba(24, 24, 27, 0.5)",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider transition-colors"
        style={{ color: "#71717a" }}
      >
        {open ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
        Filename Naming Guide
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {examples.map((ex) => (
            <div key={ex.label}>
              <div className="flex items-center gap-2">
                <span
                  className="text-[10px] font-bold uppercase"
                  style={{ color: ex.color }}
                >
                  {ex.label}
                </span>
                <code
                  className="rounded px-1.5 py-0.5 font-mono text-[10px]"
                  style={{
                    backgroundColor: "#09090b",
                    color: "#d4d4d8",
                  }}
                >
                  {ex.pattern}
                </code>
              </div>
              <div className="mt-0.5 pl-1 text-[10px]" style={{ color: "#71717a" }}>
                {ex.desc}
              </div>
            </div>
          ))}
          <div className="mt-2 text-[9px]" style={{ color: "#52525b" }}>
            Timecodes accept SS, MM:SS, or HH:MM:SS.
          </div>
        </div>
      )}
    </div>
  );
}
