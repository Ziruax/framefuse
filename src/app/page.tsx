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
import {
  buildTimeline,
  fmtBytes,
  fmtTimecode,
  parseFilename,
  segmentAtTime,
  type TimelineEntry,
} from "@/lib/merger/timeline";
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
  type KenBurnsConfig,
  type MediaSegment,
  type SubtitleFile,
  type TransitionSettings,
  type TransitionStyle,
  type VideoSettings,
  type WatermarkSettings,
} from "@/lib/merger/types";
import { getCaptionPreset, getFontOption, CAPTION_PRESETS } from "@/lib/merger/captionPresets";
import {
  buildProjectFile,
  downloadProjectFile,
  parseProjectFile,
} from "@/lib/merger/project";
import { decodeAudioPeaks, type WaveformData } from "@/lib/merger/waveform";

interface MediaItem {
  id: string;
  file: File;
  url: string;
}

let _idCounter = 0;
function genId(): string {
  _idCounter += 1;
  return `f${Date.now().toString(36)}_${_idCounter.toString(36)}`;
}

// ---- Settings persistence (production-ready: survive restarts) ----------
const LS_KEY = "framefuse.settings.v41";

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
}

function loadPersisted(): Partial<PersistedSettings> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
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

  // Restore persisted settings AFTER mount (client-only, hydration-safe).
  // Reading localStorage in the state initializers made the first client
  // render differ from the prerendered HTML (React #418) whenever settings
  // were saved on a previous run. Defaults render first, then the saved
  // settings swap in one frame later — the intentional one-shot sync with
  // the localStorage "external system".
   
  useEffect(() => {
    const p = loadPersisted();
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
        skipped.push(it.file.name);
        return;
      }
      ents.push({
        id: it.id,
        fileName: it.file.name,
        file: it.file,
        parsed,
        order,
        thumbnailUrl: it.url,
      });
    });
    return { entries: ents, skippedUnparseable: skipped };
  }, [items]);

  const timeline = useMemo(
    () => buildTimeline(entries, overrides, kenBurns),
    [entries, overrides, kenBurns],
  );

  const activeSegment = useMemo(
    () =>
      timeline.segments.length
        ? segmentAtTime(timeline.segments, currentMs)
        : null,
    [timeline.segments, currentMs],
  );

  // ---- Undo / Redo (v4.3) — snapshot history of the editable session ------
  // Object URLs are NEVER revoked mid-session (only on unmount) so a removed
  // segment can always be restored byte-perfect by Ctrl+Z.
  interface HistorySnapshot {
    items: MediaItem[];
    overrides: Record<string, number>;
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
  // history flush reads this POST-mutation value).
  const stateRef = useRef<HistorySnapshot | null>(null);
  useEffect(() => {
    stateRef.current = {
      items,
      overrides,
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
    };
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
  ]);

  // Keep exportRef in sync so menu accelerators call the latest version
  useEffect(() => {
    exportRef.current = handleExport;
  }, [handleExport]);

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
      };
    }
    return undefined;
  }, [openImagePicker, openAudioPicker]);

  // ---- Handlers -----------------------------------------------------------
  const addFiles = useCallback((files: File[]) => {
    if (!files.length) return;
    requestHistoryPush();
    setItems((prev) => {
      const next = [...prev];
      for (const f of files) {
        next.push({ id: genId(), file: f, url: trackUrl(URL.createObjectURL(f)) });
      }
      return next;
    });
    toast.success(`Added ${files.length} image${files.length === 1 ? "" : "s"}`);
  }, [requestHistoryPush, trackUrl]);

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
      setWatermarkImage({ id: `wm_${genId()}`, file, url });
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
    };
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(payload));
    } catch {
      /* storage full / private mode — non-fatal */
    }
  }, [kenBurns, settings, captionSettings, audioSettings, whisperLanguage, headlineItems, transitionSettings, watermarkSettings, beatStride, favoritePresets]);

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

  /** Duplicate a media item right after the original (v4.2). Copies the
   *  file (same object) with a fresh id so it lands as its own timeline
   *  segment; duration overrides do NOT carry over (the copy re-parses). */
  const duplicateItem = useCallback((id: string) => {
    requestHistoryPush();
    setItems((prev) => {
      const idx = prev.findIndex((i) => i.id === id);
      if (idx < 0) return prev;
      const src = prev[idx];
      const copy: MediaItem = {
        id: genId(),
        file: src.file,
        url: trackUrl(URL.createObjectURL(src.file)),
      };
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      return next;
    });
    toast.success("Duplicated segment");
  }, [requestHistoryPush, trackUrl]);

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

  const saveProject = useCallback(async () => {
    try {
      if (items.length === 0) {
        toast.error("Nothing to save yet", {
          description: "Add images first — the project stores your full storyboard.",
        });
        return;
      }
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
      const project = await buildProjectFile({
        images: items.map((it) => ({ id: it.id, file: it.file })),
        audio: audioFile,
        subtitles: subtitles
          ? { fileName: subtitles.fileName, cues: subtitles.cues }
          : null,
        headlines: headlineItems,
        overrides,
        watermark: watermarkImage
          ? {
              image: { id: watermarkImage.id, file: watermarkImage.file },
              settings: watermarkSettings,
            }
          : null,
        settings: {
          kenBurns,
          video: settings,
          caption: captionSettings,
          audio: audioSettings,
          whisperLanguage,
          transition: transitionSettings,
        },
      });
      const name = downloadProjectFile(project);
      const imgs = project.images.length;
      toast.success(`Project saved — ${name}`, {
        description: `${imgs} image${imgs === 1 ? "" : "s"}${
          project.audio ? " + audio" : ""
        }${
          project.subtitles ? " + captions" : ""
        }${
          project.headlines.length ? ` + ${project.headlines.length} headline` : ""
        } — fully self-contained .json`,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Project save failed");
    }
  }, [
    items,
    audioTrack,
    subtitles,
    headlineItems,
    overrides,
    kenBurns,
    settings,
    captionSettings,
    audioSettings,
    whisperLanguage,
    transitionSettings,
    watermarkImage,
    watermarkSettings,
  ]);

  const loadProject = useCallback(
    async (file: File) => {
      try {
        const loaded = await parseProjectFile(file);
        const { project } = loaded;

        // Snapshot the PRE-load session so Ctrl+Z restores it fully
        // (object URLs are kept alive for exactly this).
        requestHistoryPush(400);

        // Rebuild media items with their SAVED ids (so duration overrides
        // + Ken Burns direction hashing map 1:1). Old media URLs stay alive
        // for undo; the unmount cleanup revokes everything.
        const restored: MediaItem[] = loaded.imageFiles.map((entry) => ({
          id: entry.id,
          file: entry.file,
          url: trackUrl(URL.createObjectURL(entry.file)),
        }));
        setItems(restored);

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
        setTransitionSettings(project.settings.transition || defaultTransitionSettings());

        // Rewind + stop.
        currentMsRef.current = 0;
        setCurrentMs(0);
        setIsPlaying(false);

        const imgs = restored.length;
        toast.success(`Project loaded — ${imgs} image${imgs === 1 ? "" : "s"}`, {
          description: `${file.name}${
            loaded.audioSkipped ? " · audio skipped (>25MB)" : ""
          }`,
        });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Project load failed");
      }
    },
    [requestHistoryPush, trackUrl, clearWaveform],
  );

  const seek = useCallback((ms: number) => {
    const clamped = Math.max(0, Math.min(ms, totalMsRef.current));
    currentMsRef.current = clamped;
    setCurrentMs(clamped);
    // Sync audio position
    if (audioRef.current) {
      audioRef.current.currentTime = clamped / 1000;
    }
  }, []);

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

  // ---- Keyboard shortcuts (production-ready transport + undo/redo) -----
  // Space: play/pause · ←/→: seek ±1s · Shift+←/→: prev/next segment
  // Ctrl/Cmd+Z: undo · Ctrl/Cmd+Shift+Z / Ctrl+Y: redo.
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
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, seek, stepSegment, undo, redo]);

  // ---- Cleanup object URLs on unmount -------------------------------------
  // URLs are deliberately kept alive during the whole session so undo can
  // restore removed media byte-perfect; this is the single revocation point.
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
    };
  }, []);

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
      />

      {/* 3-column grid: 300px | 1fr | 320px */}
      <main
        className="grid min-h-0 flex-1 overflow-hidden"
        style={{
          gridTemplateColumns: "300px 1fr 320px",
          backgroundColor: "#0a0a0a",
        }}
      >
        {/* Left column — Media Panel (300px) */}
        <section
          className="min-h-0 overflow-y-auto overflow-x-hidden border-r"
          style={{
            borderColor: "#27272a",
            backgroundColor: "#121214",
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
            onOpenProject={openProjectPicker}
            onLoadProjectFile={loadProject}
            beatInfo={beatInfo}
            beatBusy={beatBusy}
            onDetectBeats={handleDetectBeats}
            onSnapToBeats={handleSnapToBeats}
            onFitToAudio={handleFitToAudio}
            beatStride={beatStride}
            onBeatStrideChange={(n) => setBeatStride(n as 1 | 2 | 4 | 8)}
          />
        </section>

        {/* Center column — Preview (flex-1) + Timeline (120px) */}
        <section
          className="flex min-h-0 flex-col overflow-hidden"
          style={{ backgroundColor: "#0a0a0a" }}
        >
          <div className="min-h-0 flex-1 overflow-hidden">
            <PreviewPanel
              segments={timeline.segments}
              images={images}
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
            />
          </div>
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
          />
        </section>

        {/* Right column — Settings Panel (320px) */}
        <section
          className="min-h-0 overflow-y-auto overflow-x-hidden border-l"
          style={{
            borderColor: "#27272a",
            backgroundColor: "#121214",
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
            debug={debug}
          />
        </section>
      </main>

      {/* Hidden file inputs (inline style, not className hidden) */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
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
