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
import { groqClient, sdkErrorFacts, groqJobError, resolveGroqKey } from "./groq-sdk-client";

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
  { id: "qwen/qwen3.8-27b", label: "Qwen 3.8 27B", hint: "Strong multilingual" },
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
const GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

/** v1.30 — 1 second of 16 kbps mono silence (2,384 B) as base64. The key
 *  test POSTs this to /audio/transcriptions so "key works" is verified with
 *  a REAL transcription request (same multipart contract as production).
 *  Groq's minimum billed length is 10s → one Test click bills ~$0.0001. */
const PROBE_MP3_B64 =
  "SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYxLjcuMTAzAAAAAAAAAAAAAAD/81jAAAAAAAAAAAAASW5mbwAAAA8AAAAeAAAJJAAbGxsjIyMrKyszMzMzOzs7QkJCSkpKSlJSUlpaWmJiYmJqampycnJ6enp6gYGBiYmJkZGRkZmZmaGhoampqamxsbG5ubnAwMDAyMjI0NDQ2NjY2ODg4Ojo6PDw8PD4+Pj///8AAAAATGF2YzYxLjE5AAAAAAAAAAAAAAAAJALAAAAAAAAACSSDldJ3AAAAAAAAAAAAAAD/8yjEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjEOwAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjEdgAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjEsQAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=";
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

/** v1.33: the official groq-sdk is the chat request engine (user brief).
 *  The route-level key resolution (Settings key → GROQ_API_KEY env) happens
 *  in the request layer; here the key must already be resolved. */
