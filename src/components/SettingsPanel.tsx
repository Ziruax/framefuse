"use client";

import { useState } from "react";
import {
  ChevronDown,
  Zap,
  Film,
  Captions,
  AudioLines,
  ArrowLeftRight,
  BadgeCheck,
  Bug,
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
} from "lucide-react";
import type {
  AudioSettings,
  CaptionSettings,
  HeadlineItem,
  KenBurnsConfig,
  SubtitleFile,
  TransitionSettings,
  TransitionStyle,
  VideoSettings,
  WatermarkPosition,
  WatermarkSettings,
} from "@/lib/merger/types";
import { TRANSITION_STYLE_INFO, QUALITY_PROFILES } from "@/lib/merger/types";
import type { KenBurnsDirection } from "@/lib/merger/types";
import {
  FONT_OPTIONS,
  presetsByCategory,
  getCaptionPreset,
  PRESET_CATEGORIES,
  type CaptionPreset,
} from "@/lib/merger/captionPresets";
import { HEADLINE_PRESETS, getHeadlinePreset } from "@/lib/merger/headlinePresets";
import { ANIMATION_LABELS } from "@/lib/merger/captionAnimations";
import type { WhisperProgress } from "@/lib/merger/whisper";
import { cn } from "@/lib/utils";

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
const KB_EFFECTS: { value: KenBurnsDirection; label: string; glyph: string }[] = [
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
  onGenerateCaptions: () => void;
  whisperBusy: boolean;
  whisperProgress: WhisperProgress | null;
  whisperLanguage: string;
  onWhisperLanguageChange: (lang: string) => void;
  /** Headline overlay items (v4.2). */
  headlineItems: HeadlineItem[];
  onAddHeadline: () => void;
  onUpdateHeadline: (id: string, patch: Partial<HeadlineItem>) => void;
  onRemoveHeadline: (id: string) => void;
  /** Master timeline duration (for headline default windows). */
  totalMs: number;
  debug: {
    imageCount: number;
    mode: string | null;
    totalMs: number;
    currentMs: number;
    activeSegment: string | null;
    inElectron: boolean;
  };
}

