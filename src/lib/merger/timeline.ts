// src/lib/merger/timeline.ts — filename parser + master timeline builder
//
// v5.0: multi-track. buildTimeline resolves per-item edits (itemEdits) into
// every segment: lane (track 0 = base, >= 1 = overlay), media kind, volume,
// trim, chroma and overlay geometry. The base lane keeps the v4.9 logic
// byte-for-byte; overlay items are placed absolutely (edit > parsed >
// default), never overlap-clipped and never emit warnings. Called WITHOUT
// itemEdits/videoDurations the output is functionally identical to v4.9.
import type {
  BuildTimelineResult,
  ChromaKeySettings,
  ItemEdit,
  KenBurnsConfig,
  KenBurnsDirection,
  MediaKind,
  MediaSegment,
  OverlayTransform,
  OverlapWarning,
  ParsedName,
  SegmentKind,
  TimelineMode,
} from "./types";

const DIRECTIONS: KenBurnsDirection[] = [
  "in",
  "out",
  "left",
  "right",
  "up",
  "down",
];

/** Default tail duration for the last beat-sheet segment (ms). */
const DEFAULT_BEAT_TAIL_MS = 5000;
/** Default duration for a duration-less segment in sequential mode (ms). */
const DEFAULT_DURATION_MS = 5000;

/** A finite number wins; undefined/null/NaN falls back. 0 is preserved. */
function numOr(v: number | undefined | null, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Parse a timecode like "SS", "MM:SS", or "HH:MM:SS" into milliseconds.
 * Returns 0 if any component is NaN.
 */
export function parseTimecode(tc: string): number {
  const parts = tc.split(":").map((p) => parseInt(p, 10));
  let h = 0,
    m = 0,
    s = 0;
  if (parts.length === 1) {
    s = parts[0];
  } else if (parts.length === 2) {
    m = parts[0];
    s = parts[1];
  } else {
    h = parts[0];
    m = parts[1];
    s = parts[2];
  }
  if ([h, m, s].some((n) => Number.isNaN(n))) return 0;
  return ((h * 60 + m) * 60 + s) * 1000;
}

// Three recognized filename patterns (checked in this order):
// 1. Absolute range:  [00:00:00 - 00:00:06] name.jpg
// 2. Beat-sheet:       001__Beat_1_0s_name.jpg  (start at 0s)
// 3. Duration:         10s_name.jpg             (sequential 10s clip)
const RE_ABSOLUTE =
  /\[\s*(\d{1,2}(?::\d{1,2}){0,2})\s*-\s*(\d{1,2}(?::\d{1,2}){0,2})\s*\]/;
const RE_BEAT = /_(\d+(?:\.\d+)?)s[_\.]/;
const RE_DURATION = /^(\d+(?:\.\d+)?)s[_\s-]/;

/**
 * Parse a filename for timing information.
 * Returns null when no recognized pattern is present (file is skipped).
 */
export function parseFilename(name: string): ParsedName | null {
  const base = name.replace(/\.[^.]+$/, ""); // strip extension

  // 1. Absolute range: [start - end]
  const abs = base.match(RE_ABSOLUTE);
  if (abs) {
    return {
      kind: "absolute",
      startMs: parseTimecode(abs[1]),
      endMs: parseTimecode(abs[2]),
      durationMs: null,
      raw: name,
    };
  }

  // 2. Beat-sheet: _Ns_ or _Ns.  (e.g. Beat_1_0s → start at 0s)
  const beat = base.match(RE_BEAT);
  if (beat) {
    return {
      kind: "beat",
      startMs: Math.round(parseFloat(beat[1]) * 1000),
      endMs: null,
      durationMs: null,
      raw: name,
    };
  }

  // 3. Duration: Ns_name or Ns name or Ns-name
  const dur = base.match(RE_DURATION);
  if (dur) {
    return {
      kind: "duration",
      startMs: null,
      endMs: null,
      durationMs: Math.round(parseFloat(dur[1]) * 1000),
      raw: name,
    };
  }

  return null;
}

/** Deterministic string hash → uint32. */
function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Seeded direction resolution for "random" with the v4.1 pool.
 * When kb.direction is a concrete effect it wins directly. When "random",
 * the segment deterministically picks from the user's selected pool
 * (2+ preferred effects) — falling back to all 6 when the pool is empty. */
export function resolveDirection(
  id: string,
  fallback: KenBurnsDirection,
  pool?: KenBurnsDirection[],
): KenBurnsDirection {
  if (fallback !== "random") return fallback;
  const effective =
    pool && pool.length > 0
      ? pool.filter((d) => d !== "random")
      : DIRECTIONS;
  const list = effective.length > 0 ? effective : DIRECTIONS;
  return list[hashString(id) % list.length];
}

export interface TimelineEntry {
  id: string;
  fileName: string;
  file?: File;
  parsed: ParsedName;
  order: number;
  thumbnailUrl: string;
  /** v5.0: source media kind (default "image"; "video" items get source-
   *  based default durations and no Ken Burns / xfade treatment downstream). */
  mediaType?: MediaKind;
}

/** v5.0: per-entry edit resolution (one pass, reused by both lanes). */
interface ResolvedEntry {
  entry: TimelineEntry;
  /** Normalized segment media kind — only "video" is special, everything
   *  else (including "audio"-tagged oddities) lands as "image". */
  mediaType: "image" | "video";
  /** Lane: 0 = base, >= 1 = overlay. Anything not >= 1 routes to base. */
  track: number;
  volume: number;
  trimInMs: number;
  sourceDurationMs: number | null;
  /** v5.1: resolved playback speed. BASE-lane videos honor edit.speed
   *  (clamped 0.25..4); images and overlay-lane items are locked to 1 —
   *  the FFmpeg overlay graph composites overlays at native rate. */
  speed: number;
  /** v5.2: loop the overlay source so it spans its full timeline window. */
  overlayLoop: boolean;
  chroma: ChromaKeySettings | null;
  overlay: OverlayTransform | null;
}

/** v5.1: clamp a playback speed edit to the supported 0.25..4 window. */
function clampSpeed(v: number | undefined | null): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 1;
  return Math.max(0.25, Math.min(4, n)) || 1;
}

