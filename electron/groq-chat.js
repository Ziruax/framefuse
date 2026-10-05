// electron/groq-chat.js — Groq chat-completions client (cloud LLM).
//
// v1.16 (dubbing) — the dub workflow needs a text model on Groq for two
// jobs: labelling which speaker said each transcript segment, and
// translating the segments into the dub language. This module is the HTTP
// client for POST /openai/v1/chat/completions, deliberately in the same
// style as groq-whisper.js: raw https requests, ZERO dependencies,
// actionable error classification, an abort hook, and polite retries on
// 429 / 5xx / network errors ONLY (never on 400/403 — those are the
// caller's problem, not the network's).
//
// This module is a PLAIN Node module (no Electron imports) so it can be
// smoke-tested directly:
//   node -e "require('./electron/groq-chat')"
//
// Free-tier-friendly text models (GROQ_TEXT_MODELS), UI order:
//   llama-3.3-70b-versatile   (DEFAULT — best quality on the free tier)
//   llama-3.1-8b-instant      (fastest)
//   openai/gpt-oss-120b       (OpenAI open-weight on Groq)
//   openai/gpt-oss-20b        (lighter open-weight)
//   qwen/qwen3-32b            (strong multilingual)
//   gemma2-9b-it              (compact Google model)
//
// JSON mode note: Groq (like OpenAI) requires the word "JSON" to appear
// somewhere in the messages when response_format={"type":"json_object"} is
// set. Every caller in dub-workflow.js includes it in the prompt; keep that
// rule if you add new jsonMode call sites.
//
// Abort contract (same shape as groq-whisper's groqTranscribe):
//   const abortRef = { abort: null };
//   groqChat({ ..., abortRef })   // abortRef.abort is populated
//   abortRef.abort()              // destroys the in-flight request AND any
//                                  // pending retry backoff, rejecting with
//                                  // "Chat request cancelled"

"use strict";

const { createRequest } = require("./net-transport");
const { GROQ_API_HOST, maskApiKey, transportName } = require("./groq-whisper");

const CHAT_PATH = "/openai/v1/chat/completions";
const MODELS_PATH = "/openai/v1/models";

/** Sanity cap on the response body (chat completions are KBs, not MBs). */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Retry backoff for retryable failures: 1.5s, then 4s, then 8s, 16s… */
const BACKOFF_DELAYS_MS = [1500, 4000];

const CANCEL_MSG = "Chat request cancelled";

/** The free-tier-friendly chat models, in UI order.
 *  v1.31: REFRESHED against console.groq.com/docs/models — gemma2-9b-it
 *  and qwen/qwen3-32b are DECOMMISSIONED (they 404 on call: Groq's list is
 *  live-checked at https://api.groq.com/openai/v1/models). qwen/qwen3.8-27b
 *  is the current multilingual workhorse ($0.80/$4.00 per 1M tokens). */
const GROQ_TEXT_MODELS = [
  {
    id: "llama-3.3-70b-versatile",
    label: "Llama 3.3 70B Versatile",
    hint: "Default — best quality on the free tier",
  },
  {
    id: "llama-3.1-8b-instant",
    label: "Llama 3.1 8B Instant",
    hint: "Fastest, lower quality",
  },
  {
    id: "openai/gpt-oss-120b",
    label: "GPT-OSS 120B",
    hint: "OpenAI open-weight on Groq",
  },
  {
    id: "openai/gpt-oss-20b",
    label: "GPT-OSS 20B",
    hint: "Lighter open-weight",
  },
  {
    id: "qwen/qwen3.8-27b",
    label: "Qwen 3.8 27B",
    hint: "Strong multilingual",
  },
];
const DEFAULT_TEXT_MODEL = "llama-3.3-70b-versatile";

function normalizeTextModel(id) {
  return GROQ_TEXT_MODELS.some((m) => m.id === id) ? id : DEFAULT_TEXT_MODEL;
}

