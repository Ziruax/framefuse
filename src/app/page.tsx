"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { toast } from "@/lib/toast";
import { Header, type LastExport } from "@/components/Header";
import { MediaPanel } from "@/components/MediaPanel";
import { PreviewPanel } from "@/components/PreviewPanel";
import { TimelineRuler } from "@/components/TimelineRuler";
import { SettingsPanel } from "@/components/SettingsPanel";
import { Splitter, useResizableLayout } from "@/components/ResizableSplitters";
import {
  buildTimeline,
  fmtBytes,
  fmtTimecode,
  parseFilename,
  segmentAtTime,
  type TimelineEntry,
} from "@/lib/merger/timeline";
import { makeSfxItem, renderSfxBuffer, type SfxItem } from "@/lib/merger/sfx";
import { exportNative, isElectron } from "@/lib/merger/native";
import { parseSrt, serializeSrt, serializeVtt, serializeVttWords } from "@/lib/merger/subtitles";
import {
  detectBeats as detectBeatsInAudio,
  planBeatSnap,
  planFitToAudio,
  type BeatInfo,
} from "@/lib/merger/beatDetect";
import {
  transcribeWithWhisper,
  isWhisperAvailable,
  type WhisperProgress,
} from "@/lib/merger/whisper";
import {
  defaultAudioSettings,
  defaultCaptionSettings,
  defaultKenBurnsConfig,
  defaultTransitionSettings,
  defaultWatermarkSettings,
  makeHeadlineItem,
  type AudioSettings,
  type AudioTrack,
  type CaptionSettings,
  type ExportProgress,
  type HeadlineItem,
  type ItemEdit,
  type KenBurnsConfig,
  type KenBurnsDirection,
  type MediaSegment,
  type OverlayTransform,
  type SubtitleFile,
  type TransitionSettings,
  type TransitionStyle,
  type VideoSettings,
  type WatermarkSettings,
} from "@/lib/merger/types";
import { getCaptionPreset, getFontOption, CAPTION_PRESETS } from "@/lib/merger/captionPresets";
import { closestAspectForRatio } from "@/lib/merger/renderer";
import { middleEllipsis } from "@/lib/merger/text";
import {
  buildProjectFile,
  downloadProjectFile,
  parseProjectFile,
  parseProjectDoc,
  type ProjectFile,
} from "@/lib/merger/project";
import { decodeAudioPeaks, type WaveformData } from "@/lib/merger/waveform";

interface MediaItem {
  id: string;
  file: File;
  url: string;
  /** v5.0: source media kind — videos join the media list (never audio) and
   *  become multi-track timeline items with probed durations. */
  mediaType: "image" | "video";
}

/** v5.0: is this imported file a VIDEO? (type prefix or extension — import
 *  routing: videos join the MEDIA list, everything else routes as in v4.9.) */
function isVideoFile(f: File): boolean {
  return (
    (f.type && f.type.startsWith("video/")) ||
    /\.(mp4|webm|mov|mkv|m4v|avi)$/i.test(f.name)
  );
}

/** v5.0: overlay-lane items without an explicit geometry render centered at
 *  60% output width. page.tsx writes this same default into the item's edit
 *  whenever it moves to the overlay track, so buildTimeline resolves a real
 *  OverlayTransform and the FFmpeg overlay composite (which skips null
 *  transforms) stays in lockstep with the preview. */
const DEFAULT_OVERLAY_TRANSFORM: OverlayTransform = {
  scalePercent: 60,
  position: "center",
};

let _idCounter = 0;
function genId(): string {
  _idCounter += 1;
  return `f${Date.now().toString(36)}_${_idCounter.toString(36)}`;
}

// ---- Settings persistence (production-ready: survive restarts) ----------
// v5.0: versioned settings key. The payload is wrapped as { v: 50, data } so
// future schema changes can branch on version instead of growing a flat
// blob. Legacy keys (v49 wrapped, v41 flat) are read as a fallback chain and
// removed on the first successful v50 write (one-shot migration). Only
// lightweight UI state is persisted — multi-track edits (itemEdits), SFX
// placements and video durations belong to PROJECT FILES, not localStorage.
const LS_KEY = "framefuse.settings.v50";
const LS_LEGACY_KEYS = ["framefuse.settings.v49", "framefuse.settings.v41"];
const LS_VERSION = 50;

interface PersistedSettings {
  kenBurns: KenBurnsConfig;
  settings: VideoSettings;
  captionSettings: CaptionSettings;
  audio: AudioSettings;
  whisperLanguage: string;
  /** Headline overlay items (persisted so hook titles survive reloads). v4.2 */
  headlines?: HeadlineItem[];
  /** Segment transitions (v4.3). */
  transition?: TransitionSettings;
  /** Watermark settings (v4.4). The image itself lives in project files. */
  watermark?: WatermarkSettings;
  /** v4.7: beat-snap strength (boundaries land on every Nth beat). */
  beatStride?: number;
  /** v4.7: starred caption preset ids. */
  favoritePresets?: string[];
  /** v4.8: media library view mode ("list" | "grid") — app-level pref. */
  mediaView?: "list" | "grid";
}

function loadPersisted(): Partial<PersistedSettings> {
  try {
    // v50 first; fall back to the legacy v49 (wrapped) and v41 (flat) keys.
    let raw: string | null = null;
    for (const key of [LS_KEY, ...LS_LEGACY_KEYS]) {
      raw = localStorage.getItem(key);
      if (raw) break;
    }
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    // Wrapped ({ v, data }) vs legacy (flat object) shapes — any wrapped
    // version unwraps to its data; flat v41 blobs are the settings object.
    const data =
      parsed && typeof parsed.data === "object" && typeof parsed.v === "number"
        ? parsed.data
        : parsed;
    return data as Partial<PersistedSettings>;
  } catch {
    return {};
  }
}

