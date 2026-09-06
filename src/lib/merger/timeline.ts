// src/lib/merger/timeline.ts — filename parser + master timeline builder
import type {
  BuildTimelineResult,
  KenBurnsConfig,
  KenBurnsDirection,
  MediaSegment,
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

/** Parse a timecode like "SS", "MM:SS", or "HH:MM:SS" into milliseconds. */
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

const RE_ABSOLUTE =
  /\[\s*(\d{1,2}(?::\d{1,2}){0,2})\s*-\s*(\d{1,2}(?::\d{1,2}){0,2})\s*\]/;
const RE_DURATION = /^(\d+(?:\.\d+)?)s[_\s-]/;
const RE_BEAT = /_(\d+(?:\.\d+)?)s[_\.]/;

/**
 * Parse a filename for timing information.
 * Returns null when no recognized pattern is present (file is skipped).
 */
export function parseFilename(name: string): ParsedName | null {
  const base = name.replace(/\.[^.]+$/, ""); // strip extension

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

/** Seeded direction resolution for "random". */
export function resolveDirection(
  id: string,
  fallback: KenBurnsDirection,
): KenBurnsDirection {
  if (fallback !== "random") return fallback;
  return DIRECTIONS[hashString(id) % DIRECTIONS.length];
}

export interface TimelineEntry {
  id: string;
  fileName: string;
  file?: File;
  parsed: ParsedName;
  order: number;
  thumbnailUrl: string;
}

/**
 * Build the master timeline from parsed entries.
 * - Any start-bearing segment (absolute or beat) → absolute mode.
 * - Otherwise (all duration) → sequential mode.
 * - Overlaps resolved "latest start wins" (earlier segment clipped).
 */
export function buildTimeline(
  entries: TimelineEntry[],
  overrides: Record<string, number>,
  kenBurns: KenBurnsConfig,
): BuildTimelineResult {
  const warnings: OverlapWarning[] = [];
  const skipped: string[] = [];

  const startBearing = entries.filter(
    (e) => e.parsed.kind === "absolute" || e.parsed.kind === "beat",
  );
  const durationOnly = entries.filter((e) => e.parsed.kind === "duration");

  // Files that parsed but don't fit the chosen mode are reported as skipped.
  for (const e of entries) {
    if (e.parsed.kind === "absolute" || e.parsed.kind === "beat") continue;
    if (e.parsed.kind === "duration") continue;
  }
  // (Unparseable files never reach here — they're filtered before calling.)

  const mode: TimelineMode = startBearing.length > 0 ? "absolute" : "sequential";

  const segments: MediaSegment[] = [];

  if (mode === "absolute") {
    // Sort by start time, then original order for stability.
    const sorted = [...startBearing].sort((a, b) => {
      const sa = a.parsed.startMs ?? 0;
      const sb = b.parsed.startMs ?? 0;
      return sa - sb || a.order - b.order;
    });

    // Compute initial ends.
    const withEnds = sorted.map((e, i) => {
      let endMs: number;
      if (e.parsed.kind === "absolute" && e.parsed.endMs != null) {
        endMs = e.parsed.endMs;
      } else {
        // beat: extend to next beat's start, or default tail.
        const next = sorted[i + 1];
        const nextStart = next ? next.parsed.startMs ?? 0 : null;
        endMs = nextStart != null ? nextStart : (e.parsed.startMs ?? 0) + DEFAULT_BEAT_TAIL_MS;
      }
      return { e, endMs };
    });

    // Apply per-segment duration overrides (end = start + override).
    for (const we of withEnds) {
      const ov = overrides[we.e.id];
      if (ov && ov > 0) {
        we.endMs = (we.e.parsed.startMs ?? 0) + ov;
      }
    }

    // Resolve overlaps: latest start wins → clip earlier segment's end.
    for (let i = 1; i < withEnds.length; i++) {
      const prev = withEnds[i - 1];
      const cur = withEnds[i];
      const curStart = cur.e.parsed.startMs ?? 0;
      if (curStart < prev.endMs) {
        warnings.push({
          message: `Overlap: "${prev.e.fileName}" clipped at ${fmtTimecode(curStart)} (latest start wins)`,
          segments: [prev.e.id, cur.e.id],
        });
        prev.endMs = curStart;
      }
    }

    for (const we of withEnds) {
      const startMs = we.e.parsed.startMs ?? 0;
      const endMs = Math.max(startMs + 200, we.endMs); // min 200ms
      const dir = resolveDirection(we.e.id, kenBurns.direction);
      segments.push({
        id: we.e.id,
        fileName: we.e.fileName,
        file: we.e.file,
        kind: we.e.parsed.kind as SegmentKind,
        startMs,
        endMs,
        durationMs: endMs - startMs,
        rawStartMs: we.e.parsed.startMs,
        rawEndMs: we.e.parsed.endMs,
        rawDurationMs: we.e.parsed.durationMs,
        direction: dir,
        thumbnailUrl: we.e.thumbnailUrl,
        order: we.e.order,
      });
    }

    // Duration-only files can't be placed in absolute mode → skipped.
    for (const e of durationOnly) {
      skipped.push(`${e.fileName} (duration pattern not used in absolute mode)`);
    }
  } else {
    // Sequential: stack durations in original order.
    let cursor = 0;
    for (const e of entries) {
      const ov = overrides[e.id];
      const dur = ov && ov > 0 ? ov : e.parsed.durationMs ?? DEFAULT_DURATION_MS;
      const startMs = cursor;
      const endMs = cursor + dur;
      const dir = resolveDirection(e.id, kenBurns.direction);
      segments.push({
        id: e.id,
        fileName: e.fileName,
        file: e.file,
        kind: e.parsed.kind as SegmentKind,
        startMs,
        endMs,
        durationMs: dur,
        rawStartMs: e.parsed.startMs,
        rawEndMs: e.parsed.endMs,
        rawDurationMs: e.parsed.durationMs,
        direction: dir,
        thumbnailUrl: e.thumbnailUrl,
        order: e.order,
      });
      cursor = endMs;
    }
  }

  const totalMs = segments.reduce((m, s) => Math.max(m, s.endMs), 0);

  return { segments, mode, totalMs, warnings, skipped };
}

/** Find the active segment at a given time (ms). */
export function segmentAtTime(
  segments: MediaSegment[],
  tMs: number,
): MediaSegment | null {
  for (const s of segments) {
    if (tMs >= s.startMs && tMs < s.endMs) return s;
  }
  // If past the end, return the last segment.
  if (segments.length && tMs >= segments[segments.length - 1].endMs) {
    return segments[segments.length - 1];
  }
  return null;
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