// ---------------------------------------------------------------------------
// Error classification (same approach as groq-whisper's classifyGroqError,
// with chat-completion wording).
// ---------------------------------------------------------------------------

/** Classify a Groq chat-completion failure into an actionable message.
 *  v1.29: `maskedKey` ("gsk_AbC…9xY2") appended to the 401/403 text.
 *  v1.30: non-JSON 401/403 = network-level block.
 *  v1.31: THREE families (mirrors groq-whisper's classifyGroqError — see
 *  the research notes there): non-JSON = intercepted before Groq; bare
 *  JSON WITHOUT error.type (the 33-byte {"error":{"message":"Forbidden"}})
 *  = Groq's CLOUDFLARE EDGE refused the connection (IP-range block — key
 *  never checked, console shows zero calls, regenerating the key changes
 *  nothing); JSON WITH error.type = the genuine Groq API answered
 *  (401 = key refused, 403 = permission restriction). */
function classifyChatError(status, bodyText, maskedKey) {
  let apiMessage = "";
  let errType = "";
  let bodyIsJson = false;
  try {
    const j = JSON.parse(bodyText);
    const e = j && typeof j.error === "object" && j.error ? j.error : null;
    apiMessage = (e && typeof e.message === "string" && e.message) ||
      (j && typeof j.message === "string" ? j.message : "") || "";
    errType = (e && typeof e.type === "string" && e.type) || "";
    bodyIsJson = true;
  } catch (_) { /* non-JSON body */ }
  const raw = apiMessage ? ` [${apiMessage}]` : "";
  const keyPart = maskedKey ? ` (${maskedKey})` : "";
  switch (status) {
    case 401:
    case 403:
      if (!bodyIsJson) {
        return `The request to api.groq.com was BLOCKED before reaching Groq (status ${status}, non-JSON response — VPN, proxy, firewall or TLS interception) — the key was never checked${raw}`;
      }
      if (!errType) {
        return `Groq's network edge (Cloudflare) REFUSED the connection (${status} Forbidden) — the request never reached Groq's API, so the key was never checked and console.groq.com will show ZERO requests (expected, not a bug). Cloudflare blocks whole IP ranges when a neighbor on your ISP/VPN range trips abuse rules; Groq cannot whitelist IPs. Fix: switch networks (phone hotspot), toggle VPN/proxy on/off, or retry in ~15 minutes. Chat AND transcription share this route, so both fail together${raw}`;
      }
      if (status === 401) {
        return `Groq rejected the API key${keyPart} — re-save the key in Settings → Default AI models (console.groq.com → API Keys)${raw}`;
      }
      return `Groq refused access for this key${keyPart} — a permission restriction (suspended organization or a model not enabled for this key)${raw}`;
    case 404:
      return `Groq model not found — this chat model may not be enabled for your key (decommissioned models 404)${raw}`;
    case 400:
      return `Groq rejected the chat request (bad parameters or unsupported option)${raw}`;
    case 429:
      return `Groq rate limit reached — wait a moment and try again${raw}`;
    default:
      if (status >= 500) {
        return `Groq server error (${status}) — usually transient, try again${raw}`;
      }
      return `Groq request failed (HTTP ${status})${raw}`;
  }
}

/** Errors carry `.status` and `.retryable` so the retry loop can decide. */
function makeChatError(message, { status = 0, retryable = false } = {}) {
  const err = new Error(message);
  err.status = status;
  err.retryable = retryable;
  return err;
}

const NET_ERROR_CODES = new Set([
  "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED", "ENOTFOUND",
  "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "ECONNABORTED",
]);

function isNetworkError(err) {
  if (!err) return false;
  if (err.code && NET_ERROR_CODES.has(err.code)) return true;
  const msg = String(err.message || err);
  return /socket hang up|timed out|connection|network/i.test(msg);
}

