import { NextResponse } from "next/server";

import { DUB_LANG_NAMES } from "@/lib/server/dub-langs";
import {
  BUILTIN_TEXT_MODELS,
  GEMINI_TEXT_MODELS,
  GROQ_TEXT_MODELS,
  GROQ_WHISPER_MODELS,
} from "@/lib/server/ai-models";

export const runtime = "nodejs";

/**
 * Web dubbing "models" — v1.27: the FULL provider catalogs (built-in GLM /
 * Groq chat / Gemini / Groq Whisper) that the Settings tab and the Dub Studio
 * summary use. `langNames` feeds the Dubbing language dropdown.
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    models: [], // legacy Groq-chat slot (the Dub stage-2 picker is gone)
    langNames: DUB_LANG_NAMES,
    provider: "web",
    web: true,
    builtin: { models: BUILTIN_TEXT_MODELS, default: "glm-4.6" },
    groq: { models: GROQ_TEXT_MODELS, default: "llama-3.3-70b-versatile" },
    gemini: { models: GEMINI_TEXT_MODELS, default: "gemini-3.5-flash-lite" },
    whisper: { models: GROQ_WHISPER_MODELS, default: "whisper-large-v3-turbo" },
  });
}
