"use client";

import { useMemo, useState } from "react";
import {
  ZoomIn,
  ZoomOut,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowDown,
  Shuffle,
  Sparkles,
  Bug,
  Aperture,
  ChevronRight,
  Captions,
  Type,
} from "lucide-react";
import type {
  AspectRatio,
  CaptionSettings,
  CaptionAnimation,
  KenBurnsConfig,
  KenBurnsDirection,
  Resolution,
  SubtitleFile,
  VideoSettings,
  TimelineMode,
} from "@/lib/merger/types";
import {
  CAPTION_PRESETS,
  FONT_OPTIONS,
  getCaptionPreset,
} from "@/lib/merger/captionPresets";
import { ANIMATION_LABELS } from "@/lib/merger/captionAnimations";
import { fmtTimecode } from "@/lib/merger/timeline";
import { cn } from "@/lib/utils";

interface SettingsPanelProps {
  kenBurns: KenBurnsConfig;
  settings: VideoSettings;
  onKenBurnsChange: (k: KenBurnsConfig) => void;
  onSettingsChange: (s: VideoSettings) => void;
  captionSettings: CaptionSettings;
  onCaptionSettingsChange: (c: CaptionSettings) => void;
  subtitles: SubtitleFile | null;
  debug: {
    imageCount: number;
    mode: TimelineMode | null;
    totalMs: number;
    currentMs: number;
    activeSegment: string | null;
    inElectron: boolean;
  };
}

const DIRECTIONS: { value: KenBurnsDirection; label: string; Icon: typeof ZoomIn }[] =
  [
    { value: "in", label: "Zoom In", Icon: ZoomIn },
    { value: "out", label: "Zoom Out", Icon: ZoomOut },
    { value: "left", label: "Pan Left", Icon: ArrowLeft },
    { value: "right", label: "Pan Right", Icon: ArrowRight },
    { value: "up", label: "Pan Up", Icon: ArrowUp },
    { value: "down", label: "Pan Down", Icon: ArrowDown },
    { value: "random", label: "Random", Icon: Shuffle },
  ];

const ASPECTS: { value: AspectRatio; label: string }[] = [
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
  { value: "1:1", label: "1:1" },
];

const RESOLUTIONS: { value: Resolution; label: string }[] = [
  { value: "720p", label: "720p" },
  { value: "1080p", label: "1080p" },
];

const FPS_OPTIONS: VideoSettings["fps"][] = [24, 30, 60];

