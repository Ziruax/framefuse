/**
 * SERVER-ONLY dubbing synthesis — per-speaker Edge-TTS voices + duration fit
 * + v1.27 WORD-TO-WORD TIMING.
 *
 * Each script line is synthesized with its speaker's resolved voice. Then:
 *
 *   • When the line carries the ORIGINAL utterance's word timings (from the
 *     stage-1 transcript) and word timing is on, the synthesized PCM is warped
 *     (WSOLA, pitch-preserving) so every dubbed word lands when the original
 *     word was spoken — clamped to naturalness guardrails so the flow never
 *     sounds rushed or dragged.
 *   • Without word timings (or when the timing is too far off to fix by
 *     warping), the classic duration fit applies: one Edge-TTS speed-up
 *     re-synthesis (≤ +60%) when the natural duration overruns the line's
 *     slot by > 12%; short audio is never stretched.
 *
 * Warped segments come back as WAV (24 kHz mono PCM); unwarped keep the MP3.
 */

import { getVoiceCatalog, synthesize } from "./edge-tts";
import type { TtsVoice, TtsVoicePair, TtsWord } from "./edge-tts";
import {
  decodeToPcm,
  encodeWav,
  warpWordsToTimeline,
  type WarpWord,
} from "./word-warp";

// ---------------------------------------------------------------------------
// Public shapes (web DubTrackResult contract)
// ---------------------------------------------------------------------------

export interface DubSynthLine {
  speaker: number;
  sourceText: string;
  translatedText: string;
  startMs: number;
  endMs: number;
  /** v1.27: the ORIGINAL utterance's word timings (absolute timeline ms) —
   *  present when the client still holds the stage-1 transcript. Drives the
   *  word-to-word timing match. */
  sourceWords?: WarpWord[];
}

export interface DubSynthSpeaker {
  id: number;
  voice: string;
  gender: string;
}

export interface DubSynthAlign {
  /** Word timing match ran (WSOLA warp applied). */
  applied: boolean;
  /** Why it was skipped (short lines, drift already tiny, too far…). */
  reason?: string;
  maxDriftMs?: number;
  globalFactor?: number;
  synthWords?: number;
  targetWords?: number;
}

export interface DubSynthSegment {
  startMs: number;
  endMs: number;
  speaker: number;
  sourceText: string;
  translatedText: string;
  wavPath: string;
  ttsDurMs: number;
  speedApplied: number;
  /** "wav" when word-warped, else the raw Edge-TTS "mp3". */
  format: "wav" | "mp3";
  align?: DubSynthAlign;
  bytes: string; // base64
}

export interface DubSynthResult {
  ok: true;
  language: string;
  speakers: DubSynthSpeaker[];
  segments: DubSynthSegment[];
  wavPaths: string[];
  totalDurationMs: number;
  warnings: string[];
  dubDir: string;
}

export interface DubSynthInput {
  /** Target language code (e.g. "hi"). */
  language: string;
  /** Target locale (e.g. "hi-IN") — drives voice resolution. */
  targetLocale?: string;
  lines: DubSynthLine[];
  /** speaker id (as string key) → voice ShortName. */
  voices?: Record<string, string> | null;
  /** Overrides every speaker when non-null. */
  singleVoice?: string | null;
  /** v1.27: word-to-word timing (default true when sourceWords are present). */
  wordTiming?: boolean;
}

// ---------------------------------------------------------------------------
// Voice resolution
// ---------------------------------------------------------------------------

const DEFAULT_VOICE = "en-US-AriaNeural";

interface ResolvedVoice {
  voice: string;
  gender: string;
}

function lookupVoice(voices: TtsVoice[], shortName: string): TtsVoice | undefined {
  const lower = shortName.toLowerCase();
  return voices.find((v) => v.shortName.toLowerCase() === lower);
}

