"use client";

import { useState } from "react";
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