export function SettingsPanel({
  kenBurns,
  settings,
  onKenBurnsChange,
  onSettingsChange,
  captionSettings,
  onCaptionSettingsChange,
  subtitles,
  debug,
}: SettingsPanelProps) {
  return (
    <div
      className="flex h-full flex-col overflow-y-auto"
      style={{ backgroundColor: "#111113" }}
    >
      {/* Ken Burns */}
      <Section icon={Sparkles} title="Ken Burns" accentColor="#a78bfa">
        <div className="flex items-center justify-between">
          <span className="text-[12px]" style={{ color: "#d4d4d8" }}>
            Enable motion
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={kenBurns.enabled}
            onClick={() =>
              onKenBurnsChange({ ...kenBurns, enabled: !kenBurns.enabled })
            }
            className="relative h-5 w-9 rounded-full transition-colors"
            style={{
              backgroundColor: kenBurns.enabled ? "#7c3aed" : "#3f3f46",
            }}
          >
            <span
              className={cn(
                "absolute top-0.5 size-4 rounded-full bg-white transition-transform",
                kenBurns.enabled ? "translate-x-4" : "translate-x-0.5",
              )}
            />
          </button>
        </div>

        <div
          className={cn(
            "space-y-3",
            !kenBurns.enabled && "pointer-events-none opacity-40",
          )}
        >
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px]" style={{ color: "#a1a1aa" }}>
                Intensity
              </span>
              <span
                className="font-mono text-[11px] tabular-nums"
                style={{ color: "#c4b5fd" }}
              >
                {kenBurns.intensity}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={kenBurns.intensity}
              onChange={(e) =>
                onKenBurnsChange({
                  ...kenBurns,
                  intensity: Number(e.target.value),
                })
              }
              style={{
                background: `linear-gradient(to right, #7c3aed ${kenBurns.intensity}%, #3f3f46 ${kenBurns.intensity}%)`,
              }}
            />
            <div
              className="mt-1 flex justify-between text-[9px]"
              style={{ color: "#52525b" }}
            >
              <span>subtle</span>
              <span>
                zoom {(1.06 + (kenBurns.intensity / 100) * 0.18).toFixed(3)}×
              </span>
              <span>strong</span>
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-[11px]" style={{ color: "#a1a1aa" }}>
              Direction
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {DIRECTIONS.map(({ value, label, Icon }) => {
                const active = kenBurns.direction === value;
                return (
                  <button
                    key={value}
                    type="button"
                    title={label}
                    onClick={() =>
                      onKenBurnsChange({ ...kenBurns, direction: value })
                    }
                    className={cn(
                      "flex aspect-square flex-col items-center justify-center gap-0.5 rounded-md border text-[8px] transition-all",
                    )}
                    style={
                      active
                        ? {
                            borderColor: "#7c3aed",
                            backgroundColor: "rgba(76, 29, 149, 0.5)",
                            color: "#ddd6fe",
                          }
                        : {
                            borderColor: "#27272a",
                            backgroundColor: "#18181b",
                            color: "#71717a",
                          }
                    }
                  >
                    <Icon className="size-3.5" />
                    <span className="capitalize">{value}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </Section>

      {/* Video settings */}
      <Section icon={Aperture} title="Video" accentColor="#22d3ee">
        <Field label="Aspect ratio">
          <Segmented
            options={ASPECTS}
            value={settings.aspect}
            onChange={(aspect) => onSettingsChange({ ...settings, aspect })}
          />
        </Field>
        <Field label="Resolution">
          <Segmented
            options={RESOLUTIONS}
            value={settings.resolution}
            onChange={(resolution) =>
              onSettingsChange({ ...settings, resolution })
            }
          />
        </Field>
        <Field label="Frame rate">
          <div className="flex gap-1.5">
            {FPS_OPTIONS.map((fps) => {
              const active = settings.fps === fps;
              return (
                <button
                  key={fps}
                  type="button"
                  onClick={() => onSettingsChange({ ...settings, fps })}
                  className={cn(
                    "flex-1 rounded-md border py-1.5 text-[11px] font-medium transition-all",
                  )}
                  style={
                    active
                      ? {
                          borderColor: "#06b6d4",
                          backgroundColor: "rgba(8, 51, 68, 0.5)",
                          color: "#67e8f9",
                        }
                      : {
                          borderColor: "#27272a",
                          backgroundColor: "#18181b",
                          color: "#a1a1aa",
                        }
                  }
                >
                  {fps} fps
                </button>
              );
            })}
          </div>
        </Field>
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px]" style={{ color: "#a1a1aa" }}>
              Bitrate
            </span>
            <span
              className="font-mono text-[11px] tabular-nums"
              style={{ color: "#67e8f9" }}
            >
              {settings.bitrateMbps} Mbps
            </span>
          </div>
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
              })
            }
            style={{
              background: `linear-gradient(to right, #06b6d4 ${((settings.bitrateMbps - 2) / 18) * 100}%, #3f3f46 ${((settings.bitrateMbps - 2) / 18) * 100}%)`,
            }}
          />
        </div>
      </Section>

      {/* Captions */}
      <CaptionsSection
        captionSettings={captionSettings}
        onCaptionSettingsChange={onCaptionSettingsChange}
        subtitles={subtitles}
      />

      {/* Debug */}
      <Section
        icon={Bug}
        title="Debug"
        accentColor="#a1a1aa"
        defaultOpen={false}
      >
        <dl className="space-y-1.5 text-[11px]">
          <Row label="Images" value={String(debug.imageCount)} />
          <Row
            label="Mode"
            value={debug.mode ?? "—"}
            valueColor={
              debug.mode === "absolute"
                ? "#67e8f9"
                : debug.mode === "sequential"
                  ? "#c4b5fd"
                  : "#a1a1aa"
            }
          />
          <Row label="Total time" value={fmtTimecode(debug.totalMs)} />
          <Row label="Current" value={fmtTimecode(debug.currentMs)} />
          <Row
            label="Active segment"
            value={debug.activeSegment ?? "—"}
            mono
            truncate
          />
          <Row
            label="Environment"
            value={debug.inElectron ? "Electron" : "Browser"}
            valueColor={debug.inElectron ? "#67e8f9" : "#fcd34d"}
          />
        </dl>
      </Section>
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  accentColor,
  defaultOpen = true,
  children,
}: {
  icon: typeof Sparkles;
  title: string;
  accentColor: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      className="border-b last:border-b-0"
      style={{ borderColor: "#27272a" }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 transition-colors"
        style={{ backgroundColor: "transparent" }}
      >
        <Icon className="size-4" style={{ color: accentColor }} />
        <span
          className="text-[12px] font-semibold tracking-tight"
          style={{ color: "#e4e4e7" }}
        >
          {title}
        </span>
        <span
          className="ml-auto transition-transform"
          style={{
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
            color: "#52525b",
          }}
        >
          <ChevronRight className="size-3.5" />
        </span>
      </button>
      {open && (
        <div className="space-y-3 px-4 pb-4 pt-1">{children}</div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px]" style={{ color: "#a1a1aa" }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-1.5">
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={cn(
              "flex-1 rounded-md border py-1.5 text-[11px] font-medium transition-all",
            )}
            style={
              active
                ? {
                    borderColor: "#06b6d4",
                    backgroundColor: "rgba(8, 51, 68, 0.5)",
                    color: "#67e8f9",
                  }
                : {
                    borderColor: "#27272a",
                    backgroundColor: "#18181b",
                    color: "#a1a1aa",
                  }
            }
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  truncate,
  valueColor,
}: {
  label: string;
  value: string;
  mono?: boolean;
  truncate?: boolean;
  valueColor?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt style={{ color: "#71717a" }}>{label}</dt>
      <dd
        className={cn(
          "text-right",
          mono && "font-mono",
          truncate && "max-w-[160px] truncate",
        )}
        style={{ color: valueColor || "#d4d4d8" }}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Captions section — preset grid, font dropdown, color override, position
// override, font size scale. Self-contained, calls onCaptionSettingsChange
// with the next immutable CaptionSettings object.
// ---------------------------------------------------------------------------

const POSITION_OPTIONS: {
  value: "top" | "center" | "bottom";
  label: string;
}[] = [
  { value: "top", label: "Top" },
  { value: "center", label: "Center" },
  { value: "bottom", label: "Bottom" },
];

function CaptionsSection({
  captionSettings,
  onCaptionSettingsChange,
  subtitles,
}: {
  captionSettings: CaptionSettings;
  onCaptionSettingsChange: (c: CaptionSettings) => void;
  subtitles: SubtitleFile | null;
}) {
  const set = (patch: Partial<CaptionSettings>) =>
    onCaptionSettingsChange({ ...captionSettings, ...patch });

  const cueCount = subtitles?.cues.length ?? 0;
  const lastEnd = cueCount
    ? fmtTimecode(subtitles!.cues[cueCount - 1].endMs)
    : "—";

  const selectedPreset = useMemo(
    () => getCaptionPreset(captionSettings.presetId),
    [captionSettings.presetId],
  );

  const hasSubtitles = cueCount > 0;
  const isEnabled = captionSettings.enabled;

  return (
    <Section
      icon={Captions}
      title="Captions"
      accentColor="#f0abfc"
      defaultOpen={false}
    >
      {/* Enable toggle + subtitle status */}
      <div className="flex items-center justify-between">
        <div className="flex flex-col">
          <span className="text-[12px]" style={{ color: "#d4d4d8" }}>
            Burn in captions
          </span>
          <span className="text-[10px]" style={{ color: "#71717a" }}>
            {hasSubtitles
              ? `${cueCount} cue${cueCount === 1 ? "" : "s"} · ends ${lastEnd}`
              : "Add an .srt file from the media panel"}
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={isEnabled}
          onClick={() => set({ enabled: !isEnabled })}
          disabled={!hasSubtitles}
          className="relative h-5 w-9 rounded-full transition-colors disabled:opacity-40"
          style={{
            backgroundColor: isEnabled ? "#7c3aed" : "#3f3f46",
          }}
        >
          <span
            className={cn(
              "absolute top-0.5 size-4 rounded-full bg-white transition-transform",
              isEnabled ? "translate-x-4" : "translate-x-0.5",
            )}
          />
        </button>
      </div>

      <div
        className={cn(
          "space-y-3",
          !isEnabled && "pointer-events-none opacity-40",
        )}
      >
        {/* Preset grid */}
        <Field label="Style preset">
          <div className="grid max-h-56 grid-cols-1 gap-1.5 overflow-y-auto pr-1">
            {CAPTION_PRESETS.map((p) => {
              const active = p.id === captionSettings.presetId;
              const sampleText = "The quick brown fox";
              const sampleStyle: React.CSSProperties = {
                color: p.textColor,
                backgroundColor: p.bgColor ?? "transparent",
                padding: p.bgColor
                  ? `${Math.max(2, p.bgPadding / 4)}px ${Math.max(4, p.bgPadding / 3)}px`
                  : "0",
                borderRadius: p.bgRadius ? Math.max(2, p.bgRadius / 3) : 0,
                fontWeight: p.fontWeight,
                fontStyle: p.fontStyle,
                fontFamily: p.fontFamily,
                letterSpacing: p.letterSpacing,
                textTransform: p.textTransform,
                textShadow: p.shadow
                  ? `0 0 ${p.shadowBlur}px ${p.shadowColor}`
                  : undefined,
                border: p.borderColor
                  ? `${Math.max(1, p.borderWidth / 2)}px solid ${p.borderColor}`
                  : undefined,
                fontSize: 11,
                display: "inline-block",
                opacity: p.bgColor ? p.bgAlpha : 1,
              };
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => set({ presetId: p.id })}
                  className={cn(
                    "flex items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-left transition-all",
                  )}
                  style={
                    active
                      ? {
                          borderColor: "#7c3aed",
                          backgroundColor: "rgba(76, 29, 149, 0.35)",
                        }
                      : {
                          borderColor: "#27272a",
                          backgroundColor: "#18181b",
                        }
                  }
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <div
                      className="flex h-6 min-w-[60px] items-center justify-center rounded px-1"
                      style={{ backgroundColor: "#000000" }}
                    >
                      <span style={sampleStyle}>{sampleText}</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div
                        className="truncate text-[11px] font-semibold"
                        style={{ color: active ? "#ddd6fe" : "#d4d4d8" }}
                      >
                        {p.name}
                      </div>
                      <div
                        className="truncate text-[9px]"
                        style={{ color: "#71717a" }}
                      >
                        {p.description}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </Field>

        {/* Font selector */}
        <Field label="Font family">
          <div className="relative">
            <select
              value={captionSettings.fontId}
              onChange={(e) => set({ fontId: e.target.value })}
              className="w-full appearance-none rounded-md border px-3 py-2 text-[12px] outline-none"
              style={{
                borderColor: "#3f3f46",
                backgroundColor: "#09090b",
                color: "#e4e4e7",
              }}
            >
              {FONT_OPTIONS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            <Type
              className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2"
              style={{ color: "#71717a" }}
            />
          </div>
        </Field>

        {/* Color override */}
        <Field label="Text color override">
          <div className="flex items-center gap-2">
            <label
              className="relative flex h-8 flex-1 cursor-pointer items-center gap-2 rounded-md border px-2"
              style={{
                borderColor: "#3f3f46",
                backgroundColor: "#18181b",
              }}
            >
              <span
                className="size-5 shrink-0 rounded border"
                style={{
                  backgroundColor: captionSettings.customColor ||
                    selectedPreset.textColor,
                  borderColor: "#3f3f46",
                }}
              />
              <span
                className="flex-1 truncate font-mono text-[11px]"
                style={{ color: "#d4d4d8" }}
              >
                {captionSettings.customColor ||
                  `${selectedPreset.textColor} (preset)`}
              </span>
              <input
                type="color"
                value={captionSettings.customColor || selectedPreset.textColor}
                onChange={(e) => set({ customColor: e.target.value })}
                className="absolute inset-0 size-full cursor-pointer opacity-0"
              />
            </label>
            {captionSettings.customColor && (
              <button
                type="button"
                onClick={() => set({ customColor: null })}
                className="rounded-md border px-2 py-1 text-[10px]"
                style={{
                  borderColor: "#3f3f46",
                  backgroundColor: "#18181b",
                  color: "#a1a1aa",
                }}
              >
                Reset
              </button>
            )}
          </div>
        </Field>

        {/* Position override */}
        <Field label="Position override">
          <div className="flex gap-1.5">
            {POSITION_OPTIONS.map((opt) => {
              const active =
                captionSettings.customPosition === opt.value ||
                (!captionSettings.customPosition &&
                  selectedPreset.position === opt.value);
              const isPresetDefault =
                !captionSettings.customPosition &&
                selectedPreset.position === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => set({ customPosition: opt.value })}
                  className={cn(
                    "flex-1 rounded-md border py-1.5 text-[11px] font-medium transition-all",
                  )}
                  style={
                    active
                      ? {
                          borderColor: "#7c3aed",
                          backgroundColor: "rgba(76, 29, 149, 0.4)",
                          color: "#ddd6fe",
                        }
                      : {
                          borderColor: "#27272a",
                          backgroundColor: "#18181b",
                          color: "#a1a1aa",
                        }
                  }
                >
                  {opt.label}
                  {isPresetDefault && (
                    <span
                      className="ml-1 text-[8px] uppercase opacity-70"
                      title="preset default"
                    >
                      ·
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {captionSettings.customPosition && (
            <button
              type="button"
              onClick={() => set({ customPosition: null })}
              className="mt-1.5 text-[10px]"
              style={{ color: "#71717a" }}
            >
              ↩ Reset to preset position ({selectedPreset.position})
            </button>
          )}
        </Field>

        {/* Font size scale */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px]" style={{ color: "#a1a1aa" }}>
              Font size scale
            </span>
            <span
              className="font-mono text-[11px] tabular-nums"
              style={{ color: "#c4b5fd" }}
            >
              {captionSettings.fontSizeScale.toFixed(2)}×
            </span>
          </div>
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.05}
            value={captionSettings.fontSizeScale}
            onChange={(e) =>
              set({ fontSizeScale: Number(e.target.value) })
            }
            style={{
              background: `linear-gradient(to right, #7c3aed ${((captionSettings.fontSizeScale - 0.5) / 1.5) * 100}%, #3f3f46 ${((captionSettings.fontSizeScale - 0.5) / 1.5) * 100}%)`,
            }}
          />
          <div
            className="mt-1 flex justify-between text-[9px]"
            style={{ color: "#52525b" }}
          >
            <span>0.5×</span>
            <span>1×</span>
            <span>2×</span>
          </div>
        </div>

        {/* Balanced text wrapping */}
        <div className="flex items-center justify-between">
          <div>
            <span className="text-[12px]" style={{ color: "#d4d4d8" }}>
              Balanced wrapping
            </span>
            <div className="text-[9px] mt-0.5" style={{ color: "#71717a" }}>
              Triangle shape: line 1 longer than line 2
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={captionSettings.balancedWrap}
            onClick={() =>
              set({ balancedWrap: !captionSettings.balancedWrap })
            }
            className="relative h-5 w-9 rounded-full transition-colors"
            style={{
              backgroundColor: captionSettings.balancedWrap ? "#7c3aed" : "#3f3f46",
            }}
          >
            <span
              className={cn(
                "absolute top-0.5 size-4 rounded-full bg-white transition-transform",
                captionSettings.balancedWrap ? "translate-x-4" : "translate-x-0.5",
              )}
            />
          </button>
        </div>

        {/* Word-by-word mode */}
        <Field label="Word-by-word mode">
          <div
            className="grid grid-cols-3 gap-1"
            role="radiogroup"
            aria-label="Word-by-word mode"
          >
            {([
              { value: "off", label: "Off", hint: "Full text" },
              { value: "word", label: "Highlight", hint: "Karaoke" },
              { value: "word-only", label: "Single", hint: "Hormozi" },
            ] as const).map((opt) => {
              const active = captionSettings.wordMode === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => set({ wordMode: opt.value })}
                  className={cn(
                    "rounded-md border px-2 py-1.5 text-[10px] font-medium transition-colors",
                  )}
                  style={{
                    borderColor: active ? "#7c3aed" : "#3f3f46",
                    backgroundColor: active
                      ? "rgba(124, 58, 237, 0.25)"
                      : "transparent",
                    color: active ? "#ddd6fe" : "#a1a1aa",
                  }}
                  title={opt.hint}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <div className="text-[9px] mt-1.5 leading-snug" style={{ color: "#71717a" }}>
            Highlight &amp; Single require word-level timestamps. Click
            &ldquo;Generate captions&rdquo; in the media panel (uses
            Whisper-tiny) or load a word-aligned SRT.
          </div>
        </Field>

        {/* Kinetic typography animation */}
        <Field label="Animation">
          <div
            className="grid grid-cols-3 gap-1 max-h-44 overflow-y-auto pr-1"
            role="radiogroup"
            aria-label="Caption animation"
          >
            {ANIMATION_LABELS.map((opt) => {
              const active = (captionSettings.animation || "none") === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => set({ animation: opt.value as CaptionAnimation })}
                  className={cn(
                    "rounded-md border px-2 py-1.5 text-[10px] font-medium transition-colors",
                  )}
                  style={{
                    borderColor: active ? "#7c3aed" : "#3f3f46",
                    backgroundColor: active
                      ? "rgba(124, 58, 237, 0.25)"
                      : "transparent",
                    color: active ? "#ddd6fe" : "#a1a1aa",
                  }}
                  title={opt.hint}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <div className="text-[9px] mt-1.5 leading-snug" style={{ color: "#71717a" }}>
            12 kinetic typography animations tuned for storytelling / retention.
            Pairs with Whisper-generated captions for per-word motion.
          </div>
        </Field>
      </div>
    </Section>
  );
}
