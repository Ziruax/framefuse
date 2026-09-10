"use client";

import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
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
  AudioLines,
  FileVideo,
  Layers,
  Play,
  SlidersHorizontal,
  Video,
  Volume2,
  VolumeX,
  Wand,
} from "lucide-react";
import { splitMiddle } from "@/lib/merger/text";
import type {
  MediaSegment,
  TimelineMode,
  AudioTrack,
  OverlapWarning,
  SubtitleFile,
  TransitionSettings,
  TransitionStyle,
  KenBurnsDirection,
  ItemEdit,
} from "@/lib/merger/types";
import { TRANSITION_STYLE_INFO, boundaryStyle } from "@/lib/merger/types";
import { fmtTimecode } from "@/lib/merger/timeline";
import {
  ChromaKeyer,
  defaultChromaKeySettings,
  detectKeyColor,
  hexToRgb,
  sanitizeChromaKeySettings,
  type ChromaKeySettings,
} from "@/lib/merger/chroma";
import {
  SFX_LIBRARY,
  getSfxDef,
  renderSfxBuffer,
  type SfxCategory,
  type SfxDef,
  type SfxItem,
} from "@/lib/merger/sfx";
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
  /** v5: per-item edits (track/volume/trimIn/chroma/overlay) keyed by item id. */
  itemEdits?: Record<string, ItemEdit>;
  /** v5: probed video durations (id → ms). Also acts as a video-kind hint
   *  for items whose segment hasn't been upgraded yet (prefer seg.mediaType). */
  videoDurations?: Record<string, number>;
  /** v5: patch one item's edit (partial merge at the parent). */
  onSetItemEdit?: (id: string, patch: Partial<ItemEdit>) => void;
  /** v5: SFX items currently on the timeline. */
  sfxItems?: SfxItem[];
  /** v5: add an SFX at the playhead (parent creates the item). */
  onAddSfx?: (sfxId: string) => void;
  /** v5: patch an SFX item (volume / startMs). */
  onUpdateSfx?: (id: string, patch: Partial<SfxItem>) => void;
  /** v5: remove an SFX item. */
  onRemoveSfx?: (id: string) => void;
  /** v5: playhead position for "add at playhead" timecode display. */
  currentMs?: number;
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
  itemEdits,
  videoDurations,
  onSetItemEdit,
  sfxItems,
  onAddSfx,
  onUpdateSfx,
  onRemoveSfx,
  currentMs,
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
  // v5.0: which clip's settings panel is open (single-open, list + grid),
  // generated video poster frames, and thumbnails that failed to load.
  const [openSettingsId, setOpenSettingsId] = useState<string | null>(null);
  const [videoPosters, setVideoPosters] = useState<Record<string, string>>({});
  const [brokenThumbs, setBrokenThumbs] = useState<Record<string, boolean>>({});
  const posterRequestedRef = useRef<Set<string>>(new Set());
  // v5 gates — every v5 affordance hides behind one of these so a parent that
  // passes only v4.9 props renders the exact v4.9 list/grid.
  const v5EditReady = onSetItemEdit != null && itemEdits != null;
  const v5MediaReady = v5EditReady || videoDurations != null;

  // v5: progressive video thumbnails — probe one frame per video AFTER the
  // list rendered (never blocking). Posters land in a module cache (read at
  // render so remounts pick them up without effects) + local state (drives
  // re-renders when a probe lands). Failed probes are never retried, so an
  // undecodable file can't loop — the row falls back to the icon tile.
  const requestVideoPoster = useCallback((seg: MediaSegment) => {
    if (typeof document === "undefined" || !seg.file) return;
    if (VIDEO_POSTER_CACHE.has(seg.id) || VIDEO_POSTER_PROBES.has(seg.id)) return;
    const file = seg.file;
    const probe = (async () => {
      const grab = await seekVideoTo(file, null);
      let dataUrl: string | null = null;
      try {
        if (grab) dataUrl = posterDataUrlFromVideo(grab.video);
      } catch {
        dataUrl = null;
      }
      if (dataUrl != null) {
        VIDEO_POSTER_CACHE.set(seg.id, dataUrl);
        setVideoPosters((p) => ({ ...p, [seg.id]: dataUrl as string }));
      }
      grab?.revoke();
    })();
    VIDEO_POSTER_PROBES.set(seg.id, probe);
    void probe.finally(() => {
      VIDEO_POSTER_PROBES.delete(seg.id);
    });
  }, []);

  useEffect(() => {
    for (const seg of segments) {
      if (!seg.file || !isVideoSegment(seg, videoDurations)) continue;
      if (VIDEO_POSTER_CACHE.has(seg.id) || VIDEO_POSTER_PROBES.has(seg.id)) continue;
      if (posterRequestedRef.current.has(seg.id)) continue;
      posterRequestedRef.current.add(seg.id);
      requestVideoPoster(seg);
    }
  }, [segments, videoDurations, requestVideoPoster]);

  const handleThumbError = useCallback(
    (seg: MediaSegment) => {
      setBrokenThumbs((b) => (b[seg.id] ? b : { ...b, [seg.id]: true }));
      if (isVideoSegment(seg, videoDurations)) requestVideoPoster(seg);
    },
    [videoDurations, requestVideoPoster],
  );

  // v4.1: drag-drop routes images, audio AND .srt files with feedback.
  // v4.2: also routes .framefuse.json project files.
  // v5: video files ride the same onAddFiles channel as images — but only
  // when the parent speaks the v5 media model (itemEdits / videoDurations),
  // so a v4.9 parent keeps its exact v4.9 drop routing.
  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    const all = Array.from(files);
    const projects = all.filter(isProjectFile);
    const images = all.filter((f) => f.type.startsWith("image/"));
    const videos = v5MediaReady
      ? all.filter((f) => isVideoFile(f) && !images.includes(f))
      : [];
    const audio = all.filter(
      (f) => f.type.startsWith("audio/") || /\.(mp3|wav|m4a|ogg|flac|aac|opus)$/i.test(f.name),
    );
    const srts = all.filter(
      (f) => f.type === "application/x-subrip" || /\.srt$/i.test(f.name),
    );
    if (projects.length) onLoadProjectFile(projects[projects.length - 1]);
    if (images.length || videos.length) onAddFiles([...images, ...videos]);
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
                {v5MediaReady
                  ? "Drop images or videos or click to browse"
                  : "Drop images or click to browse"}
              </p>
              <p className="mt-1 text-[11px]" style={{ color: "#71717a" }}>
                {v5MediaReady
                  ? "Images · videos · audio · .srt · projects"
                  : "Images · audio · .srt · .framefuse.json projects"}
              </p>
            </div>
            <button
              type="button"
              onClick={onLoadSamples}
              className="ff-btn-sample mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border py-2 text-[12px] font-medium transition-all duration-200"
            >
              <Sparkles className="size-3.5" /> Load sample storyboard (9 beats)
            </button>
            {onAddSfx != null && (
              <div className="mt-3">
                <SfxPalette
                  onAddSfx={onAddSfx}
                  sfxItems={sfxItems}
                  onUpdateSfx={onUpdateSfx}
                  onRemoveSfx={onRemoveSfx}
                  currentMs={currentMs}
                />
              </div>
            )}
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
              className="mb-2 flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed py-2.5 text-[11px] font-semibold transition-all duration-200 hover:border-violet-500/50 hover:bg-violet-500/5 hover:text-zinc-200 active:scale-[0.98]"
              style={{
                borderColor: dragOver ? "#7c3aed" : "#2e2e33",
                color: dragOver ? "#c4b5fd" : "#a8a8b0",
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
              {v5MediaReady ? "Add more media" : "Add more images"}
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
                  // v5: video presentation + per-item clip settings.
                  const isVideo = isVideoSegment(seg, videoDurations);
                  const sourceDurMs = isVideo
                    ? (videoDurations?.[seg.id] ?? seg.sourceDurationMs ?? null)
                    : null;
                  const settingsOpen = v5EditReady && openSettingsId === seg.id;
                  const poster = isVideo
                    ? (videoPosters[seg.id] ?? VIDEO_POSTER_CACHE.get(seg.id))
                    : undefined;
                  const thumbSrc = !isVideo
                    ? seg.thumbnailUrl
                    : (poster ?? (brokenThumbs[seg.id] ? undefined : seg.thumbnailUrl));
                  return (
                    <Fragment key={seg.id}>
                    <div
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
                        "group/tile relative aspect-square cursor-pointer overflow-hidden rounded-lg border outline-none transition-all duration-150 hover:-translate-y-0.5 active:scale-[0.96]",
                        "focus-visible:ring-2 focus-visible:ring-violet-400/80",
                        activeId === seg.id || settingsOpen
                          ? "border-violet-400/70 shadow-[0_0_0_1px_rgba(167,139,250,0.5),0_4px_16px_rgba(0,0,0,0.4)]"
                          : "border-[#27272a] hover:border-zinc-600",
                        dropTargetIdx === idx &&
                          draggedId &&
                          draggedId !== seg.id &&
                          "ring-1 ring-violet-400/70",
                      )}
                      style={{ backgroundColor: "#18181b" }}
                      title={`${seg.fileName}\n${fmtTimecode(seg.startMs)} – ${fmtTimecode(seg.endMs)} · motion ${seg.direction}${motionPinned ? " (custom)" : ""}${isVideo ? ` · video${sourceDurMs != null ? ` (source ${fmtTimecode(sourceDurMs)})` : ""}` : ""}\nclick to jump`}
                    >
                      {thumbSrc != null ? (
                        <img
                          src={thumbSrc}
                          alt={seg.fileName}
                          onError={isVideo ? () => handleThumbError(seg) : undefined}
                          className="pointer-events-none size-full object-cover transition-transform duration-200 group-hover/tile:scale-105"
                          draggable={false}
                        />
                      ) : (
                        <span
                          className="flex size-full items-center justify-center"
                          aria-hidden
                        >
                          <FileVideo className="size-6" style={{ color: "#52525b" }} />
                        </span>
                      )}
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
                        className={cn(
                          "pointer-events-none absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[8px] tabular-nums backdrop-blur-sm",
                          isVideo && "flex items-center gap-0.5",
                        )}
                        style={{ color: "#d4d4d8" }}
                      >
                        {isVideo && (
                          <FileVideo className="size-2" style={{ color: "#67e8f9" }} />
                        )}
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
                      <span
                        className={settingsOpen
                          ? "absolute right-1 top-1 flex gap-1 opacity-100 transition-opacity duration-150"
                          : "absolute right-1 top-1 flex gap-1 opacity-0 transition-opacity duration-150 group-hover/tile:opacity-100"}
                      >
                        {v5EditReady && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenSettingsId((cur) => (cur === seg.id ? null : seg.id));
                            }}
                            aria-expanded={settingsOpen}
                            aria-label={`Clip settings for segment ${idx + 1}`}
                            title="Clip settings — track, volume, trim & chroma key"
                            className="flex items-center justify-center rounded bg-black/70 p-1 backdrop-blur-sm transition-colors hover:bg-violet-500/40"
                            style={{ color: settingsOpen ? "#c4b5fd" : "#d4d4d8" }}
                          >
                            <SlidersHorizontal className="size-3" />
                          </button>
                        )}
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
                    {settingsOpen && onSetItemEdit != null && itemEdits != null && (
                      <div className="col-span-full my-1">
                        <ClipSettings
                          seg={seg}
                          edit={itemEdits[seg.id]}
                          onSetItemEdit={onSetItemEdit}
                          onClose={() => setOpenSettingsId(null)}
                          isVideo={isVideo}
                          sourceDurMs={sourceDurMs}
                        />
                      </div>
                    )}
                    </Fragment>
                  );
                })}
                {/* Add-more tile (grid mode) */}
                <button
                  type="button"
                  onClick={openImagePicker}
                  className="flex aspect-square items-center justify-center rounded-lg border border-dashed transition-all duration-150 hover:border-violet-500/50 hover:bg-violet-500/5"
                  style={{ borderColor: "#27272a", color: "#52525b" }}
                  title={v5MediaReady ? "Add more media" : "Add more images"}
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
              // v5: video presentation + per-item clip settings.
              const isVideo = isVideoSegment(seg, videoDurations);
              const sourceDurMs = isVideo
                ? (videoDurations?.[seg.id] ?? seg.sourceDurationMs ?? null)
                : null;
              const settingsOpen = v5EditReady && openSettingsId === seg.id;
              const poster = isVideo
                ? (videoPosters[seg.id] ?? VIDEO_POSTER_CACHE.get(seg.id))
                : undefined;
              const thumbSrc = !isVideo
                ? seg.thumbnailUrl
                : (poster ?? (brokenThumbs[seg.id] ? undefined : seg.thumbnailUrl));
              const rowTrack = v5EditReady
                ? (itemEdits?.[seg.id]?.track ?? seg.track)
                : 0;
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
                    {thumbSrc != null ? (
                      <img
                        src={thumbSrc}
                        alt={seg.fileName}
                        onError={isVideo ? () => handleThumbError(seg) : undefined}
                        className="size-full object-cover transition-transform duration-200 group-hover:scale-105"
                        draggable={false}
                      />
                    ) : (
                      <span
                        className="flex size-full items-center justify-center"
                        aria-hidden
                      >
                        <FileVideo className="size-4" style={{ color: "#52525b" }} />
                      </span>
                    )}
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
                      {/* v5: video kind chip + source duration + overlay lane. */}
                      {isVideo && (
                        <span
                          className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide"
                          style={{
                            borderColor: "#0e7490",
                            backgroundColor: "rgba(8, 51, 68, 0.5)",
                            color: "#67e8f9",
                          }}
                          title="Video clip"
                        >
                          <Video className="size-2.5" /> VIDEO
                        </span>
                      )}
                      {isVideo && sourceDurMs != null && (
                        <span
                          className="rounded border px-1.5 py-0.5 text-[9px] font-semibold tabular-nums"
                          style={{
                            borderColor: "rgba(14, 116, 144, 0.45)",
                            backgroundColor: "rgba(8, 51, 68, 0.35)",
                            color: "#a5f3fc",
                          }}
                          title={`Source duration — ${fmtTimecode(sourceDurMs)}`}
                        >
                          {fmtTimecode(sourceDurMs)}
                        </span>
                      )}
                      {v5EditReady && rowTrack >= 1 && (
                        <span
                          className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase"
                          style={{
                            borderColor: "rgba(139, 92, 246, 0.5)",
                            backgroundColor: "rgba(76, 29, 149, 0.4)",
                            color: "#c4b5fd",
                          }}
                          title="Overlay track — drag it on the timeline to position"
                        >
                          <Layers className="size-2.5" /> OVL
                        </span>
                      )}
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
                    {/* v4.9: middle-truncation — the head (timing metadata)
                        ellipsizes, the tail (unique suffix + extension)
                        always stays visible. End-truncation hid exactly the
                        differentiating half of storyboard filenames. */}
                    <div
                      className="mt-0.5 flex items-baseline text-[11px] font-medium"
                      style={{ color: "#d4d4d8" }}
                      title={seg.fileName}
                    >
                      {(() => {
                        const { head, tail } = splitMiddle(seg.fileName);
                        return tail ? (
                          <>
                            <span className="min-w-0 flex-1 truncate">
                              {head}
                            </span>
                            <span className="shrink-0 whitespace-nowrap">
                              {tail}
                            </span>
                          </>
                        ) : (
                          <span className="truncate">{seg.fileName}</span>
                        );
                      })()}
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
                    {v5EditReady && (
                      <button
                        type="button"
                        onClick={() =>
                          setOpenSettingsId((cur) => (cur === seg.id ? null : seg.id))
                        }
                        aria-expanded={settingsOpen}
                        aria-label={`Clip settings for segment ${idx + 1}`}
                        className={cn(
                          "rounded-md p-1.5 transition-all duration-150 hover:bg-violet-500/15",
                          settingsOpen
                            ? "bg-violet-500/25 opacity-100"
                            : "opacity-40 group-hover:opacity-100",
                        )}
                        style={{ color: settingsOpen ? "#c4b5fd" : "#a1a1aa" }}
                        title="Clip settings — track, volume, trim & chroma key"
                      >
                        <SlidersHorizontal className="size-3.5" />
                      </button>
                    )}
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
                {/* v5: inline clip-settings expander (list view). */}
                {settingsOpen && onSetItemEdit != null && itemEdits != null && (
                  <div className="mb-0.5 ml-6">
                    <ClipSettings
                      seg={seg}
                      edit={itemEdits[seg.id]}
                      onSetItemEdit={onSetItemEdit}
                      onClose={() => setOpenSettingsId(null)}
                      isVideo={isVideo}
                      sourceDurMs={sourceDurMs}
                    />
                  </div>
                )}
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

            {/* v5.0: synthesized SFX palette + placed effects (playhead adds). */}
            {onAddSfx != null && (
              <SfxPalette
                onAddSfx={onAddSfx}
                sfxItems={sfxItems}
                onUpdateSfx={onUpdateSfx}
                onRemoveSfx={onRemoveSfx}
                currentMs={currentMs}
              />
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

// ---------------------------------------------------------------------------
// v5.0 MEDIA HUB — video import, per-item chroma key, clip edits, SFX palette
//
// Everything below is additive and activated only through the new optional
// props; a parent passing only v4.9 props renders the exact v4.9 list/grid.
// All browser-only APIs (object URLs, <video>, AudioContext, WebGL) are
// guarded so nothing throws under SSR/Node, and every long-lived resource is
// a module singleton (AudioContext, ChromaKeyer, poster/buffer caches) or
// explicitly revoked (probe object URLs) — nothing is allocated per render.
// ---------------------------------------------------------------------------

const VIDEO_POSTER_W = 96;
const VIDEO_POSTER_H = 54;
/** id → poster dataURL (survives remounts; one entry per video). */
const VIDEO_POSTER_CACHE = new Map<string, string>();
/** id → in-flight poster probe (dedupes list + grid renders). */
const VIDEO_POSTER_PROBES = new Map<string, Promise<void>>();
const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|mkv|avi|ogv)$/i;

const SFX_CATEGORY_ORDER: SfxCategory[] = ["transition", "impact", "emphasis", "ui"];
const SFX_CATEGORY_LABELS: Record<SfxCategory, string> = {
  transition: "Transitions",
  impact: "Impacts",
  emphasis: "Emphasis",
  ui: "UI",
};

function isVideoFile(f: File): boolean {
  return f.type.startsWith("video/") || VIDEO_EXT_RE.test(f.name);
}

/** Video-kind resolution: v5 segments carry mediaType; a videoDurations entry
 *  doubles as the hint for parents that haven't upgraded MediaSegment yet. */
function isVideoSegment(
  seg: MediaSegment,
  videoDurations?: Record<string, number>,
): boolean {
  if (seg.mediaType === "video") return true;
  const hint = videoDurations?.[seg.id];
  return typeof hint === "number" && hint > 0;
}

/** A drawable media frame (video / image element) — narrow enough for both
 *  2D drawImage (CanvasImageSource) and the GL keyer (TexImageSource). */
type FrameSource = HTMLVideoElement | HTMLImageElement;

function fmtSec(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

/** Intrinsic dims of a TexImageSource (video / img / canvas duck-typing). */
function intrinsicDims(source: TexImageSource): { w: number; h: number } {
  const s = source as {
    videoWidth?: number;
    videoHeight?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    width?: number;
    height?: number;
  };
  if (typeof s.videoWidth === "number" && s.videoWidth > 0) {
    return { w: s.videoWidth, h: s.videoHeight ?? 0 };
  }
  if (typeof s.naturalWidth === "number" && s.naturalWidth > 0) {
    return { w: s.naturalWidth, h: s.naturalHeight ?? 0 };
  }
  if (typeof s.width === "number" && typeof s.height === "number" && s.width > 0) {
    return { w: s.width, h: s.height };
  }
  return { w: 0, h: 0 };
}

/** A seeked, ready-to-draw video element + the revoker for its object URL. */
interface VideoFrameGrab {
  video: HTMLVideoElement;
  /** Revokes the probe's object URL — call when done drawing. */
  revoke: () => void;
}

/**
 * Load a file into an offscreen <video>, wait for data, then seek.
 * `targetSec === null` seeks to the poster frame (min(1s, half the source)).
 * Resolves null (never rejects) when the file can't be decoded in time —
 * callers fall back to the generic icon tile.
 */
function seekVideoTo(file: File, targetSec: number | null): Promise<VideoFrameGrab | null> {
  if (
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return Promise.resolve(null);
  }
  return new Promise<VideoFrameGrab | null>((resolve) => {
    const video = document.createElement("video");
    let objectUrl: string | null = null;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimeout(timer);
      if (ok) {
        resolve({
          video,
          revoke: () => {
            if (objectUrl != null) {
              URL.revokeObjectURL(objectUrl);
              objectUrl = null;
            }
          },
        });
      } else {
        try {
          video.pause();
          video.removeAttribute("src");
          video.load();
        } catch {
          /* already dead */
        }
        if (objectUrl != null) URL.revokeObjectURL(objectUrl);
        resolve(null);
      }
    };
    const armTimeout = () => {
      if (timer != null) clearTimeout(timer);
      timer = setTimeout(() => settle(false), 8000);
    };
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.addEventListener("error", () => settle(false), { once: true });
    video.addEventListener(
      "loadeddata",
      () => {
        const durSec = Number.isFinite(video.duration) ? video.duration : 0;
        const t =
          targetSec == null
            ? Math.min(1, durSec > 0 ? durSec / 2 : 1)
            : Math.min(Math.max(0, targetSec), Math.max(0, durSec > 0 ? durSec - 0.05 : 0));
        if (video.readyState >= 2 && Math.abs(video.currentTime - t) < 0.05) {
          settle(true);
          return;
        }
        armTimeout();
        video.addEventListener("seeked", () => settle(true), { once: true });
        try {
          video.currentTime = t;
        } catch {
          settle(false);
        }
      },
      { once: true },
    );
    armTimeout();
    try {
      objectUrl = URL.createObjectURL(file);
      video.src = objectUrl;
    } catch {
      settle(false);
    }
  });
}

/** 96×54 cover-fit JPEG dataURL from a seeked video (poster thumbnails). */
function posterDataUrlFromVideo(video: HTMLVideoElement): string | null {
  if (typeof document === "undefined") return null;
  if (!video.videoWidth || !video.videoHeight) return null;
  const canvas = document.createElement("canvas");
  canvas.width = VIDEO_POSTER_W;
  canvas.height = VIDEO_POSTER_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const crop = ChromaKeyer.coverRect(
    video.videoWidth,
    video.videoHeight,
    0,
    0,
    VIDEO_POSTER_W,
    VIDEO_POSTER_H,
  );
  if (!(crop.sw > 0) || !(crop.sh > 0)) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, VIDEO_POSTER_W, VIDEO_POSTER_H);
  try {
    ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, VIDEO_POSTER_W, VIDEO_POSTER_H);
    return canvas.toDataURL("image/jpeg", 0.72);
  } catch {
    return null;
  }
}

