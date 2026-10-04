/**
 * SERVER-ONLY dubbing script generation (speaker detection + translation).
 *
 * One LLM call (v1.27: through the SELECTED provider — built-in cloud /
 * Groq / Gemini, configured in the Settings tab) turns timed source
 * utterances into a JSON dubbing script (speakerCount + per-line speaker +
 * translation). Parsing is defensive (fences / extra prose), with ONE stricter
 * retry, then a simpler translation-only fallback, then keeping the source
 * text with a warning.
 */

import { providerChatText, type TextProviderRequest } from "./ai-models";
import { dubLangName, dubScriptHint } from "./dub-langs";

// ---------------------------------------------------------------------------
// Public shapes (DubScriptResult contract)
// ---------------------------------------------------------------------------

export interface ScriptUtterance {
  startMs: number;
  endMs: number;
  text: string;
}

export interface DubScriptLine {
  i: number;
  startMs: number;
  endMs: number;
  speaker: number;
  sourceText: string;
  translatedText: string;
}

export interface DubScriptResult {
  ok: true;
  targetLanguage: string;
  targetLanguageName: string;
  speakerCount: number;
  lines: DubScriptLine[];
  warnings: string[];
}

export interface BuildScriptInput {
  utterances: ScriptUtterance[];
  sourceLanguage?: string;
  /** ISO code, default "hi". */
  targetLanguage: string;
  style?: string;
  /** v1.27: provider + model + keys from the Settings tab. */
  provider?: TextProviderRequest;
}

// ---------------------------------------------------------------------------
// LLM plumbing
// ---------------------------------------------------------------------------

interface LlmLine {
  i: number;
  speaker: number;
  sourceText: string;
  translatedText: string;
}

interface LlmScript {
  speakerCount: number;
  lines: LlmLine[];
}

/** Extract the first `{`…last `}` JSON substring (after fence stripping). */
function extractJsonObject(raw: string): string | null {
  let s = String(raw || "").trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  if (fence && fence[1].trim()) s = fence[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  return s.slice(first, last + 1);
}

function isLlmScript(v: unknown): v is LlmScript {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.speakerCount === "number" &&
    Array.isArray(s.lines) &&
    s.lines.every(
      (l) =>
        l &&
        typeof l === "object" &&
        typeof (l as Record<string, unknown>).translatedText === "string",
    )
  );
}

