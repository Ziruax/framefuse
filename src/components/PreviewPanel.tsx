"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  ImageOff,
  Type,
  ArrowLeftRight,
  BadgeCheck,
  Crosshair,
  Video,
  Scan,
  MoveDiagonal,
  Maximize,
  Move,
} from "lucide-react";
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

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Overlay rect in BUFFER pixels (the canvas coordinate space). */
interface OverlayGeo {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

// ---------------------------------------------------------------------------
// v5.2 — on-canvas overlay manipulation (CapCut-style PiP)
// ---------------------------------------------------------------------------

type CornerId = "tl" | "tr" | "bl" | "br";

const CORNER_DEFS: Array<{ id: CornerId; fx: 0 | 1; fy: 0 | 1 }> = [
  { id: "tl", fx: 0, fy: 0 },
  { id: "tr", fx: 1, fy: 0 },
  { id: "bl", fx: 0, fy: 1 },
  { id: "br", fx: 1, fy: 1 },
];

/** Drawn handle size (CSS px) and the slightly larger touch/mouse hit
 *  radius around each corner. */
const HANDLE_DRAW_PX = 10;
const HANDLE_HIT_PX = 13;

/** Center-snap distance (CSS px) — dragging within this of the canvas
 *  center snaps x/y to exactly 0.5 with a dashed guide. */
const SNAP_CSS_PX = 8;

/** Live drag feedback state — renders immediately (the draw effect and the
 *  chrome canvas both consume it); committed to the data model on pointerup. */
interface DragLive {
  segId: string;
  transform: OverlayTransform;
  snapX: boolean;
  snapY: boolean;
}

/** An in-flight pointer gesture (kept in a ref so pointermove/up and the
 *  window-level Esc cancel can always see the latest state). */
type Gesture =
  | {
      kind: "move";
      segId: string;
      pointerId: number;
      base: OverlayTransform;
      startBufX: number;
      startBufY: number;
      origCx: number;
      origCy: number;
      transform: OverlayTransform;
      snapX: boolean;
      snapY: boolean;
    }
  | {
      kind: "resize";
      segId: string;
      pointerId: number;
      base: OverlayTransform;
      /** Buffer-px coords of the FIXED (opposite) corner. */
      oppositeX: number;
      oppositeY: number;
      /** Which side of the anchor the dragged corner lives on. */
      signX: number;
      signY: number;
      /** dh / dw — the overlay's source aspect (kept during resize). */
      aspect: number;
      transform: OverlayTransform;
      snapX: boolean;
      snapY: boolean;
    };

function cornerPoint(g: OverlayGeo, c: { fx: 0 | 1; fy: 0 | 1 }): { x: number; y: number } {
  return { x: g.dx + c.fx * g.dw, y: g.dy + c.fy * g.dh };
}

function oppositeCornerDef(c: { fx: 0 | 1; fy: 0 | 1 }): { fx: 0 | 1; fy: 0 | 1 } {
  return { fx: (1 - c.fx) as 0 | 1, fy: (1 - c.fy) as 0 | 1 };
}

/** Field-wise equality for the override cleanup (page applied our commit →
 *  props become authoritative). */
function sameTransform(
  a: OverlayTransform | null | undefined,
  b: OverlayTransform,
): boolean {
  if (!a) return false;
  return (
    a.scalePercent === b.scalePercent &&
    a.position === b.position &&
    (a.x ?? undefined) === (b.x ?? undefined) &&
    (a.y ?? undefined) === (b.y ?? undefined)
  );
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
  // ---- v5.2 preview overhaul (all optional so the app compiles unwired) ----
  /** Preview fit mode for the BASE video draw. "cover" (default) crops the
   *  source to fill the frame — exactly what the export does; "contain"
   *  letterboxes the whole source inside the frame (preview-only). When the
   *  prop is absent the panel keeps an internal toggle state. */
  previewFit?: "cover" | "contain";
  /** Fired when the user flips the Fit/Fill toolbar toggle. */
  onPreviewFitChange?: (fit: "cover" | "contain") => void;
  /** "Match source aspect" — set the project aspect to the active video's
   *  intrinsic frame (page.tsx owns the actual aspect change). */
  onMatchAspect?: () => void;
  /** Whether matching makes sense right now (e.g. an active video whose
   *  aspect differs from the project). Button renders disabled when false. */
  canMatchAspect?: boolean;
  /** v5.2 PiP: commit an on-canvas overlay edit (drag / corner-resize /
   *  keyboard nudge). Receives the FULL new transform; the `position`
   *  field is kept as-is (x/y override it downstream in overlayGeometry). */
  onOverlayTransformChange?: (segId: string, transform: OverlayTransform) => void;
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
  previewFit,
  onPreviewFitChange,
  onMatchAspect,
  canMatchAspect,
  onOverlayTransformChange,
}: PreviewPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chromeRef = useRef<HTMLCanvasElement | null>(null);
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