/** Load an image URL into an <img> (naturalWidth > 0 on success). */
function loadImageElement(url: string): Promise<HTMLImageElement | null> {
  if (typeof document === "undefined" || !url) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img.naturalWidth > 0 ? img : null);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Draw a frame source onto a fresh small canvas (auto-detect snapshots). */
function drawSnapshot(
  source: FrameSource,
  width: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (typeof document === "undefined") return null;
  const dims = intrinsicDims(source);
  if (dims.w <= 0 || dims.h <= 0 || !(width > 0)) return null;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round((width * dims.h) / dims.w));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  try {
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }
  return { canvas, ctx };
}

/** Transparency checkerboard behind the keyed mini preview. */
function drawCheckerboard(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const cell = 6;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#18181b";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#27272a";
  for (let y = 0; y < h; y += cell) {
    for (let x = 0; x < w; x += cell) {
      if ((Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0) {
        ctx.fillRect(x, y, cell, cell);
      }
    }
  }
}

/** Normalize any hex chroma.ts accepts → 6-digit lowercase for <input color>. */
function toColorInputValue(hex: string | null | undefined): string {
  try {
    const { r, g, b } = hexToRgb(hex ?? "");
    const two = (v: number) => Math.round(v).toString(16).padStart(2, "0");
    return `#${two(r)}${two(g)}${two(b)}`;
  } catch {
    return defaultChromaKeySettings().color;
  }
}

/** One WebGL keyer for the whole panel lifetime (context-limit safe). */
let sharedChromaKeyer: ChromaKeyer | null = null;
function getSharedKeyer(): ChromaKeyer {
  if (sharedChromaKeyer == null) sharedChromaKeyer = new ChromaKeyer();
  return sharedChromaKeyer;
}

// --- SFX preview audio (module singletons — reused, never per render) -------

let sfxAudioCtx: AudioContext | null = null;

function getSfxAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (sfxAudioCtx == null) {
      const w = window as Window & { webkitAudioContext?: typeof AudioContext };
      const AC = window.AudioContext ?? w.webkitAudioContext;
      if (!AC) return null;
      sfxAudioCtx = new AC();
    }
    if (sfxAudioCtx.state === "suspended") {
      void sfxAudioCtx.resume().catch(() => {});
    }
    return sfxAudioCtx;
  } catch {
    return null;
  }
}

