"use client";

// src/components/ChromaSection.tsx — v1 shared chroma/luma key editor.
//
// EXTRACTED from MediaPanel (v1) so BOTH surfaces show the same controls:
//   1. the per-item "Clip settings" expander in the media panel (legacy);
//   2. the dedicated CHROMA tab in the settings panel (v1 UX: a proper tab
//      alongside the other five — the buried expander was "not user
//      friendly").
// The component is fully props-driven: seg + edit + onSetItemEdit, exactly
// like the MediaPanel expander used it.
//
// v1 KEYING MODES (the "white/black screen ate my overlay" fix):
//   • chroma — green/blue/magenta screens; keys on COLOR distance
//     (FFmpeg chromakey parity). The v5.2 behavior.
//   • luma — white/black screens; keys on BRIGHTNESS distance (FFmpeg
//     lumakey parity). A chroma key on a neutral color removes EVERY gray
//     pixel (u=v=0 for all grays — including the overlay's content); the
//     luma key keeps dark content on a white screen and vice versa.
// Quick presets (Green / Blue / White / Black) set color + mode in one
// click; auto-detect returns the mode alongside the color.

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { AlertTriangle, Lock, Wand } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ItemEdit, MediaSegment } from "@/lib/merger/types";
import {
  ChromaKeyer,
  defaultChromaKeySettings,
  detectKeyColor,
  hexToRgb,
  sanitizeChromaKeySettings,
  type ChromaKeyMode,
  type ChromaKeySettings,
} from "@/lib/merger/chroma";

// ---------------------------------------------------------------------------
// Frame helpers (shared with MediaPanel — exported for its poster pipeline)
// ---------------------------------------------------------------------------

/** A drawable media frame (video / image element) — narrow enough for both
 *  2D drawImage (CanvasImageSource) and the GL keyer (TexImageSource). */
export type FrameSource = HTMLVideoElement | HTMLImageElement;

/** A seeked, ready-to-draw video element + the revoker for its object URL. */
export interface VideoFrameGrab {
  video: HTMLVideoElement;
  /** Revokes the probe's object URL — call when done drawing. */
  revoke: () => void;
}

/** Intrinsic dims of a TexImageSource (video / img / canvas duck-typing). */
function intrinsicDims(source: TexImageSource): { w: number; h: number } {
  const s = source as {
    videoWidth?: number;
    videoHeight?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    width?: number;
    height?: number;
  };
  if (typeof s.videoWidth === "number" && s.videoWidth > 0) {
    return { w: s.videoWidth, h: s.videoHeight ?? 0 };
  }
  if (typeof s.naturalWidth === "number" && s.naturalWidth > 0) {
    return { w: s.naturalWidth, h: s.naturalHeight ?? 0 };
  }
  if (typeof s.width === "number" && typeof s.height === "number" && s.width > 0) {
    return { w: s.width, h: s.height };
  }
  return { w: 0, h: 0 };
}

/**
 * Load a file into an offscreen <video>, wait for data, then seek.
 * `targetSec === null` seeks to the poster frame (min(1s, half the source)).
 * Resolves null (never rejects) when the file can't be decoded in time —
 * callers fall back to the generic icon tile.
 */
export function seekVideoTo(file: File, targetSec: number | null): Promise<VideoFrameGrab | null> {
  if (
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return Promise.resolve(null);
  }
  return new Promise<VideoFrameGrab | null>((resolve) => {
    const video = document.createElement("video");
    let objectUrl: string | null = null;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimeout(timer);
      if (ok) {
        resolve({
          video,
          revoke: () => {
            if (objectUrl != null) {
              URL.revokeObjectURL(objectUrl);
              objectUrl = null;
            }
          },
        });
      } else {
        try {
          video.pause();
          video.removeAttribute("src");
          video.load();
        } catch {
          /* already dead */
        }
        if (objectUrl != null) URL.revokeObjectURL(objectUrl);
        resolve(null);
      }
    };
    const armTimeout = () => {
      if (timer != null) clearTimeout(timer);
      timer = setTimeout(() => settle(false), 8000);
    };
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.addEventListener("error", () => settle(false), { once: true });
    video.addEventListener(
      "loadeddata",
      () => {
        const durSec = Number.isFinite(video.duration) ? video.duration : 0;
        const t =
          targetSec == null
            ? Math.min(1, durSec > 0 ? durSec / 2 : 1)
            : Math.min(Math.max(0, targetSec), Math.max(0, durSec > 0 ? durSec - 0.05 : 0));
        if (video.readyState >= 2 && Math.abs(video.currentTime - t) < 0.05) {
          settle(true);
          return;
        }
        armTimeout();
        video.addEventListener("seeked", () => settle(true), { once: true });
        try {
          video.currentTime = t;
        } catch {
          settle(false);
        }
      },
      { once: true },
    );
    armTimeout();
    try {
      objectUrl = URL.createObjectURL(file);
      video.src = objectUrl;
    } catch {
      settle(false);
    }
  });
}