  // ---- v5.2 A: responsive stage ---------------------------------------------
  // The wrapper (flex-1 min-h-0, p-4) is measured with a ResizeObserver;
  // the stage letterboxes the aspect buffer inside the available box.
  const stageWrapRef = useRef<HTMLDivElement | null>(null);
  const [avail, setAvail] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const roRafRef = useRef<number | null>(null);
  const roPendingRef = useRef<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = stageWrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (!cr) return;
      roPendingRef.current = {
        w: Math.max(0, Math.floor(cr.width)),
        h: Math.max(0, Math.floor(cr.height)),
      };
      if (roRafRef.current != null) return;
      // rAF-gated: coalesce observer storms (panel splitter drags) into one
      // layout write per frame.
      roRafRef.current = requestAnimationFrame(() => {
        roRafRef.current = null;
        const p = roPendingRef.current;
        roPendingRef.current = null;
        if (p) setAvail((prev) => (prev.w === p.w && prev.h === p.h ? prev : p));
      });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (roRafRef.current != null) cancelAnimationFrame(roRafRef.current);
      roRafRef.current = null;
      roPendingRef.current = null;
    };
  }, []);

  /** Contain-fit stage size (CSS px). Falls back to a sane pre-measurement
   *  size; guards 0/NaN and keeps a 120px floor. */
  const stage = useMemo(() => {
    const aw = avail.w;
    const ah = avail.h;
    if (aw >= 40 && ah >= 40) {
      const scale = Math.min(aw / dims.w, ah / dims.h);
      if (Number.isFinite(scale) && scale > 0) {
        return {
          w: Math.max(120, Math.floor(dims.w * scale)),
          h: Math.max(120, Math.floor(dims.h * scale)),
        };
      }
    }
    const s = Math.min(640 / dims.w, 480 / dims.h);
    return {
      w: Math.max(120, Math.floor(dims.w * s)),
      h: Math.max(120, Math.floor(dims.h * s)),
    };
  }, [avail.w, avail.h, dims.w, dims.h]);

  // ---- v5.2 B: Fit/Fill preview mode ----------------------------------------
  // Prop-driven when page.tsx wires previewFit; internal fallback otherwise
  // so the toggle still works unwired.
  const [fitLocal, setFitLocal] = useState<"cover" | "contain">("cover");
  const fitMode: "cover" | "contain" = previewFit ?? fitLocal;
  const setFitMode = (f: "cover" | "contain") => {
    if (previewFit == null) setFitLocal(f);
    onPreviewFitChange?.(f);
  };

  // ---- v5.2 C: overlay selection + local transform overrides ----------------
  // Selection is DERIVED (no effect — the playhead tick stays render-cheap):
  // a canvas/keyboard pick wins while its clip is visible at the playhead;
  // otherwise the timeline-active segment is adopted when it is an
  // overlay-lane clip visible at the playhead (unless the user explicitly
  // dismissed that exact clip on the canvas); else null (auto-clears when
  // the window ends).
  const [overlaySel, setOverlaySel] = useState<{
    id: string | null;
    dismissedActive: string | null;
  }>({ id: null, dismissedActive: null });
  // Committed on-canvas edits. Used for rendering whenever the resolved
  // segment hasn't caught up yet (unwired page / async apply) — dropped by
  // the cleanup effect below once the segment carries the same transform.
  const [overlayOverrides, setOverlayOverrides] = useState<
    Record<string, { t: OverlayTransform; at: number }>
  >({});
  const [dragTransform, setDragTransform] = useState<DragLive | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  // Set while a pointer gesture owns the click — the stage's Ken Burns aim
  // onClick must not fire after an overlay drag.
  const suppressClickRef = useRef(false);

  /** Overlay-lane segments visible at the playhead (draw order). */
  const visibleOverlays = useMemo(
    () => overlaySegmentsAt(segments, currentMs),
    [segments, currentMs],
  );

  const adoptId =
    activeSegment &&
    activeSegment.track >= 1 &&
    currentMs >= activeSegment.startMs &&
    currentMs < activeSegment.endMs
      ? activeSegment.id
      : null;

  const overlaySelectionId = useMemo(() => {
    if (overlaySel.id != null && visibleOverlays.some((s) => s.id === overlaySel.id)) {
      return overlaySel.id;
    }
    if (adoptId != null && adoptId !== overlaySel.dismissedActive) return adoptId;
    return null;
  }, [overlaySel, adoptId, visibleOverlays]);

  const sourceFor = (seg: MediaSegment): VideoFrameSource | null =>
    seg.mediaType === "video"
      ? videoElsRef.current.get(seg.id) ?? null
      : images[seg.id] ?? null;

  const effectiveTransform = (seg: MediaSegment): OverlayTransform => {
    if (dragTransform && dragTransform.segId === seg.id) return dragTransform.transform;
    const ov = overlayOverrides[seg.id];
    if (ov) return ov.t;
    return seg.overlay ?? DEFAULT_OVERLAY_TRANSFORM;
  };

  const geometryFor = (seg: MediaSegment, t: OverlayTransform): OverlayGeo | null => {
    const src = sourceFor(seg);
    if (!src) return null;
    const sd = sourceDims(src);
    if (sd.w <= 0 || sd.h <= 0) return null;
    const g = overlayGeometry(dims.w, dims.h, sd.w, sd.h, t);
    return g.dw > 0 && g.dh > 0 ? g : null;
  };

  const commitTransform = (segId: string, t: OverlayTransform) => {
    setOverlayOverrides((prev) =>
      prev[segId]?.t === t ? prev : { ...prev, [segId]: { t, at: Date.now() } },
    );
    onOverlayTransformChange?.(segId, t);
  };

  // Override cleanup — drop entries whose segment is gone, whose segment
  // now carries the SAME transform (the page applied our commit → props are
  // authoritative), or — in wired mode — whose segment carries a DIFFERENT
  // authoritative transform a moment after our commit (page writes arrived;
  // e.g. the user re-tuned the overlay from SettingsPanel).
  useEffect(() => {
    const ids = Object.keys(overlayOverrides);
    if (ids.length === 0) return;
    const timer = window.setTimeout(() => {
      setOverlayOverrides((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const id of Object.keys(prev)) {
          const seg = segments.find((s) => s.id === id);
          if (!seg) {
            delete next[id];
            changed = true;
            continue;
          }
          if (sameTransform(seg.overlay, prev[id].t)) {
            delete next[id];
            changed = true;
            continue;
          }
          if (onOverlayTransformChange && seg.overlay != null) {
            delete next[id];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [segments, overlayOverrides, onOverlayTransformChange]);

  // Esc cancels an in-flight drag (window capture so it works regardless of
  // focus); restores the segment's pre-gesture transform.
  const dragging = dragTransform != null;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      gestureRef.current = null;
      setDragTransform(null);
      if (canvasRef.current) canvasRef.current.style.cursor = "";
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dragging]);

  // ---- v5.2 C: hit testing + pointer gestures --------------------------------
  /** Overlay geometry list at the playhead, TOPMOST first (reverse draw
   *  order) — the hit-test priority. */
  const hitList = (): Array<{ seg: MediaSegment; g: OverlayGeo }> => {
    const out: Array<{ seg: MediaSegment; g: OverlayGeo }> = [];
    for (let i = visibleOverlays.length - 1; i >= 0; i--) {
      const seg = visibleOverlays[i];
      const g = geometryFor(seg, effectiveTransform(seg));
      if (g) out.push({ seg, g });
    }
    return out;
  };

  const hitCorner = (
    g: OverlayGeo,
    bufX: number,
    bufY: number,
    cssPerBuf: number,
  ): { id: CornerId; fx: 0 | 1; fy: 0 | 1 } | null => {
    const r = HANDLE_HIT_PX / Math.max(cssPerBuf, 1e-4); // CSS px → buffer px
    for (const c of CORNER_DEFS) {
      const p = cornerPoint(g, c);
      if (Math.abs(bufX - p.x) <= r && Math.abs(bufY - p.y) <= r) return c;
    }
    return null;
  };

  const bufCoords = (
    canvas: HTMLCanvasElement,
    e: ReactPointerEvent<HTMLCanvasElement>,
  ): { bufX: number; bufY: number; rect: DOMRect } | null => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return null;
    const bufX = (e.clientX - rect.left) * (dims.w / rect.width);
    const bufY = (e.clientY - rect.top) * (dims.h / rect.height);
    if (!Number.isFinite(bufX) || !Number.isFinite(bufY)) return null;
    return { bufX, bufY, rect };
  };

  const onCanvasPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bc = bufCoords(canvas, e);
    if (!bc) return;
    const { bufX, bufY, rect } = bc;
    const list = hitList();

    // 1) resize handles of the SELECTED overlay
    const sel = list.find((h) => h.seg.id === overlaySelectionId);
    if (sel) {
      const corner = hitCorner(sel.g, bufX, bufY, rect.width / dims.w);
      if (corner) {
        const opp = cornerPoint(sel.g, oppositeCornerDef(corner));
        const dragged = cornerPoint(sel.g, corner);
        const base = effectiveTransform(sel.seg);
        gestureRef.current = {
          kind: "resize",
          segId: sel.seg.id,
          pointerId: e.pointerId,
          base,
          oppositeX: opp.x,
          oppositeY: opp.y,
          signX: dragged.x >= opp.x ? 1 : -1,
          signY: dragged.y >= opp.y ? 1 : -1,
          aspect: sel.g.dh / Math.max(1, sel.g.dw),
          transform: base,
          snapX: false,
          snapY: false,
        };
        setOverlaySel({ id: sel.seg.id, dismissedActive: null });
        suppressClickRef.current = true;
        canvas.style.cursor =
          corner.id === "tl" || corner.id === "br" ? "nwse-resize" : "nesw-resize";
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch {
          /* capture unavailable — gesture still works via bubbling */
        }
        return;
      }
    }

    // 2) rect containment — topmost drawn wins; click-to-select
    const inside = list.find(
      (h) =>
        bufX >= h.g.dx &&
        bufX <= h.g.dx + h.g.dw &&
        bufY >= h.g.dy &&
        bufY <= h.g.dy + h.g.dh,
    );
    if (inside) {
      const base = effectiveTransform(inside.seg);
      gestureRef.current = {
        kind: "move",
        segId: inside.seg.id,
        pointerId: e.pointerId,
        base,
        startBufX: bufX,
        startBufY: bufY,
        origCx: inside.g.dx + inside.g.dw / 2,
        origCy: inside.g.dy + inside.g.dh / 2,
        transform: base,
        snapX: false,
        snapY: false,
      };
      setOverlaySel({ id: inside.seg.id, dismissedActive: null });
      suppressClickRef.current = true;
      canvas.style.cursor = "grabbing";
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* capture unavailable — gesture still works via bubbling */
      }
      return;
    }

    // 3) empty canvas — clear the overlay selection and let the existing
    //    click behavior (Ken Burns aim etc.) run. `dismissedActive` blocks
    //    re-adoption of the timeline-active overlay until it changes.
    if (overlaySelectionId != null) {
      setOverlaySel({ id: null, dismissedActive: overlaySelectionId });
    }
  };

  const onCanvasPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const g0 = gestureRef.current;
    if (g0) {
      if (g0.pointerId !== e.pointerId) return;
      const bc = bufCoords(canvas, e);
      if (!bc) return;
      const { bufX, bufY, rect } = bc;
      if (g0.kind === "move") {
        let cx = g0.origCx + (bufX - g0.startBufX);
        let cy = g0.origCy + (bufY - g0.startBufY);
        // Center snap (8 CSS px, converted to buffer px) + dashed guide.
        const snapBuf = SNAP_CSS_PX * (dims.w / Math.max(1, rect.width));
        const snapX = Math.abs(cx - dims.w / 2) <= snapBuf;
        const snapY = Math.abs(cy - dims.h / 2) <= snapBuf;
        if (snapX) cx = dims.w / 2;
        if (snapY) cy = dims.h / 2;
        const t: OverlayTransform = {
          ...g0.base,
          x: clamp01(cx / dims.w),
          y: clamp01(cy / dims.h),
        };
        g0.transform = t;
        g0.snapX = snapX;
        g0.snapY = snapY;
        setDragTransform({ segId: g0.segId, transform: t, snapX, snapY });
      } else {
        // Corner resize — the OPPOSITE corner stays anchored, so the new
        // width is the dragged corner's horizontal distance to it (this is
        // exactly |pointer.x − anchor.x|, continuous at gesture start — a
        // 2× factor would double the width on grab). Aspect is preserved
        // automatically since dh derives from dw.
        const rawW = Math.abs(bufX - g0.oppositeX);
        const sp = clamp((rawW / dims.w) * 100, 10, 100);
        const w = (dims.w * sp) / 100;
        const h = w * g0.aspect;
        const cx = g0.oppositeX + g0.signX * (w / 2);
        const cy = g0.oppositeY + g0.signY * (h / 2);
        const t: OverlayTransform = {
          ...g0.base,
          scalePercent: Math.round(sp * 10) / 10,
          x: clamp01(cx / dims.w),
          y: clamp01(cy / dims.h),
        };
        g0.transform = t;
        setDragTransform({ segId: g0.segId, transform: t, snapX: false, snapY: false });
      }
      return;
    }

    // Hover cursors (no gesture): handles → resize, rect → move.
    const bc = bufCoords(canvas, e);
    if (!bc) return;
    const { bufX, bufY, rect } = bc;
    const list = hitList();
    const sel = list.find((h) => h.seg.id === overlaySelectionId);
    if (sel) {
      const corner = hitCorner(sel.g, bufX, bufY, rect.width / dims.w);
      if (corner) {
        canvas.style.cursor =
          corner.id === "tl" || corner.id === "br" ? "nwse-resize" : "nesw-resize";
        return;
      }
    }
    const inside = list.find(
      (h) =>
        bufX >= h.g.dx &&
        bufX <= h.g.dx + h.g.dw &&
        bufY >= h.g.dy &&
        bufY <= h.g.dy + h.g.dh,
    );
    canvas.style.cursor = inside ? "move" : "";
  };

  const endGesture = (e: ReactPointerEvent<HTMLCanvasElement>, commit: boolean) => {
    const canvas = canvasRef.current;
    const g0 = gestureRef.current;
    if (!g0 || g0.pointerId !== e.pointerId) return;
    gestureRef.current = null;
    if (canvas) {
      canvas.style.cursor = "";
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    }
    setDragTransform(null);
    // A click that only SELECTED the overlay (no move/resize) must not
    // commit — it would write an identical transform (spurious undo step).
    if (commit && !sameTransform(g0.base, g0.transform)) {
      commitTransform(g0.segId, g0.transform);
    }
    // The click that follows a drag belongs to the gesture, not the aim.
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  };

  // ---- v5.2 C: keyboard nudge (stage focused + overlay selected) -------------
  const onStageKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (overlaySelectionId == null) return;
    const seg = visibleOverlays.find((s) => s.id === overlaySelectionId);
    if (!seg) return;
    const base = effectiveTransform(seg);
    const g = geometryFor(seg, base);
    if (!g) return;
    const cx = (g.dx + g.dw / 2) / dims.w;
    const cy = (g.dy + g.dh / 2) / dims.h;
    let next: OverlayTransform | null = null;
    const step = e.shiftKey ? 0.02 : 0.005;
    switch (e.key) {
      case "ArrowLeft":
        next = { ...base, x: clamp01(cx - step), y: clamp01(cy) };
        break;
      case "ArrowRight":
        next = { ...base, x: clamp01(cx + step), y: clamp01(cy) };
        break;
      case "ArrowUp":
        next = { ...base, x: clamp01(cx), y: clamp01(cy - step) };
        break;
      case "ArrowDown":
        next = { ...base, x: clamp01(cx), y: clamp01(cy + step) };
        break;
      case "+":
      case "=": {
        const sp = clamp(base.scalePercent + (e.shiftKey ? 8 : 2), 10, 100);
        next = { ...base, scalePercent: sp, x: clamp01(cx), y: clamp01(cy) };
        break;
      }
      case "-":
      case "_": {
        const sp = clamp(base.scalePercent - (e.shiftKey ? 8 : 2), 10, 100);
        next = { ...base, scalePercent: sp, x: clamp01(cx), y: clamp01(cy) };
        break;
      }
      case "Escape":
        e.stopPropagation();
        setOverlaySel({ id: null, dismissedActive: overlaySelectionId });
        return;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (next) commitTransform(seg.id, next);
  };

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
  // v5.2: the base VIDEO draw honors the Fit/Fill preview mode (contain =
  // letterbox; export stays cover), and the overlay lane renders the live
  // drag/override transform so on-canvas manipulation is immediate.
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
    // v5.2: OVERLAY LOOP — when the segment resolves overlayLoop, source time
    // wraps modulo the source duration (the preview twin of the export's
    // -stream_loop -1) so a short green-screen clip spans its whole
    // (longer) timeline window; the element itself gets loop=true so native
    // playback wraps identically.
    const syncVideoTo = (el: HTMLVideoElement, vSeg: MediaSegment | null) => {
      if (!vSeg) {
        if (!el.paused) el.pause();
        if (el.loop) el.loop = false;
        return;
      }
      const speed =
        vSeg.speed != null && Number.isFinite(vSeg.speed) && vSeg.speed > 0
          ? vSeg.speed
          : 1;
      let localMs = vSeg.trimInMs + (currentMs - vSeg.startMs) * speed;
      if (vSeg.overlayLoop) {
        const srcDurMs = Number.isFinite(vSeg.sourceDurationMs)
          ? (vSeg.sourceDurationMs ?? 0)
          : 0;
        const durMs =
          Number.isFinite(el.duration) && el.duration > 0
            ? el.duration * 1000
            : srcDurMs > 0
              ? srcDurMs
              : 0;
        if (durMs > 0) localMs = ((localMs % durMs) + durMs) % durMs;
      }
      const wantLoop = vSeg.overlayLoop === true;
      if (el.loop !== wantLoop) el.loop = wantLoop;
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
        // v5.2: the fit mode applies to BOTH base video draws.
        const fx = computeTransitionFx(segments, Math.max(0, segIdx), currentMs, transition);
        const vEl = videoEls.get(seg.id) ?? null;
        const sctx = scratchRef.current.getContext("2d", { alpha: false });
        if (fx.kind === "dip-head" && sctx) {
          drawVideoFrame(sctx, vEl, dims.w, dims.h, fitMode);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.fillStyle = fx.dipColor === "white" ? "#ffffff" : "#000000";
          ctx.fillRect(0, 0, dims.w, dims.h);
          ctx.globalAlpha = fx.p;
          ctx.drawImage(scratchRef.current, 0, 0);
          ctx.globalAlpha = 1;
        } else {
          drawVideoFrame(ctx, vEl, dims.w, dims.h, fitMode);
        }
      } else {
        const img = seg ? images[seg.id] ?? null : null;
        // v4.3: transition head composite (dissolve/slide/wipe/dip) with
        // EXACT export parity, then captions, then the global fades.
        // (Ken Burns image draws stay COVER — image content is pre-cropped
        // by design; the Fit/Fill toggle only re-frames the VIDEO base.)
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
    // exported overlay composite in lockstep. v5.2: the live drag transform
    // (and any committed local override) wins over the resolved segment
    // transform so on-canvas manipulation renders immediately.
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
        const transform: OverlayTransform =
          dragTransform && dragTransform.segId === ov.id
            ? dragTransform.transform
            : (overlayOverrides[ov.id]?.t ?? ov.overlay ?? DEFAULT_OVERLAY_TRANSFORM);
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
    // v5.2: live on-canvas overlay manipulation + preview fit mode
    dragTransform,
    overlayOverrides,
    fitMode,
  ]);

  // ---- v5.2 C: selection chrome (separate canvas, purely additive) -----------
  // Layered ABOVE the main canvas, pointer-events none — the main canvas
  // owns all interaction. Buffer = the stage's CSS size so line weights and
  // handle squares are true on-screen pixels.
  useEffect(() => {
    const c = chromeRef.current;
    if (!c) return;
    const w = Math.max(1, Math.round(stage.w));
    const h = Math.max(1, Math.round(stage.h));
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    // Center guides while a drag is snapped to the canvas center.
    if (dragTransform && (dragTransform.snapX || dragTransform.snapY)) {
      ctx.save();
      ctx.strokeStyle = "rgba(34, 211, 238, 0.8)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      if (dragTransform.snapX) {
        ctx.moveTo(Math.round(w / 2) + 0.5, 0);
        ctx.lineTo(Math.round(w / 2) + 0.5, h);
      }
      if (dragTransform.snapY) {
        ctx.moveTo(0, Math.round(h / 2) + 0.5);
        ctx.lineTo(w, Math.round(h / 2) + 0.5);
      }
      ctx.stroke();
      ctx.restore();
    }

    const segId = dragTransform?.segId ?? overlaySelectionId;
    if (segId == null) return;
    const seg = segments.find((s) => s.id === segId);
    if (!seg || seg.track < 1 || currentMs < seg.startMs || currentMs >= seg.endMs) {
      return;
    }
    const src =
      seg.mediaType === "video"
        ? videoElsRef.current.get(seg.id) ?? null
        : images[seg.id] ?? null;
    if (!src) return;
    const sd = sourceDims(src);
    if (sd.w <= 0 || sd.h <= 0) return;
    const transform: OverlayTransform =
      dragTransform && dragTransform.segId === seg.id
        ? dragTransform.transform
        : (overlayOverrides[seg.id]?.t ?? seg.overlay ?? DEFAULT_OVERLAY_TRANSFORM);
    const g = overlayGeometry(dims.w, dims.h, sd.w, sd.h, transform);
    if (g.dw <= 0 || g.dh <= 0) return;
    const k = w / dims.w; // buffer px → CSS px
    const rx = g.dx * k;
    const ry = g.dy * k;
    const rw = g.dw * k;
    const rh = g.dh * k;

    // Backdrop tint (cyan 6%).
    ctx.fillStyle = "rgba(34, 211, 238, 0.06)";
    ctx.fillRect(rx, ry, rw, rh);

    // Rect border (cyan 1.5px, kept inside the rect).
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rx + 0.75, ry + 0.75, Math.max(1, rw - 1.5), Math.max(1, rh - 1.5));

    // Corner handles — cyan fill, dark border, centered on the corners.
    ctx.fillStyle = "#22d3ee";
    ctx.strokeStyle = "rgba(12, 12, 14, 0.9)";
    ctx.lineWidth = 1;
    const half = HANDLE_DRAW_PX / 2;
    for (const cd of CORNER_DEFS) {
      const p = cornerPoint(g, cd);
      const hx = p.x * k - half;
      const hy = p.y * k - half;
      ctx.fillRect(hx, hy, HANDLE_DRAW_PX, HANDLE_DRAW_PX);
      ctx.strokeRect(hx, hy, HANDLE_DRAW_PX, HANDLE_DRAW_PX);
    }
  }, [
    dragTransform,
    overlaySelectionId,
    overlayOverrides,
    segments,
    currentMs,
    images,
    dims.w,
    dims.h,
    stage.w,
    stage.h,
    videoMetaTick,
    videoUrls,
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

  const overlaySelected =
    overlaySelectionId != null &&
    visibleOverlays.some((s) => s.id === overlaySelectionId);

  return (
    <div
      className="flex h-full flex-col overflow-hidden"
      style={{ backgroundColor: "#0c0c0e" }}
    >
      {/* Canvas stage — v5.2: the wrapper is measured (ResizeObserver) and
          the stage letterboxes the aspect buffer into the available space. */}
      <div
        ref={stageWrapRef}
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
            className="relative rounded-lg border shadow-2xl transition-shadow duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/50"
            style={{
              borderColor: "#27272a",
              backgroundColor: "#000000",
              boxShadow:
                "0 25px 50px -12px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(34, 211, 238, 0.08)",
              aspectRatio: `${dims.w} / ${dims.h}`,
              maxWidth: "100%",
              maxHeight: "100%",
              // v5.2: responsive contain-fit size (explicit px; the
              // aspectRatio above is only a fallback). Smooth 120ms resize.
              width: `${stage.w}px`,
              height: `${stage.h}px`,
              transition:
                "width 120ms ease-out, height 120ms ease-out, box-shadow 300ms ease-out",
              ...(aimActive ? { cursor: "crosshair" } : {}),
            }}
            role="img"
            aria-label={`Video preview stage — ${aspect} aspect, ${dims.w}×${dims.h} canvas${overlaySelected ? ", overlay selected: drag to move, corner handles resize" : ""}`}
            tabIndex={0}
            onKeyDown={onStageKeyDown}
            onMouseEnter={() => setCanvasHover(true)}
            onMouseMove={
              aimActive
                ? (e: ReactMouseEvent<HTMLDivElement>) => {
                    if (gestureRef.current) return; // overlay drag owns the pointer
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
                    // An overlay gesture just consumed this pointer sequence —
                    // don't re-aim Ken Burns off a drag release.
                    if (suppressClickRef.current) {
                      suppressClickRef.current = false;
                      return;
                    }
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
              style={{ touchAction: "none" }}
              onPointerDown={onCanvasPointerDown}
              onPointerMove={onCanvasPointerMove}
              onPointerUp={(e) => endGesture(e, true)}
              onPointerCancel={(e) => endGesture(e, false)}
            />
            {/* v5.2: selection chrome — purely additive overlay canvas (rect
                border, corner handles, snap guides); pointer-events none,
                the main canvas below owns all interaction. */}
            <canvas
              ref={chromeRef}
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 block size-full"
            />
            {/* v4.8: motion-aiming overlay — crosshair follows the cursor,
                the chip names the direction a click would pin. Hidden while
                an overlay drag is in flight (v5.2). */}
            {aimActive && aim && aimedDir && !dragTransform && (
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
                Click the canvas to aim this segment&apos;s motion · center = zoom in
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
            {/* v5.0: VIDEO base chip — fit-mode aware (v5.2). */}
            {activeIsVideo && (
              <div
                className="pointer-events-none absolute right-2 top-8 flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide backdrop-blur-sm"
                style={{
                  backgroundColor: "rgba(0, 0, 0, 0.55)",
                  color: "#67e8f9",
                  border: "1px solid rgba(103, 232, 249, 0.25)",
                }}
                title={
                  fitMode === "contain"
                    ? "Video clip — Fit preview (letterbox; whole source frame visible). Export still fills the frame (cover)."
                    : "Video clip — Fill preview (cover-crop, matches the export); clip audio is mixed by the desktop export"
                }
              >
                <Video className="size-3" />
                {fitMode === "contain" ? "video · fit" : "video"}
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
              title={`Preview aspect ratio ${aspect} — ${dims.w}×${dims.h} canvas, scaled to fit the panel`}
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

        {/* v5.2 PiP hint chip — below the stage while an overlay is selected. */}
        {overlaySelected && (
          <div
            className="pointer-events-none absolute bottom-1.5 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-[9px] backdrop-blur-sm"
            style={{
              backgroundColor: "rgba(0, 0, 0, 0.62)",
              color: "#67e8f9",
              border: "1px solid rgba(103, 232, 249, 0.28)",
            }}
          >
            <Move className="size-3" />
            Drag to move · corners resize · Esc deselect
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
            never pushes the cluster off-center. v5.2: the Fit/Fill +
            Match-source cluster mirrors it on the LEFT edge. */}
        <div className="relative mb-2 flex items-center justify-center gap-2">
          {/* v5.2: preview framing controls (left-pinned). */}
          <div className="absolute left-0 top-1/2 flex -translate-y-1/2 items-center gap-1">
            <button
              type="button"
              onClick={() => setFitMode(fitMode === "contain" ? "cover" : "contain")}
              disabled={segments.length === 0}
              className="flex h-7 items-center gap-1 rounded-lg px-1.5 transition-all hover:bg-white/10 hover:shadow-[0_0_12px_rgba(103,232,249,0.12)] active:scale-90 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:shadow-none"
              style={{ color: fitMode === "contain" ? "#67e8f9" : "#a1a1aa" }}
              title="Fit shows the whole frame with letterbox bars; Fill crops to cover (export behavior)"
              aria-label={
                fitMode === "contain"
                  ? "Preview framing: Fit (letterbox) — switch to Fill"
                  : "Preview framing: Fill (cover crop) — switch to Fit"
              }
              aria-pressed={fitMode === "contain"}
            >
              {fitMode === "contain" ? (
                <Scan className="size-3.5 shrink-0" />
              ) : (
                <MoveDiagonal className="size-3.5 shrink-0" />
              )}
              <span className="text-[9px] font-semibold uppercase tracking-wide">
                {fitMode === "contain" ? "Fit" : "Fill"}
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                if (canMatchAspect) onMatchAspect?.();
              }}
              disabled={!canMatchAspect}
              className="flex size-7 items-center justify-center rounded-lg transition-all hover:bg-white/10 hover:text-zinc-200 hover:shadow-[0_0_12px_rgba(228,228,231,0.08)] active:scale-90 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:shadow-none"
              style={{ color: "#a1a1aa" }}
              title="Set the project aspect to match this video's frame"
              aria-label="Match project aspect to source video"
            >
              <Maximize className="size-3.5" />
            </button>
          </div>

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
