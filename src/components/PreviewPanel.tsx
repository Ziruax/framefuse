"use client";

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Play, Pause, SkipBack, SkipForward, ImageOff, Type, ArrowLeftRight, BadgeCheck, Crosshair, Video } from "lucide-react";
import type {
  AspectRatio,
  CaptionSettings,
  HeadlineItem,
  KenBurnsConfig,
  KenBurnsDirection,
  MediaSegment,
  OverlayTransform,
  SubtitleFile,
  TransitionSettings,
  WatermarkSettings,
} from "@/lib/merger/types";
import {
  computeTransitionFx,
  computeGlobalFade,
  applyGlobalFade,
  drawFrameWithTransition,
  drawVideoFrame,
  drawWatermark,
  overlayGeometry,
  previewDimensions,
  type VideoFrameSource,
} from "@/lib/merger/renderer";
import { ChromaKeyer } from "@/lib/merger/chroma";
import { overlaySegmentsAt } from "@/lib/merger/timeline";
import { drawCaption, drawHeadline } from "@/lib/merger/native";
import { cueAt } from "@/lib/merger/subtitles";
import { fmtTimecode } from "@/lib/merger/timeline";
import { middleEllipsis } from "@/lib/merger/text";

/** v4.5: middle-ellipsis — moved to lib/merger/text.ts in v4.9 (shared
 *  with the media list rows); re-exported here for local call sites. */

/** v5.0: overlay-lane items without an explicit geometry render centered at
 *  60% output width — MUST stay in lockstep with page.tsx's
 *  DEFAULT_OVERLAY_TRANSFORM (page writes it into the item's edit on every
 *  lane switch, so the exported overlay composite matches by construction). */
const DEFAULT_OVERLAY_TRANSFORM: OverlayTransform = {
  scalePercent: 60,
  position: "center",
};

/** Intrinsic size of a canvas paint source (video → videoWidth, image →
 *  naturalWidth) for the overlay geometry math. */
function sourceDims(s: VideoFrameSource): { w: number; h: number } {
  const w = Number(s.videoWidth ?? s.naturalWidth ?? 0);
  const h = Number(s.videoHeight ?? s.naturalHeight ?? 0);
  return {
    w: Number.isFinite(w) ? w : 0,
    h: Number.isFinite(h) ? h : 0,
  };
}

interface PreviewPanelProps {
  segments: MediaSegment[];
  images: Record<string, HTMLImageElement>;
  /** v5.0: object URLs for VIDEO media items (id → url). One hidden muted
   *  <video> element is created per id (reused across renders, destroyed
   *  with the media list) and painted onto the canvas frame-by-frame. */
  videoUrls?: Record<string, string>;
  totalMs: number;
  currentMs: number;
  isPlaying: boolean;
  kenBurns: KenBurnsConfig;
  aspect: AspectRatio;
  activeSegment: MediaSegment | null;
  subtitles: SubtitleFile | null;
  captionSettings: CaptionSettings;
  /** Headline overlay items (v4.2). */
  headlineItems: HeadlineItem[];
  /** Segment transitions (v4.3). */
  transition: TransitionSettings;
  /** Watermark image element + settings (v4.4). */
  watermarkImage: HTMLImageElement | null;
  watermarkSettings: WatermarkSettings | null;
  onSeek: (ms: number) => void;
  onTogglePlay: () => void;
  onStep: (dir: -1 | 1) => void;
  /** v4.8: click-to-aim Ken Burns motion — pin the active segment's
   *  direction from where the user clicks on the canvas. Absent (or motion
   *  disabled) → the canvas stays a plain preview. */
  onSetMotion?: (dir: KenBurnsDirection) => void;
}

/** v4.8: which concrete motion does a click at (nx, ny) ∈ [0,1]² aim at?
 *  Center zone → zoom in; otherwise the dominant axis wins (the camera
 *  pans toward the clicked point). Pure + mirrors the card popover. */
