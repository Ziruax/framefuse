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
  parseFilename,
  segmentAtTime,
  type TimelineEntry,
} from "@/lib/merger/timeline";
import { exportNative, isElectron } from "@/lib/merger/native";
import { parseSrt, serializeSrt } from "@/lib/merger/subtitles";
import {
  transcribeWithWhisper,
  isWhisperAvailable,
  type WhisperProgress,
} from "@/lib/merger/whisper";
import {
  defaultAudioSettings,
  defaultCaptionSettings,
  defaultKenBurnsConfig,
  type AudioSettings,
  type AudioTrack,
  type CaptionSettings,
  type ExportProgress,
  type KenBurnsConfig,
  type MediaSegment,
  type SubtitleFile,
  type VideoSettings,
} from "@/lib/merger/types";
import { getCaptionPreset, getFontOption, CAPTION_PRESETS } from "@/lib/merger/captionPresets";

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
  const persisted = useMemo(() => loadPersisted(), []);
  const [kenBurns, setKenBurns] = useState<KenBurnsConfig>(
    persisted.kenBurns ?? defaultKenBurnsConfig(),
  );
  const [settings, setSettings] = useState<VideoSettings>(
    persisted.settings ?? {
      aspect: "16:9",
      resolution: "1080p",
      bitrateMbps: 8,
      fps: 30,
    },
  );
  const [captionSettings, setCaptionSettings] = useState<CaptionSettings>(
    persisted.captionSettings ?? defaultCaptionSettings(),
  );
  const [audioSettings, setAudioSettings] = useState<AudioSettings>(
    persisted.audio ?? defaultAudioSettings(),
  );

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
    if (captionSettings.enabled && (!subtitles || subtitles.cues.length === 0)) {
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
    setItems((prev) => {
      const next = [...prev];
      for (const f of files) {
        next.push({ id: genId(), file: f, url: URL.createObjectURL(f) });
      }
      return next;
    });
    toast.success(`Added ${files.length} image${files.length === 1 ? "" : "s"}`);
  }, []);

  const addAudio = useCallback((file: File) => {
    setAudioTrack((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      const url = URL.createObjectURL(file);
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
  }, []);

  // ---- Subtitle (.srt) loading -------------------------------------------
  const addSubtitles = useCallback(
    (file: File) => {
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
    [],
  );

  const removeSubtitles = useCallback(() => {
    setSubtitles(null);
  }, []);

  // ---- Caption preset selection — make presets BEHAVE like their names --
  // Selecting a preset applies its signature wordMode + animation (unless
  // the user pinned one) + preferred font, so "Hormozi" actually slams
  // single words and "Karaoke" actually fills word-by-word.
  const applyCaptionPreset = useCallback((presetId: string) => {
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
  }, []);

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
  // Whisper language: "auto" = auto-detect, or a 2-letter code like "en".
  const [whisperLanguage, setWhisperLanguage] = useState<string>(
    persisted.whisperLanguage ?? "auto",
  );

  // ---- Persist settings on change ----------------------------------------
  useEffect(() => {
    const payload: PersistedSettings = {
      kenBurns,
      settings,
      captionSettings,
      audio: audioSettings,
      whisperLanguage,
    };
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(payload));
    } catch {
      /* storage full / private mode — non-fatal */
    }
  }, [kenBurns, settings, captionSettings, audioSettings, whisperLanguage]);

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
  }, [audioTrack, whisperBusy, whisperLanguage]);

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
    setAudioTrack((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
  }, []);

  const removeItem = useCallback((id: string) => {
    setItems((prev) => {
      const target = prev.find((i) => i.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((i) => i.id !== id);
    });
    setOverrides((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const overrideDuration = useCallback((id: string, durationMs: number) => {
    setOverrides((prev) => ({ ...prev, [id]: durationMs }));
  }, []);

  const clearOverride = useCallback((id: string) => {
    setOverrides((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const reorderItem = useCallback((id: string, dir: -1 | 1) => {
    setItems((prev) => {
      const idx = prev.findIndex((i) => i.id === id);
      if (idx < 0) return prev;
      const target = idx + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }, []);

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

  // ---- Keyboard shortcuts (production-ready transport) ------------------
  // Space: play/pause · ←/→: seek ±1s · Shift+←/→: prev/next segment.
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
      if (e.key === " " || e.code === "Space") {
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
  }, [togglePlay, seek, stepSegment]);

  // ---- Cleanup object URLs on unmount -------------------------------------
  useEffect(() => {
    return () => {
      items.forEach((i) => URL.revokeObjectURL(i.url));
      if (audioTrack) URL.revokeObjectURL(audioTrack.url);
    };
  }, []);

  const allSkipped = useMemo(
    () => [...skippedUnparseable, ...timeline.skipped],
    [skippedUnparseable, timeline.skipped],
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
            onKenBurnsChange={setKenBurns}
            onSettingsChange={setSettings}
            onAudioSettingsChange={setAudioSettings}
            captionSettings={captionSettings}
            onCaptionSettingsChange={setCaptionSettings}
            onApplyPreset={applyCaptionPreset}
            onExportSrt={exportSrtSidecar}
            onExportAss={exportAssSidecar}
            inElectron={inElectron}
            subtitles={subtitles}
            hasAudio={!!audioTrack}
            onGenerateCaptions={generateCaptionsFromAudio}
            whisperBusy={whisperBusy}
            whisperProgress={whisperProgress}
            whisperLanguage={whisperLanguage}
            onWhisperLanguageChange={setWhisperLanguage}
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
