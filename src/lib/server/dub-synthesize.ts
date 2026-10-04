/**
 * SERVER-ONLY dubbing synthesis — per-speaker Edge-TTS voices + duration fit.
 *
 * Each script line is synthesized with its speaker's resolved voice. When the
 * natural TTS duration overruns the line's timeline slot by > 12%, the line is
 * re-synthesized ONCE with a speed-up rate (≤ +60%); if it still overruns it
 * is accepted with a warning. Short audio is never stretched (natural pacing).
 */

import { getVoiceCatalog, synthesize } from "./edge-tts";
import type { TtsVoice, TtsVoicePair, TtsWord } from "./edge-tts";

// ---------------------------------------------------------------------------
// Public shapes (web DubTrackResult contract)
// ---------------------------------------------------------------------------

export interface DubSynthLine {
  speaker: number;
  sourceText: string;
  translatedText: string;
  startMs: number;
  endMs: number;
}

export interface DubSynthSpeaker {
  id: number;
  voice: string;
  gender: string;
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
  bytes: string; // base64 MP3
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
// Entry point
// ---------------------------------------------------------------------------

export async function synthesizeDubTrack(input: DubSynthInput): Promise<DubSynthResult> {
  const warnings: string[] = [];
  const { voices, pairs } = await getVoiceCatalog();

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
  for (let i = 0; i < input.lines.length; i++) {
    const line = input.lines[i];
    const speaker = Math.max(0, Math.min(5, Math.round(line.speaker)));
    const voice = resolved.get(speaker)?.voice ?? DEFAULT_VOICE;
    const text = (line.translatedText || "").trim();

    if (!text) {
      warnings.push(`line ${i} has empty text — skipped`);
      continue;
    }

    const slotMs = Math.max(MIN_SLOT_MS, line.endMs - line.startMs);

    try {
      // First synthesis at natural speed.
      let result = await synthesize({ text, voice, ratePct: 0, pitchHz: 0, volumePct: 0 });
      let ttsDurMs = naturalDurationMs(result.words, result.bytesLen);
      let speedApplied = 1.0;

      // Duration fit: one speed-up re-synthesis when clearly too long.
      if (ttsDurMs > slotMs * OVERFLOW_TOLERANCE) {
        const ratePct = Math.min(
          MAX_SPEEDUP_PCT,
          Math.max(1, Math.round((ttsDurMs / slotMs - 1) * 100)),
        );
        const retry = await synthesize({ text, voice, ratePct, pitchHz: 0, volumePct: 0 });
        const retryDurMs = naturalDurationMs(retry.words, retry.bytesLen);
        if (retryDurMs > 0 && retryDurMs < ttsDurMs) {
          result = retry;
          ttsDurMs = retryDurMs;
        }
        speedApplied = 1 + ratePct / 100;
        if (ttsDurMs > slotMs * OVERFLOW_TOLERANCE) {
          warnings.push(`line ${i} exceeds its slot`);
        }
      }
      // Short audio (< 50% of the slot) is kept — natural pacing, gaps are fine.

      segments.push({
        startMs: line.startMs,
        endMs: line.endMs,
        speaker,
        sourceText: line.sourceText,
        translatedText: line.translatedText,
        wavPath: "",
        ttsDurMs,
        speedApplied,
        bytes: result.bytes.toString("base64"),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "synthesis failed";
      warnings.push(`line ${i} failed: ${msg}`);
    }
  }

  segments.sort((a, b) => a.startMs - b.startMs);

  if (segments.length === 0 && input.lines.length > 0) {
    throw new Error(
      warnings[0] || "Every dubbing line failed to synthesize",
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