async function groqChat(
  system: string,
  user: string,
  req: TextProviderRequest,
  maxTokens: number,
): Promise<string> {
  const key = resolveGroqKey(req.groqKey);
  if (!key) throw new Error("No Groq key configured (Settings or GROQ_API_KEY)");
  const client = groqClient(key);
  try {
    const completion = await client.chat.completions.create({
      model: req.model ?? GROQ_DEFAULT,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      max_tokens: maxTokens,
    });
    return completion.choices?.[0]?.message?.content ?? "";
  } catch (e) {
    const f = sdkErrorFacts(e);
    if (f.status) {
      throw new Error(`Groq ${f.status}: ${f.bodyText.slice(0, 300) || f.apiMessage}`);
    }
    throw new Error(`Groq connection failed: ${String((e as Error).message)}`);
  }
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
  opts?: { model?: string },
): Promise<{ ok: boolean; message: string; models: string[]; job?: { service: string; code: string; message: string; retryable: boolean } }> {
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, message: "No key provided", models: [] };
  // v1.29: mask the key in rejection messages so users can tell WHICH key
  // was tested (mirrors the desktop classifier in groq-whisper.js — the
  // auth-rejected request never shows up in the provider's usage console).
  const maskKey = (k: string, head: number) =>
    k.length <= head + 4 ? `${k.slice(0, 3)}…` : `${k.slice(0, head)}…${k.slice(-4)}`;
  /** v1.31: parse the error message out of a provider body, note whether
   *  the body is the provider's JSON envelope at all, and capture the
   *  documented error.type field. Groq's own API errors ALWAYS carry
   *  {message, type} (console.groq.com/docs/errors). A JSON 401/403 WITHOUT
   *  type — the bare {"error":{"message":"Forbidden"}} — is Groq's
   *  Cloudflare EDGE refusing the connection (IP-range block): the key was
   *  never checked and the console will show zero requests. A non-JSON
   *  401/403 is a network-level block that never reached the provider. */
  const parseApiError = (body: string): { api: string; errType: string; errCode: string; isJson: boolean } => {
    try {
      const j = JSON.parse(body) as { error?: { message?: string; type?: string; code?: string }; message?: string };
      return {
        api: j.error?.message ?? j.message ?? "",
        errType: j.error?.type ?? "",
        errCode: j.error?.code ?? "",
        isJson: true,
      };
    } catch {
      return { api: "", errType: "", errCode: "", isJson: false };
    }
  };
  const classifyGroq = (status: number, body: string) => {
    const { api, errType, errCode, isJson } = parseApiError(body);
    const raw = api ? ` [${api}]` : "";
    if (status === 401 || status === 403) {
      // (1) Non-JSON (HTML challenge / plain text): the request was blocked
      // BEFORE Groq — the key was never checked.
      if (!isJson) {
        return `The request to api.groq.com was BLOCKED before reaching Groq (status ${status}, non-JSON response — VPN, proxy, firewall or TLS interception) — the key was never checked${raw}`;
      }
      // (2) v1.31: JSON WITHOUT error.type — the bare
      // {"error":{"message":"Forbidden"}} — is Groq's CLOUDFLARE EDGE
      // refusing the connection (IP-range block), NOT the Groq API. The key
      // was never checked; console.groq.com will show ZERO requests. This is
      // the true root cause behind "my key is accurate but Groq rejects it,
      // and no API call appears in the console".
      if (!errType) {
        return `Groq's network edge (Cloudflare) REFUSED the connection (${status} Forbidden) — the request never reached Groq's API, so the key was never checked and console.groq.com will show ZERO requests (expected, not a bug). Cloudflare blocks whole IP ranges when a neighbor on your ISP/VPN range trips abuse rules. Fix: switch networks (phone hotspot), toggle VPN/proxy on/off, or retry in ~15 minutes${raw}`;
      }
      // (3) JSON WITH error.type — the genuine Groq API answered.
      if (status === 401) {
        return `Groq rejected the API key (${maskKey(trimmed, 7)}) — re-save a valid key from console.groq.com → API Keys${raw}`;
      }
      return `Groq refused access for this key (${maskKey(trimmed, 7)}) — a permission restriction (suspended org or restricted model)${raw}`;
    }
    if (status === 404) {
      // v1.32: a GENUINE Groq 404 (JSON envelope WITH error.type/code) is
      // model availability. A 404 WITHOUT that envelope never came from
      // Groq's API — an intermediary (OS proxy, VPN, antivirus web-filter)
      // answered the upload itself. That is the "key authenticates but the
      // real transcription 404s" signature on interceptor machines.
      if (isJson && (errType || errCode)) {
        return `Groq does not recognize the model for this key${raw}`;
      }
      return `The transcription endpoint answered 404 — but this response did NOT come from Groq's API (no Groq error envelope). Something on this machine or network (a proxy, VPN, or antivirus "web protection" that scans HTTPS) intercepted the upload and answered it — the key is fine (it just authenticated) and the model is current. Fix: disable HTTPS/TLS scanning for this app in your antivirus, toggle the VPN/proxy, or use another network${raw}`;
    }
    if (status === 429) return `Groq rate limit reached — wait a moment and test again${raw}`;
    if (status >= 500) return `Groq server error (${status}) — usually transient, try again${raw}`;
    return `Groq request failed (HTTP ${status})${raw}`;
  };
  try {
    if (provider === "groq") {
      // v1.33: the OFFICIAL groq-sdk is the request engine (user brief).
      const client = groqClient(trimmed);
      // Step 1 — does the key authenticate at all? (GET /models via SDK)
      let whisper: string[] = [];
      try {
        const page = await client.models.list();
        const listed = (page as { data?: { id?: string }[] }).data ?? [];
        whisper = listed
          .map((m) => m.id ?? "")
          .filter((id) => id.startsWith("whisper"));
      } catch (e) {
        const f = sdkErrorFacts(e);
        return {
          ok: false,
          message: f.status ? classifyGroq(f.status, f.bodyText) : `Could not reach api.groq.com: ${String((e as Error).message)}`,
          models: [],
          job: f.status ? groqJobError(f.status, f.bodyText, !!(f.errType), classifyGroq(f.status, f.bodyText)) : { service: "groq", code: "GROQ_CONNECTION", message: String((e as Error).message), retryable: true },
        };
      }
      // Step 2 (v1.30) — a REAL transcription probe: POST the embedded
      // 1-second silent MP3 to /audio/transcriptions with the selected
      // whisper model (same endpoint + multipart contract as production
      // transcription, per console.groq.com/docs/speech-to-text). "Key
      // works" now means TRANSCRIPTION works, end to end.
      const model =
        opts?.model?.trim() && GROQ_WHISPER_MODELS.some((m) => m.id === opts?.model?.trim())
          ? (opts?.model?.trim() as string)
          : WHISPER_DEFAULT;
      const runProbe = async (
        modelId: string,
      ): Promise<{ ok: boolean; status: number; bodyText: string }> => {
        try {
          await client.audio.transcriptions.create({
            file: new File([Buffer.from(PROBE_MP3_B64, "base64")], "probe.mp3", {
              type: "audio/mpeg",
            }),
            model: modelId,
            response_format: "json",
          });
          return { ok: true, status: 200, bodyText: "" };
        } catch (e) {
          const f = sdkErrorFacts(e);
          return { ok: false, status: f.status, bodyText: f.bodyText };
        }
      };
      // v1.32: a 404 on the probe first gets ONE silent retry with the OTHER
      // whisper model (Groq decommissions models — a stored selection can
      // age out) before the failure is surfaced.
      let probedModel = model;
      let probeRes = await runProbe(probedModel);
      if (probeRes.status === 404) {
        const alt =
          probedModel === "whisper-large-v3" ? "whisper-large-v3-turbo" : "whisper-large-v3";
        const altRes = await runProbe(alt);
        probeRes = altRes;
        if (altRes.ok) probedModel = alt;
      }
      if (!probeRes.ok) {
        const classified = classifyGroq(probeRes.status, probeRes.bodyText);
        let probeGenuine = false;
        try {
          probeGenuine = !!(JSON.parse(probeRes.bodyText) as { error?: { type?: string; code?: string } }).error?.type;
        } catch {
          probeGenuine = false;
        }
        return {
          ok: false,
          message: `The key authenticates, but a real transcription test failed: ${classified}`,
          models: whisper,
          job: groqJobError(probeRes.status, probeRes.bodyText, probeGenuine, classified),
        };
      }
      return {
        ok: true,
        message: `Key works — real transcription verified end to end (${probedModel}; the key, the model and the upload all passed)`,
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
      const { api, isJson } = parseApiError(body);
      // v1.31: Gemini's geo-restriction gets its own actionable text.
      if (/location is not supported/i.test(api)) {
        return {
          ok: false,
          message: `Google does not offer the Gemini API in your region — connect through a VPN (any supported country) or switch the provider to Groq${api ? ` [${api}]` : ""}`,
          models: [],
        };
      }
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
      if (!isJson && (res.status === 401 || res.status === 403)) {
        return {
          ok: false,
          message: `The request to Google was BLOCKED before reaching the Gemini API (status ${res.status}, non-JSON response — VPN, proxy or firewall) — the key was never checked`,
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