const sfxBufferCache = new Map<string, Promise<AudioBuffer | null>>();

function sfxBufferFor(sfxId: string): Promise<AudioBuffer | null> {
  const cached = sfxBufferCache.get(sfxId);
  if (cached) return cached;
  const p = renderSfxBuffer(sfxId);
  sfxBufferCache.set(sfxId, p);
  return p;
}

let sfxPreviewNode: AudioBufferSourceNode | null = null;

function stopSfxPreview(): void {
  const node = sfxPreviewNode;
  sfxPreviewNode = null;
  if (!node) return;
  try {
    node.stop();
  } catch {
    /* already ended */
  }
  try {
    node.disconnect();
  } catch {
    /* already disconnected */
  }
}

/** Instant chip preview: renders (cached) + plays once; stops any previous. */
function previewSfx(sfxId: string, onEnd?: () => void): void {
  const ctx = getSfxAudioContext();
  if (!ctx) {
    onEnd?.();
    return;
  }
  stopSfxPreview();
  sfxBufferFor(sfxId)
    .then((buf) => {
      if (!buf) {
        onEnd?.();
        return;
      }
      try {
        const node = ctx.createBufferSource();
        node.buffer = buf;
        node.connect(ctx.destination);
        node.onended = () => {
          if (sfxPreviewNode === node) sfxPreviewNode = null;
          try {
            node.disconnect();
          } catch {
            /* ignore */
          }
          onEnd?.();
        };
        node.start();
        sfxPreviewNode = node;
      } catch {
        onEnd?.();
      }
    })
    .catch(() => onEnd?.());
}

