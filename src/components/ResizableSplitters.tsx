"use client";

// -----------------------------------------------------------------------------
// ResizableSplitters — v5.2 (task 3-b)
// Draggable panel splitters (Shotcut/CapCut-style) for the 3-column editor
// grid and the timeline lane stack.
//
//   • Vertical col splitters: MediaPanel | center column, center | Settings
//   • Horizontal row splitter: preview area | timeline (v5 4-lane mode)
//
// All owning state lives in useResizableLayout() (exported below) so
// page.tsx only spreads the bind objects onto <Splitter /> elements.
// Dimensions persist to localStorage under "framefuse.layout.v52" —
// deliberately SEPARATE from framefuse.settings.v50: window layout is a
// workspace concern, not a user setting.
//
// State strategy: a module-level store consumed via useSyncExternalStore.
// The server/hydration snapshot is the plain default layout (no window
// access → no hydration mismatch); the first client read lazily restores
// the persisted layout + window state, and window listeners keep the
// compact fallback (<1024px) and the timeline 65% cap in sync.
//
// Interaction contract:
//   • Pointer drag via setPointerCapture — 6px hit gutter, centered 1px line
//     that glows cyan (#22d3ee) on hover/drag.
//   • Snap: within 24px of the default → snap to default (highlighted while
//     the snap is engaged). Double-click → reset to default.
//   • Keyboard: arrows ±16px (Shift ±64px), Home = min, End = max,
//     Enter/Space deliberate no-op. Focus ring + live size chip.
//   • While dragging, <body> gains .ff-resizing (+ direction class) so the
//     whole app disables text selection and shows the resize cursor.
// -----------------------------------------------------------------------------

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

// ---- Public constants -------------------------------------------------------

/** Full width/height of a splitter gutter (px). 6px hit area, 1px visible. */
export const SPLITTER_W = 6;

// ---- Tunables ---------------------------------------------------------------

/** Drag within this distance of the default snaps to the default. */
const SNAP_PX = 24;
/** Keyboard step (px). Shift multiplies to the large step. */
const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

// Dimension ranges (task 3-b spec).
const MEDIA = { min: 220, max: 560, def: 300 } as const;
const SETTINGS = { min: 260, max: 640, def: 320 } as const;
const TIMELINE = { min: 150, def: 300 } as const;

/** Timeline height cap: 65% of the viewport (never below the min). */
const timelineMaxFor = (viewportH: number): number =>
  viewportH > 0
    ? Math.max(TIMELINE.min, Math.round(viewportH * 0.65))
    : Math.max(TIMELINE.min, TIMELINE.def);

/** localStorage key — layout concern, separate from framefuse.settings.v50. */
const LS_KEY = "framefuse.layout.v52";
/** Debounce for layout writes (ms). */
const LS_DEBOUNCE = 300;
/** Below 1024px of window width page.tsx reverts to the fixed v5.1 grid. */
const DESKTOP_QUERY = "(min-width: 1024px)";

// ---- Splitter ----------------------------------------------------------------

/** Everything <Splitter /> needs — produced by useResizableLayout(). */
export interface SplitterBind {
  /** Visual orientation of the divider line ("vertical" = col-resize). */
  orientation: "vertical" | "horizontal";
  /** Pointer axis tracked while dragging. */
  axis: "x" | "y";
  /** +1: value grows when the pointer moves in +axis direction; else −1. */
  sign: 1 | -1;
  /** Current dimension value (px). */
  value: number;
  min: number;
  max: number;
  /** Default value — snap target + double-click reset. */
  defaultValue: number;
  /** Accessible name, e.g. "Resize media panel". */
  label: string;
  onChange: (v: number) => void;
}

/**
 * A single draggable separator. Render as a grid child (vertical, sits in
 * its own 6px track) or as a flex child (horizontal, 6px tall, shrink-0).
 * Styling lives in globals.css (.ff-splitter*).
 */