// ---------------------------------------------------------------------------
// Section / Field / Segmented / Row helpers
// ---------------------------------------------------------------------------
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
    <div className="border-b" style={{ borderColor: "#27272a" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-none px-4 py-3 text-left transition-colors hover:bg-white/5"
        aria-expanded={open}
      >
        {/* v4.8: one rotating chevron (was a two-icon swap) — the motion
            itself now communicates expanded/collapsed state. */}
        <ChevronDown
          size={14}
          className={cn(
            "shrink-0 text-zinc-500 transition-transform duration-200",
            open ? "rotate-0" : "-rotate-90",
          )}
        />
        <span className="shrink-0 text-zinc-400">{icon}</span>
        <span className="flex-1 text-xs font-semibold uppercase tracking-wider text-zinc-300">
          {title}
        </span>
      </button>
      {open && <div className="px-4 pb-4 pt-1">{children}</div>}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="mb-1.5 flex items-baseline justify-between">
        <label className="text-xs font-medium text-zinc-300">{label}</label>
      </div>
      {children}
      {hint && <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">{hint}</p>}
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
        backgroundColor: "#18181b",
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
                ? "bg-zinc-200 font-semibold text-zinc-900"
                : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <span className="text-xs text-zinc-300">{label}</span>
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
            ? "border-violet-400/60 bg-violet-500 shadow-[0_0_10px_rgba(139,92,246,0.4)]"
            : "border-zinc-600 bg-zinc-800 hover:bg-zinc-700",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200",
            checked ? "translate-x-4" : "translate-x-0.5",
          )}
        />
      </button>
      <span className="text-xs leading-tight text-zinc-300">{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------
export function SettingsPanel(props: SettingsPanelProps) {
  const {
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
    onGenerateCaptions,
    whisperBusy,
    whisperProgress,
    whisperLanguage,
    onWhisperLanguageChange,
    headlineItems,
    onAddHeadline,
    onUpdateHeadline,
    onRemoveHeadline,
    totalMs,
    debug,
  } = props;

  const zoomMax = 1.06 + (kenBurns.intensity / 100) * 0.18;

  // Ken Burns pool toggle: clicking a chip toggles it in the pool while
  // staying in "random" mode (2+ selected = random among those). A single
  // selected chip becomes the fixed direction.
  const ALL_EFFECTS: KenBurnsDirection[] = ["in", "out", "left", "right", "up", "down"];
  const togglePoolEffect = (dir: KenBurnsDirection) => {
    const current = kenBurns.directionPool.length ? kenBurns.directionPool : ALL_EFFECTS;
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
      onKenBurnsChange({ ...kenBurns, direction: next[0], directionPool: next });
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
    const pool = kenBurns.directionPool.length ? kenBurns.directionPool : ALL_EFFECTS;
    return pool.includes(dir);
  };

  const isRandomMode =
    kenBurns.direction === "random" ||
    (kenBurns.directionPool.length > 1 &&
      kenBurns.directionPool.includes(kenBurns.direction));

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: "#27272a" }}>
        <Wand2 size={14} className="text-zinc-500" />
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
          Settings
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* ─── Ken Burns ─────────────────────────────────────────────── */}
        <Section icon={<Zap size={13} />} title="Ken Burns Motion" defaultOpen>
          <div className="mb-3">
            <Toggle
              checked={kenBurns.enabled}
              onChange={(v) => onKenBurnsChange({ ...kenBurns, enabled: v })}
              label="Enable motion"
            />
          </div>

          <Field label="Zoom intensity" hint={`Max zoom ${zoomMax.toFixed(2)}×`}>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={kenBurns.intensity}
              onChange={(e) =>
                onKenBurnsChange({ ...kenBurns, intensity: Number(e.target.value) })
              }
              disabled={!kenBurns.enabled}
              className="w-full accent-emerald-500"
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
                        ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/35"
                        : "bg-zinc-800/60 text-zinc-400 hover:bg-white/5 hover:-translate-y-px",
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
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  : "border-zinc-700 bg-transparent text-zinc-400 hover:border-zinc-600 hover:bg-white/5 hover:text-zinc-200",
              )}
              title="Randomize across all six effects"
            >
              <Dices className="size-3.5" />
              Random — all effects
            </button>
            <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">
              Select 2+ effects to randomize between only your favorites, or pick one to fix it.
            </p>
          </Field>
        </Section>

        {/* ─── Video ─────────────────────────────────────────────────── */}
        <Section icon={<Film size={13} />} title="Video">
          {/* v4.5: one-click encode-quality profiles. */}
          <Field label="Quality profile" hint="Resolution + fps + encoder tuning bundles">
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
                      active ? "ff-profile-active" : "hover:-translate-y-px hover:brightness-110",
                    )}
                    style={
                      active
                        ? undefined
                        : { borderColor: "#27272a", backgroundColor: "#141416" }
                    }
                  >
                    <span className="text-[11px] font-bold" style={{ color: active ? "#a7f3d0" : "#d4d4d8" }}>
                      {p.label}
                    </span>
                    <span className="text-[8px] tabular-nums" style={{ color: "#71717a" }}>
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
                                  ? "#34d399"
                                  : "#3f3f46"
                                : "#1f1f22",
                          }}
                        />
                      ))}
                      <span className="ml-1 text-[7px] uppercase tracking-wide" style={{ color: "#52525b" }}>
                        {p.speed === 3 ? "fast" : p.speed === 2 ? "balanced" : "slow"}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            {settings.quality === "custom" ? (
              <p className="mt-1.5 flex items-center gap-1 text-[9px]" style={{ color: "#fbbf24" }}>
                <Wand2 className="size-2.5" /> Custom — fields below tuned manually
              </p>
            ) : (
              <p className="mt-1.5 text-[9px] leading-relaxed" style={{ color: "#52525b" }}>
                {QUALITY_PROFILES.find((p) => p.id === settings.quality)?.hint ??
                  "Pick a profile, then fine-tune below (switches to Custom)."}
              </p>
            )}
          </Field>
          <Field label="Aspect ratio" hint="16:9 YouTube · 9:16 Shorts/Reels/TikTok · 1:1 square · 4:5 Instagram feed">
            <Segmented
              options={[
                { value: "16:9", label: "16:9" },
                { value: "9:16", label: "9:16" },
                { value: "1:1", label: "1:1" },
                { value: "4:5", label: "4:5" },
              ]}
              value={settings.aspect}
              onChange={(v) => onSettingsChange({ ...settings, aspect: v })}
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
              className="w-full accent-emerald-500"
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
              className="w-full accent-emerald-500"
              aria-label="Constant quality factor"
            />
            <p className="mt-0.5 text-[9px]" style={{ color: "#52525b" }}>
              Lower = better quality + larger files. 18–22 is the sweet spot for social uploads.
            </p>
          </Field>
        </Section>

        {/* ─── Transitions (v4.3) ─────────────────────────────────── */}
        <Section icon={<ArrowLeftRight size={13} />} title="Transitions" defaultOpen>
          <TransitionSection
            transition={transition}
            onTransitionChange={onTransitionChange}
          />
        </Section>

        {/* ─── Watermark (v4.4) ─────────────────────────────────── */}
        <Section icon={<BadgeCheck size={13} />} title="Watermark" defaultOpen>
          <WatermarkSection
            image={watermarkImage}
            settings={watermarkSettings}
            onFile={onWatermarkFile}
            onSettingsChange={onWatermarkSettingsChange}
            openPicker={openWatermarkPicker}
          />
        </Section>

        <Section icon={<AudioLines size={13} />} title="Audio">
          <Row label="Normalize loudness">
            <Toggle
              checked={audioSettings.normalize}
              onChange={(v) => onAudioSettingsChange({ ...audioSettings, normalize: v })}
              label=""
            />
          </Row>
          <p className="mb-3 mt-[-8px] text-[10px] leading-relaxed text-zinc-500">
            Master to −16 LUFS (social-media standard) — evens out quiet/loud recordings.
          </p>
          <Field label="Fade in" hint={audioSettings.fadeInMs ? `${(audioSettings.fadeInMs / 1000).toFixed(1)}s` : "off"}>
            <input
              type="range"
              min={0}
              max={3000}
              step={100}
              value={audioSettings.fadeInMs}
              onChange={(e) =>
                onAudioSettingsChange({ ...audioSettings, fadeInMs: Number(e.target.value) })
              }
              className="w-full accent-emerald-500"
              aria-label="Audio fade in"
            />
          </Field>
          <Field label="Fade out" hint={audioSettings.fadeOutMs ? `${(audioSettings.fadeOutMs / 1000).toFixed(1)}s` : "off"}>
            <input
              type="range"
              min={0}
              max={3000}
              step={100}
              value={audioSettings.fadeOutMs}
              onChange={(e) =>
                onAudioSettingsChange({ ...audioSettings, fadeOutMs: Number(e.target.value) })
              }
              className="w-full accent-emerald-500"
              aria-label="Audio fade out"
            />
          </Field>
        </Section>

        {/* ─── Title overlay (v4.2) ────────────────────────────────── */}
        <HeadlineSection
          items={headlineItems}
          onAdd={onAddHeadline}
          onUpdate={onUpdateHeadline}
          onRemove={onRemoveHeadline}
          totalMs={totalMs}
        />

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
        />

        {/* ─── Debug ─────────────────────────────────────────────────── */}
        <Section icon={<Bug size={13} />} title="Debug">
          <div className="space-y-1 font-mono text-[10px] text-zinc-500">
            <div>images: {debug.imageCount}</div>
            <div>mode: {String(debug.mode)}</div>
            <div>total: {(debug.totalMs / 1000).toFixed(1)}s</div>
            <div>playhead: {(debug.currentMs / 1000).toFixed(1)}s</div>
            <div>active: {debug.activeSegment ?? "—"}</div>
            <div>env: {debug.inElectron ? "electron" : "browser"}</div>
          </div>
        </Section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Headline overlay section (v4.2) — viral hook titles