/** Resolve the voice for ONE speaker id following the priority chain. */
function resolveSpeakerVoice(
  speaker: number,
  input: DubSynthInput,
  voices: TtsVoice[],
  pairs: Record<string, TtsVoicePair>,
): ResolvedVoice {
  const wantGender: "Female" | "Male" = speaker === 0 ? "Female" : "Male";
  const fallbackFor = (voice: string): ResolvedVoice => {
    const hit = lookupVoice(voices, voice);
    return { voice, gender: hit ? hit.gender : "Unknown" };
  };

  // 1. singleVoice overrides ALL speakers.
  if (input.singleVoice && input.singleVoice.trim()) {
    return fallbackFor(input.singleVoice.trim());
  }
  // 2. explicit per-speaker map.
  const mapped = input.voices?.[String(speaker)];
  if (mapped && mapped.trim()) {
    return fallbackFor(mapped.trim());
  }
  // 3. locale pair: female for speaker 0, male for the rest.
  const locale = (input.targetLocale || "").trim();
  if (locale && pairs[locale]) {
    const pair = pairs[locale];
    return fallbackFor(speaker === 0 ? pair.female : pair.male);
  }
  // 4. any catalog voice of the locale (preferred gender first).
  if (locale) {
    const ofLocale = voices.filter((v) => v.locale.toLowerCase() === locale.toLowerCase());
    const preferred = ofLocale.find((v) => v.gender === wantGender) || ofLocale[0];
    if (preferred) return { voice: preferred.shortName, gender: preferred.gender };
  }
  // 5. first voice overall.
  const first = voices[0];
  return first ? { voice: first.shortName, gender: first.gender } : fallbackFor(DEFAULT_VOICE);
}

// ---------------------------------------------------------------------------
// Duration math
// ---------------------------------------------------------------------------

const CBR_BYTES_PER_MS = 6; // 48 kbps MP3 → 6000 B/s

/** Natural duration of a synthesis (ms): last word end, else CBR byte math. */
function naturalDurationMs(words: TtsWord[], bytesLen: number): number {
  if (words && words.length > 0) {
    const last = words[words.length - 1];
    return Math.max(0, Math.round(last.offsetMs + last.durationMs));
  }
  return Math.round(bytesLen / CBR_BYTES_PER_MS);
}

const MIN_SLOT_MS = 600;
const OVERFLOW_TOLERANCE = 1.12; // ttsDur ≤ slot × 1.12 is fine
const MAX_SPEEDUP_PCT = 60;

// ---------------------------------------------------------------------------
// Word-to-word timing synthesis for ONE line
// ---------------------------------------------------------------------------

interface LineSynthesis {
  bytes: Buffer;
  format: "wav" | "mp3";
  ttsDurMs: number;
  speedApplied: number;
  align: DubSynthAlign;
}

/**
 * Synthesize one line with the word-to-word timing pipeline:
 *   1. natural synthesis;
 *   2. Edge-TTS rate re-synthesis when the GLOBAL duration is far off (a real
 *      speaking-rate change is always more natural than a big warp);
 *   3. WSOLA word warp to land each word on its original timing (guardrailed);
 *   4. fall back to the classic duration fit when timing data is missing.
 */