function buildUserPrompt(input: BuildScriptInput, strict: boolean): string {
  const lang = input.targetLanguage;
  const name = dubLangName(lang);
  const hint = dubScriptHint(lang);
  const sourceHint = input.sourceLanguage
    ? `The source language is ${dubLangName(input.sourceLanguage)}. `
    : "";
  const styleHint = input.style ? `Tone/register: ${input.style}. ` : "";
  const lines = input.utterances
    .map(
      (u, i) =>
        `[${i}] ${u.startMs}ms–${u.endMs}ms: ${JSON.stringify(u.text.slice(0, 600))}`,
    )
    .join("\n");

  const instructions = [
    `${sourceHint}${styleHint}You are given ${input.utterances.length} timed utterances from one video.`,
    "(a) Detect how many DISTINCT speakers appear (1 to 6) based on conversational cues.",
    "(b) Assign each line a speaker index 0..N-1 (0 = first speaker).",
    `(c) Translate each line's text to ${name} (${hint}) — natural dubbing register, meaning preserved, no transliteration to Latin.`,
    `(d) Output STRICT JSON ONLY, no markdown fences, no commentary: {"speakerCount":N,"lines":[{"i":0,"speaker":0,"sourceText":"...","translatedText":"..."}]} with exactly ${input.utterances.length} line objects.`,
    strict
      ? "Your previous reply was not valid. Return ONLY the raw JSON object starting with { and ending with }. One entry per input line, in order."
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `${instructions}\n\nUtterances:\n${lines}`;
}

const SYSTEM_PROMPT =
  "You are a professional dubbing script writer. You always reply with strict JSON, no prose, no markdown.";

/** Batch-translate fallback when the full script call fails to parse. */
async function batchTranslate(
  utterances: ScriptUtterance[],
  lang: string,
  provider: TextProviderRequest,
): Promise<Map<number, string> | null> {
  const name = dubLangName(lang);
  const hint = dubScriptHint(lang);
  const numbered = utterances.map((u, i) => `${i}: ${u.text}`).join("\n");
  const raw = await providerChatText(
    "You are a translator. You always reply with strict JSON, no prose.",
    `Translate each numbered line to ${name} (${hint}). Keep meaning and register natural for dubbing.\n${numbered}\n\nReturn ONLY a JSON array: [{"i":0,"translatedText":"..."}] with one object per input line.`,
    provider,
    { maxTokens: 8000 },
  );
  let s = raw.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  if (fence && fence[1].trim()) s = fence[1].trim();
  const first = s.indexOf("[");
  const last = s.lastIndexOf("]");
  if (first < 0 || last <= first) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(s.slice(first, last + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const map = new Map<number, string>();
  for (const item of parsed) {
    if (item && typeof item === "object") {
      const e = item as Record<string, unknown>;
      if (typeof e.i === "number" && typeof e.translatedText === "string" && e.translatedText.trim()) {
        map.set(e.i, e.translatedText.trim());
      }
    }
  }
  return map.size > 0 ? map : null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function buildDubScript(input: BuildScriptInput): Promise<DubScriptResult> {
  const lang = (input.targetLanguage || "hi").toLowerCase();
  const warnings: string[] = [];
  const utterances = input.utterances;
  const provider: TextProviderRequest = input.provider ?? { provider: "builtin", model: "glm-4.6" };

  let llm: LlmScript | null = null;
  // Two attempts: normal prompt, then a stricter retry.
  for (let attempt = 0; attempt < 2 && !llm; attempt++) {
    let raw = "";
    try {
      raw = await providerChatText(
        SYSTEM_PROMPT,
        buildUserPrompt(input, attempt > 0),
        provider,
        { maxTokens: 16000 },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "LLM call failed";
      warnings.push(`script attempt ${attempt + 1} failed: ${msg}`);
      continue;
    }
    const jsonStr = extractJsonObject(raw);
    if (!jsonStr) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      continue;
    }
    if (isLlmScript(parsed) && parsed.lines.length === utterances.length) {
      llm = parsed;
    }
  }

  let speakerCount = 1;
  let translations: Map<number, string> | null = null;

  if (llm) {
    speakerCount = Math.max(1, Math.min(6, Math.round(llm.speakerCount)));
    translations = new Map();
    for (let k = 0; k < llm.lines.length; k++) {
      const line = llm.lines[k];
      // Prefer the line whose `i` matches; fall back to positional order.
      const idx = Number.isInteger(line.i) && line.i >= 0 && line.i < utterances.length ? line.i : k;
      translations.set(idx, line.translatedText);
    }
  } else {
    // Fallback: speaker 0 everywhere + one simpler translation call.
    speakerCount = 1;
    warnings.push("script JSON parse failed twice; using single-speaker fallback");
    try {
      translations = await batchTranslate(utterances, lang, provider);
    } catch {
      translations = null;
    }
    if (!translations) {
      warnings.push("translation fallback failed; keeping source text");
    }
  }

  const lines: DubScriptLine[] = utterances.map((u, i) => {
    // Never trust LLM timings/indices — copy from the input utterances.
    let speaker = 0;
    if (llm) {
      const match = llm.lines.find((l) => l.i === i) || llm.lines[i];
      speaker = Math.round(Number(match?.speaker ?? 0));
    }
    speaker = Math.max(0, Math.min(5, speaker));
    const translated = translations?.get(i)?.trim();
    return {
      i,
      startMs: u.startMs,
      endMs: u.endMs,
      speaker,
      sourceText: u.text,
      translatedText: translated || u.text,
    };
  });

  return {
    ok: true,
    targetLanguage: lang,
    targetLanguageName: dubLangName(lang),
    speakerCount,
    lines,
    warnings,
  };
}
