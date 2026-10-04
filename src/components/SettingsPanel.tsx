"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Zap,
  Film,
  Captions,
  Music,
  Rocket,
  ArrowLeftRight,
  BadgeCheck,
  Wand2,
  RotateCcw,
  FileText,
  FileDown,
  Loader2,
  Sparkles,
  Type,
  Plus,
  Trash2,
  Clock,
  Upload,
  Search,
  X,
  Star,
  Dices,
  AudioLines,
  Check,
  ChevronRight,
  Copy,
  Download,
  Cloud,
  KeyRound,
  ExternalLink,
  Eraser,
  ScanText,
  Mic,
  Languages,
  Play,
  Square,
  User,
  Users,
  Shuffle,
  PenLine,
  Activity,
  AlertTriangle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  AudioSettings,
  CaptionSettings,
  MusicClip,
  HeadlineItem,
  KenBurnsConfig,
  SubtitleFile,
  TransitionSettings,
  TransitionStyle,
  VideoSettings,
  WatermarkPosition,
  WatermarkSettings,
  GroqConfigPayload,
  TextRemovalSettings,
  TextRemovalMode,
  TextRemovalRegion,
  DubSettings,
  DubTrackResult,
  DubScriptLine,
  DubScriptResult,
  DubTranscriptResult,
} from "@/lib/merger/types";
import { TRANSITION_STYLE_INFO, QUALITY_PROFILES } from "@/lib/merger/types";
import type { KenBurnsDirection } from "@/lib/merger/types";
import {
  FONT_OPTIONS,
  getFontOption,
  presetsByCategory,
  getCaptionPreset,
  PRESET_CATEGORIES,
  type CaptionPreset,
} from "@/lib/merger/captionPresets";
import {
  HEADLINE_PRESETS,
  getHeadlinePreset,
} from "@/lib/merger/headlinePresets";
// v1.17 Stack Text: layout + kinetic-style preset vocabulary + the pure
// animation math (reused directly by the inline live preview).
import {
  STACK_LAYOUTS,
  STACK_STYLES,
  SIMPLE_STYLES,
  getStackStyle,
  isKineticStyle,
  stackUnitTransforms,
  STACK_FADE_OUT_MS,
  type StackLayoutId,
  type StackStyleId,
  type StackUnitTransform,
} from "@/lib/merger/stackTextPresets";
// v1.18 Kinetic Typography: the semantic composition engine's settings
// block (CaptionSettings.kinetic) + the live preview, which renders through
// the REAL engine (buildKineticPlan → drawKineticComposition — the same code
// path the canvas preview and the export run).
import {
  KINETIC_DEFAULTS,
  type KineticCaptionSettings,
  type KineticFamily,
  type KineticPlan,
  type KineticPresetSpec,
} from "@/lib/merger/kinetic/types";
import {
  KINETIC_PRESETS,
  KINETIC_FAMILY_LABELS,
  getKineticPreset,
} from "@/lib/merger/kinetic/presets";
import {
  buildKineticPlan,
  type KineticCueInput,
} from "@/lib/merger/kinetic/engine";
import { drawKineticComposition } from "@/lib/merger/kinetic/render";
import { ANIMATION_LABELS } from "@/lib/merger/captionAnimations";
import type { WhisperProgress } from "@/lib/merger/whisper";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
// v1.25: QWERTY (romanized) Hindi/Urdu detection for the voice pickers.
import { localeWantsTranslit } from "@/lib/translit";
// v1.26: speech transport (IPC-first, /api routes in the web preview) —
// the dub model catalog + the voice preview/synthesis calls below run in
// BOTH runtimes now.
import {
  fetchDubModels,
  ttsPreviewVoice,
  ttsSynthesizeShort,
} from "@/lib/speech-api";
// v1.20: AI Script Writer (Gemini default + Groq chat models) — mounted in
// the Audio tab, right after Voiceover.
import ScriptWriterSection from "./ScriptWriterSection";
// v1.25: shared Edge-TTS catalog hook (was in-file above VoiceoverSection).
import { useTtsVoices } from "./use-tts-voices";
// v1.25: AI Text-to-Speech Studio (Dubbing tab) + the shared voice-filter
// helpers the Voiceover picker reuses.
import TtsStudioSection, {
  filterTtsVoices,
  resolveQwertyText,
  StudioToggle,
  VoiceGenderChips,
  type VoiceGenderFilter,
} from "./TtsStudioSection";
// v1.15: burn-in text detection (tesseract.js) + STT engine routing.
import { detectTextRegions } from "@/lib/merger/textDetect";
// v1.15: STT engine routing (Groq cloud vs local) — an app-level device
// preference, never stored in project files.
import {
  GROQ_MODEL_OPTIONS,
  loadSttSettings,
  saveSttSettings,
} from "@/lib/merger/sttSettings";

// ---------------------------------------------------------------------------
// Whisper languages
// ---------------------------------------------------------------------------
const WHISPER_LANGUAGES: { value: string; label: string }[] = [
  { value: "auto", label: "Auto-detect" },
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "it", label: "Italian" },
  { value: "pt", label: "Portuguese" },
  { value: "nl", label: "Dutch" },
  { value: "ru", label: "Russian" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "zh", label: "Chinese" },
  { value: "ar", label: "Arabic" },
  { value: "hi", label: "Hindi" },
  { value: "ur", label: "Urdu" },
  { value: "tr", label: "Turkish" },
  { value: "pl", label: "Polish" },
  { value: "vi", label: "Vietnamese" },
  { value: "th", label: "Thai" },
  { value: "id", label: "Indonesian" },
  { value: "uk", label: "Ukrainian" },
];

// ---------------------------------------------------------------------------
// Ken Burns effect chips (multi-select pool)
// ---------------------------------------------------------------------------
const KB_EFFECTS: { value: KenBurnsDirection; label: string; glyph: string }[] =
  [
    { value: "in", label: "Zoom In", glyph: "⤢" },
    { value: "out", label: "Zoom Out", glyph: "⤡" },
    { value: "left", label: "Pan Left", glyph: "←" },
    { value: "right", label: "Pan Right", glyph: "→" },
    { value: "up", label: "Pan Up", glyph: "↑" },
    { value: "down", label: "Pan Down", glyph: "↓" },
  ];

// ---------------------------------------------------------------------------
// Panel props
// ---------------------------------------------------------------------------
interface SettingsPanelProps {
  kenBurns: KenBurnsConfig;
  settings: VideoSettings;
  audioSettings: AudioSettings;
  onKenBurnsChange: (kb: KenBurnsConfig) => void;
  onSettingsChange: (s: VideoSettings) => void;
  onAudioSettingsChange: (a: AudioSettings) => void;
  /** Segment transitions (v4.3). */
  transition: TransitionSettings;
  onTransitionChange: (t: TransitionSettings) => void;
  /** Watermark / logo overlay (v4.4). */
  watermarkImage: { url: string; fileName: string } | null;
  watermarkSettings: WatermarkSettings;
  onWatermarkFile: (file: File | null) => void;
  onWatermarkSettingsChange: (w: WatermarkSettings) => void;
  openWatermarkPicker: () => void;
  /** WebVTT sidecar export (v4.4). */
  onExportVtt: () => void;
  /** Karaoke word-level WebVTT export (v4.6). */
  onExportVttWords: () => void;
  captionSettings: CaptionSettings;
  onCaptionSettingsChange: (cs: CaptionSettings) => void;
  /** Applies a preset's signature behavior (wordMode + animation + font). */
  onApplyPreset: (presetId: string) => void;
  /** v4.7: starred preset ids (Favorites group + filter). */
  favoritePresets: string[];
  onToggleFavorite: (presetId: string) => void;
  onExportSrt: () => void;
  onExportAss: () => void;
  inElectron: boolean;
  subtitles: SubtitleFile | null;
  hasAudio: boolean;
  /** ── v1.25: Background music — the MULTI-CLIP stack ──
   * The Audio tab card and the timeline Audio lane share this stack: N
   * independently draggable/volume/loop-controllable music clips. */
  musicClips: MusicClip[];
  /** Opens the OS audio file picker (multi-select; page's hidden input). */
  onAddMusic: () => void;
  /** Removes ONE music clip by id (one undo step). */
  onRemoveMusicClip: (id: string) => void;
  /** Patches ONE music clip (volume / loop / durationMs). */
  onMusicClipEdit: (id: string, patch: Partial<MusicClip>) => void;
  onGenerateCaptions: () => void;
  whisperBusy: boolean;
  whisperProgress: WhisperProgress | null;
  whisperLanguage: string;
  onWhisperLanguageChange: (lang: string) => void;
  /** v1.25: convert ROMANIZED (QWERTY) subtitles to native Devanagari /
   *  Nastaliq script — page owns the cue mutation + undo step. */
  onConvertSubtitlesToNative?: () => void;
  /** v1.20: transcription model (Groq whisper model id — kept wired for the
   *  app-level STT preference; the local size picker is gone with the engines). */
  whisperModel: string;
  onWhisperModelChange: (model: string) => void;
  hasVideoClip: boolean;
  /** Headline overlay items (v4.2). */
  headlineItems: HeadlineItem[];
  onAddHeadline: () => void;
  onUpdateHeadline: (id: string, patch: Partial<HeadlineItem>) => void;
  onRemoveHeadline: (id: string) => void;
  /** Master timeline duration (for headline default windows). */
  totalMs: number;
  /** v1.15: burn-in text detection & removal settings (default OFF). */
  textRemoval: TextRemovalSettings;
  onTextRemovalChange: (tr: TextRemovalSettings) => void;
  /** v1.15: a video source the OCR detector can sample ({ url, name }). */
  videoSourceForDetect: { url: string; name: string } | null;
  /** v5.1: assign a random transition mix to every boundary (page owns the
   *  base-lane boundary list; one commit = one undo step). */
  onRandomMix?: () => void;
  /** v5.1: number of boundaries the random mix would cover (enables the
   *  button; 0/undefined hides it). */
  boundaryCount?: number;
  // (v1.11: the Chroma tab props were removed with the tab — the per-clip
  // keyer + track switch live in the media panel's clip settings.)
  /** ── v1.17 Voiceover (Edge TTS) + Translate & Dub ── */
  /** Synthesized narration lands at the playhead (page owns currentMs). */
  onAddVoiceover: (r: {
    text: string;
    voice: string;
    ratePct?: number;
    pitchHz?: number;
    /** v1.25: optional so the TTS Studio's contract (volume?: number)
     *  composes; the Voiceover section always sends its slider fraction. */
    volume?: number;
    durationMs: number;
    /** v1.25: the TTS Studio hands a Blob (long-run read-back); the
     *  Voiceover section still passes the raw ArrayBuffer. */
    bytes: ArrayBuffer | Blob;
  }) => void;
  /** ── v1.25 TTS STUDIO HANDOFFS ── */
  /** Synthesized audio as a TIMELINE MUSIC clip (any length). */
  onAddMusicAudio: (a: {
    fileName: string;
    blob: Blob;
    durationMs: number;
  }) => void;
  /** Word-level captions from the TTS word timings. */
  onCreateWordCaptions: (r: {
    title: string;
    words: Array<{ text: string; startMs: number; endMs: number }>;
  }) => void;
  /** Machine-level dub preferences (localStorage). */
  dubSettings: DubSettings;
  onDubSettingsChange: (s: DubSettings) => void;
  /** Local base-lane video clips available as dub sources. */
  dubSourceCount: number;
  dubBusy: boolean;
  dubProgress: { phase: string; progress: number; status: string } | null;
  dubResult: DubTrackResult | null;
  onStartDub: () => void;
  onCancelDub: () => void;
  onApplyDubTrack: () => void;
  onDiscardDub: () => void;
  /** v1.26 DUB STUDIO staged workflow. ALL state is page-owned — Section
   *  unmounts its children when the accordion collapses, so the transcript,
   *  the script and the speaker-voice picks must live above this file. */
  /** Which stage is in flight (drives every stage's spinner + progress). */
  dubOp: "transcribe" | "script" | "dub" | null;
  /** Stage-1 word-level transcript (with the source count it was made from
   *  — a mismatch shows the "timeline changed" staleness hint). */
  dubTranscript: (DubTranscriptResult & { sourceCount?: number }) | null;
  /** Stage-2 editable dubbing script (lines are edited in place). */
  dubScript: DubScriptResult | null;
  /** Per-speaker voice picks for speaker ids ≥ 2 (0/1 live in dubSettings). */
  dubSpeakerVoices: Record<number, string>;
  onStartDubTranscribe: () => void;
  onDiscardTranscript: () => void;
  onStartDubScript: () => void;
  onDiscardScript: () => void;
  onStartDubFromScript: () => void;
  onDubScriptChange: (lines: DubScriptLine[]) => void;
  onDubSpeakerVoicesChange: (voices: Record<number, string>) => void;
  /** Placements currently on the VO lane (narration + dub). */
  voCount: number;
  /** ── v1.23 FLOW: CONTROLLED TAB MODE ──
   * The new left navigation rail owns which section is visible. When
   * activeTab + onTabChange are provided the panel runs CONTROLLED: the
   * internal tab rail is NOT rendered (the rail replaces it) and every
   * internal switch request (whisper auto-flip) routes to onTabChange.
   * Uncontrolled (both undefined) keeps the legacy v5 tab rail intact. */
  activeTab?: SettingsTabId;
  onTabChange?: (tab: SettingsTabId) => void;
}

