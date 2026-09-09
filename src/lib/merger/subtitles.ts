// src/lib/merger/subtitles.ts — SRT subtitle parser
// Parses standard .srt files into an array of SubtitleCue objects.

export interface WordTimestamp {
  /** Word text (already stripped of punctuation, with original spacing remembered). */
  text: string;
  /** Start time of this word, in ms, in the master timeline. */
  startMs: number;
  /** End time of this word, in ms, in the master timeline. */
  endMs: number;
}

export interface SubtitleCue {
  id: number;
  startMs: number;
  endMs: number;
  text: string;
  /**
   * Optional per-word timestamps. Populated when captions are generated
   * from audio via Whisper-tiny (or any future ASR source that returns
   * word-level alignment). When absent, the cue is rendered as full text.
   * Used by the "word" and "word-only" caption modes for viral karaoke,
   * and by per-word kinetic typography animations.
   */
  words?: WordTimestamp[];
}

/**
 * Parse a single SRT timecode into milliseconds.
 * Accepts both `,` and `.` as the millisecond separator.
 *   "00:00:01,000" -> 1000
 *   "00:01:02.500" -> 62500
 *   "01:00:00,000" -> 3600000
 */
function parseTimecode(tc: string): number {
  const m = tc.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!m) return 0;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const sec = parseInt(m[3], 10);
  // Pad ms to 3 digits: "5" → 500, "05" → 50, "005" → 5? No — SRT is always 3 digits,
  // but be defensive: treat the trailing group as the fractional part of a second.
  const msStr = m[4];
  let ms: number;
  if (msStr.length === 1) ms = parseInt(msStr, 10) * 100;
  else if (msStr.length === 2) ms = parseInt(msStr, 10) * 10;
  else ms = parseInt(msStr, 10);
  return ((h * 60 + min) * 60 + sec) * 1000 + ms;
}

/**
 * Strip simple HTML-ish tags (<i>, </i>, <b>, </b>, <font ...>, <u>, etc.)
 * but keep the textual content. Also collapses literal "\n" sequences
 * (backslash + n) into real newlines so subtitle text containing the
 * escape renders correctly.
 */
function cleanText(raw: string): string {
  let s = raw.replace(/<[^>]+>/g, ""); // strip tags
  s = s.replace(/\\n/gi, "\n"); // literal \n → newline
  s = s.replace(/\r/g, ""); // nuke stray CR
  return s.trim();
}

/**
 * Parse an SRT file's text content into a sorted list of SubtitleCue.
 *
 * Handles:
 *  - UTF-8 BOM
 *  - CRLF / LF / mixed line endings
 *  - Multi-line subtitle text (joined with \n)
 *  - Comma OR period millisecond separator
 *  - Missing / out-of-order cue indices
 *  - Stray HTML tags (removed)
 *  - Literal \n in text → real newline
 *
 * Output is sorted ascending by startMs and re-indexed from 1.
 */
export function parseSrt(content: string): SubtitleCue[] {
  if (!content) return [];

  // Strip BOM.
  let text = content.replace(/^\uFEFF/, "");
  // Normalize line endings.
  text = text.replace(/\r\n?/g, "\n");

  const cues: SubtitleCue[] = [];
  // Split on one-or-more blank lines.
  const blocks = text.split(/\n\s*\n+/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const lines = trimmed.split("\n");
    if (lines.length < 2) continue;

    let lineIdx = 0;

    // Optional index line (a pure integer).
    if (/^\d+$/.test(lines[0].trim())) {
      lineIdx = 1;
    }

    const timeLine = lines[lineIdx]?.trim() ?? "";
    // Match: "00:00:01,000 --> 00:00:04,000"
    const tcMatch = timeLine.match(
      /^(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/,
    );
    if (!tcMatch) continue;

    const startMs = parseTimecode(tcMatch[1]);
    const endMs = parseTimecode(tcMatch[2]);
    if (endMs < startMs) continue;

    const textLines = lines.slice(lineIdx + 1);
    const joined = cleanText(textLines.join("\n"));
    if (!joined) continue;

    cues.push({
      id: cues.length + 1,
      startMs,
      endMs,
      text: joined,
    });
  }

  // Sort by startMs, then re-index sequentially.
  cues.sort((a, b) => a.startMs - b.startMs);
  cues.forEach((c, i) => (c.id = i + 1));

  return cues;
}

/**
 * Find the subtitle cue active at a given time (ms), or null.
 * Uses binary search over a sorted-by-startMs list for performance.
 */
export function cueAt(cues: SubtitleCue[], tMs: number): SubtitleCue | null {
  if (!cues.length) return null;
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cues[mid];
    if (tMs < c.startMs) {
      hi = mid - 1;
    } else if (tMs >= c.endMs) {
      // Boundary: if this is the last cue and we're past its end, still return null.
      lo = mid + 1;
    } else {
      return c;
    }
  }
  return null;
}

/**
 * Serialize cues back to an SRT string (used to write a temp .srt file
 * for FFmpeg burn-in). Always emits standard SRT with 3-digit ms and
 * comma separator.
 */
export function serializeSrt(cues: SubtitleCue[]): string {
  const fmt = (ms: number): string => {
    const total = Math.max(0, Math.floor(ms));
    const h = Math.floor(total / 3_600_000);
    const m = Math.floor((total % 3_600_000) / 60_000);
    const s = Math.floor((total % 60_000) / 1000);
    const milli = total % 1000;
    return (
      String(h).padStart(2, "0") +
      ":" +
      String(m).padStart(2, "0") +
      ":" +
      String(s).padStart(2, "0") +
      "," +
      String(milli).padStart(3, "0")
    );
  };
  return cues
    .map((c, i) => {
      return `${i + 1}\n${fmt(c.startMs)} --> ${fmt(c.endMs)}\n${c.text}`;
    })
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Word-level helpers — used by the "word" / "word-only" caption modes and
// by per-word kinetic typography animations.
// ---------------------------------------------------------------------------

/**
 * Find the active word at a given time within a cue, or null.
 * Returns the index into `words[]` for the word whose [startMs, endMs)
 * contains tMs. The last word whose startMs <= tMs wins (so a word stays
 * "active" from its start until the next word begins, even if the word's
 * own endMs is slightly earlier — this matches natural reading behavior).
 */
export function activeWordIndex(
  words: WordTimestamp[] | undefined,
  tMs: number,
): number {
  if (!words || words.length === 0) return -1;
  let lo = 0;
  let hi = words.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = words[mid];
    if (tMs < w.startMs) {
      hi = mid - 1;
    } else {
      candidate = mid;
      lo = mid + 1;
    }
  }
  return candidate;
}

/** True if a cue carries word-level timestamps (Whisper-generated). */
export function hasWordTimestamps(cue: SubtitleCue): boolean {
  return !!cue.words && cue.words.length > 0;
}

/**
 * Build simple per-word timestamps from a cue by evenly dividing its
 * duration across the words. Used as a fallback when word-level timing
 * is unavailable but word-by-word mode is requested. Each word gets
 * `dur / N` ms.
 */
export function synthesizeWordTimestamps(cue: SubtitleCue): WordTimestamp[] {
  const tokens = cue.text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const dur = Math.max(1, cue.endMs - cue.startMs);
  const per = dur / tokens.length;
  return tokens.map((text, i) => ({
    text,
    startMs: cue.startMs + Math.round(per * i),
    endMs: cue.startMs + Math.round(per * (i + 1)),
  }));
}