/** Load an image URL into an <img> (naturalWidth > 0 on success). */
export function loadImageElement(url: string): Promise<HTMLImageElement | null> {
  if (typeof document === "undefined" || !url) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img.naturalWidth > 0 ? img : null);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/** Draw a frame source onto a fresh small canvas (auto-detect snapshots). */
export function drawSnapshot(
  source: FrameSource,
  width: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (typeof document === "undefined") return null;
  const dims = intrinsicDims(source);
  if (dims.w <= 0 || dims.h <= 0 || !(width > 0)) return null;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round((width * dims.h) / dims.w));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  try {
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }
  return { canvas, ctx };
}

/** Transparency checkerboard behind the keyed mini preview. */
function drawCheckerboard(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const cell = 6;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#18181b";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#27272a";
  for (let y = 0; y < h; y += cell) {
    for (let x = 0; x < w; x += cell) {
      if ((Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0) {
        ctx.fillRect(x, y, cell, cell);
      }
    }
  }
}

/** Normalize any hex chroma.ts accepts → 6-digit lowercase for <input color>. */
export function toColorInputValue(hex: string | null | undefined): string {
  try {
    const { r, g, b } = hexToRgb(hex ?? "");
    const two = (v: number) => Math.round(v).toString(16).padStart(2, "0");
    return `#${two(r)}${two(g)}${two(b)}`;
  } catch {
    return defaultChromaKeySettings().color;
  }
}

/** One WebGL keyer for the whole panel lifetime (context-limit safe). */
let sharedChromaKeyer: ChromaKeyer | null = null;
export function getSharedKeyer(): ChromaKeyer {
  if (sharedChromaKeyer == null) sharedChromaKeyer = new ChromaKeyer();
  return sharedChromaKeyer;
}

// ---------------------------------------------------------------------------
// ChromaSection — the key editor itself
// ---------------------------------------------------------------------------

/** Quick key presets: one click sets color + mode. */
const KEY_PRESETS: Array<{
  id: string;
  label: string;
  color: string;
  mode: ChromaKeyMode;
  hint: string;
}> = [
  { id: "green", label: "Green", color: "#00e000", mode: "chroma", hint: "Classic green screen — keys on color distance" },
  { id: "blue", label: "Blue", color: "#0048ff", mode: "chroma", hint: "Blue screen (spill-friendly for blond hair)" },
  { id: "white", label: "White", color: "#ffffff", mode: "luma", hint: "White background — brightness key keeps dark content" },
  { id: "black", label: "Black", color: "#000000", mode: "luma", hint: "Black background — brightness key keeps bright content" },
];

export interface ChromaSectionProps {
  seg: MediaSegment;
  edit: ItemEdit | undefined;
  onSetItemEdit: (id: string, patch: Partial<ItemEdit>) => void;
  isVideo: boolean;
  trimInMs: number;
  overlayOn: boolean;
}

export function ChromaSection({ seg, edit, onSetItemEdit, isVideo, trimInMs, overlayOn }: ChromaSectionProps) {
  const enabled = edit?.chroma != null;
  const chroma = sanitizeChromaKeySettings(edit?.chroma);
  const mode: ChromaKeyMode = chroma.mode ?? "chroma";
  const [detected, setDetected] = useState<{ color: string; confidence: number } | null>(null);
  const [detectWarn, setDetectWarn] = useState(false);
  const [detectBusy, setDetectBusy] = useState(false);
  const [frameSource, setFrameSource] = useState<FrameSource | null>(null);

  // Frame source for auto-detect + the live preview. Videos probe the trim-in
  // point (quantized to 0.5s so dragging the trim slider doesn't re-seek on
  // every 100ms tick); images load their object URL. The probe's object URL
  // is revoked on cleanup — no leaks.
  const probeAtSec = Math.round(Math.max(0, trimInMs) / 500) / 2;
  useEffect(() => {
    if (!enabled || !overlayOn) return;
    let cancelled = false;
    let revoke: (() => void) | null = null;
    const load = async () => {
      let src: FrameSource | null = null;
      if (isVideo && seg.file) {
        const grab = await seekVideoTo(seg.file, probeAtSec);
        if (cancelled) {
          grab?.revoke();
          return;
        }
        if (grab) {
          revoke = grab.revoke;
          src = grab.video;
        }
      } else {
        const img = await loadImageElement(seg.thumbnailUrl);
        if (cancelled) return;
        src = img;
      }
      if (!cancelled) setFrameSource(src);
    };
    void load();
    return () => {
      cancelled = true;
      revoke?.();
    };
  }, [enabled, overlayOn, isVideo, seg.file, seg.thumbnailUrl, probeAtSec]);

  const toggleChroma = () => {
    if (enabled) {
      onSetItemEdit(seg.id, { chroma: undefined });
      setDetected(null);
      setDetectWarn(false);
    } else {
      onSetItemEdit(seg.id, { chroma: defaultChromaKeySettings() });
    }
  };

  const runAutoDetect = async () => {
    if (detectBusy) return;
    setDetectBusy(true);
    setDetectWarn(false);
    let grab: VideoFrameGrab | null = null;
    try {
      let source: FrameSource | null = frameSource;
      if (!source) {
        if (isVideo && seg.file) {
          grab = await seekVideoTo(seg.file, Math.max(0, trimInMs) / 1000);
          source = grab?.video ?? null;
        } else {
          source = await loadImageElement(seg.thumbnailUrl);
        }
      }
      const snap = source ? drawSnapshot(source, 160) : null;
      if (!snap) {
        setDetectWarn(true);
        return;
      }
      const det = detectKeyColor(
        snap.ctx.getImageData(0, 0, snap.canvas.width, snap.canvas.height),
      );
      if (det.confidence < 0.5) {
        setDetectWarn(true);
        return;
      }
      setDetected({ color: det.color, confidence: det.confidence });
      // v1: the detector picks the keying MODE too (white/black screens →
      // luma) — this is exactly what fixes "keyed the white bg, lost the
      // content".
      onSetItemEdit(seg.id, {
        chroma: { ...chroma, color: det.color.toUpperCase(), mode: det.mode },
      });
    } catch {
      setDetectWarn(true);
    } finally {
      grab?.revoke();
      setDetectBusy(false);
    }
  };

  const patchChroma = (patch: Partial<ChromaKeySettings>) => {
    onSetItemEdit(seg.id, { chroma: { ...chroma, ...patch } });
  };

  const applyPreset = (p: (typeof KEY_PRESETS)[number]) => {
    setDetected(null);
    setDetectWarn(false);
    patchChroma({ color: p.color, mode: p.mode });
  };

  return (
    <div
      className="rounded-md border p-2"
      style={{ borderColor: "rgba(6, 78, 59, 0.35)", backgroundColor: "rgba(6, 78, 59, 0.08)" }}
    >
      <div className="flex items-center justify-between">
        <span
          className="flex items-center gap-1 text-[8px] font-semibold uppercase tracking-[0.12em]"
          style={{ color: "#6ee7b7" }}
        >
          <Wand className="size-2.5" /> Chroma key
        </span>
        {overlayOn ? (
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={`Chroma key for ${seg.fileName}`}
            onClick={toggleChroma}
            title={enabled ? "Disable chroma key" : "Enable chroma key (green screen removal)"}
            className="relative h-4 w-7 rounded-full transition-colors duration-150"
            style={{ backgroundColor: enabled ? "rgba(16, 185, 129, 0.55)" : "#3f3f46" }}
          >
            <span
              className={cn(
                "absolute top-[2px] size-3 rounded-full bg-white shadow-sm transition-all duration-150",
                enabled ? "left-[14px]" : "left-[2px]",
              )}
            />
          </button>
        ) : (
          <span className="text-[8px] font-medium" style={{ color: "#71717a" }}>
            overlay only
          </span>
        )}
      </div>

      {!overlayOn ? (
        <p className="mt-1.5 flex items-center gap-1 text-[9px]" style={{ color: "#71717a" }}>
          <Lock className="size-2.5 shrink-0" />
          Move to Overlay track to key.
        </p>
      ) : enabled ? (
        <div className="mt-2 space-y-2">
          {/* v1 quick presets — color + keying mode in one click. */}
          <div className="grid grid-cols-4 gap-1" role="group" aria-label="Key presets">
            {KEY_PRESETS.map((p) => {
              const active =
                toColorInputValue(chroma.color).toLowerCase() === p.color &&
                mode === p.mode;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPreset(p)}
                  title={p.hint}
                  aria-pressed={active}
                  className={cn(
                    "flex items-center justify-center gap-1 rounded-md border px-1 py-1 text-[9px] font-semibold transition-all duration-150 active:scale-95",
                    active
                      ? "border-emerald-400/60 bg-emerald-400/15 text-emerald-200"
                      : "border-zinc-700/70 text-zinc-400 hover:border-zinc-600 hover:bg-white/5 hover:text-zinc-200",
                  )}
                >
                  <span
                    className="size-2.5 shrink-0 rounded-[3px] border border-black/40"
                    style={{ backgroundColor: p.color }}
                  />
                  {p.label}
                </button>
              );
            })}
          </div>

          {/* v1 keying-mode explainer — the two modes in one sentence each. */}
          <p className="px-0.5 text-[9px] leading-relaxed" style={{ color: "#71717a" }}>
            {mode === "luma"
              ? "Luma key — removes pixels by brightness. Dark content stays on white screens (and vice versa)."
              : "Chroma key — removes pixels by color distance. Works best with a solid green/blue screen."}
          </p>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={runAutoDetect}
              disabled={detectBusy}
              className={cn(
                "flex items-center gap-1 rounded-md border px-1.5 py-1 text-[9px] font-semibold transition-all duration-150",
                detectBusy ? "cursor-wait opacity-60" : "hover:-translate-y-px hover:brightness-125",
              )}
              style={{
                borderColor: "rgba(16, 185, 129, 0.4)",
                backgroundColor: "rgba(16, 185, 129, 0.1)",
                color: "#6ee7b7",
              }}
              title="Sample the frame's edges to find the key color + keying mode automatically"
            >
              <Wand className={cn("size-3", detectBusy && "animate-pulse")} />
              Auto-detect key
            </button>
            {detected != null && (
              <span
                className="flex min-w-0 items-center gap-1 text-[9px]"
                style={{ color: "#a1a1aa" }}
                title={`Detected key color ${detected.color.toUpperCase()} with ${Math.round(detected.confidence * 100)}% confidence`}
              >
                <span
                  className="size-2.5 shrink-0 rounded-[3px] border border-black/40"
                  style={{ backgroundColor: detected.color }}
                />
                <span className="truncate tabular-nums">
                  {detected.color.toUpperCase()} · {Math.round(detected.confidence * 100)}%
                </span>
              </span>
            )}
          </div>
          {detectWarn && (
            <p className="flex items-center gap-1 text-[9px]" style={{ color: "#a1a1aa" }}>
              <AlertTriangle className="size-2.5 shrink-0" style={{ color: "#d97706" }} />
              Couldn&apos;t find a clear key color — set it manually.
            </p>
          )}

          <div className="flex items-center gap-2">
            <label className="w-14 shrink-0 text-[10px] font-medium" style={{ color: "#d4d4d8" }}>
              Key color
            </label>
            <input
              type="color"
              value={toColorInputValue(chroma.color)}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                const v = e.target.value;
                if (!/^#[0-9a-f]{6}$/i.test(v)) return;
                setDetected(null);
                setDetectWarn(false);
                patchChroma({ color: v.toUpperCase() });
              }}
              aria-label={`Key color for ${seg.fileName}`}
              title="Key color — the color (chroma) or brightness (luma) removed by the keyer"
              className="size-6 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5"
              style={{ borderColor: "#3f3f46" }}
            />
            <span className="font-mono text-[9px] tabular-nums" style={{ color: "#a1a1aa" }}>
              {toColorInputValue(chroma.color).toUpperCase()}
            </span>
          </div>

          <SliderRow
            label="Similarity"
            value={chroma.similarity}
            min={0.01}
            max={0.5}
            step={0.01}
            onChange={(v) => patchChroma({ similarity: v })}
            format={(v) => v.toFixed(2)}
            ariaLabel={`Chroma similarity for ${seg.fileName}`}
            title={
              mode === "luma"
                ? "Brightness distance treated as the key — higher removes more"
                : "Chroma distance treated as the key — higher removes more"
            }
          />
          <SliderRow
            label="Blend"
            value={chroma.blend}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => patchChroma({ blend: v })}
            format={(v) => v.toFixed(2)}
            ariaLabel={`Chroma blend for ${seg.fileName}`}
            title="Edge softness between keyed and kept pixels"
          />
          {mode === "chroma" ? (
            <div>
              <SliderRow
                label="Spill"
                value={chroma.spill}
                min={0}
                max={1}
                step={0.05}
                onChange={(v) => patchChroma({ spill: v })}
                format={(v) => v.toFixed(2)}
                ariaLabel={`Spill suppression for ${seg.fileName}`}
                title="Green fringe suppression on kept pixels"
              />
              <p className="mt-0.5 px-0.5 text-[9px]" style={{ color: "#71717a" }}>
                Removes green fringe (preview only — export approximates).
              </p>
            </div>
          ) : (
            <p className="px-0.5 text-[9px]" style={{ color: "#71717a" }}>
              Spill suppression is green-screen only — off in luma mode.
            </p>
          )}

          <div
            className="flex items-center gap-2 border-t pt-1.5"
            style={{ borderColor: "rgba(6, 78, 59, 0.3)" }}
          >
            <ChromaMiniPreview source={frameSource} settings={chroma} />
            <p className="min-w-0 text-[9px]" style={{ color: "#71717a" }}>
              {frameSource ? "Live key preview — checkerboard = removed." : "Loading frame…"}
            </p>
          </div>
        </div>
      ) : (
        <p className="mt-1.5 px-0.5 text-[9px]" style={{ color: "#52525b" }}>
          Remove a solid background (green/blue/white/black). PNG frames key too.
        </p>
      )}
    </div>
  );
}

interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
  ariaLabel: string;
  title?: string;
}

/** Labeled slider + tabular value badge — the pro-panel row pattern. */
export function SliderRow({ label, value, min, max, step, onChange, format, ariaLabel, title }: SliderRowProps) {
  return (
    <div className="flex items-center gap-2" title={title}>
      <span className="w-14 shrink-0 text-[10px] font-medium" style={{ color: "#d4d4d8" }}>
        {label}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={ariaLabel}
        className="min-w-0 flex-1"
      />
      <span
        className="w-8 shrink-0 text-right text-[9px] font-semibold tabular-nums"
        style={{ color: "#a1a1aa" }}
      >
        {format(value)}
      </span>
    </div>
  );
}

interface ChromaMiniPreviewProps {
  source: FrameSource | null;
  settings: ChromaKeySettings;
}

/** Tiny keyed-frame swatch strip over a checkerboard; silently falls back to
 *  the raw frame when WebGL is unavailable (ChromaKeyer.composite → false). */
function ChromaMiniPreview({ source, settings }: ChromaMiniPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawCheckerboard(ctx, canvas.width, canvas.height);
    if (!source) return;
    const dims = intrinsicDims(source);
    if (dims.w <= 0 || dims.h <= 0) return;
    const ok = getSharedKeyer().composite(ctx, source, settings, 0, 0, canvas.width, canvas.height, 1);
    if (!ok) {
      const crop = ChromaKeyer.coverRect(dims.w, dims.h, 0, 0, canvas.width, canvas.height);
      if (crop.sw > 0 && crop.sh > 0) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        try {
          ctx.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, canvas.width, canvas.height);
        } catch {
          /* undecodable — leave the checkerboard */
        }
      }
    }
    // Field-level deps (same re-render cadence as the v5.2 MediaPanel
    // original) + the v1 mode flag.
  }, [source, settings.color, settings.similarity, settings.blend, settings.spill, settings.mode]);

  return (
    <canvas
      ref={canvasRef}
      width={96}
      height={54}
      role="img"
      aria-label="Chroma key live preview"
      className="h-[54px] w-[96px] shrink-0 rounded-md border"
      style={{ borderColor: "#3f3f46", backgroundColor: "#18181b" }}
    />
  );
}
