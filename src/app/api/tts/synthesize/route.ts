import { NextRequest, NextResponse } from "next/server";

import { getVoiceCatalog, synthesize, synthesizeLongText } from "@/lib/server/edge-tts";
import type { TtsVoice, TtsWord } from "@/lib/server/edge-tts";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_TEXT_CHARS = 400_000; // hard cap for the web route (chunked engine handles the rest)
const LONG_TEXT_THRESHOLD = 2_800; // ≤ → single shot; > → synthesizeLong chunking

// API-level clamps (the engine clamps further internally).
const RATE_PCT_RANGE = [-50, 100] as const;
const PITCH_HZ_RANGE = [-50, 50] as const;
const VOLUME_RANGE = [0, 2] as const; // linear multiplier: 1 = unchanged

// ShortName shape, e.g. "hi-IN-SwaraNeural" / "en-US-AndrewMultilingualNeural".
const SHORTNAME_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*Neural$/;
const DEFAULT_VOICE = "en-US-AriaNeural";

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  const raw = body[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return Number.NaN;
  return raw;
}

/** Normalize + sanitize the requested voice.
 *  Returns a usable ShortName, or null when the input doesn't look like one. */
async function sanitizeVoice(raw: unknown): Promise<string | null> {
  if (typeof raw !== "string") return null;
  const voice = raw.trim();
  if (!voice) return null;
  if (!SHORTNAME_RE.test(voice)) return null;
  const { voices }: { voices: TtsVoice[] } = await getVoiceCatalog();
  const lower = voice.toLowerCase();
  const exact = voices.find((v) => v.shortName.toLowerCase() === lower);
  if (exact) return exact.shortName;
  // Unknown ShortName → first catalog voice of the same locale (keeps the
  // user's language choice), else a sane default.
  const locale = voice.split("-").slice(0, 2).join("-");
  const sameLocale = voices.find((v) => v.locale.toLowerCase() === locale.toLowerCase());
  return sameLocale ? sameLocale.shortName : DEFAULT_VOICE;
}

interface SynthesizeResponse {
  ok: true;
  bytes: string;
  bytesLen: number;
  mimeType: "audio/mpeg";
  words: TtsWord[];
  chunkCount: number;
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Request body must be JSON" }, { status: 400 });
  }

  // ---- text ----
  const text = typeof body.text === "string" ? body.text : "";
  if (!text.trim()) {
    return NextResponse.json(
      { ok: false, error: "text is required and must be a non-empty string" },
      { status: 400 },
    );
  }
  if (text.length > MAX_TEXT_CHARS) {
    return NextResponse.json(
      {
        ok: false,
        error: `text is ${text.length} characters — the web route caps at ${MAX_TEXT_CHARS}`,
      },
      { status: 400 },
    );
  }

  // ---- voice ----
  let voice: string | null = null;
  try {
    voice = await sanitizeVoice(body.voice);
  } catch {
    voice = null;
  }
  if (!voice) {
    return NextResponse.json(
      {
        ok: false,
        error: 'voice is required and must look like a ShortName, e.g. "hi-IN-SwaraNeural"',
      },
      { status: 400 },
    );
  }

  // ---- prosody (clamp, don't reject — friendly to UI sliders) ----
  const ratePctRaw = optionalNumber(body, "ratePct");
  if (ratePctRaw !== undefined && Number.isNaN(ratePctRaw)) {
    return NextResponse.json({ ok: false, error: "ratePct must be a number" }, { status: 400 });
  }
  const pitchHzRaw = optionalNumber(body, "pitchHz");
  if (pitchHzRaw !== undefined && Number.isNaN(pitchHzRaw)) {
    return NextResponse.json({ ok: false, error: "pitchHz must be a number" }, { status: 400 });
  }
  const volumeRaw = optionalNumber(body, "volume");
  if (volumeRaw !== undefined && Number.isNaN(volumeRaw)) {
    return NextResponse.json({ ok: false, error: "volume must be a number" }, { status: 400 });
  }
  const ratePct = ratePctRaw === undefined ? 0 : clamp(ratePctRaw, RATE_PCT_RANGE[0], RATE_PCT_RANGE[1]);
  const pitchHz = pitchHzRaw === undefined ? 0 : clamp(pitchHzRaw, PITCH_HZ_RANGE[0], PITCH_HZ_RANGE[1]);
  const volume = volumeRaw === undefined ? 1 : clamp(volumeRaw, VOLUME_RANGE[0], VOLUME_RANGE[1]);
  // volume is a linear multiplier (0..2) → SSML volume percentage (-100..+100).
  const volumePct = Math.round(clamp((volume - 1) * 100, -100, 100));

  try {
    const opts = { text, voice, ratePct, pitchHz, volumePct };
    if (text.length <= LONG_TEXT_THRESHOLD) {
      const r = await synthesize(opts);
      const payload: SynthesizeResponse = {
        ok: true,
        bytes: r.bytes.toString("base64"),
        bytesLen: r.bytesLen,
        mimeType: "audio/mpeg",
        words: r.words || [],
        chunkCount: 1,
      };
      return NextResponse.json(payload);
    }
    const r = await synthesizeLongText(opts);
    const payload: SynthesizeResponse = {
      ok: true,
      bytes: r.bytes.toString("base64"),
      bytesLen: r.bytesLen,
      mimeType: "audio/mpeg",
      words: r.words || [],
      chunkCount: r.chunkCount,
    };
    return NextResponse.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Speech synthesis failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