// ---------------------------------------------------------------------------
// Clip settings (per-item track / volume / trim / chroma key)
// ---------------------------------------------------------------------------

interface ClipSettingsProps {
  seg: MediaSegment;
  edit: ItemEdit | undefined;
  onSetItemEdit: (id: string, patch: Partial<ItemEdit>) => void;
  onClose: () => void;
  isVideo: boolean;
  sourceDurMs: number | null;
}

/** v5: the per-item "pro tool" expander — track, volume, trim, chroma key. */
function ClipSettings({
  seg,
  edit,
  onSetItemEdit,
  onClose,
  isVideo,
  sourceDurMs,
}: ClipSettingsProps) {
  const onOverlay = (edit?.track ?? 0) >= 1;
  // ItemEdit.volume is the frozen 0..2 ratio (6-a data model); the UI presents
  // it as 0–200%.
  const volumePct = Math.round(Math.min(2, Math.max(0, edit?.volume ?? 1)) * 100);
  const trimInMs = Math.max(0, Math.round(edit?.trimInMs ?? seg.trimInMs ?? 0));
  const maxTrimMs =
    isVideo && sourceDurMs != null && sourceDurMs > 0
      ? Math.max(0, Math.round(sourceDurMs - seg.durationMs))
      : 0;
  const trimVal = Math.min(trimInMs, maxTrimMs);

  return (
    <div
      id={`ff-clip-settings-${seg.id}`}
      role="group"
      aria-label={`Clip settings for ${seg.fileName}`}
      className="ff-pop rounded-lg border p-2.5 shadow-xl"
    >
      <div className="mb-2 flex items-center gap-1.5">
        <SlidersHorizontal className="size-3.5 shrink-0" style={{ color: "#c4b5fd" }} />
        <span
          className="shrink-0 text-[9px] font-bold uppercase tracking-[0.12em]"
          style={{ color: "#a1a1aa" }}
        >
          Clip settings
        </span>
        <span
          className="ml-1 min-w-0 flex-1 truncate text-[10px]"
          style={{ color: "#71717a" }}
          title={seg.fileName}
        >
          {seg.fileName}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close clip settings"
          className="shrink-0 rounded p-1 transition-colors hover:bg-white/10"
          style={{ color: "#71717a" }}
          title="Close"
        >
          <X className="size-3" />
        </button>
      </div>

      <div className="space-y-2.5">
        {/* Track switch */}
        <div>
          <p
            className="mb-1 flex items-center gap-1 text-[8px] font-semibold uppercase tracking-[0.12em]"
            style={{ color: "#71717a" }}
          >
            <Layers className="size-2.5" /> Track
          </p>
          <div
            className="flex rounded-md border p-0.5"
            role="radiogroup"
            aria-label={`Track for ${seg.fileName}`}
            style={{ borderColor: "#27272a", backgroundColor: "rgba(9, 9, 11, 0.5)" }}
          >
            {[0, 1].map((v) => {
              const active = onOverlay ? v === 1 : v === 0;
              return (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onSetItemEdit(seg.id, { track: v })}
                  title={
                    v === 0
                      ? "Base track — the main storyboard lane"
                      : "Overlay track — drawn on top of the base lane"
                  }
                  className={cn(
                    "flex-1 rounded px-1.5 py-1 text-[9px] font-semibold transition-all duration-150",
                    !active && "text-zinc-500 hover:text-zinc-300",
                  )}
                  style={
                    active
                      ? v === 1
                        ? {
                            backgroundColor: "rgba(139, 92, 246, 0.2)",
                            color: "#c4b5fd",
                            boxShadow: "inset 0 0 0 1px rgba(139, 92, 246, 0.4)",
                          }
                        : {
                            backgroundColor: "rgba(113, 113, 122, 0.2)",
                            color: "#e4e4e7",
                            boxShadow: "inset 0 0 0 1px rgba(113, 113, 122, 0.35)",
                          }
                      : undefined
                  }
                >
                  {v === 0 ? "Base" : "Overlay"}
                </button>
              );
            })}
          </div>
          {onOverlay && (
            <p className="mt-1 px-0.5 text-[9px]" style={{ color: "#71717a" }}>
              ⟶ Drag it on the timeline to position
            </p>
          )}
        </div>

        {/* Volume (video only) */}
        <div className={cn(!isVideo && "opacity-50")}>
          <div className="mb-1 flex items-center justify-between">
            <span
              className="flex items-center gap-1 text-[8px] font-semibold uppercase tracking-[0.12em]"
              style={{ color: "#71717a" }}
            >
              {volumePct === 0 ? (
                <VolumeX className="size-2.5" />
              ) : (
                <Volume2 className="size-2.5" />
              )}
              Volume
            </span>
            <span className="text-[9px] font-semibold tabular-nums" style={{ color: "#a1a1aa" }}>
              {volumePct}%
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={200}
            step={5}
            value={volumePct}
            disabled={!isVideo}
            onChange={(e) => onSetItemEdit(seg.id, { volume: Number(e.target.value) / 100 })}
            aria-label={`Clip volume for ${seg.fileName} (percent)`}
            className="w-full disabled:cursor-not-allowed"
          />
          {!isVideo && (
            <p className="mt-0.5 px-0.5 text-[9px]" style={{ color: "#52525b" }}>
              Video only — images have no audio.
            </p>
          )}
        </div>

        {/* Trim start (video only) */}
        <div className={cn(!isVideo && "opacity-50")}>
          <div className="mb-1 flex items-center justify-between">
            <span
              className="flex items-center gap-1 text-[8px] font-semibold uppercase tracking-[0.12em]"
              style={{ color: "#71717a" }}
            >
              <Scissors className="size-2.5" /> Trim start
            </span>
            <span className="text-[9px] font-semibold tabular-nums" style={{ color: "#a1a1aa" }}>
              {fmtSec(trimVal)}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={maxTrimMs > 0 ? maxTrimMs : 100}
            step={100}
            value={trimVal}
            disabled={!isVideo || maxTrimMs <= 0}
            onChange={(e) =>
              onSetItemEdit(seg.id, { trimInMs: Math.round(Number(e.target.value)) })
            }
            aria-label={`Trim start for ${seg.fileName} (seconds into the source)`}
            className="w-full disabled:cursor-not-allowed"
          />
          <p className="mt-0.5 px-0.5 text-[9px]" style={{ color: "#52525b" }}>
            {isVideo
              ? sourceDurMs != null
                ? `source ${fmtSec(sourceDurMs)} · window ${fmtSec(trimVal)} → ${fmtSec(trimVal + seg.durationMs)}`
                : "Source duration not probed yet — trim unavailable."
              : "Video only — images use the full frame."}
          </p>
        </div>

        <ChromaSection
          seg={seg}
          edit={edit}
          onSetItemEdit={onSetItemEdit}
          isVideo={isVideo}
          trimInMs={trimInMs}
          overlayOn={onOverlay}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chroma key controls (green screen)
// ---------------------------------------------------------------------------

interface ChromaSectionProps {
  seg: MediaSegment;
  edit: ItemEdit | undefined;
  onSetItemEdit: (id: string, patch: Partial<ItemEdit>) => void;
  isVideo: boolean;
  trimInMs: number;
  overlayOn: boolean;
}

function ChromaSection({ seg, edit, onSetItemEdit, isVideo, trimInMs, overlayOn }: ChromaSectionProps) {
  const enabled = edit?.chroma != null;
  const chroma = sanitizeChromaKeySettings(edit?.chroma);
  const [detected, setDetected] = useState<{ color: string; confidence: number } | null>(null);
  const [detectWarn, setDetectWarn] = useState(false);
  const [detectBusy, setDetectBusy] = useState(false);
  const [frameSource, setFrameSource] = useState<FrameSource | null>(null);

  // Frame source for auto-detect + the live preview. Videos probe the trim-in
  // point (quantized to 0.5s so dragging the trim slider doesn't re-seek on
  // every 100ms tick); images load their object URL. The probe's object URL
  // is revoked on cleanup — no leaks.
  const probeAtSec = Math.round(Math.max(0, trimInMs) / 500) / 2;
  useEffect(() => {
    if (!enabled || !overlayOn) return;
    let cancelled = false;
    let revoke: (() => void) | null = null;
    const load = async () => {
      let src: FrameSource | null = null;
      if (isVideo && seg.file) {
        const grab = await seekVideoTo(seg.file, probeAtSec);
        if (cancelled) {
          grab?.revoke();
          return;
        }
        if (grab) {
          revoke = grab.revoke;
          src = grab.video;
        }
      } else {
        const img = await loadImageElement(seg.thumbnailUrl);
        if (cancelled) return;
        src = img;
      }
      if (!cancelled) setFrameSource(src);
    };
    void load();
    return () => {
      cancelled = true;
      revoke?.();
    };
  }, [enabled, overlayOn, isVideo, seg.file, seg.thumbnailUrl, probeAtSec]);

  const toggleChroma = () => {
    if (enabled) {
      onSetItemEdit(seg.id, { chroma: undefined });
      setDetected(null);
      setDetectWarn(false);
    } else {
      onSetItemEdit(seg.id, { chroma: defaultChromaKeySettings() });
    }
  };

  const runAutoDetect = async () => {
    if (detectBusy) return;
    setDetectBusy(true);
    setDetectWarn(false);
    let grab: VideoFrameGrab | null = null;
    try {
      let source: FrameSource | null = frameSource;
      if (!source) {
        if (isVideo && seg.file) {
          grab = await seekVideoTo(seg.file, Math.max(0, trimInMs) / 1000);
          source = grab?.video ?? null;
        } else {
          source = await loadImageElement(seg.thumbnailUrl);
        }
      }
      const snap = source ? drawSnapshot(source, 160) : null;
      if (!snap) {
        setDetectWarn(true);
        return;
      }
      const det = detectKeyColor(
        snap.ctx.getImageData(0, 0, snap.canvas.width, snap.canvas.height),
      );
      if (det.confidence < 0.5) {
        setDetectWarn(true);
        return;
      }
      setDetected({ color: det.color, confidence: det.confidence });
      onSetItemEdit(seg.id, {
        chroma: { ...chroma, color: det.color.toUpperCase() },
      });
    } catch {
      setDetectWarn(true);
    } finally {
      grab?.revoke();
      setDetectBusy(false);
    }
  };

  const patchChroma = (patch: Partial<ChromaKeySettings>) => {
    onSetItemEdit(seg.id, { chroma: { ...chroma, ...patch } });
  };

  return (
    <div
      className="rounded-md border p-2"
      style={{ borderColor: "rgba(6, 78, 59, 0.35)", backgroundColor: "rgba(6, 78, 59, 0.08)" }}
    >
      <div className="flex items-center justify-between">
        <span
          className="flex items-center gap-1 text-[8px] font-semibold uppercase tracking-[0.12em]"
          style={{ color: "#6ee7b7" }}
        >
          <Wand className="size-2.5" /> Chroma key
        </span>
        {overlayOn ? (
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={`Chroma key for ${seg.fileName}`}
            onClick={toggleChroma}
            title={enabled ? "Disable chroma key" : "Enable chroma key (green screen removal)"}
            className="relative h-4 w-7 rounded-full transition-colors duration-150"
            style={{ backgroundColor: enabled ? "rgba(16, 185, 129, 0.55)" : "#3f3f46" }}
          >
            <span
              className={cn(
                "absolute top-[2px] size-3 rounded-full bg-white shadow-sm transition-all duration-150",
                enabled ? "left-[14px]" : "left-[2px]",
              )}
            />
          </button>
        ) : (
          <span className="text-[8px] font-medium" style={{ color: "#71717a" }}>
            overlay only
          </span>
        )}
      </div>

      {!overlayOn ? (
        <p className="mt-1.5 flex items-center gap-1 text-[9px]" style={{ color: "#71717a" }}>
          <Lock className="size-2.5 shrink-0" />
          Move to Overlay track to key.
        </p>
      ) : enabled ? (
        <div className="mt-2 space-y-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={runAutoDetect}
              disabled={detectBusy}
              className={cn(
                "flex items-center gap-1 rounded-md border px-1.5 py-1 text-[9px] font-semibold transition-all duration-150",
                detectBusy ? "cursor-wait opacity-60" : "hover:-translate-y-px hover:brightness-125",
              )}
              style={{
                borderColor: "rgba(16, 185, 129, 0.4)",
                backgroundColor: "rgba(16, 185, 129, 0.1)",
                color: "#6ee7b7",
              }}
              title="Sample the frame's edges to find the key color automatically"
            >
              <Wand className={cn("size-3", detectBusy && "animate-pulse")} />
              Auto-detect key
            </button>
            {detected != null && (
              <span
                className="flex min-w-0 items-center gap-1 text-[9px]"
                style={{ color: "#a1a1aa" }}
                title={`Detected key color ${detected.color.toUpperCase()} with ${Math.round(detected.confidence * 100)}% confidence`}
              >
                <span
                  className="size-2.5 shrink-0 rounded-[3px] border border-black/40"
                  style={{ backgroundColor: detected.color }}
                />
                <span className="truncate tabular-nums">
                  {detected.color.toUpperCase()} · {Math.round(detected.confidence * 100)}%
                </span>
              </span>
            )}
          </div>
          {detectWarn && (
            <p className="flex items-center gap-1 text-[9px]" style={{ color: "#a1a1aa" }}>
              <AlertTriangle className="size-2.5 shrink-0" style={{ color: "#d97706" }} />
              Couldn't find a clear key color — set it manually.
            </p>
          )}

          <div className="flex items-center gap-2">
            <label className="w-14 shrink-0 text-[10px] font-medium" style={{ color: "#d4d4d8" }}>
              Key color
            </label>
            <input
              type="color"
              value={toColorInputValue(chroma.color)}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const v = e.target.value;
                if (!/^#[0-9a-f]{6}$/i.test(v)) return;
                setDetected(null);
                setDetectWarn(false);
                patchChroma({ color: v.toUpperCase() });
              }}
              aria-label={`Key color for ${seg.fileName}`}
              title="Key color — the color removed by the keyer"
              className="size-6 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5"
              style={{ borderColor: "#3f3f46" }}
            />
            <span className="font-mono text-[9px] tabular-nums" style={{ color: "#a1a1aa" }}>
              {toColorInputValue(chroma.color).toUpperCase()}
            </span>
          </div>

          <SliderRow
            label="Similarity"
            value={chroma.similarity}
            min={0.01}
            max={0.5}
            step={0.01}
            onChange={(v) => patchChroma({ similarity: v })}
            format={(v) => v.toFixed(2)}
            ariaLabel={`Chroma similarity for ${seg.fileName}`}
            title="Chroma distance treated as the key — higher removes more"
          />
          <SliderRow
            label="Blend"
            value={chroma.blend}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => patchChroma({ blend: v })}
            format={(v) => v.toFixed(2)}
            ariaLabel={`Chroma blend for ${seg.fileName}`}
            title="Edge softness between keyed and kept pixels"
          />
          <div>
            <SliderRow
              label="Spill"
              value={chroma.spill}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => patchChroma({ spill: v })}
              format={(v) => v.toFixed(2)}
              ariaLabel={`Spill suppression for ${seg.fileName}`}
              title="Green fringe suppression on kept pixels"
            />
            <p className="mt-0.5 px-0.5 text-[9px]" style={{ color: "#71717a" }}>
              Removes green fringe (preview only — export approximates).
            </p>
          </div>

          <div
            className="flex items-center gap-2 border-t pt-1.5"
            style={{ borderColor: "rgba(6, 78, 59, 0.3)" }}
          >
            <ChromaMiniPreview source={frameSource} settings={chroma} />
            <p className="min-w-0 text-[9px]" style={{ color: "#71717a" }}>
              {frameSource ? "Live key preview — checkerboard = removed." : "Loading frame…"}
            </p>
          </div>
        </div>
      ) : (
        <p className="mt-1.5 px-0.5 text-[9px]" style={{ color: "#52525b" }}>
          Remove a solid background (green/blue screen). PNG frames key too.
        </p>
      )}
    </div>
  );
}

interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
  ariaLabel: string;
  title?: string;
}

/** Labeled slider + tabular value badge — the pro-panel row pattern. */
function SliderRow({ label, value, min, max, step, onChange, format, ariaLabel, title }: SliderRowProps) {
  return (
    <div className="flex items-center gap-2" title={title}>
      <span className="w-14 shrink-0 text-[10px] font-medium" style={{ color: "#d4d4d8" }}>
        {label}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={ariaLabel}
        className="min-w-0 flex-1"
      />
      <span
        className="w-8 shrink-0 text-right text-[9px] font-semibold tabular-nums"
        style={{ color: "#a1a1aa" }}
      >
        {format(value)}
      </span>
    </div>
  );
}

interface ChromaMiniPreviewProps {
  source: FrameSource | null;
  settings: ChromaKeySettings;
}

/** Tiny keyed-frame swatch strip over a checkerboard; silently falls back to
 *  the raw frame when WebGL is unavailable (ChromaKeyer.composite → false). */
function ChromaMiniPreview({ source, settings }: ChromaMiniPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawCheckerboard(ctx, canvas.width, canvas.height);
    if (!source) return;
    const dims = intrinsicDims(source);
    if (dims.w <= 0 || dims.h <= 0) return;
    const ok = getSharedKeyer().composite(ctx, source, settings, 0, 0, canvas.width, canvas.height, 1);
    if (!ok) {
      const crop = ChromaKeyer.coverRect(dims.w, dims.h, 0, 0, canvas.width, canvas.height);
      if (crop.sw > 0 && crop.sh > 0) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        try {
          ctx.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, canvas.width, canvas.height);
        } catch {
          /* undecodable — leave the checkerboard */
        }
      }
    }
  }, [source, settings.color, settings.similarity, settings.blend, settings.spill]);

  return (
    <canvas
      ref={canvasRef}
      width={96}
      height={54}
      role="img"
      aria-label="Chroma key live preview"
      className="h-[54px] w-[96px] shrink-0 rounded-md border"
      style={{ borderColor: "#3f3f46", backgroundColor: "#18181b" }}
    />
  );
}

