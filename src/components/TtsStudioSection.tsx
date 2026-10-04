"use client";

// ---------------------------------------------------------------------------
// v1.26 — AI TEXT-TO-SPEECH STUDIO (its own "TTS" dock tab)
//
// A full Edge-TTS surface on top of the speech transport
// (src/lib/speech-api.ts):
//   • up to 200,000 words (1.5 M chars) chunked into ONE merged MP3
//   • live chunk/char progress + cancel (works in web AND desktop)
//   • word-level timings → captions handoff, SRT/VTT/JSON sidecars
//   • QWERTY (romanized) Hindi/Urdu input — auto-converts to native script
//   • language picker grouped by language name + voice presets (built-in
//     prosody presets + user-saved voice presets)
//   • handoffs: VO lane (≤ 20 min), Audio lane (any length), captions
//
// Electron discipline: synthesis goes IPC-first when the bridge exists;
// in the web preview the /api/tts routes serve the same Edge-TTS engine
// server-side, so Generate/preview work in the browser too.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  AudioLines,
  Captions,
  ChevronDown,
  Clock,
  Download,
  Loader2,
  Mic,
  Music,
  Play,
  Plus,
  Search,
  Square,
  Star,
  Trash2,
} from "lucide-react";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { fmtTimecode } from "@/lib/merger/timeline";
import {
  isLikelyRomanized,
  localeWantsTranslit,
  transliterateForLocale,
} from "@/lib/translit";
import {
  regionLabel,
  ttsPreviewVoice,
  ttsSynthesize,
} from "@/lib/speech-api";
import { useTtsVoices, type TtsVoice } from "./use-tts-voices";

// ---------------------------------------------------------------------------
// Props contract (page.tsx owns the timeline/VO/caption mutations)
// ---------------------------------------------------------------------------
export interface TtsStudioSectionProps {
  onAddVoiceover: (vo: {
    text: string;
    voice: string;
    ratePct?: number;
    pitchHz?: number;
    volume?: number;
    durationMs: number;
    bytes: Blob;
  }) => void;
  voCount: number;
  /** Add synthesized audio as a TIMELINE MUSIC clip (works for any length). */
  onAddMusicAudio: (a: {
    fileName: string;
    blob: Blob;
    durationMs: number;
  }) => void;
  /** Create word-level captions from the TTS word timings. */
  onCreateWordCaptions: (r: {
    title: string;
    words: Array<{ text: string; startMs: number; endMs: number }>;
  }) => void;
}

// ---------------------------------------------------------------------------
// Limits / persistence
// ---------------------------------------------------------------------------
const LS_KEY = "framefuse.ttsstudio.v1";
const MAX_WORDS = 200_000;
const MAX_CHARS = 1_500_000;
/** Narration longer than 20 minutes belongs on the Audio lane, not VO. */
const VO_LANE_MAX_MS = 20 * 60 * 1000;
/** ttsPreview cap (main-process) and the studio's own preview slice. */
const PREVIEW_MAX_CHARS = 300;

/** Locale-appropriate preview fallbacks (only hi/ur need native text —
 *  an English sample read by those voices sounds wrong). */
const STUDIO_PREVIEW_SAMPLES: Record<string, string> = {
  hi: "नमस्ते, यह आवाज़ का एक नमूना है।",
  ur: "ہیلو، یہ آواز کا ایک نمونہ ہے۔",
};

function previewFallback(locale: string): string {
  const lang = (locale || "").split("-")[0].toLowerCase();
  return (
    STUDIO_PREVIEW_SAMPLES[lang] ??
    "This is a voice preview of the selected voice."
  );
}

// ---------------------------------------------------------------------------
// Shared helpers (exported — VoiceoverSection reuses them)
// ---------------------------------------------------------------------------
export type VoiceGenderFilter = "all" | "female" | "male";

export interface VoiceFilter {
  search: string;
  locale: string;
  gender: VoiceGenderFilter;
}