export function Splitter({
  orientation,
  axis,
  sign,
  value,
  min,
  max,
  defaultValue,
  label,
  onChange,
}: SplitterBind) {
  const dragRef = useRef<{ id: number; start: number; value: number } | null>(
    null,
  );
  const [dragging, setDragging] = useState(false);
  const [snapped, setSnapped] = useState(false);
  const [focused, setFocused] = useState(false);

  const clamp = useCallback(
    (v: number) => Math.min(max, Math.max(min, v)),
    [min, max],
  );
  const snapToDefault = useCallback(
    (v: number) => (Math.abs(v - defaultValue) <= SNAP_PX ? defaultValue : v),
    [defaultValue],
  );

  const setBodyResize = useCallback(
    (on: boolean) => {
      document.body.classList.toggle("ff-resizing", on);
      document.body.classList.toggle(
        orientation === "vertical" ? "ff-resizing-col" : "ff-resizing-row",
        on,
      );
    },
    [orientation],
  );

  // Safety: if the splitter unmounts mid-drag, still release the body class.
  useEffect(
    () => () => {
      if (dragRef.current) {
        dragRef.current = null;
        document.body.classList.remove(
          "ff-resizing",
          "ff-resizing-col",
          "ff-resizing-row",
        );
      }
    },
    [],
  );

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // pointer already gone — drag simply won't capture; safe to continue
    }
    dragRef.current = {
      id: e.pointerId,
      value,
      start: axis === "x" ? e.clientX : e.clientY,
    };
    setDragging(true);
    setBodyResize(true);
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    const pos = axis === "x" ? e.clientX : e.clientY;
    const raw = clamp(d.value + sign * (pos - d.start));
    const next = snapToDefault(raw);
    setSnapped(next === defaultValue);
    if (next !== value) onChange(next);
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    setSnapped(false);
    setBodyResize(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // capture already released by the browser (pointercancel path)
    }
  };

  // Keyboard mapping mirrors the visual direction of the separator:
  //   x-axis: ArrowRight moves the separator right (value += sign·step)
  //   y-axis: ArrowUp moves the separator up    (value −= sign·step)
  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    switch (e.key) {
      case "ArrowLeft":
        if (axis !== "x") return;
        e.preventDefault();
        onChange(clamp(value - sign * step));
        break;
      case "ArrowRight":
        if (axis !== "x") return;
        e.preventDefault();
        onChange(clamp(value + sign * step));
        break;
      case "ArrowUp":
        if (axis !== "y") return;
        e.preventDefault();
        onChange(clamp(value - sign * step));
        break;
      case "ArrowDown":
        if (axis !== "y") return;
        e.preventDefault();
        onChange(clamp(value + sign * step));
        break;
      case "Home":
        e.preventDefault();
        onChange(min);
        break;
      case "End":
        e.preventDefault();
        onChange(max);
        break;
      case "Enter":
      case " ":
      case "Spacebar":
        // Deliberate no-op — keeps focus, prevents page scroll.
        e.preventDefault();
        break;
      default:
        return;
    }
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={orientation}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      data-dragging={dragging || undefined}
      data-snap={snapped || undefined}
      className={`ff-splitter ${
        orientation === "vertical" ? "ff-splitter-col" : "ff-splitter-row"
      }`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => onChange(defaultValue)}
      onKeyDown={handleKeyDown}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      {/* 1px visible line (zinc-700 → cyan on hover/drag — see globals.css) */}
      <span className="ff-splitter-line" aria-hidden="true" />
      {/* grip texture: 3 dots, zinc-500 */}
      <span className="ff-splitter-grip" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {/* live size chip while dragging or keyboard-focused */}
      {(dragging || focused) && (
        <span className="ff-splitter-chip" aria-hidden="true">
          {Math.round(value)} px
        </span>
      )}
    </div>
  );
}

// ---- Layout store (useSyncExternalStore) -------------------------------------

/** The three persisted dimensions (px). */
interface LayoutDims {
  mediaW: number;
  settingsW: number;
  timelineH: number;
}

/** Full store snapshot: dims + window state. */
interface LayoutStore {
  dims: LayoutDims;
  compact: boolean;
  viewportH: number;
}

/** Server/hydration snapshot — plain defaults, no window access. */
const SERVER_SNAPSHOT: LayoutStore = {
  dims: { mediaW: MEDIA.def, settingsW: SETTINGS.def, timelineH: TIMELINE.def },
  compact: false,
  viewportH: 0,
};

/** localStorage payload (unknown-typed — validated on read). */
interface StoredLayout {
  mediaW?: unknown;
  settingsW?: unknown;
  timelineH?: unknown;
}

/** Coerce a value into a finite clamped integer, or null if invalid. */
function readNum(v: unknown, min: number, max: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/** Restore the persisted layout, clamped to valid ranges; defaults on any
 *  parse/storage error (task 3-b persistence contract). Client-only. */
function loadDims(): LayoutDims {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoredLayout;
      const m = readNum(parsed.mediaW, MEDIA.min, MEDIA.max);
      const s = readNum(parsed.settingsW, SETTINGS.min, SETTINGS.max);
      const t = readNum(
        parsed.timelineH,
        TIMELINE.min,
        timelineMaxFor(window.innerHeight),
      );
      if (m != null || s != null || t != null) {
        return {
          mediaW: m ?? MEDIA.def,
          settingsW: s ?? SETTINGS.def,
          timelineH: t ?? TIMELINE.def,
        };
      }
    }
  } catch {
    // corrupt payload / storage unavailable → defaults
  }
  return {
    mediaW: MEDIA.def,
    settingsW: SETTINGS.def,
    timelineH: TIMELINE.def,
  };
}

const listeners = new Set<() => void>();
let cache: LayoutStore | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** Client snapshot — lazily restores the persisted layout on first read. */
function snapshot(): LayoutStore {
  if (cache === null) {
    cache = {
      dims: loadDims(),
      compact: !window.matchMedia(DESKTOP_QUERY).matches,
      viewportH: window.innerHeight,
    };
  }
  return cache;
}

function getServerSnapshot(): LayoutStore {
  return SERVER_SNAPSHOT;
}

