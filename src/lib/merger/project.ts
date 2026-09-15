// src/lib/merger/project.ts — .framefuse.json project save/load (v4.2 → v5.0)
//
// A project file is a single JSON document that restores the ENTIRE working
// session: media (images / videos / audio, inlined as data URLs so the file
// is fully self-contained), subtitle cues with word timing, headline overlay
// items, all settings, per-segment duration overrides and — since v5.0 — the
// multi-track edit map (itemEdits), SFX placements (sfxItems) and known
// video source durations (videoDurations). Videos above MAX_VIDEO_MB are
// not inlined (a metadata-only stub is kept so the loader can flag it via
// LoadedProject.videoSkipped).
//
// Format:
// {
//   "app": "framefuse",
//   "version": 5.0,
//   "savedAt": 1730000000000,
//   "images":   [{ "id": "f...", "name": "001__Beat_1_0s_x.jpg", "type": "image/jpeg", "dataUrl": "...", "mediaType": "image" | "video"? }],
//   "audio":    { "name": "voiceover.mp3", "type": "audio/mpeg", "dataUrl": "..." } | null,
//   "subtitles":{ "fileName": "...", "cues": [...] } | null,
//   "headlines":[ ... ],
//   "overrides":{ "f...": 4200 },
//   "motionOverrides": { "f...": "left" },
//   "itemEdits": { "f...": { "track": 1, "startMs": 500, ... } },        // v5.0
//   "sfxItems": [ { "id": "sfx_...", "sfxId": "whoosh", "startMs": 1200, "volume": 0.8 } ], // v5.0
//   "videoDurations": { "f...": 18340 },                                   // v5.0
//   "watermark": { ... } | null,
//   "settings": { "kenBurns", "video", "caption", "audio", "whisperLanguage", "transition" }
// }
//
// Loading is fully backward compatible: ≤4.9 files (no new fields) load
// unchanged — every v5 field is optional and sanitized on parse.

import type {
  AudioSettings,
  CaptionSettings,
  HeadlineItem,
  ItemEdit,
  KenBurnsConfig,
  KenBurnsDirection,
  MediaKind,
  OverlayPos,
  TransitionSettings,
  VideoSettings,
  WatermarkSettings,
} from "./types";
import { serializeSrt, type SubtitleCue } from "./subtitles";
import { getSfxDef, type SfxItem } from "./sfx";

export const PROJECT_APP = "framefuse";
export const PROJECT_VERSION = 5.0;

/** Audio above this size (MB, decoded) is skipped to keep project files sane. */
export const MAX_AUDIO_MB = 25;

/** v5.0: video entries above this size (MB) are skipped from inlining —
 *  video data URLs are ~1.37× the raw size, so 200MB keeps project files
 *  under ~280MB while still bundling typical short-form clips. */
export const MAX_VIDEO_MB = 200;

export interface ProjectImageEntry {
  id: string;
  name: string;
  type: string;
  dataUrl: string;
  /** v5.0: "video" entries are reconstructed as video media; absent (≤4.9
   *  files) means "image". An entry with an empty dataUrl + mediaType
   *  "video" is a too-big-to-inline stub (see MAX_VIDEO_MB). */
  mediaType?: MediaKind;
}

export interface ProjectAudioEntry {
  name: string;
  type: string;
  dataUrl: string;
}

export interface ProjectFile {
  app: string;
  version: number;
  savedAt: number;
  images: ProjectImageEntry[];
  audio: ProjectAudioEntry | null;
  subtitles: {
    fileName: string;
    cues: SubtitleCue[];
  } | null;
  headlines: HeadlineItem[];
  overrides: Record<string, number>;
  /** v4.8: per-segment Ken Burns direction overrides (id → direction).
   *  Optional for back-compat with ≤4.7 project files. */
  motionOverrides?: Record<string, KenBurnsDirection>;
  /** v5.0: per-item edit map (id → { startMs, durationMs, track, trimInMs,
   *  volume, chroma, overlay }) — multi-track timeline state. */
  itemEdits?: Record<string, ItemEdit>;
  /** v5.0: SFX placements on the master timeline (sanitized to known
   *  SFX_LIBRARY ids on load; invalid entries are dropped). */
  sfxItems?: SfxItem[];
  /** v5.0: known source durations for video items (id → ms). */
  videoDurations?: Record<string, number>;
  /** Watermark / logo overlay (v4.4): image + settings. */
  watermark: {
    image: ProjectImageEntry | null;
    settings: WatermarkSettings;
  } | null;
  settings: {
    kenBurns: KenBurnsConfig;
    video: VideoSettings;
    caption: CaptionSettings;
    audio: AudioSettings;
    whisperLanguage: string;
    /** Segment transitions (v4.3; optional for back-compat with 4.2 files). */
    transition?: TransitionSettings;
  };
}