// ---------------------------------------------------------------------------
// Section / Field / Segmented / Row helpers
// ---------------------------------------------------------------------------
// ── v1.22 ENGINE DIAGNOSTICS CARD ───────────────────────────────────────────
// The live answer to "why is the Rust engine falling back to FFmpeg?":
//   • the engine's load state (version + binary + path, or the exact load
//     error with every candidate path that was tried)
//   • the LAST bypass reason (unsupported feature / timeline failure /
//     runtime engine error) from the most recent export
//   • a "Run engine test" button that executes a REAL 36-frame mini export
//     through the engine IN THIS RUNTIME (load path + FFmpeg DLL dir + wgpu
//     adapter) and reports engineUsed/encoder/adapter/wall time — or the
//     exact error. Silent fallbacks are a thing of the past.
function EngineDiagnosticsCard() {
  const [status, setStatus] = useState<{
    loaded: boolean;
    version?: string | null;
    binary?: string | null;
    from?: string | null;
    error?: string | null;
    lastFailure?: { at: number; stage: string; reason: string } | null;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    stage?: string;
    error?: string;
    engineUsed?: string;
    encoderName?: string;
    adapter?: string;
    frames?: number;
    wallMs?: number;
  } | null>(null);
  const [inElectron, setInElectron] = useState<boolean | null>(null);

  useEffect(() => {
    const api = window.electronAPI;
    let cancelled = false;
    const electron = !!api && typeof api.engineStatus === "function";
    // setState runs inside async continuations (allowed) — never directly
    // in the effect body.
    const boot = async () => {
      await Promise.resolve();
      if (cancelled) return;
      setInElectron(electron);
      if (!electron) return;
      try {
        const s = await api!.engineStatus?.();
        if (!cancelled && s) setStatus(s);
      } catch {
        /* status is best-effort — the card shows the fallback note */
      }
    };
    boot();
    return () => {
      cancelled = true;
    };
  }, []);

  const runTest = useCallback(async () => {
    const api = window.electronAPI;
    if (!api?.engineSelfTest) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.engineSelfTest();
      setTestResult(r);
      // The run may have changed the failure trace — refresh the status.
      try {
        const s = await api.engineStatus?.();
        if (s) setStatus(s);
      } catch {
        /* status refresh is best-effort */
      }
    } catch (err) {
      setTestResult({
        ok: false,
        stage: "ipc",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  }, []);

  if (inElectron === false) {
    return (
      <p className="text-[10px] leading-relaxed text-stone-500">
        Export engine: Rust native (auto) — falls back to FFmpeg automatically
        if unavailable. Engine diagnostics run in the FrameFuse desktop app.
      </p>
    );
  }

  const okPill = "bg-[#0e211b] text-emerald-300 border-emerald-500/40";
  const badPill = "bg-[#2b1315] text-rose-400 border-rose-500/50";

  return (
    <div className="space-y-2">
      {/* load state */}
      <div className="flex flex-wrap items-center gap-1.5">
        {status === null ? (
          <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-400">
            <Loader2 size={10} className="animate-spin" /> checking engine…
          </span>
        ) : status.loaded ? (
          <span
            className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${okPill}`}
          >
            <Activity size={10} /> Rust engine loaded
            {status.version ? ` · v${status.version}` : ""}
          </span>
        ) : (
          <span
            className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${badPill}`}
            title={status.error || undefined}
          >
            <AlertTriangle size={10} /> Rust engine not loaded
          </span>
        )}
        {status?.loaded && status.from && (
          <span className="max-w-full truncate text-[9px] font-mono text-stone-500" title={status.from}>
            {status.binary}
          </span>
        )}
      </div>

      {/* load error detail */}
      {status && !status.loaded && status.error && (
        <p className="break-words rounded-md border border-rose-500/30 bg-[#2b1315] p-1.5 text-[10px] leading-relaxed text-rose-400">
          {status.error}
          {status.lastFailure ? "" : " — exports will use the FFmpeg CLI pipeline until this is fixed."}
        </p>
      )}

      {/* last bypass reason */}
      {status?.lastFailure && (
        <p className="break-words rounded-md border border-[#2b2723] bg-[#26221e] p-1.5 text-[10px] leading-relaxed text-stone-400">
          <span className="font-semibold text-stone-400">Last export used FFmpeg CLI: </span>
          {status.lastFailure.reason}
        </p>
      )}

      {/* self-test */}
      <button
        type="button"
        onClick={runTest}
        disabled={testing}
        className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[#2b2723] bg-[#26221e] px-2 py-1.5 text-[11px] font-medium text-stone-400 shadow-[0_1px_2px_rgba(0,0,0,0.45)] transition-colors hover:bg-white/[0.04] hover:text-stone-100 disabled:opacity-60"
      >
        {testing ? (
          <>
            <Loader2 size={12} className="animate-spin" /> Testing engine…
          </>
        ) : (
          <>
            <Activity size={12} /> Run engine test
          </>
        )}
      </button>

      {testResult && (
        <div
          className={`rounded-md border p-2 text-[10px] leading-relaxed ${
            testResult.ok
              ? "border-emerald-500/30 bg-[#0e211b] text-emerald-300"
              : "border-rose-500/30 bg-[#2b1315] text-rose-400"
          }`}
        >
          {testResult.ok ? (
            <>
              <span className="font-semibold">Engine healthy.</span>{" "}
              {testResult.engineUsed === "rust-gpu" ? "GPU compositor" : "CPU compositor"} ·{" "}
              {testResult.encoderName} · {testResult.frames} frames in{" "}
              {(testResult.wallMs ?? 0)}ms
              {testResult.adapter ? ` · ${testResult.adapter}` : ""}
            </>
          ) : (
            <>
              <span className="font-semibold">
                Engine test failed{testResult.stage ? ` (${testResult.stage})` : ""}:
              </span>{" "}
              {testResult.error}
              <br />
              <span className="text-stone-500">
                Exports will use the FFmpeg CLI pipeline (safe mode) — the video
                still exports correctly.
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Section({
  icon,
  title,
  children,
  defaultOpen = false,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    // v5.1 CapCut: uniform section CARD — rounded-lg, 1px #2b2723 hairline,
    // #211e1a warm body, 12px uppercase stone-400 header with tracking (was
    // a full-width border-b list row). Logic (accordion state) unchanged.
    <div
      className="mx-2 mb-2 overflow-hidden rounded-lg border"
      style={{ borderColor: "#2b2723", backgroundColor: "#211e1a" }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-none px-3 py-2.5 text-left transition-colors hover:bg-white/[0.06]"
        aria-expanded={open}
      >
        {/* v4.8: one rotating chevron (was a two-icon swap) — the motion
            itself now communicates expanded/collapsed state. */}
        <ChevronDown
          size={14}
          className={cn(
            "shrink-0 text-stone-500 transition-transform duration-200",
            open ? "rotate-0" : "-rotate-90",
          )}
        />
        <span className="shrink-0 text-stone-500">{icon}</span>
        <span className="flex-1 text-xs font-semibold uppercase tracking-wide text-stone-400">
          {title}
        </span>
      </button>
      {open && <div className="px-3 pb-3 pt-1">{children}</div>}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3">
      <div className="mb-1.5 flex items-baseline justify-between">
        <label className="text-xs font-medium text-stone-400">{label}</label>
      </div>
      {children}
      {hint && (
        <p className="mt-1 text-[10px] leading-relaxed text-stone-500">{hint}</p>
      )}
    </div>
  );
}

function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  size = "md",
}: {
  options: { value: T; label: string; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  size?: "sm" | "md";
}) {
  return (
    <div
      className="grid gap-1 rounded-md p-1"
      style={{
        gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`,
        backgroundColor: "#211e1a",
      }}
      role="radiogroup"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded transition-colors",
              size === "sm" ? "px-1.5 py-1 text-[10px]" : "px-2 py-1.5 text-xs",
              active
                ? "bg-[#2a2724] font-semibold text-stone-100 shadow-[0_1px_2px_rgba(0,0,0,0.45)]"
                : "text-stone-500 hover:bg-white/[0.06] hover:text-stone-300",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// v1.21 LIVE-PREVIEW FONT PICKER ─────────────────────────────────────────────
// Every option renders in its OWN typeface (the bundled @font-face families
// — Inter/Montserrat/Bebas Neue/Playfair Display/Roboto ship with the app
// and the export burns the exact same TTFs). Users SEE the real caption
// font before picking it; the old native <select> could not style options
// per-family, so "which font is which" was guesswork.
// Full keyboard support (↑/↓, Home/End, Enter, Escape) + click-outside.
function FontPicker({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (fontId: string) => void;
  options: { id: string; name: string; stack: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const activeIdx = Math.max(
    0,
    options.findIndex((o) => o.id === value),
  );
  const current = options.find((o) => o.id === value) ?? options[0];

  // click-outside + Escape close
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const choose = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!open && (e.key === "Enter" || e.key === " " || e.key === "ArrowDown")) {
      setOpen(true);
      e.preventDefault();
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") {
      setHighlight((h) => Math.min(options.length - 1, h + 1));
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      setHighlight((h) => Math.max(0, h - 1));
      e.preventDefault();
    } else if (e.key === "Home") {
      setHighlight(0);
      e.preventDefault();
    } else if (e.key === "End") {
      setHighlight(options.length - 1);
      e.preventDefault();
    } else if (e.key === "Enter") {
      choose(options[highlight]?.id ?? value);
      e.preventDefault();
    }
  };

  return (
    <div
      ref={wrapRef}
      className="relative"
      onKeyDown={onKey}
    >
      <button
        type="button"
        onClick={() => {
          if (!open) setHighlight(activeIdx);
          setOpen(!open);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Caption font"
        className="flex w-full items-center justify-between rounded border bg-[#211e1a] px-2.5 py-2 text-left transition-colors hover:border-[#3a352d]"
        style={{
          borderColor: open ? "#f06214" : "#332e28",
        }}
      >
        <span
          className="truncate text-stone-300"
          style={{ fontFamily: current.stack, fontSize: 14 }}
        >
          {current.name}
        </span>
        <ChevronDown
          size={13}
          className="ml-2 shrink-0 text-stone-500 transition-transform"
          style={{ transform: open ? "rotate(180deg)" : undefined }}
        />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Font options"
          className="absolute z-40 mt-1 w-full overflow-hidden rounded border shadow-2xl"
          style={{ borderColor: "#332e28", backgroundColor: "#26221e" }}
        >
          <div className="max-h-72 overflow-y-auto ff-font-scroll">
            {options.map((o, i) => {
              const active = o.id === value;
              const hl = i === highlight;
              return (
                <button
                  key={o.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => choose(o.id)}
                  className="flex w-full items-center justify-between px-2.5 py-2 text-left transition-colors"
                  style={{
                    backgroundColor: active
                      ? "#2b1c10"
                      : hl
                        ? "#26221e"
                        : "transparent",
                  }}
                >
                  <span
                    className="truncate"
                    style={{
                      fontFamily: o.stack,
                      fontSize: 15,
                      lineHeight: 1.35,
                      color: active ? "#fdba74" : "#e7e5e4",
                    }}
                  >
                    {o.name}
                  </span>
                  {active ? (
                    <Check
                      size={12}
                      className="ml-2 shrink-0"
                      style={{ color: "#fdba74" }}
                    />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <span className="text-xs text-stone-400">{label}</span>
      {children}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full border transition-all duration-200 active:scale-95",
          checked
            ? "border-orange-400/60 bg-orange-500 shadow-[0_0_10px_rgba(234,88,12,0.35)]"
            : "border-[#3a352d] bg-[#2a2724] hover:bg-[#33302b]",
        )}
      >
        {/* v1.24 fix: left-0.5 anchors the thumb explicitly. Without a left
            value the thumb's STATIC position is used, and buttons default to
            text-align:center — the thumb started ~9px in (mid-track) and
            translate-x-4 then pushed it OUT of the track when ON. */}
        <span
          className={cn(
            "absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200",
            checked ? "translate-x-[14px]" : "translate-x-0",
          )}
        />
      </button>
      <span className="text-xs leading-tight text-stone-400">{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// v5.0 tabs — Media | Captions | Effects | Audio | TTS | Dubbing | Export
// (v1.11: Chroma tab REMOVED — its keyer + track switch already live in the
// media panel's per-clip settings, one place, no duplicate surface.)
// (v1.24: DUBBING tab ADDED — voiceover, script writer, translate & dub and
// text removal moved out of Audio/Effects so every speech/voice tool lives
// in one place.)
// (v1.26: TTS tab SPLIT OUT — simple text-to-speech (the AI TTS Studio +
// Voiceover) gets its own home; Dubbing keeps the Dub Studio + Script
// Writer + Text Removal.)
// ---------------------------------------------------------------------------
const SETTINGS_TAB_IDS = [
  "media",
  "captions",
  "effects",
  "audio",
  "tts",
  "dubbing",
  "export",
] as const;

type SettingsTabId = (typeof SETTINGS_TAB_IDS)[number];
export type { SettingsTabId };

/** Sanitizes the persisted value — anything unknown falls back to "media". */
function isSettingsTabId(value: unknown): value is SettingsTabId {
  return (
    typeof value === "string" &&
    (SETTINGS_TAB_IDS as readonly string[]).includes(value)
  );
}

/** Dedicated small key (sibling of framefuse.settings.v49/v50). */
const TAB_STORAGE_KEY = "framefuse.settings.tab";

/** Per-tab accent — v1.23 Flow: emerald/tangerine/rose/teal/amber
 *  (dark-theme values), a family spread that keeps each section's
 *  identity on the night canvas. */
const SETTINGS_TABS: {
  id: SettingsTabId;
  label: string;
  icon: LucideIcon;
  accent: string;
  glow: string;
}[] = [
  {
    id: "media",
    label: "Media",
    icon: Film,
    accent: "#34d399",
    glow: "rgba(5, 150, 105, 0.35)",
  },
  {
    id: "captions",
    label: "Captions",
    icon: Captions,
    accent: "#fb923c",
    glow: "rgba(234, 88, 12, 0.35)",
  },
  {
    id: "effects",
    label: "Effects",
    icon: Sparkles,
    accent: "#fb7185",
    glow: "rgba(225, 29, 72, 0.35)",
  },
  {
    id: "audio",
    label: "Audio",
    icon: Music,
    accent: "#2dd4bf",
    glow: "rgba(13, 148, 136, 0.35)",
  },
  {
    id: "tts",
    label: "TTS",
    icon: AudioLines,
    accent: "#a3e635",
    glow: "rgba(132, 204, 22, 0.35)",
  },
  {
    id: "dubbing",
    label: "Dubbing",
    icon: Languages,
    accent: "#a78bfa",
    glow: "rgba(124, 58, 237, 0.35)",
  },
  {
    id: "export",
    label: "Export",
    icon: Rocket,
    accent: "#fbbf24",
    glow: "rgba(217, 119, 6, 0.35)",
  },
];

// Tab-panel mount transition — pure CSS (no animation deps in this app).
// The class is re-applied each time a panel becomes visible, so every tab
// switch replays the short fade/slide-in; prefers-reduced-motion kills it.
// v1.11: container queries — inside narrow contexts (small-screen drawers)
// the tab labels collapse to icon-only so the 6-way rail never overflows.
const TAB_PANEL_CSS = `
@keyframes ff-tab-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
.ff-tab-panel-in { animation: ff-tab-in 220ms cubic-bezier(0.21, 0.61, 0.35, 1); }
@media (prefers-reduced-motion: reduce) {
  .ff-tab-panel-in { animation: none; }
}
.ff-settings-tabs { container-type: inline-size; }
@container (max-width: 380px) {
  .ff-tab-label { display: none; }
  .ff-settings-tabs button[role="tab"] { padding-top: 10px; padding-bottom: 10px; }
  .ff-settings-tabs button[role="tab"] svg { width: 17px; height: 17px; }
}
/* v1.21 FontPicker list — slim custom scrollbar (the long font list
 * deserves better than the default chunky one) */
.ff-font-scroll { scrollbar-width: thin; scrollbar-color: #3a352d transparent; }
.ff-font-scroll::-webkit-scrollbar { width: 8px; }
.ff-font-scroll::-webkit-scrollbar-track { background: transparent; }
.ff-font-scroll::-webkit-scrollbar-thumb { background: #3a352d; border-radius: 4px; border: 2px solid #211e1a; }
.ff-font-scroll::-webkit-scrollbar-thumb:hover { background: #4a443b; }
`;

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------
export function SettingsPanel(props: SettingsPanelProps) {
  const {
    activeTab: activeTabProp,
    onTabChange,
    kenBurns,
    settings,
    audioSettings,
    onKenBurnsChange,
    onSettingsChange,
    onAudioSettingsChange,
    transition,
    onTransitionChange,
    watermarkImage,
    watermarkSettings,
    onWatermarkFile,
    onWatermarkSettingsChange,
    openWatermarkPicker,
    onExportVtt,
    onExportVttWords,
    captionSettings,
    onCaptionSettingsChange,
    onApplyPreset,
    favoritePresets,
    onToggleFavorite,
    onExportSrt,
    onExportAss,
    inElectron,
    subtitles,
    hasAudio,
    musicClips,
    onAddMusic,
    onRemoveMusicClip,
    onMusicClipEdit,
    onConvertSubtitlesToNative,
    onGenerateCaptions,
    whisperBusy,
    whisperProgress,
    whisperLanguage,
    onWhisperLanguageChange,
    whisperModel,
    onWhisperModelChange,
    hasVideoClip,
    headlineItems,
    onAddHeadline,
    onUpdateHeadline,
    onRemoveHeadline,
    totalMs,
    textRemoval,
    onTextRemovalChange,
    videoSourceForDetect,
    onRandomMix,
    boundaryCount,
    onAddVoiceover,
    onAddMusicAudio,
    onCreateWordCaptions,
    dubSettings,
    onDubSettingsChange,
    dubSourceCount,
    dubBusy,
    dubOp,
    dubProgress,
    dubResult,
    dubTranscript,
    dubScript,
    dubSpeakerVoices,
    onStartDub,
    onCancelDub,
    onApplyDubTrack,
    onDiscardDub,
    onStartDubTranscribe,
    onDiscardTranscript,
    onStartDubScript,
    onDiscardScript,
    onStartDubFromScript,
    onDubScriptChange,
    onDubSpeakerVoicesChange,
    voCount,
  } = props;

  const zoomMax = 1.06 + (kenBurns.intensity / 100) * 0.18;

  // Ken Burns pool toggle: clicking a chip toggles it in the pool while
  // staying in "random" mode (2+ selected = random among those). A single
  // selected chip becomes the fixed direction.
  const ALL_EFFECTS: KenBurnsDirection[] = [
    "in",
    "out",
    "left",
    "right",
    "up",
    "down",
  ];
  const togglePoolEffect = (dir: KenBurnsDirection) => {
    const current = kenBurns.directionPool.length
      ? kenBurns.directionPool
      : ALL_EFFECTS;
    const has = current.includes(dir);
    const next = has ? current.filter((d) => d !== dir) : [...current, dir];
    if (next.length === 0) {
      // Deselecting everything → back to full random.
      onKenBurnsChange({
        ...kenBurns,
        direction: "random",
        directionPool: ALL_EFFECTS,
      });
      return;
    }
    if (next.length === 1) {
      // One effect left → fixed direction.
      onKenBurnsChange({
        ...kenBurns,
        direction: next[0],
        directionPool: next,
      });
      return;
    }
    onKenBurnsChange({ ...kenBurns, direction: "random", directionPool: next });
  };

  const setFullRandom = () => {
    onKenBurnsChange({
      ...kenBurns,
      direction: "random",
      directionPool: ALL_EFFECTS,
    });
  };

  const poolActive = (dir: KenBurnsDirection) => {
    const pool = kenBurns.directionPool.length
      ? kenBurns.directionPool
      : ALL_EFFECTS;
    return pool.includes(dir);
  };

  const isRandomMode =
    kenBurns.direction === "random" ||
    (kenBurns.directionPool.length > 1 &&
      kenBurns.directionPool.includes(kenBurns.direction));

  // ── v5.0 tab state ── v1.23 FLOW: controlled when the shell rail owns
  // the section (activeTabProp + onTabChange); the internal rail is then
  // hidden and every switch request is delegated to the shell.
  const controlled = activeTabProp != null && onTabChange != null;
  const [internalTab, setInternalTab] = useState<SettingsTabId>("media");
  const tab: SettingsTabId = controlled ? activeTabProp : internalTab;
  const switchTab = useCallback(
    (t: SettingsTabId) => {
      if (controlled) onTabChange?.(t);
      else setInternalTab(t);
    },
    [controlled, onTabChange],
  );
  const setTab = switchTab;
  const [tabsHydrated, setTabsHydrated] = useState(false);
  const tabRefs = useRef<Record<SettingsTabId, HTMLButtonElement | null>>({
    media: null,
    captions: null,
    effects: null,
    audio: null,
    tts: null,
    dubbing: null,
    export: null,
  });
  // Whisper auto-switch guard: flip to Captions once per busy→true edge so
  // the transcription progress is visible. The user can navigate away
  // freely — we never yank the tab back while a run is in flight.
  const whisperAutoSwitchedRef = useRef(false);

  useEffect(() => {
    // Restore the persisted tab after hydration (a lazy useState initializer
    // would mismatch SSR markup). One-shot sync with the localStorage
    // "external system" — same pattern as page.tsx's persisted-restore.
    // v1.23: skipped in controlled mode (the shell rail owns the section
    // and persists it itself).
    if (!controlled) {
      try {
        const stored = window.localStorage.getItem(TAB_STORAGE_KEY);
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (isSettingsTabId(stored)) setInternalTab(stored);
      } catch {
        /* storage unavailable (private mode) — keep the default */
      }
    }
    setTabsHydrated(true);
  }, [controlled]);

  useEffect(() => {
    if (tabsHydrated && !controlled) {
      try {
        window.localStorage.setItem(TAB_STORAGE_KEY, tab);
      } catch {
        /* ignore write failures */
      }
    }
  }, [tab, tabsHydrated, controlled]);

  useEffect(() => {
    if (whisperBusy) {
      if (!whisperAutoSwitchedRef.current) {
        whisperAutoSwitchedRef.current = true;
        setTab("captions");
      }
    } else {
      // Run finished — the next generation may auto-switch again.
      whisperAutoSwitchedRef.current = false;
    }
  }, [whisperBusy]);

  const activeTab = SETTINGS_TABS.find((t) => t.id === tab) ?? SETTINGS_TABS[0];
  const activeTabIndex = SETTINGS_TABS.indexOf(activeTab);

  // Roving tabindex: Arrow keys cycle, Home/End jump to the ends.
  const handleTablistKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const idx = activeTabIndex;
    let next = -1;
    if (e.key === "ArrowRight") next = (idx + 1) % SETTINGS_TABS.length;
    else if (e.key === "ArrowLeft")
      next = (idx - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = SETTINGS_TABS.length - 1;
    else return;
    e.preventDefault();
    const target = SETTINGS_TABS[next];
    setTab(target.id);
    tabRefs.current[target.id]?.focus();
  };

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <style dangerouslySetInnerHTML={{ __html: TAB_PANEL_CSS }} />

        {/* ── tab bar — 6 equal segments (v1: + Chroma), roving tabindex,
            sliding accent indicator. Sticky so it survives scrolling.
            v1.23 FLOW: NOT rendered in controlled mode — the shell's left
            navigation rail owns section switching. ── */}
        {!controlled && (
        <div
          role="tablist"
          aria-label="Settings sections"
          onKeyDown={handleTablistKeyDown}
          className="ff-settings-tabs sticky top-0 z-30 grid grid-cols-5 border-b"
          style={{ borderColor: "#2b2723", backgroundColor: "#1a1815" }}
        >
          {SETTINGS_TABS.map((t) => {
            const active = t.id === tab;
            return (
              <button
                key={t.id}
                ref={(el) => {
                  tabRefs.current[t.id] = el;
                }}
                id={`ff-settings-tab-${t.id}`}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`ff-settings-tabpanel-${t.id}`}
                tabIndex={active ? 0 : -1}
                onClick={() => setTab(t.id)}
                className={cn(
                  "group relative flex flex-col items-center gap-1 px-1 py-2.5 transition-colors duration-150",
                  active ? "bg-[#211e1a]" : "hover:bg-white/[0.04]",
                )}
              >
                <span className="relative flex items-center">
                  <t.icon
                    size={14}
                    className={cn(
                      "transition-colors duration-150",
                      active ? "" : "text-[#8f887f] group-hover:text-stone-200",
                    )}
                    style={active ? { color: t.accent } : undefined}
                  />
                  {/* Live dot while Whisper is transcribing. */}
                  {t.id === "captions" && whisperBusy && (
                    <span
                      className="absolute -right-2 -top-1 size-1.5 animate-pulse rounded-full bg-orange-500"
                      style={{ boxShadow: "0 0 6px rgba(234, 88, 12, 0.9)" }}
                      aria-hidden
                    />
                  )}
                  {/* Headline count badge. */}
                  {t.id === "effects" && headlineItems.length > 0 && (
                    <span
                      className="absolute -right-2.5 -top-1.5 rounded-full px-1 py-px text-[8px] font-bold leading-none tabular-nums text-orange-400"
                      style={{ backgroundColor: "rgba(234, 88, 12, 0.12)" }}
                      aria-hidden
                    >
                      {headlineItems.length}
                    </span>
                  )}
                </span>
                <span
                  className={cn(
                    "ff-tab-label text-[10px] font-semibold uppercase tracking-wider transition-colors duration-150",
                    active
                      ? "text-stone-100"
                      : "text-[#8f887f] group-hover:text-stone-300",
                  )}
                >
                  {t.label}
                </span>
              </button>
            );
          })}
          {/* v5.1 CapCut: the active tab's TANGERINE TOP BORDER — a sliding
              2px indicator along the rail's top edge (icon keeps its semantic
              accent; the rail accent itself is the app's tangerine). v1: 6 tabs. */}
          <span
            aria-hidden
            className="pointer-events-none absolute left-0 top-0 h-[2px] transition-all duration-200 ease-out"
            style={{
              width: `${100 / SETTINGS_TABS.length}%`,
              transform: `translateX(${activeTabIndex * 100}%)`,
              backgroundColor: "#f97316",
              boxShadow: "0 0 8px rgba(234, 88, 12, 0.45)",
            }}
          />
        </div>
        )}

        {/* ─── Media tab — Ken Burns motion ──────────────────────────── */}
        <div
          id="ff-settings-tabpanel-media"
          role="tabpanel"
          aria-labelledby="ff-settings-tab-media"
          tabIndex={tab === "media" ? 0 : -1}
          className={cn("pb-2 pt-2", tab === "media" ? "ff-tab-panel-in" : "hidden")}
        >
          {/* ─── Ken Burns ─────────────────────────────────────────────── */}
          <Section
            icon={<Zap size={13} />}
            title="Ken Burns Motion"
            defaultOpen
          >
            <div className="mb-3">
              <Toggle
                checked={kenBurns.enabled}
                onChange={(v) => onKenBurnsChange({ ...kenBurns, enabled: v })}
                label="Enable motion"
              />
            </div>

            <Field
              label="Zoom intensity"
              hint={`Max zoom ${zoomMax.toFixed(2)}×`}
            >
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={kenBurns.intensity}
                onChange={(e) =>
                  onKenBurnsChange({
                    ...kenBurns,
                    intensity: Number(e.target.value),
                  })
                }
                disabled={!kenBurns.enabled}
                className="w-full accent-orange-600"
                aria-label="Ken Burns zoom intensity"
              />
            </Field>

            <Field
              label="Effects"
              hint={
                isRandomMode
                  ? `Random — picks from ${kenBurns.directionPool.length || 6} selected effect${(kenBurns.directionPool.length || 6) === 1 ? "" : "s"} per image`
                  : `Fixed — every image uses ${kenBurns.direction}`
              }
            >
              <div className="grid grid-cols-3 gap-1.5">
                {KB_EFFECTS.map((eff) => {
                  const active = poolActive(eff.value);
                  return (
                    <button
                      key={eff.value}
                      type="button"
                      aria-pressed={active}
                      disabled={!kenBurns.enabled}
                      onClick={() => togglePoolEffect(eff.value)}
                      className={cn(
                        "flex items-center gap-1.5 rounded-md px-1.5 py-1.5 text-[10px] font-medium transition-all duration-150 active:scale-[0.96]",
                        active
                          ? "bg-[#0e211b] text-emerald-300 ring-1 ring-emerald-500/40"
                          : "bg-[#26221e] text-stone-500 hover:bg-white/[0.06] hover:-translate-y-px",
                        !kenBurns.enabled && "opacity-40",
                      )}
                    >
                      <span aria-hidden>{eff.glyph}</span>
                      {eff.label}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={setFullRandom}
                disabled={!kenBurns.enabled}
                className={cn(
                  "mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[10px] font-semibold transition-all active:scale-[0.98]",
                  isRandomMode && kenBurns.directionPool.length === 6
                    ? "border-emerald-500/40 bg-[#0e211b] text-emerald-300"
                    : "border-[#2b2723] bg-transparent text-stone-500 hover:border-[#332e28] hover:bg-white/[0.04] hover:text-stone-300",
                )}
                title="Randomize across all six effects"
              >
                <Dices className="size-3.5" />
                Random — all effects
              </button>
              <p className="mt-1 text-[10px] leading-relaxed text-stone-500">
                Select 2+ effects to randomize between only your favorites, or
                pick one to fix it.
              </p>
            </Field>
          </Section>
        </div>
        {/* ─── Export tab — Engine + Video ─────────────────────────── */}
        <div
          id="ff-settings-tabpanel-export"
          role="tabpanel"
          aria-labelledby="ff-settings-tab-export"
          tabIndex={tab === "export" ? 0 : -1}
          className={cn(
            "pb-2 pt-2",
            tab === "export" ? "ff-tab-panel-in" : "hidden",
          )}
        >
          {/* ─── ENGINE — Rust native (default) with automatic FFmpeg
              fallback. v1.22: LIVE diagnostics + the on-demand self-test —
              the "why is it always falling back" answer, in the UI. ─── */}
          <Section icon={<Zap size={13} />} title="Engine" defaultOpen>
            <EngineDiagnosticsCard />
          </Section>

          {/* ─── Video ─────────────────────────────────────────────────── */}
          <Section icon={<Film size={13} />} title="Video" defaultOpen>
            {/* v4.5: one-click encode-quality profiles. */}
            <Field
              label="Quality profile"
              hint="Resolution + fps + encoder tuning bundles"
            >
              <div className="grid grid-cols-3 gap-1.5">
                {QUALITY_PROFILES.map((p) => {
                  // undefined quality (persisted v4.4 settings) = "social".
                  const active = (settings.quality || "social") === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() =>
                        onSettingsChange({
                          ...settings,
                          resolution: p.resolution,
                          fps: p.fps,
                          bitrateMbps: p.bitrateMbps,
                          crf: p.crf,
                          quality: p.id,
                        })
                      }
                      title={p.hint}
                      className={cn(
                        "ff-profile-card group relative flex flex-col gap-1 rounded-lg border p-2 text-left transition-all duration-200",
                        active
                          ? "ff-profile-active"
                          : "hover:-translate-y-px hover:brightness-110",
                      )}
                      style={
                        active
                          ? undefined
                          : {
                              borderColor: "#2b2723",
                              backgroundColor: "#26221e",
                            }
                      }
                    >
                      <span
                        className="flex items-center gap-1 text-[11px] font-bold"
                        style={{ color: active ? "#fb923c" : "#b5aea3" }}
                      >
                        {p.label}
                        {active && (
                          <Check
                            className="size-3 shrink-0"
                            style={{ color: "#ea580c" }}
                            aria-hidden
                          />
                        )}
                      </span>
                      <span
                        className="text-[8px] tabular-nums"
                        style={{ color: "#8f887f" }}
                      >
                        {p.resolution} · {p.fps}fps
                      </span>
                      {/* speed meter: 3 dots, filled = speed cost */}
                      <span className="flex items-center gap-0.5" aria-hidden>
                        {[1, 2, 3].map((d) => (
                          <span
                            key={d}
                            className="h-1 w-2.5 rounded-full transition-colors duration-200"
                            style={{
                              backgroundColor:
                                d <= p.speed
                                  ? active
                                    ? "#ea580c"
                                    : "#4a443b"
                                  : "#332e28",
                            }}
                          />
                        ))}
                        <span
                          className="ml-1 text-[7px] uppercase tracking-wide"
                          style={{ color: "#8f887f" }}
                        >
                          {p.speed === 3
                            ? "fast"
                            : p.speed === 2
                              ? "balanced"
                              : "slow"}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
              {settings.quality === "custom" ? (
                <p
                  className="mt-1.5 flex items-center gap-1 text-[9px]"
                  style={{ color: "#fb923c" }}
                >
                  <Wand2 className="size-2.5" /> Custom — fields below tuned
                  manually
                </p>
              ) : (
                <p
                  className="mt-1.5 text-[9px] leading-relaxed"
                  style={{ color: "#8f887f" }}
                >
                  {QUALITY_PROFILES.find((p) => p.id === settings.quality)
                    ?.hint ??
                    "Pick a profile, then fine-tune below (switches to Custom)."}
                </p>
              )}
            </Field>
            <Field
              label="Aspect ratio"
              hint="16:9 YouTube · 9:16 Shorts/Reels/TikTok · 1:1 square · 4:5 Instagram feed"
            >
              <Segmented
                options={[
                  { value: "16:9", label: "16:9" },
                  { value: "9:16", label: "9:16" },
                  { value: "1:1", label: "1:1" },
                  { value: "4:5", label: "4:5" },
                ]}
                value={settings.aspect}
                onChange={(v) =>
                  // v5.2: a manual pick is an explicit choice — disables the
                  // first-video aspect auto-match from then on.
                  onSettingsChange({ ...settings, aspect: v, aspectTouched: true })
                }
              />
            </Field>
            <Field label="Resolution">
              <Segmented
                options={[
                  { value: "720p", label: "720p" },
                  { value: "1080p", label: "1080p" },
                ]}
                value={settings.resolution}
                onChange={(v) =>
                  onSettingsChange({
                    ...settings,
                    resolution: v,
                    quality: "custom",
                  })
                }
              />
            </Field>
            {/* v1.14.4: the constrained-CPU fast-mode off switch (default ON).
                Only ever engages on Tier-3 machines (≤3 strong cores /
                legacy dual-module APUs) with a mostly-dirty ≥4-min timeline
                requested at 1080p-class — renders the 720p-class resolution
                of the SAME aspect for ~2.2× less encode work. The completion
                toast always says it ran. */}
            <Field
              label="Constrained-CPU fast mode"
              hint={settings.constrainedFastMode === false ? "Off" : "On (default)"}
            >
              <Segmented
                options={[
                  { value: "on", label: "On" },
                  { value: "off", label: "Off" },
                ]}
                value={settings.constrainedFastMode === false ? "off" : "on"}
                onChange={(v) =>
                  onSettingsChange({
                    ...settings,
                    constrainedFastMode: v === "off" ? false : undefined,
                  })
                }
              />
              <p className="mt-0.5 text-[9px]" style={{ color: "#8f887f" }}>
                On slow CPUs, long 1080p exports render at 720p-class (~2×
                faster) — the toast says when.
              </p>
            </Field>
            {/* v1.14.5: the slideshow 24-fps off switch (default ON). Pure-image
                timelines render 20 % fewer frames at the film rate (24 vs 30
                fps); mixed-video timelines, 60 fps projects and cinema are
                never touched, and the completion toast always says it ran. */}
            <Field
              label="Slideshow 24 fps"
              hint={settings.slideshowFps24 === false ? "Off" : "On (default)"}
            >
              <Segmented
                options={[
                  { value: "on", label: "On" },
                  { value: "off", label: "Off" },
                ]}
                value={settings.slideshowFps24 === false ? "off" : "on"}
                onChange={(v) =>
                  onSettingsChange({
                    ...settings,
                    slideshowFps24: v === "off" ? false : undefined,
                  })
                }
              />
              <p className="mt-0.5 text-[9px]" style={{ color: "#8f887f" }}>
                Image-only timelines export at 24 fps — 20 % fewer frames.
              </p>
            </Field>
            <Field label="Frame rate">
              <Segmented
                options={[
                  { value: 24, label: "24" },
                  { value: 30, label: "30" },
                  { value: 60, label: "60" },
                ]}
                value={settings.fps}
                onChange={(v) =>
                  onSettingsChange({
                    ...settings,
                    fps: v as 24 | 30 | 60,
                    quality: "custom",
                  })
                }
              />
            </Field>
            <Field label="Bitrate" hint={`${settings.bitrateMbps} Mbps`}>
              <input
                type="range"
                min={2}
                max={20}
                step={1}
                value={settings.bitrateMbps}
                onChange={(e) =>
                  onSettingsChange({
                    ...settings,
                    bitrateMbps: Number(e.target.value),
                    quality: "custom",
                  })
                }
                className="w-full accent-orange-600"
                aria-label="Video bitrate"
              />
            </Field>
            <Field
              label="Constant quality (CRF)"
              hint={
                settings.quality === "custom"
                  ? `CRF ${settings.crf ?? 20} · manual`
                  : `CRF ${QUALITY_PROFILES.find((p) => p.id === settings.quality)?.crf ?? 20} · from profile`
              }
            >
              <input
                type="range"
                min={14}
                max={30}
                step={1}
                value={settings.crf ?? 20}
                onChange={(e) =>
                  onSettingsChange({
                    ...settings,
                    crf: Number(e.target.value),
                    quality: "custom",
                  })
                }
                className="w-full accent-orange-600"
                aria-label="Constant quality factor"
              />
              <p className="mt-0.5 text-[9px]" style={{ color: "#8f887f" }}>
                Lower = better quality + larger files; 18–22 suits social.
              </p>
            </Field>
            <Field
              label="Audio bitrate"
              hint={`${settings.audioKbps ?? 192} kbps`}
            >
              <div className="flex items-center gap-2">
                {[96, 128, 192, 256, 320].map((k) => {
                  const active = (settings.audioKbps ?? 192) === k;
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() =>
                        onSettingsChange({ ...settings, audioKbps: k as 96 | 128 | 192 | 256 | 320 })
                      }
                      aria-pressed={active}
                      title={`${k} kbps${
                        k === 96
                          ? " — smallest files (voice-heavy edits)"
                          : k === 320
                            ? " — near-transparent music quality"
                            : ""
                      }`}
                      className={cn(
                        "flex-1 rounded-md border py-1 text-[10px] font-medium tabular-nums transition-colors",
                        active
                          ? "border-orange-500/50 bg-orange-500/15 text-orange-300"
                          : "border-[#2b2723] bg-[#26221e] text-stone-500 hover:border-[#332e28] hover:text-stone-300",
                      )}
                    >
                      {k}
                    </button>
                  );
                })}
              </div>
              <p className="mt-0.5 text-[9px]" style={{ color: "#8f887f" }}>
                192 suits most social video; 320 for music projects.
              </p>
            </Field>
          </Section>

        </div>

        {/* ─── Effects tab — Transitions + Watermark + Titles ────────── */}
        <div
          id="ff-settings-tabpanel-effects"
          role="tabpanel"
          aria-labelledby="ff-settings-tab-effects"
          tabIndex={tab === "effects" ? 0 : -1}
          className={cn(
            "pb-2 pt-2",
            tab === "effects" ? "ff-tab-panel-in" : "hidden",
          )}
        >
          {/* ─── Transitions (v4.3) ─────────────────────────────────── */}
          <Section
            icon={<ArrowLeftRight size={13} />}
            title="Transitions"
            defaultOpen
          >
            <TransitionSection
              transition={transition}
              onTransitionChange={onTransitionChange}
              onRandomMix={onRandomMix}
              boundaryCount={boundaryCount}
            />
          </Section>

          {/* ─── Watermark (v4.4) ─────────────────────────────────── */}
          <Section
            icon={<BadgeCheck size={13} />}
            title="Watermark"
            defaultOpen
          >
            <WatermarkSection
              image={watermarkImage}
              settings={watermarkSettings}
              onFile={onWatermarkFile}
              onSettingsChange={onWatermarkSettingsChange}
              openPicker={openWatermarkPicker}
            />
          </Section>

          {/* ─── Stack Text (v4.2 headline overlay → v1.17) ────────────── */}
          <HeadlineSection
            items={headlineItems}
            onAdd={onAddHeadline}
            onUpdate={onUpdateHeadline}
            onRemove={onRemoveHeadline}
            totalMs={totalMs}
          />

          {/* v1.24: Text removal MOVED to the Dubbing tab (speech/voice
              neighborhood — it strips burned-in dialogue before re-dubbing). */}
        </div>

        {/* ─── Audio tab — normalize / fades ──────────────────────────── */}
        <div
          id="ff-settings-tabpanel-audio"
          role="tabpanel"
          aria-labelledby="ff-settings-tab-audio"
          tabIndex={tab === "audio" ? 0 : -1}
          className={cn("pb-2 pt-2", tab === "audio" ? "ff-tab-panel-in" : "hidden")}
        >
          <Section icon={<AudioLines size={13} />} title="Audio" defaultOpen>
            {/* ── v1.3: master output volume (scales the summed mix) ─────── */}
            <Row label="Master volume">
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={200}
                  step={5}
                  value={Math.round(
                    Math.max(0, Math.min(2, audioSettings.masterVolume ?? 1)) * 100,
                  )}
                  onChange={(e) =>
                    onAudioSettingsChange({
                      ...audioSettings,
                      masterVolume: Math.max(
                        0,
                        Math.min(2, Number(e.target.value) / 100),
                      ),
                    })
                  }
                  className="w-28 accent-orange-600"
                  aria-label="Master output volume"
                />
                <span className="w-9 text-right text-[10px] tabular-nums text-stone-500">
                  {Math.round(
                    Math.max(0, Math.min(2, audioSettings.masterVolume ?? 1)) * 100,
                  )}
                  %
                </span>
              </div>
            </Row>
            <p className="mb-3 mt-[-8px] text-[10px] leading-relaxed text-stone-500">
              Scales clip audio, music and SFX — boosts above 100% apply on
              export.
            </p>
            <Row label="Normalize loudness">
              <div className="flex items-center gap-1.5">
                <span
                  className="rounded border px-1 py-px font-mono text-[9px] font-semibold uppercase tracking-wide"
                  style={{
                    borderColor: "#332e28",
                    backgroundColor: "#26221e",
                    color: "#fb923c",
                  }}
                  title="Every source is measured first, then a single static gain is applied (no dynamic pumping)"
                >
                  2-pass
                </span>
                <Toggle
                  checked={audioSettings.normalize}
                  onChange={(v) =>
                    onAudioSettingsChange({ ...audioSettings, normalize: v })
                  }
                  label=""
                />
              </div>
            </Row>
            <p className="mb-3 mt-[-8px] text-[10px] leading-relaxed text-stone-500">
              Masters every source to −16 LUFS (social standard) with a static
              gain.
            </p>
            <Field
              label="Fade in"
              hint={
                audioSettings.fadeInMs
                  ? `${(audioSettings.fadeInMs / 1000).toFixed(1)}s`
                  : "off"
              }
            >
              <input
                type="range"
                min={0}
                max={3000}
                step={100}
                value={audioSettings.fadeInMs}
                onChange={(e) =>
                  onAudioSettingsChange({
                    ...audioSettings,
                    fadeInMs: Number(e.target.value),
                  })
                }
                className="w-full accent-orange-600"
                aria-label="Audio fade in"
              />
            </Field>
            <Field
              label="Fade out"
              hint={
                audioSettings.fadeOutMs
                  ? `${(audioSettings.fadeOutMs / 1000).toFixed(1)}s`
                  : "off"
              }
            >
              <input
                type="range"
                min={0}
                max={3000}
                step={100}
                value={audioSettings.fadeOutMs}
                onChange={(e) =>
                  onAudioSettingsChange({
                    ...audioSettings,
                    fadeOutMs: Number(e.target.value),
                  })
                }
                className="w-full accent-orange-600"
                aria-label="Audio fade out"
              />
            </Field>
          </Section>

          {/* ── v1.25: Background music — the MULTI-TRACK stack. Every clip
              has its own row (name, duration, start) with per-clip volume,
              loop and remove; "Add another track" stacks more files (they
              appear as new rows on the timeline's Audio lane). ── */}
          <Section icon={<Music size={13} />} title="Background music" defaultOpen>
            {musicClips.length === 0 && (
              <p className="mb-2 text-[10px] leading-relaxed text-stone-500">
                Add background music that plays under the whole video —
                mixed with clip audio at its own volume. Add as many tracks
                as you like; they stack on the timeline's Audio lane.
              </p>
            )}
            {musicClips.map((clip) => {
              const volPct = Math.round(Math.max(0, Math.min(2, clip.volume)) * 100);
              const loopsToFill =
                clip.loop && clip.durationMs > 0 && totalMs > 0
                  ? clip.startMs + clip.durationMs < totalMs
                  : false;
              return (
                <div key={clip.id} className="mb-2.5 rounded-md border"
                  style={{ borderColor: "rgba(13, 148, 136, 0.35)", backgroundColor: "#10201d" }}
                >
                  {/* Clip row — name, duration, one-click remove. */}
                  <div className="flex items-center gap-2 px-2 py-1.5">
                    <Music size={13} className="shrink-0" style={{ color: "#2dd4bf" }} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[11px] font-medium text-stone-400" title={clip.fileName}>
                        {clip.fileName}
                      </p>
                      <p className="text-[9px] tabular-nums text-stone-500">
                        {clip.durationMs > 0
                          ? `${(clip.durationMs / 1000).toFixed(1)}s @ ${(clip.startMs / 1000).toFixed(1)}s${loopsToFill ? " — loops to fill the video" : ""}`
                          : "reading duration…"}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => onRemoveMusicClip(clip.id)}
                      className="flex size-6 shrink-0 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-rose-500/10 hover:text-rose-400"
                      title="Remove this music track"
                      aria-label={`Remove ${clip.fileName}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                  {/* Per-clip volume + loop controls. */}
                  <Row label="Volume">
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={0}
                        max={200}
                        step={5}
                        value={volPct}
                        onChange={(e) =>
                          onMusicClipEdit(clip.id, {
                            volume: Math.max(
                              0,
                              Math.min(2, Number(e.target.value) / 100),
                            ),
                          })
                        }
                        className="w-28 accent-teal-600"
                        aria-label={`Volume for ${clip.fileName}`}
                      />
                      <span className="w-9 text-right text-[10px] tabular-nums text-stone-500">
                        {volPct}%
                      </span>
                    </div>
                  </Row>
                  <Row label="Loop to fill video">
                    <Toggle
                      checked={clip.loop}
                      onChange={(v) => onMusicClipEdit(clip.id, { loop: v })}
                      label=""
                    />
                  </Row>
                </div>
              );
            })}
            {musicClips.length > 0 && (
              <p className="mb-1 text-[10px] leading-relaxed text-stone-500">
                {musicClips.length === 1
                  ? "Drag the music clip on the timeline's Audio lane to reposition it; drag its right edge to trim (when not looping)."
                  : `${musicClips.length} tracks stack as rows on the timeline's Audio lane — drag each clip to reposition it.`}
              </p>
            )}
            <button
              type="button"
              onClick={onAddMusic}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[10px] font-semibold transition-colors"
              style={{
                borderColor: "rgba(13, 148, 136, 0.5)",
                backgroundColor: musicClips.length > 0 ? "#10201d" : "#14b8a6",
                color: musicClips.length > 0 ? "#2dd4bf" : "#ffffff",
              }}
              title="Choose one or more audio files (mp3, wav, m4a…)"
            >
              <Upload size={11} />
              {musicClips.length > 0 ? "Add another track" : "Add background music"}
            </button>
          </Section>
        </div>

        {/* ─── v1.26 TTS tab — SIMPLE text-to-speech gets its own home: the
            AI TTS Studio (long-form Edge-TTS, language picker, voice
            presets, word timings) + the classic one-clip Voiceover. Both
            run IPC-first and fall back to the /api/tts routes in the web
            preview, so everything below is live in a browser. ──────── */}
        <div
          id="ff-settings-tabpanel-tts"
          role="tabpanel"
          aria-labelledby="ff-settings-tab-tts"
          tabIndex={tab === "tts" ? 0 : -1}
          className={cn("pb-2 pt-2", tab === "tts" ? "ff-tab-panel-in" : "hidden")}
        >
          <TtsStudioSection
            onAddVoiceover={onAddVoiceover}
            voCount={voCount}
            onAddMusicAudio={onAddMusicAudio}
            onCreateWordCaptions={onCreateWordCaptions}
          />

          {/* ── v1.17: Voiceover (Edge TTS narration — web + desktop) ─── */}
          <VoiceoverSection onAddVoiceover={onAddVoiceover} voCount={voCount} />
        </div>

        {/* ─── Dubbing tab (v1.24) — the full dub pipeline: Dub Studio
            (transcribe → script → voices & dub), AI script writer and
            burn-in text removal. v1.26: the Dub Studio is no longer
            Electron-gated — it runs through the speech transport in the
            web preview too. ────────────────────────────────────────── */}
        <div
          id="ff-settings-tabpanel-dubbing"
          role="tabpanel"
          aria-labelledby="ff-settings-tab-dubbing"
          tabIndex={tab === "dubbing" ? 0 : -1}
          className={cn("pb-2 pt-2", tab === "dubbing" ? "ff-tab-panel-in" : "hidden")}
        >
          {/* ── v1.20: AI Script Writer (Gemini default + Groq, Electron only) ── */}
          {inElectron && <ScriptWriterSection />}

          {/* ── v1.17→v1.26: Translate & Dub (transcribe → LLM → Edge TTS) —
              web preview runs it through the speech transport. ── */}
          <DubSection
            dubSettings={dubSettings}
            onDubSettingsChange={onDubSettingsChange}
            dubSourceCount={dubSourceCount}
            dubBusy={dubBusy}
            dubOp={dubOp}
            dubProgress={dubProgress}
            dubResult={dubResult}
            dubTranscript={dubTranscript}
            dubScript={dubScript}
            dubSpeakerVoices={dubSpeakerVoices}
            onStartDub={onStartDub}
            onCancelDub={onCancelDub}
            onApplyDubTrack={onApplyDubTrack}
            onDiscardDub={onDiscardDub}
            onStartDubTranscribe={onStartDubTranscribe}
            onDiscardTranscript={onDiscardTranscript}
            onStartDubScript={onStartDubScript}
            onDiscardScript={onDiscardScript}
            onStartDubFromScript={onStartDubFromScript}
            onDubScriptChange={onDubScriptChange}
            onDubSpeakerVoicesChange={onDubSpeakerVoicesChange}
          />

          {/* ── v1.24: Text removal moved here from the Effects tab —
              strips burned-in dialogue/subtitles before re-dubbing. ── */}
          <TextRemovalSection
            textRemoval={textRemoval}
            onTextRemovalChange={onTextRemovalChange}
            videoSourceForDetect={videoSourceForDetect}
          />
        </div>

        {/* ─── Captions tab — presets, word mode, Whisper, sidecars ──── */}
        <div
          id="ff-settings-tabpanel-captions"
          role="tabpanel"
          aria-labelledby="ff-settings-tab-captions"
          tabIndex={tab === "captions" ? 0 : -1}
          className={cn(
            "pb-2 pt-2",
            tab === "captions" ? "ff-tab-panel-in" : "hidden",
          )}
        >
          {/* ─── Captions ──────────────────────────────────────────────── */}
          <CaptionsSection
            captionSettings={captionSettings}
            onCaptionSettingsChange={onCaptionSettingsChange}
            onApplyPreset={onApplyPreset}
            favoritePresets={favoritePresets}
            onToggleFavorite={onToggleFavorite}
            onExportSrt={onExportSrt}
            onExportAss={onExportAss}
            onExportVtt={onExportVtt}
            onExportVttWords={onExportVttWords}
            inElectron={inElectron}
            subtitles={subtitles}
            hasAudio={hasAudio}
            onGenerateCaptions={onGenerateCaptions}
            whisperBusy={whisperBusy}
            whisperProgress={whisperProgress}
            whisperLanguage={whisperLanguage}
            onWhisperLanguageChange={onWhisperLanguageChange}
            onConvertSubtitlesToNative={onConvertSubtitlesToNative}
            whisperModel={whisperModel}
            onWhisperModelChange={onWhisperModelChange}
            hasSpeechSource={hasAudio || hasVideoClip}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// v1.15 — Text removal section (burned-in text detection & removal).
// DEFAULT OFF. Auto-detect samples the first video source with OCR and
// clusters stable word boxes into source-normalized regions.
// ---------------------------------------------------------------------------
interface TextRemovalSectionProps {
  textRemoval: TextRemovalSettings;
  onTextRemovalChange: (tr: TextRemovalSettings) => void;
  videoSourceForDetect: { url: string; name: string } | null;
}

const TR_MODES: Array<{ value: TextRemovalMode; label: string; hint: string }> = [
  {
    value: "inpaint",
    label: "Inpaint",
    hint: "Smooth fill interpolated from the surroundings — best for clean text removal (recommended)",
  },
  {
    value: "blur",
    label: "Blur",
    hint: "Strong region-limited Gaussian blur — the text becomes an unreadable smudge",
  },
  {
    value: "cover",
    label: "Cover",
    hint: "Solid black box over the text — the classic hard cover",
  },
];

function TextRemovalSection({
  textRemoval,
  onTextRemovalChange,
  videoSourceForDetect,
}: TextRemovalSectionProps) {
  const [detecting, setDetecting] = useState(false);
  const [detectProgress, setDetectProgress] = useState<{
    progress: number;
    status: string;
  } | null>(null);
  const detectAbortRef = useRef<AbortController | null>(null);

  const set = (patch: Partial<TextRemovalSettings>) =>
    onTextRemovalChange({ ...textRemoval, ...patch });

  const runDetect = useCallback(async () => {
    if (detecting || !videoSourceForDetect) return;
    const ctrl = new AbortController();
    detectAbortRef.current = ctrl;
    setDetecting(true);
    setDetectProgress({ progress: 0, status: "Starting…" });
    try {
      const result = await detectTextRegions(videoSourceForDetect, {
        signal: ctrl.signal,
        onProgress: (p) => setDetectProgress(p),
      });
      set({ regions: result.regions, enabled: true });
      if (result.regions.length > 0) {
        toast.success(`Found ${result.regions.length} text region(s)`, {
          description:
            "Removal is ON. Check the list below — remove any region you want to keep visible.",
        });
      } else {
        toast.info("No stable text found", {
          description:
            "The scan sampled every sampled frame and found no text that stays put. You can still enable removal manually with your own regions.",
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("cancelled")) {
        // silent — the user stopped it
      } else {
        toast.error("Text detection failed", { description: msg });
      }
    } finally {
      setDetecting(false);
      setDetectProgress(null);
      detectAbortRef.current = null;
    }
  }, [detecting, videoSourceForDetect]);

  const removeRegion = (id: string) =>
    set({ regions: textRemoval.regions.filter((r) => r.id !== id) });

  return (
    <Section
      icon={<Eraser size={13} />}
      title="Text removal"
      defaultOpen={false}
    >
      {/* Enable switch — OFF by default (the shipped default). Same Toggle
          component as every other app switch (design consistency). */}
      <div className="mb-3">
        <Toggle
          checked={textRemoval.enabled}
          onChange={(v) => set({ enabled: v })}
          label="Enable text removal"
        />
        <p className="mt-0.5 text-[10px] leading-snug text-stone-500">
          Watermarks, hard subtitles, usernames — detected on the video and
          removed on export.
        </p>
      </div>

      {/* Auto-detect — OCR over sampled frames of the first video source. */}
      <button
        type="button"
        onClick={() => {
          if (detecting) {
            detectAbortRef.current?.abort();
            return;
          }
          void runDetect();
        }}
        disabled={!videoSourceForDetect && !detecting}
        className={cn(
          "flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-semibold transition-colors",
          detecting
            ? "bg-[#2a2724] text-stone-400 hover:bg-[#33302b]"
            : !videoSourceForDetect
              ? "cursor-not-allowed bg-[#26221e] text-stone-400"
              : "bg-orange-500 text-white hover:bg-orange-400",
        )}
        title={
          videoSourceForDetect
            ? `Scan ${videoSourceForDetect.name} for burned-in text (samples up to 6 frames with OCR)`
            : "Add a video clip first — detection scans a video source"
        }
      >
        {detecting ? (
          <>
            <Loader2 size={13} className="animate-spin" />
            Cancel scan
          </>
        ) : (
          <>
            <ScanText size={13} />
            Detect text on video
          </>
        )}
      </button>
      {detectProgress && (
        <div className="mt-2">
          <div className="h-1 w-full overflow-hidden rounded-full bg-[#332e28]">
            <div
              className="h-full bg-gradient-to-r from-orange-400 to-orange-600 transition-all"
              style={{ width: `${detectProgress.progress}%` }}
            />
          </div>
          <p className="mt-1 truncate text-[10px] text-stone-500">
            {detectProgress.status}
          </p>
        </div>
      )}
      {!videoSourceForDetect && (
        <p className="mt-1.5 text-[10px] leading-snug text-stone-400">
          Detection needs at least one video clip on the timeline.
        </p>
      )}

      {/* Mode picker. */}
      <div className="mt-3">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-stone-500">
          Removal style
        </div>
        <div className="grid grid-cols-3 gap-1">
          {TR_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => set({ mode: m.value })}
              title={m.hint}
              className={cn(
                "rounded border px-2 py-1.5 text-[10px] font-medium transition-colors",
                textRemoval.mode === m.value
                  ? "border-orange-500/50 bg-orange-500/15 text-orange-300"
                  : "border-[#2b2723] bg-[#26221e] text-stone-500 hover:bg-white/[0.04] hover:text-stone-300",
              )}
              aria-pressed={textRemoval.mode === m.value}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[9px] leading-snug text-stone-400">
          {TR_MODES.find((m) => m.value === textRemoval.mode)?.hint}
        </p>
      </div>

      {/* Regions list. */}
      {textRemoval.regions.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-stone-500">
              Regions ({textRemoval.regions.length}/8)
            </span>
            <button
              type="button"
              onClick={() => set({ regions: [], enabled: false })}
              className="rounded border px-1.5 py-0.5 text-[9px] font-medium text-stone-500 transition-colors hover:bg-white/[0.06] hover:text-stone-300"
              style={{ borderColor: "#332e28" }}
            >
              Clear all
            </button>
          </div>
          <div className="max-h-40 space-y-1 overflow-y-auto pr-1">
            {textRemoval.regions.map((r) => (
              <div
                key={r.id}
                className="flex items-center gap-2 rounded border px-2 py-1.5"
                style={{ borderColor: "#2b2723", backgroundColor: "#26221e" }}
              >
                <span
                  className="size-2 shrink-0 rounded-sm"
                  style={{
                    background:
                      "repeating-linear-gradient(45deg, #f97316, #f97316 3px, #c2410c 3px, #c2410c 6px)",
                  }}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-[10px] text-stone-400">
                  {r.label
                    ? `“${r.label}”`
                    : `Region @ ${(r.x * 100).toFixed(0)}%, ${(r.y * 100).toFixed(0)}% · ${(r.w * 100).toFixed(0)}×${(r.h * 100).toFixed(0)}%`}
                  <span className="ml-1 text-stone-400">
                    {r.source === "ocr" ? "· detected" : "· manual"}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => removeRegion(r.id)}
                  className="shrink-0 rounded p-1 text-stone-500 transition-colors hover:bg-rose-500/10 hover:text-rose-400"
                  aria-label="Remove this text-removal region"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="mt-3 text-[9px] leading-relaxed text-stone-400">
        Regions follow every crop and aspect — the preview is an approximation.
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Headline overlay section (v4.2 → v1.17 "Stack Text") — viral hook titles
// with LAYOUT (geometry) × STYLE (kinetic choreography) pickers.
// ---------------------------------------------------------------------------
interface HeadlineSectionProps {
  items: HeadlineItem[];
  onAdd: () => void;
  onUpdate: (id: string, patch: Partial<HeadlineItem>) => void;
  onRemove: (id: string) => void;
  totalMs: number;
}

/** Legacy item.position → StackLayout derivation (stackLayout absent). */
function legacyLayoutFor(position: HeadlineItem["position"]): StackLayoutId {
  if (position === "top") return "top-banner";
  if (position === "bottom") return "bottom-center";
  return "center-stack";
}

// ── v1.17: animated inline style preview (tiny canvas-free rAF loop that
// reuses stackUnitTransforms — the same math the export painter runs).
const STACK_PREVIEW_W = 220;
const STACK_PREVIEW_H = 64;
const STACK_PREVIEW_LOOP_MS = 2600;

function StackStylePreview({
  text,
  styleId,
  accentColor,
}: {
  text: string;
  styleId: string;
  accentColor: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const unitEls = Array.from(host.children) as HTMLElement[];
    if (unitEls.length === 0) return;
    if (!isKineticStyle(styleId)) {
      // Simple styles: static chip (the canvas preview plays them).
      for (const el of unitEls) {
        el.style.opacity = "1";
        el.style.transform = "none";
        el.style.filter = "none";
        el.style.clipPath = "none";
      }
      return;
    }
    const loopMs = STACK_PREVIEW_LOOP_MS;
    let raf = 0;
    const startedAt = performance.now();
    const tick = (now: number) => {
      const currentMs = (now - startedAt) % loopMs;
      const outTail = Math.max(
        0,
        Math.min(1, (loopMs - currentMs) / STACK_FADE_OUT_MS),
      );
      const transforms = stackUnitTransforms({
        style: styleId as StackStyleId,
        startMs: 0,
        endMs: loopMs,
        currentMs,
        unitCount: unitEls.length,
        canvasH: STACK_PREVIEW_H,
        canvasW: STACK_PREVIEW_W,
        unitWeights: unitEls.map((el) => Math.max(1, (el.dataset.ch || "").length)),
      });
      for (let i = 0; i < unitEls.length; i++) {
        const t: StackUnitTransform | undefined = transforms[i];
        const el = unitEls[i];
        if (!t) continue;
        if (!t.visible) {
          el.style.opacity = "0";
          continue;
        }
        el.style.opacity = String(t.alpha * outTail);
        el.style.transform =
          `translate(${t.offsetX.toFixed(1)}px, ${t.offsetY.toFixed(1)}px) ` +
          `rotate(${t.rotate.toFixed(1)}deg) scale(${Math.max(0.01, t.scale).toFixed(3)})`;
        const blur = t.blur * (STACK_PREVIEW_H / 1080);
        el.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : "none";
        el.style.clipPath =
          t.reveal < 1
            ? `inset(0 ${(100 * (1 - t.reveal)).toFixed(1)}% 0 0)`
            : "none";
        // Karaoke fill: the accent overlay is the second child (clipped).
        const fill = el.querySelector<HTMLElement>("[data-fill]");
        if (fill) fill.style.width = `${(t.fillProgress * 100).toFixed(1)}%`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [styleId, text]);

  const kinetic = isKineticStyle(styleId);
  const unit = kinetic ? getStackStyle(styleId as StackStyleId).spec.unit : "word";
  const karaoke = styleId === "karaoke-fill";
  const units =
    unit === "line"
      ? text.split(/\n+/).filter(Boolean).slice(0, 3)
      : text.split(/\s+/).filter(Boolean).slice(0, 6);

  return (
    <div
      ref={hostRef}
      className={cn(
        "flex h-16 w-full select-none items-center justify-center gap-0.5 overflow-hidden rounded border px-1",
        unit === "line" ? "flex-col" : "flex-row flex-wrap",
      )}
      style={{
        borderColor: "#2b2723",
        backgroundColor: "#12100e",
        maxHeight: STACK_PREVIEW_H,
        maxWidth: STACK_PREVIEW_W * 2,
      }}
      aria-hidden="true"
    >
      {units.length === 0 ? (
        <span className="text-[10px] text-stone-400">no text</span>
      ) : (
        units.map((u, i) => (
          <span
            key={i}
            data-ch={u}
            className={cn(
              "relative inline-block whitespace-nowrap text-[11px] font-extrabold uppercase leading-tight text-white will-change-transform",
              unit === "word" ? "m-[0_2px]" : "block",
            )}
          >
            {u}
            {karaoke && (
              <span
                className="absolute inset-y-0 left-0 overflow-hidden"
                data-fill
                style={{ width: "0%", color: accentColor }}
              >
                <span className="whitespace-nowrap">{u}</span>
              </span>
            )}
          </span>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transition section (v4.3) — style tiles with LIVE CSS mini-previews
// ---------------------------------------------------------------------------
const TX_STYLE_ORDER: TransitionStyle[] = [
  "none",
  "dissolve",
  "dip-black",
  "dip-white",
  "slide-left",
  "slide-right",
  "wipe-left",
  "wipe-right",
  "circleopen",
];

function TransitionSection({
  transition,
  onTransitionChange,
  onRandomMix,
  boundaryCount = 0,
}: {
  transition: TransitionSettings;
  onTransitionChange: (t: TransitionSettings) => void;
  /** v5.1: random mix across every boundary (page-level handler — it owns
   *  the boundary list + the single-commit history push). */
  onRandomMix?: () => void;
  boundaryCount?: number;
}) {
  const info = TRANSITION_STYLE_INFO[transition.style];
  const hasOverrides =
    !!transition.overrides && Object.keys(transition.overrides).length > 0;
  return (
    <div>
      <Field
        label="Style"
        hint={`${info.hint} ${transition.style === "none" ? "" : "· burned into the export exactly like the preview."}`}
      >
        <div className="grid grid-cols-4 gap-1.5">
          {TX_STYLE_ORDER.map((style) => {
            const active = transition.style === style;
            const si = TRANSITION_STYLE_INFO[style];
            const isDip = style === "dip-black" || style === "dip-white";
            return (
              <button
                key={style}
                type="button"
                role="radio"
                aria-checked={active}
                title={si.hint}
                onClick={() => onTransitionChange({ ...transition, style })}
                className={cn(
                  "ff-tx-tile group flex flex-col items-center gap-1 rounded-md p-1.5 transition-all duration-150",
                  active ? "ff-tx-tile-active" : "hover:bg-white/[0.06]",
                )}
              >
                <div className="ff-tx-stage">
                  <div className="ff-tx-rect ff-tx-a" />
                  <div
                    className={cn("ff-tx-rect ff-tx-b", `ff-anim-${style}`)}
                  />
                  {isDip && (
                    <div
                      className={cn(
                        "ff-tx-veil",
                        style === "dip-white"
                          ? "ff-tx-veil-white"
                          : "ff-tx-veil-black",
                        `ff-anim-veil-${style}`,
                      )}
                    />
                  )}
                </div>
                <span
                  className={cn(
                    "text-[9px] font-medium leading-none",
                    active ? "text-teal-400" : "text-stone-500",
                  )}
                >
                  {si.label}
                </span>
              </button>
            );
          })}
        </div>
      </Field>

      {/* v5.1: one-click boundary strategies. Random mix pins a no-repeat
          random style to EVERY boundary via the overrides map (page-level,
          one undo step); Apply-to-all keeps the global style and clears the
          overrides. */}
      {(onRandomMix != null || hasOverrides) && boundaryCount > 0 && (
        <div className="mb-3 flex items-center gap-1.5">
          {onRandomMix != null && boundaryCount > 1 && (
            <button
              type="button"
              onClick={onRandomMix}
              className="ff-btn-ghost flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[10px] font-semibold transition-all duration-150 active:scale-[0.97]"
              title={`Assign a random transition (no back-to-back repeats) to all ${boundaryCount} boundaries`}
            >
              <Dices className="size-3" /> Random mix
            </button>
          )}
          {hasOverrides && (
            <button
              type="button"
              onClick={() =>
                onTransitionChange({ ...transition, overrides: undefined })
              }
              className="ff-btn-ghost flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[10px] font-semibold transition-all duration-150 active:scale-[0.97]"
              title="Use the global style everywhere — clears every per-boundary pin"
            >
              <RotateCcw className="size-3" /> Apply to all
            </button>
          )}
        </div>
      )}

      {transition.style !== "none" && (
        <Field
          label={`Duration — ${(transition.durationMs / 1000).toFixed(1)}s`}
          hint="Auto-shortened on very brief segments (max 45% of the segment) so a clip is never all-transition."
        >
          <input
            type="range"
            min={200}
            max={1500}
            step={100}
            value={transition.durationMs}
            onChange={(e) =>
              onTransitionChange({
                ...transition,
                durationMs: Number(e.target.value),
              })
            }
            className="w-full accent-orange-600"
            aria-label="Transition duration"
          />
        </Field>
      )}

      <Row label="Fade video in / out">
        <Toggle
          checked={transition.fadeStartEnd}
          onChange={(v) =>
            onTransitionChange({ ...transition, fadeStartEnd: v })
          }
          label=""
        />
      </Row>
      <p className="mt-1 text-[10px] leading-relaxed text-stone-500">
        Start/end fades ease the whole video (captions included) from and to
        black — a clean opener/outro even with hard cuts.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Watermark section (v4.4) — logo overlay with 3×3 position picker
// ---------------------------------------------------------------------------
const WM_POSITIONS: WatermarkPosition[] = [
  "top-left",
  "top",
  "top-right",
  "left",
  "center",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
];

function WatermarkSection({
  image,
  settings,
  onFile,
  onSettingsChange,
  openPicker,
}: {
  image: { url: string; fileName: string } | null;
  settings: WatermarkSettings;
  onFile: (file: File | null) => void;
  onSettingsChange: (w: WatermarkSettings) => void;
  openPicker: () => void;
}) {
  return (
    <div>
      <Field
        label="Logo image"
        hint="PNG with transparency works best. Burned into every frame UNDER the captions — export matches the preview exactly."
      >
        {image ? (
          <div
            className="flex items-center gap-2.5 rounded-lg border p-2"
            style={{ borderColor: "#2b2723", backgroundColor: "#26221e" }}
          >
            <div
              className="flex size-10 shrink-0 items-center justify-center rounded-lg"
              style={{
                backgroundColor: "#26221e",
                boxShadow: "inset 0 0 0 1px rgba(0, 0, 0, 0.45)",
              }}
            >
              <img
                src={image.url}
                alt="watermark"
                className="max-h-8 max-w-8 object-contain"
                draggable={false}
              />
            </div>
            <div className="min-w-0 flex-1">
              <div
                className="truncate text-[11px] font-medium text-stone-200"
                title={image.fileName}
              >
                {image.fileName}
              </div>
              <div className="text-[9px] text-stone-500">
                branded on every frame
              </div>
            </div>
            <button
              type="button"
              onClick={() => onFile(null)}
              className="shrink-0 rounded p-1 transition-colors hover:bg-rose-500/10 hover:text-rose-400"
              style={{ color: "#8f887f" }}
              title="Remove watermark"
              aria-label="Remove watermark"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={openPicker}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-3 text-[11px] font-semibold transition-all hover:-translate-y-px"
            style={{ borderColor: "#332e28", color: "#8f887f" }}
          >
            <Upload className="size-3.5" />
            Upload logo / watermark
          </button>
        )}
      </Field>

      {image && (
        <>
          <Field label="Position">
            <div
              className="grid w-max grid-cols-3 gap-1"
              role="radiogroup"
              aria-label="Watermark position"
            >
              {WM_POSITIONS.map((pos) => {
                const active = settings.position === pos;
                const row = pos.startsWith("top")
                  ? 0
                  : pos.startsWith("bottom")
                    ? 2
                    : 1;
                const col = pos.endsWith("left")
                  ? 0
                  : pos.endsWith("right")
                    ? 2
                    : 1;
                return (
                  <button
                    key={pos}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    title={pos}
                    onClick={() =>
                      onSettingsChange({ ...settings, position: pos })
                    }
                    className={cn(
                      "ff-wm-cell group flex size-7 items-center justify-center rounded transition-all active:scale-90",
                      active ? "ff-wm-cell-active" : "hover:bg-white/[0.06]",
                    )}
                  >
                    <span
                      className={cn(
                        "size-1.5 rounded-sm transition-all",
                        active
                          ? "ff-wm-dot-active"
                          : "bg-stone-500 group-hover:bg-stone-400",
                      )}
                      style={
                        !active
                          ? {
                              transform: `translate(${(col - 1) * 5}px, ${(row - 1) * 5}px)`,
                            }
                          : undefined
                      }
                    />
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label={`Size — ${settings.sizePercent}% of width`}>
            <input
              type="range"
              min={5}
              max={50}
              step={1}
              value={settings.sizePercent}
              onChange={(e) =>
                onSettingsChange({
                  ...settings,
                  sizePercent: Number(e.target.value),
                })
              }
              className="w-full accent-orange-600"
              aria-label="Watermark size"
            />
          </Field>

          <Field label={`Opacity — ${settings.opacity}%`}>
            <input
              type="range"
              min={10}
              max={100}
              step={5}
              value={settings.opacity}
              onChange={(e) =>
                onSettingsChange({
                  ...settings,
                  opacity: Number(e.target.value),
                })
              }
              className="w-full accent-orange-600"
              aria-label="Watermark opacity"
            />
          </Field>

          <Field
            label={`Margin — ${settings.marginPercent}%`}
            hint="Distance from the edges (scales with the video width)."
          >
            <input
              type="range"
              min={0}
              max={10}
              step={1}
              value={settings.marginPercent}
              onChange={(e) =>
                onSettingsChange({
                  ...settings,
                  marginPercent: Number(e.target.value),
                })
              }
              className="w-full accent-orange-600"
              aria-label="Watermark margin"
            />
          </Field>
        </>
      )}
    </div>
  );
}

function HeadlineSection({
  items,
  onAdd,
  onUpdate,
  onRemove,
  totalMs,
}: HeadlineSectionProps) {
  const clampMs = (v: number) =>
    Math.max(0, Math.min(v, Math.max(totalMs, 60000)));

  return (
    // `key` remounts the section when items appear/disappear so the
    // auto-open (items present → expanded) also applies to headlines
    // restored from localStorage/project files AFTER the first mount.
    <Section
      key={items.length > 0 ? "hl-with-items" : "hl-empty"}
      icon={<Type size={13} />}
      title="Stack Text"
      defaultOpen={items.length > 0}
    >
      <p className="mb-3 text-[10px] leading-relaxed text-stone-500">
        Big hook titles — 6 layouts × kinetic styles, burned into the export
        exactly like the preview.
      </p>

      {/* Status line */}
      <div className="mb-3 flex items-center gap-1.5 text-[10px] text-stone-500">
        <Clock size={10} />
        {items.length === 0 ? (
          <span>No titles — add one to build your hook.</span>
        ) : (
          <span>
            {items.length} title{items.length === 1 ? "" : "s"} ·{" "}
            {(
              items.reduce((n, h) => n + (h.endMs - h.startMs), 0) / 1000
            ).toFixed(1)}
            s total
          </span>
        )}
      </div>

      {/* Item list */}
      <div className="mb-3 space-y-2">
        {items.map((item, idx) => {
          const preset = getHeadlinePreset(item.presetId);
          const dur = (item.endMs - item.startMs) / 1000;
          const invalid = item.endMs <= item.startMs;
          // v1.17 Stack Text: effective layout (legacy items derive one from
          // their position) + effective style (kinetic stackStyle, or the
          // legacy simple animation when the item has none).
          const effLayout: StackLayoutId =
            item.stackLayout ?? legacyLayoutFor(item.position);
          const effStyle: string =
            item.stackStyle && isKineticStyle(item.stackStyle)
              ? item.stackStyle
              : item.animation;
          return (
            <div
              key={item.id}
              className="rounded-lg border p-2.5 transition-colors"
              style={{
                borderColor: invalid ? "rgba(225, 29, 72, 0.45)" : "#2b2723",
                backgroundColor: "#26221e",
              }}
            >
              {/* Header row: index + preset name + remove */}
              <div className="mb-2 flex items-center gap-2">
                <span
                  className="rounded px-1.5 py-0.5 text-[9px] font-bold tabular-nums"
                  style={{
                    backgroundColor: "rgba(234, 88, 12, 0.15)",
                    color: "#fdba74",
                  }}
                >
                  {idx + 1}
                </span>
                {/* Mini live swatch of the preset */}
                <span
                  className="flex h-5 min-w-[46px] items-center justify-center overflow-hidden rounded px-1.5 text-[8px]"
                  style={{
                    backgroundColor: preset.bgColor
                      ? `${preset.bgColor}${Math.round(preset.bgAlpha * 255)
                          .toString(16)
                          .padStart(2, "0")}`
                      : "transparent",
                    border: preset.borderColor
                      ? `1px solid ${preset.borderColor}`
                      : "1px solid transparent",
                    color: preset.textColor,
                    fontFamily: preset.fontFamily,
                    fontWeight: preset.fontWeight,
                    fontStyle:
                      preset.fontStyle === "italic" ? "italic" : "normal",
                    letterSpacing: Math.min(1.5, preset.letterSpacing / 2),
                    textTransform:
                      preset.textTransform === "uppercase"
                        ? "uppercase"
                        : "none",
                    textShadow:
                      preset.shadow && preset.shadowBlur > 0
                        ? `0 0 ${Math.max(2, preset.shadowBlur / 2)}px ${
                            preset.accentColor || preset.shadowColor
                          }`
                        : undefined,
                  }}
                >
                  Hook
                </span>
                <span className="flex-1 truncate text-[10px] text-stone-500">
                  {preset.name}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(item.id)}
                  className="rounded p-1 text-stone-500 transition-colors hover:bg-rose-500/10 hover:text-rose-400"
                  title="Remove title"
                >
                  <Trash2 size={12} />
                </button>
              </div>

              {/* Text */}
              <textarea
                value={item.text}
                rows={2}
                onChange={(e) => onUpdate(item.id, { text: e.target.value })}
                placeholder="YOUR HOOK HERE — keep it under 8 words"
                className="mb-2 w-full resize-none rounded border bg-[#211e1a] px-2 py-1.5 text-[11px] text-stone-300 placeholder:text-stone-500 focus:border-orange-500"
                style={{ borderColor: "#332e28" }}
                aria-label={`Headline ${idx + 1} text`}
              />

              {/* Timing */}
              <div className="mb-2 flex items-center gap-1.5">
                <label className="flex items-center gap-1 text-[10px] text-stone-500">
                  <Clock size={10} />
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={(item.startMs / 1000).toFixed(1)}
                    onChange={(e) =>
                      onUpdate(item.id, {
                        startMs: clampMs(
                          Math.round(parseFloat(e.target.value) * 1000) || 0,
                        ),
                      })
                    }
                    className="w-16 rounded border bg-[#211e1a] px-1.5 py-1 text-[10px] tabular-nums text-stone-300 focus:border-orange-500"
                    style={{ borderColor: "#332e28" }}
                    aria-label="Start time (seconds)"
                  />
                  s →
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={(item.endMs / 1000).toFixed(1)}
                    onChange={(e) =>
                      onUpdate(item.id, {
                        endMs: clampMs(
                          Math.round(parseFloat(e.target.value) * 1000) || 0,
                        ),
                      })
                    }
                    className="w-16 rounded border bg-[#211e1a] px-1.5 py-1 text-[10px] tabular-nums text-stone-300 focus:border-orange-500"
                    style={{ borderColor: "#332e28" }}
                    aria-label="End time (seconds)"
                  />
                  s
                </label>
                <span
                  className={cn(
                    "ml-auto rounded px-1.5 py-0.5 text-[9px] tabular-nums",
                    invalid
                      ? "bg-rose-500/15 text-rose-400"
                      : "bg-[#26221e] text-stone-500",
                  )}
                >
                  {invalid ? "end ≤ start" : `${dur.toFixed(1)}s`}
                </span>
              </div>

              {/* Preset select (visual style) */}
              <select
                value={item.presetId}
                onChange={(e) =>
                  onUpdate(item.id, { presetId: e.target.value })
                }
                className="mb-2 w-full rounded border bg-[#211e1a] px-2 py-1.5 text-[11px] text-stone-300 focus:border-orange-500"
                style={{ borderColor: "#332e28" }}
                aria-label={`Headline ${idx + 1} visual style`}
              >
                {HEADLINE_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.description}
                  </option>
                ))}
              </select>

              {/* v1.17 Stack Text: Layout picker (geometry of the lines) */}
              <label
                className="mb-0.5 block text-[10px] font-medium text-stone-500"
                htmlFor={`stack-layout-${item.id}`}
              >
                Layout
              </label>
              <select
                id={`stack-layout-${item.id}`}
                value={effLayout}
                onChange={(e) =>
                  onUpdate(item.id, {
                    stackLayout: e.target.value as StackLayoutId,
                  })
                }
                className="mb-2 w-full rounded border bg-[#211e1a] px-2 py-1.5 text-[11px] text-stone-300 focus:border-orange-500"
                style={{ borderColor: "#332e28" }}
                aria-label={`Headline ${idx + 1} layout`}
              >
                {STACK_LAYOUTS.map((l) => (
                  <option key={l.id} value={l.id} title={l.hint}>
                    {l.name} — {l.hint}
                  </option>
                ))}
              </select>

              {/* v1.17 Stack Text: Style picker (8 kinetic + 4 simple) */}
              <label
                className="mb-0.5 block text-[10px] font-medium text-stone-500"
                htmlFor={`stack-style-${item.id}`}
              >
                Style
              </label>
              <select
                id={`stack-style-${item.id}`}
                value={effStyle}
                onChange={(e) => {
                  const v = e.target.value;
                  if (isKineticStyle(v)) {
                    // Kinetic: stackStyle wins, legacy animation neutralized.
                    onUpdate(item.id, {
                      stackStyle: v as StackStyleId,
                      animation: "none",
                    });
                  } else {
                    // Simple: legacy animation wins, stackStyle cleared.
                    onUpdate(item.id, {
                      stackStyle: undefined,
                      animation: v as HeadlineItem["animation"],
                    });
                  }
                }}
                className="mb-1.5 w-full rounded border bg-[#211e1a] px-2 py-1.5 text-[11px] text-stone-300 focus:border-orange-500"
                style={{ borderColor: "#332e28" }}
                aria-label={`Headline ${idx + 1} animation style`}
              >
                <optgroup label="Kinetic">
                  {STACK_STYLES.map((s) => (
                    <option key={s.id} value={s.id} title={s.hint}>
                      {s.name} — {s.hint}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Simple">
                  {SIMPLE_STYLES.map((s) => (
                    <option key={s.id} value={s.id} title={s.hint}>
                      {s.name} — {s.hint}
                    </option>
                  ))}
                </optgroup>
              </select>

              {/* Animated live style preview */}
              <StackStylePreview
                text={item.text}
                styleId={effStyle}
                accentColor={preset.accentColor || "#FACC15"}
              />
              <p className="mb-1 mt-1 text-[9px] leading-relaxed text-stone-500">
                Kinetic styles render via the ASS compositor at export — the
                engine picks automatically.
              </p>

              {/* Size */}
              <div className="mt-2">
                <Field
                  label="Size"
                  hint={`${(item.sizeScale * 100).toFixed(0)}%`}
                >
                  <input
                    type="range"
                    min={0.5}
                    max={2}
                    step={0.05}
                    value={item.sizeScale}
                    onChange={(e) =>
                      onUpdate(item.id, { sizeScale: Number(e.target.value) })
                    }
                    className="w-full accent-orange-600"
                    aria-label={`Headline ${idx + 1} size`}
                  />
                </Field>
              </div>
            </div>
          );
        })}
      </div>

      {/* Add button */}
      <button
        type="button"
        onClick={onAdd}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed py-2 text-[11px] font-medium transition-all hover:border-orange-500/50 hover:bg-orange-500/10"
        style={{ borderColor: "#332e28", color: "#b5aea3" }}
      >
        <Plus size={13} className="text-orange-600" /> Add title
      </button>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Captions section
// ---------------------------------------------------------------------------
interface CaptionsSectionProps {
  captionSettings: CaptionSettings;
  onCaptionSettingsChange: (cs: CaptionSettings) => void;
  onApplyPreset: (presetId: string) => void;
  /** v4.7: starred preset ids (Favorites group + filter). */
  favoritePresets: string[];
  onToggleFavorite: (presetId: string) => void;
  onExportSrt: () => void;
  onExportAss: () => void;
  /** WebVTT sidecar (v4.4). */
  onExportVtt: () => void;
  /** Karaoke word-level WebVTT (v4.6). */
  onExportVttWords: () => void;
  inElectron: boolean;
  subtitles: SubtitleFile | null;
  hasAudio: boolean;
  onGenerateCaptions: () => void;
  whisperBusy: boolean;
  whisperProgress: WhisperProgress | null;
  whisperLanguage: string;
  onWhisperLanguageChange: (lang: string) => void;
  /** v1.25: convert ROMANIZED (QWERTY) subtitles to native Devanagari /
   *  Nastaliq script — page owns the cue mutation + undo step. */
  onConvertSubtitlesToNative?: () => void;
  /** v1.20: transcription model (Groq whisper model id — kept wired for the
   *  app-level STT preference; the local size picker is gone with the engines). */
  whisperModel: string;
  onWhisperModelChange: (model: string) => void;
  /** v1.3: transcription source available (audio track OR a video clip). */
  hasSpeechSource: boolean;
}

function CaptionsSection(props: CaptionsSectionProps) {
  const {
    captionSettings,
    onCaptionSettingsChange,
    onApplyPreset,
    favoritePresets,
    onToggleFavorite,
    onExportSrt,
    onExportAss,
    onExportVtt,
    onExportVttWords,
    inElectron,
    subtitles,
    hasAudio,
    onGenerateCaptions,
    whisperBusy,
    whisperProgress,
    whisperLanguage,
    onWhisperLanguageChange,
    onConvertSubtitlesToNative,
    hasSpeechSource,
  } = props;

  const set = (patch: Partial<CaptionSettings>) =>
    onCaptionSettingsChange({ ...captionSettings, ...patch });

  /** v4.6: preset search + category filter (42 presets need discoverability). */
  const [presetQuery, setPresetQuery] = useState("");
  const [presetCat, setPresetCat] = useState<
    "all" | "favorites" | CaptionPreset["category"]
  >("all");
  const q = presetQuery.trim().toLowerCase();
  const isFav = (p: CaptionPreset) => favoritePresets.includes(p.id);
  const showFavGroup = presetCat === "all" && !q && favoritePresets.length > 0;
  const matchesQuery = (p: CaptionPreset) =>
    !q ||
    p.name.toLowerCase().includes(q) ||
    p.description.toLowerCase().includes(q) ||
    p.id.toLowerCase().includes(q) ||
    (p.animation ?? "").toLowerCase().includes(q) ||
    (p.wordMode ?? "").includes(q);
  const filteredCategories = presetsByCategory()
    .map((cat) => ({
      ...cat,
      presets: cat.presets.filter((p) => {
        if (presetCat === "favorites") return isFav(p) && matchesQuery(p);
        // When the favorites group is pinned on top, skip the duplicate
        // copy in the preset's home category.
        if (showFavGroup && isFav(p)) return false;
        if (presetCat !== "all" && p.category !== presetCat) return false;
        return matchesQuery(p);
      }),
    }))
    .filter((cat) => cat.presets.length > 0);
  // v4.7: favorites pinned to the top when browsing all styles unfiltered.
  const favGroup = showFavGroup
    ? {
        category: "favorites",
        label: "★ Favorites",
        hint: "Your starred presets",
        presets: presetsByCategory()
          .flatMap((c) => c.presets)
          .filter((p) => favoritePresets.includes(p.id)),
      }
    : null;
  const matchCount = filteredCategories.reduce(
    (n, c) => n + c.presets.length,
    0,
  );

  const preset = getCaptionPreset(captionSettings.presetId);
  const hasCues = !!subtitles && subtitles.cues.length > 0;
  const hasWords =
    hasCues && subtitles!.cues.some((c) => c.words && c.words.length > 0);
  // v1.18: while the kinetic engine is active (and word timing exists — the
  // engine needs it), its semantic compositions REPLACE word mode + the
  // per-word animation pickers, so those two fields hide.
  const kineticOn = hasWords && !!captionSettings.kinetic?.enabled;

  // ── v1.15 STT engine routing (Groq Cloud — the only engine) ──────────────
  // App-level preference (localStorage, never in project files). The Groq
  // API key itself lives in the MAIN process (userData/groq.json, 0600) and
  // only a MASKED form ever crosses the bridge.
  const groqApi =
    typeof window !== "undefined" && window.electronAPI
      ? (window.electronAPI as unknown as {
          whisperGroqGet?: () => Promise<GroqConfigPayload>;
          whisperGroqSet?: (p: {
            apiKey?: string;
            model?: string;
          }) => Promise<GroqConfigPayload>;
          whisperGroqTest?: (p: {
            apiKey?: string;
          }) => Promise<{ ok: boolean; message: string; whisperModels: string[] }>;
        })
      : undefined;
  const [groqCfg, setGroqCfg] = useState<GroqConfigPayload | null>(null);
  const [groqKeyInput, setGroqKeyInput] = useState("");
  const [groqKeyEditing, setGroqKeyEditing] = useState(false);
  const [groqBusy, setGroqBusy] = useState<"" | "save" | "test" | "clear">("");

  // Load the on-device Groq config once (masked key presence + model).
  useEffect(() => {
    const get = groqApi?.whisperGroqGet;
    if (!get) return;
    let cancelled = false;
    get()
      .then((cfg) => {
        if (!cancelled && cfg) {
          setGroqCfg(cfg);
          // Mirror any main-side model drift into the app preference.
          const cur = loadSttSettings();
          if (cur.groqModel !== cfg.model) {
            saveSttSettings({ ...cur, groqModel: cfg.model });
          }
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const saveGroqKey = useCallback(async () => {
    const set = groqApi?.whisperGroqSet;
    const key = groqKeyInput.trim();
    if (!set) return;
    if (!key) {
      toast.error("Paste an API key first", {
        description: "Create a free key at console.groq.com → API Keys.",
      });
      return;
    }
    setGroqBusy("save");
    try {
      const cfg = await set({ apiKey: key });
      setGroqCfg(cfg);
      setGroqKeyInput("");
      setGroqKeyEditing(false);
      toast.success("Groq API key saved on this device", {
        description: "whisper-large-v3-turbo is now the default captions engine.",
      });
    } catch (err) {
      toast.error("Could not save the key", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setGroqBusy("");
    }
  }, [groqApi, groqKeyInput]);

  const clearGroqKey = useCallback(async () => {
    const set = groqApi?.whisperGroqSet;
    if (!set) return;
    setGroqBusy("clear");
    try {
      const cfg = await set({ apiKey: "" });
      setGroqCfg(cfg);
      // v1.20: Groq is the ONLY engine — clearing the key does NOT switch
      // any preference; the card simply returns to the "add key" state.
      toast.success("API key removed", {
        description: "Paste a Groq API key to transcribe again.",
      });
    } catch (err) {
      toast.error("Could not remove the key", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setGroqBusy("");
    }
  }, [groqApi]);

  const testGroqKey = useCallback(async () => {
    const test = groqApi?.whisperGroqTest;
    if (!test) return;
    setGroqBusy("test");
    try {
      const r = await test(
        groqKeyEditing && groqKeyInput.trim()
          ? { apiKey: groqKeyInput.trim() }
          : {},
      );
      if (r.ok) {
        toast.success("Groq key works", {
          description:
            r.whisperModels.length > 0
              ? `Available: ${r.whisperModels.slice(0, 3).join(", ")}`
              : r.message,
        });
      } else {
        toast.error("Groq key check failed", { description: r.message });
      }
    } catch (err) {
      toast.error("Could not reach Groq", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setGroqBusy("");
    }
  }, [groqApi, groqKeyEditing, groqKeyInput]);

  const pickGroqModel = useCallback(
    async (model: string) => {
      const cur = loadSttSettings();
      saveSttSettings({ ...cur, groqModel: model });
      const set = groqApi?.whisperGroqSet;
      if (set) {
        try {
          const cfg = await set({ model });
          setGroqCfg(cfg);
        } catch {
          /* main-side persistence is best-effort; the preference is set */
        }
      }
    },
    [groqApi],
  );

  return (
    <Section icon={<Captions size={13} />} title="Captions" defaultOpen>
      {/* ── Whisper generation ── */}
      <div
        className="mb-4 rounded-lg border p-3"
        style={{ borderColor: "#2b2723", backgroundColor: "#26221e" }}
      >
        <div className="mb-2 flex items-center gap-1.5">
          <Sparkles size={12} className="text-orange-600" />
          <span className="text-[11px] font-semibold text-stone-200">
            AI Captions (Whisper)
          </span>
        </div>

        {/* ── v1.15/v1.20: Speech-to-text ENGINE — Groq Cloud (only) ── */}
        <div
          className="mb-2.5 rounded-lg border p-2.5"
          style={{ borderColor: "#2b2723", backgroundColor: "#211e1a" }}
        >
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-stone-500">
              Engine
            </span>
            {groqCfg?.hasKey && (
              <span
                className="flex items-center gap-1 text-[10px] font-medium text-emerald-300"
                title="Groq key saved on this device"
              >
                <Check size={10} /> Key saved
              </span>
            )}
          </div>
          {/* v1.20: Groq Cloud is the ONLY engine — a fixed badge, no toggle. */}
          <div
            className="flex items-center justify-center gap-1.5 rounded border border-orange-500/50 bg-orange-500/15 px-2 py-1.5 text-[11px] font-medium text-orange-300"
            aria-label="Groq Cloud — the only transcription engine"
            title="Groq Cloud — the only transcription engine (cloud transcription with your own free API key)"
          >
            <Cloud size={12} />
            Groq Cloud
            <span className="rounded-full bg-orange-500/20 px-1.5 py-px text-[8px] font-semibold uppercase">
              Only engine
            </span>
          </div>
          <p className="mt-1.5 text-[9px] leading-relaxed text-stone-400">
            Groq Cloud is the only transcription engine — a free API key is
            all it needs.
          </p>

          <div className="mt-2">
              {!inElectron || !groqApi?.whisperGroqGet ? (
                <p className="text-[10px] leading-relaxed text-stone-500">
                  Transcription runs in the FrameFuse desktop app — add your
                  free Groq API key there (Settings → Captions).
                </p>
              ) : groqCfg?.hasKey && !groqKeyEditing ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <KeyRound size={11} className="shrink-0 text-orange-600" />
                    <span
                      className="flex-1 truncate rounded border bg-[#26221e] px-2 py-1 font-mono text-[10px] text-stone-400"
                      style={{ borderColor: "#2b2723" }}
                      title={groqCfg.maskedKey}
                    >
                      {groqCfg.maskedKey}
                    </span>
                  </div>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={testGroqKey}
                      disabled={groqBusy !== ""}
                      className="flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-medium text-stone-400 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
                      style={{ borderColor: "#332e28" }}
                    >
                      {groqBusy === "test" ? (
                        <Loader2 size={10} className="animate-spin" />
                      ) : (
                        <BadgeCheck size={10} />
                      )}
                      Test key
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setGroqKeyEditing(true);
                        setGroqKeyInput("");
                      }}
                      disabled={groqBusy !== ""}
                      className="rounded border px-2 py-1 text-[10px] font-medium text-stone-400 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
                      style={{ borderColor: "#332e28" }}
                    >
                      Replace
                    </button>
                    <button
                      type="button"
                      onClick={clearGroqKey}
                      disabled={groqBusy !== ""}
                      className="flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-medium text-rose-400/90 transition-colors hover:bg-rose-500/10 hover:border-rose-500/50 disabled:cursor-not-allowed disabled:opacity-50"
                      style={{ borderColor: "#332e28" }}
                    >
                      {groqBusy === "clear" ? (
                        <Loader2 size={10} className="animate-spin" />
                      ) : (
                        <Trash2 size={10} />
                      )}
                      Remove
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <input
                    type="password"
                    value={groqKeyInput}
                    onChange={(e) => setGroqKeyInput(e.target.value)}
                    placeholder="gsk_… paste your Groq API key"
                    spellCheck={false}
                    autoComplete="off"
                    className="w-full rounded border bg-[#211e1a] px-2 py-1.5 font-mono text-[10px] text-stone-300 placeholder:text-stone-500 focus:border-orange-500/60 focus:outline-none"
                    style={{ borderColor: "#332e28" }}
                    aria-label="Groq API key"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void saveGroqKey();
                      }
                    }}
                  />
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={saveGroqKey}
                      disabled={groqBusy !== "" || !groqKeyInput.trim()}
                      className="flex items-center gap-1 rounded bg-orange-500 px-2.5 py-1 text-[10px] font-semibold text-white transition-colors hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {groqBusy === "save" ? (
                        <Loader2 size={10} className="animate-spin" />
                      ) : (
                        <KeyRound size={10} />
                      )}
                      Save key
                    </button>
                    {groqKeyEditing && (
                      <button
                        type="button"
                        onClick={() => {
                          setGroqKeyEditing(false);
                          setGroqKeyInput("");
                        }}
                        className="rounded border px-2 py-1 text-[10px] font-medium text-stone-500 transition-colors hover:bg-white/[0.06]"
                        style={{ borderColor: "#332e28" }}
                      >
                        Cancel
                      </button>
                    )}
                    <a
                      href="https://console.groq.com/keys"
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto flex items-center gap-1 text-[10px] font-medium text-orange-400 underline-offset-2 hover:underline"
                    >
                      Get a free key
                      <ExternalLink size={9} />
                    </a>
                  </div>
                </div>
              )}

              {/* Cloud model — turbo is the default (faster). */}
              <div className="mt-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-stone-500">
                    Cloud model
                  </span>
                  <span className="text-[9px] text-stone-400">Whisper large</span>
                </div>
                <div className="grid grid-cols-2 gap-1">
                  {GROQ_MODEL_OPTIONS.map((m) => {
                    const active =
                      (groqCfg?.model ?? loadSttSettings().groqModel) === m.id;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => {
                          void pickGroqModel(m.id);
                        }}
                        title={m.hint}
                        className={cn(
                          "rounded border px-2 py-1.5 text-[10px] font-medium transition-colors",
                          active
                            ? "border-orange-500/50 bg-orange-500/15 text-orange-300"
                            : "border-[#2b2723] bg-[#26221e] text-stone-500 hover:bg-white/[0.04] hover:text-stone-300",
                        )}
                        aria-pressed={active}
                      >
                        {m.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <p className="mt-2 text-[9px] leading-relaxed text-stone-400">
                Your key stays on this device; audio is sent to api.groq.com
                for transcription only.
              </p>
            </div>
        </div>
        <div className="mb-2 flex gap-2">
          <select
            value={whisperLanguage}
            onChange={(e) => onWhisperLanguageChange(e.target.value)}
            className="min-w-0 flex-1 rounded border bg-[#211e1a] px-2 py-1.5 text-[11px] text-stone-300 focus:border-orange-500"
            style={{ borderColor: "#332e28" }}
            aria-label="Whisper language"
          >
            {WHISPER_LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={onGenerateCaptions}
          disabled={whisperBusy || !hasSpeechSource}
          className={cn(
            "flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-semibold transition-colors",
            whisperBusy || !hasSpeechSource
              ? "cursor-not-allowed bg-[#26221e] text-stone-400"
              : "bg-orange-600 text-white hover:bg-orange-500",
          )}
        >
          {whisperBusy ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Sparkles size={13} />
          )}
          {whisperBusy ? "Working…" : "Generate captions"}
        </button>
        {whisperProgress && (
          <div className="mt-2">
            <div className="h-1 w-full overflow-hidden rounded-full bg-[#332e28]">
              <div
                className="h-full bg-gradient-to-r from-orange-400 to-orange-600 transition-all"
                style={{ width: `${whisperProgress.progress}%` }}
              />
            </div>
            <p className="mt-1 truncate text-[10px] text-stone-500">
              {whisperProgress.status}
            </p>
          </div>
        )}
        <p className="mt-2 text-[10px] leading-relaxed text-stone-500">
          Speech is taken from your audio track, or the first video clip when no
          track is loaded.
        </p>

        {/* v1.25 QWERTY captions: romanized (Hinglish / Roman Urdu) subtitle
            text converts to native Devanagari / Nastaliq so burn-in + kinetic
            typography render properly (and hi-IN / ur-PK voices read it
            naturally). Shown for Hindi/Urdu transcriptions with cues loaded. */}
        {subtitles != null &&
          (whisperLanguage === "hi" || whisperLanguage === "ur") &&
          onConvertSubtitlesToNative != null && (
            <div
              className="mt-2 rounded-md border px-2.5 py-2"
              style={{
                borderColor: "rgba(13, 148, 136, 0.35)",
                backgroundColor: "#10201d",
              }}
            >
              <p className="text-[10px] leading-relaxed text-stone-400">
                Typed the captions on a QWERTY keyboard (Hinglish / Roman
                Urdu)? Convert them to native script for clean burn-in and
                word-perfect karaoke timing.
              </p>
              <button
                type="button"
                onClick={onConvertSubtitlesToNative}
                className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[10px] font-semibold transition-colors hover:brightness-110"
                style={{
                  borderColor: "rgba(13, 148, 136, 0.5)",
                  backgroundColor: "#14b8a6",
                  color: "#ffffff",
                }}
                title={
                  whisperLanguage === "hi"
                    ? "Romanized → Devanagari (editable, one undo step)"
                    : "Romanized → Nastaliq Urdu (editable, one undo step)"
                }
              >
                <Languages size={11} />
                Convert to {whisperLanguage === "hi" ? "Devanagari" : "Urdu script"}
              </button>
            </div>
          )}

      </div>

      {/* ── Burn-in toggle + source status ── */}
      <div className="mb-3">
        <Toggle
          checked={captionSettings.enabled}
          onChange={(v) => set({ enabled: v })}
          label="Burn captions into video"
        />
      </div>
      <div className="mb-3 text-[10px] text-stone-500">
        {subtitles ? (
          <>
            <span className="text-stone-400">{subtitles.fileName}</span> ·{" "}
            {subtitles.cues.length} cue{subtitles.cues.length === 1 ? "" : "s"}
            {hasWords && (
              <span className="text-emerald-300"> · word timing ✓</span>
            )}
          </>
        ) : (
          "No subtitle source — generate from audio or drop a .srt file."
        )}
      </div>

      {/* ── Preset picker (searchable, filterable, grouped — v4.6) ── */}
      <Field
        label="Style preset"
        hint={`${preset.name} — ${preset.description}`}
      >
        {/* Search + category chips */}
        <div className="mb-1.5 flex gap-1">
          <div className="relative flex-1">
            <Search
              size={11}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-stone-500"
            />
            <input
              value={presetQuery}
              onChange={(e) => setPresetQuery(e.target.value)}
              placeholder="Search 42 presets…"
              className="w-full rounded-md border bg-[#211e1a] py-1 pl-6 pr-2 text-[10px] text-stone-300 placeholder:text-stone-500 focus:border-orange-500"
              style={{ borderColor: "#332e28" }}
              aria-label="Search caption presets"
            />
            {presetQuery && (
              <button
                type="button"
                onClick={() => setPresetQuery("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-stone-400 hover:text-stone-300"
                title="Clear search"
              >
                <X size={10} />
              </button>
            )}
          </div>
          <div className="relative">
            <select
              value={presetCat}
              onChange={(e) => setPresetCat(e.target.value as typeof presetCat)}
              className="h-full appearance-none rounded-md border bg-[#211e1a] pl-2 pr-6 text-[10px] text-stone-300 focus:border-orange-500"
              style={{ borderColor: "#332e28" }}
              aria-label="Filter presets by category"
              title="Filter by category"
            >
              <option value="all">All styles</option>
              {favoritePresets.length > 0 && (
                <option value="favorites">
                  ★ Favorites ({favoritePresets.length})
                </option>
              )}
              {PRESET_CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <ChevronDown
              size={10}
              className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-stone-500"
            />
          </div>
        </div>
        {matchCount === 0 ? (
          <div
            className="rounded-md border border-dashed px-3 py-4 text-center text-[10px] text-stone-500"
            style={{ borderColor: "#332e28" }}
          >
            No presets match “{presetQuery.trim()}”
          </div>
        ) : (
          <div
            className="max-h-72 overflow-y-auto rounded-md border"
            style={{ borderColor: "#2b2723" }}
          >
            {[favGroup, ...filteredCategories]
              .filter((g): g is NonNullable<typeof g> => !!g)
              .map((cat) => (
                <div key={cat.category}>
                  <div
                    className={cn(
                      "sticky top-0 z-10 bg-[#211e1a] px-2 py-1 text-[9px] font-bold uppercase tracking-widest",
                      cat.category === "favorites"
                        ? "text-orange-400/90"
                        : "text-stone-500",
                    )}
                    title={cat.hint}
                  >
                    {cat.label}
                  </div>
                  {cat.presets.map((p) => {
                    const active = p.id === captionSettings.presetId;
                    const fav = isFav(p);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => onApplyPreset(p.id)}
                        className={cn(
                          "flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors",
                          active ? "bg-[#0e211b]" : "hover:bg-white/[0.04]",
                        )}
                        aria-pressed={active}
                      >
                        {/* Mini live swatch */}
                        <span
                          className="flex h-6 shrink-0 items-center justify-center overflow-hidden rounded px-1.5"
                          style={{
                            backgroundColor: p.bgColor
                              ? `${p.bgColor}${Math.round(p.bgAlpha * 255)
                                  .toString(16)
                                  .padStart(2, "0")}`
                              : "transparent",
                            border: p.borderColor
                              ? `1px solid ${p.borderColor}`
                              : "1px solid transparent",
                            borderRadius: Math.min(6, p.bgRadius / 2),
                            color: p.textColor,
                            fontFamily: p.fontFamily,
                            fontWeight: p.fontWeight,
                            fontStyle:
                              p.fontStyle === "italic" ? "italic" : "normal",
                            fontSize: 9,
                            letterSpacing: Math.min(2, p.letterSpacing / 2),
                            textTransform: p.textTransform,
                            textShadow:
                              p.shadow && p.shadowBlur > 0
                                ? `0 0 ${Math.max(2, p.shadowBlur / 2)}px ${p.shadowColor}`
                                : undefined,
                            minWidth: 54,
                          }}
                        >
                          Quick fox
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[11px] font-medium text-stone-200">
                            {p.name}
                            {p.animation && p.animation !== "none" && (
                              <span className="ml-1 text-[9px] text-emerald-300">
                                ✦
                              </span>
                            )}
                          </span>
                          <span className="block truncate text-[9px] text-stone-500">
                            {p.description}
                          </span>
                        </span>
                        {p.highlightColor && (
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: p.highlightColor }}
                            title="Active-word highlight"
                          />
                        )}
                        {/* v4.7 favorite star — spans inside the row button keep
                        HTML valid; role=button + keyboard handling for a11y. */}
                        <span
                          role="button"
                          tabIndex={0}
                          aria-pressed={fav}
                          aria-label={
                            fav ? "Remove from favorites" : "Add to favorites"
                          }
                          title={
                            fav ? "Remove from favorites" : "Star this preset"
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleFavorite(p.id);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              e.stopPropagation();
                              onToggleFavorite(p.id);
                            }
                          }}
                          className={cn(
                            "shrink-0 rounded p-0.5 transition-all duration-150 hover:scale-125 active:scale-95",
                            fav
                              ? "text-orange-500"
                              : "text-stone-400 hover:text-orange-500/70",
                          )}
                        >
                          <Star
                            className="size-3"
                            fill={fav ? "currentColor" : "none"}
                          />
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
          </div>
        )}
      </Field>

      {/* ── Word mode ── (hidden while the v1.18 kinetic engine owns
          composition + motion) */}
      {!kineticOn && (
        <Field
          label="Word mode"
          hint={
            hasWords
              ? "Word-level timing detected — all modes available."
              : "Word modes need word timestamps — generate captions from audio first."
          }
        >
          <Segmented
            size="sm"
            options={[
              {
                value: "off",
                label: "Full text",
                title: "Standard subtitle block",
              },
              {
                value: "word",
                label: "Karaoke",
                title: "Highlight the spoken word",
              },
              {
                value: "word-only",
                label: "Single",
                title: "One word at a time (Hormozi)",
              },
              {
                value: "stack",
                label: "Stack",
                title: "Words stack as spoken (quote builder)",
              },
            ]}
            value={captionSettings.wordMode}
            onChange={(v) => set({ wordMode: v })}
          />
        </Field>
      )}

      {/* ── v1.18 Kinetic Typography engine (semantic compositions) —
          always rendered (v1.20): the design library shows the 24 presets
          even before word timing exists (dimmed until then) ── */}
      <KineticTypographySection
        captionSettings={captionSettings}
        onCaptionSettingsChange={onCaptionSettingsChange}
        hasWords={hasWords}
      />

      {/* ── Animation ── (hidden while the kinetic engine owns motion) */}
      {!kineticOn && (
        <Field
          label="Kinetic animation"
          hint={
            captionSettings.animation
              ? "Pinned — preset switches keep your choice"
              : "Following preset default (pin to override)"
          }
        >
          <div
            className="max-h-56 overflow-y-auto rounded-md border"
            style={{ borderColor: "#2b2723" }}
          >
            {[
              { id: "classic", label: "Classic" },
              { id: "viral", label: "Viral pack ✦" },
            ].map((grp) => (
              <div key={grp.id}>
                <div className="sticky top-0 z-10 bg-[#211e1a] px-2 py-1 text-[9px] font-bold uppercase tracking-widest text-stone-500">
                  {grp.label}
                </div>
                <div className="grid grid-cols-2 gap-1 p-1">
                  {ANIMATION_LABELS.filter((a) => a.group === grp.id).map((a) => {
                    const active =
                      (captionSettings.animation ||
                        preset.animation ||
                        "none") === a.value;
                    return (
                      <button
                        key={a.value}
                        type="button"
                        title={a.hint}
                        onClick={() =>
                          set({
                            animation: a.value,
                            animationPinned: a.value !== "none" ? true : false,
                          })
                        }
                        className={cn(
                          "rounded px-1.5 py-1.5 text-left text-[10px] font-medium transition-colors",
                          active
                            ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/40"
                            : "bg-[#26221e] text-stone-500 hover:bg-white/[0.08]",
                        )}
                        aria-pressed={active}
                      >
                        {a.label}
                        <span className="block truncate text-[8px] font-normal text-stone-500">
                          {a.hint}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          {captionSettings.animation && (
            <button
              type="button"
              onClick={() => set({ animation: null, animationPinned: false })}
              className="mt-1 flex items-center gap-1 text-[10px] text-stone-500 hover:text-stone-300"
            >
              <RotateCcw size={10} /> Follow preset default
            </button>
          )}
        </Field>
      )}

      {/* ── Font ── */}
      <Field
        label="Font"
        hint="Every option previews in its real typeface — the bundled fonts render identically in preview and export."
      >
        <FontPicker
          value={captionSettings.fontId}
          options={FONT_OPTIONS}
          onChange={(fontId) => {
            if (kineticOn) {
              // v1.18: while the kinetic engine is active the Font picker also
              // drives kinetic.fontOverride so preview + export typography
              // match (the engine's presets would otherwise pick their own).
              onCaptionSettingsChange({
                ...captionSettings,
                fontId,
                kinetic: {
                  ...KINETIC_DEFAULTS,
                  ...captionSettings.kinetic,
                  fontOverride: fontId,
                },
              });
            } else {
              set({ fontId });
            }
          }}
        />
      </Field>

      {/* ── Color override ── */}
      <Field label="Text color" hint="Overrides the preset color.">
        <div className="flex items-center gap-2">
          <label
            className="relative inline-flex h-7 w-10 cursor-pointer items-center justify-center overflow-hidden rounded border"
            style={{ borderColor: "#332e28" }}
          >
            <input
              type="color"
              value={captionSettings.customColor || preset.textColor}
              onChange={(e) => set({ customColor: e.target.value })}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              aria-label="Custom caption color"
            />
            <span
              className="h-4 w-6 rounded-sm"
              style={{
                backgroundColor:
                  captionSettings.customColor || preset.textColor,
              }}
            />
          </label>
          <span className="font-mono text-[10px] text-stone-500">
            {captionSettings.customColor || preset.textColor}
          </span>
          {captionSettings.customColor && (
            <button
              type="button"
              onClick={() => set({ customColor: null })}
              className="ml-auto flex items-center gap-1 text-[10px] text-stone-500 hover:text-stone-300"
            >
              <RotateCcw size={10} /> Preset
            </button>
          )}
        </div>
      </Field>

      {/* ── Position ── */}
      <Field label="Position">
        <div className="flex gap-1">
          {(["top", "center", "bottom"] as const).map((pos) => {
            const active =
              captionSettings.customPosition === pos ||
              (!captionSettings.customPosition && preset.position === pos);
            const isPresetDefault =
              !captionSettings.customPosition && preset.position === pos;
            return (
              <button
                key={pos}
                type="button"
                onClick={() =>
                  set({ customPosition: isPresetDefault ? null : pos })
                }
                className={cn(
                  "flex-1 rounded px-2 py-1.5 text-[10px] font-medium capitalize transition-colors",
                  active
                    ? "bg-[#2a2724] text-stone-100 shadow-[0_1px_2px_rgba(0,0,0,0.45)]"
                    : "bg-[#26221e] text-stone-500 hover:bg-white/[0.08]",
                )}
                aria-pressed={active}
              >
                {pos}
                {isPresetDefault && (
                  <span className="ml-0.5 text-[8px] text-stone-500">·</span>
                )}
              </button>
            );
          })}
        </div>
        {captionSettings.customPosition && (
          <button
            type="button"
            onClick={() => set({ customPosition: null })}
            className="mt-1 flex items-center gap-1 text-[10px] text-stone-500 hover:text-stone-300"
          >
            <RotateCcw size={10} /> Preset position
          </button>
        )}
      </Field>

      {/* ── Size scale ── */}
      <Field
        label="Size"
        hint={`${(captionSettings.fontSizeScale * 100).toFixed(0)}% of preset size`}
      >
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.05}
          value={captionSettings.fontSizeScale}
          onChange={(e) => set({ fontSizeScale: Number(e.target.value) })}
          className="w-full accent-emerald-600"
          aria-label="Caption font size scale"
        />
      </Field>

      {/* ── Balanced wrap ── */}
      <Row label="Balanced wrapping">
        <Toggle
          checked={captionSettings.balancedWrap}
          onChange={(v) => set({ balancedWrap: v })}
          label=""
        />
      </Row>
      <p className="mb-3 mt-[-8px] text-[10px] leading-relaxed text-stone-500">
        Triangle shape — line 1 longer than line 2 (auto in the export via ASS
        smart wrap).
      </p>

      {/* ── Sidecar exports ── */}
      <Field label="Export caption files">
        <div className="grid grid-cols-2 gap-1">
          <button
            type="button"
            onClick={onExportSrt}
            disabled={!hasCues}
            className={cn(
              "flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[10px] font-semibold transition-colors",
              hasCues
                ? "bg-[#26221e] text-stone-400 hover:bg-white/[0.08]"
                : "cursor-not-allowed bg-[#26221e]/60 text-stone-400",
            )}
          >
            <FileText size={11} /> .srt
          </button>
          <button
            type="button"
            onClick={onExportVtt}
            disabled={!hasCues}
            title="WebVTT — for HTML5 <track> and web video players"
            className={cn(
              "flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[10px] font-semibold transition-colors",
              hasCues
                ? "bg-[#26221e] text-stone-400 hover:bg-white/[0.08]"
                : "cursor-not-allowed bg-[#26221e]/60 text-stone-400",
            )}
          >
            <FileText size={11} /> .vtt
          </button>
          <button
            type="button"
            onClick={onExportAss}
            disabled={!hasCues}
            title={
              inElectron
                ? "Styled ASS with your kinetic animations"
                : "Desktop app only"
            }
            className={cn(
              "flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[10px] font-semibold transition-colors",
              hasCues && inElectron
                ? "bg-[#26221e] text-stone-400 hover:bg-white/[0.08]"
                : "cursor-not-allowed bg-[#26221e]/60 text-stone-400",
            )}
          >
            <FileDown size={11} /> .ass
          </button>
          <button
            type="button"
            onClick={onExportVttWords}
            disabled={!hasWords}
            title={
              hasWords
                ? "Karaoke WebVTT — word-level timing for web players"
                : "Needs word timestamps — generate captions from audio first"
            }
            className={cn(
              "flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[10px] font-semibold transition-colors",
              hasWords
                ? "bg-[#26221e] text-stone-400 hover:bg-white/[0.08]"
                : "cursor-not-allowed bg-[#26221e]/60 text-stone-400",
            )}
          >
            <AudioLines size={11} /> words .vtt
          </button>
        </div>
      </Field>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// v1.18 — KINETIC TYPOGRAPHY (the professional semantic caption engine).
// Settings for the 24-preset composition system that lives inside
// CaptionSettings.kinetic, plus a live animated preview rendered through
// the REAL engine — buildKineticPlan on a sample cue set, then
// drawKineticComposition every rAF frame (the StackStylePreview pattern,
// scaled up to a 16:9 canvas). No page.tsx changes: kinetic rides the
// existing captionSettings persistence.
// ---------------------------------------------------------------------------

/** Display order for the preset <optgroup>s (family id → label). */
const KINETIC_FAMILY_ORDER = Object.keys(
  KINETIC_FAMILY_LABELS,
) as KineticFamily[];

/**
 * Font scale for the preview canvas: ~160px tall vs the 1080p reference the
 * preset baseSizeFrac values target. The layout solver's 10px floor keeps
 * the base type readable at this size while emphasisScale/supportScale
 * multipliers still show each preset's hierarchy.
 */
const KINETIC_PREVIEW_FONT_SCALE = 0.42;

/** Gap of dark silence between preview loops (ms). */
const KINETIC_PREVIEW_GAP_MS = 800;

/** Builds a preview cue with evenly-spread word timings. */
function kineticPreviewCue(
  startMs: number,
  endMs: number,
  text: string,
): KineticCueInput {
  const words = text.split(/\s+/).filter(Boolean);
  const span = (endMs - startMs) / Math.max(1, words.length);
  return {
    startMs,
    endMs,
    text,
    words: words.map((w, i) => ({
      text: w,
      startMs: Math.round(startMs + i * span),
      endMs: Math.round(startMs + (i + 1) * span),
    })),
  };
}

/**
 * Sample narration that exercises the whole engine: a long narration cue
 * (13 words, multi-phrase), a mid-length reveal, and a short dramatic sting
 * (auto drama-shortening + full-screen candidates).
 */
const KINETIC_PREVIEW_CUES: KineticCueInput[] = [
  kineticPreviewCue(
    0,
    3200,
    "I never trusted him but I never imagined he would lie to me",
  ),
  kineticPreviewCue(3400, 5400, "and then suddenly the truth came out"),
  kineticPreviewCue(5600, 6800, "seventeen years of secrets"),
];

// ---------------------------------------------------------------------------
// v1.20 — DESIGN LIBRARY: the visible 24-preset gallery. The designs existed
// since v1.18 but were only reachable through a plain <select> in Single
// mode — invisible in the default Auto state and before word-timed captions
// existed. The gallery renders one static mini-canvas per preset (grouped by
// family) through the REAL engine: buildKineticPlan on a fixed sample cue →
// drawKineticComposition once at 85% of the composition (every word entered,
// before the exit fade). No rAF loops — 24 static snapshots, redrawn only on
// mount / tile resize / webfont load.
// ---------------------------------------------------------------------------

/**
 * Sample cue for the tile snapshots: 6 words in 2 semantic phrases with
 * "truth" as the emphasis word (semantic score 7 — above the emphasis bar),
 * so every preset's accent color + hierarchy pattern shows in the thumbnail.
 * Words are spoken over 0-2600ms; the cue carries a 600ms hold tail so a
 * snapshot at 85% of the composition lands after every entrance and before
 * every exit.
 */
const KINETIC_GALLERY_CUES: KineticCueInput[] = (() => {
  const text = "but the truth was worth it";
  const words = text.split(/\s+/).filter(Boolean);
  const span = 2600 / words.length;
  return [
    {
      startMs: 0,
      endMs: 3200,
      text,
      words: words.map((w, i) => ({
        text: w,
        startMs: Math.round(i * span),
        endMs: Math.round((i + 1) * span),
      })),
    },
  ];
})();

/** Snapshot position inside the sample composition. */
const KINETIC_GALLERY_T_FRAC = 0.85;

/** Snapshot canvas height (px) — full tile width × ~72px. */
const KINETIC_TILE_CANVAS_H = 72;

/**
 * Mini-canvas font scale — the same floor-dominated regime the live preview
 * runs in (KINETIC_PREVIEW_FONT_SCALE), so thumbnails match what the engine
 * actually draws.
 */
const KINETIC_TILE_FONT_SCALE = 0.42;

interface KineticPresetTileProps {
  preset: KineticPresetSpec;
  plan: KineticPlan;
  selected: boolean;
  disabled: boolean;
  motionLevel: string;
  onSelect: (presetId: string) => void;
}

/** One design tile: static snapshot canvas + preset name. */
function KineticPresetTile(props: KineticPresetTileProps) {
  const { preset, plan, selected, disabled, motionLevel, onSelect } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Static snapshot: drawn once per (plan, motion) change and re-drawn on
  // tile resize (splitter drag / drawer open) and webfont load. Deliberately
  // NO animation loop — 24 tiles × rAF would burn the main thread.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const comp = plan.compositions[0];

    const render = () => {
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      if (cssW < 4 || cssH < 4) return; // not laid out yet (hidden tab/drawer)
      const bw = Math.max(1, Math.round(cssW * dpr));
      const bh = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#0a0a0c";
      ctx.fillRect(0, 0, cssW, cssH);
      if (!comp) return;
      // Thumbnails render each preset's OWN font + accent (the design's
      // identity); user overrides apply to the live preview, not the library.
      // Same measure contract as the live preview / drawKineticCaption.
      const stack = getFontOption(preset.fontId).stack;
      const currentMs =
        comp.startMs + (comp.endMs - comp.startMs) * KINETIC_GALLERY_T_FRAC;
      drawKineticComposition(
        ctx,
        comp,
        preset,
        {
          fontSizeScale: KINETIC_TILE_FONT_SCALE,
          customColor: null,
          fontOverride: null,
          accentOverride: null,
          motionLevel,
          currentMs,
        },
        cssW,
        cssH,
        (text, weight, fontPx) => {
          ctx.font = `${weight} ${fontPx}px ${stack}`;
          return ctx.measureText(text).width;
        },
      );
    };

    render();
    const ro = new ResizeObserver(render);
    ro.observe(canvas);
    // First paint may measure with fallback fonts — redraw once they settle.
    let alive = true;
    document.fonts.ready
      .then(() => {
        if (alive) render();
      })
      .catch(() => {
        /* fonts unavailable — the initial render stands */
      });
    return () => {
      alive = false;
      ro.disconnect();
    };
  }, [plan, preset, motionLevel]);

  return (
    <button
      type="button"
      onClick={() => onSelect(preset.id)}
      disabled={disabled}
      aria-pressed={selected}
      title={`${preset.name} — ${preset.description}`}
      className={cn(
        "rounded-lg border bg-[#26221e] p-1.5 text-left transition-colors",
        selected
          ? "border-cyan-400 shadow-[0_0_12px_rgba(34,211,238,0.3)]"
          : "border-[#2b2723] hover:border-[#332e28]",
        disabled && "cursor-not-allowed",
      )}
    >
      <canvas
        ref={canvasRef}
        className="block w-full rounded-md"
        style={{ height: KINETIC_TILE_CANVAS_H, backgroundColor: "#0a0a0c" }}
        aria-hidden="true"
      />
      <span className="mt-1 block truncate text-[11px] leading-tight text-stone-400">
        {preset.name}
      </span>
    </button>
  );
}

interface KineticPresetGalleryProps {
  /** Raw persisted settings — stable identity drives the memoized plans. */
  kineticRaw: KineticCaptionSettings | undefined;
  hasWords: boolean;
  onSelectPreset: (presetId: string) => void;
  onSelectAuto: () => void;
}

/**
 * The design library: "Auto mix" + the 24 preset tiles grouped by family.
 * Rendered whenever the kinetic engine is ON — dimmed + inert (but fully
 * visible) until word-timed captions exist, so the designs are discoverable
 * from the very first project open.
 */
function KineticPresetGallery(props: KineticPresetGalleryProps) {
  const { kineticRaw, hasWords, onSelectPreset, onSelectAuto } = props;
  const kinetic: KineticCaptionSettings = {
    ...KINETIC_DEFAULTS,
    ...kineticRaw,
  };

  // One plan per preset (single mode pins it; deterministic given the seed) —
  // rebuilt only when the persisted settings object identity changes.
  const galleryPlans = useMemo(
    () =>
      KINETIC_PRESETS.map((preset) => ({
        preset,
        plan: buildKineticPlan(KINETIC_GALLERY_CUES, {
          ...KINETIC_DEFAULTS,
          ...kineticRaw,
          enabled: true,
          mode: "single",
          presetId: preset.id,
        }),
      })),
    [kineticRaw],
  );

  const autoSelected = kinetic.mode === "auto";

  return (
    <Field
      label="Design library"
      hint={
        hasWords
          ? "24 designs across 5 families — click one to pin it (Single mode); Auto mix lets the engine pick per scene."
          : undefined
      }
    >
      <div
        className={cn(
          "@container max-h-[26rem] overflow-y-auto rounded-lg border p-1.5",
          !hasWords && "pointer-events-none opacity-50",
        )}
        style={{ borderColor: "#2b2723" }}
        role="group"
        aria-label="Kinetic typography design library"
      >
        {/* ── Auto mix — the engine picks per scene ── */}
        <button
          type="button"
          onClick={onSelectAuto}
          disabled={!hasWords}
          aria-pressed={autoSelected}
          title="The engine scores all 24 presets for every composition — semantic fit, intensity, style memory"
          className={cn(
            "flex w-full items-center gap-2.5 rounded-lg border bg-[#26221e] p-2 text-left transition-colors",
            autoSelected
              ? "border-orange-500 shadow-[0_0_12px_rgba(234,88,12,0.25)]"
              : "border-[#2b2723] hover:border-[#332e28]",
            !hasWords && "cursor-not-allowed",
          )}
        >
          <span
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-md border",
              autoSelected
                ? "border-orange-500/50 bg-[#2b1c10] text-orange-600"
                : "border-[#2b2723] text-stone-500",
            )}
          >
            <Shuffle size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] font-medium leading-tight text-stone-200">
              Auto mix
            </span>
            <span className="block truncate text-[10px] leading-tight text-stone-500">
              Engine picks per scene — all 24 presets scored
            </span>
          </span>
        </button>

        {/* ── The 24 presets, grouped by family ── */}
        {KINETIC_FAMILY_ORDER.map((fam) => (
          <div key={fam} className="mt-2.5">
            <div className="mb-1 px-0.5 text-[10px] font-semibold uppercase tracking-wider text-stone-500">
              {KINETIC_FAMILY_LABELS[fam] ?? fam}
            </div>
            <div className="grid grid-cols-2 gap-1.5 @min-[420px]:grid-cols-3 @min-[560px]:grid-cols-4">
              {galleryPlans
                .filter(({ preset }) => preset.family === fam)
                .map(({ preset, plan }) => (
                  <KineticPresetTile
                    key={preset.id}
                    preset={preset}
                    plan={plan}
                    selected={
                      kinetic.mode === "single" &&
                      kinetic.presetId === preset.id
                    }
                    disabled={!hasWords}
                    motionLevel={kinetic.motion}
                    onSelect={onSelectPreset}
                  />
                ))}
            </div>
          </div>
        ))}
      </div>
    </Field>
  );
}

interface KineticTypographySectionProps {
  captionSettings: CaptionSettings;
  onCaptionSettingsChange: (cs: CaptionSettings) => void;
  /** Word timestamps present — the engine (and this section) needs them. */
  hasWords: boolean;
}

function KineticTypographySection(props: KineticTypographySectionProps) {
  const { captionSettings, onCaptionSettingsChange, hasWords } = props;

  // Legacy default (§38): old projects have no kinetic block at all — read
  // through KINETIC_DEFAULTS; every write spreads defaults first.
  const kinetic: KineticCaptionSettings = {
    ...KINETIC_DEFAULTS,
    ...captionSettings.kinetic,
  };

  const setKinetic = (patch: Partial<KineticCaptionSettings>) =>
    onCaptionSettingsChange({
      ...captionSettings,
      kinetic: { ...KINETIC_DEFAULTS, ...captionSettings.kinetic, ...patch },
    });

  // The plan is always built (enabled forced true) so the preview animates
  // from the current settings; the canvas itself only mounts when enabled.
  const plan = useMemo(
    () =>
      buildKineticPlan(KINETIC_PREVIEW_CUES, {
        ...KINETIC_DEFAULTS,
        ...captionSettings.kinetic,
        enabled: true,
      }),
    [captionSettings.kinetic],
  );

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [previewInfo, setPreviewInfo] = useState<{
    name: string;
    family: string;
    classification: string;
    intensity: number;
  } | null>(null);
  const lastCompStartRef = useRef(-1);

  const fontOverride = kinetic.fontOverride ?? null;
  const accentOverride = kinetic.accentOverride ?? null;
  const motionLevel = kinetic.motion;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const compositions = plan.compositions;
    const planEndMs = compositions.length
      ? compositions[compositions.length - 1].endMs
      : 0;
    const loopMs = planEndMs + KINETIC_PREVIEW_GAP_MS;
    const startedAt = performance.now();
    let raf = 0;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      // Backing store = CSS size × DPR (crisp text). The painter is fully
      // proportional to cw/ch, so a dpr transform reproduces the exact
      // layout at any backing resolution.
      const dpr = window.devicePixelRatio || 1;
      const cssW = Math.max(1, canvas.clientWidth);
      const cssH = Math.max(1, canvas.clientHeight);
      const bw = Math.max(1, Math.round(cssW * dpr));
      const bh = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#0a0a0c";
      ctx.fillRect(0, 0, cssW, cssH);

      const t = (now - startedAt) % loopMs;
      const comp = plan.compositionAt(t);
      if (comp) {
        const preset = getKineticPreset(comp.presetId);
        // Same measure contract as drawKineticCaption: set ctx.font with the
        // preset/override stack BEFORE measuring.
        const stack = getFontOption(fontOverride || preset.fontId).stack;
        drawKineticComposition(
          ctx,
          comp,
          preset,
          {
            fontSizeScale: KINETIC_PREVIEW_FONT_SCALE,
            customColor: null,
            fontOverride,
            accentOverride,
            motionLevel,
            currentMs: t,
          },
          cssW,
          cssH,
          (text, weight, fontPx) => {
            ctx.font = `${weight} ${fontPx}px ${stack}`;
            return ctx.measureText(text).width;
          },
        );
        // Info line — throttled: setState only when the composition changes.
        if (comp.startMs !== lastCompStartRef.current) {
          lastCompStartRef.current = comp.startMs;
          setPreviewInfo({
            name: preset.name,
            family: KINETIC_FAMILY_LABELS[preset.family] ?? preset.family,
            classification: comp.classification.replace(/_/g, " ").toLowerCase(),
            intensity: comp.intensity,
          });
        }
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [plan, fontOverride, accentOverride, motionLevel]);

  const toggleMixPreset = (presetId: string) => {
    const has = kinetic.manualMix.some((m) => m.presetId === presetId);
    setKinetic({
      manualMix: has
        ? kinetic.manualMix.filter((m) => m.presetId !== presetId)
        : [...kinetic.manualMix, { presetId, weight: 20 }],
    });
  };

  const setMixWeight = (presetId: string, weight: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(weight)));
    setKinetic({
      manualMix: kinetic.manualMix.map((m) =>
        m.presetId === presetId ? { ...m, weight: clamped } : m,
      ),
    });
  };

  // v1.20: no early return when word timing is missing — the section (engine
  // toggle + design library) renders regardless so the 24 designs are always
  // discoverable; the gallery is dimmed + inert until hasWords flips true.

  return (
    <div
      className="mb-3 rounded-lg border p-2.5"
      style={{ borderColor: "#2b2723", backgroundColor: "#26221e" }}
    >
      {/* ── Engine switch ── */}
      <Toggle
        checked={kinetic.enabled}
        onChange={(v) =>
          setKinetic(
            v
              ? // Turning ON: sync the font override to the picked caption font.
                { enabled: true, fontOverride: captionSettings.fontId }
              : { enabled: false },
          )
        }
        label="Kinetic typography engine"
      />
      <p className="mt-1.5 text-[10px] leading-relaxed text-stone-500">
        Semantic compositions — phrase hierarchy, emphasis and motion follow
        the narration. Replaces the word-mode + animation pickers below.
      </p>

      {kinetic.enabled && (
        <div className="mt-2.5">
          {/* ── v1.20 Design library: the 24-preset gallery — ALWAYS visible
              while the engine is on (the designs were previously hidden
              behind the Single-mode <select>). It stays visible — dimmed and
              inert — until word timing exists, so users can SEE the designs
              before transcribing. ── */}
          <KineticPresetGallery
            kineticRaw={captionSettings.kinetic}
            hasWords={hasWords}
            onSelectPreset={(presetId) =>
              setKinetic({ mode: "single", presetId })
            }
            onSelectAuto={() => setKinetic({ mode: "auto" })}
          />
          {!hasWords && (
            <p className="-mt-2 mb-3 text-[10px] leading-relaxed text-orange-400/90">
              Generate captions with word timing (transcribe your audio) to
              unlock kinetic typography.
            </p>
          )}
          {hasWords && (
            <>
          {/* ── Typography mode ── */}
          <Field
            label="Typography mode"
            hint="How the engine picks the style for each composition."
          >
            <Segmented
              size="sm"
              options={[
                {
                  value: "auto",
                  label: "Auto Mix",
                  title:
                    "The engine scores all 24 presets per composition (semantic fit, intensity, variety)",
                },
                {
                  value: "single",
                  label: "Single",
                  title: "One pinned preset for every composition",
                },
                {
                  value: "manual",
                  label: "Manual Mix",
                  title: "Your weighted preset mix biases the scoring",
                },
                {
                  value: "all",
                  label: "All Styles",
                  title: "Full library, engine scoring decides",
                },
              ]}
              value={kinetic.mode}
              onChange={(v) => setKinetic({ mode: v })}
            />
          </Field>

          {/* ── Single mode: the pinned preset is chosen in the Design
              library gallery above (v1.20 — replaced the plain <select>). ── */}

          {/* ── Manual mode: weighted mix of every preset ── */}
          {kinetic.mode === "manual" && (
            <Field
              label="Style mix"
              hint="Check the presets the engine may use; weights bias the roulette."
            >
              <div
                className="max-h-64 overflow-y-auto rounded-md border"
                style={{ borderColor: "#2b2723" }}
              >
                {KINETIC_PRESETS.map((p) => {
                  const entry = kinetic.manualMix.find(
                    (m) => m.presetId === p.id,
                  );
                  return (
                    <div
                      key={p.id}
                      className="flex items-center gap-2 bg-[#26221e] px-2 py-1.5"
                    >
                      <input
                        type="checkbox"
                        checked={!!entry}
                        onChange={() => toggleMixPreset(p.id)}
                        className="size-3 shrink-0 accent-emerald-600"
                        aria-label={`Include ${p.name} in the style mix`}
                      />
                      <span
                        className="min-w-0 flex-1 truncate text-[11px] text-stone-200"
                        title={p.description}
                      >
                        {p.name}
                        <span className="ml-1.5 text-[9px] text-stone-500">
                          {KINETIC_FAMILY_LABELS[p.family]}
                        </span>
                      </span>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={entry?.weight ?? 0}
                        disabled={!entry}
                        onChange={(e) =>
                          setMixWeight(p.id, Number(e.target.value))
                        }
                        className="w-14 rounded border bg-[#211e1a] px-1.5 py-1 text-[10px] tabular-nums text-stone-300 disabled:opacity-40"
                        style={{ borderColor: "#332e28" }}
                        aria-label={`${p.name} weight`}
                        title="Preference weight 0-100"
                      />
                    </div>
                  );
                })}
              </div>
            </Field>
          )}

          {/* ── Variation ── */}
          <Field
            label="Variation"
            hint="How often the engine switches styles."
          >
            <Segmented
              size="sm"
              options={[
                {
                  value: "low",
                  label: "Low",
                  title: "One style settles in — rare switches",
                },
                {
                  value: "medium",
                  label: "Medium",
                  title: "Occasional switches",
                },
                {
                  value: "high",
                  label: "High",
                  title: "Frequent style variety (default)",
                },
                {
                  value: "extreme",
                  label: "Extreme",
                  title: "New style almost every composition",
                },
              ]}
              value={kinetic.variation}
              onChange={(v) => setKinetic({ variation: v })}
            />
          </Field>

          {/* ── Intensity ── */}
          <Field
            label="Intensity"
            hint="Narrative drama level the compositions aim for."
          >
            <Segmented
              size="sm"
              options={[
                {
                  value: "auto",
                  label: "Auto",
                  title: "Follow the semantic intensity scoring",
                },
                {
                  value: "low",
                  label: "Low",
                  title: "Clamp to calm compositions",
                },
                {
                  value: "medium",
                  label: "Medium",
                  title: "Clamp to mid drama",
                },
                {
                  value: "high",
                  label: "High",
                  title: "Boost everything to high drama",
                },
              ]}
              value={kinetic.intensity}
              onChange={(v) => setKinetic({ intensity: v })}
            />
          </Field>

          {/* ── Word density ── */}
          <Field
            label="Word density"
            hint="Words per composition (phrase grouping target)."
          >
            <Segmented
              size="sm"
              options={[
                {
                  value: "auto",
                  label: "Auto",
                  title: "5-12 words normally; drama auto-shortens",
                },
                {
                  value: "short",
                  label: "Short",
                  title: "3-6 word compositions",
                },
                {
                  value: "medium",
                  label: "Medium",
                  title: "5-9 word compositions",
                },
                {
                  value: "long",
                  label: "Long",
                  title: "8-14 word compositions",
                },
              ]}
              value={kinetic.density}
              onChange={(v) => setKinetic({ density: v })}
            />
          </Field>

          {/* ── Motion ── */}
          <Field label="Motion" hint="Motion energy of entrances + emphasis.">
            <Segmented
              size="sm"
              options={[
                {
                  value: "subtle",
                  label: "Subtle",
                  title: "0.6× motion energy",
                },
                {
                  value: "balanced",
                  label: "Balanced",
                  title: "1× motion energy",
                },
                {
                  value: "dynamic",
                  label: "Dynamic",
                  title: "1.3× motion energy (default)",
                },
                {
                  value: "extreme",
                  label: "Extreme",
                  title: "1.6× motion energy",
                },
              ]}
              value={kinetic.motion}
              onChange={(v) => setKinetic({ motion: v })}
            />
          </Field>

          {/* ── Seed ── */}
          <Field
            label="Seed"
            hint="Deterministic — the same seed always produces the same style sequence."
          >
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                max={999999}
                value={kinetic.seed}
                onChange={(e) =>
                  setKinetic({
                    seed: Math.max(
                      1,
                      Math.min(999999, Math.round(Number(e.target.value) || 1)),
                    ),
                  })
                }
                className="w-24 rounded border bg-[#211e1a] px-1.5 py-1 text-[10px] tabular-nums text-stone-300"
                style={{ borderColor: "#332e28" }}
                aria-label="Kinetic engine seed"
              />
              <button
                type="button"
                onClick={() =>
                  setKinetic({
                    seed: 1 + Math.floor(Math.random() * 999999),
                  })
                }
                className="flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-medium text-stone-400 transition-colors hover:bg-white/[0.06]"
                style={{ borderColor: "#332e28" }}
                aria-label="Randomize seed"
                title="Randomize seed"
              >
                <Dices size={10} /> Random
              </button>
            </div>
          </Field>

          {/* ── Live preview (through the real engine) ── */}
          <Field
            label="Live preview"
            hint="Kinetic compositions render via the ASS compositor at export."
          >
            <div
              className="overflow-hidden rounded-lg border"
              style={{ borderColor: "#2b2723" }}
            >
              <canvas
                ref={canvasRef}
                className="block w-full"
                style={{
                  aspectRatio: "16 / 9",
                  maxHeight: 170,
                  backgroundColor: "#0a0a0c",
                }}
                aria-label="Kinetic typography live preview"
              />
            </div>
            <p className="mt-1 truncate text-[10px] text-stone-500">
              {previewInfo ? (
                <>
                  <span className="text-stone-400">{previewInfo.name}</span> ·{" "}
                  {previewInfo.family} · {previewInfo.classification} ·
                  intensity {previewInfo.intensity}
                </>
              ) : (
                "Cycling engine output…"
              )}
            </p>
          </Field>
          </>
        )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// v1.17 — VOICEOVER (Edge TTS narration, created in-editor).
// The MAIN process talks to Microsoft's Edge neural voices (free); the
// renderer only picks a language/voice (previewable BEFORE committing),
// writes the narration text, and adds the synthesized clip at the playhead.
// ---------------------------------------------------------------------------

/** Locale-appropriate one-liners for voice previews (non-Latin scripts need
 *  native text — an English sample read by a Hindi voice sounds wrong). */
const VOICE_PREVIEW_SAMPLES: Record<string, string> = {
  hi: "नमस्ते, यह आवाज़ का एक नमूना है।",
  ur: "ہیلو، یہ آواز کا ایک نمونہ ہے۔",
  bn: "হ্যালো, এটি একটি ভয়েস নমুনা।",
  ta: "வணக்கம், இது ஒரு குரல் மாதிரி.",
  te: "హలో, ఇది వాయిస్ నమూనా.",
  mr: "नमस्कार, हा आवाजाचा एक नमुना आहे.",
  gu: "નમસ્તે, આ અવાજનો એક નમૂનો છે.",
  kn: "ಹಲೋ, ಇದು ಧ್ವನಿ ಮಾದರಿ.",
  ml: "ഹലോ, ഇതൊരു ശബ്ദ സാമ്പിൾ ആണ്.",
  pa: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ, ਇਹ ਆਵਾਜ਼ ਦਾ ਨਮੂਨਾ ਹੈ।",
  ar: "مرحبًا، هذا عيّنة صوت.",
  fa: "سلام، این یک نمونه صدا است.",
  zh: "你好，这是一段语音示例。",
  ja: "こんにちは、これは音声サンプルです。",
  ko: "안녕하세요, 이것은 음성 샘플입니다.",
  th: "สวัสดี นี่คือตัวอย่างเสียง",
  vi: "Xin chào, đây là một mẫu giọng nói.",
  ru: "Привет, это образец голоса.",
  uk: "Привіт, це зразок голосу.",
  tr: "Merhaba, bu bir ses örneğidir.",
};

function voicePreviewSample(locale: string, userText: string): string {
  const first = userText.trim().slice(0, 90);
  if (first) return first;
  const lang = (locale || "").split("-")[0].toLowerCase();
  return VOICE_PREVIEW_SAMPLES[lang] ?? "This is a voice preview.";
}

// v1.25: useTtsVoices (this file's shared voice-catalog hook) moved to
// ./use-tts-voices.ts — the TTS Studio imports it too.
function VoiceoverSection({
  onAddVoiceover,
  voCount,
}: {
  onAddVoiceover: (r: {
    text: string;
    voice: string;
    ratePct?: number;
    pitchHz?: number;
    volume?: number;
    durationMs: number;
    bytes: ArrayBuffer | Blob;
  }) => void;
  voCount: number;
}) {
  const { voices, pairs } = useTtsVoices();
  const [text, setText] = useState("");
  // v1.25: QWERTY romanized → native script (hi/ur), shared with the Studio.
  const [qwerty, setQwerty] = useState(true);
  const [locale, setLocale] = useState("en-US");
  const [voice, setVoice] = useState("en-US-AriaNeural");
  const [voiceSearch, setVoiceSearch] = useState("");
  const [voiceGender, setVoiceGender] = useState<VoiceGenderFilter>("all");
  const [ratePct, setRatePct] = useState(0);
  const [pitchHz, setPitchHz] = useState(0);
  const [volume, setVolume] = useState(1);
  const [busy, setBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  const locales = useMemo(() => {
    const set = new Set<string>();
    for (const v of voices ?? []) set.add(v.locale);
    return Array.from(set).sort();
  }, [voices]);
  const localeVoices = useMemo(
    () =>
      filterTtsVoices(voices ?? [], {
        search: voiceSearch,
        locale,
        gender: voiceGender,
      }),
    [voices, voiceSearch, locale, voiceGender],
  );

  // QWERTY resolution (hi/ur): romanized → native, native passes through.
  const showQwerty = localeWantsTranslit(locale) !== null;
  const qw = useMemo(
    () => resolveQwertyText(text, locale, qwerty),
    [text, locale, qwerty],
  );

  // Locale switch → default to that locale's female pair voice.
  const changeLocale = useCallback(
    (next: string) => {
      setLocale(next);
      setVoiceSearch("");
      const pair = pairs[next];
      if (pair?.female) setVoice(pair.female);
      else {
        const first = (voices ?? []).find((v) => v.locale === next);
        if (first) setVoice(first.shortName);
      }
    },
    [pairs, voices],
  );

  // Gender filter switch → keep the current voice when it still matches,
  // else the first voice of the new filter (shared Studio behavior).
  const changeVoiceGender = useCallback(
    (g: VoiceGenderFilter) => {
      setVoiceGender(g);
      const list = filterTtsVoices(voices ?? [], {
        search: voiceSearch,
        locale,
        gender: g,
      });
      if (list.length > 0 && !list.some((v) => v.shortName === voice)) {
        setVoice(list[0].shortName);
      }
    },
    [voices, voiceSearch, locale, voice],
  );

  const stopPreview = useCallback(() => {
    const a = previewAudioRef.current;
    if (a) {
      a.pause();
      previewAudioRef.current = null;
    }
  }, []);

  useEffect(() => stopPreview, [stopPreview]);

  const playPreview = useCallback(async () => {
    if (!voice) return;
    stopPreview();
    setPreviewBusy(true);
    try {
      // v1.26 transport — previews work in the web preview too.
      const r = await ttsPreviewVoice({
        voice,
        // v1.25: previews read the CONVERTED text (native script for hi/ur).
        text: voicePreviewSample(locale, qw.converted),
      });
      const blob = new Blob([r.bytes], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      previewAudioRef.current = audio;
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch (err) {
      toast.error("Voice preview failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPreviewBusy(false);
    }
  }, [voice, locale, qw, stopPreview]);

  const addVoiceover = useCallback(async () => {
    // v1.25: synthesize (and store) the CONVERTED text — hi/ur QWERTY input
    // reaches Edge TTS as native script, and export regeneration matches.
    const trimmed = qw.converted.trim();
    if (!trimmed) {
      toast.error("Write the narration text first");
      return;
    }
    if (!voice) {
      toast.error("Select a voice first");
      return;
    }
    setBusy(true);
    try {
      // v1.26 transport — IPC in the desktop app, /api/tts/synthesize in
      // the web preview (the volume slider maps to the engine convention).
      const r = await ttsSynthesizeShort({
        text: trimmed,
        voice,
        ratePct,
        pitchHz,
        volumePct: Math.round(volume * 100),
      });
      onAddVoiceover({
        text: trimmed,
        voice,
        ratePct,
        pitchHz,
        volume,
        durationMs: r.durationMs,
        bytes: r.bytes,
      });
      setText("");
    } catch (err) {
      toast.error("Voiceover synthesis failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }, [qw, voice, ratePct, pitchHz, volume, onAddVoiceover]);

  const selectCls =
    "w-full rounded border bg-[#211e1a] px-2 py-1.5 text-[11px] text-stone-300 focus:border-orange-500";

  return (
    <Section icon={<Mic size={13} />} title="Voiceover (TTS)" defaultOpen={false}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="Narration text — one clip is placed at the playhead."
        className="mb-2 w-full resize-y rounded border bg-[#211e1a] px-2 py-1.5 text-[11px] text-stone-300 placeholder:text-stone-500 focus:border-orange-500 focus:outline-none"
        style={{ borderColor: "#332e28" }}
        aria-label="Narration text"
      />
      {showQwerty && (
        <div className="mb-2">
          <StudioToggle
            checked={qwerty}
            onChange={setQwerty}
            label="QWERTY input — auto-converts to native script"
          />
          {qwerty && qw.nativeDetected && (
            <p className="mt-1 text-[10px] leading-relaxed text-amber-400/90">
              Native script detected — converting is skipped
            </p>
          )}
          {qwerty && qw.willConvert && (
            <p
              className="mt-1 truncate rounded px-1.5 py-1 text-[10px] text-stone-300"
              style={{ backgroundColor: "#10201d" }}
              title={qw.converted}
            >
              {qw.converted.slice(0, 120)}
              {qw.converted.length > 120 ? " …" : ""}
            </p>
          )}
        </div>
      )}
      <div className="mb-1.5 flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Search
            size={11}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-stone-500"
          />
          <input
            value={voiceSearch}
            onChange={(e) => setVoiceSearch(e.target.value)}
            placeholder="Search voices…"
            className="w-full rounded border bg-[#211e1a] py-1.5 pl-7 pr-2 text-[11px] text-stone-300 placeholder:text-stone-500 focus:border-orange-500 focus:outline-none"
            style={{ borderColor: "#332e28" }}
            aria-label="Search voices"
          />
        </div>
        <VoiceGenderChips value={voiceGender} onChange={changeVoiceGender} />
      </div>
      <div className="mb-2 grid grid-cols-2 gap-1.5">
        <div>
          <label className="mb-0.5 block text-[10px] font-medium text-stone-500">
            Language
          </label>
          <select
            value={locale}
            onChange={(e) => changeLocale(e.target.value)}
            className={selectCls}
            style={{ borderColor: "#332e28" }}
            aria-label="Voiceover language"
          >
            {locales.length === 0 && <option value={locale}>{locale}</option>}
            {locales.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-0.5 block text-[10px] font-medium text-stone-500">
            Voice
          </label>
          <div className="flex items-center gap-1">
            <select
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              className={cn(selectCls, "flex-1")}
              style={{ borderColor: "#332e28" }}
              aria-label="Voiceover voice"
            >
              {localeVoices.length === 0 && <option value={voice}>{voice}</option>}
              {localeVoices.map((v) => (
                <option key={v.shortName} value={v.shortName}>
                  {v.displayName} ({v.shortName})
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void playPreview()}
              disabled={previewBusy || !voice}
              title="Listen to this voice before using it"
              className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded border text-orange-600 transition-colors hover:bg-orange-500/10 disabled:cursor-not-allowed disabled:opacity-40"
              style={{ borderColor: "#332e28" }}
              aria-label="Preview voice"
            >
              {previewBusy ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <Play size={11} />
              )}
            </button>
          </div>
        </div>
      </div>
      <div className="mb-2 grid grid-cols-3 gap-1.5">
        <Field label="Rate" hint={`${ratePct > 0 ? "+" : ""}${ratePct}%`}>
          <input
            type="range"
            min={-50}
            max={50}
            step={5}
            value={ratePct}
            onChange={(e) => setRatePct(Number(e.target.value))}
            className="w-full accent-orange-600"
            aria-label="Speech rate"
          />
        </Field>
        <Field label="Pitch" hint={`${pitchHz > 0 ? "+" : ""}${pitchHz}Hz`}>
          <input
            type="range"
            min={-20}
            max={20}
            step={2}
            value={pitchHz}
            onChange={(e) => setPitchHz(Number(e.target.value))}
            className="w-full accent-orange-600"
            aria-label="Pitch"
          />
        </Field>
        <Field label="Volume" hint={`${Math.round(volume * 100)}%`}>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(volume * 100)}
            onChange={(e) => setVolume(Number(e.target.value) / 100)}
            className="w-full accent-orange-600"
            aria-label="Voiceover volume"
          />
        </Field>
      </div>
      <button
        type="button"
        onClick={() => void addVoiceover()}
        disabled={busy || !text.trim()}
        className="flex w-full items-center justify-center gap-1.5 rounded bg-orange-500 px-2.5 py-1.5 text-[11px] font-semibold text-white transition-colors hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? (
          <>
            <Loader2 size={11} className="animate-spin" /> Synthesizing…
          </>
        ) : (
          <>
            <Mic size={11} /> Add at playhead
          </>
        )}
      </button>
      <p className="mb-1 mt-1 text-[10px] leading-relaxed text-stone-500">
        {voCount > 0
          ? `${voCount} clip${voCount === 1 ? "" : "s"} on the VO lane — drag to move, Alt+click to remove.`
          : "Voiceovers regenerate automatically at export after a project is reopened."}
      </p>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// v1.17 — TRANSLATE & DUB (Groq Whisper → free LLM → Edge TTS).
// Source = the timeline's local video clips. Free-tier discipline: audio is
// extracted + compressed for Groq's 25MB cap (auto-chunked when long), the
// script is generated by llama-3.3-70b-versatile by default, speakers are
// detected best-effort and auto-assigned male/female voices.
// ---------------------------------------------------------------------------

interface DubSectionProps {
  dubSettings: DubSettings;
  onDubSettingsChange: (s: DubSettings) => void;
  dubSourceCount: number;
  /** Any dub-family op is in flight (transcribe | script | dub). */
  dubBusy: boolean;
  /** Which stage is running — drives each stage's spinner + progress bar. */
  dubOp: "transcribe" | "script" | "dub" | null;
  dubProgress: { phase: string; progress: number; status: string } | null;
  dubResult: DubTrackResult | null;
  /** Stage-1 output (page-owned; survives accordion collapses). */
  dubTranscript: (DubTranscriptResult & { sourceCount?: number }) | null;
  /** Stage-2 output (page-owned; lines are edited in place). */
  dubScript: DubScriptResult | null;
  /** Per-speaker voice picks for speaker ids ≥ 2 (0/1 live in dubSettings). */
  dubSpeakerVoices: Record<number, string>;
  onStartDub: () => void;
  onCancelDub: () => void;
  onApplyDubTrack: () => void;
  onDiscardDub: () => void;
  onStartDubTranscribe: () => void;
  onDiscardTranscript: () => void;
  onStartDubScript: () => void;
  onDiscardScript: () => void;
  onStartDubFromScript: () => void;
  onDubScriptChange: (lines: DubScriptLine[]) => void;
  onDubSpeakerVoicesChange: (voices: Record<number, string>) => void;
}

const DUB_LOCALE_PREFERENCE = ["-IN", "-US", "-GB", "-CA", "-AU"];

/** Best locale for a language code, given the pairs the TTS engine offers
 *  (prefers IN first — the user's market — then the classic majors). */
function dubLocaleFor(lang: string, pairs: Record<string, { female: string; male: string }>): string {
  for (const suffix of DUB_LOCALE_PREFERENCE) {
    const cand = `${lang}${suffix}`;
    if (pairs[cand]) return cand;
  }
  const hit = Object.keys(pairs).find((k) => k.toLowerCase().startsWith(`${lang.toLowerCase()}-`));
  return hit ?? `${lang}-IN`;
}

/** mm:ss.s timecode for transcript/script line headers. */
function dubTimecode(ms: number): string {
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${String(m).padStart(2, "0")}:${rest < 10 ? "0" : ""}${rest.toFixed(1)}`;
}

/** SRT timestamp (00:00:01,200) for the transcript sidecar export. */
function dubSrtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const f = total % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(f, 3)}`;
}

/** Anchor-download a text sidecar (same flow as the page's sidecar exports). */
function dubDownloadText(fileName: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type DubStage = "transcript" | "script" | "dub";

const DUB_STAGES: Array<{ id: DubStage; label: string; icon: typeof ScanText }> = [
  { id: "transcript", label: "Transcript", icon: ScanText },
  { id: "script", label: "Script", icon: FileText },
  { id: "dub", label: "Voices & dub", icon: AudioLines },
];

/** The shared busy row (status + cancel + bar) for every stage. */
function DubProgressRow({
  status,
  progress,
  onCancel,
}: {
  status: string;
  progress: number;
  onCancel: () => void;
}) {
  return (
    <div className="mb-2" role="status">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1 text-[10px] text-stone-400">
          <Loader2 size={10} className="shrink-0 animate-spin" />
          <span className="truncate">{status}</span>
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] text-stone-400 transition-colors hover:bg-white/[0.06]"
          style={{ borderColor: "#332e28" }}
        >
          <Square size={9} /> Cancel
        </button>
      </div>
      <div
        className="h-1 w-full overflow-hidden rounded-full"
        style={{ backgroundColor: "#332e28" }}
        role="progressbar"
        aria-valuenow={Math.round(progress)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-orange-400 to-orange-600 transition-all"
          style={{ width: `${Math.max(3, Math.min(100, progress))}%` }}
        />
      </div>
    </div>
  );
}

/** Speaker chip — teal for S1, amber for S2, violet for S3+. */
function SpeakerChip({ id }: { id: number }) {
  const styles =
    id === 0
      ? { backgroundColor: "rgba(13, 148, 136, 0.35)", color: "#2dd4bf" }
      : id === 1
        ? { backgroundColor: "#2b1c10", color: "#fdba74" }
        : { backgroundColor: "rgba(124, 58, 237, 0.25)", color: "#c4b5fd" };
  return (
    <span
      className="mr-1 shrink-0 rounded px-1 py-px font-mono text-[9px] font-semibold"
      style={styles}
    >
      S{id + 1}
    </span>
  );
}

function DubSection(props: DubSectionProps) {
  const {
    dubSettings,
    onDubSettingsChange,
    dubSourceCount,
    dubBusy,
    dubOp,
    dubProgress,
    dubResult,
    dubTranscript,
    dubScript,
    dubSpeakerVoices,
    onStartDub,
    onCancelDub,
    onApplyDubTrack,
    onDiscardDub,
    onStartDubTranscribe,
    onDiscardTranscript,
    onStartDubScript,
    onDiscardScript,
    onStartDubFromScript,
    onDubScriptChange,
    onDubSpeakerVoicesChange,
  } = props;

  const { voices, pairs } = useTtsVoices();
  const [models, setModels] = useState<Array<{ id: string; label: string; hint: string }>>([]);
  const [langNames, setLangNames] = useState<Record<string, string>>({});
  const [groqHasKey, setGroqHasKey] = useState<boolean | null>(null);
  // v1.22: the Gemini dub-provider picker data (models + key presence).
  const [geminiModels, setGeminiModels] = useState<
    Array<{ id: string; label: string; hint: string }>
  >([]);
  const [geminiHasKey, setGeminiHasKey] = useState<boolean | null>(null);
  /** v1.26: the web speech provider is active (no electronAPI bridge) —
 *  the API routes run the transcription/translation, no keys needed. */
  const [webProvider, setWebProvider] = useState(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  // Stage navigation + the word-timing toggle (ephemeral UI state — fine to
  // reset on accordion collapse; the DATA lives in page.tsx).
  const [stage, setStage] = useState<DubStage>(dubScript ? "dub" : dubTranscript ? "script" : "transcript");
  const [showWords, setShowWords] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // v1.26 transport: dubModels resolves IPC-first and falls back to
    // /api/dub/models — the language dropdown (langNames) populates in the
    // web preview too. provider === "web" marks the keyless cloud engine.
    fetchDubModels()
      .then((r) => {
        if (!r) return;
        setModels(r.models ?? []);
        setLangNames(r.langNames ?? {});
        setGeminiModels(r.gemini?.models ?? []);
        setGeminiHasKey(r.gemini ? !!r.gemini.hasKey : null);
        setWebProvider(r.provider === "web");
        if (r.provider === "web") setGroqHasKey(true);
      })
      .catch(() => {});
    const api = window.electronAPI;
    if (typeof api?.whisperGroqGet === "function") {
      api
        .whisperGroqGet()
        .then((cfg) => setGroqHasKey(!!cfg?.hasKey))
        .catch(() => setGroqHasKey(false));
    }
  }, []);

  // Keep the effective locale + default voices in sync with the language.
  // v1.20: once the voice catalog has loaded, a single-voice pick the
  // (new) locale doesn't offer resets to auto — the locale pair's default
  // female takes over on the main side.
  useEffect(() => {
    const locale = dubLocaleFor(dubSettings.targetLanguage, pairs);
    const pair = pairs[locale];
    const catalog = voices ?? [];
    const localeNames = new Set(
      catalog.filter((v) => v.locale === locale).map((v) => v.shortName),
    );
    const singleStale =
      !!dubSettings.singleVoice &&
      catalog.length > 0 &&
      !localeNames.has(dubSettings.singleVoice);
    if (
      locale !== dubSettings.targetLocale ||
      (pair?.female && dubSettings.femaleVoice !== pair.female) ||
      (pair?.male && dubSettings.maleVoice !== pair.male) ||
      singleStale
    ) {
      onDubSettingsChange({
        ...dubSettings,
        targetLocale: locale,
        femaleVoice: pair?.female ?? dubSettings.femaleVoice,
        maleVoice: pair?.male ?? dubSettings.maleVoice,
        singleVoice: singleStale ? null : (dubSettings.singleVoice ?? null),
      });
    }
  }, [dubSettings.targetLanguage, pairs, voices]);

  const localeVoices = useMemo(
    () => (voices ?? []).filter((v) => v.locale === dubSettings.targetLocale),
    [voices, dubSettings.targetLocale],
  );

  // v1.20 voice mode: "single" = ONE voice reads the whole dub (the main
  // process skips speaker detection entirely); "multi" = the classic
  // per-speaker female/male pair. Old persisted prefs read as "multi".
  const singleMode = (dubSettings.voiceMode ?? "multi") === "single";

  /** The voice the single-mode select shows as selected: the explicit pick
   *  when the locale offers it, else the locale's default. */
  const singleVoiceValue = useMemo(() => {
    const sv = dubSettings.singleVoice;
    if (sv && localeVoices.some((v) => v.shortName === sv)) return sv;
    if (
      dubSettings.femaleVoice &&
      localeVoices.some((v) => v.shortName === dubSettings.femaleVoice)
    ) {
      return dubSettings.femaleVoice;
    }
    const pair = pairs[dubSettings.targetLocale];
    if (pair?.female && localeVoices.some((v) => v.shortName === pair.female)) {
      return pair.female;
    }
    return localeVoices[0]?.shortName ?? "";
  }, [
    dubSettings.singleVoice,
    dubSettings.femaleVoice,
    dubSettings.targetLocale,
    localeVoices,
    pairs,
  ]);

  const setVoiceMode = useCallback(
    (mode: "single" | "multi") => {
      if (mode === (dubSettings.voiceMode ?? "multi")) return;
      onDubSettingsChange({
        ...dubSettings,
        voiceMode: mode,
        // Leaving single mode drops the pick so multi stays byte-identical
        // to ≤ v1.19 on the dubbing pipeline.
        singleVoice: mode === "single" ? (dubSettings.singleVoice ?? null) : null,
      });
    },
    [dubSettings, onDubSettingsChange],
  );

  /** Language switch — the script is language-bound, so it is invalidated. */
  const changeLanguage = useCallback(
    (lang: string) => {
      if (lang === dubSettings.targetLanguage) return;
      const locale = dubLocaleFor(lang, pairs);
      const pair = pairs[locale];
      onDubSettingsChange({
        ...dubSettings,
        targetLanguage: lang,
        targetLocale: locale,
        femaleVoice: pair?.female ?? "",
        maleVoice: pair?.male ?? "",
        // Language switch: the single-voice pick belongs to the old locale.
        singleVoice: null,
      });
      if (dubScript) onDiscardScript();
    },
    [dubSettings, pairs, onDubSettingsChange, dubScript, onDiscardScript],
  );

  const playPreview = useCallback(
    async (voice: string) => {
      if (!voice) return;
      const a = previewAudioRef.current;
      if (a) a.pause();
      try {
        // v1.26 transport — previews also work in the web preview.
        const r = await ttsPreviewVoice({
          voice,
          text: voicePreviewSample(dubSettings.targetLocale, ""),
        });
        const blob = new Blob([r.bytes], { type: "audio/mpeg" });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        previewAudioRef.current = audio;
        audio.onended = () => URL.revokeObjectURL(url);
        await audio.play();
      } catch {
        /* preview is best-effort */
      }
    },
    [dubSettings.targetLocale],
  );

  useEffect(() => {
    const a = previewAudioRef.current;
    return () => {
      if (a) a.pause();
    };
  }, []);

  const languages = useMemo(
    () =>
      Object.entries(langNames)
        .map(([code, name]) => ({ code, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [langNames],
  );

  const selectCls =
    "w-full rounded border bg-[#211e1a] px-2 py-1.5 text-[11px] text-stone-300 focus:border-orange-500";

  const transcribeBusy = dubBusy && dubOp === "transcribe";
  const scriptBusy = dubBusy && dubOp === "script";
  const dubRunBusy = dubBusy && dubOp === "dub";

  const transcriptStale =
    !!dubTranscript &&
    dubTranscript.sourceCount != null &&
    dubTranscript.sourceCount !== dubSourceCount;

  const scriptLines = dubScript?.lines ?? [];
  const scriptSpeakerCount = dubScript?.speakerCount ?? 2;
  const multiSpeakerCount = Math.max(2, Math.min(8, scriptSpeakerCount));

  /** Copy the transcript as timecoded lines. */
  const copyTranscript = useCallback(async () => {
    if (!dubTranscript) return;
    const text = dubTranscript.utterances
      .map((u) => `${dubTimecode(u.startMs)} → ${dubTimecode(u.endMs)}  ${u.text}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Copy failed", { description: "Clipboard access was blocked by the browser." });
    }
  }, [dubTranscript]);

  /** Speaker label + voice picker row for one multi-mode speaker id. */
  const speakerVoiceRow = (id: number) => {
    const value =
      id === 0 ? dubSettings.femaleVoice : id === 1 ? dubSettings.maleVoice : (dubSpeakerVoices[id] ?? "");
    const label =
      id === 0 ? "Speaker 1 · female" : id === 1 ? "Speaker 2 · male" : `Speaker ${id + 1}`;
    const options =
      id <= 1
        ? localeVoices.filter(
            (v) =>
              (id === 0 ? v.gender === "Female" : v.gender === "Male") ||
              localeVoices.length <= 2,
          )
        : localeVoices;
    const onChange = (v: string) => {
      if (id === 0) onDubSettingsChange({ ...dubSettings, femaleVoice: v });
      else if (id === 1) onDubSettingsChange({ ...dubSettings, maleVoice: v });
      else onDubSpeakerVoicesChange({ ...dubSpeakerVoices, [id]: v });
    };
    return (
      <div key={id}>
        <label className="mb-0.5 block text-[10px] font-medium text-stone-500">
          {label}
        </label>
        <div className="flex items-center gap-1">
          <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className={cn(selectCls, "flex-1")}
            style={{ borderColor: "#332e28" }}
            aria-label={label}
          >
            {options.length === 0 && <option value={value}>{value || "auto"}</option>}
            {options.map((v) => (
              <option key={v.shortName} value={v.shortName}>
                {v.displayName}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void playPreview(value)}
            disabled={!value}
            title="Listen to this voice"
            className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded border text-orange-600 transition-colors hover:bg-orange-500/10 disabled:cursor-not-allowed disabled:opacity-40"
            style={{ borderColor: "#332e28" }}
            aria-label={`Preview ${label}`}
          >
            <Play size={11} />
          </button>
        </div>
      </div>
    );
  };

  const stageChipState = (id: DubStage) => {
    if (id === "transcript") return dubTranscript ? "done" : stage === id ? "active" : "todo";
    if (id === "script") return dubScript ? "done" : stage === id ? "active" : "todo";
    return dubResult ? "done" : stage === id ? "active" : "todo";
  };

  return (
    <Section icon={<Languages size={13} />} title="Dub Studio — transcribe · script · dub" defaultOpen>
      {/* ── Stepper: three reviewable stages over one pipeline ── */}
      <div className="mb-2 flex items-center gap-1" role="group" aria-label="Dub Studio stages">
        {DUB_STAGES.map((s, idx) => {
          const state = stageChipState(s.id);
          const Icon = s.icon;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setStage(s.id)}
              aria-current={stage === s.id ? "step" : undefined}
              className={cn(
                "flex flex-1 items-center justify-center gap-1 rounded border px-1.5 py-1.5 text-[10px] font-medium transition-colors",
                state === "active"
                  ? "border-orange-500/50 bg-orange-500/15 text-orange-300"
                  : state === "done"
                    ? "border-teal-500/40 bg-teal-500/10 text-teal-300"
                    : "border-[#2b2723] bg-[#26221e] text-stone-500 hover:bg-white/[0.04] hover:text-stone-300",
              )}
              title={
                s.id === "transcript"
                  ? "Stage 1 — word-level transcript (Groq Whisper)"
                  : s.id === "script"
                    ? "Stage 2 — create the dubbing script in the selected language"
                    : "Stage 3 — one voice or per-speaker voices, then synthesize"
              }
            >
              {state === "done" ? <Check size={11} /> : <Icon size={11} />}
              <span className="hidden sm:inline">{s.label}</span>
              {idx === 0 && <sup className="ml-px text-[8px] opacity-70">1</sup>}
              {idx === 1 && <sup className="ml-px text-[8px] opacity-70">2</sup>}
              {idx === 2 && <sup className="ml-px text-[8px] opacity-70">3</sup>}
            </button>
          );
        })}
      </div>

      {/* ═══════════════════════════════════════════════════════════════════
          STAGE 1 — WORD-LEVEL TRANSCRIPT
          ═══════════════════════════════════════════════════════════════ */}
      {stage === "transcript" && (
        <div className="mb-2 rounded border p-2" style={{ borderColor: "#332e28", backgroundColor: "#26221e" }}>
          <p className="mb-1.5 text-[10px] leading-relaxed text-stone-400">
            <span className="font-semibold text-stone-300">1 · Audio → transcript (word level).</span>{" "}
            {webProvider
              ? "Extracts the timeline's audio and transcribes it with the built-in cloud ASR — every line keeps its per-word timings."
              : "Extracts the timeline's audio and transcribes it with Groq Whisper — every line keeps its per-word timings."}
          </p>

          {transcribeBusy ? (
            <DubProgressRow
              status={dubProgress?.status ?? "Transcribing…"}
              progress={dubProgress?.progress ?? 0}
              onCancel={onCancelDub}
            />
          ) : (
            <button
              type="button"
              onClick={onStartDubTranscribe}
              disabled={dubSourceCount === 0 || groqHasKey === false}
              title={
                dubSourceCount === 0
                  ? "Import a local video clip first — the transcript uses the timeline's audio"
                  : groqHasKey === false
                    ? "Add your free Groq API key in the Captions tab first"
                    : "Extract + transcribe the timeline audio at word level"
              }
              className="mb-2 flex w-full items-center justify-center gap-1.5 rounded bg-orange-500 px-2.5 py-1.5 text-[11px] font-semibold text-white transition-colors hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ScanText size={11} />
              {dubTranscript ? "Re-transcribe audio" : "Transcribe audio · word level"}
            </button>
          )}

          {dubTranscript && !transcribeBusy && (
            <div>
              <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-stone-400">
                <span className="font-semibold text-stone-300">
                  {langNames[dubTranscript.language] ?? dubTranscript.language}
                </span>
                <span>· {dubTranscript.wordCount} words</span>
                <span>· {dubTranscript.utterances.length} lines</span>
                <span className="flex items-center gap-0.5">
                  <Clock size={9} /> {(dubTranscript.totalMs / 1000).toFixed(1)}s
                </span>
                <button
                  type="button"
                  onClick={() => setShowWords((w) => !w)}
                  aria-pressed={showWords}
                  className={cn(
                    "ml-auto rounded border px-1.5 py-0.5 text-[9px] font-medium transition-colors",
                    showWords
                      ? "border-orange-500/50 bg-orange-500/15 text-orange-300"
                      : "border-[#332e28] text-stone-400 hover:bg-white/[0.06]",
                  )}
                >
                  {showWords ? "Hide word timings" : "Show word timings"}
                </button>
              </div>

              {transcriptStale && (
                <p className="mb-1.5 flex items-center gap-1 rounded border px-1.5 py-1 text-[10px] text-amber-300" style={{ borderColor: "rgba(251, 191, 36, 0.3)", backgroundColor: "rgba(251, 191, 36, 0.07)" }}>
                  <AlertTriangle size={10} className="shrink-0" />
                  The timeline changed since this transcript — re-transcribe to stay in sync.
                </p>
              )}

              <div
                className="ff-scroll-thin mb-1.5 max-h-72 overflow-y-auto rounded border p-1"
                style={{ borderColor: "#332e28", backgroundColor: "#211e1a" }}
                role="log"
                aria-label="Word-level transcript"
              >
                {dubTranscript.utterances.map((u, i) => (
                  <div key={i} className="mb-1 rounded px-1.5 py-1 text-[10px] leading-relaxed" style={{ backgroundColor: "#26221e" }}>
                    <div className="flex items-baseline gap-1.5">
                      <span className="shrink-0 font-mono text-[9px] text-teal-400">
                        {dubTimecode(u.startMs)}–{dubTimecode(u.endMs)}
                      </span>
                      <span className="text-stone-300">{u.text}</span>
                    </div>
                    {showWords && u.words && u.words.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
                        {u.words.map((w, j) => (
                          <span key={j} className="text-stone-500">
                            {w.text}
                            <span className="ml-0.5 font-mono text-[8px] text-stone-600">
                              {(w.startMs / 1000).toFixed(2)}–{(w.endMs / 1000).toFixed(2)}
                            </span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  onClick={() => void copyTranscript()}
                  className="flex items-center gap-1 rounded border px-1.5 py-1 text-[10px] text-stone-400 transition-colors hover:bg-white/[0.06]"
                  style={{ borderColor: "#332e28" }}
                >
                  {copied ? <Check size={10} /> : <Copy size={10} />}
                  {copied ? "Copied" : "Copy"}
                </button>
                <button
                  type="button"
                  onClick={() =>
                    dubDownloadText(
                      `transcript-${dubTranscript.language || "audio"}.json`,
                      JSON.stringify(dubTranscript, null, 2),
                      "application/json",
                    )
                  }
                  className="flex items-center gap-1 rounded border px-1.5 py-1 text-[10px] text-stone-400 transition-colors hover:bg-white/[0.06]"
                  style={{ borderColor: "#332e28" }}
                >
                  <Download size={10} /> JSON
                </button>
                <button
                  type="button"
                  onClick={() =>
                    dubDownloadText(
                      `transcript-${dubTranscript.language || "audio"}.txt`,
                      dubTranscript.utterances
                        .map((u) => `${dubTimecode(u.startMs)} → ${dubTimecode(u.endMs)}  ${u.text}`)
                        .join("\n"),
                      "text/plain",
                    )
                  }
                  className="flex items-center gap-1 rounded border px-1.5 py-1 text-[10px] text-stone-400 transition-colors hover:bg-white/[0.06]"
                  style={{ borderColor: "#332e28" }}
                >
                  <Download size={10} /> TXT
                </button>
                <button
                  type="button"
                  onClick={() =>
                    dubDownloadText(
                      `transcript-${dubTranscript.language || "audio"}.srt`,
                      dubTranscript.utterances
                        .map((u, i) => `${i + 1}\n${dubSrtTime(u.startMs)} --> ${dubSrtTime(u.endMs)}\n${u.text}\n`)
                        .join("\n"),
                      "text/plain",
                    )
                  }
                  className="flex items-center gap-1 rounded border px-1.5 py-1 text-[10px] text-stone-400 transition-colors hover:bg-white/[0.06]"
                  style={{ borderColor: "#332e28" }}
                >
                  <Download size={10} /> SRT
                </button>
                <button
                  type="button"
                  onClick={onDiscardTranscript}
                  className="flex items-center gap-1 rounded border px-1.5 py-1 text-[10px] text-stone-400 transition-colors hover:bg-white/[0.06]"
                  style={{ borderColor: "#332e28" }}
                >
                  <Trash2 size={10} /> Clear
                </button>
                <button
                  type="button"
                  onClick={() => setStage("script")}
                  className="ml-auto flex items-center gap-1 rounded bg-orange-500 px-2 py-1 text-[10px] font-semibold text-white transition-colors hover:bg-orange-400"
                >
                  Create the dubbing script <ChevronRight size={10} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          STAGE 2 — THE EDITABLE DUBBING SCRIPT
          ═══════════════════════════════════════════════════════════════ */}
      {stage === "script" && (
        <div className="mb-2 rounded border p-2" style={{ borderColor: "#332e28", backgroundColor: "#26221e" }}>
          <p className="mb-1.5 text-[10px] leading-relaxed text-stone-400">
            <span className="font-semibold text-stone-300">2 · Dubbing script.</span>{" "}
            Detects the speakers, translates every line into the target language and shows the
            full script for review — edit any line before dubbing.
          </p>

          {/* language + provider */}
          <div className="mb-2 grid grid-cols-2 gap-1.5">
            <div>
              <label className="mb-0.5 block text-[10px] font-medium text-stone-500">
                Dub into
              </label>
              <select
                value={dubSettings.targetLanguage}
                onChange={(e) => changeLanguage(e.target.value)}
                className={selectCls}
                style={{ borderColor: "#332e28" }}
                aria-label="Target dub language"
              >
                {languages.length === 0 && (
                  <option value={dubSettings.targetLanguage}>
                    {langNames[dubSettings.targetLanguage] ?? dubSettings.targetLanguage}
                  </option>
                )}
                {languages.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-0.5 block text-[10px] font-medium text-stone-500">
                AI model provider
              </label>
              {webProvider ? (
                <div
                  className="flex items-center justify-center gap-1.5 rounded border border-orange-500/50 bg-orange-500/15 px-2 py-1.5 text-[11px] font-medium text-orange-300"
                  title="The web preview's built-in cloud AI runs the dub's speaker detection + translation — no key needed. The desktop app uses your Groq/Gemini key."
                >
                  <Sparkles size={12} /> Cloud AI (built-in)
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-1" role="group" aria-label="Dub AI model provider">
                    <button
                      type="button"
                      onClick={() =>
                        dubSettings.textProvider !== "groq" &&
                        onDubSettingsChange({ ...dubSettings, textProvider: "groq" })
                      }
                      className={cn(
                        "flex items-center justify-center gap-1.5 rounded border px-2 py-1.5 text-[11px] font-medium transition-colors",
                        (dubSettings.textProvider ?? "groq") === "groq"
                          ? "border-orange-500/50 bg-orange-500/15 text-orange-300"
                          : "border-[#2b2723] bg-[#26221e] text-stone-500 hover:bg-white/[0.04] hover:text-stone-300",
                      )}
                      aria-pressed={(dubSettings.textProvider ?? "groq") === "groq"}
                      title="Groq chat models run the dub's speaker detection + translation (free tier)"
                    >
                      <Sparkles size={12} /> Groq
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        (dubSettings.textProvider ?? "groq") !== "gemini" &&
                        onDubSettingsChange({ ...dubSettings, textProvider: "gemini" })
                      }
                      className={cn(
                        "flex items-center justify-center gap-1.5 rounded border px-2 py-1.5 text-[11px] font-medium transition-colors",
                        dubSettings.textProvider === "gemini"
                          ? "border-orange-500/50 bg-orange-500/15 text-orange-300"
                          : "border-[#2b2723] bg-[#26221e] text-stone-500 hover:bg-white/[0.04] hover:text-stone-300",
                      )}
                      aria-pressed={dubSettings.textProvider === "gemini"}
                      title="Gemini models run the dub's speaker detection + translation — needs your Gemini key (Settings → Script Writer)"
                    >
                      <PenLine size={12} /> Gemini
                    </button>
                  </div>
                  {dubSettings.textProvider === "gemini" && geminiHasKey === false && (
                    <p className="mt-1 text-[10px] text-orange-400/90">
                      No Gemini key saved — add one in Settings → Script Writer (aistudio.google.com/apikey),
                      or switch back to Groq.
                    </p>
                  )}
                </>
              )}
            </div>
          </div>

          <div className="mb-2 grid grid-cols-2 gap-1.5">
            {webProvider ? (
              <div>
                <label className="mb-0.5 block text-[10px] font-medium text-stone-500">
                  AI model
                </label>
                <p className="rounded border border-[#2b2723] bg-[#26221e] px-2 py-1.5 text-[10px] leading-relaxed text-stone-400">
                  Speaker detection + translation run on the built-in cloud
                  model — nothing to configure (no key needed in the web
                  preview).
                </p>
              </div>
            ) : (dubSettings.textProvider ?? "groq") === "gemini" ? (
              <div>
                <label className="mb-0.5 block text-[10px] font-medium text-stone-500">
                  Gemini model
                </label>
                <select
                  value={dubSettings.geminiModel}
                  onChange={(e) =>
                    onDubSettingsChange({ ...dubSettings, geminiModel: e.target.value })
                  }
                  className={selectCls}
                  style={{ borderColor: "#332e28" }}
                  aria-label="Gemini dub model"
                >
                  {geminiModels.length === 0 && (
                    <option value={dubSettings.geminiModel}>{dubSettings.geminiModel}</option>
                  )}
                  {geminiModels.map((m) => (
                    <option key={m.id} value={m.id} title={m.hint}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div>
                <label className="mb-0.5 block text-[10px] font-medium text-stone-500">
                  Groq model (free tier)
                </label>
                <select
                  value={dubSettings.groqModel}
                  onChange={(e) =>
                    onDubSettingsChange({ ...dubSettings, groqModel: e.target.value })
                  }
                  className={selectCls}
                  style={{ borderColor: "#332e28" }}
                  aria-label="Groq text model"
                >
                  {models.length === 0 && (
                    <option value={dubSettings.groqModel}>{dubSettings.groqModel}</option>
                  )}
                  {models.map((m) => (
                    <option key={m.id} value={m.id} title={m.hint}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="mb-0.5 block text-[10px] font-medium text-stone-500">
                Voice mode
              </label>
              <div className="grid grid-cols-2 gap-1" role="group" aria-label="Voice mode">
                <button
                  type="button"
                  onClick={() => setVoiceMode("single")}
                  className={cn(
                    "flex items-center justify-center gap-1.5 rounded border px-2 py-1.5 text-[11px] font-medium transition-colors",
                    singleMode
                      ? "border-orange-500/50 bg-orange-500/15 text-orange-300"
                      : "border-[#2b2723] bg-[#26221e] text-stone-500 hover:bg-white/[0.04] hover:text-stone-300",
                  )}
                  aria-pressed={singleMode}
                  title="One voice reads every line — speaker detection is skipped"
                >
                  <User size={12} /> One voice
                </button>
                <button
                  type="button"
                  onClick={() => setVoiceMode("multi")}
                  className={cn(
                    "flex items-center justify-center gap-1.5 rounded border px-2 py-1.5 text-[11px] font-medium transition-colors",
                    !singleMode
                      ? "border-orange-500/50 bg-orange-500/15 text-orange-300"
                      : "border-[#2b2723] bg-[#26221e] text-stone-500 hover:bg-white/[0.04] hover:text-stone-300",
                  )}
                  aria-pressed={!singleMode}
                  title="Detect speakers and assign a voice to each"
                >
                  <Users size={12} /> Multi-speaker
                </button>
              </div>
            </div>
          </div>

          {scriptBusy ? (
            <DubProgressRow
              status={dubProgress?.status ?? "Writing the script…"}
              progress={dubProgress?.progress ?? 0}
              onCancel={onCancelDub}
            />
          ) : (
            <button
              type="button"
              onClick={onStartDubScript}
              disabled={!dubTranscript || groqHasKey === false}
              title={
                !dubTranscript
                  ? "Run stage 1 first — the script is built from the word-level transcript"
                  : groqHasKey === false
                    ? "Add your free Groq API key in the Captions tab first"
                    : "Detect speakers + translate the transcript into the selected language"
              }
              className="mb-2 flex w-full items-center justify-center gap-1.5 rounded bg-orange-500 px-2.5 py-1.5 text-[11px] font-semibold text-white transition-colors hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <FileText size={11} />
              {dubScript
                ? `Regenerate script (${dubSettings.targetLanguage})`
                : `Create dubbing script (${langNames[dubSettings.targetLanguage] ?? dubSettings.targetLanguage})`}
            </button>
          )}

          {dubScript && !scriptBusy && (
            <div>
              <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-stone-400">
                <span className="font-semibold text-stone-300">
                  {singleMode ? "One voice" : `${dubScript.speakerCount} speakers`}
                </span>
                <span>· {scriptLines.length} lines · editable</span>
                <span className="text-stone-500">
                  (dub: {dubScript.targetLanguageName ?? dubScript.targetLanguage})
                </span>
                <button
                  type="button"
                  onClick={onDiscardScript}
                  className="ml-auto flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] text-stone-400 transition-colors hover:bg-white/[0.06]"
                  style={{ borderColor: "#332e28" }}
                >
                  <Trash2 size={9} /> Clear script
                </button>
              </div>

              {dubScript.warnings.length > 0 && (
                <p className="mb-1.5 flex items-start gap-1 rounded border px-1.5 py-1 text-[10px] leading-relaxed text-amber-300" style={{ borderColor: "rgba(251, 191, 36, 0.3)", backgroundColor: "rgba(251, 191, 36, 0.07)" }}>
                  <AlertTriangle size={10} className="mt-px shrink-0" />
                  {dubScript.warnings[0]}
                  {dubScript.warnings.length > 1 && ` (+${dubScript.warnings.length - 1} more)`}
                </p>
              )}

              <div
                className="ff-scroll-thin mb-1.5 max-h-80 overflow-y-auto rounded border p-1"
                style={{ borderColor: "#332e28", backgroundColor: "#211e1a" }}
                role="list"
                aria-label="Dubbing script lines"
              >
                {scriptLines.map((l) => (
                  <div
                    key={l.i}
                    className="mb-1 rounded p-1.5"
                    style={{ backgroundColor: "#26221e" }}
                    role="listitem"
                  >
                    <div className="mb-1 flex items-center gap-1.5">
                      {!singleMode && (
                        <select
                          value={l.speaker}
                          onChange={(e) =>
                            onDubScriptChange(
                              scriptLines.map((x) =>
                                x.i === l.i ? { ...x, speaker: Number(e.target.value) } : x,
                              ),
                            )
                          }
                          className="shrink-0 rounded border bg-[#211e1a] px-1 py-px text-[9px] text-stone-300 focus:border-orange-500"
                          style={{ borderColor: "#332e28" }}
                          aria-label={`Speaker for line ${l.i + 1}`}
                        >
                          {Array.from({ length: multiSpeakerCount }, (_, id) => (
                            <option key={id} value={id}>
                              Speaker {id + 1}
                            </option>
                          ))}
                        </select>
                      )}
                      {singleMode && <SpeakerChip id={0} />}
                      <span className="font-mono text-[9px] text-teal-400">
                        {dubTimecode(l.startMs)}–{dubTimecode(l.endMs)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[10px] text-stone-500">
                        {l.sourceText}
                      </span>
                      <button
                        type="button"
                        onClick={() => onDubScriptChange(scriptLines.filter((x) => x.i !== l.i))}
                        title="Remove this line from the dub"
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-stone-500 transition-colors hover:bg-white/[0.06] hover:text-stone-300"
                        aria-label={`Remove line ${l.i + 1}`}
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                    <textarea
                      value={l.translatedText}
                      onChange={(e) =>
                        onDubScriptChange(
                          scriptLines.map((x) =>
                            x.i === l.i ? { ...x, translatedText: e.target.value } : x,
                          ),
                        )
                      }
                      rows={2}
                      className="ff-scroll-thin w-full resize-y rounded border bg-[#211e1a] px-1.5 py-1 text-[10px] leading-relaxed text-stone-200 focus:border-orange-500 focus:outline-none"
                      style={{ borderColor: "#332e28" }}
                      aria-label={`Dubbed text for line ${l.i + 1}`}
                    />
                  </div>
                ))}
              </div>

              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setStage("dub")}
                  className="flex items-center gap-1 rounded bg-orange-500 px-2 py-1 text-[10px] font-semibold text-white transition-colors hover:bg-orange-400"
                >
                  Choose voices &amp; dub <ChevronRight size={10} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════
          STAGE 3 — VOICES + SYNTHESIZE
          ═══════════════════════════════════════════════════════════════ */}
      {stage === "dub" && (
        <div className="mb-2 rounded border p-2" style={{ borderColor: "#332e28", backgroundColor: "#26221e" }}>
          <p className="mb-1.5 text-[10px] leading-relaxed text-stone-400">
            <span className="font-semibold text-stone-300">3 · Voices &amp; dub.</span>{" "}
            {dubScript
              ? "Synthesize the edited script with the voices below — original audio is ducked."
              : "No script yet — the button below runs the whole pipeline in one click."}
          </p>

          {singleMode ? (
            <div className="mb-2">
              <label className="mb-0.5 block text-[10px] font-medium text-stone-500">
                Dubbing voice
              </label>
              <div className="flex items-center gap-1">
                <select
                  value={singleVoiceValue}
                  onChange={(e) =>
                    onDubSettingsChange({ ...dubSettings, singleVoice: e.target.value })
                  }
                  className={cn(selectCls, "flex-1")}
                  style={{ borderColor: "#332e28" }}
                  aria-label="Dubbing voice"
                >
                  {localeVoices.length === 0 && (
                    <option value={singleVoiceValue}>
                      {singleVoiceValue || "auto"}
                    </option>
                  )}
                  {localeVoices.map((v) => (
                    <option key={v.shortName} value={v.shortName}>
                      {v.displayName}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void playPreview(singleVoiceValue)}
                  disabled={!singleVoiceValue}
                  title="Listen to this voice"
                  className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded border text-orange-600 transition-colors hover:bg-orange-500/10 disabled:cursor-not-allowed disabled:opacity-40"
                  style={{ borderColor: "#332e28" }}
                  aria-label="Preview dubbing voice"
                >
                  <Play size={11} />
                </button>
              </div>
            </div>
          ) : (
            <div className="mb-2 grid grid-cols-2 gap-1.5">
              {Array.from({ length: multiSpeakerCount }, (_, id) => speakerVoiceRow(id))}
            </div>
          )}

          <Field
            label="Original audio"
            hint={`${Math.round(dubSettings.originalVolume * 100)}%`}
          >
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(dubSettings.originalVolume * 100)}
              onChange={(e) =>
                onDubSettingsChange({
                  ...dubSettings,
                  originalVolume: Number(e.target.value) / 100,
                })
              }
              className="w-full accent-orange-600"
              aria-label="Original audio level under the dub"
            />
          </Field>

          {dubRunBusy ? (
            <div className="mt-2">
              <DubProgressRow
                status={dubProgress?.status ?? "Dubbing…"}
                progress={dubProgress?.progress ?? 0}
                onCancel={onCancelDub}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={dubScript ? onStartDubFromScript : onStartDub}
              disabled={
                (dubScript ? scriptLines.length === 0 : dubSourceCount === 0) ||
                (dubScript ? false : groqHasKey === false)
              }
              title={
                dubScript
                  ? "Synthesize the edited script (no re-transcription, no re-translation)"
                  : dubSourceCount === 0
                    ? "Import a local video clip first — the dub uses the timeline's audio"
                    : groqHasKey === false
                      ? "Add your free Groq API key in the Captions tab first"
                      : "Transcribe → translate → synthesize a full dub track in one click"
              }
              className="mt-2 flex w-full items-center justify-center gap-1.5 rounded bg-orange-500 px-2.5 py-1.5 text-[11px] font-semibold text-white transition-colors hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Languages size={11} />
              {dubScript
                ? `Start dubbing — this script (${scriptLines.length} lines)`
                : "Auto: transcribe → script → dub"}
            </button>
          )}

          {dubResult && (
            <div className="mt-2 rounded border" style={{ borderColor: "#332e28" }}>
              <div className="flex items-center justify-between px-2 py-1.5">
                <span className="text-[10px] font-semibold text-stone-400">
                  {dubResult.speakers.length} speaker
                  {dubResult.speakers.length === 1 ? "" : "s"} ·{" "}
                  {dubResult.segments.length} segments
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={onApplyDubTrack}
                    className="flex items-center gap-1 rounded bg-orange-500 px-2 py-1 text-[10px] font-semibold text-white transition-colors hover:bg-orange-400"
                  >
                    <Check size={10} /> Add to timeline
                  </button>
                  <button
                    type="button"
                    onClick={onDiscardDub}
                    className="flex items-center gap-1 rounded border px-1.5 py-1 text-[10px] text-stone-400 transition-colors hover:bg-white/[0.06]"
                    style={{ borderColor: "#332e28" }}
                  >
                    <Trash2 size={10} /> Discard
                  </button>
                </div>
              </div>
              <div
                className="ff-scroll-thin max-h-64 overflow-y-auto px-2 pb-2"
                role="log"
                aria-label="Dub segments"
              >
                {dubResult.segments.map((s, i) => (
                  <div
                    key={i}
                    className="mb-1 rounded px-1.5 py-1 text-[10px] leading-relaxed"
                    style={{ backgroundColor: "#26221e" }}
                  >
                    <SpeakerChip id={s.speaker ?? 0} />
                    <span className="text-stone-500">
                      {(s.startMs / 1000).toFixed(1)}s
                    </span>
                    <span className="mx-1 text-stone-400">·</span>
                    {s.translatedText}
                    <div className="mt-0.5 truncate text-stone-400">{s.sourceText}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <p className="mb-1 mt-1 text-[10px] leading-relaxed text-stone-500">
        {dubSourceCount > 0
          ? webProvider
            ? `Source: ${dubSourceCount} timeline clip${dubSourceCount === 1 ? "" : "s"} — cloud transcription, no key needed in the web preview.`
            : `Source: ${dubSourceCount} timeline clip${dubSourceCount === 1 ? "" : "s"} — free Groq key required (Captions tab).`
          : "Import a local video clip on the timeline to dub it."}
      </p>
    </Section>
  );
}
