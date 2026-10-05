/**
 * SERVER-ONLY AI model catalogs + provider plumbing (v1.27).
 *
 * Mirrors src/lib/merger/ai-settings.ts (the client store) — the ids here are
 * what the /api/dub + /api/ai routes accept. Three text providers:
 *   builtin — the z-ai SDK (no key, always available)
 *   groq    — api.groq.com chat models (user's key, OpenAI-compatible)
 *   gemini  — generativelanguage.googleapis.com (user's key)
 * Two STT providers: builtin (z-ai ASR) and groq (Whisper, word timestamps).
 */

import { zaiChatText } from "./zai";

// ---------------------------------------------------------------------------
// Catalogs
// ---------------------------------------------------------------------------

export interface ServerModelOption {
  id: string;
  label: string;
  hint: string;
}

export const BUILTIN_TEXT_MODELS: ServerModelOption[] = [
  { id: "glm-4.6", label: "GLM 4.6", hint: "Most capable — best translation quality" },
  { id: "glm-4.5-air", label: "GLM 4.5 Air", hint: "Lighter + fast, solid translations" },
  { id: "glm-4.5", label: "GLM 4.5", hint: "Balanced flagship" },
  { id: "glm-4-plus", label: "GLM 4 Plus", hint: "Steady all-rounder" },
  { id: "glm-4-flash", label: "GLM 4 Flash", hint: "Fastest, short scripts" },
];

