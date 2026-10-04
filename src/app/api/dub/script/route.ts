import { NextRequest, NextResponse } from "next/server";

import { buildDubScript } from "@/lib/server/dub-script";
import type { ScriptUtterance } from "@/lib/server/dub-script";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_UTTERANCES = 500;

function bad(error: string, status: number) {
  return NextResponse.json({ ok: false, error }, { status });
}

/** Validate + normalize the utterances array (timings are copied verbatim). */
function parseUtterances(raw: unknown): ScriptUtterance[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ScriptUtterance[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.text !== "string" || !e.text.trim()) return null;
    if (typeof e.startMs !== "number" || !Number.isFinite(e.startMs)) return null;
    if (typeof e.endMs !== "number" || !Number.isFinite(e.endMs)) return null;
    out.push({
      startMs: Math.max(0, Math.round(e.startMs)),
      endMs: Math.max(0, Math.round(e.endMs)),
      text: e.text,
    });
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

  const utterances = parseUtterances(body.utterances);
  if (!utterances || utterances.length === 0) {
    return bad(
      "utterances is required: a non-empty array of { startMs, endMs, text }",
      400,
    );
  }
  if (utterances.length > MAX_UTTERANCES) {
    return bad(`Too many utterances — the limit is ${MAX_UTTERANCES}`, 400);
  }

  let targetLanguage = "hi";
  if (typeof body.targetLanguage === "string" && body.targetLanguage.trim()) {
    targetLanguage = body.targetLanguage.trim().toLowerCase();
  }
  if (!/^[a-z]{2,3}(-[a-z0-9-]+)?$/i.test(targetLanguage)) {
    return bad("targetLanguage must be a language code like \"hi\" or \"pt-BR\"", 400);
  }

  const sourceLanguage =
    typeof body.sourceLanguage === "string" && body.sourceLanguage.trim()
      ? body.sourceLanguage.trim().toLowerCase()
      : undefined;
  const style =
    typeof body.style === "string" && body.style.trim() ? body.style.trim().slice(0, 120) : undefined;

  try {
    const result = await buildDubScript({ utterances, sourceLanguage, targetLanguage, style });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Script generation failed";
    return bad(message, 500);
  }
}