async function synthesizeLineWithTiming(
  text: string,
  voice: string,
  line: DubSynthLine,
  wordTiming: boolean,
): Promise<LineSynthesis> {
  const sourceWords = line.sourceWords ?? [];
  const usable = wordTiming && sourceWords.length >= 2;

  // Target word times relative to the line start (clamp inside the slot).
  const slotMs = Math.max(MIN_SLOT_MS, line.endMs - line.startMs);
  const targetWords: WarpWord[] = sourceWords.map((w) => {
    const startMs = Math.max(0, w.startMs - line.startMs);
    const endMs = Math.max(startMs + 1, Math.min(slotMs, w.endMs - line.startMs));
    return { startMs, endMs };
  });
  const targetDurMs =
    targetWords.length > 0 ? Math.min(slotMs, Math.max(...targetWords.map((w) => w.endMs))) : slotMs;

  // ---- 1. natural synthesis ----
  let result = await synthesize({ text, voice, ratePct: 0, pitchHz: 0, volumePct: 0 });
  let synthWords: TtsWord[] = result.words;
  let synthDurMs = naturalDurationMs(synthWords, result.bytesLen);
  let speedApplied = 1.0;

  // ---- 2. global rate re-synthesis (natural speech-rate change) ----
  const globalFactor = synthDurMs > 0 ? targetDurMs / synthDurMs : 1;
  if (usable && globalFactor < 0.72) {
    // Way too long → speed the TTS voice up (Edge rate is pitch-preserving).
    const ratePct = Math.min(
      MAX_SPEEDUP_PCT,
      Math.max(5, Math.round((synthDurMs / targetDurMs - 1) * 100)),
    );
    const retry = await synthesize({ text, voice, ratePct, pitchHz: 0, volumePct: 0 });
    const retryDurMs = naturalDurationMs(retry.words, retry.bytesLen);
    if (retryDurMs > 0 && retryDurMs < synthDurMs) {
      result = retry;
      synthWords = retry.words;
      synthDurMs = retryDurMs;
      speedApplied = 1 + ratePct / 100;
    }
  } else if (usable && globalFactor > 1.45) {
    // Way too short — the dub can't stretch that far naturally; keep natural
    // pacing (the segment simply ends early inside its slot).
    return {
      bytes: result.bytes,
      format: "mp3",
      ttsDurMs: synthDurMs,
      speedApplied,
      align: {
        applied: false,
        reason: "translation much shorter than the original — natural pacing kept",
        synthWords: synthWords.length,
        targetWords: targetWords.length,
        globalFactor: Math.round(globalFactor * 1000) / 1000,
      },
    };
  }

  // ---- 3. WSOLA word warp ----
  if (usable && synthWords.length >= 2) {
    try {
      const pcm = await decodeToPcm(result.bytes);
      const warpSynthWords: WarpWord[] = synthWords.map((w) => ({
        startMs: w.offsetMs,
        endMs: w.offsetMs + w.durationMs,
      }));
      const warp = warpWordsToTimeline(pcm, warpSynthWords, targetWords);
      if (warp.applied) {
        return {
          bytes: encodeWav(warp.pcm),
          format: "wav",
          ttsDurMs: Math.round(warp.durationMs),
          speedApplied,
          align: {
            applied: true,
            maxDriftMs: warp.report.maxDriftMs,
            globalFactor: warp.report.globalFactor,
            synthWords: warp.report.synthWords,
            targetWords: warp.report.targetWords,
          },
        };
      }
      // Skipped (already aligned / guardrail) — keep the audio, note why.
      return {
        bytes: result.bytes,
        format: "mp3",
        ttsDurMs: synthDurMs,
        speedApplied,
        align: {
          applied: false,
          reason: warp.report.skippedReason,
          maxDriftMs: warp.report.maxDriftMs,
          synthWords: warp.report.synthWords,
          targetWords: warp.report.targetWords,
          globalFactor: warp.report.globalFactor,
        },
      };
    } catch {
      // Decode/warp failure → classic fit below (never fail the line for it).
    }
  }

  // ---- 4. classic duration fit (no timing data / warp unavailable) ----
  if (synthDurMs > slotMs * OVERFLOW_TOLERANCE) {
    const ratePct = Math.min(
      MAX_SPEEDUP_PCT,
      Math.max(1, Math.round((synthDurMs / slotMs - 1) * 100)),
    );
    const retry = await synthesize({ text, voice, ratePct, pitchHz: 0, volumePct: 0 });
    const retryDurMs = naturalDurationMs(retry.words, retry.bytesLen);
    if (retryDurMs > 0 && retryDurMs < synthDurMs) {
      result = retry;
      synthDurMs = retryDurMs;
      speedApplied = 1 + ratePct / 100;
    }
  }
  // Short audio (< 50% of the slot) is kept — natural pacing, gaps are fine.
  return {
    bytes: result.bytes,
    format: "mp3",
    ttsDurMs: synthDurMs,
    speedApplied,
    align: {
      applied: false,
      reason: usable ? "word warp unavailable" : "no source word timings",
    },
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function synthesizeDubTrack(input: DubSynthInput): Promise<DubSynthResult> {
  const warnings: string[] = [];
  const { voices, pairs } = await getVoiceCatalog();
  const wordTiming = input.wordTiming !== false; // default ON

  // Speaker ids appearing in the lines (sorted, clamped to 0..5).
  const speakerIds = Array.from(
    new Set(input.lines.map((l) => Math.max(0, Math.min(5, Math.round(l.speaker))))),
  ).sort((a, b) => a - b);

  const resolved = new Map<number, ResolvedVoice>();
  const speakers: DubSynthSpeaker[] = [];
  for (const id of speakerIds) {
    const r = resolveSpeakerVoice(id, input, voices, pairs);
    resolved.set(id, r);
    speakers.push({ id, voice: r.voice, gender: r.gender });
  }

  const segments: DubSynthSegment[] = [];
  let alignedCount = 0;
  for (let i = 0; i < input.lines.length; i++) {
    const line = input.lines[i];
    const speaker = Math.max(0, Math.min(5, Math.round(line.speaker)));
    const voice = resolved.get(speaker)?.voice ?? DEFAULT_VOICE;
    const text = (line.translatedText || "").trim();

    if (!text) {
      warnings.push(`line ${i} has empty text — skipped`);
      continue;
    }
    // v1.29: a line with NO speakable characters (punctuation-only, symbols,
    // emoji, whitespace — real cases: garbage transcript tokens like "#" or
    // "…") makes Edge TTS return zero audio, which used to fail the WHOLE
    // dub run with a misleading "voice name is probably invalid" error.
    // Skip it with a warning instead — one bad line must never kill the dub.
    if (!/[\p{L}\p{N}]/u.test(text)) {
      warnings.push(`line ${i} has no speakable text ("${text.slice(0, 12)}") — skipped`);
      continue;
    }

    try {
      const r = await synthesizeLineWithTiming(text, voice, line, wordTiming);
      if (r.align.applied) alignedCount++;
      segments.push({
        startMs: line.startMs,
        endMs: line.endMs,
        speaker,
        sourceText: line.sourceText,
        translatedText: line.translatedText,
        wavPath: "",
        ttsDurMs: r.ttsDurMs,
        speedApplied: r.speedApplied,
        format: r.format,
        align: r.align,
        bytes: r.bytes.toString("base64"),
      });
      if (r.ttsDurMs > Math.max(MIN_SLOT_MS, line.endMs - line.startMs) * OVERFLOW_TOLERANCE) {
        warnings.push(`line ${i} exceeds its slot`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "synthesis failed";
      warnings.push(`line ${i} failed: ${msg}`);
    }
  }

  segments.sort((a, b) => a.startMs - b.startMs);

  if (segments.length === 0 && input.lines.length > 0) {
    const onlyUnspeakable =
      warnings.length > 0 &&
      warnings.every((w) => /no speakable text|empty text/.test(w));
    throw new Error(
      onlyUnspeakable
        ? "No speakable lines in the script — every line is punctuation/symbols only. Re-run transcription on real speech, or edit the script lines."
        : warnings[0] || "Every dubbing line failed to synthesize",
    );
  }
  if (alignedCount > 0) {
    warnings.unshift(
      `word-to-word timing applied to ${alignedCount}/${segments.length} segments`,
    );
  }

  const totalDurationMs = segments.reduce((mx, s) => Math.max(mx, s.startMs + s.ttsDurMs), 0);
  return {
    ok: true,
    language: input.language,
    speakers,
    segments,
    wavPaths: [], // web transport — audio is delivered inline (base64)
    totalDurationMs,
    warnings,
    dubDir: "",
  };
}