// ---------------------------------------------------------------------------
interface HeadlineSectionProps {
  items: HeadlineItem[];
  onAdd: () => void;
  onUpdate: (id: string, patch: Partial<HeadlineItem>) => void;
  onRemove: (id: string) => void;
  totalMs: number;
}

const HEADLINE_ANIMATIONS: {
  value: HeadlineItem["animation"];
  label: string;
  title: string;
}[] = [
  { value: "none", label: "None", title: "Static — no entrance" },
  { value: "fade", label: "Fade", title: "Fade in / out (300ms)" },
  { value: "slide-up", label: "Slide", title: "Slide up from below (280ms)" },
  { value: "pop", label: "Pop", title: "Pop 0.6 → 1 with overshoot (260ms)" },
  { value: "zoom-punch", label: "Punch", title: "Zoom 2.0 → 1 fast (200ms)" },
];

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
];

function TransitionSection({
  transition,
  onTransitionChange,
}: {
  transition: TransitionSettings;
  onTransitionChange: (t: TransitionSettings) => void;
}) {
  const info = TRANSITION_STYLE_INFO[transition.style];
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
                  active
                    ? "ff-tx-tile-active"
                    : "hover:bg-white/5",
                )}
              >
                <div className="ff-tx-stage">
                  <div className="ff-tx-rect ff-tx-a" />
                  <div className={cn("ff-tx-rect ff-tx-b", `ff-anim-${style}`)} />
                  {isDip && (
                    <div
                      className={cn(
                        "ff-tx-veil",
                        style === "dip-white" ? "ff-tx-veil-white" : "ff-tx-veil-black",
                        `ff-anim-veil-${style}`,
                      )}
                    />
                  )}
                </div>
                <span
                  className={cn(
                    "text-[9px] font-medium leading-none",
                    active ? "text-fuchsia-300" : "text-zinc-400",
                  )}
                >
                  {si.label}
                </span>
              </button>
            );
          })}
        </div>
      </Field>

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
              onTransitionChange({ ...transition, durationMs: Number(e.target.value) })
            }
            className="w-full accent-fuchsia-500"
            aria-label="Transition duration"
          />
        </Field>
      )}

      <Row label="Fade video in / out">
        <Toggle
          checked={transition.fadeStartEnd}
          onChange={(v) => onTransitionChange({ ...transition, fadeStartEnd: v })}
          label=""
        />
      </Row>
      <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">
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
  "top-left", "top", "top-right",
  "left", "center", "right",
  "bottom-left", "bottom", "bottom-right",
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
          <div className="flex items-center gap-2.5 rounded-lg border p-2" style={{ borderColor: "#27272a", backgroundColor: "#18181b" }}>
            <div
              className="flex size-10 shrink-0 items-center justify-center rounded-lg"
              style={{
                backgroundColor: "#0a0a0a",
                boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.06)",
              }}
            >
              <img src={image.url} alt="watermark" className="max-h-8 max-w-8 object-contain" draggable={false} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] font-medium text-zinc-200" title={image.fileName}>
                {image.fileName}
              </div>
              <div className="text-[9px] text-zinc-500">branded on every frame</div>
            </div>
            <button
              type="button"
              onClick={() => onFile(null)}
              className="shrink-0 rounded p-1 transition-colors hover:bg-red-500/15 hover:text-red-400"
              style={{ color: "#71717a" }}
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
            style={{ borderColor: "#3f3f46", color: "#a1a1aa" }}
          >
            <Upload className="size-3.5" />
            Upload logo / watermark
          </button>
        )}
      </Field>

      {image && (
        <>
          <Field label="Position">
            <div className="grid w-max grid-cols-3 gap-1" role="radiogroup" aria-label="Watermark position">
              {WM_POSITIONS.map((pos) => {
                const active = settings.position === pos;
                const row = pos.startsWith("top") ? 0 : pos.startsWith("bottom") ? 2 : 1;
                const col = pos.endsWith("left") ? 0 : pos.endsWith("right") ? 2 : 1;
                return (
                  <button
                    key={pos}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    title={pos}
                    onClick={() => onSettingsChange({ ...settings, position: pos })}
                    className={cn(
                      "ff-wm-cell group flex size-7 items-center justify-center rounded transition-all active:scale-90",
                      active ? "ff-wm-cell-active" : "hover:bg-white/5",
                    )}
                  >
                    <span
                      className={cn(
                        "size-1.5 rounded-sm transition-all",
                        active ? "ff-wm-dot-active" : "bg-zinc-600 group-hover:bg-zinc-400",
                      )}
                      style={
                        !active
                          ? { transform: `translate(${(col - 1) * 5}px, ${(row - 1) * 5}px)` }
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
              onChange={(e) => onSettingsChange({ ...settings, sizePercent: Number(e.target.value) })}
              className="w-full accent-emerald-500"
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
              onChange={(e) => onSettingsChange({ ...settings, opacity: Number(e.target.value) })}
              className="w-full accent-emerald-500"
              aria-label="Watermark opacity"
            />
          </Field>

          <Field label={`Margin — ${settings.marginPercent}%`} hint="Distance from the edges (scales with the video width).">
            <input
              type="range"
              min={0}
              max={10}
              step={1}
              value={settings.marginPercent}
              onChange={(e) => onSettingsChange({ ...settings, marginPercent: Number(e.target.value) })}
              className="w-full accent-emerald-500"
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
  const clampMs = (v: number) => Math.max(0, Math.min(v, Math.max(totalMs, 60000)));

  return (
    // `key` remounts the section when items appear/disappear so the
    // auto-open (items present → expanded) also applies to headlines
    // restored from localStorage/project files AFTER the first mount.
    <Section
      key={items.length > 0 ? "hl-with-items" : "hl-empty"}
      icon={<Type size={13} />}
      title="Title Overlay"
      defaultOpen={items.length > 0}
    >
      <p className="mb-3 text-[10px] leading-relaxed text-zinc-500">
        Big hook titles independent of captions — perfect for the first 3
        seconds. Burned into the export exactly like the preview.
      </p>

      {/* Status line */}
      <div className="mb-3 flex items-center gap-1.5 text-[10px] text-zinc-500">
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
          return (
            <div
              key={item.id}
              className="rounded-lg border p-2.5 transition-colors"
              style={{
                borderColor: invalid ? "rgba(185, 28, 28, 0.5)" : "#27272a",
                backgroundColor: "#18181b",
              }}
            >
              {/* Header row: index + preset name + remove */}
              <div className="mb-2 flex items-center gap-2">
                <span
                  className="rounded px-1.5 py-0.5 text-[9px] font-bold tabular-nums"
                  style={{ backgroundColor: "rgba(251, 191, 36, 0.15)", color: "#fbbf24" }}
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
                    fontStyle: preset.fontStyle === "italic" ? "italic" : "normal",
                    letterSpacing: Math.min(1.5, preset.letterSpacing / 2),
                    textTransform: preset.textTransform === "uppercase" ? "uppercase" : "none",
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
                <span className="flex-1 truncate text-[10px] text-zinc-400">
                  {preset.name}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(item.id)}
                  className="rounded p-1 text-zinc-500 transition-colors hover:bg-red-500/15 hover:text-red-400"
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
                className="mb-2 w-full resize-none rounded border bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:border-violet-500"
                style={{ borderColor: "#3f3f46" }}
                aria-label={`Headline ${idx + 1} text`}
              />

              {/* Timing */}
              <div className="mb-2 flex items-center gap-1.5">
                <label className="flex items-center gap-1 text-[10px] text-zinc-500">
                  <Clock size={10} />
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={(item.startMs / 1000).toFixed(1)}
                    onChange={(e) =>
                      onUpdate(item.id, {
                        startMs: clampMs(Math.round(parseFloat(e.target.value) * 1000) || 0),
                      })
                    }
                    className="w-16 rounded border bg-zinc-900 px-1.5 py-1 text-[10px] tabular-nums text-zinc-200 focus:border-violet-500"
                    style={{ borderColor: "#3f3f46" }}
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
                        endMs: clampMs(Math.round(parseFloat(e.target.value) * 1000) || 0),
                      })
                    }
                    className="w-16 rounded border bg-zinc-900 px-1.5 py-1 text-[10px] tabular-nums text-zinc-200 focus:border-violet-500"
                    style={{ borderColor: "#3f3f46" }}
                    aria-label="End time (seconds)"
                  />
                  s
                </label>
                <span
                  className={cn(
                    "ml-auto rounded px-1.5 py-0.5 text-[9px] tabular-nums",
                    invalid ? "bg-red-500/20 text-red-300" : "bg-zinc-800 text-zinc-400",
                  )}
                >
                  {invalid ? "end ≤ start" : `${dur.toFixed(1)}s`}
                </span>
              </div>

              {/* Preset select */}
              <select
                value={item.presetId}
                onChange={(e) => onUpdate(item.id, { presetId: e.target.value })}
                className="mb-2 w-full rounded border bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-200 focus:border-violet-500"
                style={{ borderColor: "#3f3f46" }}
                aria-label={`Headline ${idx + 1} style`}
              >
                {HEADLINE_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.description}
                  </option>
                ))}
              </select>

              {/* Position + animation */}
              <Segmented
                size="sm"
                options={[
                  { value: "top", label: "Top", title: "Top of frame" },
                  { value: "center", label: "Center", title: "Middle of frame" },
                  { value: "bottom", label: "Bottom", title: "Bottom of frame" },
                ]}
                value={item.position}
                onChange={(v) => onUpdate(item.id, { position: v })}
              />
              <div className="mt-1.5">
                <Segmented
                  size="sm"
                  options={HEADLINE_ANIMATIONS.map((a) => ({
                    value: a.value,
                    label: a.label,
                    title: a.title,
                  }))}
                  value={item.animation}
                  onChange={(v) => onUpdate(item.id, { animation: v })}
                />
              </div>

              {/* Size */}
              <div className="mt-2">
                <Field label="Size" hint={`${(item.sizeScale * 100).toFixed(0)}%`}>
                  <input
                    type="range"
                    min={0.5}
                    max={2}
                    step={0.05}
                    value={item.sizeScale}
                    onChange={(e) =>
                      onUpdate(item.id, { sizeScale: Number(e.target.value) })
                    }
                    className="w-full accent-amber-500"
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
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed py-2 text-[11px] font-medium transition-all hover:border-amber-500/50 hover:bg-amber-500/5"
        style={{ borderColor: "#3f3f46", color: "#d4d4d8" }}
      >
        <Plus size={13} className="text-amber-400" /> Add title
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
  const showFavGroup =
    presetCat === "all" && !q && favoritePresets.length > 0;
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
  const matchCount = filteredCategories.reduce((n, c) => n + c.presets.length, 0);

  const preset = getCaptionPreset(captionSettings.presetId);
  const hasCues = !!subtitles && subtitles.cues.length > 0;
  const hasWords = hasCues && subtitles!.cues.some((c) => c.words && c.words.length > 0);

  return (
    <Section icon={<Captions size={13} />} title="Captions" defaultOpen>
      {/* ── Whisper generation ── */}
      <div
        className="mb-4 rounded-lg border p-3"
        style={{ borderColor: "#27272a", backgroundColor: "#18181b" }}
      >
        <div className="mb-2 flex items-center gap-1.5">
          <Sparkles size={12} className="text-amber-400" />
          <span className="text-[11px] font-semibold text-zinc-200">
            AI Captions (Whisper)
          </span>
        </div>
        <div className="mb-2 flex gap-2">
          <select
            value={whisperLanguage}
            onChange={(e) => onWhisperLanguageChange(e.target.value)}
            className="min-w-0 flex-1 rounded border bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-200"
            style={{ borderColor: "#3f3f46" }}
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
          disabled={whisperBusy || !hasAudio}
          className={cn(
            "flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-xs font-semibold transition-colors",
            whisperBusy || !hasAudio
              ? "cursor-not-allowed bg-zinc-800 text-zinc-500"
              : "bg-amber-500 text-zinc-900 hover:bg-amber-400",
          )}
        >
          {whisperBusy ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Sparkles size={13} />
          )}
          {whisperBusy ? "Working…" : "Generate from audio"}
        </button>
        {whisperProgress && (
          <div className="mt-2">
            <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full bg-amber-500 transition-all"
                style={{ width: `${whisperProgress.progress}%` }}
              />
            </div>
            <p className="mt-1 truncate text-[10px] text-zinc-500">
              {whisperProgress.status}
            </p>
          </div>
        )}
        <p className="mt-2 text-[10px] leading-relaxed text-zinc-500">
          Whisper-tiny runs locally (in-app, ~75 MB download once, then offline). Produces{" "}
          <span className="text-zinc-300">exact word-by-word timing</span> for karaoke &amp;
          kinetic captions.
        </p>
      </div>

      {/* ── Burn-in toggle + source status ── */}
      <div className="mb-3">
        <Toggle
          checked={captionSettings.enabled}
          onChange={(v) => set({ enabled: v })}
          label="Burn captions into video"
        />
      </div>
      <div className="mb-3 text-[10px] text-zinc-500">
        {subtitles ? (
          <>
            <span className="text-zinc-300">{subtitles.fileName}</span> ·{" "}
            {subtitles.cues.length} cue{subtitles.cues.length === 1 ? "" : "s"}
            {hasWords && (
              <span className="text-emerald-400"> · word timing ✓</span>
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
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-zinc-500"
            />
            <input
              value={presetQuery}
              onChange={(e) => setPresetQuery(e.target.value)}
              placeholder="Search 42 presets…"
              className="w-full rounded-md border bg-zinc-900 py-1 pl-6 pr-2 text-[10px] text-zinc-200 placeholder:text-zinc-600 focus:border-emerald-600/60"
              style={{ borderColor: "#27272a" }}
              aria-label="Search caption presets"
            />
            {presetQuery && (
              <button
                type="button"
                onClick={() => setPresetQuery("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-500 hover:text-zinc-200"
                title="Clear search"
              >
                <X size={10} />
              </button>
            )}
          </div>
          <div className="relative">
            <select
              value={presetCat}
              onChange={(e) =>
                setPresetCat(e.target.value as typeof presetCat)
              }
              className="h-full appearance-none rounded-md border bg-zinc-900 pl-2 pr-6 text-[10px] text-zinc-200"
              style={{ borderColor: "#27272a" }}
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
              className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-zinc-500"
            />
          </div>
        </div>
        {matchCount === 0 ? (
          <div
            className="rounded-md border border-dashed px-3 py-4 text-center text-[10px] text-zinc-500"
            style={{ borderColor: "#27272a" }}
          >
            No presets match “{presetQuery.trim()}”
          </div>
        ) : (
        <div className="max-h-72 overflow-y-auto rounded-md border" style={{ borderColor: "#27272a" }}>
          {[favGroup, ...filteredCategories]
            .filter((g): g is NonNullable<typeof g> => !!g)
            .map((cat) => (
            <div key={cat.category}>
              <div
                className={cn(
                  "sticky top-0 z-10 bg-[#131316] px-2 py-1 text-[9px] font-bold uppercase tracking-widest",
                  cat.category === "favorites" ? "text-amber-400/90" : "text-zinc-500",
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
                      active ? "bg-emerald-500/15" : "hover:bg-white/5",
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
                        fontStyle: p.fontStyle === "italic" ? "italic" : "normal",
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
                      <span className="block truncate text-[11px] font-medium text-zinc-200">
                        {p.name}
                        {p.animation && p.animation !== "none" && (
                          <span className="ml-1 text-[9px] text-emerald-400">✦</span>
                        )}
                      </span>
                      <span className="block truncate text-[9px] text-zinc-500">
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
                      aria-label={fav ? "Remove from favorites" : "Add to favorites"}
                      title={fav ? "Remove from favorites" : "Star this preset"}
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
                        fav ? "text-amber-400" : "text-zinc-600 hover:text-amber-400/70",
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

      {/* ── Word mode ── */}
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
            { value: "off", label: "Full text", title: "Standard subtitle block" },
            { value: "word", label: "Karaoke", title: "Highlight the spoken word" },
            { value: "word-only", label: "Single", title: "One word at a time (Hormozi)" },
            { value: "stack", label: "Stack", title: "Words stack as spoken (quote builder)" },
          ]}
          value={captionSettings.wordMode}
          onChange={(v) => set({ wordMode: v })}
        />
      </Field>

      {/* ── Animation ── */}
      <Field
        label="Kinetic animation"
        hint={
          captionSettings.animation
            ? "Pinned — preset switches keep your choice"
            : "Following preset default (pin to override)"
        }
      >
        <div className="max-h-56 overflow-y-auto rounded-md border" style={{ borderColor: "#27272a" }}>
          {[
            { id: "classic", label: "Classic" },
            { id: "viral", label: "Viral pack ✦" },
          ].map((grp) => (
            <div key={grp.id}>
              <div className="sticky top-0 z-10 bg-[#131316] px-2 py-1 text-[9px] font-bold uppercase tracking-widest text-zinc-500">
                {grp.label}
              </div>
              <div className="grid grid-cols-2 gap-1 p-1">
                {ANIMATION_LABELS.filter((a) => a.group === grp.id).map((a) => {
                  const active =
                    (captionSettings.animation || preset.animation || "none") === a.value;
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
                          ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40"
                          : "bg-zinc-800/50 text-zinc-400 hover:bg-white/5",
                      )}
                      aria-pressed={active}
                    >
                      {a.label}
                      <span className="block truncate text-[8px] font-normal text-zinc-500">
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
            className="mt-1 flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300"
          >
            <RotateCcw size={10} /> Follow preset default
          </button>
        )}
      </Field>

      {/* ── Font ── */}
      <Field label="Font" hint="Windows-safe stacks — preview matches the export.">
        <select
          value={captionSettings.fontId}
          onChange={(e) => set({ fontId: e.target.value })}
          className="w-full rounded border bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-200"
          style={{ borderColor: "#3f3f46" }}
          aria-label="Caption font"
        >
          {FONT_OPTIONS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </Field>

      {/* ── Color override ── */}
      <Field label="Text color" hint="Overrides the preset color.">
        <div className="flex items-center gap-2">
          <label className="relative inline-flex h-7 w-10 cursor-pointer items-center justify-center overflow-hidden rounded border" style={{ borderColor: "#3f3f46" }}>
            <input
              type="color"
              value={captionSettings.customColor || preset.textColor}
              onChange={(e) => set({ customColor: e.target.value })}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              aria-label="Custom caption color"
            />
            <span
              className="h-4 w-6 rounded-sm"
              style={{ backgroundColor: captionSettings.customColor || preset.textColor }}
            />
          </label>
          <span className="font-mono text-[10px] text-zinc-400">
            {captionSettings.customColor || preset.textColor}
          </span>
          {captionSettings.customColor && (
            <button
              type="button"
              onClick={() => set({ customColor: null })}
              className="ml-auto flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300"
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
                    ? "bg-zinc-200 text-zinc-900"
                    : "bg-zinc-800/60 text-zinc-400 hover:bg-white/5",
                )}
                aria-pressed={active}
              >
                {pos}
                {isPresetDefault && <span className="ml-0.5 text-[8px] text-zinc-500">·</span>}
              </button>
            );
          })}
        </div>
        {captionSettings.customPosition && (
          <button
            type="button"
            onClick={() => set({ customPosition: null })}
            className="mt-1 flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300"
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
          className="w-full accent-emerald-500"
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
      <p className="mb-3 mt-[-8px] text-[10px] leading-relaxed text-zinc-500">
        Triangle shape — line 1 longer than line 2 (auto in the export via ASS smart wrap).
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
                ? "bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
                : "cursor-not-allowed bg-zinc-800/50 text-zinc-600",
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
                ? "bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
                : "cursor-not-allowed bg-zinc-800/50 text-zinc-600",
            )}
          >
            <FileText size={11} /> .vtt
          </button>
          <button
            type="button"
            onClick={onExportAss}
            disabled={!hasCues}
            title={inElectron ? "Styled ASS with your kinetic animations" : "Desktop app only"}
            className={cn(
              "flex items-center justify-center gap-1 rounded px-2 py-1.5 text-[10px] font-semibold transition-colors",
              hasCues && inElectron
                ? "bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
                : "cursor-not-allowed bg-zinc-800/50 text-zinc-600",
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
                ? "bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
                : "cursor-not-allowed bg-zinc-800/50 text-zinc-600",
            )}
          >
            <AudioLines size={11} /> words .vtt
          </button>
        </div>
      </Field>
    </Section>
  );
}