export function aimDirection(
  nx: number,
  ny: number,
  centerRadius = 0.16,
): KenBurnsDirection {
  const dx = nx - 0.5;
  const dy = ny - 0.5;
  if (Math.hypot(dx, dy * 0.85) < centerRadius) return "in";
  return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? "right" : "left") : ny > 0.5 ? "down" : "up";
}

const AIM_LABEL: Record<string, string> = {
  in: "Zoom In",
  out: "Zoom Out",
  left: "Pan Left",
  right: "Pan Right",
  up: "Pan Up",
  down: "Pan Down",
};

/** v5.1: MM:SS.d — the transport readout chip precision ("00:12.3"). */
function fmtTenths(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, "0")}:${r < 10 ? "0" : ""}${r.toFixed(1)}`;
}

export function PreviewPanel({
  segments,
  images,
  videoUrls,
  totalMs,
  currentMs,
  isPlaying,
  kenBurns,
  aspect,
  activeSegment,
  subtitles,
  captionSettings,
  headlineItems,
  transition,
  watermarkImage,
  watermarkSettings,
  onSeek,
  onTogglePlay,
  onStep,
  onSetMotion,
}: PreviewPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scratchRef = useRef<HTMLCanvasElement | null>(null);
  const dims = previewDimensions(aspect);
  // v4.8: hover point for the motion-aiming overlay (normalized coords).
  const [aim, setAim] = useState<{ nx: number; ny: number } | null>(null);
  // v5.0: hidden video paint sources, one per video media id (created/
  // destroyed with the media list, reused across renders). Bumped whenever
  // a video's metadata lands so the canvas redraws with real dimensions.
  const videoElsRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const videoHostRef = useRef<HTMLDivElement | null>(null);
  const [videoMetaTick, setVideoMetaTick] = useState(0);
  // v5.0: one shared WebGL chroma keyer for the overlay lane (composite()
  // reconfigures its offscreen to the dest rect; false → plain drawImage).
  const chromaKeyerRef = useRef<ChromaKeyer | null>(null);

  const activeIsVideo = activeSegment?.mediaType === "video";
  // v5.1: the aiming hint only appears while the pointer is over the canvas —
  // context-sensitive guidance instead of a permanent fixture (VLM review).
  const [canvasHover, setCanvasHover] = useState(false);
  const aimActive =
    !!onSetMotion &&
    kenBurns.enabled &&
    !!activeSegment &&
    !activeIsVideo && // v5.0: Ken Burns + aiming are image-only (video motion is the content)
    segments.length > 0;
  const aimedDir = aim ? aimDirection(aim.nx, aim.ny) : null;

  // v5.0: hidden <video> lifecycle — create on new ids, rewire when the URL
  // for a known id changes (project load restores saved ids w/ fresh URLs),
  // destroy when the id leaves the media list. Elements live in the DOM (a
  // clipped 2px host, opacity 0) so Chromium keeps decoding frames for
  // canvas painting; React never manages the raw children.
  useEffect(() => {
    const host = videoHostRef.current;
    const map = videoElsRef.current;
    if (!host) return;
    const ids = new Set<string>(Object.keys(videoUrls ?? {}));
    for (const [id, el] of Array.from(map.entries())) {
      if (ids.has(id)) continue;
      try {
        el.pause();
        el.removeAttribute("src");
        el.load();
      } catch {
        /* noop */
      }
      el.remove();
      map.delete(id);
    }
    for (const [id, url] of Object.entries(videoUrls ?? {})) {
      let el = map.get(id);
      if (!el) {
        el = document.createElement("video");
        el.muted = true;
        el.playsInline = true;
        el.preload = "auto";
        el.style.position = "absolute";
        el.style.width = "2px";
        el.style.height = "2px";
        el.style.opacity = "0";
        el.addEventListener("loadedmetadata", () => setVideoMetaTick((t) => t + 1));
        el.addEventListener("loadeddata", () => setVideoMetaTick((t) => t + 1));
        el.src = url;
        el.dataset.url = url;
        host.appendChild(el);
        map.set(id, el);
      } else if (el.dataset.url !== url) {
        el.dataset.url = url;
        el.src = url;
      }
    }
  }, [videoUrls]);

  // v5.0: unmount — pause + release every hidden video, drop the keyer.
  useEffect(
    () => () => {
      for (const el of videoElsRef.current.values()) {
        try {
          el.pause();
          el.removeAttribute("src");
          el.load();
        } catch {
          /* noop */
        }
        el.remove();
      }
      videoElsRef.current.clear();
      chromaKeyerRef.current?.dispose();
      chromaKeyerRef.current = null;
    },
    [],
  );

  // Redraw whenever the playhead or inputs change. v5.0 draw order mirrors
  // the FFmpeg export graph exactly: BASE → overlay lane (track asc) →
  // watermark → headlines/captions (subtitles) → global fades. Video frames
  // are painted from the hidden <video> elements — they may lag one frame
  // behind the playhead (async decode), which is the accepted trade-off.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    const seg = activeSegment;
    const videoEls = videoElsRef.current;
    const activeOverlays = overlaySegmentsAt(segments, currentMs);

    // ---- v5.0: video sync (base + overlays) --------------------------------
    // Scrub/seek → currentTime = trimIn/1000 + (t − seg.startMs)·speed/1000
    // and pause; playing → play() at playbackRate=speed + drift-correct over
    // 120ms; segment exit → pause. Muted always (audio comes from the
    // music/SFX tracks; the export handles real clip audio).
    // v5.1: SPEED — source-time mapping is trimIn + local·speed (the export's
    // setpts twin); the element plays at playbackRate=speed so wall-clock
    // playback advances source time at the same rate and the 120ms drift
    // window stays meaningful.
    const syncVideoTo = (el: HTMLVideoElement, vSeg: MediaSegment | null) => {
      if (!vSeg) {
        if (!el.paused) el.pause();
        return;
      }
      const speed =
        vSeg.speed != null && Number.isFinite(vSeg.speed) && vSeg.speed > 0
          ? vSeg.speed
          : 1;
      const localMs = vSeg.trimInMs + (currentMs - vSeg.startMs) * speed;
      const targetSec = Math.max(0, localMs) / 1000;
      const dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null;
      const clampedSec = dur != null ? Math.min(targetSec, Math.max(0, dur - 0.05)) : targetSec;
      if (el.playbackRate !== speed) {
        try {
          el.playbackRate = speed;
        } catch {
          /* rate out of range — native rate is a fine fallback */
        }
      }
      if (!isPlaying) {
        if (!el.paused) el.pause();
        if (el.readyState >= 1 && Math.abs(el.currentTime - clampedSec) > 0.02) {
          try {
            el.currentTime = clampedSec;
          } catch {
            /* not seekable yet */
          }
        }
        return;
      }
      if (el.readyState >= 1 && Math.abs(el.currentTime * 1000 - localMs) > 120) {
        try {
          el.currentTime = clampedSec;
        } catch {
          /* noop */
        }
      }
      if (el.paused) el.play().catch(() => { /* no data yet / autoplay */ });
    };

    if (videoEls.size > 0) {
      const activeVideoIds = new Set<string>();
      if (seg && seg.mediaType === "video") activeVideoIds.add(seg.id);
      for (const ov of activeOverlays) {
        if (ov.mediaType === "video") activeVideoIds.add(ov.id);
      }
      for (const [id, el] of videoEls) {
        if (activeVideoIds.has(id)) {
          const vSeg =
            seg && seg.id === id
              ? seg
              : activeOverlays.find((o) => o.id === id) ?? null;
          syncVideoTo(el, vSeg);
        } else {
          syncVideoTo(el, null); // segment exit → pause
        }
      }
    }

    // ---- BASE layer ----------------------------------------------------------
    if (seg) {
      if (!scratchRef.current) scratchRef.current = document.createElement("canvas");
      if (scratchRef.current.width !== dims.w || scratchRef.current.height !== dims.h) {
        scratchRef.current.width = dims.w;
        scratchRef.current.height = dims.h;
      }
      const segIdx = segments.findIndex((s) => s.id === seg.id);
      if (seg.mediaType === "video") {
        // v5.0: video base — cover-fit via drawVideoFrame, NO Ken Burns.
        // The transition rule makes xfade heads hard cuts at video
        // boundaries, so only dip heads can be active — and
        // drawFrameWithTransition sources the CURRENT image only, so dip
        // heads are composited here manually (video frame on scratch →
        // blend over the dip color at p). drawFrameWithTransition is never
        // called with a video source (images map misses by design).
        const fx = computeTransitionFx(segments, Math.max(0, segIdx), currentMs, transition);
        const vEl = videoEls.get(seg.id) ?? null;
        const sctx = scratchRef.current.getContext("2d", { alpha: false });
        if (fx.kind === "dip-head" && sctx) {
          drawVideoFrame(sctx, vEl, dims.w, dims.h);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.fillStyle = fx.dipColor === "white" ? "#ffffff" : "#000000";
          ctx.fillRect(0, 0, dims.w, dims.h);
          ctx.globalAlpha = fx.p;
          ctx.drawImage(scratchRef.current, 0, 0);
          ctx.globalAlpha = 1;
        } else {
          drawVideoFrame(ctx, vEl, dims.w, dims.h);
        }
      } else {
        const img = seg ? images[seg.id] ?? null : null;
        // v4.3: transition head composite (dissolve/slide/wipe/dip) with
        // EXACT export parity, then captions, then the global fades.
        drawFrameWithTransition(
          ctx, scratchRef.current, seg, Math.max(0, segIdx), segments,
          img, images, currentMs, dims.w, dims.h, kenBurns, transition,
        );
      }
    } else {
      ctx.fillStyle = "#0a0a0a";
      ctx.fillRect(0, 0, dims.w, dims.h);
    }

    // ---- v5.0: OVERLAY lane (track asc = draw order) ------------------------
    // Each active overlay paints through the shared chroma keyer when
    // seg.chroma is set (composite false → plain drawImage fallback), else a
    // plain drawImage, always at the overlayGeometry rect. A null transform
    // falls back to DEFAULT_OVERLAY_TRANSFORM — page.tsx materializes the
    // same default into the item's edit on lane switches, keeping the
    // exported overlay composite in lockstep.
    if (activeOverlays.length > 0) {
      if (!chromaKeyerRef.current) chromaKeyerRef.current = new ChromaKeyer();
      const keyer = chromaKeyerRef.current;
      keyer.configure(dims.w, dims.h);
      for (const ov of activeOverlays) {
        const src: VideoFrameSource | null =
          ov.mediaType === "video"
            ? videoEls.get(ov.id) ?? null
            : images[ov.id] ?? null;
        if (!src) continue; // image not decoded yet / video not created
        const sd = sourceDims(src);
        if (sd.w <= 0 || sd.h <= 0) continue; // no metadata yet
        const transform: OverlayTransform = ov.overlay ?? DEFAULT_OVERLAY_TRANSFORM;
        const g = overlayGeometry(dims.w, dims.h, sd.w, sd.h, transform);
        if (g.dw <= 0 || g.dh <= 0) continue;
        const keyed =
          ov.chroma != null &&
          keyer.composite(ctx, src, ov.chroma, g.dx, g.dy, g.dw, g.dh);
        if (!keyed) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(src, g.dx, g.dy, g.dw, g.dh);
        }
      }
    }

    // Watermark overlay (v4.4) — UNDER headlines + captions, exactly like
    // the export z-order (overlay filter before subtitles).
    if (watermarkImage && watermarkSettings) {
      drawWatermark(ctx, watermarkImage, dims.w, dims.h, watermarkSettings);
    }

    // Headline overlay (v4.2) — under captions so center captions sit on top.
    if (headlineItems && headlineItems.length > 0) {
      drawHeadline(ctx, headlineItems, currentMs, dims.w, dims.h);
    }

    // Overlay caption if enabled + active cue exists.
    if (
      captionSettings?.enabled &&
      subtitles &&
      subtitles.cues.length > 0
    ) {
      const cue = cueAt(subtitles.cues, currentMs);
      if (cue) {
        // Pass per-word timestamps + current time + cue window +
        // animation so the word-mode presets and kinetic typography
        // animations render identically to the export.
        const capCtx = {
          ...captionSettings,
          words: cue.words,
          currentMs,
          cueStartMs: cue.startMs,
          cueEndMs: cue.endMs,
        };
        drawCaption(ctx, cue.text, capCtx, dims.w, dims.h);
      }
    }

    // v4.3: global fades AFTER captions — mirrors fade-after-subtitles
    // in the FFmpeg export (start/end fades + dip tails).
    if (seg && scratchRef.current) {
      const segIdx = Math.max(0, segments.findIndex((s) => s.id === seg.id));
      applyGlobalFade(
        ctx,
        scratchRef.current,
        computeGlobalFade(segments, segIdx, currentMs, transition),
      );
    }
  }, [
    currentMs,
    activeSegment,
    images,
    kenBurns,
    dims.w,
    dims.h,
    subtitles,
    captionSettings,
    headlineItems,
    segments,
    transition,
    watermarkImage,
    watermarkSettings,
    // v5.0: video paint sources + playback state + metadata arrival
    isPlaying,
    videoUrls,
    videoMetaTick,
  ]);

  const pct = totalMs > 0 ? (currentMs / totalMs) * 100 : 0;

  // v4.3: is the playhead inside a transition window right now?
  const activeTxFx = (() => {
    if (!activeSegment || transition.style === "none") return null;
    const idx = segments.findIndex((s) => s.id === activeSegment.id);
    if (idx <= 0) return null;
    const fx = computeTransitionFx(segments, idx, currentMs, transition);
    return fx.kind === "none" ? null : fx;
  })();
  const txLabel =
    activeTxFx && activeTxFx.kind !== "none"
      ? transition.style === "dissolve"
        ? "dissolve"
        : transition.style === "dip-black"
          ? "dip"
          : transition.style === "dip-white"
            ? "flash"
            : transition.style.replace("-", " ")
      : null;

  return (
    <div
      className="flex h-full flex-col overflow-hidden"
      style={{ backgroundColor: "#0c0c0e" }}
    >
      {/* Canvas stage */}
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4"
        style={{
          background:
            "radial-gradient(ellipse at 50% 20%, rgba(124, 58, 237, 0.07) 0%, rgba(12, 12, 14, 0) 65%)",
        }}
      >
        {segments.length === 0 ? (
          <div
            className="ff-grid-bg flex h-full w-full flex-col items-center justify-center rounded-xl border text-center transition-colors"
            style={{ borderColor: "#27272a" }}
          >
            <ImageOff className="mb-3 size-8" style={{ color: "#3f3f46" }} />
            <p className="text-[13px] font-medium" style={{ color: "#a1a1aa" }}>
              No images yet
            </p>
            <p className="mt-1 text-[11px]" style={{ color: "#52525b" }}>
              Add images from the left panel to begin
            </p>
          </div>
        ) : (
          <div
            className="relative rounded-lg border shadow-2xl transition-shadow duration-300"
            style={{
              borderColor: "#27272a",
              backgroundColor: "#000000",
              boxShadow:
                "0 25px 50px -12px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(34, 211, 238, 0.08)",
              aspectRatio: `${dims.w} / ${dims.h}`,
              maxWidth: "100%",
              maxHeight: "100%",
              width: dims.w,
              ...(aimActive ? { cursor: "crosshair" } : {}),
            }}
            onMouseEnter={() => setCanvasHover(true)}
            onMouseMove={
              aimActive
                ? (e: ReactMouseEvent<HTMLDivElement>) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setAim({
                      nx: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
                      ny: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
                    });
                  }
                : undefined
            }
            onMouseLeave={() => {
              setCanvasHover(false);
              if (aimActive) setAim(null);
            }}
            onClick={
              aimActive && aim
                ? () => {
                    onSetMotion?.(aimDirection(aim.nx, aim.ny));
                  }
                : undefined
            }
          >
            <canvas
              ref={canvasRef}
              width={dims.w}
              height={dims.h}
              className="block size-full rounded-lg"
            />
            {/* v4.8: motion-aiming overlay — crosshair follows the cursor,
                the chip names the direction a click would pin. */}
            {aimActive && aim && aimedDir && (
              <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-lg">
                {/* Crosshair guides */}
                <span
                  className="absolute inset-y-0 w-px"
                  style={{
                    left: `${aim.nx * 100}%`,
                    backgroundColor: "rgba(167, 139, 250, 0.4)",
                    boxShadow: "0 0 8px rgba(167, 139, 250, 0.35)",
                  }}
                />
                <span
                  className="absolute inset-x-0 h-px"
                  style={{
                    top: `${aim.ny * 100}%`,
                    backgroundColor: "rgba(167, 139, 250, 0.4)",
                    boxShadow: "0 0 8px rgba(167, 139, 250, 0.35)",
                  }}
                />
                {/* Center bullseye (click = zoom in) + visible center dot
                    (v4.8 VLM: the center must read on busy video content). */}
                <span
                  className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-violet-300/40"
                  style={{
                    width: "24%",
                    aspectRatio: "1 / 1",
                    maxHeight: "34%",
                    boxShadow:
                      "inset 0 0 24px rgba(167, 139, 250, 0.18), 0 0 12px rgba(167, 139, 250, 0.12)",
                  }}
                />
                <span
                  className="absolute left-1/2 top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
                  style={{
                    backgroundColor: "#c4b5fd",
                    borderColor: "rgba(255, 255, 255, 0.75)",
                    boxShadow: "0 0 8px rgba(167, 139, 250, 0.9)",
                  }}
                />
                {/* Aim chip near the cursor */}
                <span
                  className="absolute flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold backdrop-blur-sm"
                  style={{
                    left: `calc(${(aim.nx * 100).toFixed(1)}% + 12px)`,
                    top: `calc(${(aim.ny * 100).toFixed(1)}% + 12px)`,
                    backgroundColor: "rgba(0, 0, 0, 0.72)",
                    color: "#c4b5fd",
                    border: "1px solid rgba(167, 139, 250, 0.4)",
                    maxWidth: "45%",
                    whiteSpace: "nowrap",
                  }}
                >
                  <Crosshair className="size-3 shrink-0" />
                  Aim: {AIM_LABEL[aimedDir]}
                </span>
              </div>
            )}
            {/* v4.8: hover-scoped hint (only while motion aiming is armed
                AND the pointer is over the canvas — guidance exactly when
                the click is possible, not a permanent overlay) */}
            {aimActive && !aim && canvasHover && (
              <div
                className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-md px-2 py-1 text-[9px] backdrop-blur-sm"
                style={{
                  backgroundColor: "rgba(0, 0, 0, 0.62)",
                  color: "#c4b5fd",
                  border: "1px solid rgba(167, 139, 250, 0.28)",
                }}
              >
                <Crosshair className="size-3" />
                Click the canvas to aim this segment's motion · center = zoom in
              </div>
            )}
            {/* Segment label overlay (v4.5: middle-ellipsis so BOTH the
                timestamp prefix and the descriptive tail stay readable). */}
            {activeSegment && (
              <div
                className="pointer-events-none absolute left-2 top-2 rounded-md px-2 py-1 backdrop-blur-sm"
                style={{
                  backgroundColor: "rgba(0, 0, 0, 0.6)",
                  border: "1px solid rgba(255, 255, 255, 0.06)",
                }}
              >
                <div
                  className="max-w-[280px] truncate text-[11px] font-medium"
                  style={{ color: "#e4e4e7" }}
                  title={activeSegment.fileName}
                >
                  {middleEllipsis(activeSegment.fileName, 42)}
                </div>
                <div className="text-[9px]" style={{ color: "#a1a1aa" }}>
                  {fmtTimecode(activeSegment.startMs)} –{" "}
                  {fmtTimecode(activeSegment.endMs)}
                </div>
              </div>
            )}
            {/* Direction badge — Ken Burns applies to images only (v5.0). */}
            {activeSegment && kenBurns.enabled && !activeIsVideo && (
              <div
                className="pointer-events-none absolute right-2 top-2 rounded px-1.5 py-0.5 text-[9px] capitalize backdrop-blur-sm"
                style={{
                  backgroundColor: "rgba(0, 0, 0, 0.6)",
                  color: "#c4b5fd",
                  border: "1px solid rgba(196, 181, 253, 0.15)",
                }}
              >
                ⟶ {activeSegment.direction}
              </div>
            )}
            {/* v5.0: VIDEO base chip — cover-fit playback, no Ken Burns. */}
            {activeIsVideo && (
              <div
                className="pointer-events-none absolute right-2 top-8 flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide backdrop-blur-sm"
                style={{
                  backgroundColor: "rgba(0, 0, 0, 0.55)",
                  color: "#67e8f9",
                  border: "1px solid rgba(103, 232, 249, 0.25)",
                }}
                title="Video clip — cover-fit playback (no Ken Burns); clip audio is mixed by the desktop export"
              >
                <Video className="size-3" />
                video
              </div>
            )}
            {/* Active transition indicator (v4.3) — v5.1: moved to the
                bottom-center so the aspect chip owns the bottom-right. */}
            {txLabel && (
              <div
                className="pointer-events-none absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-medium capitalize backdrop-blur-sm ff-tx-live"
                style={{
                  backgroundColor: "rgba(0, 0, 0, 0.55)",
                  color: "#f0abfc",
                  border: "1px solid rgba(240, 171, 252, 0.25)",
                }}
                title={`Transition playing — ${(activeTxFx?.p ?? 0).toFixed(2)} progress`}
              >
                <ArrowLeftRight className="size-3" />
                {txLabel}
              </div>
            )}
            {/* v5.1 CapCut: aspect label chip — bottom-right of the stage. */}
            <div
              className="pointer-events-none absolute bottom-2 right-2 flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wide backdrop-blur-sm"
              style={{
                backgroundColor: "rgba(0, 0, 0, 0.55)",
                color: "#a5f3fc",
                border: "1px solid rgba(103, 232, 249, 0.22)",
              }}
              title={`Preview aspect ratio ${aspect} — ${dims.w}×${dims.h} canvas`}
            >
              {aspect}
            </div>
            {/* Watermark indicator (v4.4) */}
            {watermarkImage && watermarkSettings && (
              <div
                className="pointer-events-none absolute left-2 top-12 flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] backdrop-blur-sm"
                style={{
                  backgroundColor: "rgba(0, 0, 0, 0.55)",
                  color: "#86efac",
                  border: "1px solid rgba(134, 239, 172, 0.22)",
                }}
                title={`Watermark active — ${watermarkSettings.position}, ${watermarkSettings.sizePercent}% width, ${watermarkSettings.opacity}% opacity`}
              >
                <BadgeCheck className="size-3" />
                watermark
              </div>
            )}
            {/* Headline indicator (v4.2) */}
            {headlineItems.length > 0 && (
              <div
                className="pointer-events-none absolute bottom-2 left-2 flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] backdrop-blur-sm"
                style={{
                  backgroundColor: "rgba(0, 0, 0, 0.55)",
                  color: "#fbbf24",
                  border: "1px solid rgba(251, 191, 36, 0.2)",
                }}
                title={`${headlineItems.length} headline overlay item${
                  headlineItems.length === 1 ? "" : "s"
                } on the timeline`}
              >
                <Type className="size-3" />
                {headlineItems.length} headline
                {headlineItems.length === 1 ? "" : "s"}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Transport */}
      <div
        className="border-t px-4 py-3"
        style={{
          borderColor: "#27272a",
          backgroundColor: "#111113",
          boxShadow: "0 -8px 24px rgba(0, 0, 0, 0.35)",
        }}
      >
        {/* v5.1 CapCut: centered transport cluster — 28px step buttons,
            a 36px round cyan play button at the row's visual center, and
            the timecode chip pinned to the right edge (out of flow) so it
            never pushes the cluster off-center. */}
        <div className="relative mb-2 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => onStep(-1)}
            disabled={segments.length === 0}
            className="flex size-7 items-center justify-center rounded-lg transition-all hover:bg-white/10 hover:text-zinc-200 hover:shadow-[0_0_12px_rgba(228,228,231,0.08)] active:scale-90 disabled:opacity-30 disabled:hover:shadow-none"
            style={{ color: "#a1a1aa" }}
            title="Previous segment (Shift+←)"
            aria-label="Previous segment"
          >
            <SkipBack className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={onTogglePlay}
            disabled={segments.length === 0}
            className="flex size-9 items-center justify-center rounded-full text-white shadow-lg transition-all duration-150 hover:scale-105 hover:brightness-110 hover:shadow-[0_6px_24px_rgba(6,182,212,0.6)] active:scale-95 disabled:opacity-30 disabled:hover:scale-100 disabled:hover:brightness-100"
            style={{
              background: "linear-gradient(135deg, #22d3ee 0%, #0891b2 60%, #0e7490 100%)",
              boxShadow:
                "0 4px 16px rgba(6, 182, 212, 0.45), inset 0 1px 0 rgba(255,255,255,0.25)",
            }}
            title={isPlaying ? "Pause (Space)" : "Play (Space)"}
            aria-label={isPlaying ? "Pause playback" : "Play playback"}
          >
            {isPlaying ? (
              <Pause className="size-[18px]" />
            ) : (
              <Play className="size-[18px] translate-x-0.5" />
            )}
          </button>
          <button
            type="button"
            onClick={() => onStep(1)}
            disabled={segments.length === 0}
            className="flex size-7 items-center justify-center rounded-lg transition-all hover:bg-white/10 hover:text-zinc-200 hover:shadow-[0_0_12px_rgba(228,228,231,0.08)] active:scale-90 disabled:opacity-30 disabled:hover:shadow-none"
            style={{ color: "#a1a1aa" }}
            title="Next segment (Shift+→)"
            aria-label="Next segment"
          >
            <SkipForward className="size-3.5" />
          </button>

          {/* Time display — tabular mono chip, pinned right. */}
          <div
            className="absolute right-0 top-1/2 -translate-y-1/2 rounded-md border px-2 py-0.5 font-mono text-[11px] tabular-nums"
            style={{
              borderColor: "#27272a",
              backgroundColor: "#18181b",
            }}
          >
            <span style={{ color: "#e4e4e7" }}>
              {fmtTenths(currentMs)}
            </span>
            <span className="mx-0.5" style={{ color: "#52525b" }}>
              /
            </span>
            <span style={{ color: "#8b8b93" }}>
              {fmtTenths(totalMs)}
            </span>
          </div>
        </div>

        {/* Scrubber — v5.1: cyan progress fill (matches the playhead). */}
        <div className="group relative flex items-center">
          <input
            type="range"
            min={0}
            max={Math.max(1, totalMs)}
            step={10}
            value={Math.min(currentMs, totalMs)}
            onChange={(e) => onSeek(Number(e.target.value))}
            disabled={segments.length === 0}
            className="w-full"
            style={{
              background: `linear-gradient(to right, #22d3ee ${pct}%, #0891b2 ${Math.min(
                100,
                pct + 8,
              )}%, #3f3f46 ${Math.min(100, pct + 8)}%)`,
            }}
            aria-label="Timeline scrubber"
          />
        </div>
      </div>

      {/* v5.0: host for the hidden <video> paint sources (kept in the DOM at
          2px/opacity 0 so Chromium decodes frames for canvas painting;
          React never manages the raw children of this div). */}
      <div
        ref={videoHostRef}
        aria-hidden="true"
        style={{
          position: "absolute",
          width: 2,
          height: 2,
          overflow: "hidden",
          opacity: 0,
          pointerEvents: "none",
          left: 0,
          top: 0,
          zIndex: -1,
        }}
      />
    </div>
  );
}