/** Debounced persist of the current dims (task 3-b: ~300ms). */
function schedulePersist(dims: LayoutDims): void {
  if (persistTimer != null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(dims));
    } catch {
      // storage full/blocked → layout stays session-only
    }
  }, LS_DEBOUNCE);
}

/** Publish a store update; dims changes re-arm the debounced persist. */
function update(patch: Partial<LayoutStore>): void {
  const prev = snapshot();
  const next = { ...prev, ...patch };
  if (next.dims !== prev.dims) schedulePersist(next.dims);
  cache = next;
  listeners.forEach((l) => l());
}

/** Change dimensions (callers clamp; readNum re-validates defensively). */
function setDim(patch: Partial<LayoutDims>): void {
  const cur = snapshot().dims;
  const next = { ...cur, ...patch };
  if (
    next.mediaW === cur.mediaW &&
    next.settingsW === cur.settingsW &&
    next.timelineH === cur.timelineH
  ) {
    return;
  }
  update({ dims: next });
}

/** Subscribe for store updates; the first subscriber attaches the window
 *  listeners (compact fallback + timeline cap re-clamp on viewport changes). */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  let detach: (() => void) | null = null;
  if (listeners.size === 1) {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const sync = () => {
      const compact = !mq.matches;
      const viewportH = window.innerHeight;
      const cur = snapshot();
      const cap = timelineMaxFor(viewportH);
      const dims =
        cur.dims.timelineH > cap ? { ...cur.dims, timelineH: cap } : cur.dims;
      if (
        compact !== cur.compact ||
        viewportH !== cur.viewportH ||
        dims !== cur.dims
      ) {
        update({ compact, viewportH, dims });
      }
    };
    mq.addEventListener("change", sync);
    window.addEventListener("resize", sync);
    detach = () => {
      mq.removeEventListener("change", sync);
      window.removeEventListener("resize", sync);
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && detach) {
      detach();
    }
  };
}

// ---- Layout hook --------------------------------------------------------------

/** Snapshot returned by useResizableLayout(). */
export interface ResizableLayout {
  /** true below 1024px window width — fixed v5.1 layout, splitters hidden. */
  compact: boolean;
  mediaW: number;
  settingsW: number;
  timelineH: number;
  /** Ready-to-use gridTemplateColumns for the 3-panel editor grid. */
  gridTemplateColumns: string;
  /** Spread onto <Splitter /> between MediaPanel and the center column. */
  media: SplitterBind;
  /** Spread onto <Splitter /> between the center column and SettingsPanel. */
  settings: SplitterBind;
  /** Spread onto <Splitter /> between the preview and the timeline. */
  timeline: SplitterBind;
}

/**
 * Owns the resizable editor layout: panel widths + timeline height, restored
 * from localStorage (clamped, defaults on parse errors), persisted debounced,
 * re-clamped when the viewport shrinks, with a <1024px compact fallback.
 * page.tsx spreads the bind objects onto <Splitter /> elements.
 */
export function useResizableLayout(): ResizableLayout {
  const { dims, compact, viewportH } = useSyncExternalStore(
    subscribe,
    snapshot,
    getServerSnapshot,
  );

  // Stable setters (module store absorbs the writes).
  const setMediaW = useCallback((v: number) => {
    setDim({ mediaW: readNum(v, MEDIA.min, MEDIA.max) ?? MEDIA.def });
  }, []);
  const setSettingsW = useCallback((v: number) => {
    setDim({
      settingsW: readNum(v, SETTINGS.min, SETTINGS.max) ?? SETTINGS.def,
    });
  }, []);
  const setTimelineH = useCallback((v: number) => {
    setDim({
      timelineH:
        readNum(v, TIMELINE.min, timelineMaxFor(snapshot().viewportH)) ??
        TIMELINE.def,
    });
  }, []);

  const gridTemplateColumns = compact
    ? "300px 1fr 320px"
    : `${dims.mediaW}px ${SPLITTER_W}px 1fr ${SPLITTER_W}px ${dims.settingsW}px`;

  return {
    compact,
    mediaW: dims.mediaW,
    settingsW: dims.settingsW,
    timelineH: dims.timelineH,
    gridTemplateColumns,
    media: {
      orientation: "vertical",
      axis: "x",
      sign: 1, // drag right → wider media panel
      value: dims.mediaW,
      min: MEDIA.min,
      max: MEDIA.max,
      defaultValue: MEDIA.def,
      label: "Resize media panel",
      onChange: setMediaW,
    },
    settings: {
      orientation: "vertical",
      axis: "x",
      sign: -1, // drag left → wider settings panel
      value: dims.settingsW,
      min: SETTINGS.min,
      max: SETTINGS.max,
      defaultValue: SETTINGS.def,
      label: "Resize settings panel",
      onChange: setSettingsW,
    },
    timeline: {
      orientation: "horizontal",
      axis: "y",
      sign: -1, // drag up → taller timeline
      value: dims.timelineH,
      min: TIMELINE.min,
      max: timelineMaxFor(viewportH),
      defaultValue: TIMELINE.def,
      label: "Resize timeline",
      onChange: setTimelineH,
    },
  };
}
