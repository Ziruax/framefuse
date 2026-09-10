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
  Captions,
  FileText,
  Copy,
  Save,
  FolderOpen,
  Sparkles,
  ArrowLeftRight,
} from "lucide-react";
import type {
  MediaSegment,
  TimelineMode,
  AudioTrack,
  OverlapWarning,
  SubtitleFile,
  TransitionSettings,
} from "@/lib/merger/types";
import { TRANSITION_STYLE_INFO } from "@/lib/merger/types";
import { fmtTimecode } from "@/lib/merger/timeline";
import { cn } from "@/lib/utils";

interface MediaPanelProps {
  segments: MediaSegment[];
  mode: TimelineMode | null;
  audioTrack: AudioTrack | null;
  subtitles: SubtitleFile | null;
  skipped: string[];
  warnings: OverlapWarning[];
  onAddFiles: (files: File[]) => void;
  /** Drag-drop support: audio + .srt + .framefuse.json files are routed too. */
  onAddAudioFile: (file: File) => void;
  onAddSubtitleFile: (file: File) => void;
  /** Open a dropped .framefuse.json project (v4.2). */
  onLoadProjectFile: (file: File) => void;
  onLoadSamples: () => void;
  openImagePicker: () => void;
  openAudioPicker: () => void;
  openSubtitlePicker: () => void;
  onRemoveAudio: () => void;
  onRemoveSubtitles: () => void;
  onRemove: (id: string) => void;
  onOverride: (id: string, durationMs: number) => void;
  onClearOverride: (id: string) => void;
  onReorder: (id: string, dir: -1 | 1) => void;
  /** Duplicate a segment in place (v4.2). */
  onDuplicate: (id: string) => void;
  /** Save the current session as .framefuse.json (v4.2). */
  onSaveProject: () => void;
  onOpenProject: () => void;
  /** Segment transitions (v4.3) — boundary link indicators. */
  transition: TransitionSettings;
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

const isProjectFile = (f: File) =>
  /\.framefuse\.json$/i.test(f.name) ||
  (f.type === "application/json" && /\.json$/i.test(f.name));

export function MediaPanelBase({
  segments,
  mode,
  audioTrack,
  subtitles,
  skipped,
  warnings,
  onAddFiles,
  onAddAudioFile,
  onAddSubtitleFile,
  onLoadProjectFile,
  onLoadSamples,
  openImagePicker,
  openAudioPicker,
  openSubtitlePicker,
  onRemoveAudio,
  onRemoveSubtitles,
  onRemove,
  onOverride,
  onClearOverride,
  onReorder,
  onDuplicate,
  onSaveProject,
  onOpenProject,
  transition,
}: MediaPanelProps) {
  const [dragOver, setDragOver] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  // v4.1: drag-drop routes images, audio AND .srt files with feedback.
  // v4.2: also routes .framefuse.json project files.
  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    const all = Array.from(files);
    const projects = all.filter(isProjectFile);
    const images = all.filter((f) => f.type.startsWith("image/"));
    const audio = all.filter(
      (f) => f.type.startsWith("audio/") || /\.(mp3|wav|m4a|ogg|flac|aac|opus)$/i.test(f.name),
    );
    const srts = all.filter(
      (f) => f.type === "application/x-subrip" || /\.srt$/i.test(f.name),
    );
    if (projects.length) onLoadProjectFile(projects[projects.length - 1]);
    if (images.length) onAddFiles(images);
    if (audio.length) onAddAudioFile(audio[audio.length - 1]);
    if (srts.length) onAddSubtitleFile(srts[srts.length - 1]);
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
        className="flex items-center gap-1.5 border-b px-3 py-2.5"
        style={{ borderColor: "#27272a" }}
      >
        <button
          type="button"
          onClick={openImagePicker}
          className="ff-btn-primary flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-semibold"
        >
          <Plus className="size-4" /> Add Images
        </button>
        <button
          type="button"
          onClick={openAudioPicker}
          className="ff-btn-ghost flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium"
          title="Attach an audio track (voiceover / music)"
        >
          <Music className="size-3.5" /> Audio
        </button>
        <button
          type="button"
          onClick={openSubtitlePicker}
          className="ff-btn-ghost flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium"
          title="Load an .srt subtitle file"
        >
          <Captions className="size-3.5" /> Subs
          {subtitles && subtitles.cues.length > 0 && (
            <span
              className="ml-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-bold"
              style={{
                backgroundColor: "rgba(124, 58, 237, 0.35)",
                color: "#ddd6fe",
              }}
            >
              {subtitles.cues.length}
            </span>
          )}
        </button>
        <div className="flex-1" />
        {/* Project save / open (v4.2) */}
        <button
          type="button"
          onClick={onSaveProject}
          className="ff-btn-ghost flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-medium"
          title="Save the full session (media + captions + headlines + settings) as a self-contained .framefuse.json"
        >
          <Save className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onOpenProject}
          className="ff-btn-ghost flex items-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-medium"
          title="Open a saved .framefuse.json project"
        >
          <FolderOpen className="size-3.5" />
        </button>
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
              className="ff-grid-bg flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-12 text-center transition-all duration-200"
              style={{
                borderColor: dragOver ? "#7c3aed" : "#3f3f46",
                backgroundColor: dragOver ? "rgba(124, 58, 237, 0.1)" : "transparent",
                boxShadow: dragOver ? "0 0 32px rgba(124, 58, 237, 0.25) inset" : "none",
              }}
            >
              <div
                className="mb-3 flex size-12 items-center justify-center rounded-full transition-transform duration-200"
                style={{
                  backgroundColor: dragOver ? "rgba(124, 58, 237, 0.25)" : "#27272a",
                  transform: dragOver ? "scale(1.08)" : "scale(1)",
                }}
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
                Images · audio · .srt · .framefuse.json projects
              </p>
            </div>
            <button
              type="button"
              onClick={onLoadSamples}
              className="ff-btn-sample mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border py-2 text-[12px] font-medium transition-all duration-200"
            >
              <Sparkles className="size-3.5" /> Load sample storyboard (9 beats)
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
              className="mb-2 flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed py-2 text-[11px] transition-all duration-200"
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
                <div key={seg.id}>
                {(idx > 0 && transition && transition.style !== "none") ? (
                  <div
                    className="ff-tx-link -my-0.5 flex items-center gap-1.5 pl-6 text-[9px] font-medium capitalize"
                    style={{ color: "#d8b4fe" }}
                    title={`${TRANSITION_STYLE_INFO[transition.style].label} transition into this segment · ${(Math.min(transition.durationMs, Math.floor(seg.durationMs * 0.45)) / 1000).toFixed(1)}s`}
                  >
                    <span
                      className="inline-flex size-3.5 items-center justify-center rounded-full"
                      style={{
                        backgroundImage:
                          "linear-gradient(135deg, #8b5cf6, #d946ef)",
                        boxShadow: "0 0 6px rgba(139, 92, 246, 0.45)",
                      }}
                    >
                      <ArrowLeftRight className="size-2" style={{ color: "#fff" }} />
                    </span>
                    {transition.style.replace("-", " ")}
                  </div>
                ) : null}
                <div
                  key={seg.id}
                  className="group relative flex items-center gap-2.5 overflow-hidden rounded-lg border p-2 transition-all duration-150 hover:-translate-y-px"
                  style={{
                    borderColor: "#27272a",
                    backgroundColor: "#18181b",
                  }}
                >
                  {/* Active-segment left accent (matches the timeline). */}
                  <span
                    className="absolute inset-y-0 left-0 w-[3px]"
                    style={{
                      backgroundColor: kindStyle.border,
                      opacity: 0.65,
                    }}
                  />
                  {/* Thumbnail (48x48) */}
                  <div
                    className="relative size-12 shrink-0 overflow-hidden rounded-lg ring-1 ring-black/40"
                    style={{ backgroundColor: "#000000" }}
                  >
                    <img
                      src={seg.thumbnailUrl}
                      alt={seg.fileName}
                      className="size-full object-cover transition-transform duration-200 group-hover:scale-105"
                      draggable={false}
                    />
                    <span
                      className="absolute bottom-0 right-0 rounded-tl bg-black/75 px-1 text-[9px] font-semibold tabular-nums"
                      style={{ color: "#e4e4e7" }}
                    >
                      {idx + 1}
                    </span>
                  </div>

