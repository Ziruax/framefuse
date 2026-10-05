import { NextRequest, NextResponse } from "next/server";

import { testProviderKey } from "@/lib/server/ai-models";

export const runtime = "nodejs";

/** POST /api/ai/test — validate a Groq or Gemini API key (Settings tab). */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Request body must be JSON" }, { status: 400 });
  }
  const provider = body.provider === "gemini" ? "gemini" : body.provider === "groq" ? "groq" : null;
  if (!provider) {
    return NextResponse.json(
      { ok: false, error: 'provider must be "groq" or "gemini"' },
      { status: 400 },
    );
  }
  const key = typeof body.key === "string" ? body.key : "";
  // v1.30: the Groq test now probes a REAL transcription with the selected
  // whisper model — the Settings tab sends its sttGroqModel pick.
  const model = typeof body.model === "string" ? body.model : undefined;
  const r = await testProviderKey(provider, key, { model });
  return NextResponse.json(r, { status: r.ok ? 200 : 400 });
}