// ---------------------------------------------------------------------------
// JSON tolerance helpers — LLMs wrap their JSON in prose and code fences.
// ---------------------------------------------------------------------------

/** Strip ``` / ```json code fences from LLM output. */
function stripCodeFences(s) {
  let t = String(s == null ? "" : s).trim();
  if (!t) return "";
  // Whole-response fence: ```json\n{…}\n```
  const whole = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(t);
  if (whole) return whole[1].trim();
  // Fences embedded mid-text (before/after the payload).
  t = t.replace(/```[a-zA-Z0-9_-]*\s*/g, "").replace(/```/g, "");
  return t.trim();
}

/** Extract the first balanced {...} or [...] block (string-aware). */
function extractJsonBlock(s) {
  const start = s.search(/[{[]/);
  if (start < 0) return null;
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function tryParseJson(s) {
  try { return { ok: true, value: JSON.parse(s) }; } catch (_) { /* retry below */ }
  try {
    // Tolerate trailing commas — a classic LLM slip.
    return { ok: true, value: JSON.parse(s.replace(/,\s*([}\]])/g, "$1")) };
  } catch (_) { /* give up */ }
  return { ok: false };
}

/** Best-effort JSON extraction from an LLM reply: strips code fences,
 *  tolerates surrounding prose, returns the first parsed object/array or
 *  null if nothing parseable is found. */
function parseJsonish(str) {
  if (str == null) return null;
  const s = stripCodeFences(str);
  if (!s) return null;
  const direct = tryParseJson(s);
  if (direct.ok) return direct.value;
  const block = extractJsonBlock(s);
  if (block == null) return null;
  const parsed = tryParseJson(block);
  return parsed.ok ? parsed.value : null;
}

// ---------------------------------------------------------------------------
// One chat-completion request (no retries — the wrapper handles those).
// ---------------------------------------------------------------------------

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw makeChatError("groqChat: messages must be a non-empty array");
  }
  return messages.map((m) => {
    if (!m || typeof m !== "object") {
      throw makeChatError("groqChat: every message must be { role, content }");
    }
    if (m.role !== "system" && m.role !== "user" && m.role !== "assistant") {
      throw makeChatError(`groqChat: invalid message role "${String(m.role)}"`);
    }
    if (typeof m.content !== "string") {
      throw makeChatError("groqChat: message content must be a string");
    }
    return { role: m.role, content: m.content };
  });
}

function chatRequestOnce(o) {
  const { apiKey, modelId, messages, temperature, maxTokens, jsonMode, timeoutMs, ctl } = o;
  return new Promise((resolve, reject) => {
    const payload = {
      model: modelId,
      messages,
      temperature,
      max_tokens: maxTokens,
    };
    if (jsonMode) payload.response_format = { type: "json_object" };
    const body = Buffer.from(JSON.stringify(payload), "utf8");

    let timer = null;
    const req = createRequest(
      {
        host: GROQ_API_HOST,
        path: CHAT_PATH,
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": String(body.length),
        },
      },
      (res) => {
        const chunks = [];
        let bytes = 0;
        res.on("data", (d) => {
          chunks.push(d);
          bytes += d.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            req.destroy(new Error("Groq chat response exceeded 10 MB"));
          }
        });
        res.on("end", () => {
          clearTimeout(timer);
          const bodyText = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) {
            // v1.29: masked fingerprint of the key this request carried.
            reject(makeChatError(
              classifyChatError(res.statusCode, bodyText, maskApiKey(apiKey)),
              {
                status: res.statusCode,
                retryable: res.statusCode === 429 || res.statusCode >= 500,
              },
            ));
            return;
          }
          let j;
          try {
            j = JSON.parse(bodyText);
          } catch (err) {
            // A 200 with an unparseable body is almost always a transient
            // gateway hiccup — retryable.
            reject(makeChatError(`Could not parse the Groq chat response: ${err.message}`, { retryable: true }));
            return;
          }
          const choice = j && Array.isArray(j.choices) ? j.choices[0] : null;
          if (!choice || typeof choice !== "object" || !choice.message) {
            reject(makeChatError("Groq returned an empty chat completion", { retryable: true }));
            return;
          }
          resolve({
            content: typeof choice.message.content === "string" ? choice.message.content : "",
            finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
            usage: j && typeof j.usage === "object" && j.usage ? j.usage : null,
          });
        });
      },
    );
    ctl.req = req;

    // Total-request timeout (connect + headers + body).
    timer = setTimeout(() => {
      try { req.destroy(new Error("Groq chat request timed out")); } catch (_) { /* already gone */ }
    }, Math.max(1000, timeoutMs));

    req.on("error", (err) => {
      clearTimeout(timer);
      const msg = err && err.message ? err.message : String(err);
      if (msg === CANCEL_MSG) {
        reject(makeChatError(msg, { retryable: false }));
        return;
      }
      reject(makeChatError(`Groq chat request failed: ${msg}`, { retryable: isNetworkError(err) }));
    });

    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// groqChat — the public client with retry/backoff/abort.
