"use client";

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
} from "lucide-react";
import type {
  AspectRatio,
  KenBurnsConfig,
  KenBurnsDirection,
  Resolution,
  VideoSettings,
  TimelineMode,
} from "@/lib/merger/types";
import { fmtTimecode } from "@/lib/merger/timeline";
import { cn } from "@/lib/utils";

interface SettingsPanelProps {
  kenBurns: KenBurnsConfig;
  settings: VideoSettings;
  onKenBurnsChange: (k: KenBurnsConfig) => void;
  onSettingsChange: (s: VideoSettings) => void;
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
  debug,
}: SettingsPanelProps) {
  return (
    <div className="flex h-full flex-col overflow-y-auto bg-[#111113]">
      {/* Ken Burns */}
      <Section icon={Sparkles} title="Ken Burns" accent="violet">
        <div className="flex items-center justify-between">
          <span className="text-[12px] text-zinc-300">Enable motion</span>
          <button
            type="button"
            role="switch"
            aria-checked={kenBurns.enabled}
            onClick={() => onKenBurnsChange({ ...kenBurns, enabled: !kenBurns.enabled })}
            className={cn(
              "relative h-5 w-9 rounded-full transition-colors",
              kenBurns.enabled ? "bg-violet-600" : "bg-zinc-700",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 size-4 rounded-full bg-white transition-transform",
                kenBurns.enabled ? "translate-x-4" : "translate-x-0.5",
              )}
            />
          </button>
        </div>

        <div className={cn("space-y-3", !kenBurns.enabled && "pointer-events-none opacity-40")}>
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] text-zinc-400">Intensity</span>
              <span className="font-mono text-[11px] tabular-nums text-violet-300">
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
                onKenBurnsChange({ ...kenBurns, intensity: Number(e.target.value) })
              }
              style={{
                background: `linear-gradient(to right, oklch(0.541 0.281 293) ${kenBurns.intensity}%, #3f3f46 ${kenBurns.intensity}%)`,
              }}
            />
            <div className="mt-1 flex justify-between text-[9px] text-zinc-600">
              <span>subtle</span>
              <span>
                zoom {(1.06 + (kenBurns.intensity / 100) * 0.18).toFixed(3)}×
              </span>
              <span>strong</span>
            </div>
          </div>

          <div>
            <div className="mb-1.5 text-[11px] text-zinc-400">Direction</div>
            <div className="grid grid-cols-4 gap-1.5">
              {DIRECTIONS.map(({ value, label, Icon }) => {
                const active = kenBurns.direction === value;
                return (
                  <button
                    key={value}
                    type="button"
                    title={label}
                    onClick={() => onKenBurnsChange({ ...kenBurns, direction: value })}
                    className={cn(
                      "flex aspect-square flex-col items-center justify-center gap-0.5 rounded-md border text-[8px] transition-all",
                      active
                        ? "border-violet-500 bg-violet-950/50 text-violet-200"
                        : "border-zinc-800 bg-zinc-900 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300",
                    )}
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
      <Section icon={Aperture} title="Video" accent="cyan">
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
            {FPS_OPTIONS.map((fps) => (
              <button
                key={fps}
                type="button"
                onClick={() => onSettingsChange({ ...settings, fps })}
                className={cn(
                  "flex-1 rounded-md border py-1.5 text-[11px] font-medium transition-all",
                  settings.fps === fps
                    ? "border-cyan-500 bg-cyan-950/50 text-cyan-200"
                    : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700",
                )}
              >
                {fps} fps
              </button>
            ))}
          </div>
        </Field>
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] text-zinc-400">Bitrate</span>
            <span className="font-mono text-[11px] tabular-nums text-cyan-300">
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
              onSettingsChange({ ...settings, bitrateMbps: Number(e.target.value) })
            }
            style={{
              background: `linear-gradient(to right, oklch(0.6 0.18 200) ${((settings.bitrateMbps - 2) / 18) * 100}%, #3f3f46 ${((settings.bitrateMbps - 2) / 18) * 100}%)`,
            }}
          />
        </div>
      </Section>

      {/* Debug */}
      <Section icon={Bug} title="Debug" accent="zinc" defaultOpen={false}>
        <dl className="space-y-1.5 text-[11px]">
          <Row label="Images" value={String(debug.imageCount)} />
          <Row
            label="Mode"
            value={debug.mode ?? "—"}
            valueClass={
              debug.mode === "absolute"
                ? "text-cyan-300"
                : debug.mode === "sequential"
                  ? "text-violet-300"
                  : "text-zinc-400"
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
            valueClass={debug.inElectron ? "text-cyan-300" : "text-amber-300"}
          />
        </dl>
      </Section>
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  accent,
  defaultOpen = true,
  children,
}: {
  icon: typeof Sparkles;
  title: string;
  accent: "violet" | "cyan" | "zinc";
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const accentText =
    accent === "violet"
      ? "text-violet-400"
      : accent === "cyan"
        ? "text-cyan-400"
        : "text-zinc-400";
  return (
    <details
      open={defaultOpen}
      className="group border-b border-zinc-800 last:border-b-0"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 transition-colors hover:bg-zinc-900/40">
        <Icon className={cn("size-4", accentText)} />
        <span className="text-[12px] font-semibold tracking-tight text-zinc-200">
          {title}
        </span>
        <span className="ml-auto text-zinc-600 transition-transform group-open:rotate-90">
          ›
        </span>
      </summary>
      <div className="space-y-3 px-4 pb-4 pt-1">{children}</div>
    </details>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] text-zinc-400">{label}</div>
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
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            "flex-1 rounded-md border py-1.5 text-[11px] font-medium transition-all",
            value === opt.value
              ? "border-cyan-500 bg-cyan-950/50 text-cyan-200"
              : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  truncate,
  valueClass,
}: {
  label: string;
  value: string;
  mono?: boolean;
  truncate?: boolean;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-zinc-500">{label}</dt>
      <dd
        className={cn(
          "text-right text-zinc-300",
          mono && "font-mono",
          truncate && "max-w-[160px] truncate",
          valueClass,
        )}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}