export const GROQ_TEXT_MODELS: ServerModelOption[] = [
  { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", hint: "Groq default — best quality" },
  { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B", hint: "Instant — very fast" },
  { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", hint: "OpenAI open-weight 120B" },
  { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B", hint: "OpenAI open-weight 20B" },
  { id: "qwen/qwen3-32b", label: "Qwen 3 32B", hint: "Strong multilingual" },
  { id: "gemma2-9b-it", label: "Gemma 2 9B", hint: "Light multilingual" },
];

export const GEMINI_TEXT_MODELS: ServerModelOption[] = [
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite", hint: "Fastest + generous free tier" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", hint: "Fast, high quality" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite", hint: "Light + fast" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", hint: "Proven all-rounder" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", hint: "Highest quality, slower" },
];

export const GROQ_WHISPER_MODELS: ServerModelOption[] = [
  { id: "whisper-large-v3-turbo", label: "Whisper Large v3 Turbo", hint: "Faster, near-identical accuracy" },
  { id: "whisper-large-v3", label: "Whisper Large v3", hint: "Maximum accuracy" },
];

const BUILTIN_DEFAULT = "glm-4.6";
const GROQ_DEFAULT = "llama-3.3-70b-versatile";
const GEMINI_DEFAULT = "gemini-3.5-flash-lite";
const WHISPER_DEFAULT = "whisper-large-v3-turbo";

// ---------------------------------------------------------------------------
// Provider request shape (what every route passes down)
// ---------------------------------------------------------------------------

export type TextProviderId = "builtin" | "groq" | "gemini";
export type SttProviderId = "builtin" | "groq";

export interface TextProviderRequest {
  provider: TextProviderId;
  model?: string;
  groqKey?: string;
  geminiKey?: string;
}

/** Sanitize a client-supplied provider+model+key combo. */
export function normalizeTextProvider(raw: unknown): TextProviderRequest {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const provider: TextProviderId =
    r.provider === "groq" || r.provider === "gemini" || r.provider === "builtin" ? r.provider : "builtin";
  const groqKey = typeof r.groqKey === "string" ? r.groqKey.trim() : "";
  const geminiKey = typeof r.geminiKey === "string" ? r.geminiKey.trim() : "";
  const pick = (v: unknown, catalog: ServerModelOption[], fallback: string): string => {
    const id = typeof v === "string" ? v.trim() : "";
    return catalog.some((m) => m.id === id) ? id : fallback;
  };
  const model =
    provider === "groq"
      ? pick(r.model, GROQ_TEXT_MODELS, GROQ_DEFAULT)
      : provider === "gemini"
        ? pick(r.model, GEMINI_TEXT_MODELS, GEMINI_DEFAULT)
        : pick(r.model, BUILTIN_TEXT_MODELS, BUILTIN_DEFAULT);
  // Groq/Gemini REQUIRE their key — without one the call degrades to builtin.
  if (provider === "groq" && !groqKey) return { provider: "builtin", model: BUILTIN_DEFAULT };
  if (provider === "gemini" && !geminiKey) return { provider: "builtin", model: BUILTIN_DEFAULT };
  return { provider, model, groqKey, geminiKey };
}

// ---------------------------------------------------------------------------
// One chat completion through the selected provider
// ---------------------------------------------------------------------------

const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const PROVIDER_TIMEOUT_MS = 120_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PROVIDER_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function groqChat(
  system: string,
  user: string,
  req: TextProviderRequest,
  maxTokens: number,
): Promise<string> {
  const res = await fetchWithTimeout(GROQ_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${req.groqKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: req.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Groq ${res.status}: ${body.slice(0, 300)}`);
  }
  const j = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return j.choices?.[0]?.message?.content ?? "";
}

async function geminiChat(
  system: string,
  user: string,
  req: TextProviderRequest,
  maxTokens: number,
): Promise<string> {
  const res = await fetchWithTimeout(
    `${GEMINI_BASE}/models/${encodeURIComponent(req.model ?? GEMINI_DEFAULT)}:generateContent`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": req.geminiKey ?? "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: maxTokens,
        },
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 300)}`);
  }
  const j = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
}

/** Provider-agnostic chat completion → assistant text. Retries once on 429. */
export async function providerChatText(
  system: string,
  user: string,
  req: TextProviderRequest,
  opts?: { maxTokens?: number },
): Promise<string> {
  const maxTokens = opts?.maxTokens ?? 16000;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (req.provider === "groq") return await groqChat(system, user, req, maxTokens);
      if (req.provider === "gemini") return await geminiChat(system, user, req, maxTokens);
      return await zaiChatText(system, user, { maxTokens, model: req.model });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const rateLimited = /429|Too many requests/i.test(msg) || /aborted|timeout/i.test(msg) === false && /5\d\d/.test(msg);
      if (rateLimited && attempt === 1) {
        await new Promise((res) => setTimeout(res, 1500));
        continue;
      }
      throw err;
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Key testing (POST /api/ai/test)
// ---------------------------------------------------------------------------

export async function testProviderKey(
  provider: "groq" | "gemini",
  key: string,
): Promise<{ ok: boolean; message: string; models: string[] }> {
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, message: "No key provided", models: [] };
  // v1.29: mask the key in rejection messages so users can tell WHICH key
  // was tested (mirrors the desktop classifier in groq-whisper.js — the
  // auth-rejected request never shows up in the provider's usage console).
  const maskKey = (k: string, head: number) =>
    k.length <= head + 4 ? `${k.slice(0, 3)}…` : `${k.slice(0, head)}…${k.slice(-4)}`;
  const classifyGroq = (status: number, body: string) => {
    let api = "";
    try {
      api = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? "";
    } catch { /* non-JSON */ }
    const raw = api ? ` [${api}]` : "";
    if (status === 401 || status === 403) {
      return `Groq rejected the API key (${maskKey(trimmed, 7)}) — re-save a valid key from console.groq.com → API Keys${raw}`;
    }
    if (status === 429) return `Groq rate limit reached — wait a moment and test again${raw}`;
    if (status >= 500) return `Groq server error (${status}) — usually transient, try again${raw}`;
    return `Groq request failed (HTTP ${status})${raw}`;
  };
  try {
    if (provider === "groq") {
      const res = await fetchWithTimeout("https://api.groq.com/openai/v1/models", {
        headers: { Authorization: `Bearer ${trimmed}` },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, message: classifyGroq(res.status, body), models: [] };
      }
      const j = (await res.json()) as { data?: { id?: string }[] };
      const whisper = (j.data ?? [])
        .map((m) => m.id ?? "")
        .filter((id) => id.startsWith("whisper"));
      return {
        ok: true,
        message: `Key works — ${whisper.length ? `Whisper available: ${whisper.join(", ")}` : "key authenticated"}`,
        models: whisper,
      };
    }
    const res = await fetchWithTimeout(`${GEMINI_BASE}/models`, {
      headers: { "x-goog-api-key": trimmed },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Google returns 400 with "API key not valid" for bad keys (and
      // 401/403 for restricted ones) — route all key-shaped failures to
      // the same actionable text.
      let api = "";
      try {
        api = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? "";
      } catch { /* non-JSON */ }
      const keyish =
        res.status === 401 ||
        res.status === 403 ||
        (res.status === 400 && /api key|api_key/i.test(api));
      if (keyish) {
        return {
          ok: false,
          message: `Gemini rejected the API key (${maskKey(trimmed, 4)}) — re-save a valid key from aistudio.google.com/apikey${api ? ` [${api}]` : ""}`,
          models: [],
        };
      }
      return { ok: false, message: `Gemini ${res.status}: ${body.slice(0, 200)}`, models: [] };
    }
    const j = (await res.json()) as { models?: { name?: string }[] };
    const names = (j.models ?? [])
      .map((m) => (m.name ?? "").replace(/^models\//, ""))
      .filter((n) => n.startsWith("gemini"))
      .slice(0, 40);
    return { ok: true, message: `Key works — ${names.length} Gemini models`, models: names };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: msg, models: [] };
  }
}