// ---------------------------------------------------------------------------
// SFX palette (synthesized sound effects + placed items)
// ---------------------------------------------------------------------------

interface SfxPaletteProps {
  onAddSfx: (sfxId: string) => void;
  sfxItems?: SfxItem[];
  onUpdateSfx?: (id: string, patch: Partial<SfxItem>) => void;
  onRemoveSfx?: (id: string) => void;
  currentMs?: number;
}

/** v5: SOUND EFFECTS collapsible block — preview chips + placed SFX rows. */
function SfxPalette({ onAddSfx, sfxItems, onUpdateSfx, onRemoveSfx, currentMs }: SfxPaletteProps) {
  const [open, setOpen] = useState(true);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const playhead = fmtTimecode(currentMs ?? 0);

  const preview = (def: SfxDef) => {
    setPreviewId(def.id);
    previewSfx(def.id, () => setPreviewId((cur) => (cur === def.id ? null : cur)));
  };

  return (
    <div
      className="rounded-lg border p-2.5"
      style={{ borderColor: "rgba(6, 182, 212, 0.35)", backgroundColor: "rgba(8, 51, 68, 0.18)" }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] transition-colors hover:text-cyan-200"
        style={{ color: "#a5f3fc" }}
      >
        <AudioLines className="size-3.5 shrink-0" />
        Sound effects
        {sfxItems != null && sfxItems.length > 0 && (
          <span
            className="rounded-full px-1.5 py-0.5 text-[8px] font-bold"
            style={{ backgroundColor: "rgba(34, 211, 238, 0.2)", color: "#a5f3fc" }}
          >
            {sfxItems.length}
          </span>
        )}
        <span className="ml-auto" />
        <ChevronDown className={cn("size-3 transition-transform duration-200", open && "rotate-180")} />
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-[9px]" style={{ color: "#67e8f9" }}>
            Click a chip to preview it · <span className="font-semibold">+</span> places it at the
            playhead ({playhead})
          </p>

          {SFX_CATEGORY_ORDER.map((cat) => {
            const defs = SFX_LIBRARY.filter((d) => d.category === cat);
            if (defs.length === 0) return null;
            return (
              <div key={cat}>
                <p
                  className="mb-1 text-[8px] font-semibold uppercase tracking-wider"
                  style={{ color: "#71717a" }}
                >
                  {SFX_CATEGORY_LABELS[cat]}
                </p>
                <div className="grid grid-cols-2 gap-1">
                  {defs.map((def) => {
                    const playing = previewId === def.id;
                    return (
                      <div
                        key={def.id}
                        role="button"
                        tabIndex={0}
                        aria-label={`Preview ${def.label} sound effect`}
                        onClick={() => preview(def)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            preview(def);
                          }
                        }}
                        title={`${def.hint} (${def.defaultDurMs} ms)`}
                        className={cn(
                          "group/chip flex cursor-pointer select-none items-center gap-1 rounded-md border px-1.5 py-1 transition-all duration-150 hover:border-cyan-400/50 hover:bg-cyan-400/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 active:scale-[0.98]",
                          playing && "border-cyan-400/70 bg-cyan-400/15",
                        )}
                        style={{
                          borderColor: playing ? "rgba(34, 211, 238, 0.7)" : "rgba(34, 211, 238, 0.25)",
                          backgroundColor: playing ? "rgba(34, 211, 238, 0.12)" : "rgba(9, 9, 11, 0.45)",
                        }}
                      >
                        <span aria-hidden className={cn("text-[12px] leading-none", playing && "animate-pulse")}>
                          {def.emoji}
                        </span>
                        <span
                          className="min-w-0 flex-1 truncate text-[10px] font-medium"
                          style={{ color: "#d4d4d8" }}
                        >
                          {def.label}
                        </span>
                        <span className="shrink-0 text-[8px] tabular-nums" style={{ color: "#67e8f9" }}>
                          {def.defaultDurMs}ms
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onAddSfx(def.id);
                          }}
                          aria-label={`Add ${def.label} at playhead ${playhead}`}
                          title={`Add at playhead (${playhead})`}
                          className="flex size-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-cyan-400/25"
                          style={{ color: "#a5f3fc" }}
                        >
                          <Plus className="size-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {sfxItems != null && (
            <div className="border-t pt-1.5" style={{ borderColor: "rgba(34, 211, 238, 0.2)" }}>
              <p
                className="mb-1 text-[8px] font-semibold uppercase tracking-wider"
                style={{ color: "#71717a" }}
              >
                On timeline
              </p>
              {sfxItems.length === 0 ? (
                <p className="px-0.5 text-[9px]" style={{ color: "#71717a" }}>
                  No effects placed yet — hit <span className="font-semibold">+</span> on an effect
                  to drop it at the playhead.
                </p>
              ) : (
                <div className="space-y-1">
                  {sfxItems.map((item) => {
                    const def = getSfxDef(item.sfxId);
                    const volPct = Math.round(
                      Math.min(1, Math.max(0, typeof item.volume === "number" ? item.volume : 1)) * 100,
                    );
                    return (
                      <div
                        key={item.id}
                        className="flex items-center gap-1.5 rounded-md border px-1.5 py-1"
                        style={{
                          borderColor: "rgba(34, 211, 238, 0.2)",
                          backgroundColor: "rgba(9, 9, 11, 0.4)",
                        }}
                      >
                        <span aria-hidden className="shrink-0 text-[11px] leading-none">
                          {def?.emoji ?? "🎵"}
                        </span>
                        <span
                          className="w-14 shrink-0 truncate text-[9px] font-medium"
                          style={{ color: "#d4d4d8" }}
                          title={def?.label ?? item.sfxId}
                        >
                          {def?.label ?? "Unknown"}
                        </span>
                        <span
                          className="shrink-0 text-[9px] tabular-nums"
                          style={{ color: "#67e8f9" }}
                          title="Start time"
                        >
                          {fmtTimecode(item.startMs)}
                        </span>
                        {onUpdateSfx != null ? (
                          <input
                            type="range"
                            min={0}
                            max={100}
                            step={5}
                            value={volPct}
                            onChange={(e) => onUpdateSfx(item.id, { volume: Number(e.target.value) / 100 })}
                            aria-label={`Volume for ${def?.label ?? item.sfxId}`}
                            title="Playback volume"
                            className="mx-1 min-w-0 flex-1"
                          />
                        ) : (
                          <span className="flex-1" />
                        )}
                        {onUpdateSfx != null && (
                          <span
                            className="w-7 shrink-0 text-right text-[8px] tabular-nums"
                            style={{ color: "#a1a1aa" }}
                          >
                            {volPct}%
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            if (def) preview(def);
                          }}
                          aria-label={`Preview ${def?.label ?? "effect"}`}
                          title="Preview"
                          className="flex size-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-cyan-400/25"
                          style={{ color: "#67e8f9" }}
                        >
                          <Play className="size-3" />
                        </button>
                        {onRemoveSfx != null && (
                          <button
                            type="button"
                            onClick={() => onRemoveSfx(item.id)}
                            aria-label={`Remove ${def?.label ?? "effect"}`}
                            title="Remove"
                            className="flex size-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-red-500/25"
                            style={{ color: "#71717a" }}
                          >
                            <Trash2 className="size-3" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}


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