function resolveEntry(
  e: TimelineEntry,
  itemEdits?: Record<string, ItemEdit>,
  videoDurations?: Record<string, number>,
): ResolvedEntry {
  const edit = itemEdits?.[e.id];
  const mediaType: "image" | "video" = e.mediaType === "video" ? "video" : "image";
  const track =
    typeof edit?.track === "number" && Number.isFinite(edit.track) && edit.track >= 1
      ? edit.track
      : 0;
  const volume = numOr(edit?.volume, 1);
  const trimInMs = numOr(edit?.trimInMs, 0);
  const sourceDurationMs: number | null =
    mediaType === "video" ? numOr(videoDurations?.[e.id], 0) || null : null;
  // v5.1: speed only on BASE-lane VIDEO items (see ResolvedEntry.speed).
  const speed = mediaType === "video" && track === 0 ? clampSpeed(edit?.speed) : 1;
  // v5.2: loop the overlay source so short green-screen clips can span the
  // whole video (export -stream_loop -1, preview wraps currentTime).
  const overlayLoop = edit?.overlayLoop === true && track >= 1;
  return {
    entry: e,
    mediaType,
    track,
    volume,
    trimInMs,
    sourceDurationMs,
    speed,
    overlayLoop,
    // Raw passthrough — chroma.ts owns sanitization at the UI boundary.
    chroma: edit?.chroma ?? null,
    overlay: edit?.overlay ?? null,
  };
}

/** Build a segment object from a resolved entry (shared by both lanes). */
function makeSegment(
  r: ResolvedEntry,
  kind: SegmentKind,
  startMs: number,
  endMs: number,
  direction: KenBurnsDirection,
): MediaSegment {
  const e = r.entry;
  return {
    id: e.id,
    fileName: e.fileName,
    file: e.file,
    kind,
    startMs,
    endMs,
    durationMs: endMs - startMs,
    rawStartMs: e.parsed.startMs,
    rawEndMs: e.parsed.endMs,
    rawDurationMs: e.parsed.durationMs,
    direction,
    thumbnailUrl: e.thumbnailUrl,
    order: e.order,
    mediaType: r.mediaType,
    track: r.track,
    volume: r.volume,
    trimInMs: r.trimInMs,
    sourceDurationMs: r.sourceDurationMs,
    speed: r.speed,
    overlayLoop: r.overlayLoop,
    chroma: r.chroma,
    overlay: r.overlay,
  };
}

/** v5.1: scale a resolved natural (source-window) duration to the TIMELINE
 *  duration for a base-lane video: source window / speed. speed 1 (the
 *  default everywhere) divides by 1 → the v5.0 value is returned unchanged,
 *  so every pre-v5.1 project resolves byte-identical durations.
 *  EXPLICIT user overrides are NEVER passed here — an override (drag trim,
 *  duration slider, split half) is the FINAL timeline duration the user
 *  sees, not a source quantity; only the implicit defaults (filename
 *  range/beat tail/duration pattern/source length) are source windows. */
