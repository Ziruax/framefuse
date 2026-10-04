/**
 * SERVER-ONLY dubbing transcription pipeline.
 *
 * ffmpeg (ffmpeg-static) extracts/segments audio, silencedetect finds speech
 * windows, z-ai ASR transcribes them, and one z-ai LLM call detects the
 * language. Word timings are estimated by char-weighted distribution inside
 * each speech segment (the ASR service returns text only, no timestamps).
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

import { zaiAsrFile, zaiChatText } from "./zai";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public shapes (DubTranscriptResult contract)
// ---------------------------------------------------------------------------

export interface DubWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface DubUtterance {
  startMs: number;
  endMs: number;
  text: string;
  words: DubWord[];
}

export interface DubTranscriptResult {
  ok: true;
  language: string;
  totalMs: number;
  wordCount: number;
  utterances: DubUtterance[];
}

/** Error carrying an HTTP status for the route layer. */
export class TranscribeFailure extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export const MAX_UPLOAD_FILES = 8;
export const MAX_FILE_BYTES = 200 * 1024 * 1024; // 200 MB per file
export const MAX_TOTAL_AUDIO_SEC = 20 * 60; // 20 min of extracted audio

// ---------------------------------------------------------------------------
// ffmpeg plumbing
// ---------------------------------------------------------------------------

let ffmpegPathCache: string | null = null;

/** Absolute path of the ffmpeg-static binary (runtime require → real
 *  node_modules location, immune to bundler __dirname rewrites). */
function ffmpegPath(): string {
  if (ffmpegPathCache) return ffmpegPathCache;
  // Runtime require from the real node_modules (bundler-opaque).
  const req = createRequire(path.join(process.cwd(), "index.cjs"));
  const p = req("ffmpeg-static") as string;
  if (!p || !fs.existsSync(p)) {
    throw new TranscribeFailure("ffmpeg binary is not available on the server", 500);
  }
  ffmpegPathCache = p;
  return p;
}

const FFMPEG_TIMEOUT_MS = 120_000;

interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Run one bounded ffmpeg invocation (killed after 120 s). */
async function execFfmpeg(args: string[]): Promise<ExecResult> {
  try {
    return await execFileAsync(ffmpegPath(), args, {
      timeout: FFMPEG_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
    const tail = (e.stderr || "").trim().split("\n").filter(Boolean).slice(-1).join(" ").slice(0, 200);
    if (e.killed) {
      throw new TranscribeFailure(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS / 1000}s`);
    }
    throw new TranscribeFailure(tail ? `ffmpeg failed: ${tail}` : "ffmpeg failed");
  }
}

// ---------------------------------------------------------------------------
// Silence analysis
// ---------------------------------------------------------------------------

interface SilenceReport {
  durationSec: number | null;
  /** Ordered silence intervals; `end` null = trailing silence (to EOF). */
  silences: { start: number; end: number | null }[];
}

/** Parse `Duration:` + silencedetect lines out of an ffmpeg info-level stderr. */
export function parseSilenceReport(stderr: string): SilenceReport {
  let durationSec: number | null = null;
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (dur) {
    durationSec = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);
  }
  const silences: { start: number; end: number | null }[] = [];
  const eventRe = /(silence_start|silence_end):\s*(-?\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = eventRe.exec(stderr)) !== null) {
    const kind = m[1];
    const t = Number(m[2]);
    if (kind === "silence_start") {
      silences.push({ start: t, end: null });
    } else {
      // Close the most recent open interval (defensive: ignore stray ends).
      const open = [...silences].reverse().find((s) => s.end === null);
      if (open) open.end = t;
    }
  }
  return { durationSec, silences };
}

export interface TimeRange {
  start: number;
  end: number;
}

/** Speech = complement of the silence intervals. Drops < 0.25 s blips, merges
 *  speech separated by < 0.25 s, and (when > 50 segments) packs adjacent
 *  segments into ≤ ~12 s ASR windows. */
export function speechSegmentsFromSilences(report: SilenceReport): TimeRange[] {
  const duration = report.durationSec ?? 0;
  if (duration <= 0) return [];
  // Resolve trailing silences + clip to [0, duration].
  const silences = report.silences
    .map((s) => ({
      start: Math.max(0, Math.min(duration, s.start)),
      end: s.end === null ? duration : Math.max(0, Math.min(duration, s.end)),
    }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);

  const speech: TimeRange[] = [];
  let cursor = 0;
  for (const sil of silences) {
    if (sil.start > cursor) speech.push({ start: cursor, end: sil.start });
    if (sil.end > cursor) cursor = sil.end;
  }
  if (cursor < duration) speech.push({ start: cursor, end: duration });

  // Drop tiny blips (< 0.25 s).
  const MIN_SEG_SEC = 0.25;
  const kept = speech.filter((s) => s.end - s.start >= MIN_SEG_SEC);
  if (kept.length === 0) return [];

  // Merge speech separated by < 0.25 s of silence.
  const MERGE_GAP_SEC = 0.25;
  const merged: TimeRange[] = [kept[0]];
  for (const seg of kept.slice(1)) {
    const last = merged[merged.length - 1];
    if (seg.start - last.end < MERGE_GAP_SEC) {
      last.end = Math.max(last.end, seg.end);
    } else {
      merged.push({ ...seg });
    }
  }

  // Cap the ASR call count: pack adjacent segments into ≤ ~12 s windows.
  if (merged.length > 50) {
    const WINDOW_SEC = 12;
    const packed: TimeRange[] = [];
    for (const seg of merged) {
      const last = packed[packed.length - 1];
      if (last && last.end - last.start < WINDOW_SEC && seg.end - last.start <= WINDOW_SEC + 1) {
        last.end = Math.max(last.end, seg.end);
      } else {
        packed.push({ ...seg });
      }
    }
    return packed;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Word timing (char-weighted distribution)
// ---------------------------------------------------------------------------

/** Distribute words across the segment proportional to token length
 *  (chars + 1 for the trailing space) — estimated word-level timing. */
export function distributeWords(text: string, segStartMs: number, segEndMs: number): DubWord[] {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const weights = tokens.map((t) => t.length + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const durMs = Math.max(0, segEndMs - segStartMs);
  let offset = 0;
  const words: DubWord[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const startMs = Math.round(segStartMs + (offset / total) * durMs);
    const dur = Math.max(1, Math.round((weights[i] / total) * durMs));
    offset += weights[i];
    words.push({ text: tokens[i], startMs, endMs: startMs + dur });
  }
  return words;
}

// ---------------------------------------------------------------------------
// Small concurrency helper (≤ 2 in flight)
// ---------------------------------------------------------------------------

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async () => {
        while (true) {
          const i = next++;
          if (i >= items.length) break;
          results[i] = await fn(items[i], i);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface TranscribeUpload {
  /** Saved upload (any ffmpeg-readable media file). */
  path: string;
  /** Timeline placement start (ms). null → back-to-back (no meta). */
  startMs: number | null;
  /** Timeline placement end (ms). null → full duration. */
  endMs: number | null;
}

interface PlannedSegment {
  partIdx: number;
  local: TimeRange; // seconds inside part<i>.wav
}

/** Sanitize an LLM language guess to a short English name. */
function sanitizeLanguageName(raw: string): string {
  let s = raw.trim().replace(/^["'`\s]+|["'`.\s]+$/g, "");
  s = s.replace(/\s+/g, " ");
  if (!s) return "";
  if (s.length > 40) s = s.slice(0, 40).trim();
  return s;
}

/**
 * Full transcription pipeline. `workDir` receives part<i>.wav / seg-*.wav
 * intermediates (the CALLER owns creating/removing it).
 */
export async function transcribeDubUploads(
  workDir: string,
  uploads: TranscribeUpload[],
): Promise<DubTranscriptResult> {
  // ---- 1. extract 16 kHz mono PCM WAV per upload ----
  const partPaths: string[] = [];
  for (let i = 0; i < uploads.length; i++) {
    const up = uploads[i];
    const partPath = path.join(workDir, `part${i}.wav`);
    const args: string[] = ["-hide_banner", "-loglevel", "error", "-y"];
    const hasMeta = up.startMs !== null;
    const startSec = Math.max(0, (up.startMs ?? 0) / 1000);
    if (hasMeta && startSec > 0) {
      args.push("-ss", startSec.toFixed(3)); // fast input seek
    }
    if (hasMeta && up.endMs !== null) {
      const durSec = Math.max(0, (up.endMs - (up.startMs ?? 0)) / 1000);
      if (durSec > 0) args.push("-t", durSec.toFixed(3));
    }
    args.push("-i", up.path, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", partPath);
    try {
      await execFfmpeg(args);
    } catch (err) {
      throw new TranscribeFailure(
        `Could not extract audio from upload ${i + 1}: ${err instanceof Error ? err.message : "decode failed"}`,
        400,
      );
    }
    partPaths.push(partPath);
  }

  // ---- 2. silence-split each part ----
  const durationsSec: number[] = [];
  const segments: PlannedSegment[] = [];
  for (let i = 0; i < partPaths.length; i++) {
    const info = await execFfmpeg([
      "-hide_banner",
      "-i", partPaths[i],
      "-af", "silencedetect=noise=-35dB:d=0.4",
      "-f", "null",
      "-",
    ]);
    const report = parseSilenceReport(info.stderr);
    const duration = report.durationSec ?? 0;
    durationsSec.push(duration);
    for (const seg of speechSegmentsFromSilences(report)) {
      segments.push({ partIdx: i, local: seg });
    }
  }

  // ---- 3. total-audio guard (after extraction) ----
  const totalAudioSec = durationsSec.reduce((a, b) => a + b, 0);
  if (totalAudioSec > MAX_TOTAL_AUDIO_SEC) {
    throw new TranscribeFailure(
      `Extracted audio is ${(totalAudioSec / 60).toFixed(1)} min — the limit is ${
        MAX_TOTAL_AUDIO_SEC / 60
      } min`,
      413,
    );
  }

  // ---- 4. timeline base per part ----
  const basesMs: number[] = [];
  let cumulativeMs = 0;
  for (let i = 0; i < partPaths.length; i++) {
    if (uploads[i].startMs !== null) {
      basesMs.push(uploads[i].startMs as number);
    } else {
      basesMs.push(Math.round(cumulativeMs));
    }
    cumulativeMs += Math.round(durationsSec[i] * 1000);
  }

  // ---- 5. cut + ASR each speech segment (concurrency ≤ 2) ----
  interface AsrOutcome {
    segment: PlannedSegment;
    text: string | null; // null = failed/empty
  }
  const outcomes: AsrOutcome[] = await mapLimit(segments, 2, async (seg, j) => {
    const segPath = path.join(workDir, `seg-${seg.partIdx}-${j}.wav`);
    const dur = seg.local.end - seg.local.start;
    await execFfmpeg([
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", partPaths[seg.partIdx],
      "-ss", seg.local.start.toFixed(3),
      "-t", dur.toFixed(3),
      "-c:a", "copy",
      segPath,
    ]);
    try {
      const text = await zaiAsrFile(segPath);
      return { segment: seg, text: text && text.trim() ? text.trim() : null };
    } catch {
      return { segment: seg, text: null };
    }
  });

  // ---- 6. utterances + estimated word timings ----
  const utterances: DubUtterance[] = [];
  let asrFailures = 0;
  for (const out of outcomes) {
    if (!out.text) {
      asrFailures++;
      continue;
    }
    const baseMs = basesMs[out.segment.partIdx];
    const startMs = baseMs + Math.round(out.segment.local.start * 1000);
    const endMs = baseMs + Math.round(out.segment.local.end * 1000);
    utterances.push({
      startMs,
      endMs,
      text: out.text,
      words: distributeWords(out.text, startMs, endMs),
    });
  }
  utterances.sort((a, b) => a.startMs - b.startMs);

  if (utterances.length === 0 && asrFailures > 0) {
    throw new TranscribeFailure("Speech recognition failed for every audio segment", 500);
  }

  // ---- 7. language detection (ONE LLM call on the joined transcript) ----
  let language = "auto";
  const joined = utterances.map((u) => u.text).join(" ").trim();
  if (joined) {
    const snippet = joined.slice(0, 400);
    try {
      const raw = await zaiChatText(
        "You identify languages. Reply with the English language name only.",
        `Identify the spoken language of this transcript. Reply with ONLY the English language name (e.g. Hindi, English, Urdu, Arabic). Transcript: ${snippet}`,
        { maxTokens: 200 },
      );
      const name = sanitizeLanguageName(raw);
      if (name) language = name;
    } catch {
      // Keep "auto" — language detection is best-effort.
    }
  }

  const totalMs = utterances.reduce((mx, u) => Math.max(mx, u.endMs), 0);
  const wordCount = utterances.reduce((sum, u) => sum + u.words.length, 0);
  return { ok: true, language, totalMs, wordCount, utterances };
}