export interface SaveProjectInput {
  /** v5.0: mediaType is optional per entry — the v4.9 call shape
   *  `images: [{ id, file }]` keeps compiling (defaults to "image"). */
  images: { id: string; file: File; mediaType?: MediaKind }[];
  audio: File | null;
  subtitles: { fileName: string; cues: SubtitleCue[] } | null;
  headlines: HeadlineItem[];
  overrides: Record<string, number>;
  /** v4.8: per-segment Ken Burns direction overrides. */
  motionOverrides?: Record<string, KenBurnsDirection>;
  /** Watermark / logo overlay (v4.4). */
  watermark: { image: { id: string; file: File } | null; settings: WatermarkSettings } | null;
  /** v5.0: multi-track timeline edits. */
  itemEdits?: Record<string, ItemEdit>;
  /** v5.0: SFX placements (rendered WAVs are re-synthesized on load —
   *  effects are procedural, only the placements persist). */
  sfxItems?: SfxItem[];
  /** v5.0: known video source durations (id → ms). */
  videoDurations?: Record<string, number>;
  settings: ProjectFile["settings"];
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/** Build the self-contained project document. */
export async function buildProjectFile(
  input: SaveProjectInput,
): Promise<ProjectFile> {
  const images: ProjectImageEntry[] = [];
  for (const img of input.images) {
    const isVideo = img.mediaType === "video";
    if (isVideo && img.file.size > MAX_VIDEO_MB * 1024 * 1024) {
      // v5.0: too big to inline — keep a metadata-only stub so the loader
      // can flag it (LoadedProject.videoSkipped) instead of silently losing
      // the item from the session inventory.
      images.push({
        id: img.id,
        name: img.file.name,
        type: img.file.type || "video/mp4",
        dataUrl: "",
        mediaType: "video",
      });
      continue;
    }
    images.push({
      id: img.id,
      name: img.file.name,
      type: img.file.type || (isVideo ? "video/mp4" : "image/jpeg"),
      dataUrl: await fileToDataUrl(img.file),
      ...(img.mediaType && img.mediaType !== "image"
        ? { mediaType: img.mediaType }
        : {}),
    });
  }

  let audio: ProjectAudioEntry | null = null;
  if (input.audio && input.audio.size <= MAX_AUDIO_MB * 1024 * 1024) {
    audio = {
      name: input.audio.name,
      type: input.audio.type || "audio/mpeg",
      dataUrl: await fileToDataUrl(input.audio),
    };
  }

  let watermark: ProjectFile["watermark"] = null;
  if (input.watermark) {
    const wmImg = input.watermark.image;
    watermark = {
      image: wmImg
        ? {
            id: wmImg.id,
            name: wmImg.file.name,
            type: wmImg.file.type || "image/png",
            dataUrl: await fileToDataUrl(wmImg.file),
          }
        : null,
      settings: input.watermark.settings,
    };
  }

  return {
    app: PROJECT_APP,
    version: PROJECT_VERSION,
    savedAt: Date.now(),
    images,
    audio,
    subtitles: input.subtitles
      ? {
          fileName: input.subtitles.fileName,
          cues: input.subtitles.cues,
        }
      : null,
    headlines: input.headlines,
    overrides: input.overrides,
    motionOverrides: sanitizeMotionOverrides(input.motionOverrides),
    itemEdits: sanitizeItemEdits(input.itemEdits),
    sfxItems: sanitizeSfxItems(input.sfxItems),
    videoDurations: sanitizeVideoDurations(input.videoDurations),
    watermark,
    settings: input.settings,
  };
}

/** Keep only entries that map to a real concrete direction (never "random",
 *  never "none" — those are meaningless as pinned overrides). */
function sanitizeMotionOverrides(
  mo: Record<string, KenBurnsDirection> | undefined | null,
): Record<string, KenBurnsDirection> | undefined {
  if (!mo || typeof mo !== "object") return undefined;
  const valid: KenBurnsDirection[] = ["in", "out", "left", "right", "up", "down"];
  const out: Record<string, KenBurnsDirection> = {};
  let any = false;
  for (const [id, dir] of Object.entries(mo)) {
    if (typeof dir === "string" && valid.includes(dir)) {
      out[id] = dir;
      any = true;
    }
  }
  return any ? out : undefined;
}

/**
 * v5.0: keep only well-typed ItemEdit fields per id (finite numbers, real
 * objects). chroma passes through RAW — chroma.ts owns sanitization at the
 * UI boundary. Returns undefined when nothing survives (field omitted).
 */
export function sanitizeItemEdits(
  edits: Record<string, ItemEdit> | undefined | null,
): Record<string, ItemEdit> | undefined {
  if (!edits || typeof edits !== "object") return undefined;
  const out: Record<string, ItemEdit> = {};
  let any = false;
  for (const [id, edit] of Object.entries(edits)) {
    if (!id || !edit || typeof edit !== "object") continue;
    const clean: ItemEdit = {};
    if (typeof edit.startMs === "number" && Number.isFinite(edit.startMs)) {
      clean.startMs = edit.startMs;
    }
    if (typeof edit.durationMs === "number" && Number.isFinite(edit.durationMs)) {
      clean.durationMs = edit.durationMs;
    }
    if (typeof edit.track === "number" && Number.isFinite(edit.track)) {
      clean.track = edit.track;
    }
    if (typeof edit.trimInMs === "number" && Number.isFinite(edit.trimInMs)) {
      clean.trimInMs = edit.trimInMs;
    }
    if (typeof edit.volume === "number" && Number.isFinite(edit.volume)) {
      clean.volume = edit.volume;
    }
    // v5.1: per-clip playback speed (0.25..4, finite; 1 is normalized away
    // so speed-1 edits never bloat project files or the export payload).
    if (
      typeof edit.speed === "number" &&
      Number.isFinite(edit.speed) &&
      edit.speed > 0 &&
      edit.speed !== 1
    ) {
      clean.speed = Math.min(4, Math.max(0.25, edit.speed));
    }
    if (edit.chroma && typeof edit.chroma === "object") {
      clean.chroma = edit.chroma;
    }
    // v5.2: loop the overlay source to span its full timeline window.
    if (edit.overlayLoop === true) {
      clean.overlayLoop = true;
    }
    if (
      edit.overlay &&
      typeof edit.overlay === "object" &&
      typeof edit.overlay.position === "string" &&
      typeof edit.overlay.scalePercent === "number" &&
      Number.isFinite(edit.overlay.scalePercent)
    ) {
      clean.overlay = {
        scalePercent: edit.overlay.scalePercent,
        position: edit.overlay.position as OverlayPos,
        // v5.2: free-form canvas placement (normalized 0..1 center).
        ...(typeof edit.overlay.x === "number" && Number.isFinite(edit.overlay.x)
          ? { x: Math.min(1, Math.max(0, edit.overlay.x)) }
          : {}),
        ...(typeof edit.overlay.y === "number" && Number.isFinite(edit.overlay.y)
          ? { y: Math.min(1, Math.max(0, edit.overlay.y)) }
          : {}),
      };
    }
    if (Object.keys(clean).length > 0) {
      out[id] = clean;
      any = true;
    }
  }
  return any ? out : undefined;
}

/**
 * v5.0: drop SFX placements that don't match the sfx.ts shapes — unknown
 * effect ids, missing/invalid ids, non-finite starts. Surviving items get
 * volume clamped to 0..1 (makeSfxItem's contract). Returns undefined when
 * nothing survives (field omitted).
 */
export function sanitizeSfxItems(
  items: SfxItem[] | undefined | null,
): SfxItem[] | undefined {
  if (!Array.isArray(items)) return undefined;
  const out: SfxItem[] = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    if (typeof it.id !== "string" || !it.id) continue;
    if (typeof it.sfxId !== "string" || !getSfxDef(it.sfxId)) continue;
    if (typeof it.startMs !== "number" || !Number.isFinite(it.startMs)) continue;
    const rawVol =
      typeof it.volume === "number" && Number.isFinite(it.volume) ? it.volume : 1;
    // v5.3: round-trip the custom duration (clamped to the sfx.ts contract).
    const rawDur =
      typeof it.durMs === "number" && Number.isFinite(it.durMs)
        ? Math.min(10000, Math.max(20, Math.round(it.durMs)))
        : undefined;
    out.push({
      id: it.id,
      sfxId: it.sfxId,
      startMs: it.startMs,
      volume: Math.min(1, Math.max(0, rawVol)),
      ...(rawDur != null ? { durMs: rawDur } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

/** v5.0: keep finite, positive source durations only. */
export function sanitizeVideoDurations(
  d: Record<string, number> | undefined | null,
): Record<string, number> | undefined {
  if (!d || typeof d !== "object") return undefined;
  const out: Record<string, number> = {};
  let any = false;
  for (const [id, ms] of Object.entries(d)) {
    if (!id) continue;
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) continue;
    out[id] = ms;
    any = true;
  }
  return any ? out : undefined;
}

/** Trigger a browser download of the project as `.framefuse.json`. */
export function downloadProjectFile(project: ProjectFile): string {
  const json = JSON.stringify(project);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date(project.savedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const name = `framefuse_${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(
    stamp.getDate(),
  )}_${pad(stamp.getHours())}${pad(stamp.getMinutes())}.framefuse.json`;
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return name;
}

export interface LoadedProject {
  project: ProjectFile;
  /** Reconstructed File objects, in the saved order (ids preserved).
   *  v5.0: entries carry the saved mediaType when it was "video". */
  imageFiles: { id: string; file: File; mediaType?: MediaKind }[];
  audioFile: File | null;
  /** Watermark image File (v4.4) or null. */
  watermarkFile: { id: string; file: File } | null;
  /** Re-serialized SRT text (for the FFmpeg temp file). */
  srtText: string | null;
  audioSkipped: boolean;
  /** v5.0: a video entry existed but produced no File — it was too large
   *  to inline at save time (stub, empty dataUrl) or its data failed to
   *  reconstruct. The UI should warn the user and re-link the source. */
  videoSkipped: boolean;
}

async function dataUrlToFile(
  dataUrl: string,
  name: string,
  type: string,
): Promise<File> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return new File([blob], name, { type: type || blob.type });
}

/** Parse + validate a .framefuse.json file and rebuild its File objects.
 *  v5.0: sanitizes the new fields (itemEdits / sfxItems / videoDurations)
 *  onto the returned project; ≤4.9 files without them load unchanged.
 *  v5.1: the body is shared with parseProjectDoc so the native open flow
 *  (electronAPI.openProject() → doc) feeds through the SAME validation. */
export async function parseProjectFile(file: File): Promise<LoadedProject> {
  let doc: unknown;
  try {
    doc = JSON.parse(await file.text());
  } catch {
    throw new Error("Not a valid FrameFuse project file (JSON parse failed)");
  }
  return parseProjectDoc(doc);
}

/** v5.1: validate + rehydrate an already-parsed project document (the
 *  parseProjectFile body minus the JSON step). Native saves hand the doc
 *  straight back through IPC — this is the single validation path for both. */
export async function parseProjectDoc(doc: unknown): Promise<LoadedProject> {
  const project = doc as ProjectFile;
  if (!project || project.app !== PROJECT_APP) {
    throw new Error("This file was not created by FrameFuse");
  }
  if (typeof project.version !== "number" || project.version > PROJECT_VERSION) {
    throw new Error(
      `Project was saved by a newer FrameFuse (v${project.version}) — please update`,
    );
  }
  if (!Array.isArray(project.images)) {
    project.images = [];
  }
  // v5.0: sanitize the new optional fields (idempotent; ≤4.9 files keep
  // them undefined). Mutating the parsed project means consumers always see
  // clean data.
  project.itemEdits = sanitizeItemEdits(project.itemEdits);
  project.sfxItems = sanitizeSfxItems(project.sfxItems);
  project.videoDurations = sanitizeVideoDurations(project.videoDurations);

  const imageFiles: { id: string; file: File; mediaType?: MediaKind }[] = [];
  let videoSkipped = false;
  for (const img of project.images) {
    const isVideo = img?.mediaType === "video";
    if (!img?.dataUrl || !img.name) {
      // Metadata-only stub = video skipped at save time (too big to inline).
      if (isVideo) videoSkipped = true;
      continue;
    }
    try {
      imageFiles.push({
        id: img.id || `p${imageFiles.length}`,
        file: await dataUrlToFile(img.dataUrl, img.name, img.type),
        ...(isVideo ? { mediaType: "video" as MediaKind } : {}),
      });
    } catch {
      // Unreadable entry — flag videos (v5.0), silently skip images (v4.9).
      if (isVideo) videoSkipped = true;
    }
  }
  if (imageFiles.length === 0) {
    throw new Error("Project contains no readable images");
  }

  let audioFile: File | null = null;
  if (project.audio?.dataUrl) {
    try {
      audioFile = await dataUrlToFile(
        project.audio.dataUrl,
        project.audio.name,
        project.audio.type,
      );
    } catch {
      audioFile = null;
    }
  }

  // Watermark image (v4.4).
  let watermarkFile: { id: string; file: File } | null = null;
  if (project.watermark?.image?.dataUrl) {
    try {
      watermarkFile = {
        id: project.watermark.image.id || "wm_project",
        file: await dataUrlToFile(
          project.watermark.image.dataUrl,
          project.watermark.image.name,
          project.watermark.image.type,
        ),
      };
    } catch {
      watermarkFile = null;
    }
  }

  const cues = project.subtitles?.cues;
  const validCues = Array.isArray(cues) && cues.length > 0;

  return {
    project,
    imageFiles,
    audioFile,
    watermarkFile,
    srtText: validCues ? serializeSrt(cues) : null,
    audioSkipped: !!project.audio && !audioFile,
    videoSkipped,
  };
}
