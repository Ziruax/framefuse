"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { toast } from "sonner";
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
import type {
  AudioTrack,
  ExportProgress,
  KenBurnsConfig,
  MediaSegment,
  VideoSettings,
} from "@/lib/merger/types";

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

export default function Page() {
  // ---- Source data --------------------------------------------------------
  const [items, setItems] = useState<MediaItem[]>([]);
  const [audioTrack, setAudioTrack] = useState<AudioTrack | null>(null);
  const [overrides, setOverrides] = useState<Record<string, number>>({});

  // ---- Settings -----------------------------------------------------------
  const [kenBurns, setKenBurns] = useState<KenBurnsConfig>({
    enabled: true,
    intensity: 35,
    direction: "random",
  });
  const [settings, setSettings] = useState<VideoSettings>({
    aspect: "16:9",
    resolution: "1080p",
    bitrateMbps: 8,
    fps: 30,
  });

  // ---- Playback -----------------------------------------------------------
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const currentMsRef = useRef(0);

  // ---- Export -------------------------------------------------------------
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [lastExport, setLastExport] = useState<LastExport | null>(null);
  const [inElectron, setInElectron] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // ---- File pickers (page-level so the app menu can trigger them) ---------
  const imageInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const openImagePicker = useCallback(() => imageInputRef.current?.click(), []);
  const openAudioPicker = useCallback(() => audioInputRef.current?.click(), []);

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
    () => (timeline.segments.length ? segmentAtTime(timeline.segments, currentMs) : null),
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
  totalMsRef.current = timeline.totalMs;
  const segmentsRef = useRef(timeline.segments);
  segmentsRef.current = timeline.segments;

  // ---- Playback rAF loop --------------------------------------------------
  useEffect(() => {
    if (!isPlaying) return;
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
        return;
      }
      currentMsRef.current = m;
      setCurrentMs(m);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying]);

  // ---- Detect Electron + wire app-menu accelerators -----------------------
  const exportRef = useRef<() => void>(() => {});
  exportRef.current = async () => {
    if (timeline.segments.length === 0) {
      toast.error("Add images first");
      return;
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
        totalMs: timeline.totalMs,
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
      if (ac.signal.aborted) toast("Export cancelled");
      else toast.error(msg || "Export failed");
    } finally {
      setIsExporting(false);
      setExportProgress(null);
      abortRef.current = null;
    }
  };

  useEffect(() => {
    const electron = isElectron();
    setInElectron(electron);
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
        const dur = a.duration && Number.isFinite(a.duration) ? a.duration * 1000 : null;
        setAudioTrack((p) => (p && p.url === url ? { ...p, durationMs: dur } : p));
      };
      a.src = url;
      return { fileName: file.name, url, durationMs: null };
    });
    toast.success(`Audio: ${file.name}`);
  }, []);

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
          files.push(new File([blob], name, { type: blob.type || "image/jpeg" }));
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
      if (dir === 1) target = segs[Math.min(segs.length - 1, idx + 1)] ?? segs[0];
      else target = segs[Math.max(0, idx - 1)] ?? segs[0];
      if (target) seek(target.startMs);
    },
    [seek],
  );

  const handleExport = useCallback(() => {
    exportRef.current();
  }, []);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

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
    <div className="flex h-screen flex-col overflow-hidden bg-[#0a0a0a] text-zinc-100">
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

      <main className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)_290px]">
        <section className="min-h-0 overflow-hidden border-r border-zinc-800">
          <MediaPanel
            segments={timeline.segments}
            mode={timeline.mode}
            audioTrack={audioTrack}
            skipped={allSkipped}
            warnings={timeline.warnings}
            onAddFiles={addFiles}
            onLoadSamples={loadSamples}
            openImagePicker={openImagePicker}
            openAudioPicker={openAudioPicker}
            onRemoveAudio={removeAudio}
            onRemove={removeItem}
            onOverride={overrideDuration}
            onClearOverride={clearOverride}
            onReorder={reorderItem}
          />
        </section>

        <section className="flex min-h-0 flex-col overflow-hidden">
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

        <section className="min-h-0 overflow-hidden border-l border-zinc-800">
          <SettingsPanel
            kenBurns={kenBurns}
            settings={settings}
            onKenBurnsChange={setKenBurns}
            onSettingsChange={setSettings}
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
    </div>
  );
}