                  {/* Info */}
                  <div className="ml-1 min-w-0 flex-1">
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
                            className="w-14 rounded border px-1 py-0.5 text-[11px] outline-none focus:border-violet-500"
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
                            className="rounded p-0.5 transition-colors hover:bg-white/10"
                            style={{ color: "#34d399" }}
                            title="Apply duration"
                          >
                            <Check className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            className="rounded p-0.5 transition-colors hover:bg-white/10"
                            style={{ color: "#71717a" }}
                            title="Cancel"
                          >
                            <X className="size-3.5" />
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => startEdit(seg)}
                          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono tabular-nums transition-colors hover:bg-white/5"
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
                          className="text-[9px] transition-colors hover:underline"
                          style={{ color: "#f59e0b" }}
                          title="Reset to parsed duration"
                        >
                          reset
                        </button>
                      )}
                    </div>
                    <div
                      className="mt-0.5 truncate text-[11px] font-medium"
                      style={{ color: "#d4d4d8" }}
                      title={seg.fileName}
                    >
                      {seg.fileName}
                    </div>
                    <div
                      className="mt-0.5 flex items-center gap-2 text-[9px]"
                      style={{ color: "#71717a" }}
                    >
                      <span className="tabular-nums">
                        dur {(seg.durationMs / 1000).toFixed(1)}s
                      </span>
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
                      className="rounded p-0.5 transition-colors hover:bg-white/10 disabled:opacity-30"
                      style={{ color: "#71717a" }}
                      title="Move up"
                    >
                      <ArrowUp className="size-3.5" />
                    </button>
                    <GripVertical className="size-3" style={{ color: "#3f3f46" }} />
                    <button
                      type="button"
                      onClick={() => onReorder(seg.id, 1)}
                      disabled={idx === segments.length - 1}
                      className="rounded p-0.5 transition-colors hover:bg-white/10 disabled:opacity-30"
                      style={{ color: "#71717a" }}
                      title="Move down"
                    >
                      <ArrowDown className="size-3.5" />
                    </button>
                  </div>
                  <div className="flex shrink-0 flex-col items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onDuplicate(seg.id)}
                      className="rounded p-1 opacity-40 transition-all hover:bg-violet-500/15 hover:opacity-100 group-hover:opacity-100"
                      style={{ color: "#c4b5fd" }}
                      title="Duplicate segment"
                    >
                      <Copy className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemove(seg.id)}
                      className="rounded p-1 opacity-40 transition-all hover:bg-red-500/15 hover:text-red-400 group-hover:opacity-100"
                      style={{ color: "#a1a1aa" }}
                      title="Remove"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>
                </div>
              );
            })}

            {/* Audio track chip */}
            {audioTrack && (
              <div
                className="flex items-center gap-2.5 rounded-lg border p-2 transition-colors"
                style={{
                  borderColor: "rgba(112, 26, 117, 0.45)",
                  backgroundColor: "#18181b",
                }}
              >
                <div
                  className="flex size-10 shrink-0 items-center justify-center rounded-lg"
                  style={{
                    backgroundColor: "rgba(112, 26, 117, 0.4)",
                    boxShadow: "0 0 12px rgba(217, 70, 239, 0.15)",
                  }}
                >
                  <Music className="size-4" style={{ color: "#f0abfc" }} />
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className="truncate text-[11px] font-medium"
                    style={{ color: "#d4d4d8" }}
                    title={audioTrack.fileName}
                  >
                    {audioTrack.fileName}
                  </div>
                  <div className="text-[9px]" style={{ color: "#71717a" }}>
                    audio track
                    {audioTrack.durationMs
                      ? ` · ${fmtTimecode(audioTrack.durationMs)}`
                      : ""}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onRemoveAudio}
                  className="shrink-0 rounded p-1 transition-colors hover:bg-red-500/15"
                  style={{ color: "#71717a" }}
                  title="Remove audio"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            )}

            {/* Whisper caption generation moved to the right Settings panel
                (Captions section) so all caption controls are in one place. */}

            {/* Subtitles chip */}
            {subtitles && subtitles.cues.length > 0 && (
              <div
                className="flex items-center gap-2.5 rounded-lg border p-2 transition-colors"
                style={{
                  borderColor: "rgba(76, 29, 149, 0.45)",
                  backgroundColor: "#18181b",
                }}
              >
                <div
                  className="flex size-10 shrink-0 items-center justify-center rounded-lg"
                  style={{
                    backgroundColor: "rgba(76, 29, 149, 0.4)",
                    boxShadow: "0 0 12px rgba(124, 58, 237, 0.15)",
                  }}
                >
                  <Captions className="size-4" style={{ color: "#c4b5fd" }} />
                </div>
                <div className="min-w-0 flex-1">
                  <div
                    className="truncate text-[11px] font-medium"
                    style={{ color: "#d4d4d8" }}
                    title={subtitles.fileName}
                  >
                    {subtitles.fileName}
                  </div>
                  <div className="text-[9px]" style={{ color: "#71717a" }}>
                    subtitles · {subtitles.cues.length} cue
                    {subtitles.cues.length === 1 ? "" : "s"}
                    {subtitles.cues.length > 0
                      ? ` · ${fmtTimecode(subtitles.cues[subtitles.cues.length - 1].endMs)}`
                      : ""}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onRemoveSubtitles}
                  className="shrink-0 rounded p-1 transition-colors hover:bg-red-500/15"
                  style={{ color: "#71717a" }}
                  title="Remove subtitles"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            )}

            {/* Empty subtitles hint when none loaded */}
            {!subtitles && (
              <button
                type="button"
                onClick={openSubtitlePicker}
                className="flex w-full items-center gap-2 rounded-lg border border-dashed p-2 text-[11px] transition-all hover:border-violet-500/50 hover:bg-violet-500/5"
                style={{
                  borderColor: "#27272a",
                  color: "#71717a",
                  backgroundColor: "transparent",
                }}
              >
                <FileText className="size-3.5" />
                <span>Add an .srt subtitle file</span>
              </button>
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
        className="flex w-full items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] transition-colors hover:text-zinc-400"
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