// ---------------------------------------------------------------------------

/**
 * Run one chat completion.
 *
 * @param {object} o
 * @param {string} o.apiKey                 Groq key ("gsk_…").
 * @param {string} [o.model]                Model id (normalized against
 *                                          GROQ_TEXT_MODELS; unknown →
 *                                          DEFAULT_TEXT_MODEL).
 * @param {Array<{role:string,content:string}>} o.messages
 * @param {number} [o.temperature=0.3]
 * @param {number} [o.maxTokens=4096]
 * @param {boolean} [o.jsonMode=false]      Adds response_format json_object
 *                                          and strips code fences from the
 *                                          returned content. The prompt MUST
 *                                          contain the word "JSON".
 * @param {number} [o.timeoutMs=120000]     Total request timeout.
 * @param {number} [o.retries=2]            Retries on 429/5xx/network only.
 * @param {{abort:Function}} [o.abortRef]   Populated with a cancel function.
 * @returns {Promise<{content:string, finishReason:string|null, usage:object|null}>}
 */
async function groqChat(o) {
  const opts = o || {};
  const apiKey = typeof opts.apiKey === "string" ? opts.apiKey.trim() : "";
  if (!apiKey) throw makeChatError("groqChat: no API key provided");
  const messages = validateMessages(opts.messages); // throws (non-retryable)
  const modelId = normalizeTextModel(opts.model);
  const temperature = Number.isFinite(Number(opts.temperature)) ? Number(opts.temperature) : 0.3;
  const maxTokens = Number.isFinite(Number(opts.maxTokens)) ? Math.max(1, Math.round(Number(opts.maxTokens))) : 4096;
  const jsonMode = !!opts.jsonMode;
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) ? Number(opts.timeoutMs) : 120000;
  const retries = Math.max(0, Math.min(5, Number.isFinite(Number(opts.retries)) ? Math.round(Number(opts.retries)) : 2));
  const abortRef = opts.abortRef && typeof opts.abortRef === "object" ? opts.abortRef : null;

  const ctl = { aborted: false, req: null, wake: null };
  const doAbort = () => {
    if (ctl.aborted) return;
    ctl.aborted = true;
    try { if (ctl.req) ctl.req.destroy(new Error(CANCEL_MSG)); } catch (_) { /* already gone */ }
    const wake = ctl.wake;
    ctl.wake = null;
    if (wake) wake(new Error(CANCEL_MSG));
  };
  if (abortRef) abortRef.abort = doAbort;

  /** Backoff sleep that a late abort can interrupt. */
  const cancellableSleep = (ms) => new Promise((res, rej) => {
    const timer = setTimeout(() => { ctl.wake = null; res(); }, ms);
    ctl.wake = (err) => { clearTimeout(timer); rej(err); };
  });

  let attempt = 0;
  let activeModelId = modelId;
  let modelSwapped = false;
  for (;;) {
    if (ctl.aborted) throw makeChatError(CANCEL_MSG);
    let result;
    try {
      result = await chatRequestOnce({
        apiKey, modelId: activeModelId, messages, temperature, maxTokens, jsonMode, timeoutMs, ctl,
      });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (ctl.aborted || msg === CANCEL_MSG) throw makeChatError(CANCEL_MSG);
      // v1.31: a 404 means the model id is gone (Groq decommissions models
      // — e.g. gemma2-9b-it / qwen3-32b in 2026) or not enabled for this
      // key. One silent retry on the DEFAULT model keeps the dub/script
      // workflow alive instead of dying on a stored stale preference.
      if (err.status === 404 && !modelSwapped && activeModelId !== DEFAULT_TEXT_MODEL) {
        modelSwapped = true;
        activeModelId = DEFAULT_TEXT_MODEL;
        continue;
      }
      if (!err.retryable || attempt >= retries) {
        if (modelSwapped) {
          err.message = `${err.message} (already retried on ${DEFAULT_TEXT_MODEL} after ${modelId} was not found)`;
        }
        throw err;
      }
      const delayMs = attempt < BACKOFF_DELAYS_MS.length
        ? BACKOFF_DELAYS_MS[attempt]
        : Math.min(16000, BACKOFF_DELAYS_MS[BACKOFF_DELAYS_MS.length - 1] * Math.pow(2, attempt - BACKOFF_DELAYS_MS.length + 1));
      try {
        await cancellableSleep(delayMs);
      } catch (sleepErr) {
        throw makeChatError(sleepErr && sleepErr.message ? sleepErr.message : CANCEL_MSG);
      }
      attempt++;
      continue;
    }
    let content = result.content;
    if (jsonMode && typeof content === "string") content = stripCodeFences(content);
    return { content, finishReason: result.finishReason, usage: result.usage, modelUsed: activeModelId };
  }
}

