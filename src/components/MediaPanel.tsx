"use client";

import { memo, useRef, useState, type DragEvent } from "react";
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
  RotateCcw,
  Activity,
  Scissors,
  Timer,
  Lock,
  List,
  LayoutGrid,
  MoveDiagonal,
} from "lucide-react";
import type {
  MediaSegment,
  TimelineMode,
  AudioTrack,
  OverlapWarning,
  SubtitleFile,
  TransitionSettings,
  TransitionStyle,
  KenBurnsDirection,
} from "@/lib/merger/types";
import { TRANSITION_STYLE_INFO, boundaryStyle } from "@/lib/merger/types";
import { fmtTimecode } from "@/lib/merger/timeline";
import type { BeatInfo } from "@/lib/merger/beatDetect";
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
  /** v4.5 drag-reorder: move an item to an absolute index. */
  onMoveTo: (id: string, targetIdx: number) => void;
  /** Duplicate a segment in place (v4.2). */
  onDuplicate: (id: string) => void;
  /** v4.5 per-boundary transition override (null = follow global). */
  onBoundaryStyle: (segId: string, style: TransitionStyle | null) => void;
  /** v4.5: reset ALL per-boundary overrides. */
  onClearBoundaryOverrides: () => void;
  /** Save the current session as .framefuse.json (v4.2). */
  onSaveProject: () => void;
  onOpenProject: () => void;
  /** Segment transitions (v4.3) — boundary link indicators. */
  transition: TransitionSettings;
  /** Beat detection results (v4.6) — null until detected. */
  beatInfo: BeatInfo | null;
  beatBusy: boolean;
  onDetectBeats: () => void;
  onSnapToBeats: () => void;
  onFitToAudio: () => void;
  /** v4.7 strength dial: boundaries land on every Nth beat (1/2/4/8). */
  beatStride: number;
  onBeatStrideChange: (n: number) => void;
  /** v4.8: per-segment Ken Burns direction overrides (id → direction). */
  motionOverrides: Record<string, KenBurnsDirection>;
  /** Pin one segment's motion (null = clear → back to global/random). */
  onSetMotion: (segId: string, dir: KenBurnsDirection | null) => void;
  /** Reset every motion override back to the global setting. */
  onClearMotionOverrides: () => void;
  /** v4.8: media library layout (list = rich rows, grid = compact tiles). */
  mediaView: "list" | "grid";
  onMediaViewChange: (v: "list" | "grid") => void;
  /** v4.8: active segment id (grid tiles highlight the playhead segment). */
  activeId: string | null;
  /** v4.8: grid tile click → seek the playhead to that segment. */
  onSelectSegment?: (id: string) => void;
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

