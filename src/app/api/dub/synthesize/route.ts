import { NextRequest, NextResponse } from "next/server";

import { synthesizeDubTrack } from "@/lib/server/dub-synthesize";
import type { DubSynthLine } from "@/lib/server/dub-synthesize";
import { pairsCached } from "@/lib/server/edge-tts";
import { dubLocaleForLang } from "@/lib/server/dub-langs";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_LINES = 500;

function bad(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

function parseLines(raw: unknown): DubSynthLine[] | null {
  if (!Array.isArray(raw)) return null;
  const out: DubSynthLine[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.sourceText !== "string") return null;
    if (typeof e.translatedText !== "string") return null;
    if (typeof e.startMs !== "number" || !Number.isFinite(e.startMs)) return null;
    if (typeof e.endMs !== "number" || !Number.isFinite(e.endMs)) return null;
    const speaker =
      typeof e.speaker === "number" && Number.isFinite(e.speaker) ? Math.round(e.speaker) : 0;
    out.push({
      speaker,
      sourceText: e.sourceText,
      translatedText: e.translatedText,
      startMs: Math.round(e.startMs),
      endMs: Math.round(e.endMs),
    });
  }
  return out;
}

function parseVoiceMap(raw: unknown): Record<string, string> | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d+$/.test(key)) continue;
    if (typeof value !== "string" || !value.trim()) continue;
    out[key] = value.trim();
  }
  return out;
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad("Request body must be JSON", 400);
  }

  const lines = parseLines(body.lines);
  if (!lines || lines.length === 0) {
    return bad(
      "lines is required: a non-empty array of { speaker, sourceText, translatedText, startMs, endMs }",
      400,
    );
  }
  if (lines.length > MAX_LINES) {
    return bad(`Too many lines — the limit is ${MAX_LINES}`, 400);
  }

  let language = "hi";
  if (typeof body.language === "string" && body.language.trim()) {
    language = body.language.trim().toLowerCase();
  }

  let targetLocale = "";
  if (typeof body.targetLocale === "string") {
    targetLocale = body.targetLocale.trim();
  }
  if (!targetLocale) {
    // Derive a locale from the language code (e.g. "hi" → "hi-IN").
    try {
      targetLocale = dubLocaleForLang(language, await pairsCached()) || "";
    } catch {
      targetLocale = "";
    }
  }

  const singleVoiceRaw = body.singleVoice;
  if (singleVoiceRaw !== undefined && singleVoiceRaw !== null && typeof singleVoiceRaw !== "string") {
    return bad("singleVoice must be a voice ShortName or null", 400);
  }
  const singleVoice =
    typeof singleVoiceRaw === "string" && singleVoiceRaw.trim() ? singleVoiceRaw.trim() : null;

  const voices = parseVoiceMap(body.voices);

  try {
    const result = await synthesizeDubTrack({
      language,
      targetLocale,
      lines,
      voices,
      singleVoice,
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Dubbing synthesis failed";
    return bad(message, 500);
  }
}