export default function Page() {
  // ---- Source data --------------------------------------------------------
  const [items, setItems] = useState<MediaItem[]>([]);
  const [audioTrack, setAudioTrack] = useState<AudioTrack | null>(null);
  const [subtitles, setSubtitles] = useState<SubtitleFile | null>(null);
  const [overrides, setOverrides] = useState<Record<string, number>>({});

  // ---- Audio playback (synced with preview) -------------------------------
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // ---- Settings -----------------------------------------------------------
  // v4.2 hydration fix: persisted (localStorage) values are applied in a
  // mount effect instead of the state initializers. Reading localStorage
  // during the first render made the client HTML differ from the prerendered
  // server HTML (React #418) whenever settings had been saved on a previous
  // run. Defaults render first (matching the static export), then the saved
  // settings swap in one frame later.
  const [kenBurns, setKenBurns] = useState<KenBurnsConfig>(
    defaultKenBurnsConfig(),
  );
  const [settings, setSettings] = useState<VideoSettings>({
    aspect: "16:9",
    resolution: "1080p",
    bitrateMbps: 8,
    fps: 30,
    // v4.5 encode-quality profile — "social" = the v4.4 defaults exactly.
    quality: "social",
    crf: 20,
  });
  const [captionSettings, setCaptionSettings] = useState<CaptionSettings>(
    defaultCaptionSettings(),
  );
  const [audioSettings, setAudioSettings] = useState<AudioSettings>(
    defaultAudioSettings(),
  );

  // ---- Headline overlay track (v4.2) — viral hook titles ----------------
  const [headlineItems, setHeadlineItems] = useState<HeadlineItem[]>([]);

  // ---- Segment transitions (v4.3) -----------------------------------------
  const [transitionSettings, setTransitionSettings] =
    useState<TransitionSettings>(defaultTransitionSettings());

  // ---- Watermark / logo overlay (v4.4) ------------------------------------
  const [watermarkImage, setWatermarkImage] = useState<MediaItem | null>(null);
  const [watermarkSettings, setWatermarkSettings] =
    useState<WatermarkSettings>(defaultWatermarkSettings());
  /** Loaded element for the canvas preview (natural size for geometry). */
  const [watermarkImgEl, setWatermarkImgEl] = useState<HTMLImageElement | null>(
    null,
  );
  const watermarkInputRef = useRef<HTMLInputElement>(null);
  const openWatermarkPicker = useCallback(
    () => watermarkInputRef.current?.click(),
    [],
  );

  // Whisper language: "auto" = auto-detect, or a 2-letter code like "en".
  const [whisperLanguage, setWhisperLanguage] = useState<string>("auto");

  // v4.7: beat-snap strength — boundaries land on every Nth beat (1/2/4/8).
  // Declared above the restore effect (it references the setter).
  const [beatStride, setBeatStride] = useState<1 | 2 | 4 | 8>(1);
  // v4.7: starred caption presets (app-level preference, not project data).
  const [favoritePresets, setFavoritePresets] = useState<string[]>([]);
  // v4.8: per-segment Ken Burns direction overrides (id → direction).
  // Project-level data (saved into .framefuse.json), undo-able.
  const [motionOverrides, setMotionOverrides] = useState<
    Record<string, KenBurnsDirection>
  >({});
  // v4.8: media library view mode (app-level pref, persisted).
  const [mediaView, setMediaView] = useState<"list" | "grid">("list");

  // ---- v5.0 MULTI-TRACK STATE ----------------------------------------------
  /** Per-item user edits (patch-merged; undefined values DELETE keys, so a
   *  `{ chroma: undefined }` patch disables the keyer). Feeds buildTimeline
   *  → resolved seg.track/volume/trimInMs/chroma/overlay/startMs/durationMs. */
  const [itemEdits, setItemEdits] = useState<Record<string, ItemEdit>>({});
  /** Probed video source durations (id → ms) — drives video default clip
   *  lengths + the timeline trim clamps + project round-trips. */
  const [videoDurations, setVideoDurations] = useState<Record<string, number>>({});
  /** Probed video source dims (id → {w,h}) — recorded for the export
   *  payload (native.ts computes image dims itself; video dims are probed by
   *  the main process, so this map is a page-level record / undecodable flag). */
  const [videoDims, setVideoDims] = useState<Record<string, { w: number; h: number }>>({});
  /** v5.2: one-shot gate for the auto aspect-match on the first imported
   *  video (see probeVideoItem). Reset on "New project", armed-off when a
   *  saved project loads (its aspect is an explicit user choice). */
  const autoAspectRef = useRef(false);
  /** Probed video poster thumbnails (id → 96×54 JPEG dataURL) — used as
   *  segment thumbnailUrl so the media list, filmstrips and overlays show a
   *  real frame instead of a broken image. */
  const [videoThumbnails, setVideoThumbnails] = useState<Record<string, string>>({});
  /** SFX placements on the master timeline (preview-scheduled + exported). */
  const [sfxItems, setSfxItems] = useState<SfxItem[]>([]);

  // Restore persisted settings AFTER mount (client-only, hydration-safe).
  // Reading localStorage in the state initializers made the first client
  // render differ from the prerendered HTML (React #418) whenever settings
  // were saved on a previous run. Defaults render first, then the saved
  // settings swap in one frame later — the intentional one-shot sync with
  // the localStorage "external system".
   
  useEffect(() => {
    const p = loadPersisted();
    if (p.kenBurns) setKenBurns(p.kenBurns);
     
    if (p.settings) setSettings(p.settings);
     
    if (p.captionSettings) setCaptionSettings(p.captionSettings);
     
    if (p.audio) setAudioSettings(p.audio);
    if (p.transition) setTransitionSettings(p.transition);
    if (p.watermark) setWatermarkSettings(p.watermark);
    if (Array.isArray(p.headlines)) {
       
      setHeadlineItems(
        p.headlines.filter((h) => h && h.text && h.endMs > h.startMs),
      );
    }
     
    if (p.whisperLanguage && p.whisperLanguage !== "auto") {
      setWhisperLanguage(p.whisperLanguage);
    }
    // v4.7 prefs: beat-snap strength + starred presets.
    if (p.beatStride === 1 || p.beatStride === 2 || p.beatStride === 4 || p.beatStride === 8) {
      setBeatStride(p.beatStride);
    }
    if (Array.isArray(p.favoritePresets)) {
      setFavoritePresets(
        p.favoritePresets.filter((id) => typeof id === "string"),
      );
    }
    // v4.8: media library layout preference.
    if (p.mediaView === "grid" || p.mediaView === "list") {
      setMediaView(p.mediaView);
    }
  }, []);

  // ---- Playback -----------------------------------------------------------
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const currentMsRef = useRef(0);

  // ---- Export -------------------------------------------------------------
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(
    null,
  );
  const [lastExport, setLastExport] = useState<LastExport | null>(null);
  const [inElectron, setInElectron] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // ---- v5.1: native project file identity (null = unsaved session) --------
  const [currentProjectPath, setCurrentProjectPath] = useState<string | null>(null);
  const [currentProjectName, setCurrentProjectName] = useState<string | null>(null);

  // ---- File pickers (page-level so the app menu can trigger them) ---------
  const imageInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const subtitleInputRef = useRef<HTMLInputElement>(null);
  const openImagePicker = useCallback(() => imageInputRef.current?.click(), []);
  const openAudioPicker = useCallback(() => audioInputRef.current?.click(), []);
  const openSubtitlePicker = useCallback(
    () => subtitleInputRef.current?.click(),
    [],
  );

  // ---- Loaded HTMLImageElements for canvas drawing ------------------------
  const imagesRef = useRef<Record<string, HTMLImageElement>>({});
  const [images, setImages] = useState<Record<string, HTMLImageElement>>({});

  // ---- Derived timeline ---------------------------------------------------
  const { entries, skippedUnparseable } = useMemo(() => {
    const ents: TimelineEntry[] = [];
    const skipped: string[] = [];
    items.forEach((it, order) => {
      const parsed = parseFilename(it.file.name);
      if (!parsed) {
        if (it.mediaType === "video") {
          // v5.0: videos don't need filename timing — an unparseable name
          // becomes a duration-kind entry whose length defaults to the
          // probed source duration (5000ms until the probe lands).
          ents.push({
            id: it.id,
            fileName: it.file.name,
            file: it.file,
            parsed: {
              kind: "duration",
              startMs: null,
              endMs: null,
              durationMs: null,
              raw: it.file.name,
            },
            order,
            thumbnailUrl: videoThumbnails[it.id] ?? it.url,
            mediaType: "video",
          });
        } else {
          skipped.push(it.file.name);
        }
        return;
      }
      ents.push({
        id: it.id,
        fileName: it.file.name,
        file: it.file,
        parsed,
        order,
        thumbnailUrl:
          it.mediaType === "video"
            ? videoThumbnails[it.id] ?? it.url
            : it.url,
        mediaType: it.mediaType,
      });
    });
    return { entries: ents, skippedUnparseable: skipped };
  }, [items, videoThumbnails]);

  const timeline = useMemo(
    () =>
      buildTimeline(
        entries,
        overrides,
        kenBurns,
        motionOverrides,
        itemEdits,
        videoDurations,
      ),
    [entries, overrides, kenBurns, motionOverrides, itemEdits, videoDurations],
  );

  const activeSegment = useMemo(
    () =>
      timeline.segments.length
        ? segmentAtTime(timeline.segments, currentMs)
        : null,
    [timeline.segments, currentMs],
  );

  /** v5.2: "Match source aspect" — the active video wins, else the first
   *  video with probed dims. Enabled only when its closest aspect differs
   *  from the current output aspect (button otherwise pointless). */
  const matchAspectTarget = useMemo(() => {
    const cand =
      activeSegment?.mediaType === "video" && videoDims[activeSegment.id]
        ? activeSegment
        : timeline.segments.find(
            (s) => s.mediaType === "video" && videoDims[s.id],
          ) ?? null;
    return cand && videoDims[cand.id] ? { seg: cand, dims: videoDims[cand.id] } : null;
  }, [activeSegment, timeline.segments, videoDims]);

  const canMatchAspect =
    matchAspectTarget != null &&
    closestAspectForRatio(matchAspectTarget.dims.w / matchAspectTarget.dims.h) !==
      settings.aspect;

  const handleMatchAspect = useCallback(() => {
    if (!matchAspectTarget) return;
    const { seg, dims } = matchAspectTarget;
    const next = closestAspectForRatio(dims.w / dims.h);
    if (next === settings.aspect) return;
    setSettings((prev) => ({ ...prev, aspect: next, aspectTouched: true }));
    toast.success(`Aspect set to ${next} — matches "${middleEllipsis(seg.fileName, 32)}"`, {
      description: `${dims.w}×${dims.h} source frame.`,
    });
  }, [matchAspectTarget, settings.aspect]);

  /** v5.1: number of base-lane boundaries (drives the Random-mix button). */
  const boundaryCount = useMemo(() => {
    const baseSegs = timeline.segments.filter((s) => s.track === 0);
    return baseSegs.length > 1 ? baseSegs.length - 1 : 0;
  }, [timeline.segments]);

  /** v5.0: object URLs for VIDEO media items (id → url) — PreviewPanel's
   *  paint sources and the export's video bytes channel. */
  const videoUrls = useMemo(() => {
    const map: Record<string, string> = {};
    for (const it of items) {
      if (it.mediaType === "video") map[it.id] = it.url;
    }
    return map;
  }, [items]);

  // ---- Undo / Redo (v4.3) — snapshot history of the editable session ------
  // Object URLs are NEVER revoked mid-session (only on unmount) so a removed
  // segment can always be restored byte-perfect by Ctrl+Z.
  interface HistorySnapshot {
    items: MediaItem[];
    overrides: Record<string, number>;
    motionOverrides: Record<string, KenBurnsDirection>;
    subtitles: SubtitleFile | null;
    headlineItems: HeadlineItem[];
    captionSettings: CaptionSettings;
    kenBurns: KenBurnsConfig;
    settings: VideoSettings;
    audioSettings: AudioSettings;
    audioTrack: AudioTrack | null;
    whisperLanguage: string;
    transition: TransitionSettings;
    watermarkImage: MediaItem | null;
    watermarkSettings: WatermarkSettings;
    /** v5.0: multi-track edits + SFX placements + probed video durations. */
    itemEdits: Record<string, ItemEdit>;
    sfxItems: SfxItem[];
    videoDurations: Record<string, number>;
  }

  const HISTORY_MAX = 80;
  const historyRef = useRef<{
    stack: HistorySnapshot[];
    idx: number;
    baseline: boolean;
    /** A push is requested and waiting for its debounce window. */
    pending: boolean;
    /** Timestamp of the last action — pushes wait for the burst to settle. */
    lastRequest: number;
  }>({ stack: [], idx: -1, baseline: false, pending: false, lastRequest: 0 });
  const [historyState, setHistoryState] = useState({
    canUndo: false,
    canRedo: false,
  });

  // Mirror of all snapshot-able state (synced after every commit — the
  // history flush reads this POST-mutation value). v5: also mirrors the
  // playback flag + sfx placements for the scheduling callbacks.
  const stateRef = useRef<HistorySnapshot | null>(null);
  const isPlayingRef = useRef(false);
  useEffect(() => {
    stateRef.current = {
      items,
      overrides,
      motionOverrides,
      subtitles,
      headlineItems,
      captionSettings,
      kenBurns,
      settings,
      audioSettings,
      audioTrack,
      whisperLanguage,
      transition: transitionSettings,
      watermarkImage,
      watermarkSettings,
      itemEdits,
      sfxItems,
      videoDurations,
    };
    isPlayingRef.current = isPlaying;
  });

  const snapshotEq = (a: HistorySnapshot, b: HistorySnapshot): boolean => {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  };

  // POST-STATE history design: every stack entry is a full session state
  // captured AFTER an action committed. Undo steps to the previous entry,
  // redo re-applies the next — which is exactly how the removed-segment
  // case works: [baseline(9), removed(8)] → undo → 9, redo → 8.
  const pushTimerRef = useRef<number | null>(null);

  const flushHistoryPush = useCallback(() => {
    const h = historyRef.current;
    const snap = stateRef.current;
    if (pushTimerRef.current) {
      clearTimeout(pushTimerRef.current);
      pushTimerRef.current = null;
    }
    if (!h.pending || !snap || !h.baseline) return;
    h.pending = false;
    const top = h.stack[h.idx];
    if (top && snapshotEq(top, snap)) return; // no-op guard
    h.stack.length = h.idx + 1; // truncate the redo tail
    h.stack.push(snap);
    if (h.stack.length > HISTORY_MAX) h.stack.shift();
    h.idx = h.stack.length - 1;
    setHistoryState({ canUndo: h.idx > 0, canRedo: false });
  }, []);

  /**
   * Request a history push of the state AFTER the current action settles.
   * - debounceMs = 0 → discrete action (click): flush ~80ms after the call
   *   (post-commit, post-stateRef-sync).
   * - debounceMs > 0 → continuous input (slider/spinner): every change
   *   restarts the timer; the FINAL settled state is pushed once.
   */
  const requestHistoryPush = useCallback(
    (debounceMs = 0) => {
      const h = historyRef.current;
      h.pending = true;
      h.lastRequest = Date.now();
      if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
      const delay = Math.max(80, debounceMs);
      pushTimerRef.current = window.setTimeout(() => {
        flushHistoryPush();
      }, delay);
    },
    [flushHistoryPush],
  );

  const applySnapshot = useCallback((snap: HistorySnapshot) => {
    // Cancel any in-flight push so restored states are never re-pushed.
    const h = historyRef.current;
    h.pending = false;
    if (pushTimerRef.current) {
      clearTimeout(pushTimerRef.current);
      pushTimerRef.current = null;
    }
    setItems(snap.items);
    setOverrides(snap.overrides);
    setMotionOverrides(snap.motionOverrides);
    setSubtitles(snap.subtitles);
    setHeadlineItems(snap.headlineItems);
    setCaptionSettings(snap.captionSettings);
    setKenBurns(snap.kenBurns);
    setSettings(snap.settings);
    setAudioSettings(snap.audioSettings);
    setAudioTrack(snap.audioTrack);
    setWhisperLanguage(snap.whisperLanguage);
    setTransitionSettings(snap.transition);
    setWatermarkImage(snap.watermarkImage);
    setWatermarkSettings(snap.watermarkSettings);
    // v5.0: restore the multi-track session (edits, SFX, video durations).
    setItemEdits(snap.itemEdits);
    setSfxItems(snap.sfxItems);
    setVideoDurations(snap.videoDurations);
    setIsPlaying(false);
  }, []);

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (h.idx <= 0) return;
    h.idx -= 1;
    applySnapshot(h.stack[h.idx]);
    setHistoryState({
      canUndo: h.idx > 0,
      canRedo: h.idx < h.stack.length - 1,
    });
  }, [applySnapshot]);

  const redo = useCallback(() => {
    const h = historyRef.current;
    if (h.idx >= h.stack.length - 1) return;
    h.idx += 1;
    applySnapshot(h.stack[h.idx]);
    setHistoryState({
      canUndo: h.idx > 0,
      canRedo: h.idx < h.stack.length - 1,
    });
  }, [applySnapshot]);

  // Baseline snapshot after the persisted-restore effect settles.
  useEffect(() => {
    const t = setTimeout(() => {
      const h = historyRef.current;
      if (!h.baseline) {
        h.baseline = true;
        // Directly push the initial state (not via request — no action).
        const snap = stateRef.current;
        if (snap) {
          h.stack = [snap];
          h.idx = 0;
        }
      }
    }, 100);
    return () => clearTimeout(t);
  }, []);

  // Track every object URL ever created so unmount can clean them all up
  // (they stay alive during the session for undo restores).
  const urlsRef = useRef<Set<string>>(new Set());
  const trackUrl = useCallback((url: string) => {
    urlsRef.current.add(url);
    return url;
  }, []);

  // ---- Watermark image element loading (v4.4) -----------------------------
  useEffect(() => {
    let cancelled = false;
    if (!watermarkImage) {
      // Deferred clear (avoids synchronous setState in the effect body).
      const t = window.setTimeout(() => {
        if (!cancelled) setWatermarkImgEl(null);
      }, 0);
      return () => {
        cancelled = true;
        clearTimeout(t);
      };
    }
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setWatermarkImgEl(img);
    };
    img.onerror = () => {
      if (!cancelled) setWatermarkImgEl(null);
    };
    img.src = watermarkImage.url;
    return () => {
      cancelled = true;
    };
  }, [watermarkImage]);

  // ---- Load images when items change --------------------------------------
  useEffect(() => {
    const created = imagesRef.current;
    items.forEach((it) => {
      if (!created[it.id]) {
        const img = new Image();
        created[it.id] = img;
        img.onload = () =>
          setImages((prev) => (prev[it.id] ? prev : { ...prev, [it.id]: img }));
        img.onerror = () => {
          /* ignore */
        };
        img.src = it.url;
      }
    });
    const ids = new Set(items.map((i) => i.id));
    setImages((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const k of Object.keys(next)) {
        if (!ids.has(k)) {
          delete next[k];
          delete created[k];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [items]);

  // ---- Keep refs in sync for the playback loop ----------------------------
  const totalMsRef = useRef(timeline.totalMs);
  const segmentsRef = useRef(timeline.segments);

  useEffect(() => {
    totalMsRef.current = timeline.totalMs;
    segmentsRef.current = timeline.segments;
  }, [timeline.totalMs, timeline.segments]);

  // ---- v5.0 SFX preview audio ----------------------------------------------
  // A page-level (lazy) AudioContext + per-sfxId AudioBuffer cache schedules
  // every placement ahead of the wall clock when playback starts; seek/pause/
  // stop kills the live sources and (while playing) reschedules from the new
  // playhead. The master timeline clock stays the single source of truth —
  // the music <audio> element keeps its existing behavior.
  const sfxAudioRef = useRef<{
    ctx: AudioContext | null;
    buffers: Map<string, AudioBuffer>;
  }>({ ctx: null, buffers: new Map() });
  const sfxSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  /** Bumped on every (re)schedule — in-flight async schedules self-abort when
   *  superseded (scrub bursts, rapid seeks). */
  const sfxSchedTokenRef = useRef(0);

  const getSfxAudioContext = useCallback((): AudioContext | null => {
    if (typeof window === "undefined") return null; // SSR guard — silent no-op
    const w = window as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const AC = w.AudioContext ?? w.webkitAudioContext;
    if (!AC) return null;
    if (!sfxAudioRef.current.ctx) sfxAudioRef.current.ctx = new AC();
    return sfxAudioRef.current.ctx;
  }, []);

  const getSfxBuffer = useCallback(async (sfxId: string): Promise<AudioBuffer | null> => {
    const cached = sfxAudioRef.current.buffers.get(sfxId);
    if (cached) return cached;
    const buf = await renderSfxBuffer(sfxId); // null in Node / on failure
    if (buf) sfxAudioRef.current.buffers.set(sfxId, buf);
    return buf;
  }, []);

  const stopSfxSources = useCallback(() => {
    sfxSchedTokenRef.current += 1; // invalidate in-flight schedules
    for (const src of sfxSourcesRef.current) {
      try {
        src.onended = null;
        src.stop();
      } catch {
        /* already ended */
      }
      try {
        src.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    sfxSourcesRef.current.clear();
  }, []);

  const scheduleSfxFrom = useCallback(
    async (fromMs: number) => {
      stopSfxSources();
      const ctx = getSfxAudioContext();
      if (!ctx) return; // no Web Audio (SSR/Node) — silent no-op
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      const items = stateRef.current?.sfxItems ?? [];
      if (items.length === 0) return;
      const token = sfxSchedTokenRef.current;
      const baseTime = ctx.currentTime;
      for (const item of items) {
        // Loop-boundary rule: never reschedule items that already passed.
        if (item.startMs < fromMs) continue;
        const buf = await getSfxBuffer(item.sfxId);
        if (token !== sfxSchedTokenRef.current) return; // superseded
        if (!buf) continue; // unrenderable effect — skip silently
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const gain = ctx.createGain();
        gain.gain.value = item.volume;
        src.connect(gain);
        gain.connect(ctx.destination);
        try {
          const delaySec = Math.max(0, (item.startMs - fromMs) / 1000);
          src.start(baseTime + delaySec);
          sfxSourcesRef.current.add(src);
          src.onended = () => {
            sfxSourcesRef.current.delete(src);
          };
        } catch {
          /* start threw (past time) — skip this placement */
        }
      }
    },
    [getSfxAudioContext, getSfxBuffer, stopSfxSources],
  );

  // Reschedule whenever playback starts or the placement list changes while
  // playing (add/move/volume mid-playback); stop everything when paused.
  // Runs AFTER the stateRef sync effect above (declaration order) so it always
  // reads the freshest sfxItems.
  useEffect(() => {
    if (!isPlaying) {
      stopSfxSources();
      return;
    }
    void scheduleSfxFrom(currentMsRef.current);
  }, [isPlaying, sfxItems, scheduleSfxFrom, stopSfxSources]);

  // ---- Playback rAF loop --------------------------------------------------
  useEffect(() => {
    if (!isPlaying) {
      // Pause audio when not playing
      if (audioRef.current) {
        audioRef.current.pause();
      }
      return;
    }

    // Start audio playback synced with timeline
    if (audioRef.current && audioTrack) {
      audioRef.current.currentTime = currentMsRef.current / 1000;
      audioRef.current.play().catch(() => {});
    }

    let raf = 0;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      let m = currentMsRef.current + dt;
      const total = totalMsRef.current;
      if (m >= total) {
        m = total;
        currentMsRef.current = m;
        setCurrentMs(m);
        setIsPlaying(false);
        if (audioRef.current) audioRef.current.pause();
        return;
      }
      currentMsRef.current = m;
      setCurrentMs(m);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, audioTrack]);

  // ---- Detect Electron + wire app-menu accelerators -----------------------
  const exportRef = useRef<() => void>(() => {});

  const handleExport = useCallback(async () => {
    if (timeline.segments.length === 0) {
      toast.error("Add images first");
      return;
    }
    // If captions are enabled but no subtitles are loaded, warn (don't abort).
    if (
      captionSettings.enabled &&
      (!subtitles || subtitles.cues.length === 0) &&
      headlineItems.length === 0
    ) {
      toast.info("Captions enabled but no .srt loaded", {
        description: "Add a subtitle file from the media panel to burn in captions.",
      });
    }
    const ac = new AbortController();
    abortRef.current = ac;
    setIsExporting(true);
    setExportProgress({ progress: 0 });
    const imageUrls: Record<string, string> = {};
    for (const seg of timeline.segments) {
      const it = items.find((i) => i.id === seg.id);
      if (it) imageUrls[seg.id] = it.url;
    }
    try {
      const res = await exportNative({
        segments: timeline.segments,
        imageUrls,
        audioTrack,
        settings,
        kenBurns,
        audio: audioSettings,
        totalMs: timeline.totalMs,
        subtitles,
        captionSettings,
        headlines: headlineItems.length ? headlineItems : null,
        transition: transitionSettings,
        watermark: watermarkImage
          ? { imageUrl: watermarkImage.url, settings: watermarkSettings }
          : null,
        // v5.0: SFX placements (native.ts renders each unique effect once,
        // uploads the WAV, and the amix graph adelay's it at startMs). Omitted
        // when empty so v4.9-shaped projects keep the byte-identical IPC.
        sfx: sfxItems.length > 0 ? sfxItems : undefined,
        onProgress: (p) => setExportProgress(p),
        signal: ac.signal,
      });
      setLastExport({
        path: res.path,
        size: res.size,
        method: inElectron ? "Native FFmpeg" : "WebCodecs",
        at: Date.now(),
      });
      toast.success(`Exported ${fmtBytes(res.size)}`, {
        description: inElectron ? res.path : "Saved to your downloads",
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (ac.signal.aborted) toast.info("Export cancelled");
      else toast.error(msg || "Export failed");
    } finally {
      setIsExporting(false);
      setExportProgress(null);
      abortRef.current = null;
    }
  }, [
    timeline.segments,
    timeline.totalMs,
    items,
    audioTrack,
    settings,
    kenBurns,
    audioSettings,
    subtitles,
    captionSettings,
    headlineItems,
    transitionSettings,
    watermarkImage,
    watermarkSettings,
    inElectron,
    sfxItems,
  ]);

  // Keep exportRef in sync so menu accelerators call the latest version
  useEffect(() => {
    exportRef.current = handleExport;
  }, [handleExport]);

  // ---- v5.1: native project-file menu handlers (ref-synced so the menu
  // registrations never re-bind — the exportRef pattern).
  const saveProjectRef = useRef<() => void>(() => {});
  const saveProjectAsRef = useRef<() => void>(() => {});
  const openProjectRef = useRef<() => void>(() => {});
  const newProjectRef = useRef<() => void>(() => {});

  useEffect(() => {
    const electron = isElectron();
    // Defer setState to avoid cascading renders
    Promise.resolve().then(() => setInElectron(electron));
    if (electron && window.electronAPI) {
      const api = window.electronAPI;
      const offExport = api.onMenu("menu:export", () => exportRef.current());
      const offImages = api.onMenu("menu:add-images", () => openImagePicker());
      const offAudio = api.onMenu("menu:add-audio", () => openAudioPicker());
      const offGuide = api.onMenu("menu:naming-guide", () =>
        toast.info("Filename patterns", {
          description:
            "Absolute: [00:00:00 - 00:00:06] name.jpg\nBeat: 001__Beat_1_0s_name.jpg\nDuration: 10s_name.jpg",
        }),
      );
      // v5.1 native project files (dialog-backed main-process IPC).
      const offSave = api.onMenu("menu:save-project", () => saveProjectRef.current());
      const offSaveAs = api.onMenu("menu:save-project-as", () => saveProjectAsRef.current());
      const offOpen = api.onMenu("menu:open-project", () => openProjectRef.current());
      const offNew = api.onMenu("menu:new-project", () => newProjectRef.current());

      // Verify FFmpeg is reachable on startup so the user sees a clear
      // error early instead of a generic export failure. This catches
      // the case where the bundled ffmpeg.exe is missing (e.g. cross-
      // build from Linux that didn't include the Windows binary).
      if (api.ffmpegStatus) {
        api.ffmpegStatus().then((status) => {
          if (!status.ok) {
            toast.error("FFmpeg not found", {
              description:
                (status.error || "FFmpeg binary is missing") +
                "\nPath: " + status.path +
                "\n\nExports will fail until this is fixed. Try reinstalling FrameFuse.",
            });
          }
        }).catch(() => { /* silent — the export will surface the error if needed */ });
      }

      return () => {
        offExport?.();
        offImages?.();
        offAudio?.();
        offGuide?.();
        offSave?.();
        offSaveAs?.();
        offOpen?.();
        offNew?.();
      };
    }
    return undefined;
  }, [openImagePicker, openAudioPicker]);

  // ---- Handlers -----------------------------------------------------------
  /**
   * v5.0: probe one imported VIDEO for duration, intrinsic dims and a poster
   * thumbnail. Fully async and failure-tolerant: an undecodable file settles
   * with the 5000ms fallback duration and no thumbnail (icon tile) — it never
   * blocks the media list, which renders immediately from the file list.
   */
  const probeVideoItem = useCallback(
    (item: MediaItem, opts?: { onUndecodable?: (name: string) => void }) => {
      const { id, url } = item;
      let settled = false;
      // v5.2: one-shot aspect auto-match — the FIRST video with known dims
      // rewrites the output aspect (unless the user already picked one) so
      // vertical / square sources are never silently center-cropped. The
      // ref gates it to a single decision per project session (first wins).
      const maybeAutoAspect = (dims: { w: number; h: number }) => {
        if (autoAspectRef.current) return;
        autoAspectRef.current = true;
        setSettings((prev) => {
          if (prev.aspectTouched) return prev;
          const next = closestAspectForRatio(dims.w / dims.h);
          if (next === prev.aspect) return prev;
          toast.success(`Aspect matched to your video — ${next}`, {
            description: `${dims.w}×${dims.h} source detected. Change it any time in Settings → Export.`,
          });
          return { ...prev, aspect: next };
        });
      };
      const finish = (
        durationMs: number | null,
        dims: { w: number; h: number } | null,
        thumb: string | null,
      ) => {
        if (settled) return;
        settled = true;
        if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0) {
          setVideoDurations((prev) =>
            prev[id] === durationMs ? prev : { ...prev, [id]: durationMs },
          );
        }
        if (dims && dims.w > 0 && dims.h > 0) {
          setVideoDims((prev) => ({ ...prev, [id]: dims }));
          maybeAutoAspect(dims);
        } else {
          opts?.onUndecodable?.(item.file.name);
        }
        if (thumb) {
          setVideoThumbnails((prev) => ({ ...prev, [id]: thumb }));
        }
      };
      if (typeof document === "undefined") {
        finish(null, null, null);
        return;
      }
      const v = document.createElement("video");
      v.muted = true;
      v.playsInline = true;
      v.preload = "metadata";
      const cleanupEl = () => {
        v.onloadedmetadata = null;
        v.onseeked = null;
        v.onerror = null;
        try {
          v.removeAttribute("src");
          v.load();
        } catch {
          /* noop */
        }
      };
      v.onloadedmetadata = () => {
        const durSec = v.duration && Number.isFinite(v.duration) ? v.duration : 0;
        const durationMs = durSec > 0 ? Math.round(durSec * 1000) : 5000;
        const dims = { w: v.videoWidth || 0, h: v.videoHeight || 0 };
        const grab = () => {
          try {
            if (dims.w > 0 && dims.h > 0) {
              const c = document.createElement("canvas");
              c.width = 96;
              c.height = 54;
              const cx = c.getContext("2d");
              if (cx) {
                // Cover-fit the frame into the 96×54 poster.
                const cover = Math.max(96 / dims.w, 54 / dims.h);
                const dw = dims.w * cover;
                const dh = dims.h * cover;
                cx.drawImage(v, (96 - dw) / 2, (54 - dh) / 2, dw, dh);
                finish(durationMs, dims, c.toDataURL("image/jpeg", 0.72));
                return;
              }
            }
            finish(durationMs, dims, null);
          } catch {
            finish(durationMs, dims, null);
          }
        };
        // Poster frame at min(1s, dur/2) — bright enough for typical clips.
        const seekSec = Math.min(1, Math.max(0, durSec / 2));
        if (seekSec > 0 && dims.w > 0) {
          v.onseeked = () => {
            grab();
            cleanupEl();
          };
          v.currentTime = seekSec;
          window.setTimeout(() => {
            if (!settled) grab();
          }, 4000);
        } else {
          grab();
        }
      };
      v.onerror = () => {
        finish(5000, null, null); // undecodable — 5s placeholder + icon tile
        cleanupEl();
      };
      v.src = url;
      // Global timeout — a stalled decode must never block the list.
      window.setTimeout(() => {
        if (!settled) finish(5000, null, null);
      }, 8000);
    },
    [],
  );

  const addFiles = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      requestHistoryPush();
      const added: MediaItem[] = files.map((f) => ({
        id: genId(),
        file: f,
        url: trackUrl(URL.createObjectURL(f)),
        // v5.0 import routing: video files join the MEDIA list (never the
        // audio channel); everything else routes exactly as in v4.9.
        mediaType: isVideoFile(f) ? "video" : "image",
      }));
      setItems((prev) => [...prev, ...added]);
      const nVideo = added.filter((a) => a.mediaType === "video").length;
      const nImage = added.length - nVideo;
      if (nVideo > 0) {
        let warned = false;
        for (const it of added) {
          if (it.mediaType !== "video") continue;
          probeVideoItem(it, {
            onUndecodable: (name) => {
              if (warned) return;
              warned = true;
              toast.error("Couldn't decode a video", {
                description: `${name} will use a 5s placeholder — try re-encoding it (MP4/H.264 or WebM).`,
              });
            },
          });
        }
        toast.success(
          `Added ${nVideo} video${nVideo === 1 ? "" : "s"}${nImage ? ` + ${nImage} image${nImage === 1 ? "" : "s"}` : ""}`,
          {
            description:
              "Videos join the base track at their source length — move clips to the Overlay lane from the timeline or the media panel.",
          },
        );
      } else {
        toast.success(`Added ${nImage} image${nImage === 1 ? "" : "s"}`);
      }
    },
    [requestHistoryPush, trackUrl, probeVideoItem],
  );

  // ---- Beat detection (v4.6) ---------------------------------------------
  const [beatInfo, setBeatInfo] = useState<BeatInfo | null>(null);
  const [beatBusy, setBeatBusy] = useState(false);
  // v4.7: waveform peaks for the timeline strip (decoded per audio track).
  const [waveform, setWaveform] = useState<WaveformData | null>(null);
  // Beat data is DERIVED from the audio — invalidated on every track swap
  // (add/remove) rather than via an effect, per lint rule
  // react-hooks/set-state-in-effect.
  const clearBeatInfo = useCallback(() => {
    setBeatInfo(null);
    setBeatBusy(false);
  }, []);
  const clearWaveform = useCallback(() => setWaveform(null), []);

  const addAudio = useCallback((file: File) => {
    requestHistoryPush();
    clearBeatInfo();
    clearWaveform();
    setAudioTrack(() => {
      // The previous track's URL stays alive (undo-safe); unmount revokes.
      const url = trackUrl(URL.createObjectURL(file));
      const a = document.createElement("audio");
      a.preload = "metadata";
      a.onloadedmetadata = () => {
        const dur =
          a.duration && Number.isFinite(a.duration)
            ? a.duration * 1000
            : null;
        setAudioTrack((p) =>
          p && p.url === url ? { ...p, durationMs: dur } : p,
        );
      };
      a.src = url;
      return { fileName: file.name, url, durationMs: null };
    });
    toast.success(`Audio: ${file.name}`);
  }, [requestHistoryPush, trackUrl, clearBeatInfo, clearWaveform]);

  // v4.7: decode waveform peaks whenever a new audio track lands (async —
  // state is set in the promise continuation, not synchronously in the
  // effect body). Undecodable audio simply keeps the strip hidden; the
  // in-flight decode is cancelled when the track changes again.
  const audioUrl = audioTrack?.url ?? null;
  useEffect(() => {
    if (!audioUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(audioUrl);
        const blob = await resp.blob();
        if (cancelled) return;
        const data = await decodeAudioPeaks(blob);
        if (!cancelled) setWaveform(data);
      } catch {
        /* undecodable → no strip (same contract as beat detection) */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [audioUrl]);

  // ---- Subtitle (.srt) loading -------------------------------------------
  const addSubtitles = useCallback(
    (file: File) => {
      requestHistoryPush();
      const reader = new FileReader();
      reader.onload = () => {
        const rawText = String(reader.result || "");
        const cues = parseSrt(rawText);
        if (cues.length === 0) {
          toast.error("No subtitle cues found", {
            description:
              "Make sure the .srt file has standard timecodes (00:00:01,000 --> 00:00:04,000).",
          });
          return;
        }
        // Re-serialize from parsed cues so the FFmpeg-side SRT is always
        // well-formed (normalised line endings, 3-digit ms).
        const normalized = serializeSrt(cues);
        setSubtitles({
          fileName: file.name,
          cues,
          rawText: normalized,
        });
        toast.success(`Loaded ${cues.length} subtitle cue${cues.length === 1 ? "" : "s"}`, {
          description: file.name,
        });
        // Auto-enable captions when subtitles are first added.
        setCaptionSettings((prev) =>
          prev.enabled ? prev : { ...prev, enabled: true },
        );
      };
      reader.onerror = () => {
        toast.error("Failed to read subtitle file");
      };
      reader.readAsText(file);
    },
    [requestHistoryPush],
  );

  const removeSubtitles = useCallback(() => {
    requestHistoryPush();
    setSubtitles(null);
  }, [requestHistoryPush]);

  // ---- Caption preset selection — make presets BEHAVE like their names --
  // Selecting a preset applies its signature wordMode + animation (unless
  // the user pinned one) + preferred font, so "Hormozi" actually slams
  // single words and "Karaoke" actually fills word-by-word.
  const applyCaptionPreset = useCallback((presetId: string) => {
    requestHistoryPush();
    const preset = getCaptionPreset(presetId);
    setCaptionSettings((prev) => {
      const next: CaptionSettings = {
        ...prev,
        presetId: preset.id,
        // Reset overrides so the preset's design shines through.
        customColor: null,
        customPosition: null,
      };
      // Apply the preset's preferred font.
      if (preset.fontId) next.fontId = preset.fontId;
      // Apply the preset's word mode (its signature behavior).
      if (preset.wordMode) next.wordMode = preset.wordMode;
      // Apply the preset's animation unless the user pinned one explicitly.
      if (prev.animationPinned !== true) {
        next.animation = preset.animation ?? null;
      }
      return next;
    });
  }, [requestHistoryPush]);

  // ---- Caption sidecar exports (.srt browser / .ass Electron) ----------
  const exportSrtSidecar = useCallback(() => {
    if (!subtitles || subtitles.cues.length === 0) {
      toast.error("No captions to export", {
        description: "Generate captions from audio or load a .srt file first.",
      });
      return;
    }
    const text = serializeSrt(subtitles.cues);
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (subtitles.fileName || "captions").replace(/\.[^.]+$/, "") + ".srt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast.success(`Exported ${subtitles.cues.length} cues to .srt`);
  }, [subtitles]);

  // ---- WebVTT sidecar export (v4.4) — HTML5 <track> / web players ----
  const exportVttSidecar = useCallback(() => {
    if (!subtitles || subtitles.cues.length === 0) {
      toast.error("No captions to export", {
        description: "Generate captions from audio or load a .srt file first.",
      });
      return;
    }
    const text = serializeVtt(subtitles.cues);
    const blob = new Blob([text], { type: "text/vtt;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download =
      (subtitles.fileName || "captions").replace(/\.[^.]+$/, "") + ".vtt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast.success(`Exported ${subtitles.cues.length} cues to .vtt`);
  }, [subtitles]);

  // ---- Karaoke WebVTT sidecar export (v4.6) — word-level timing ----------
  const exportVttWordsSidecar = useCallback(() => {
    if (!subtitles || subtitles.cues.length === 0) {
      toast.error("No captions to export", {
        description: "Generate captions from audio or load a .srt file first.",
      });
      return;
    }
    const wordCount = subtitles.cues.reduce(
      (n, c) => n + (c.words?.length ?? 0),
      0,
    );
    if (wordCount === 0) {
      toast.error("No word timing in these captions", {
        description: "Word-level .vtt needs captions generated from audio (Whisper) — .srt imports carry cue timing only.",
      });
      return;
    }
    const text = serializeVttWords(subtitles.cues);
    const blob = new Blob([text], { type: "text/vtt;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download =
      (subtitles.fileName || "captions").replace(/\.[^.]+$/, "") +
      ".words.vtt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast.success(`Exported ${wordCount} word timings to .vtt`);
  }, [subtitles]);

  // ---- Watermark management (v4.4) ---------------------------------------
  const setWatermarkFile = useCallback(
    (file: File | null) => {
      requestHistoryPush(200);
      if (!file) {
        setWatermarkImage(null);
        return;
      }
      const url = trackUrl(URL.createObjectURL(file));
      setWatermarkImage({ id: `wm_${genId()}`, file, url, mediaType: "image" });
      toast.success(`Watermark set — ${file.name}`, {
        description:
          "Position, size and opacity are in the Watermark settings section.",
      });
    },
    [requestHistoryPush, trackUrl],
  );

  const removeWatermarkImage = useCallback(() => {
    requestHistoryPush();
    setWatermarkImage(null);
    toast.info("Watermark removed");
  }, [requestHistoryPush]);

  const handleWatermarkSettingsChange = useCallback(
    (v: WatermarkSettings) => {
      requestHistoryPush(500);
      setWatermarkSettings(v);
    },
    [requestHistoryPush],
  );

  const exportAssSidecar = useCallback(async () => {
    if (!subtitles || subtitles.cues.length === 0) {
      toast.error("No captions to export", {
        description: "Generate captions from audio or load a .srt file first.",
      });
      return;
    }
    const api = window.electronAPI;
    if (!api?.exportAssFile) {
      toast.info(".ass export is available in the desktop app");
      return;
    }
    try {
      const { resolveDimensions } = await import("@/lib/merger/renderer");
      const dims = resolveDimensions(settings.aspect, settings.resolution);
      const preset = getCaptionPreset(captionSettings.presetId);
      const font = getFontOption(captionSettings.fontId);
      const res = await api.exportAssFile({
        cues: subtitles.cues.map((c) => ({
          startMs: c.startMs,
          endMs: c.endMs,
          text: c.text,
          words: c.words,
        })),
        captionSettings: {
          fontName: font.ffmpegName,
          fontSize: preset.fontSize,
          fontSizeScale: captionSettings.fontSizeScale,
          fontWeight: preset.fontWeight,
          fontStyle: preset.fontStyle,
          textColor: captionSettings.customColor || preset.textColor,
          highlightColor: preset.highlightColor || null,
          borderColor: preset.borderColor,
          borderWidth: preset.borderWidth,
          bgColor: preset.bgColor,
          bgAlpha: preset.bgAlpha,
          shadow: preset.shadow,
          shadowColor: preset.shadowColor,
          shadowBlur: preset.shadowBlur,
          textTransform: preset.textTransform,
          letterSpacing: preset.letterSpacing,
          alignment: preset.alignment,
          position: preset.position,
          positionY: preset.positionY,
          customPosition: captionSettings.customPosition,
          wordMode: captionSettings.wordMode,
          animation: captionSettings.animation || preset.animation || "none",
        },
        width: dims.w,
        height: dims.h,
      });
      if (res) {
        toast.success("Exported .ass subtitle file", { description: res.path });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : ".ass export failed");
    }
  }, [subtitles, captionSettings, settings.aspect, settings.resolution]);

  // ---- Whisper caption generation (word-level timestamps) ----------------
  const [whisperBusy, setWhisperBusy] = useState(false);
  const [whisperProgress, setWhisperProgress] = useState<WhisperProgress | null>(null);

  // ---- Persist settings on change ----------------------------------------
  useEffect(() => {
    const payload: PersistedSettings = {
      kenBurns,
      settings,
      captionSettings,
      audio: audioSettings,
      whisperLanguage,
      headlines: headlineItems.length ? headlineItems : [],
      transition: transitionSettings,
      watermark: watermarkSettings,
      beatStride,
      favoritePresets,
      mediaView,
    };
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ v: LS_VERSION, data: payload }));
      // One-shot legacy cleanup — the data now lives under the versioned key.
      for (const legacy of LS_LEGACY_KEYS) {
        if (localStorage.getItem(legacy) != null) {
          localStorage.removeItem(legacy);
        }
      }
    } catch {
      /* storage full / private mode — non-fatal */
    }
  }, [kenBurns, settings, captionSettings, audioSettings, whisperLanguage, headlineItems, transitionSettings, watermarkSettings, beatStride, favoritePresets, mediaView]);

  const generateCaptionsFromAudio = useCallback(async () => {
    if (!audioTrack) {
      toast.error("Add an audio track first", {
        description: "Whisper transcribes your audio into word-by-word captions.",
      });
      return;
    }
    if (!isWhisperAvailable()) {
      toast.error("Audio decoding is not supported in this browser");
      return;
    }
    if (whisperBusy) return;

    setWhisperBusy(true);
    setWhisperProgress({ progress: 0, status: "Starting…" });

    const ac = new AbortController();
    try {
      // Fetch the audio File back from the object URL.
      const resp = await fetch(audioTrack.url);
      const blob = await resp.blob();
      const file = new File([blob], audioTrack.fileName, {
        type: blob.type || "audio/mpeg",
      });

      const result = await transcribeWithWhisper({
        audioFile: file,
        signal: ac.signal,
        language: whisperLanguage,
        onProgress: (p) => setWhisperProgress(p),
      });

      if (result.cues.length === 0) {
        toast.error("No speech detected", {
          description: "Whisper couldn't transcribe any words from this audio.",
        });
        return;
      }

      const wordCount = result.cues.reduce(
        (n, c) => n + (c.words?.length ?? 0),
        0,
      );
      requestHistoryPush(250);
      setSubtitles({
        fileName: `${audioTrack.fileName.replace(/\.[^.]+$/, "")}.whisper.srt`,
        cues: result.cues,
        rawText: serializeSrt(result.cues),
      });
      // Auto-enable captions + switch to word mode + pick a word-aware
      // preset if the user hasn't already, so the karaoke effect is
      // immediately visible in the preview.
      setCaptionSettings((prev) => {
        const next = { ...prev, enabled: true };
        if (!prev.wordMode || prev.wordMode === "off") {
          next.wordMode = "word";
        }
        const isWordPreset =
          prev.presetId.startsWith("word-") ||
          prev.presetId.startsWith("kinetic-");
        if (!isWordPreset) {
          next.presetId = "word-karaoke";
        }
        // Default the animation to the preset's preferred animation
        // (e.g. word-karaoke → pop-in) so the user immediately sees
        // motion. They can override in the Settings panel.
        if (!prev.animation || prev.animation === "none") {
          const preset = CAPTION_PRESETS.find((p) => p.id === next.presetId);
          if (preset?.animation) next.animation = preset.animation;
        }
        return next;
      });
      toast.success(
        `Transcribed ${wordCount} word${wordCount === 1 ? "" : "s"}${
          result.wordLevel ? " (exact word timing)" : ""
        }`,
        {
          description: `${result.cues.length} cue${
            result.cues.length === 1 ? "" : "s"
          } · ${result.wordLevel ? "word-by-word mode ready" : "estimated word timing"}${
            result.language ? ` · ${result.language}` : ""
          }`,
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("cancelled")) toast.info("Caption generation cancelled");
      else toast.error("Whisper transcription failed", { description: msg });
    } finally {
      setWhisperBusy(false);
      setWhisperProgress(null);
    }
  }, [audioTrack, whisperBusy, whisperLanguage, requestHistoryPush]);

  const loadSamples = useCallback(async () => {
    try {
      const res = await fetch("/samples/manifest.json");
      const names: string[] = await res.json();
      const files: File[] = [];
      for (const name of names) {
        try {
          const r = await fetch(`/samples/${name}`);
          if (!r.ok) continue;
          const blob = await r.blob();
          files.push(
            new File([blob], name, { type: blob.type || "image/jpeg" }),
          );
        } catch {
          /* skip individual failures */
        }
      }
      if (files.length) {
        addFiles(files);
        toast.success(`Loaded ${files.length} sample beats`);
      } else {
        toast.error("Could not load samples");
      }
    } catch {
      toast.error("Sample manifest unavailable");
    }
  }, [addFiles]);

  const removeAudio = useCallback(() => {
    requestHistoryPush();
    clearBeatInfo();
    clearWaveform();
    setAudioTrack(null);
  }, [requestHistoryPush, clearBeatInfo, clearWaveform]);

  const removeItem = useCallback((id: string) => {
    requestHistoryPush();
    // The object URL stays alive (undo-safe) — revoked on unmount only.
    setItems((prev) => prev.filter((i) => i.id !== id));
    setOverrides((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    // v4.9: prune id-keyed overrides the moment their segment dies, so the
    // override maps never accumulate orphans (undo still restores them —
    // both maps live in the history snapshot).
    setMotionOverrides((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    // v5.0: same pruning for multi-track edits + probed video durations
    // (both live in the history snapshot, so Ctrl+Z restores them). The
    // hidden <video> element is dropped by PreviewPanel when the id leaves
    // the videoUrls map; thumbnails/dims stay as harmless probe caches.
    setItemEdits((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setVideoDurations((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setTransitionSettings((prev) => {
      if (
        !prev.overrides ||
        !Object.prototype.hasOwnProperty.call(prev.overrides, id)
      )
        return prev;
      const nextOverrides = { ...prev.overrides };
      delete nextOverrides[id];
      return { ...prev, overrides: nextOverrides };
    });
  }, [requestHistoryPush]);

  const overrideDuration = useCallback((id: string, durationMs: number) => {
    requestHistoryPush(600);
    setOverrides((prev) => ({ ...prev, [id]: durationMs }));
  }, [requestHistoryPush]);

  const clearOverride = useCallback((id: string) => {
    requestHistoryPush();
    setOverrides((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, [requestHistoryPush]);

  // ---- Beat-sync actions (v4.6) ------------------------------------------

  const handleDetectBeats = useCallback(async () => {
    if (!audioTrack || beatBusy) return;
    setBeatBusy(true);
    try {
      const resp = await fetch(audioTrack.url);
      const blob = await resp.blob();
      const file = new File([blob], audioTrack.fileName, {
        type: blob.type || "audio/mpeg",
      });
      const info = await detectBeatsInAudio(file);
      if (info.beatMs.length < 2) {
        setBeatInfo(info);
        toast.info("No clear beat found", {
          description: "The audio may be ambient, speech-only, or very quiet. Beat snapping needs a steady pulse.",
        });
        return;
      }
      setBeatInfo(info);
      toast.success(`Detected ${info.beatMs.length} beats${info.bpm ? ` · ${info.bpm} BPM` : ""}`, {
        description: "Snap cuts to beats now — every boundary lands on the pulse.",
      });
    } catch (err) {
      console.error("beat detect failed", err);
      toast.error("Beat detection failed", {
        description: "Could not decode the audio in this browser.",
      });
    } finally {
      setBeatBusy(false);
    }
  }, [audioTrack, beatBusy]);

  const handleSnapToBeats = useCallback(() => {
    if (!beatInfo || !timeline.segments.length) return;
    if (timeline.mode !== "sequential") {
      toast.error("Beat snap needs the sequence timeline", {
        description: "Timestamped filenames drive absolute timelines — rename without _Ns_ patterns to retime freely.",
      });
      return;
    }
    const plan = planBeatSnap(
      timeline.segments.map((s) => ({ id: s.id, durationMs: s.durationMs })),
      beatInfo.beatMs,
      800,
      beatStride,
    );
    if (!Object.keys(plan).length) {
      toast.error("Not enough beats to snap", {
        description: "Try a longer/punchier audio track, or a finer cut rate (Beat / 2).",
      });
      return;
    }
    requestHistoryPush();
    setOverrides((prev) => ({ ...prev, ...plan }));
    toast.success(
      beatStride === 1
        ? "Cuts snapped to beats"
        : `Cuts snapped to every ${beatStride}th beat`,
      {
        description: "Undo (Ctrl+Z) restores the previous durations.",
      },
    );
  }, [beatInfo, timeline.segments, timeline.mode, requestHistoryPush, beatStride]);

  // ---- Preset favorites (v4.7) --------------------------------------------
  const toggleFavoritePreset = useCallback((presetId: string) => {
    setFavoritePresets((prev) =>
      prev.includes(presetId)
        ? prev.filter((id) => id !== presetId)
        : [...prev, presetId],
    );
  }, []);

  const handleFitToAudio = useCallback(() => {
    if (!audioTrack || !audioTrack.durationMs || !timeline.segments.length) return;
    if (timeline.mode !== "sequential") {
      toast.error("Fit-to-audio needs the sequence timeline", {
        description: "Timestamped filenames drive absolute timelines.",
      });
      return;
    }
    const plan = planFitToAudio(
      timeline.segments.map((s) => ({ id: s.id, durationMs: s.durationMs })),
      audioTrack.durationMs,
    );
    if (!Object.keys(plan).length) return;
    requestHistoryPush();
    setOverrides((prev) => ({ ...prev, ...plan }));
    toast.success("Video fitted to audio", {
      description: `Timeline now ends with the audio at ${fmtTimecode(audioTrack.durationMs)}.`,
    });
  }, [audioTrack, timeline.segments, timeline.mode, requestHistoryPush]);

  const reorderItem = useCallback((id: string, dir: -1 | 1) => {
    requestHistoryPush();
    setItems((prev) => {
      const idx = prev.findIndex((i) => i.id === id);
      if (idx < 0) return prev;
      const target = idx + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }, [requestHistoryPush]);

  /** v4.5 drag-reorder: move an item to an absolute index (drop target). */
  const moveItemTo = useCallback((id: string, targetIdx: number) => {
    requestHistoryPush();
    setItems((prev) => {
      const idx = prev.findIndex((i) => i.id === id);
      if (idx < 0 || targetIdx < 0 || targetIdx >= prev.length || targetIdx === idx) {
        return prev;
      }
      const next = [...prev];
      const [moved] = next.splice(idx, 1);
      next.splice(targetIdx, 0, moved);
      return next;
    });
  }, [requestHistoryPush]);

  /**
   * v4.5 per-boundary transition override. `style === null` removes the
   * override (boundary follows the global style again); a style (including
   * "none" = explicit hard cut) pins the boundary.
   */
  const handleBoundaryStyle = useCallback(
    (segId: string, style: TransitionStyle | null) => {
      requestHistoryPush();
      setTransitionSettings((prev) => {
        const overrides = { ...(prev.overrides || {}) };
        if (style == null) delete overrides[segId];
        else overrides[segId] = style;
        // Drop the map entirely when empty — keeps settings/project files clean.
        const hasAny = Object.keys(overrides).length > 0;
        return { ...prev, overrides: hasAny ? overrides : undefined };
      });
    },
    [requestHistoryPush],
  );

  /** v4.5: clear every per-boundary override in one shot. */
  const clearBoundaryOverrides = useCallback(() => {
    requestHistoryPush();
    setTransitionSettings((prev) => ({ ...prev, overrides: undefined }));
  }, [requestHistoryPush]);

  /**
   * Duplicate a media item right after the original (v4.2). Copies the
   * file (same object) with a fresh id so it lands as its own timeline
   * segment; duration overrides + itemEdits do NOT carry over (the copy
   * re-parses), but the probed VIDEO metadata (duration/dims/poster) does —
   * no re-decode needed.
   */
  const duplicateItem = useCallback(
    (id: string) => {
      requestHistoryPush();
      const srcId = id;
      const copyId = genId();
      setItems((prev) => {
        const idx = prev.findIndex((i) => i.id === srcId);
        if (idx < 0) return prev;
        const src = prev[idx];
        const copy: MediaItem = {
          id: copyId,
          file: src.file,
          url: trackUrl(URL.createObjectURL(src.file)),
          mediaType: src.mediaType,
        };
        const next = [...prev];
        next.splice(idx + 1, 0, copy);
        return next;
      });
      // v5.0: carry the probed video metadata over to the copy instantly
      // (computed outside the updater — deterministic id, idempotent writes).
      if (videoDurations[srcId] != null) {
        setVideoDurations((vd) =>
          vd[srcId] != null ? { ...vd, [copyId]: vd[srcId] } : vd,
        );
      }
      if (videoDims[srcId]) {
        setVideoDims((dm) => (dm[srcId] ? { ...dm, [copyId]: dm[srcId] } : dm));
      }
      if (videoThumbnails[srcId]) {
        setVideoThumbnails((th) =>
          th[srcId] ? { ...th, [copyId]: th[srcId] } : th,
        );
      }
      toast.success("Duplicated segment");
    },
    [requestHistoryPush, trackUrl, videoDurations, videoDims, videoThumbnails],
  );

  /** v5.1: build an ABSOLUTE-range filename for a split's right half (the
 *  absolute pattern is checked FIRST by parseFilename, so the clip lands
 *  exactly at the split point in absolute mode). Any existing range and
 *  extension are stripped from the base name. */
function splitRangeName(name: string, startMs: number, endMs: number): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  const base = name
    .slice(0, dot > 0 ? dot : undefined)
    .replace(/\[[^\]]*\]\s*/, "")
    .trim();
  return `[${fmtTimecode(startMs)} - ${fmtTimecode(endMs)}] ${base || "clip"}${ext}`;
}

/**
 * v5.1 SPLIT AT PLAYHEAD — cut the ACTIVE base-track segment in two at the
 * current playhead (strictly inside, >100ms from both edges). Implemented
 * entirely with the existing items/overrides/itemEdits model:
 *  - LEFT: the original item stays; a duration override pins its window to
 *    (splitAt − start) — honored in BOTH timeline modes.
 *  - RIGHT: a NEW item (same source File, fresh id, inserted right after):
 *      · sequential mode keeps the same name (the override pins the
 *        duration, so the two parts sum to the original);
 *      · absolute mode renames the File with an absolute range
 *        `[splitAt − end]` so filename timing places it at the split;
 *      · video: itemEdits trimInMs = trimIn + leftDur·speed (source time);
 *        speed/volume edits carry over so both halves play identically.
 * One requestHistoryPush → ONE undo step (all updates batch in one tick).
 */
const splitAtPlayhead = useCallback(() => {
  const seg = activeSegment; // segmentAtTime → BASE lane only
  if (!seg) {
    toast.error("No active clip under the playhead");
    return;
  }
  const splitAt = currentMsRef.current;
  if (splitAt <= seg.startMs + 100 || splitAt >= seg.endMs - 100) {
    toast.error("Playhead is too close to the clip edge", {
      description: "Split needs the playhead more than 0.1s from either edge of the active clip.",
    });
    return;
  }
  const item = items.find((i) => i.id === seg.id);
  if (!item) return;

  const speed = seg.speed != null && seg.speed > 0 ? seg.speed : 1;
  const leftDur = splitAt - seg.startMs;
  const rightDur = seg.endMs - splitAt;
  const rightId = genId();

  requestHistoryPush();

  // LEFT: pin the shortened window.
  // RIGHT: same bytes, fresh id — the shared object URL stays valid (URLs
  // are only revoked on unmount, by design).
  setOverrides((prev) => ({ ...prev, [seg.id]: leftDur, [rightId]: rightDur }));
  setItems((prev) => {
    const idx = prev.findIndex((i) => i.id === seg.id);
    if (idx < 0) return prev;
    const absolute = timeline.mode === "absolute";
    const name = absolute
      ? splitRangeName(item.file.name, splitAt, seg.endMs)
      : item.file.name;
    const copy: MediaItem = {
      id: rightId,
      // File([file]) re-blobs the SAME bytes lazily — no memory copy.
      file: new File([item.file], name, { type: item.file.type }),
      url: item.url,
      mediaType: item.mediaType,
    };
    const next = [...prev];
    // Absolute-mode fix-up: a left half whose placement does NOT come from
    // filename timing (an untimed video — parseFilename null — or a
    // duration-kind name) would otherwise re-append at the tail AFTER the
    // right half — swapping the split order. Renaming it to an absolute
    // range pins it at its current position. Absolute/beat kinds already
    // place by filename start, so they keep the user's name.
    const leftKind = parseFilename(item.file.name)?.kind;
    if (absolute && leftKind !== "absolute" && leftKind !== "beat") {
      next[idx] = {
        ...next[idx],
        file: new File(
          [item.file],
          splitRangeName(item.file.name, seg.startMs, splitAt),
          { type: item.file.type },
        ),
      };
    }
    next.splice(idx + 1, 0, copy);
    return next;
  });
  // RIGHT video edit: source window starts after the left half's window.
  if (item.mediaType === "video") {
    const rightEdit: ItemEdit = {
      trimInMs: Math.max(0, Math.round(seg.trimInMs + leftDur * speed)),
    };
    if (seg.speed != null && seg.speed !== 1) rightEdit.speed = seg.speed;
    if (seg.volume != null && seg.volume !== 1) rightEdit.volume = seg.volume;
    setItemEdits((prev) => ({ ...prev, [rightId]: rightEdit }));
  }
  // Carry the probed video metadata (duration/dims/poster) to the right
  // half instantly — no re-probe (the duplicateItem pattern).
  if (videoDurations[seg.id] != null) {
    setVideoDurations((vd) =>
      vd[seg.id] != null ? { ...vd, [rightId]: vd[seg.id] } : vd,
    );
  }
  if (videoDims[seg.id]) {
    setVideoDims((dm) => (dm[seg.id] ? { ...dm, [rightId]: dm[seg.id] } : dm));
  }
  if (videoThumbnails[seg.id]) {
    setVideoThumbnails((th) =>
      th[seg.id] ? { ...th, [rightId]: th[seg.id] } : th,
    );
  }
  toast.success("Clip split at playhead", {
    description: `Left ${(leftDur / 1000).toFixed(1)}s · right ${(rightDur / 1000).toFixed(1)}s — undo (Ctrl+Z) restores the original clip.`,
  });
}, [
  activeSegment,
  items,
  timeline.mode,
  requestHistoryPush,
  videoDurations,
  videoDims,
  videoThumbnails,
]);

/**
 * v5.1 "Random mix" — pin a random transition (from every available style
 * incl. dips) to ALL base-lane boundaries with no back-to-back repeats, via
 * the existing per-boundary overrides map. One commit → one undo step.
 */
const handleRandomTransitionMix = useCallback(() => {
  const baseSegs = timeline.segments.filter((s) => s.track === 0);
  if (baseSegs.length < 2) {
    toast.error("Need at least two clips", {
      description: "Transitions live on the boundaries between base-track clips.",
    });
    return;
  }
  const pool: TransitionStyle[] = [
    "dissolve",
    "dip-black",
    "dip-white",
    "slide-left",
    "slide-right",
    "wipe-left",
    "wipe-right",
    "circleopen",
  ];
  requestHistoryPush();
  const overrides: Record<string, TransitionStyle> = {};
  let prev: TransitionStyle | null = null;
  for (let i = 1; i < baseSegs.length; i++) {
    const seg = baseSegs[i];
    const choices = prev == null ? pool : pool.filter((s) => s !== prev);
    const pick = choices[Math.floor(Math.random() * choices.length)];
    overrides[seg.id] = pick;
    prev = pick;
  }
  setTransitionSettings((prevT) => ({ ...prevT, overrides }));
  toast.success(
    `Randomized ${baseSegs.length - 1} transition${
      baseSegs.length === 2 ? "" : "s"
    }`,
    {
      description:
        "No two neighboring cuts share a style — undo (Ctrl+Z) restores the previous pins.",
    },
  );
}, [timeline.segments, requestHistoryPush]);

// ---- Headline overlay management (v4.2) ------------------------------
  const addHeadline = useCallback(() => {
    requestHistoryPush();
    setHeadlineItems((prev) => {
      // New items default to starting right after the last one ends
      // (or at the playhead when empty) — quick “hook chain” building.
      const base = prev.length
        ? Math.min(prev[prev.length - 1].endMs, totalMsRef.current)
        : Math.min(currentMsRef.current, Math.max(0, totalMsRef.current - 3000));
      const item = makeHeadlineItem({ startMs: base, endMs: base + 3000 });
      return [...prev, item];
    });
  }, [requestHistoryPush]);

  const updateHeadline = useCallback(
    (id: string, patch: Partial<HeadlineItem>) => {
      requestHistoryPush(600);
      setHeadlineItems((prev) =>
        prev.map((h) => (h.id === id ? { ...h, ...patch } : h)),
      );
    },
    [requestHistoryPush],
  );

  const removeHeadline = useCallback((id: string) => {
    requestHistoryPush();
    setHeadlineItems((prev) => prev.filter((h) => h.id !== id));
  }, [requestHistoryPush]);

  // ---- Project save / load (.framefuse.json, v4.2) --------------------
  const projectInputRef = useRef<HTMLInputElement>(null);
  const openProjectPicker = useCallback(
    () => projectInputRef.current?.click(),
    [],
  );

  // ---- v4.8: per-segment Ken Burns motion override -----------------------
  /** Pin one segment's motion (null = clear → back to global/random). */
  const setSegmentMotion = useCallback(
    (segId: string, dir: KenBurnsDirection | null) => {
      requestHistoryPush();
      setMotionOverrides((prev) => {
        const next = { ...prev };
        if (dir == null) delete next[segId];
        else next[segId] = dir;
        return next;
      });
    },
    [requestHistoryPush],
  );

  const clearAllMotionOverrides = useCallback(() => {
    requestHistoryPush();
    setMotionOverrides({});
    toast.success("Motion overrides cleared", {
      description: "Every segment follows the global Ken Burns setting again.",
    });
  }, [requestHistoryPush]);

  // ---- v5.0: multi-track item edits + SFX placements ----------------------
  /**
   * Patch-merge one item's edit. Semantics (7-b's contract): undefined field
   * values DELETE the key (`{ chroma: undefined }` disables the keyer — the
   * spread keeps the key present-but-undefined, JSON save drops it, timeline
   * resolves null); finite numbers / objects merge over the prior edit.
   * Entries that become empty are removed from the map entirely.
   */
  const applyItemEdit = useCallback((id: string, patch: Partial<ItemEdit>) => {
    setItemEdits((prev) => {
      const base: ItemEdit = { ...(prev[id] ?? {}) };
      for (const [key, value] of Object.entries(patch) as [
        keyof ItemEdit,
        ItemEdit[keyof ItemEdit],
      ][]) {
        if (value === undefined) delete base[key];
        else (base[key] as unknown) = value;
      }
      const next = { ...prev };
      if (Object.keys(base).length === 0) delete next[id];
      else next[id] = base;
      return next;
    });
  }, []);

  /**
   * Shared translation logic for item-edit patches (see the doc comment on
   * handleSetItemEdit / handleTimelineEdit below for the full contract).
   * v5.1 adds (3): the BASE lane pins clip durations through the v4.x
   * `overrides` map (edit.durationMs only drives the overlay lane), so any
   * effective duration is mirrored there while the clip sits on the base
   * lane — timeline trim drags actually stick.
   */
  const translateItemEdit = useCallback(
    (
      id: string,
      patch: Partial<ItemEdit>,
    ): {
      patch: Partial<ItemEdit>;
      routedFromBase: boolean;
      baseDurationMs: number | undefined;
    } => {
      const existing = stateRef.current?.itemEdits[id] ?? {};
      const eff: Partial<ItemEdit> = { ...patch };
      // (1) base-lane horizontal move → auto-route to the overlay lane.
      const patchSetsTrack = "track" in patch;
      const currentTrack = existing.track ?? 0;
      const routedFromBase =
        eff.startMs !== undefined && !patchSetsTrack && currentTrack === 0;
      if (routedFromBase) eff.track = 1;
      // (2) overlay default geometry when moving to any overlay lane.
      const finalTrack = (eff.track !== undefined ? eff.track : currentTrack) ?? 0;
      const finalOverlay =
        eff.overlay !== undefined ? eff.overlay : existing.overlay;
      if (finalTrack >= 1 && !finalOverlay) {
        eff.overlay = DEFAULT_OVERLAY_TRANSFORM;
      }
      // (3) v5.1: mirror the effective duration into the BASE lane's
      // overrides map. `overrides` is the final TIMELINE duration the base
      // lane resolves (never speed-divided — see timeline.ts), so trim
      // drags and panel edits land exactly where the user dropped them.
      const mergedDur =
        eff.durationMs !== undefined ? eff.durationMs : existing.durationMs;
      const baseDurationMs =
        finalTrack === 0 &&
        typeof mergedDur === "number" &&
        Number.isFinite(mergedDur) &&
        mergedDur > 0
          ? mergedDur
          : undefined;
      return { patch: eff, routedFromBase, baseDurationMs };
    },
    [],
  );

  /** MediaPanel clip-settings channel (sliders → debounced history push).
   *
   * Two page-level translations keep the frozen data model honest:
   * 1. BASE-LANE startMs (7-a's caveat): absolute-mode base clips emit
   *    `{ startMs }` on horizontal drags, but buildTimeline ignores
   *    edit.startMs on the base lane (filename timing rules there). Per
   *    7-a's recommended option, the patch is AUTO-ROUTED to the overlay
   *    lane (`{ track: 1, startMs }`) so the clip stays where the user
   *    dropped it — a toast explains the lane change. Sequential mode never
   *    emits horizontal base moves, so nothing to translate there.
   * 2. DEFAULT OVERLAY GEOMETRY: items moved to the overlay lane without an
   *    explicit transform get DEFAULT_OVERLAY_TRANSFORM written into their
   *    edit — the FFmpeg overlay composite skips null transforms, so
   *    materializing the same default the preview renders keeps
   *    preview↔export parity by construction.
   */
  const handleSetItemEdit = useCallback(
    (id: string, patch: Partial<ItemEdit>) => {
      requestHistoryPush(500);
      const { patch: eff, routedFromBase, baseDurationMs } =
        translateItemEdit(id, patch);
      applyItemEdit(id, eff);
      if (baseDurationMs != null) {
        setOverrides((prev) => ({ ...prev, [id]: baseDurationMs }));
      }
      if (routedFromBase) {
        toast.info("Moved to the Overlay track", {
          description:
            "Base clips follow filename timing — a horizontal drag places the clip as an overlay. Drop it back on the Video lane to restore it.",
        });
      }
    },
    [requestHistoryPush, applyItemEdit, translateItemEdit],
  );

  /** TimelineRuler drag commits (move / trim / lane switch — discrete pushes
   *  on pointerup; same translations as handleSetItemEdit). */
  const handleTimelineEdit = useCallback(
    (id: string, patch: Partial<ItemEdit>) => {
      requestHistoryPush();
      const { patch: eff, routedFromBase, baseDurationMs } =
        translateItemEdit(id, patch);
      applyItemEdit(id, eff);
      if (baseDurationMs != null) {
        setOverrides((prev) => ({ ...prev, [id]: baseDurationMs }));
      }
      if (routedFromBase) {
        toast.info("Moved to the Overlay track", {
          description:
            "Base clips follow filename timing — a horizontal drag places the clip as an overlay. Drop it back on the Video lane to restore it.",
        });
      }
    },
    [requestHistoryPush, applyItemEdit, translateItemEdit],
  );

  /** v5.0: add an SFX placement at the playhead (MediaPanel palette). */
  const handleAddSfx = useCallback(
    (sfxId: string) => {
      requestHistoryPush();
      const startMs = Math.max(0, Math.min(currentMsRef.current, totalMsRef.current));
      setSfxItems((prev) => [...prev, makeSfxItem({ sfxId, startMs, volume: 1 })]);
    },
    [requestHistoryPush],
  );

  /** v5.0: move an SFX pill (TimelineRuler drag). */
  const handleMoveSfx = useCallback(
    (id: string, startMs: number) => {
      requestHistoryPush();
      setSfxItems((prev) =>
        prev.map((s) =>
          s.id === id
            ? { ...s, startMs: Math.max(0, Math.min(startMs, totalMsRef.current)) }
            : s,
        ),
      );
    },
    [requestHistoryPush],
  );

  /** v5.0: patch an SFX placement (volume slider in the media panel). */
  const handleUpdateSfx = useCallback(
    (id: string, patch: Partial<SfxItem>) => {
      requestHistoryPush(500);
      setSfxItems((prev) =>
        prev.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      );
    },
    [requestHistoryPush],
  );

  /** v5.0: remove an SFX placement (pill × / Alt+click / Delete). */
  const handleRemoveSfx = useCallback(
    (id: string) => {
      requestHistoryPush();
      setSfxItems((prev) => prev.filter((s) => s.id !== id));
    },
    [requestHistoryPush],
  );

  /**
   * v5.1: build the self-contained project document — the EXACT v5.0
   * serialization, shared by the browser download flow and the native
   * saveProject/saveProjectAs bridges (main.js persists this doc verbatim).
   */
  const buildProjectDoc = useCallback(async (): Promise<ProjectFile | null> => {
    let audioFile: File | null = null;
    if (audioTrack) {
      try {
        const resp = await fetch(audioTrack.url);
        const blob = await resp.blob();
        audioFile = new File([blob], audioTrack.fileName, {
          type: blob.type || "audio/mpeg",
        });
      } catch {
        audioFile = null;
      }
    }
    return await buildProjectFile({
      // v5.0: entries carry their mediaType so videos round-trip as videos.
      images: items.map((it) => ({
        id: it.id,
        file: it.file,
        mediaType: it.mediaType,
      })),
      audio: audioFile,
      subtitles: subtitles
        ? { fileName: subtitles.fileName, cues: subtitles.cues }
        : null,
      headlines: headlineItems,
      overrides,
      motionOverrides,
      watermark: watermarkImage
        ? {
            image: { id: watermarkImage.id, file: watermarkImage.file },
            settings: watermarkSettings,
          }
        : null,
      // v5.0: multi-track session — edits, SFX placements, video durations.
      itemEdits,
      sfxItems,
      videoDurations,
      settings: {
        kenBurns,
        video: settings,
        caption: captionSettings,
        audio: audioSettings,
        whisperLanguage,
        transition: transitionSettings,
      },
    });
  }, [
    items,
    audioTrack,
    subtitles,
    headlineItems,
    overrides,
    motionOverrides,
    kenBurns,
    settings,
    captionSettings,
    audioSettings,
    whisperLanguage,
    transitionSettings,
    watermarkImage,
    watermarkSettings,
    itemEdits,
    sfxItems,
    videoDurations,
  ]);

  const saveProject = useCallback(async () => {
    try {
      if (items.length === 0) {
        toast.error("Nothing to save yet", {
          description: "Add images first — the project stores your full storyboard.",
        });
        return;
      }
      const project = await buildProjectDoc();
      if (!project) return;

      // v5.1: native save — direct write once a path is known, save dialog
      // on the first save. A null result = user cancelled → silent.
      const api = window.electronAPI;
      if (api?.saveProject) {
        const r = await api.saveProject({
          doc: project,
          currentPath: currentProjectPath,
        });
        if (r) {
          setCurrentProjectPath(r.path);
          setCurrentProjectName(r.name);
          toast.success(`Project saved — ${r.name}`, {
            description: r.path,
          });
        }
        return;
      }

      // Browser fallback — EXACTLY the v4.2/v5.0 download flow.
      const name = downloadProjectFile(project);
      const imgs = project.images.length;
      const vids = project.images.filter((i) => i.mediaType === "video").length;
      toast.success(`Project saved — ${name}`, {
        description: `${imgs} media item${imgs === 1 ? "" : "s"}${
          vids ? ` (${vids} video${vids === 1 ? "" : "s"})` : ""
        }${
          project.audio ? " + audio" : ""
        }${
          project.subtitles ? " + captions" : ""
        }${
          project.headlines.length ? ` + ${project.headlines.length} headline` : ""
        }${
          sfxItems.length ? ` + ${sfxItems.length} SFX` : ""
        } — fully self-contained .json`,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Project save failed");
    }
  }, [items, buildProjectDoc, currentProjectPath, sfxItems]);

  /** v5.1: Save As — always opens the native dialog; browser falls back to
   *  the download flow (there is no meaningful "as" in a download). */
  const saveProjectAs = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.saveProjectAs) {
      await saveProject();
      return;
    }
    try {
      if (items.length === 0) {
        toast.error("Nothing to save yet", {
          description: "Add images first — the project stores your full storyboard.",
        });
        return;
      }
      const project = await buildProjectDoc();
      if (!project) return;
      const r = await api.saveProjectAs({ doc: project });
      if (r) {
        setCurrentProjectPath(r.path);
        setCurrentProjectName(r.name);
        toast.success(`Project saved — ${r.name}`, {
          description: r.path,
        });
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Project save failed");
    }
  }, [items, buildProjectDoc, saveProject]);

  /**
   * v5.1: loadProject accepts a browser File OR an already-parsed native doc
   * (electronAPI.openProject hands back { path, name, doc }). Both feed the
   * SAME parse/validation path — parseProjectFile wraps parseProjectDoc.
   * Native identity (path/name) is set by the CALLER after this resolves;
   * loading always clears the previous identity first.
   */
  const loadProject = useCallback(
    async (source: File | { doc: unknown }, displayName?: string) => {
      try {
        const loaded =
          source instanceof File
            ? await parseProjectFile(source)
            : await parseProjectDoc((source as { doc: unknown }).doc);
        const { project } = loaded;
        const shownName =
          displayName ?? (source instanceof File ? source.name : "project");

        // v5.1: the loaded session is not yet tied to a file on disk.
        setCurrentProjectPath(null);
        setCurrentProjectName(null);

        // Snapshot the PRE-load session so Ctrl+Z restores it fully
        // (object URLs are kept alive for exactly this).
        requestHistoryPush(400);

        // Rebuild media items with their SAVED ids (so duration overrides,
        // itemEdits and Ken Burns direction hashing map 1:1). Old media URLs
        // stay alive for undo; the unmount cleanup revokes everything.
        const restored: MediaItem[] = loaded.imageFiles.map((entry) => ({
          id: entry.id,
          file: entry.file,
          url: trackUrl(URL.createObjectURL(entry.file)),
          mediaType: entry.mediaType === "video" ? "video" : "image",
        }));
        setItems(restored);

        // v5.0: restore the multi-track session BEFORE the probes land — the
        // saved videoDurations make the timeline immediately correct, then
        // fresh probes (below) confirm/refresh durations + dims + posters.
        setItemEdits(
          project.itemEdits && typeof project.itemEdits === "object"
            ? project.itemEdits
            : {},
        );
        setSfxItems(Array.isArray(project.sfxItems) ? project.sfxItems : []);
        setVideoDurations(
          project.videoDurations && typeof project.videoDurations === "object"
            ? project.videoDurations
            : {},
        );
        // Probe restored videos (durations/dims/thumbnails) — async, never
        // blocks the session; saved durations cover the gap meanwhile.
        // v5.2: the project file carries an explicit aspect choice — the
        // first-video auto-match stays disarmed for loaded projects.
        autoAspectRef.current = true;
        for (const it of restored) {
          if (it.mediaType === "video") probeVideoItem(it);
        }

        // Audio.
        if (loaded.audioFile) {
          const url = trackUrl(URL.createObjectURL(loaded.audioFile));
          clearWaveform();
          const a = document.createElement("audio");
          a.preload = "metadata";
          a.onloadedmetadata = () => {
            const dur =
              a.duration && Number.isFinite(a.duration) ? a.duration * 1000 : null;
            setAudioTrack((p) =>
              p && p.url === url ? { ...p, durationMs: dur } : p,
            );
          };
          a.src = url;
          setAudioTrack({
            fileName: loaded.audioFile.name,
            url,
            durationMs: null,
          });
        } else {
          setAudioTrack(null);
          clearWaveform();
        }

        // Subtitles.
        if (project.subtitles && loaded.srtText) {
          setSubtitles({
            fileName: project.subtitles.fileName,
            cues: project.subtitles.cues,
            rawText: loaded.srtText,
          });
        } else {
          setSubtitles(null);
        }

        // Watermark (v4.4).
        if (loaded.watermarkFile) {
          const url = trackUrl(URL.createObjectURL(loaded.watermarkFile.file));
          setWatermarkImage({
            id: loaded.watermarkFile.id,
            file: loaded.watermarkFile.file,
            url,
            mediaType: "image",
          });
        } else {
          setWatermarkImage(null);
        }
        setWatermarkSettings(
          project.watermark?.settings || defaultWatermarkSettings(),
        );

        // Settings + headlines + overrides.
        setKenBurns(project.settings.kenBurns);
        setSettings(project.settings.video);
        setCaptionSettings(project.settings.caption);
        setAudioSettings(project.settings.audio);
        setWhisperLanguage(project.settings.whisperLanguage || "auto");
        setHeadlineItems(Array.isArray(project.headlines) ? project.headlines : []);
        setOverrides(
          project.overrides && typeof project.overrides === "object"
            ? project.overrides
            : {},
        );
        setMotionOverrides(
          project.motionOverrides &&
            typeof project.motionOverrides === "object"
            ? (project.motionOverrides as Record<string, KenBurnsDirection>)
            : {},
        );
        setTransitionSettings(project.settings.transition || defaultTransitionSettings());

        // Rewind + stop.
        currentMsRef.current = 0;
        setCurrentMs(0);
        setIsPlaying(false);

        const imgs = restored.length;
        const vids = restored.filter((r) => r.mediaType === "video").length;
        toast.success(
          `Project loaded — ${imgs} media item${imgs === 1 ? "" : "s"}${
            vids ? ` (${vids} video${vids === 1 ? "" : "s"})` : ""
          }`,
          {
            description: `${shownName}${
              loaded.audioSkipped ? " · audio skipped (>25MB)" : ""
            }${
              loaded.videoSkipped
                ? " · video skipped (too large to inline at save time)"
                : ""
            }${
              project.sfxItems?.length
                ? ` · ${project.sfxItems.length} SFX restored`
                : ""
            }`,
          },
        );
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Project load failed");
      }
    },
    [requestHistoryPush, trackUrl, clearWaveform, probeVideoItem],
  );

  /**
   * v5.1: open a project — native dialog (with recents) when the bridge is
   * present, browser file picker otherwise. Feeds the result through the
   * EXISTING loadProject parse path and adopts the on-disk identity.
   */
  const handleOpenProject = useCallback(async () => {
    const api = window.electronAPI;
    if (api?.openProject) {
      try {
        const r = await api.openProject();
        if (!r) return; // cancelled — silent
        await loadProject({ doc: r.doc }, r.name);
        setCurrentProjectPath(r.path);
        setCurrentProjectName(r.name);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Project open failed");
      }
      return;
    }
    openProjectPicker();
  }, [loadProject, openProjectPicker]);

  /**
   * v5.1: new project — confirm, then reset the session to the initial-load
   * state (empty media/captions/headlines/edits/SFX, no project identity).
   * Settings stay (they are app-level persisted prefs, like the v5.0 load
   * flow's fallback) and Ctrl+Z restores everything that was cleared.
   */
  const newProject = useCallback(() => {
    const hasSession =
      items.length > 0 ||
      audioTrack != null ||
      subtitles != null ||
      headlineItems.length > 0 ||
      sfxItems.length > 0;
    if (
      hasSession &&
      !window.confirm(
        "Start a new project? Unsaved changes in the current session are cleared (Ctrl+Z can restore them).",
      )
    ) {
      return;
    }
    requestHistoryPush();
    setItems([]);
    setOverrides({});
    setMotionOverrides({});
    setSubtitles(null);
    setHeadlineItems([]);
    setAudioTrack(null);
    setItemEdits({});
    setSfxItems([]);
    setVideoDurations({});
    // v5.1: stale per-item probe caches keyed by the (now removed) ids.
    setVideoDims({});
    setVideoThumbnails({});
    // v5.2: fresh project → re-arm the first-video aspect auto-match.
    autoAspectRef.current = false;
    setWatermarkImage(null);
    clearBeatInfo();
    clearWaveform();
    setCurrentProjectPath(null);
    setCurrentProjectName(null);
    currentMsRef.current = 0;
    setCurrentMs(0);
    setIsPlaying(false);
    toast.success("New project", {
      description: "Clean timeline — add media to start editing.",
    });
  }, [
    items.length,
    audioTrack,
    subtitles,
    headlineItems.length,
    sfxItems.length,
    requestHistoryPush,
    clearBeatInfo,
    clearWaveform,
  ]);

  // Keep the v5.1 menu-handler refs on the latest closures (the menu
  // registrations in the Electron effect bind once).
  useEffect(() => {
    saveProjectRef.current = () => void saveProject();
    saveProjectAsRef.current = () => void saveProjectAs();
    openProjectRef.current = () => void handleOpenProject();
    newProjectRef.current = newProject;
  }, [saveProject, saveProjectAs, handleOpenProject, newProject]);

  const seek = useCallback(
    (ms: number) => {
      const clamped = Math.max(0, Math.min(ms, totalMsRef.current));
      currentMsRef.current = clamped;
      setCurrentMs(clamped);
      // Sync audio position
      if (audioRef.current) {
        audioRef.current.currentTime = clamped / 1000;
      }
      // v5.0: SFX sources stop + reschedule at the new playhead (the async
      // schedule self-aborts when superseded, so scrub bursts are cheap).
      if (isPlayingRef.current) void scheduleSfxFrom(clamped);
      else stopSfxSources();
    },
    [scheduleSfxFrom, stopSfxSources],
  );

  const togglePlay = useCallback(() => {
    if (segmentsRef.current.length === 0) return;
    setIsPlaying((p) => {
      if (!p && currentMsRef.current >= totalMsRef.current) {
        currentMsRef.current = 0;
        setCurrentMs(0);
      }
      return !p;
    });
  }, []);

  const stepSegment = useCallback(
    (dir: -1 | 1) => {
      const segs = segmentsRef.current;
      if (!segs.length) return;
      const cur = segmentAtTime(segs, currentMsRef.current);
      const idx = cur ? segs.findIndex((s) => s.id === cur.id) : -1;
      let target: MediaSegment | undefined;
      if (dir === 1)
        target = segs[Math.min(segs.length - 1, idx + 1)] ?? segs[0];
      else target = segs[Math.max(0, idx - 1)] ?? segs[0];
      if (target) seek(target.startMs);
    },
    [seek],
  );

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // ---- v5.1 clip tools for the global keyboard handler (ref-synced so the
  // key listener never re-binds — the exportRef pattern).
  const removeActiveSegment = useCallback(() => {
    const seg = activeSegment;
    if (!seg) return;
    removeItem(seg.id);
  }, [activeSegment, removeItem]);
  const splitAtPlayheadRef = useRef(splitAtPlayhead);
  const removeActiveRef = useRef(removeActiveSegment);
  useEffect(() => {
    splitAtPlayheadRef.current = splitAtPlayhead;
    removeActiveRef.current = removeActiveSegment;
  }, [splitAtPlayhead, removeActiveSegment]);

  // ---- Keyboard shortcuts (production-ready transport + undo/redo) -----
  // Space: play/pause · ←/→: seek ±1s · Shift+←/→: prev/next segment
  // Ctrl/Cmd+Z: undo · Ctrl/Cmd+Shift+Z / Ctrl+Y: redo
  // v5.1: S = split at playhead · Delete/Backspace = remove active clip.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Don't hijack typing in inputs.
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        redo();
      } else if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (e.shiftKey) stepSegment(1);
        else seek(currentMsRef.current + 1000);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (e.shiftKey) stepSegment(-1);
        else seek(Math.max(0, currentMsRef.current - 1000));
      } else if (e.key === "Home") {
        e.preventDefault();
        seek(0);
      } else if ((e.key === "s" || e.key === "S") && !mod) {
        // v5.1: split the active base clip at the playhead (one undo step).
        e.preventDefault();
        splitAtPlayheadRef.current();
      } else if (
        (e.key === "Delete" || e.key === "Backspace") &&
        !mod
      ) {
        // v5.1: remove the active clip (guarded above against inputs).
        e.preventDefault();
        removeActiveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, seek, stepSegment, undo, redo]);

  // ---- Cleanup object URLs on unmount -------------------------------------
  // URLs are deliberately kept alive during the whole session so undo can
  // restore removed media byte-perfect; this is the single revocation point.
  // v5.0: live SFX sources are stopped too (the AudioContext + buffer cache
  // are module-lifetime singletons, harmless to leave running muted-free).
  useEffect(() => {
    const urls = urlsRef.current;
    return () => {
      urls.forEach((u) => {
        try {
          URL.revokeObjectURL(u);
        } catch {
          /* already gone */
        }
      });
      urls.clear();
      stopSfxSources();
    };
  }, [stopSfxSources]);

  const allSkipped = useMemo(
    () => [...skippedUnparseable, ...timeline.skipped],
    [skippedUnparseable, timeline.skipped],
  );

  // ---- Settings-change handlers (history-aware wrappers, v4.3) ----------
  // Continuous inputs (sliders, selects) push one debounced pre-change
  // snapshot per burst so Ctrl+Z steps back in usable increments.
  const handleKenBurnsChange = useCallback(
    (v: KenBurnsConfig) => {
      requestHistoryPush(500);
      setKenBurns(v);
    },
    [requestHistoryPush],
  );
  const handleSettingsChange = useCallback(
    (v: VideoSettings) => {
      requestHistoryPush(500);
      setSettings(v);
    },
    [requestHistoryPush],
  );
  const handleAudioSettingsChange = useCallback(
    (v: AudioSettings) => {
      requestHistoryPush(500);
      setAudioSettings(v);
    },
    [requestHistoryPush],
  );
  const handleCaptionSettingsChange = useCallback(
    (v: CaptionSettings) => {
      requestHistoryPush(500);
      setCaptionSettings(v);
    },
    [requestHistoryPush],
  );
  const handleTransitionChange = useCallback(
    (v: TransitionSettings) => {
      requestHistoryPush(500);
      setTransitionSettings(v);
    },
    [requestHistoryPush],
  );
  const handleWhisperLanguageChange = useCallback(
    (lang: string) => {
      requestHistoryPush();
      setWhisperLanguage(lang);
    },
    [requestHistoryPush],
  );

  // ---- v5.2 resizable panel layout (task 3-b) ------------------------------
  // Splitter-driven panel widths + timeline height, persisted separately
  // from framefuse.settings.v50 (layout concern, not settings — see
  // src/components/ResizableSplitters.tsx). Below 1024px window width the
  // hook reports compact and the fixed v5.1 layout applies (splitters hidden).
  const layout = useResizableLayout();

  // TimelineRuler's internal v5 gate (new v5 props present) is always true —
  // page.tsx unconditionally passes onEditItem / sfxItems / onMoveSfx /
  // onRemoveSfx / videoDurations — so the 4-lane timeline always takes the
  // resizable height in non-compact mode. Legacy v4.9 single-track (fixed
  // 120/140px inside TimelineRuler) keeps its auto height via compact branch.
  const timelineIsV5 = true;

  const debug = {
    imageCount: timeline.segments.length,
    mode: timeline.mode,
    totalMs: timeline.totalMs,
    currentMs,
    activeSegment: activeSegment?.fileName ?? null,
    inElectron,
  };

  return (
    <div
      className="flex h-screen w-screen flex-col overflow-hidden"
      style={{ backgroundColor: "#0a0a0a", color: "#e4e4e7" }}
    >
      <Header
        mode={timeline.mode}
        imageCount={timeline.segments.length}
        isExporting={isExporting}
        exportProgress={exportProgress}
        lastExport={lastExport}
        inElectron={inElectron}
        onExport={handleExport}
        onCancel={handleCancel}
        canUndo={historyState.canUndo}
        canRedo={historyState.canRedo}
        onUndo={undo}
        onRedo={redo}
        settings={settings}
        totalMs={timeline.totalMs}
        projectName={currentProjectName}
      />

      {/* 3-column grid — v5.2 (task 3-b): columns resizable via splitters
          (6px gutters), persisted in framefuse.layout.v52. Below 1024px the
          hook reports compact → fixed 300px | 1fr | 320px, splitters hidden. */}
      <main
        className="grid min-h-0 flex-1 overflow-hidden"
        style={{
          gridTemplateColumns: layout.gridTemplateColumns,
          backgroundColor: "#0a0a0a",
        }}
      >
        {/* Left column — Media Panel (300px) */}
        <section
          className="min-h-0 overflow-y-auto overflow-x-hidden border-r"
          style={{
            borderColor: "#27272a",
            backgroundColor: "#121214",
            boxShadow: "inset 1px 0 0 rgba(255,255,255,0.02)",
          }}
        >
          <MediaPanel
            segments={timeline.segments}
            mode={timeline.mode}
            audioTrack={audioTrack}
            subtitles={subtitles}
            skipped={allSkipped}
            warnings={timeline.warnings}
            transition={transitionSettings}
            onAddFiles={addFiles}
            onAddAudioFile={addAudio}
            onAddSubtitleFile={addSubtitles}
            onLoadSamples={loadSamples}
            openImagePicker={openImagePicker}
            openAudioPicker={openAudioPicker}
            openSubtitlePicker={openSubtitlePicker}
            onRemoveAudio={removeAudio}
            onRemoveSubtitles={removeSubtitles}
            onRemove={removeItem}
            onOverride={overrideDuration}
            onClearOverride={clearOverride}
            onReorder={reorderItem}
            onMoveTo={moveItemTo}
            onDuplicate={duplicateItem}
            onBoundaryStyle={handleBoundaryStyle}
            onClearBoundaryOverrides={clearBoundaryOverrides}
            onSaveProject={saveProject}
            onOpenProject={handleOpenProject}
            onLoadProjectFile={loadProject}
            beatInfo={beatInfo}
            beatBusy={beatBusy}
            onDetectBeats={handleDetectBeats}
            onSnapToBeats={handleSnapToBeats}
            onFitToAudio={handleFitToAudio}
            beatStride={beatStride}
            onBeatStrideChange={(n) => setBeatStride(n as 1 | 2 | 4 | 8)}
            motionOverrides={motionOverrides}
            onSetMotion={setSegmentMotion}
            onClearMotionOverrides={clearAllMotionOverrides}
            mediaView={mediaView}
            onMediaViewChange={(v) => setMediaView(v)}
            activeId={activeSegment?.id ?? null}
            onSelectSegment={(id) => {
              const s = timeline.segments.find((x) => x.id === id);
              if (s) seek(s.startMs);
            }}
            itemEdits={itemEdits}
            videoDurations={videoDurations}
            onSetItemEdit={handleSetItemEdit}
            sfxItems={sfxItems}
            onAddSfx={handleAddSfx}
            onUpdateSfx={handleUpdateSfx}
            onRemoveSfx={handleRemoveSfx}
            currentMs={currentMs}
          />
        </section>

        {/* v5.2 (task 3-b): col splitter — drag to resize the media panel. */}
        {!layout.compact && <Splitter {...layout.media} />}

        {/* Center column — Preview (flex-1) + resizable Timeline */}
        <section
          className="flex min-h-0 flex-col overflow-hidden"
          style={{ backgroundColor: "#0a0a0a" }}
        >
          <div className="min-h-0 flex-1 overflow-hidden">
            <PreviewPanel
              segments={timeline.segments}
              images={images}
              videoUrls={videoUrls}
              totalMs={timeline.totalMs}
              currentMs={currentMs}
              isPlaying={isPlaying}
              kenBurns={kenBurns}
              aspect={settings.aspect}
              activeSegment={activeSegment}
              subtitles={subtitles}
              captionSettings={captionSettings}
              headlineItems={headlineItems}
              transition={transitionSettings}
              watermarkImage={watermarkImgEl}
              watermarkSettings={watermarkImage ? watermarkSettings : null}
              onSeek={seek}
              onTogglePlay={togglePlay}
              onStep={stepSegment}
              onSetMotion={(dir) => {
                const seg = activeSegment;
                if (!seg) return;
                setSegmentMotion(seg.id, dir);
                toast.success(`Motion pinned — ${dir}`, {
                  description: `Segment "${seg.fileName.slice(0, 42)}" now uses ${dir}. Undo (Ctrl+Z) restores it.`,
                });
              }}
              // ---- v5.2 preview overhaul wiring ----
              previewFit={settings.previewFit ?? "cover"}
              onPreviewFitChange={(fit) =>
                setSettings((prev) =>
                  prev.previewFit === fit ? prev : { ...prev, previewFit: fit },
                )
              }
              onMatchAspect={handleMatchAspect}
              canMatchAspect={canMatchAspect}
              onOverlayTransformChange={(segId, t) => {
                // Commit an on-canvas PiP edit (drag move / corner resize /
                // keyboard nudge) into the item's edit map — the same store
                // the timeline and export read. One history entry per commit.
                requestHistoryPush();
                applyItemEdit(segId, { overlay: t });
              }}
            />
          </div>
          {/* v5.2 (task 3-b): row splitter — drag to resize the timeline. */}
          {!layout.compact && <Splitter {...layout.timeline} />}

          {/* v5 4-lane timeline: explicit resizable height + custom scrollbar
              so tall lane stacks scroll (timelineIsV5 mirrors TimelineRuler's
              internal v5 gate — page.tsx always passes the v5 props). Compact
              or legacy v4.9 single-track keeps the auto/fixed height. */}
          <div
            className={
              "min-h-0 shrink-0" +
              (!layout.compact && timelineIsV5 ? " ff-timeline-scroll" : "")
            }
            style={
              !layout.compact && timelineIsV5
                ? { height: `${layout.timelineH}px` }
                : undefined
            }
          >
          <TimelineRuler
            segments={timeline.segments}
            totalMs={timeline.totalMs}
            currentMs={currentMs}
            mode={timeline.mode}
            activeId={activeSegment?.id ?? null}
            headlines={headlineItems}
            transition={transitionSettings}
            beats={beatInfo?.beatMs ?? null}
            waveform={waveform}
            onSeek={seek}
            onJumpToSegment={(id) => {
              // v4.9: filmstrip double-click — jump + a light selection cue
              // (the media card for this clip becomes active via the seek).
              const s = timeline.segments.find((x) => x.id === id);
              if (s) {
                seek(s.startMs + 5);
                toast.info(`Jumped to clip ${s.order + 1}`, {
                  description: `${fmtTimecode(s.startMs)} — ${s.fileName.slice(0, 48)}`,
                });
              }
            }}
            onEditItem={handleTimelineEdit}
            sfxItems={sfxItems}
            onMoveSfx={handleMoveSfx}
            onRemoveSfx={handleRemoveSfx}
            videoDurations={videoDurations}
            onSplit={splitAtPlayhead}
            onDuplicate={duplicateItem}
            onRemove={removeItem}
            activeSegment={activeSegment}
          />
          </div>
        </section>

        {/* v5.2 (task 3-b): col splitter — drag to resize the settings panel. */}
        {!layout.compact && <Splitter {...layout.settings} />}

        {/* Right column — Settings Panel (resizable, default 320px) */}
        <section
          className="min-h-0 overflow-y-auto overflow-x-hidden border-l"
          style={{
            borderColor: "#27272a",
            backgroundColor: "#121214",
            boxShadow: "inset -1px 0 0 rgba(255,255,255,0.02)",
          }}
        >
          <SettingsPanel
            kenBurns={kenBurns}
            settings={settings}
            audioSettings={audioSettings}
            transition={transitionSettings}
            onKenBurnsChange={handleKenBurnsChange}
            onSettingsChange={handleSettingsChange}
            onAudioSettingsChange={handleAudioSettingsChange}
            onTransitionChange={handleTransitionChange}
            watermarkImage={
              watermarkImage
                ? { url: watermarkImage.url, fileName: watermarkImage.file.name }
                : null
            }
            watermarkSettings={watermarkSettings}
            onWatermarkFile={setWatermarkFile}
            onWatermarkSettingsChange={handleWatermarkSettingsChange}
            openWatermarkPicker={openWatermarkPicker}
            captionSettings={captionSettings}
            onCaptionSettingsChange={handleCaptionSettingsChange}
            onApplyPreset={applyCaptionPreset}
            favoritePresets={favoritePresets}
            onToggleFavorite={toggleFavoritePreset}
            onExportSrt={exportSrtSidecar}
            onExportAss={exportAssSidecar}
            onExportVtt={exportVttSidecar}
            onExportVttWords={exportVttWordsSidecar}
            inElectron={inElectron}
            subtitles={subtitles}
            hasAudio={!!audioTrack}
            onGenerateCaptions={generateCaptionsFromAudio}
            whisperBusy={whisperBusy}
            whisperProgress={whisperProgress}
            whisperLanguage={whisperLanguage}
            onWhisperLanguageChange={handleWhisperLanguageChange}
            headlineItems={headlineItems}
            onAddHeadline={addHeadline}
            onUpdateHeadline={updateHeadline}
            onRemoveHeadline={removeHeadline}
            totalMs={timeline.totalMs}
            onRandomMix={handleRandomTransitionMix}
            boundaryCount={boundaryCount}
            debug={debug}
          />
        </section>
      </main>

      {/* Hidden file inputs (inline style, not className hidden) */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*,video/mp4,video/webm,video/quicktime,video/x-matroska,video/x-msvideo,.mp4,.webm,.mov,.mkv,.m4v,.avi"
        multiple
        style={{
          position: "absolute",
          opacity: 0,
          width: 1,
          height: 1,
          pointerEvents: "none",
        }}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          if (e.target.files) addFiles(Array.from(e.target.files));
          e.target.value = "";
        }}
      />
      <input
        ref={audioInputRef}
        type="file"
        accept="audio/*"
        style={{
          position: "absolute",
          opacity: 0,
          width: 1,
          height: 1,
          pointerEvents: "none",
        }}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const f = e.target.files?.[0];
          if (f) addAudio(f);
          e.target.value = "";
        }}
      />
      <input
        ref={subtitleInputRef}
        type="file"
        accept=".srt,text/plain,application/x-subrip"
        style={{
          position: "absolute",
          opacity: 0,
          width: 1,
          height: 1,
          pointerEvents: "none",
        }}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const f = e.target.files?.[0];
          if (f) addSubtitles(f);
          e.target.value = "";
        }}
      />
      <input
        ref={projectInputRef}
        type="file"
        accept=".json,.framefuse.json,application/json"
        style={{
          position: "absolute",
          opacity: 0,
          width: 1,
          height: 1,
          pointerEvents: "none",
        }}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const f = e.target.files?.[0];
          if (f) loadProject(f);
          e.target.value = "";
        }}
      />
      <input
        ref={watermarkInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif"
        style={{
          position: "absolute",
          opacity: 0,
          width: 1,
          height: 1,
          pointerEvents: "none",
        }}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const f = e.target.files?.[0];
          if (f) setWatermarkFile(f);
          e.target.value = "";
        }}
      />

      {/* Hidden audio element for preview playback (synced with timeline) */}
      {audioTrack && (
        <audio
          ref={audioRef}
          src={audioTrack.url}
          preload="auto"
          style={{ display: "none" }}
        />
      )}
    </div>
  );
}
