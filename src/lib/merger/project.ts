// src/lib/merger/project.ts — .framefuse.json project save/load (v4.2)
//
// A project file is a single JSON document that restores the ENTIRE working
// session: media (images + audio, inlined as data URLs so the file is fully
// self-contained), subtitle cues with word timing, headline overlay items,
// all settings, and per-segment duration overrides.
//
// Format:
// {
//   "app": "framefuse",
//   "version": 4.2,
//   "savedAt": 1730000000000,
//   "images":   [{ "id": "f...", "name": "001__Beat_1_0s_x.jpg", "type": "image/jpeg", "dataUrl": "..." }],
//   "audio":    { "name": "voiceover.mp3", "type": "audio/mpeg", "dataUrl": "..." } | null,
//   "subtitles":{ "fileName": "...", "cues": [...] } | null,
//   "headlines":[ ... ],
//   "overrides":{ "f...": 4200 },
//   "settings": { "kenBurns", "video", "caption", "audio", "whisperLanguage" }
// }

import type {
  AudioSettings,
  CaptionSettings,
  HeadlineItem,
  KenBurnsConfig,
  KenBurnsDirection,
  TransitionSettings,
  VideoSettings,
  WatermarkSettings,
} from "./types";
import { serializeSrt, type SubtitleCue } from "./subtitles";

export const PROJECT_APP = "framefuse";
export const PROJECT_VERSION = 4.8;

/** Audio above this size (MB, decoded) is skipped to keep project files sane. */
export const MAX_AUDIO_MB = 25;

export interface ProjectImageEntry {
  id: string;
  name: string;
  type: string;
  dataUrl: string;
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
  images: { id: string; file: File }[];
  audio: File | null;
  subtitles: { fileName: string; cues: SubtitleCue[] } | null;
  headlines: HeadlineItem[];
  overrides: Record<string, number>;
  /** v4.8: per-segment Ken Burns direction overrides. */
  motionOverrides?: Record<string, KenBurnsDirection>;
  /** Watermark / logo overlay (v4.4). */
  watermark: { image: { id: string; file: File } | null; settings: WatermarkSettings } | null;
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
    images.push({
      id: img.id,
      name: img.file.name,
      type: img.file.type || "image/jpeg",
      dataUrl: await fileToDataUrl(img.file),
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
  /** Reconstructed File objects, in the saved order (ids preserved). */
  imageFiles: { id: string; file: File }[];
  audioFile: File | null;
  /** Watermark image File (v4.4) or null. */
  watermarkFile: { id: string; file: File } | null;
  /** Re-serialized SRT text (for the FFmpeg temp file). */
  srtText: string | null;
  audioSkipped: boolean;
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

/** Parse + validate a .framefuse.json file and rebuild its File objects. */
export async function parseProjectFile(file: File): Promise<LoadedProject> {
  let project: ProjectFile;
  try {
    project = JSON.parse(await file.text());
  } catch {
    throw new Error("Not a valid FrameFuse project file (JSON parse failed)");
  }
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

  const imageFiles: { id: string; file: File }[] = [];
  for (const img of project.images) {
    if (!img?.dataUrl || !img.name) continue;
    try {
      imageFiles.push({
        id: img.id || `p${imageFiles.length}`,
        file: await dataUrlToFile(img.dataUrl, img.name, img.type),
      });
    } catch {
      /* skip unreadable entry */
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
  };
}