// ---------------------------------------------------------------------------
// Model listing — which of our curated text models does THIS key have?
// ---------------------------------------------------------------------------

/** GET /openai/v1/models filtered to GROQ_TEXT_MODELS, in UI order.
 *  Best-effort: resolves [] (with a console.warn) when the key is bad or
 *  the network fails — callers use this to grey out options, not to
 *  validate keys (groqTestKey does that). */
function groqListTextModels(apiKey) {
  return new Promise((resolve) => {
    if (typeof apiKey !== "string" || !apiKey.trim()) {
      resolve([]);
      return;
    }
    const req = createRequest(
      {
        host: GROQ_API_HOST,
        path: MODELS_PATH,
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) {
            console.warn(`[groq-chat] Could not list models (HTTP ${res.statusCode}): ${classifyChatError(res.statusCode, body, maskApiKey(apiKey))}`);
            resolve([]);
            return;
          }
          const ids = new Set();
          try {
            const j = JSON.parse(body);
            for (const m of Array.isArray(j.data) ? j.data : []) {
              if (m && typeof m.id === "string") ids.add(m.id);
            }
          } catch (_) { /* best-effort */ }
          resolve(GROQ_TEXT_MODELS.filter((m) => ids.has(m.id)).map((m) => m.id));
        });
      },
    );
    req.setTimeout(15000, () => {
      req.destroy(new Error("Connection to api.groq.com timed out"));
    });
    req.on("error", (err) => {
      console.warn(`[groq-chat] Could not list models: ${err && err.message ? err.message : err}`);
      resolve([]);
    });
    req.end();
  });
}

module.exports = {
  GROQ_TEXT_MODELS,
  DEFAULT_TEXT_MODEL,
  normalizeTextModel,
  groqChat,
  groqListTextModels,
  classifyChatError,
  parseJsonish,
  stripCodeFences,
  extractJsonBlock,
};