/** Locale + gender + free-text search filter over the live catalog. */
export function filterTtsVoices(
  voices: TtsVoice[],
  f: VoiceFilter,
): TtsVoice[] {
  const q = f.search.trim().toLowerCase();
  return voices.filter((v) => {
    if (f.locale && v.locale !== f.locale) return false;
    if (f.gender !== "all" && (v.gender || "").toLowerCase() !== f.gender) {
      return false;
    }
    if (q) {
      const hay =
        `${v.displayName} ${v.shortName} ${v.friendlyName} ${v.locale}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export interface QwertyResolve {
  /** The text synthesis (and previews) should actually receive. */
  converted: string;
  /** The user pasted native script — conversion is skipped, pass through. */
  nativeDetected: boolean;
  /** A conversion will actually happen (romanized + toggle on). */
  willConvert: boolean;
}

/**
 * QWERTY (romanized) → native-script resolution for hi / ur locales.
 * Pure — shared verbatim with the Voiceover section.
 */
export function resolveQwertyText(
  text: string,
  locale: string,
  qwertyOn: boolean,
): QwertyResolve {
  if (!localeWantsTranslit(locale) || !text.trim() || !qwertyOn) {
    return { converted: text, nativeDetected: false, willConvert: false };
  }
  if (!isLikelyRomanized(text)) {
    return { converted: text, nativeDetected: true, willConvert: false };
  }
  return {
    converted: transliterateForLocale(text, locale),
    nativeDetected: false,
    willConvert: true,
  };
}

/** Teal Flow-Night toggle (the studio's QWERTY switch; same fixed thumb
 *  geometry as SettingsPanel's Toggle). */
export function StudioToggle({
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
            ? "border-teal-400/60 bg-teal-500 shadow-[0_0_10px_rgba(45,212,191,0.3)]"
            : "border-[#3a352d] bg-[#2a2724] hover:bg-[#33302b]",
        )}
      >
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

/** All / Female / Male segmented chips (shared voice filter). */
export function VoiceGenderChips({
  value,
  onChange,
}: {
  value: VoiceGenderFilter;
  onChange: (v: VoiceGenderFilter) => void;
}) {
  const opts: { value: VoiceGenderFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "female", label: "Female" },
    { value: "male", label: "Male" },
  ];
  return (
    <div
      className="flex shrink-0 items-center gap-1"
      role="radiogroup"
      aria-label="Voice gender filter"
    >
      {opts.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded-full border px-2 py-[3px] text-[10px] font-medium transition-colors",
              active
                ? "border-teal-500/50 bg-[#10201d] text-teal-300"
                : "border-[#332e28] text-stone-500 hover:bg-white/[0.04] hover:text-stone-300",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// v1.26 VOICE PRESETS — prosody styles (built-in) + user-saved voice configs
// ---------------------------------------------------------------------------
/** A built-in prosody preset — applies speed/pitch/volume, keeps the voice. */
interface BuiltInPreset {
  id: string;
  name: string;
  hint: string;
  ratePct: number;
  pitchHz: number;
  volumePct: number;
}

const BUILT_IN_PRESETS: BuiltInPreset[] = [
  { id: "natural", name: "Natural", hint: "Default pace and tone", ratePct: 0, pitchHz: 0, volumePct: 100 },
  { id: "narrator", name: "Narrator", hint: "Measured documentary narration", ratePct: -10, pitchHz: 0, volumePct: 100 },
  { id: "audiobook", name: "Audiobook", hint: "Slow, warm, comfortable", ratePct: -18, pitchHz: -5, volumePct: 100 },
  { id: "news", name: "News anchor", hint: "Crisp and confident", ratePct: 8, pitchHz: 0, volumePct: 100 },
  { id: "promo", name: "Promo", hint: "Energetic advertisement read", ratePct: 18, pitchHz: 15, volumePct: 100 },
  { id: "calm", name: "Calm", hint: "Soft meditation pacing", ratePct: -25, pitchHz: -10, volumePct: 95 },
  { id: "podcast", name: "Podcast", hint: "Conversational host tone", ratePct: -5, pitchHz: 5, volumePct: 100 },
];

/** A user-saved preset — captures the FULL synthesis config (voice + prosody). */
interface UserPreset {
  id: string;
  name: string;
  voice: string;
  locale: string;
  ratePct: number;
  pitchHz: number;
  volumePct: number;
}

const PRESET_LS_KEY = "framefuse.tts.presets.v1";

function loadUserPresets(): UserPreset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(PRESET_LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (p): p is UserPreset =>
        !!p &&
        typeof (p as UserPreset).id === "string" &&
        typeof (p as UserPreset).name === "string" &&
        typeof (p as UserPreset).voice === "string" &&
        typeof (p as UserPreset).locale === "string" &&
        typeof (p as UserPreset).ratePct === "number" &&
        typeof (p as UserPreset).pitchHz === "number" &&
        typeof (p as UserPreset).volumePct === "number",
    );
  } catch {
    return [];
  }
}

function saveUserPresets(list: UserPreset[]) {
  try {
    window.localStorage.setItem(PRESET_LS_KEY, JSON.stringify(list));
  } catch {
    /* storage full / private mode — non-fatal */
  }
}

// ---------------------------------------------------------------------------
// Local formatters / serializers (one cue per word for sidecars)
// ---------------------------------------------------------------------------
interface StudioWord {
  text: string;
  offsetMs: number;
  durationMs: number;
}

interface TtsStudioResult {
  /** Main-process file name (ttslong_<ts>.mp3). */
  fileName: string;
  /** The EXACT text this run synthesized (native script when converted). */
  text: string;
  blob: Blob;
  url: string;
  durationMs: number;
  bytesLen: number;
  words: StudioWord[];
  chunkCount: number;
}

interface RunProgress {
  phase: "synth" | "probe" | "done";
  chunkIndex: number;
  chunkCount: number;
  charsDone: number;
  totalChars: number;
  status: string;
}

/** MM:SS (or H:MM:SS) for the live elapsed timer. */
function fmtElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** mm:ss.mmm — word-table precision (fmtTimecode is whole seconds). */
function fmtMsTimecode(ms: number): string {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const m = Math.floor(safe / 60_000);
  const s = Math.floor((safe % 60_000) / 1000);
  const milli = Math.floor(safe % 1000);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(milli).padStart(3, "0")}`;
}

function fmtMB(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function srtTimecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  return (
    `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:` +
    `${String(s).padStart(2, "0")},${String(total % 1000).padStart(3, "0")}`
  );
}

function vttTimecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  return (
    `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:` +
    `${String(s).padStart(2, "0")}.${String(total % 1000).padStart(3, "0")}`
  );
}

/** SRT sidecar: one cue per word (start = global offset, end = +duration). */
function wordsToSrt(words: StudioWord[]): string {
  return words
    .map(
      (w, i) =>
        `${i + 1}\n${srtTimecode(w.offsetMs)} --> ${srtTimecode(w.offsetMs + w.durationMs)}\n${w.text}`,
    )
    .join("\n\n");
}

/** WebVTT sidecar: same one-word cues, dot-separated timestamps. */
function wordsToVtt(words: StudioWord[]): string {
  const body = words
    .map(
      (w) =>
        `${vttTimecode(w.offsetMs)} --> ${vttTimecode(w.offsetMs + w.durationMs)}\n${w.text}`,
    )
    .join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}

function wordsToJson(words: StudioWord[]): string {
  return JSON.stringify(
    {
      format: "framefuse-tts-words/1",
      count: words.length,
      words: words.map((w) => ({
        text: w.text,
        startMs: w.offsetMs,
        endMs: w.offsetMs + w.durationMs,
      })),
    },
    null,
    2,
  );
}

/** Anchor-download a text sidecar (same flow as the page's sidecar exports). */
function downloadText(fileName: string, text: string, mime: string) {
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

/** yyyymmdd-hhmm stamp for the "Save audio file" download name. */
function ttsFileStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}`
  );
}

/** Compact label/hint row for the studio's sliders. */
function StudioField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-baseline justify-between gap-1">
        <label className="text-[10px] font-medium text-stone-500">
          {label}
        </label>
        {hint && (
          <span className="text-[10px] tabular-nums text-stone-400">
            {hint}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The Studio
// ---------------------------------------------------------------------------
export default function TtsStudioSection({
  onAddVoiceover,
  voCount,
  onAddMusicAudio,
  onCreateWordCaptions,
}: TtsStudioSectionProps) {
  const { voices, pairs, languages } = useTtsVoices();

  const [open, setOpen] = useState(true);
  // Script + settings (persisted to localStorage as one draft object).
  const [text, setText] = useState("");
  const [qwerty, setQwerty] = useState(true);
  const [search, setSearch] = useState("");
  const [locale, setLocale] = useState("en-US");
  const [gender, setGender] = useState<VoiceGenderFilter>("all");
  const [voice, setVoice] = useState("en-US-AriaNeural");
  const [ratePct, setRatePct] = useState(0);
  const [pitchHz, setPitchHz] = useState(0);
  const [volumePct, setVolumePct] = useState(100);
  // v1.26 presets: user-saved voice configs (built-ins are constants).
  const [userPresets, setUserPresets] = useState<UserPreset[]>([]);
  const [presetName, setPresetName] = useState("");
  // Preview / run / result.
  const [previewBusy, setPreviewBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [result, setResult] = useState<TtsStudioResult | null>(null);
  const [wordsOpen, setWordsOpen] = useState(false);

  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const resultUrlRef = useRef<string | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const runStartRef = useRef(0);
  const hydratedRef = useRef(false);
  /** Web-mode abort handle for the active long synthesis. */
  const synthAbortRef = useRef<AbortController | null>(null);

  // v1.26: user presets load once on mount (plain read — hydration-safe).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUserPresets(loadUserPresets());
  }, []);

  // ---- Draft persistence ---------------------------------------------------
  useEffect(() => {
    hydratedRef.current = true;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const d = JSON.parse(raw) as Record<string, unknown>;
      // One-shot mount hydration of the persisted draft (the v4.2 pattern:
      // persisted values are applied in a mount effect, not initializers —
      // SSR/localStorage safety). Suppressed per the codebase convention.
      /* eslint-disable react-hooks/set-state-in-effect */
      if (typeof d.text === "string") setText(d.text.slice(0, MAX_CHARS));
      if (typeof d.qwerty === "boolean") setQwerty(d.qwerty);
      if (typeof d.locale === "string" && d.locale) setLocale(d.locale);
      if (typeof d.voice === "string" && d.voice) setVoice(d.voice);
      if (
        d.gender === "all" ||
        d.gender === "female" ||
        d.gender === "male"
      ) {
        setGender(d.gender);
      }
      if (typeof d.ratePct === "number") {
        setRatePct(Math.max(-95, Math.min(100, Math.round(d.ratePct))));
      }
      if (typeof d.pitchHz === "number") {
        setPitchHz(Math.max(-100, Math.min(100, Math.round(d.pitchHz))));
      }
      if (typeof d.volumePct === "number") {
        setVolumePct(Math.max(0, Math.min(100, Math.round(d.volumePct))));
      }
    } catch {
      /* corrupted draft — start fresh */
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  // Debounced write (a 1.5 M-char draft shouldn't hit storage per keystroke).
  useEffect(() => {
    if (!hydratedRef.current) return;
    const t = window.setTimeout(() => {
      try {
        localStorage.setItem(
          LS_KEY,
          JSON.stringify({
            text,
            qwerty,
            locale,
            voice,
            gender,
            ratePct,
            pitchHz,
            volumePct,
          }),
        );
      } catch {
        /* storage full / private mode — non-fatal */
      }
    }, 400);
    return () => window.clearTimeout(t);
  }, [text, qwerty, locale, voice, gender, ratePct, pitchHz, volumePct]);

  // ---- Derived -------------------------------------------------------------
  const wordCount = useMemo(
    () => (text.trim() ? text.trim().split(/\s+/).length : 0),
    [text],
  );
  const charCount = text.length;
  const overLimit = wordCount > MAX_WORDS || charCount > MAX_CHARS;

  /** Locale of the SELECTED voice (falls back to the locale select). */
  const activeLocale = useMemo(
    () =>
      voices?.find((v) => v.shortName === voice)?.locale ?? locale,
    [voices, voice, locale],
  );
  const showQwerty = localeWantsTranslit(activeLocale) !== null;
  const qw = useMemo(
    () => resolveQwertyText(text, activeLocale, qwerty),
    [text, activeLocale, qwerty],
  );
  const convertedText = qw.converted;

  const locales = useMemo(() => {
    const set = new Set<string>();
    for (const v of voices ?? []) set.add(v.locale);
    return Array.from(set).sort();
  }, [voices]);

  /** v1.26: the language picker's grouped options — every catalog locale,
 *  grouped under its human language name ("Hindi" → hi-IN). Falls back to
 *  the raw locale list while the catalog is loading. */
  const languageGroups = useMemo(() => {
    const catalog = languages ?? [];
    const have = new Set(locales);
    const groups = catalog
      .map((lang) => ({
        ...lang,
        locales: lang.locales.filter((l) => have.size === 0 || have.has(l)),
      }))
      .filter((g) => g.locales.length > 0);
    if (groups.length > 0) return groups;
    // Catalog still loading — one flat group of the known locales.
    return locales.length > 0
      ? [{ code: "", name: "All languages", locales }]
      : [{ code: "", name: "Loading…", locales: [locale] }];
  }, [languages, locales, locale]);

  /** Option label: "Hindi (India)" / "English (United States)". */
  const localeLabel = useCallback(
    (l: string) => {
      const langPart = (l.split("-")[0] || l).toLowerCase();
      const group = (languages ?? []).find((g) => g.code === langPart);
      const langName = group?.name ?? langPart;
      return l.includes("-") ? `${langName} (${regionLabel(l)})` : langName;
    },
    [languages],
  );

  const filteredVoices = useMemo(
    () => filterTtsVoices(voices ?? [], { search, locale, gender }),
    [voices, search, locale, gender],
  );

  /** The built-in preset that matches the CURRENT prosody (or null). */
  const activeBuiltIn = useMemo(
    () =>
      BUILT_IN_PRESETS.find(
        (p) => p.ratePct === ratePct && p.pitchHz === pitchHz && p.volumePct === volumePct,
      ) ?? null,
    [ratePct, pitchHz, volumePct],
  );

  /** Apply a built-in prosody preset (voice stays untouched). */
  const applyBuiltIn = useCallback((p: BuiltInPreset) => {
    setRatePct(p.ratePct);
    setPitchHz(p.pitchHz);
    setVolumePct(p.volumePct);
  }, []);

  /** Apply a user preset — voice, locale AND prosody. */
  const applyUserPreset = useCallback(
    (p: UserPreset) => {
      setLocale(p.locale);
      setSearch("");
      setVoice(p.voice);
      setRatePct(p.ratePct);
      setPitchHz(p.pitchHz);
      setVolumePct(p.volumePct);
      toast.info(`Preset "${p.name}" applied`, {
        description: `${p.voice} · speed ${p.ratePct > 0 ? "+" : ""}${p.ratePct}% · pitch ${p.pitchHz > 0 ? "+" : ""}${p.pitchHz}Hz`,
      });
    },
    [],
  );

  /** Save the CURRENT config (voice + locale + prosody) as a user preset. */
  const savePreset = useCallback(() => {
    const name = presetName.trim();
    if (!name) {
      toast.error("Name the preset first");
      return;
    }
    if (!voice) {
      toast.error("Select a voice first");
      return;
    }
    const next: UserPreset[] = [
      ...userPresets.filter((p) => p.name.toLowerCase() !== name.toLowerCase()),
      {
        id: `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        name,
        voice,
        locale,
        ratePct,
        pitchHz,
        volumePct,
      },
    ];
    setUserPresets(next);
    saveUserPresets(next);
    setPresetName("");
    toast.success(`Preset "${name}" saved`, {
      description: "It appears below the built-in style presets.",
    });
  }, [presetName, voice, userPresets, locale, ratePct, pitchHz, volumePct]);

  const deleteUserPreset = useCallback((id: string) => {
    setUserPresets((prev) => {
      const next = prev.filter((p) => p.id !== id);
      saveUserPresets(next);
      return next;
    });
  }, []);

  // Locale switch → that locale's female pair default; clear the search so
  // the new locale's list isn't accidentally empty.
  const changeLocale = useCallback(
    (next: string) => {
      setLocale(next);
      setSearch("");
      const pair = pairs[next];
      if (pair?.female) setVoice(pair.female);
      else {
        const first = (voices ?? []).find((v) => v.locale === next);
        if (first) setVoice(first.shortName);
      }
    },
    [pairs, voices],
  );

  // Gender switch → keep the current voice when it still matches, else the
  // first voice of the new filter.
  const changeGender = useCallback(
    (g: VoiceGenderFilter) => {
      setGender(g);
      const list = filterTtsVoices(voices ?? [], { search, locale, gender: g });
      if (list.length > 0 && !list.some((v) => v.shortName === voice)) {
        setVoice(list[0].shortName);
      }
    },
    [voices, search, locale, voice],
  );

  // ---- Voice preview (single-flight, detached <audio>) ---------------------
  const stopPreview = useCallback(() => {
    const a = previewAudioRef.current;
    if (a) {
      a.pause();
      previewAudioRef.current = null;
    }
  }, []);

  useEffect(() => stopPreview, [stopPreview]);

  const playPreview = useCallback(async () => {
    stopPreview();
    if (!voice) return;
    setPreviewBusy(true);
    try {
      const sample = (
        convertedText.trim() || previewFallback(activeLocale)
      ).slice(0, PREVIEW_MAX_CHARS);
      // v1.26 transport: IPC in the desktop app, /api/tts/synthesize in the
      // web preview — previews work in both runtimes now.
      const r = await ttsPreviewVoice({ voice, text: sample });
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
  }, [voice, convertedText, activeLocale, stopPreview]);

  // ---- Long-run progress subscription --------------------------------------
  // Live elapsed timer while a run is active.
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => {
      setElapsedMs(Date.now() - runStartRef.current);
    }, 250);
    return () => window.clearInterval(t);
  }, [running]);

  // Revoke the result object URL on replace/unmount (the blob itself stays
  // alive for the VO/Audio-lane handoffs — page.tsx owns those URLs).
  useEffect(
    () => () => {
      if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
      const a = previewAudioRef.current;
      if (a) a.pause();
    },
    [],
  );

  // ---- GENERATE ------------------------------------------------------------
  const generate = useCallback(async () => {
    const finalText = convertedText.trim();
    if (!finalText) {
      toast.error("Write the narration text first");
      return;
    }
    if (!voice) {
      toast.error("Select a voice first");
      return;
    }
    if (overLimit) return;

    const runId = `tts_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    activeRunIdRef.current = runId;
    runStartRef.current = Date.now();
    setElapsedMs(0);
    setRunning(true);
    setProgress({
      phase: "synth",
      chunkIndex: 0,
      chunkCount: 0,
      charsDone: 0,
      totalChars: finalText.length,
      status: "starting",
    });

    // Web-mode abort handle (the IPC path cancels via ttsCancelLong).
    const abort = new AbortController();
    synthAbortRef.current = abort;

    try {
      // v1.26 transport — IPC-first (main-process chunking + progress
      // channel), web fallback (client chunk loop against /api/tts/synthesize
      // with the SAME progress/cancel contract).
      const res = await ttsSynthesize({
        text: finalText,
        voice,
        ratePct,
        pitchHz,
        volumePct,
        signal: abort.signal,
        onProgress: (d) => {
          if (activeRunIdRef.current !== runId) return;
          setProgress({
            phase: "synth",
            chunkIndex: d.chunkIndex,
            chunkCount: d.chunkCount,
            charsDone: d.charsDone,
            totalChars: d.totalChars || finalText.length,
            status: d.status,
          });
        },
      });
      const blob = new Blob([res.bytes as BlobPart], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
      resultUrlRef.current = url;
      setResult({
        fileName: `tts_${runId.slice(4)}.mp3`,
        text: finalText,
        blob,
        url,
        durationMs: res.durationMs,
        bytesLen: res.bytesLen,
        words: res.words ?? [],
        chunkCount: res.chunkCount,
      });
      setWordsOpen(false);
      toast.success("Narration ready", {
        description: `${fmtTimecode(res.durationMs)} · ${(res.words?.length ?? 0).toLocaleString()} words · ${res.chunkCount} chunk${res.chunkCount === 1 ? "" : "s"}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/cancel|abort/i.test(msg)) toast.info("Synthesis cancelled");
      else toast.error("TTS synthesis failed", { description: msg });
    } finally {
      synthAbortRef.current = null;
      activeRunIdRef.current = null;
      setRunning(false);
      setProgress(null);
    }
  }, [convertedText, voice, overLimit, ratePct, pitchHz, volumePct]);

  // ---- CANCEL --------------------------------------------------------------
  // IPC runs reject via the main process's cancel error; web runs reject
  // with AbortError — both reset + toast in generate()'s catch/finally.
  const cancelRun = useCallback(async () => {
    const runId = activeRunIdRef.current;
    if (!runId) return;
    synthAbortRef.current?.abort();
    try {
      await window.electronAPI?.ttsCancelLong?.(runId);
    } catch {
      /* the rejection path above handles the toast */
    }
  }, []);

  // ---- Result handoffs -----------------------------------------------------
  const addAsVoiceover = useCallback(() => {
    if (!result) return;
    onAddVoiceover({
      text: result.text,
      voice,
      ratePct,
      pitchHz,
      volume: 1,
      durationMs: result.durationMs,
      bytes: result.blob,
    });
  }, [result, voice, ratePct, pitchHz, onAddVoiceover]);

  const addAsMusicAudio = useCallback(() => {
    if (!result) return;
    onAddMusicAudio({
      fileName: result.fileName,
      blob: result.blob,
      durationMs: result.durationMs,
    });
    toast.info("Added to the Audio lane — drag to reposition");
  }, [result, onAddMusicAudio]);

  const createWordCaptions = useCallback(() => {
    if (!result || result.words.length < 3) return;
    onCreateWordCaptions({
      title: result.fileName,
      words: result.words.map((w) => ({
        text: w.text,
        startMs: w.offsetMs,
        endMs: w.offsetMs + w.durationMs,
      })),
    });
  }, [result, onCreateWordCaptions]);

  const exportWordSidecar = useCallback(
    (kind: "srt" | "vtt" | "json") => {
      if (!result || result.words.length === 0) return;
      const base = "framefuse-tts-words";
      if (kind === "srt") {
        downloadText(`${base}.srt`, wordsToSrt(result.words), "text/plain");
      } else if (kind === "vtt") {
        downloadText(`${base}.vtt`, wordsToVtt(result.words), "text/vtt");
      } else {
        downloadText(
          `${base}.json`,
          wordsToJson(result.words),
          "application/json",
        );
      }
    },
    [result],
  );

  // ---- Progress bar derivation --------------------------------------------
  // Determinate only for the synth phase with real char counts; the probe
  // phase (and the pre-first-event moment) runs indeterminate.
  const determinate = Boolean(
    progress && progress.phase === "synth" && progress.totalChars > 0,
  );
  const progressPct = progress
    ? Math.max(
        3,
        Math.min(
          100,
          progress.totalChars > 0
            ? (progress.charsDone / progress.totalChars) * 100
            : 0,
        ),
      )
    : 3;
  const phaseLabel = (() => {
    if (!progress) return "Synthesizing…";
    if (progress.phase === "probe") return "Measuring duration…";
    if (progress.phase === "done") return "Finishing…";
    if (progress.chunkCount > 0) {
      return `Synthesizing chunk ${Math.min(progress.chunkIndex + 1, progress.chunkCount)} of ${progress.chunkCount}…`;
    }
    return "Synthesizing…";
  })();

  const selectCls =
    "w-full rounded border bg-[#211e1a] px-2 py-1.5 text-[11px] text-stone-300 focus:border-teal-500 focus:outline-none";
  const actionBtnCls =
    "flex items-center justify-center gap-1.5 rounded border px-2 py-1.5 text-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40";

  const generateDisabled = running || !text.trim() || !voice || overLimit;

  // ---- Render --------------------------------------------------------------
  return (
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
        <ChevronDown
          size={14}
          className={cn(
            "shrink-0 text-stone-500 transition-transform duration-200",
            open ? "rotate-0" : "-rotate-90",
          )}
        />
        <AudioLines size={14} className="shrink-0 text-orange-400" />
        <span className="flex-1 text-xs font-semibold uppercase tracking-wide text-stone-300">
          AI Text-to-Speech Studio
        </span>
        <span className="hidden shrink-0 text-[10px] text-stone-500 sm:inline">
          up to 200,000 words
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1">
          {/* ── 1. Script ─────────────────────────────────────────────── */}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste or write the full narration — up to 200,000 words are synthesized into one audio file…"
            className="mb-1.5 min-h-[180px] w-full resize-y rounded border px-2 py-1.5 font-mono text-[11px] leading-relaxed text-stone-300 placeholder:text-stone-500 focus:border-teal-500 focus:outline-none"
            style={{ borderColor: "#332e28", backgroundColor: "#1a1815" }}
            aria-label="Narration script"
          />
          <div className="mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <span
              className={cn(
                "rounded-full border px-2 py-[2px] text-[10px] font-medium tabular-nums",
                overLimit
                  ? "border-rose-500/50 bg-[#2b1315] text-rose-400"
                  : "border-[#332e28] text-stone-400",
              )}
            >
              {wordCount.toLocaleString()} words ·{" "}
              {charCount.toLocaleString()} chars
            </span>
          </div>
          {overLimit && (
            <p className="mb-2 flex items-center gap-1 text-[10px] leading-relaxed text-rose-400">
              <AlertTriangle size={10} className="shrink-0" />
              Script exceeds the 200,000-word / 1,500,000-character limit —
              trim it to generate.
            </p>
          )}

          {/* ── 2. QWERTY (romanized) input — hi / ur locales only ──── */}
          {showQwerty && (
            <div className="mb-2">
              <StudioToggle
                checked={qwerty}
                onChange={setQwerty}
                label="QWERTY input — auto-converts to native script"
              />
              {qwerty && qw.nativeDetected && (
                <p className="mt-1 flex items-center gap-1 text-[10px] leading-relaxed text-amber-400/90">
                  <AlertTriangle size={10} className="shrink-0" />
                  Native script detected — converting is skipped
                </p>
              )}
              {qwerty && qw.willConvert && (
                <div
                  className="mt-1 overflow-hidden rounded border"
                  style={{
                    borderColor: "rgba(45,212,191,0.25)",
                    backgroundColor: "#10201d",
                  }}
                  title={convertedText}
                >
                  <p className="px-2 pt-1 text-[9px] font-semibold uppercase tracking-wide text-teal-500/80">
                    Native script preview
                  </p>
                  <p className="max-h-16 overflow-hidden px-2 pb-1.5 text-[11px] leading-relaxed text-stone-300">
                    {convertedText.slice(0, PREVIEW_MAX_CHARS)}
                    {convertedText.length > PREVIEW_MAX_CHARS
                      ? ` +${(convertedText.length - PREVIEW_MAX_CHARS).toLocaleString()} more`
                      : ""}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ── 3. Language + voice picker ─────────────────────────── */}
          <div className="mb-1.5 flex items-center gap-1.5">
            <div className="relative min-w-0 flex-1">
              <Search
                size={11}
                className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-stone-500"
              />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search voices — name, locale…"
                className="w-full rounded border bg-[#211e1a] py-1.5 pl-7 pr-2 text-[11px] text-stone-300 placeholder:text-stone-500 focus:border-teal-500 focus:outline-none"
                style={{ borderColor: "#332e28" }}
                aria-label="Search voices"
              />
            </div>
            <VoiceGenderChips value={gender} onChange={changeGender} />
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
                aria-label="Speech language and locale"
              >
                {languageGroups.map((g) => (
                  <optgroup key={g.code || "all"} label={g.name}>
                    {g.locales.map((l) => (
                      <option key={l} value={l}>
                        {g.code ? localeLabel(l) : l}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-0.5 block text-[10px] font-medium text-stone-500">
                Voice ({filteredVoices.length > 0 ? `${filteredVoices.length} in ${locale}` : "—"})
              </label>
              <div className="flex items-center gap-1">
                <select
                  value={voice}
                  onChange={(e) => setVoice(e.target.value)}
                  className={cn(selectCls, "min-w-0 flex-1")}
                  style={{ borderColor: "#332e28" }}
                  aria-label="Synthesis voice"
                >
                  {filteredVoices.length === 0 && (
                    <option value={voice}>{voice || "— loading voices —"}</option>
                  )}
                  {filteredVoices.map((v) => (
                    <option key={v.shortName} value={v.shortName}>
                      {v.displayName} ({v.shortName})
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void playPreview()}
                  disabled={previewBusy || !voice}
                  title="Listen to this voice (first 300 characters of your script)"
                  className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded border text-teal-400 transition-colors hover:bg-teal-500/10 disabled:cursor-not-allowed disabled:opacity-40"
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

          {/* ── 4. Prosody ───────────────────────────────────────────── */}
          <div className="mb-2 grid grid-cols-3 gap-1.5">
            <StudioField
              label="Speed"
              hint={ratePct === 0 ? "normal" : `${ratePct > 0 ? "+" : ""}${ratePct}%`}
            >
              <input
                type="range"
                min={-95}
                max={100}
                step={5}
                value={ratePct}
                onChange={(e) => setRatePct(Number(e.target.value))}
                className="w-full accent-teal-500"
                aria-label="Speech speed"
              />
            </StudioField>
            <StudioField
              label="Pitch"
              hint={`${pitchHz > 0 ? "+" : ""}${pitchHz}Hz`}
            >
              <input
                type="range"
                min={-100}
                max={100}
                step={5}
                value={pitchHz}
                onChange={(e) => setPitchHz(Number(e.target.value))}
                className="w-full accent-teal-500"
                aria-label="Pitch"
              />
            </StudioField>
            <StudioField label="Output volume" hint={`${volumePct}%`}>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={volumePct}
                onChange={(e) => setVolumePct(Number(e.target.value))}
                className="w-full accent-teal-500"
                aria-label="Output volume"
              />
            </StudioField>
          </div>

          {/* ── 5. Voice presets (v1.26) ──────────────────────────── */}
          <div
            className="mb-2 rounded border p-2"
            style={{ borderColor: "#332e28", backgroundColor: "#1a1815" }}
          >
            <div className="mb-1.5 flex items-center gap-1.5">
              <Star size={10} className="shrink-0 text-teal-400" />
              <span className="text-[10px] font-semibold uppercase tracking-wide text-stone-400">
                Voice presets
              </span>
              <span className="text-[9px] text-stone-600">styles apply speed · pitch · volume</span>
            </div>
            <div className="mb-1.5 flex flex-wrap gap-1" role="group" aria-label="Built-in voice style presets">
              {BUILT_IN_PRESETS.map((p) => {
                const active = activeBuiltIn?.id === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => applyBuiltIn(p)}
                    title={p.hint}
                    aria-pressed={active}
                    className={cn(
                      "rounded-full border px-2 py-[3px] text-[10px] font-medium transition-colors",
                      active
                        ? "border-teal-500/60 bg-[#10201d] text-teal-300"
                        : "border-[#332e28] text-stone-400 hover:bg-white/[0.04] hover:text-stone-200",
                    )}
                  >
                    {p.name}
                  </button>
                );
              })}
            </div>

            {/* User-saved presets (voice + language + prosody). */}
            {userPresets.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1" role="group" aria-label="Saved voice presets">
                {userPresets.map((p) => {
                  const active = p.voice === voice && p.ratePct === ratePct && p.pitchHz === pitchHz;
                  return (
                    <span
                      key={p.id}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full border px-2 py-[3px] text-[10px] font-medium transition-colors",
                        active
                          ? "border-orange-500/60 bg-orange-500/15 text-orange-300"
                          : "border-[#3a2d20] bg-[#241c12] text-amber-200/90 hover:bg-[#2e2315]",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => applyUserPreset(p)}
                        title={`${p.voice} · ${p.locale} · speed ${p.ratePct > 0 ? "+" : ""}${p.ratePct}% · pitch ${p.pitchHz > 0 ? "+" : ""}${p.pitchHz}Hz`}
                        className="cursor-pointer"
                      >
                        {p.name}
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteUserPreset(p.id)}
                        title="Delete this preset"
                        aria-label={`Delete preset ${p.name}`}
                        className="cursor-pointer text-stone-500 transition-colors hover:text-rose-400"
                      >
                        <Trash2 size={9} />
                      </button>
                    </span>
                  );
                })}
              </div>
            )}

            {/* Save the current config as a preset. */}
            <div className="flex items-center gap-1">
              <input
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                placeholder="Preset name — e.g. Hindi narrator"
                maxLength={40}
                className="min-w-0 flex-1 rounded border bg-[#211e1a] px-2 py-1 text-[10px] text-stone-300 placeholder:text-stone-500 focus:border-teal-500 focus:outline-none"
                style={{ borderColor: "#332e28" }}
                aria-label="New preset name"
              />
              <button
                type="button"
                onClick={savePreset}
                disabled={!presetName.trim() || !voice}
                title="Save the current voice, language and prosody as a reusable preset"
                className="flex shrink-0 items-center gap-1 rounded border border-teal-500/40 bg-teal-500/10 px-2 py-1 text-[10px] font-semibold text-teal-300 transition-colors hover:bg-teal-500/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Plus size={10} /> Save preset
              </button>
            </div>
          </div>

          {/* ── 6. Generate + live progress ──────────────────────────── */}
          <button
            type="button"
            onClick={() => void generate()}
            disabled={generateDisabled}
            title="Synthesize the full script into one audio file (works in the web preview and the desktop app)"
            className="flex w-full items-center justify-center gap-1.5 rounded bg-orange-500 px-2.5 py-1.5 text-[11px] font-semibold text-white transition-colors hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {running ? (
              <>
                <Loader2 size={11} className="animate-spin" /> Synthesizing…
              </>
            ) : (
              <>
                <AudioLines size={11} /> Generate audio
              </>
            )}
          </button>

          {running && (
            <div
              className="mt-2 rounded border p-2"
              style={{ borderColor: "#332e28", backgroundColor: "#1a1815" }}
              role="status"
              aria-live="polite"
            >
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1 text-[10px] text-stone-300">
                  <Loader2 size={10} className="shrink-0 animate-spin" />
                  <span className="truncate">{phaseLabel}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className="tabular-nums text-[10px] text-stone-500">
                    {fmtElapsed(elapsedMs)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void cancelRun()}
                    className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] text-rose-400 transition-colors hover:bg-rose-500/10"
                    style={{ borderColor: "#4a2430" }}
                    aria-label="Cancel synthesis"
                  >
                    <Square size={9} /> Cancel
                  </button>
                </span>
              </div>
              <div
                className="h-1 w-full overflow-hidden rounded-full"
                style={{ backgroundColor: "#332e28" }}
                role="progressbar"
                aria-valuenow={Math.round(progressPct)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                {determinate ? (
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-teal-400 to-teal-600 transition-all"
                    style={{ width: `${progressPct}%` }}
                  />
                ) : (
                  <div className="h-full w-1/3 animate-pulse rounded-full bg-teal-500/70" />
                )}
              </div>
              {determinate && progress && progress.totalChars > 0 && (
                <p className="mt-1 text-[10px] tabular-nums text-stone-500">
                  {progress.charsDone.toLocaleString()} /{" "}
                  {progress.totalChars.toLocaleString()} characters
                </p>
              )}
            </div>
          )}

          {/* ── 6. Result ────────────────────────────────────────────── */}
          {!result && !running && (
            <div
              className="mt-2 rounded border border-dashed px-2 py-3 text-center"
              style={{ borderColor: "#332e28" }}
            >
              <p className="text-[10px] leading-relaxed text-stone-500">
                No audio yet — write a script, pick a voice and press
                &ldquo;Generate audio&rdquo;. Playback, word timings and
                timeline handoffs appear here.
              </p>
            </div>
          )}

          {result && !running && (
            <div
              className="mt-2 overflow-hidden rounded border"
              style={{
                borderColor: "rgba(45,212,191,0.35)",
                backgroundColor: "#10201d",
              }}
            >
              <div className="flex items-center gap-1.5 border-b px-2 py-1.5" style={{ borderColor: "rgba(45,212,191,0.25)" }}>
                <AudioLines size={11} className="shrink-0 text-teal-400" />
                <span className="truncate text-[10px] font-semibold uppercase tracking-wide text-teal-300">
                  Result
                </span>
                <span className="ml-auto shrink-0 truncate text-[10px] text-stone-500">
                  {result.fileName}
                </span>
              </div>
              <div className="p-2">
                { }
                <audio
                  controls
                  src={result.url}
                  preload="metadata"
                  className="mb-2 h-8 w-full"
                />
                <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-stone-400">
                  <span className="flex items-center gap-1 tabular-nums">
                    <Clock size={10} /> {fmtTimecode(result.durationMs)}
                  </span>
                  <span className="tabular-nums">
                    {fmtMB(result.bytesLen)}
                  </span>
                  <span className="tabular-nums">
                    {result.words.length.toLocaleString()} words
                  </span>
                  <span className="tabular-nums">
                    {result.chunkCount} chunk{result.chunkCount === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <a
                    href={result.url}
                    download={`framefuse-tts-${ttsFileStamp()}.mp3`}
                    className={cn(
                      actionBtnCls,
                      "border-teal-500/50 bg-teal-500/15 text-teal-200 hover:bg-teal-500/25",
                    )}
                    title="Download the merged MP3"
                  >
                    <Download size={10} /> Save audio file
                  </a>
                  <button
                    type="button"
                    onClick={addAsVoiceover}
                    disabled={result.durationMs > VO_LANE_MAX_MS}
                    title={
                      result.durationMs > VO_LANE_MAX_MS
                        ? "Too long for the VO lane — use 'Add as audio track'"
                        : "Place the narration at the playhead on the VO lane"
                    }
                    className={cn(
                      actionBtnCls,
                      "border-[#332e28] text-stone-300 hover:bg-white/[0.04]",
                    )}
                  >
                    <Mic size={10} /> Add as narration on VO lane
                  </button>
                  <button
                    type="button"
                    onClick={addAsMusicAudio}
                    className={cn(
                      actionBtnCls,
                      "border-[#332e28] text-stone-300 hover:bg-white/[0.04]",
                    )}
                    title="Add to the Audio lane as a music clip (any length)"
                  >
                    <Music size={10} /> Add as audio track
                  </button>
                  <button
                    type="button"
                    onClick={createWordCaptions}
                    disabled={result.words.length < 3}
                    title={
                      result.words.length < 3
                        ? "Needs at least 3 word timings"
                        : "Build karaoke-ready captions from the word timings"
                    }
                    className={cn(
                      actionBtnCls,
                      "border-[#332e28] text-stone-300 hover:bg-white/[0.04]",
                    )}
                  >
                    <Captions size={10} /> Create word-level captions
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── 7. Word timing table ─────────────────────────────────── */}
          {result && !running && result.words.length > 0 && (
            <div
              className="mt-2 rounded border"
              style={{ borderColor: "#332e28" }}
            >
              {/* Header row: the collapsible toggle + the export buttons as
                  SIBLINGS (nested <button> is invalid HTML and trips
                  hydration warnings). */}
              <div className="flex w-full items-center gap-1.5 px-2 py-1.5">
                <button
                  type="button"
                  onClick={() => setWordsOpen((o) => !o)}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded text-left transition-colors hover:bg-white/[0.04]"
                  aria-expanded={wordsOpen}
                  aria-label="Toggle word timing table"
                >
                  <ChevronDown
                    size={11}
                    className={cn(
                      "shrink-0 text-stone-500 transition-transform",
                      wordsOpen ? "rotate-0" : "-rotate-90",
                    )}
                  />
                  <span className="min-w-0 truncate text-[10px] font-semibold uppercase tracking-wide text-stone-400">
                    Word timing — {result.words.length.toLocaleString()} words
                  </span>
                </button>
                <span className="flex shrink-0 items-center gap-1">
                  {(["srt", "vtt", "json"] as const).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        exportWordSidecar(kind);
                      }}
                      className="rounded border border-[#332e28] px-1.5 py-0.5 text-[9px] font-semibold uppercase text-stone-500 transition-colors hover:bg-white/[0.04] hover:text-teal-300"
                      title={`Export the full word list as ${kind.toUpperCase()}`}
                    >
                      {kind}
                    </button>
                  ))}
                </span>
              </div>
              {wordsOpen && (
                <div
                  className="max-h-64 overflow-y-auto border-t"
                  style={{ borderColor: "#332e28" }}
                >
                  <table className="w-full text-left text-[10px]">
                    <thead className="sticky top-0 bg-[#211e1a] text-stone-500">
                      <tr>
                        <th className="px-2 py-1 font-medium">#</th>
                        <th className="px-2 py-1 font-medium">Word</th>
                        <th className="px-2 py-1 text-right font-medium">
                          Start
                        </th>
                        <th className="px-2 py-1 text-right font-medium">
                          Dur
                        </th>
                      </tr>
                    </thead>
                    <tbody className="text-stone-300">
                      {result.words.slice(0, 100).map((w, i) => (
                        <tr
                          key={i}
                          className="border-t"
                          style={{ borderColor: "#2b2723" }}
                        >
                          <td className="px-2 py-1 tabular-nums text-stone-500">
                            {i + 1}
                          </td>
                          <td className="max-w-[180px] truncate px-2 py-1">
                            {w.text}
                          </td>
                          <td className="px-2 py-1 text-right tabular-nums">
                            {fmtMsTimecode(w.offsetMs)}
                          </td>
                          <td className="px-2 py-1 text-right tabular-nums">
                            {w.durationMs} ms
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {result.words.length > 100 && (
                    <p
                      className="border-t px-2 py-1 text-[10px] text-stone-500"
                      style={{ borderColor: "#2b2723" }}
                    >
                      First 100 of {result.words.length.toLocaleString()}{" "}
                      words — export SRT / VTT / JSON for the full set.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── 8. Footer ───────────────────────────────────────────── */}
          <p className="mb-1 mt-1 text-[10px] leading-relaxed text-stone-500">
            {voCount > 0 && `${voCount} clip${voCount === 1 ? "" : "s"} on the VO lane · `}
            One run at a time — progress, cancel and the draft (text, voice,
            prosody) persist locally.
          </p>
        </div>
      )}
    </div>
  );
}