const MOTION_OPTIONS: { value: KenBurnsDirection; label: string; glyph: string }[] = [
  { value: "in", label: "Zoom In", glyph: "⤢" },
  { value: "out", label: "Zoom Out", glyph: "⤡" },
  { value: "left", label: "Pan Left", glyph: "←" },
  { value: "right", label: "Pan Right", glyph: "→" },
  { value: "up", label: "Pan Up", glyph: "↑" },
  { value: "down", label: "Pan Down", glyph: "↓" },
];

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
  onMoveTo,
  onDuplicate,
  onBoundaryStyle,
  onClearBoundaryOverrides,
  onSaveProject,
  onOpenProject,
  transition,
  beatInfo,
  beatBusy,
  onDetectBeats,
  onSnapToBeats,
  onFitToAudio,
  beatStride,
  onBeatStrideChange,
  motionOverrides,
  onSetMotion,
  onClearMotionOverrides,
  mediaView,
  onMediaViewChange,
  activeId,
  onSelectSegment,
}: MediaPanelProps) {
  const [dragOver, setDragOver] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  // v4.5: per-boundary transition popover + card drag-reorder state.
  // `draggedIdRef` is the SYNCHRONOUS source of truth (state stays for
  // styling) — dragstart→drop can commit in the same tick when drags are
  // programmatic/fast, and React state hasn't committed yet at drop time.
  const [openBoundary, setOpenBoundary] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTargetIdx, setDropTargetIdx] = useState<number | null>(null);
  const draggedIdRef = useRef<string | null>(null);
  // v4.8: per-segment motion popover (mirrors the boundary picker pattern).
  const [openMotion, setOpenMotion] = useState<string | null>(null);

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
          className="ff-btn-ghost flex items-center gap-1.5 rounded-md border-emerald-600/50 px-2.5 py-1.5 text-[12px] font-semibold"
          style={{ color: "#a7f3d0" }}
          title="Add images (or drop them anywhere on this panel)"
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
        {/* v4.8: library layout toggle — rich rows vs compact tiles. */}
        <div
          className="flex items-center rounded-md border p-0.5"
          style={{ borderColor: "#27272a" }}
          role="radiogroup"
          aria-label="Media library view"
        >
          <button
            type="button"
            onClick={() => onMediaViewChange("list")}
            aria-pressed={mediaView === "list"}
            title="List view — details, durations, boundary links"
            className={cn(
              "flex items-center justify-center rounded-[4px] p-1.5 transition-all duration-150",
              mediaView === "list"
                ? "bg-violet-500/25 text-violet-200 shadow-[inset_0_0_0_1px_rgba(167,139,250,0.4)]"
                : "text-zinc-500 hover:bg-white/5 hover:text-zinc-300",
            )}
          >
            <List className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onMediaViewChange("grid")}
            aria-pressed={mediaView === "grid"}
            title="Grid view — compact tiles for large storyboards"
            className={cn(
              "flex items-center justify-center rounded-[4px] p-1.5 transition-all duration-150",
              mediaView === "grid"
                ? "bg-violet-500/25 text-violet-200 shadow-[inset_0_0_0_1px_rgba(167,139,250,0.4)]"
                : "text-zinc-500 hover:bg-white/5 hover:text-zinc-300",
            )}
          >
            <LayoutGrid className="size-3.5" />
          </button>
        </div>
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
                // v4.5: card drags (reorder) must not light up the file zone.
                if (!e.dataTransfer.types.includes("Files")) return;
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={openImagePicker}
              className="mb-2 flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed py-2.5 text-[11px] font-medium transition-all duration-200 hover:border-violet-500/50 hover:bg-violet-500/5 hover:text-zinc-300"
              style={{
                borderColor: dragOver ? "#7c3aed" : "#27272a",
                color: dragOver ? "#c4b5fd" : "#8b8b93",
                backgroundColor: dragOver
                  ? "rgba(124, 58, 237, 0.1)"
                  : "transparent",
              }}
            >
              <Plus
                className={cn(
                  "size-3.5 transition-transform duration-200",
                  !dragOver && "group-hover:rotate-90",
                )}
              />{" "}
              Add more images
            </div>

            {/* v4.5: per-boundary override summary + reset-all. */}
            {transition.overrides && Object.keys(transition.overrides).length > 0 && (
              <div
                className="mb-2 flex items-center justify-between rounded-md border px-2 py-1"
                style={{
                  borderColor: "rgba(251, 191, 36, 0.25)",
                  backgroundColor: "rgba(120, 53, 15, 0.14)",
                }}
              >
                <span className="text-[9px] font-medium" style={{ color: "#fbbf24" }}>
                  ✦ {Object.keys(transition.overrides).length} custom
                  {" "}
                  {Object.keys(transition.overrides).length === 1 ? "boundary" : "boundaries"}
                </span>
                <button
                  type="button"
                  onClick={onClearBoundaryOverrides}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[8px] font-semibold transition-colors hover:bg-amber-500/15"
                  style={{ color: "#fbbf24" }}
                  title="Reset every boundary back to the global transition"
                >
                  <RotateCcw className="size-2.5" /> reset all
                </button>
              </div>
            )}

            {segments.length > 0 && Object.keys(motionOverrides).length > 0 && (
              <div
                className="mb-2 flex items-center justify-between rounded-md border px-2 py-1"
                style={{
                  borderColor: "rgba(52, 211, 153, 0.22)",
                  backgroundColor: "rgba(6, 78, 59, 0.12)",
                }}
              >
                <span className="text-[9px] font-medium" style={{ color: "#6ee7b7" }}>
                  ✦ {Object.keys(motionOverrides).length} custom
                  {" "}
                  {Object.keys(motionOverrides).length === 1 ? "motion" : "motions"}
                </span>
                <button
                  type="button"
                  onClick={onClearMotionOverrides}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[8px] font-semibold transition-colors hover:bg-emerald-500/15"
                  style={{ color: "#6ee7b7" }}
                  title="Reset every motion back to the global Ken Burns setting"
                >
                  <RotateCcw className="size-2.5" /> reset all
                </button>
              </div>
            )}

            {mediaView === "grid" ? (
              /* v4.8: compact tile grid — built for 100+ image storyboards.
               * Tiles show index + duration; click seeks; hover reveals
               * remove; drag-reorder works in sequential mode. */
              <div className="grid grid-cols-3 gap-1.5">
                {segments.map((seg, idx) => {
                  const motionPinned = Object.prototype.hasOwnProperty.call(
                    motionOverrides,
                    seg.id,
                  );
                  const dragEnabled = mode !== "absolute";
                  return (
                    <div
                      key={seg.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`Segment ${idx + 1} — ${(seg.durationMs / 1000).toFixed(1)}s, ${seg.fileName}`}
                      draggable={dragEnabled}
                      onDragStart={(e) => {
                        if (!dragEnabled) return;
                        draggedIdRef.current = seg.id;
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", seg.id);
                      }}
                      onDragEnd={() => {
                        draggedIdRef.current = null;
                        setDropTargetIdx(null);
                      }}
                      onDragOver={(e) => {
                        const id = draggedIdRef.current;
                        if (!id || id === seg.id) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        setDropTargetIdx(idx);
                      }}
                      onDrop={(e) => {
                        const id = draggedIdRef.current;
                        if (!id) return;
                        e.preventDefault();
                        e.stopPropagation();
                        onMoveTo(id, idx);
                        draggedIdRef.current = null;
                        setDropTargetIdx(null);
                      }}
                      onClick={() => onSelectSegment?.(seg.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          onSelectSegment?.(seg.id);
                        }
                      }}
                      className={cn(
                        "group/tile relative aspect-square cursor-pointer overflow-hidden rounded-lg border transition-all duration-150 hover:-translate-y-0.5",
                        activeId === seg.id
                          ? "border-violet-400/70 shadow-[0_0_0_1px_rgba(167,139,250,0.5),0_4px_16px_rgba(0,0,0,0.4)]"
                          : "border-[#27272a] hover:border-zinc-600",
                        dropTargetIdx === idx &&
                          draggedId &&
                          draggedId !== seg.id &&
                          "ring-1 ring-violet-400/70",
                      )}
                      style={{ backgroundColor: "#18181b" }}
                      title={`${seg.fileName}\n${fmtTimecode(seg.startMs)} – ${fmtTimecode(seg.endMs)} · motion ${seg.direction}${motionPinned ? " (custom)" : ""}\nclick to jump`}
                    >
                      <img
                        src={seg.thumbnailUrl}
                        alt={seg.fileName}
                        className="pointer-events-none size-full object-cover transition-transform duration-200 group-hover/tile:scale-105"
                        draggable={false}
                      />
                      {/* Scrim + labels */}
                      <span
                        className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2"
                        style={{
                          background:
                            "linear-gradient(to top, rgba(0,0,0,0.78), rgba(0,0,0,0))",
                        }}
                      />
                      <span
                        className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/70 px-1 text-[8px] font-semibold tabular-nums backdrop-blur-sm"
                        style={{ color: "#e4e4e7" }}
                      >
                        {idx + 1}
                      </span>
                      <span
                        className="pointer-events-none absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[8px] tabular-nums backdrop-blur-sm"
                        style={{ color: "#d4d4d8" }}
                      >
                        {(seg.durationMs / 1000).toFixed(1)}s
                      </span>
                      {/* Pinned motion indicator */}
                      {motionPinned && (
                        <span
                          className="pointer-events-none absolute left-1 top-1 flex items-center gap-0.5 rounded px-1 py-0.5 text-[7px] font-bold uppercase backdrop-blur-sm"
                          style={{
                            backgroundColor: "rgba(6, 78, 59, 0.75)",
                            color: "#6ee7b7",
                          }}
                          title={`Pinned motion: ${motionOverrides[seg.id]}`}
                        >
                          <MoveDiagonal className="size-2" />
                          {motionOverrides[seg.id]}
                        </span>
                      )}
                      {/* Hover actions */}
                      <span className="absolute right-1 top-1 flex gap-1 opacity-0 transition-opacity duration-150 group-hover/tile:opacity-100">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemove(seg.id);
                          }}
                          className="flex items-center justify-center rounded bg-black/70 p-1 backdrop-blur-sm transition-colors hover:bg-red-500/40"
                          style={{ color: "#d4d4d8" }}
                          title="Remove"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </span>
                    </div>
                  );
                })}
                {/* Add-more tile (grid mode) */}
                <button
                  type="button"
                  onClick={openImagePicker}
                  className="flex aspect-square items-center justify-center rounded-lg border border-dashed transition-all duration-150 hover:border-violet-500/50 hover:bg-violet-500/5"
                  style={{ borderColor: "#27272a", color: "#52525b" }}
                  title="Add more images"
                >
                  <Plus className="size-5" />
                </button>
              </div>
            ) : (
            <>{segments.map((seg, idx) => {
              const overridden =
                seg.rawDurationMs != null &&
                Math.abs(seg.rawDurationMs - seg.durationMs) > 50;
              const kindStyle =
                KIND_STYLES[seg.kind] || KIND_STYLES.duration;
              // v4.5: drag-reorder only re-sequences SEQUENTIAL timelines —
              // absolute/beat projects are ordered by filename timestamps.
              const dragEnabled = mode !== "absolute";
              // v4.5 boundary state: effective style + whether it's pinned.
              const effStyle = boundaryStyle(transition, seg.id);
              const isPinned =
                !!transition.overrides &&
                Object.prototype.hasOwnProperty.call(transition.overrides, seg.id);
              const boundaryOpen = openBoundary === seg.id;
              const motionPinned = Object.prototype.hasOwnProperty.call(
                motionOverrides,
                seg.id,
              );
              const motionOpen = openMotion === seg.id;
              const headDurSec =
                (Math.min(transition.durationMs, Math.floor(seg.durationMs * 0.45)) / 1000);
              return (
                <div key={seg.id}>
                {idx > 0 ? (
                  <div className="relative -my-0.5">
                    {/* Click-outside backdrop while the picker is open. */}
                    {boundaryOpen && (
                      <div
                        className="fixed inset-0 z-20"
                        onClick={() => setOpenBoundary(null)}
                        aria-hidden
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => setOpenBoundary(boundaryOpen ? null : seg.id)}
                      aria-expanded={boundaryOpen}
                      aria-label={`Transition into segment ${idx + 1}`}
                      className={cn(
                        "ff-tx-link relative z-[21] ml-5 flex items-center gap-1.5 rounded-full py-0.5 pl-2 pr-2.5 text-[9px] font-medium capitalize transition-all duration-200",
                        effStyle === "none" && !isPinned
                          ? "opacity-40 hover:opacity-100"
                          : "hover:brightness-110",
                      )}
                      style={
                        isPinned
                          ? {
                              color: "#fbbf24",
                              backgroundColor: "rgba(120, 53, 15, 0.22)",
                              boxShadow: "inset 0 0 0 1px rgba(251, 191, 36, 0.28)",
                            }
                          : effStyle !== "none"
                            ? { color: "#d8b4fe" }
                            : { color: "#71717a" }
                      }
                      title={`${TRANSITION_STYLE_INFO[effStyle].label} into segment ${idx + 1}${isPinned ? " (custom)" : ""} · ${headDurSec.toFixed(1)}s · click to customize`}
                    >
                      <span
                        className="inline-flex size-3.5 items-center justify-center rounded-full transition-transform duration-200 group-hover:scale-110"
                        style={
                          effStyle === "none"
                            ? {
                                backgroundColor: "#3f3f46",
                              }
                            : {
                                backgroundImage:
                                  "linear-gradient(135deg, #8b5cf6, #d946ef)",
                                boxShadow: "0 0 6px rgba(139, 92, 246, 0.45)",
                              }
                        }
                      >
                        <ArrowLeftRight className="size-2" style={{ color: effStyle === "none" ? "#a1a1aa" : "#fff" }} />
                      </span>
                      {isPinned && effStyle === "none" ? "hard cut" : effStyle.replace("-", " ")}
                      {isPinned && effStyle !== "none" ? " ✦" : ""}
                      <ChevronDown
                        className={cn(
                          "size-2.5 transition-transform duration-200",
                          boundaryOpen && "rotate-180",
                        )}
                        style={{ color: "currentColor" }}
                      />
                    </button>

                    {/* v4.5 boundary style picker. */}
                    {boundaryOpen && (
                      <div className="ff-pop absolute left-5 top-full z-[22] mt-1 w-56 rounded-lg border p-2 shadow-xl">
                        <p className="mb-1.5 px-0.5 text-[9px] font-semibold uppercase tracking-wider" style={{ color: "#71717a" }}>
                          Boundary {idx} → {idx + 1}
                        </p>
                        <div className="grid grid-cols-2 gap-1">
                          {(Object.keys(TRANSITION_STYLE_INFO) as TransitionStyle[]).map((st) => (
                            <button
                              key={st}
                              type="button"
                              onClick={() => {
                                onBoundaryStyle(seg.id, st);
                                setOpenBoundary(null);
                              }}
                              className={cn(
                                "rounded px-1.5 py-1 text-left text-[9px] font-medium transition-all duration-150",
                                effStyle === st
                                  ? "bg-violet-500/25 ring-1 ring-violet-400/50"
                                  : "hover:bg-white/5",
                              )}
                              style={{ color: effStyle === st ? "#d8b4fe" : "#a1a1aa" }}
                              title={TRANSITION_STYLE_INFO[st].hint}
                            >
                              {TRANSITION_STYLE_INFO[st].label}
                            </button>
                          ))}
                        </div>
                        <div className="mt-1.5 flex items-center justify-between border-t pt-1.5" style={{ borderColor: "#27272a" }}>
                          <span className="text-[8px] tabular-nums" style={{ color: "#52525b" }}>
                            {headDurSec.toFixed(1)}s · global: {transition.style.replace("-", " ")}
                          </span>
                          {isPinned && (
                            <button
                              type="button"
                              onClick={() => {
                                onBoundaryStyle(seg.id, null);
                                setOpenBoundary(null);
                              }}
                              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[8px] font-semibold transition-colors hover:bg-white/5"
                              style={{ color: "#fbbf24" }}
                            >
                              <RotateCcw className="size-2.5" /> follow global
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ) : null}
                <div
                  key={seg.id}
                  draggable={dragEnabled}
                  onDragStart={(e) => {
                    if (!dragEnabled) return;
                    setDraggedId(seg.id);
                    draggedIdRef.current = seg.id;
                    e.dataTransfer.effectAllowed = "move";
                    // Data required for some browsers to start a drag.
                    e.dataTransfer.setData("text/plain", seg.id);
                  }}
                  onDragEnd={() => {
                    setDraggedId(null);
                    draggedIdRef.current = null;
                    setDropTargetIdx(null);
                  }}
                  onDragOver={(e) => {
                    const id = draggedIdRef.current;
                    if (!id || id === seg.id) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setDropTargetIdx(idx);
                  }}
                  onDrop={(e) => {
                    const id = draggedIdRef.current;
                    if (!id) return;
                    e.preventDefault();
                    e.stopPropagation();
                    onMoveTo(id, idx);
                    setDraggedId(null);
                    draggedIdRef.current = null;
                    setDropTargetIdx(null);
                  }}
                  className={cn(
                    "group relative flex items-center gap-2.5 rounded-lg border p-2 transition-all duration-150 hover:-translate-y-px",
                    draggedId === seg.id && "opacity-40",
                    dropTargetIdx === idx && draggedId && draggedId !== seg.id && "ring-1 ring-violet-400/70",
                  )}
                  style={{
                    borderColor: dropTargetIdx === idx && draggedId ? "#8b5cf6" : "#27272a",
                    backgroundColor: draggedId === seg.id ? "#0f0f11" : "#18181b",
                    cursor: draggedId ? "grabbing" : undefined,
                  }}
                >
                  {/* Active-segment left accent (matches the timeline). */}
                  <span
                    className="absolute inset-y-0 left-0 w-[3px] rounded-l-lg"
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
                      className="relative mt-0.5 flex items-center gap-2 text-[9px]"
                      style={{ color: "#b1b1b8" }}
                      title={`Duration ${(seg.durationMs / 1000).toFixed(1)}s · Ken Burns ${seg.direction} — click the motion to customize`}
                    >
                      <span className="tabular-nums">
                        dur {(seg.durationMs / 1000).toFixed(1)}s
                      </span>
                      <span style={{ color: "#52525b" }}>·</span>
                      {/* v4.8: per-segment motion popover — click to pin this
                          segment's Ken Burns direction (or aim it on the
                          preview canvas). */}
                      {motionOpen && (
                        <div
                          className="fixed inset-0 z-20"
                          onClick={() => setOpenMotion(null)}
                          aria-hidden
                        />
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          setOpenMotion(motionOpen ? null : seg.id)
                        }
                        aria-expanded={motionOpen}
                        aria-label={`Motion for segment ${idx + 1}`}
                        className={cn(
                          "relative z-[21] flex items-center gap-1 rounded px-1.5 py-0.5 capitalize transition-all duration-150 hover:bg-white/5",
                          motionPinned && "font-semibold",
                        )}
                        style={{
                          color: motionPinned ? "#6ee7b7" : undefined,
                          backgroundColor: motionPinned
                            ? "rgba(6, 78, 59, 0.45)"
                            : undefined,
                        }}
                        title={
                          motionPinned
                            ? `Pinned: ${motionOverrides[seg.id]} — click to change or follow global`
                            : "Ken Burns motion — click to pin a custom direction"
                        }
                      >
                        {motionPinned && "✦ "}
                        {seg.direction}
                        <ChevronDown
                          className={cn(
                            "size-2.5 transition-transform duration-200",
                            motionOpen && "rotate-180",
                          )}
                          style={{ color: "currentColor" }}
                        />
                      </button>
                      {motionOpen && (
                        <div className="ff-pop absolute bottom-full left-0 z-[22] mb-1 w-44 rounded-lg border p-2 shadow-xl">
                          <p
                            className="mb-1.5 px-0.5 text-[9px] font-semibold uppercase tracking-wider"
                            style={{ color: "#71717a" }}
                          >
                            Motion · segment {idx + 1}
                          </p>
                          <div className="grid grid-cols-2 gap-1">
                            {MOTION_OPTIONS.map((m) => (
                              <button
                                key={m.value}
                                type="button"
                                onClick={() => {
                                  onSetMotion(seg.id, m.value);
                                  setOpenMotion(null);
                                }}
                                className={cn(
                                  "flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-[9px] font-medium transition-all duration-150",
                                  motionPinned &&
                                    motionOverrides[seg.id] === m.value
                                    ? "bg-emerald-500/25 ring-1 ring-emerald-400/50"
                                    : "hover:bg-white/5",
                                )}
                                style={{
                                  color:
                                    motionPinned &&
                                    motionOverrides[seg.id] === m.value
                                      ? "#6ee7b7"
                                      : "#a1a1aa",
                                }}
                                title={`${m.label} for this segment only`}
                              >
                                <span
                                  aria-hidden
                                  className="text-[11px] leading-none"
                                >
                                  {m.glyph}
                                </span>
                                {m.label}
                              </button>
                            ))}
                          </div>
                          <div
                            className="mt-1.5 flex items-center justify-between border-t pt-1.5"
                            style={{ borderColor: "#27272a" }}
                          >
                            <span className="text-[8px]" style={{ color: "#52525b" }}>
                              tip: aim on the canvas
                            </span>
                            {motionPinned && (
                              <button
                                type="button"
                                onClick={() => {
                                  onSetMotion(seg.id, null);
                                  setOpenMotion(null);
                                }}
                                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[8px] font-semibold transition-colors hover:bg-white/5"
                                style={{ color: "#6ee7b7" }}
                              >
                                <RotateCcw className="size-2.5" /> follow global
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Actions — v4.8: 28px hit targets (VLM: too small/thin). */}
                  <div className="flex shrink-0 flex-col items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onReorder(seg.id, -1)}
                      disabled={idx === 0 || !dragEnabled}
                      className="rounded-md p-1.5 transition-colors hover:bg-white/10 disabled:opacity-30"
                      style={{ color: "#8a8a93" }}
                      title={
                        dragEnabled
                          ? "Move up"
                          : "Order locked — sequenced by filename timestamps"
                      }
                    >
                      <ArrowUp className="size-3.5" />
                    </button>
                    <span
                      title={
                        dragEnabled
                          ? "Drag to reorder"
                          : "Order locked — beat/absolute timelines are sequenced by filename timestamps"
                      }
                      className="flex items-center"
                    >
                      <GripVertical
                        className="size-3"
                        style={{ color: dragEnabled ? "#3f3f46" : "#27272a" }}
                      />
                    </span>
                    <button
                      type="button"
                      onClick={() => onReorder(seg.id, 1)}
                      disabled={idx === segments.length - 1 || !dragEnabled}
                      className="rounded-md p-1.5 transition-colors hover:bg-white/10 disabled:opacity-30"
                      style={{ color: "#8a8a93" }}
                      title={
                        dragEnabled
                          ? "Move down"
                          : "Order locked — sequenced by filename timestamps"
                      }
                    >
                      <ArrowDown className="size-3.5" />
                    </button>
                  </div>
                  <div className="flex shrink-0 flex-col items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onDuplicate(seg.id)}
                      className="rounded-md p-1.5 opacity-40 transition-all hover:bg-violet-500/15 hover:opacity-100 group-hover:opacity-100"
                      style={{ color: "#c4b5fd" }}
                      title="Duplicate segment"
                    >
                      <Copy className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemove(seg.id)}
                      className="rounded-md p-1.5 opacity-40 transition-all hover:bg-red-500/15 hover:text-red-400 group-hover:opacity-100"
                      style={{ color: "#a1a1aa" }}
                      title="Remove"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>
                </div>
              );
            })}</>
            )}

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
                  <div className="text-[9px]" style={{ color: "#a1a1ab" }}>
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

            {/* Beat-sync card (v4.6) — cut on the pulse */}
            {audioTrack && (
              <div
                className="rounded-lg border p-2.5"
                style={{
                  borderColor: "rgba(6, 182, 212, 0.35)",
                  backgroundColor: "rgba(8, 51, 68, 0.18)",
                }}
              >
                <div className="flex items-center gap-2">
                  <div
                    className="flex size-6 shrink-0 items-center justify-center rounded-md"
                    style={{
                      backgroundColor: "rgba(6, 182, 212, 0.18)",
                      boxShadow: "0 0 10px rgba(34, 211, 238, 0.12)",
                    }}
                  >
                    <Activity className="size-3.5" style={{ color: "#67e8f9" }} />
                  </div>
                  <span className="text-[11px] font-semibold" style={{ color: "#a5f3fc" }}>
                    Beat sync
                  </span>
                  <span className="ml-auto text-[9px] tabular-nums" style={{ color: "#67e8f9" }}>
                    {beatBusy
                      ? "listening…"
                      : beatInfo && beatInfo.beatMs.length >= 2
                        ? `${beatInfo.bpm ?? "?"} BPM · ${beatInfo.beatMs.length} beats`
                        : "not detected"}
                  </span>
                </div>

                {mode !== "absolute" ? (
                  <>
                    {/* v4.7 strength dial — how often cuts land: every beat,
                        every 2nd, a bar, or two bars. Applies to Snap cuts. */}
                    {beatInfo && beatInfo.beatMs.length >= 2 && (
                      <div className="mt-2 flex items-center gap-1.5">
                        <span
                          className="text-[9px] font-medium"
                          style={{ color: "#67e8f9" }}
                          title="How frequently cuts land — a bar assumes 4/4 time"
                        >
                          Cut every
                        </span>
                        <div
                          className="flex flex-1 items-center rounded-md border p-0.5"
                          style={{
                            borderColor: "rgba(34, 211, 238, 0.25)",
                            backgroundColor: "rgba(9, 9, 11, 0.5)",
                          }}
                          role="radiogroup"
                          aria-label="Beat snap strength"
                        >
                          {[
                            { v: 1, label: "Beat", title: "Every beat — fastest cuts" },
                            { v: 2, label: "2", title: "Every 2nd beat — half-time" },
                            { v: 4, label: "Bar", title: "Every 4th beat — one bar (4/4)" },
                            { v: 8, label: "2 bars", title: "Every 8th beat — two bars (4/4)" },
                          ].map((opt) => {
                            const active = beatStride === opt.v;
                            return (
                              <button
                                key={opt.v}
                                type="button"
                                role="radio"
                                aria-checked={active}
                                title={opt.title}
                                onClick={() => onBeatStrideChange(opt.v)}
                                className={cn(
                                  "flex-1 rounded px-1 py-1 text-[9px] font-semibold tabular-nums transition-all",
                                  active
                                    ? "hover:brightness-110"
                                    : "text-zinc-500 hover:text-zinc-300",
                                )}
                                style={
                                  active
                                    ? {
                                        backgroundColor: "rgba(34, 211, 238, 0.2)",
                                        color: "#a5f3fc",
                                        boxShadow: "inset 0 0 0 1px rgba(34, 211, 238, 0.35)",
                                      }
                                    : undefined
                                }
                              >
                                {opt.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    <div className="mt-2 grid grid-cols-3 gap-1.5">
                    <button
                      type="button"
                      onClick={onDetectBeats}
                      disabled={beatBusy}
                      className={cn(
                        "flex items-center justify-center gap-1 rounded-md border px-1.5 py-1.5 text-[9px] font-semibold transition-all",
                        beatBusy
                          ? "cursor-wait opacity-60"
                          : "hover:-translate-y-px hover:brightness-125",
                      )}
                      style={{
                        borderColor: "rgba(34, 211, 238, 0.4)",
                        backgroundColor: "rgba(34, 211, 238, 0.1)",
                        color: "#a5f3fc",
                      }}
                      title="Analyze the audio for beats + tempo (runs locally, ~1s)"
                    >
                      <Activity className={cn("size-3", beatBusy && "animate-pulse")} />
                      {beatBusy ? "…" : "Detect beats"}
                    </button>
                    <button
                      type="button"
                      onClick={onSnapToBeats}
                      disabled={beatBusy || !beatInfo || beatInfo.beatMs.length < 2}
                      className={cn(
                        "flex items-center justify-center gap-1 rounded-md border px-1.5 py-1.5 text-[9px] font-semibold transition-all",
                        beatBusy || !beatInfo || beatInfo.beatMs.length < 2
                          ? "cursor-not-allowed opacity-40"
                          : "hover:-translate-y-px hover:brightness-125",
                      )}
                      style={{
                        borderColor: "rgba(34, 211, 238, 0.4)",
                        backgroundColor: "rgba(34, 211, 238, 0.1)",
                        color: "#a5f3fc",
                      }}
                      title="Retiming every cut to land exactly on a beat — undo with Ctrl+Z"
                    >
                      <Scissors className="size-3" /> Snap cuts
                    </button>
                    <button
                      type="button"
                      onClick={onFitToAudio}
                      disabled={beatBusy || !audioTrack.durationMs}
                      className={cn(
                        "flex items-center justify-center gap-1 rounded-md border px-1.5 py-1.5 text-[9px] font-semibold transition-all",
                        beatBusy || !audioTrack.durationMs
                          ? "cursor-not-allowed opacity-40"
                          : "hover:-translate-y-px hover:brightness-125",
                      )}
                      style={{
                        borderColor: "rgba(34, 211, 238, 0.4)",
                        backgroundColor: "rgba(34, 211, 238, 0.1)",
                        color: "#a5f3fc",
                      }}
                      title="Scale segment durations so the video ends with the music"
                    >
                      <Timer className="size-3" /> Fit audio
                    </button>
                    </div>
                  </>
                ) : (
                  <div
                    className="mt-2 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[9px]"
                    style={{ backgroundColor: "rgba(113, 113, 122, 0.15)", color: "#a1a1aa" }}
                    title="Timestamped filenames drive absolute timelines"
                  >
                    <Lock className="size-3 shrink-0" />
                    Beat snap needs sequence mode — filename timestamps rule here.
                  </div>
                )}
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
                  <div className="text-[9px]" style={{ color: "#a1a1ab" }}>
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