function scaleDur(r: ResolvedEntry, durMs: number): number {
  if (r.mediaType !== "video" || r.track !== 0 || r.speed === 1 || r.speed <= 0) {
    return durMs;
  }
  return durMs / r.speed;
}

/**
 * Build the master timeline from parsed entries.
 * - Any start-bearing segment (absolute or beat) → absolute mode.
 * - Otherwise (all duration) → sequential mode.
 * - Overlaps resolved "latest start wins" (earlier segment clipped).
 * - Beat-sheet segments auto-extend to the next beat's start time.
 *
 * v5.0: `itemEdits` routes items to lanes (track 0 = base, >= 1 = overlay).
 * Base-lane logic is the v4.9 code, except a VIDEO base item with no explicit
 * duration defaults to its source length (`videoDurations[id]`, 5000ms when
 * unknown) in both the beat-tail and sequential paths. Overlay items are
 * placed absolutely (edit.startMs ?? parsed.startMs ?? 0) with duration
 * edit.durationMs ?? parsed.durationMs ?? video-source/5000, are NEVER
 * overlap-clipped, never participate in base overlap resolution, and never
 * emit warnings. Without itemEdits/videoDurations the output is
 * functionally identical to v4.9.
 */
export function buildTimeline(
  entries: TimelineEntry[],
  overrides: Record<string, number>,
  kenBurns: KenBurnsConfig,
  /** v4.8: per-segment Ken Burns direction overrides (id → direction).
   *  Wins over the global/random resolution; a concrete direction here
   * becomes `seg.direction`, which the preview renderer AND the FFmpeg
   * zoompan both consume — preview↔export parity is inherited for free. */
  motionOverrides?: Record<string, KenBurnsDirection>,
  /** v5.0: per-item edits (id → { startMs, durationMs, track, trimInMs,
   *  volume, chroma, overlay }). Absent/empty = pure v4.9 behavior. */
  itemEdits?: Record<string, ItemEdit>,
  /** v5.0: known video source durations (id → ms) driving video defaults. */
  videoDurations?: Record<string, number>,
): BuildTimelineResult {
  const warnings: OverlapWarning[] = [];
  const skipped: string[] = [];

  // v5.3: BASE-LANE startMs edits are honored (timeline trim handles / clip
  // moves). A helper reads the user's explicit placement with the filename
  // timing as fallback — projects without edits resolve identically to v5.2.
  const editStartOf = (id: string, fallback: number): number => {
    const es = itemEdits?.[id]?.startMs;
    return typeof es === "number" && Number.isFinite(es) && es >= 0 ? es : fallback;
  };

  // v5.0: resolve edits once, then partition into lanes. Without itemEdits
  // every entry lands on the base lane → identical to the v4.9 flow.
  const resolved = entries.map((e) => resolveEntry(e, itemEdits, videoDurations));
  const baseEntries = resolved.filter((r) => r.track === 0);
  const overlayEntries = resolved.filter((r) => r.track >= 1);

  const startBearing = baseEntries.filter(
    (r) => r.entry.parsed.kind === "absolute" || r.entry.parsed.kind === "beat",
  );
  const durationOnly = baseEntries.filter(
    (r) => r.entry.parsed.kind === "duration",
  );

  const mode: TimelineMode =
    startBearing.length > 0 ? "absolute" : "sequential";

  const segments: MediaSegment[] = [];

  if (mode === "absolute") {
    // Sort by start time (v5.3: the EDITED start — a moved/trimmed clip
    // re-sorts so the overlap chain below resolves in visual order), then
    // original order for stability.
    const sorted = [...startBearing].sort((a, b) => {
      const sa = editStartOf(a.entry.id, a.entry.parsed.startMs ?? 0);
      const sb = editStartOf(b.entry.id, b.entry.parsed.startMs ?? 0);
      return sa - sb || a.entry.order - b.entry.order;
    });

    // Compute initial ends. v5.3: an edited start TRANSLATES the natural
    // window (a horizontal move shifts the whole clip; a trim commit always
    // carries a duration override which wins below, so the end lands where
    // the gesture math put it).
    const withEnds = sorted.map((r, i) => {
      const start = editStartOf(r.entry.id, r.entry.parsed.startMs ?? 0);
      let endMs: number;
      if (r.entry.parsed.kind === "absolute" && r.entry.parsed.endMs != null) {
        endMs = start + ((r.entry.parsed.endMs ?? 0) - (r.entry.parsed.startMs ?? 0));
      } else {
        // beat: extend to next beat's start, or default tail (v5.0: a VIDEO
        // beat with no next beat runs for its SOURCE duration, else 5s).
        // v5.3: when the next beat was moved/trimmed, cap the extension at
        // the position it VACATED (min of edited + parsed start) so the
        // user's gap survives the commit instead of being auto-filled.
        const next = sorted[i + 1];
        const nextStart = next
          ? Math.min(
              editStartOf(next.entry.id, next.entry.parsed.startMs ?? 0),
              next.entry.parsed.startMs ?? 0,
            )
          : null;
        endMs =
          nextStart != null
            ? Math.max(start + 200, nextStart)
            : start +
              (r.mediaType === "video"
                ? r.sourceDurationMs ?? DEFAULT_BEAT_TAIL_MS
                : DEFAULT_BEAT_TAIL_MS);
      }
      return { r, endMs };
    });

    // Apply per-segment duration overrides (end = edited start + override).
    for (const we of withEnds) {
      const ov = overrides[we.r.entry.id];
      if (ov && ov > 0) {
        we.endMs = editStartOf(we.r.entry.id, we.r.entry.parsed.startMs ?? 0) + ov;
      }
    }

    // Resolve overlaps: latest start wins → clip earlier segment's end.
    for (let i = 1; i < withEnds.length; i++) {
      const prev = withEnds[i - 1];
      const cur = withEnds[i];
      const curStart = editStartOf(cur.r.entry.id, cur.r.entry.parsed.startMs ?? 0);
      if (curStart < prev.endMs) {
        warnings.push({
          message: `Overlap: "${prev.r.entry.fileName}" clipped at ${fmtTimecode(curStart)} (latest start wins)`,
          segments: [prev.r.entry.id, cur.r.entry.id],
        });
        prev.endMs = curStart;
      }
    }

    for (const we of withEnds) {
      const startMs = editStartOf(we.r.entry.id, we.r.entry.parsed.startMs ?? 0);
      // v5.1: an explicit override is the FINAL timeline duration (applied
      // above, possibly overlap-clipped since) — NOT divided by speed. Only
      // the implicit window (natural end − start) is a source window that
      // speed rescales.
      const ov = overrides[we.r.entry.id];
      const endMs =
        ov && ov > 0
          ? Math.max(startMs + 200, we.endMs) // min 200ms
          : Math.max(
              startMs + 200,
              startMs + scaleDur(we.r, we.endMs - startMs),
            ); // min 200ms
      const dir =
        motionOverrides?.[we.r.entry.id] ??
        resolveDirection(we.r.entry.id, kenBurns.direction, kenBurns.directionPool);
      segments.push(
        makeSegment(
          we.r,
          we.r.entry.parsed.kind as SegmentKind,
          startMs,
          endMs,
          dir,
        ),
      );
    }

    // Duration-only files can't be placed in absolute mode → skipped.
    // v5.0 exception: VIDEOS don't need filename timing — they are appended
    // after the last base segment (in original order) at their source
    // duration, matching the "add clip to the end of the edit" semantics of
    // a real video editor. Images keep the v4.9 skip behavior.
    const videoTail = durationOnly.filter((r) => r.mediaType === "video");
    const imageTail = durationOnly.filter((r) => r.mediaType !== "video");
    if (videoTail.length > 0) {
      let cursor = segments.reduce((m, s) => Math.max(m, s.endMs), 0);
      for (const r of videoTail) {
        const e = r.entry;
        const ov = overrides[e.id];
        const dur =
          ov && ov > 0
            ? ov
            : e.parsed.durationMs != null
              ? e.parsed.durationMs
              : r.sourceDurationMs ?? DEFAULT_DURATION_MS;
        // v5.3: honor an edited start (trim/move); never overlap the clips
        // already placed — a start before the cursor packs at the cursor.
        const startMs = Math.max(cursor, editStartOf(e.id, cursor));
        // v5.1: an override is the final timeline duration (unscaled); the
        // implicit source window is what speed divides.
        const endMs =
          startMs +
          Math.max(200, ov && ov > 0 ? ov : scaleDur(r, dur));
        const dir =
          motionOverrides?.[e.id] ??
          resolveDirection(e.id, kenBurns.direction, kenBurns.directionPool);
        segments.push(
          makeSegment(r, e.parsed.kind as SegmentKind, startMs, endMs, dir),
        );
        cursor = endMs;
      }
    }
    for (const r of imageTail) {
      skipped.push(
        `${r.entry.fileName} (duration pattern not used in absolute mode)`,
      );
    }
  } else {
    // Sequential: stack durations in original order. A video without an
    // explicit duration defaults to its source length (5000ms when unknown).
    // v5.1: base-lane video durations are SOURCE windows — the timeline
    // duration is window/speed, so the cursor (and every following clip)
    // shifts left when a clip is sped up. Images are always speed 1.
    // v5.3: an edited start is honored (trim handles) — a start past the
    // cursor opens a gap (non-ripple trim); a start before it packs at the
    // cursor so sequential clips can never overlap.
    let cursor = 0;
    for (const r of baseEntries) {
      const e = r.entry;
      const ov = overrides[e.id];
      const dur =
        ov && ov > 0
          ? ov
          : e.parsed.durationMs != null
            ? e.parsed.durationMs
            : r.mediaType === "video"
              ? r.sourceDurationMs ?? DEFAULT_DURATION_MS
              : DEFAULT_DURATION_MS;
      const startMs = Math.max(cursor, editStartOf(e.id, cursor));
      // v5.1: an override is the final timeline duration (unscaled); the
      // implicit source window is what speed divides.
      const endMs =
        startMs + Math.max(200, ov && ov > 0 ? ov : scaleDur(r, dur));
      const dir =
        motionOverrides?.[e.id] ??
        resolveDirection(e.id, kenBurns.direction, kenBurns.directionPool);
      segments.push(
        makeSegment(r, e.parsed.kind as SegmentKind, startMs, endMs, dir),
      );
      cursor = endMs;
    }
  }

  // v5.0: overlay lane — placed absolutely, no overlap clipping, no
  // warnings, no participation in base resolution. Appended after the base
  // segments, sorted by startMs (then order) for deterministic draw order.
  if (overlayEntries.length > 0) {
    const overlaySegs: MediaSegment[] = overlayEntries.map((r) => {
      const e = r.entry;
      const edit = itemEdits?.[e.id];
      const startMs = numOr(edit?.startMs, numOr(e.parsed.startMs, 0));
      const durationMs = Math.max(
        0,
        numOr(
          edit?.durationMs,
          numOr(
            e.parsed.durationMs,
            r.mediaType === "video"
              ? r.sourceDurationMs ?? DEFAULT_DURATION_MS
              : DEFAULT_DURATION_MS,
          ),
        ),
      );
      const dir =
        motionOverrides?.[e.id] ??
        resolveDirection(e.id, kenBurns.direction, kenBurns.directionPool);
      return makeSegment(
        r,
        e.parsed.kind as SegmentKind,
        startMs,
        startMs + durationMs,
        dir,
      );
    });
    overlaySegs.sort((a, b) => a.startMs - b.startMs || a.order - b.order);
    segments.push(...overlaySegs);
  }

  // v5.0: total spans ALL lanes (overlays can extend past the base end).
  const totalMs = segments.reduce((m, s) => Math.max(m, s.endMs), 0);

  return { segments, mode, totalMs, warnings, skipped };
}

/**
 * Find the active BASE-lane (track 0) segment at a given time (ms).
 * v5.0: overlay segments are invisible to this lookup — use
 * overlaySegmentsAt for the overlay stack. Past the end of the base lane the
 * last base segment is returned (v4.9 semantic, preserved).
 */
export function segmentAtTime(
  segments: MediaSegment[],
  tMs: number,
): MediaSegment | null {
  let last: MediaSegment | null = null;
  for (const s of segments) {
    if ((s.track ?? 0) !== 0) continue; // v5.0: base lane only
    last = s;
    if (tMs >= s.startMs && tMs < s.endMs) return s;
  }
  // If past the end, return the last base segment.
  if (last && tMs >= last.endMs) {
    return last;
  }
  return null;
}

/**
 * v5.0: overlay-lane segments (track >= 1) active at tMs, in draw order —
 * sorted by track (lower tracks draw first / get covered), then startMs.
 * The interval is closed at the start and open at the end, so a segment
 * whose endMs equals the next one's startMs never double-draws.
 */
export function overlaySegmentsAt(
  segments: MediaSegment[],
  tMs: number,
): MediaSegment[] {
  const hits: MediaSegment[] = [];
  for (const s of segments) {
    if ((s.track ?? 0) < 1) continue;
    if (tMs >= s.startMs && tMs < s.endMs) hits.push(s);
  }
  hits.sort((a, b) => a.track - b.track || a.startMs - b.startMs);
  return hits;
}

/** Format milliseconds as MM:SS or HH:MM:SS. */
export function fmtTimecode(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

/** Format a byte size human-readably. */
export function fmtBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
