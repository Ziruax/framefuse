// electron/gemini-chat.js — Google Gemini generateContent client (cloud LLM).
//
// v1.20 (AI script writing) — the Script Writer generates narration scripts
// with a cloud text model. Gemini 3.5 Flash Lite is the DEFAULT (fast +
// generous free tier); the wider Gemini family and the Groq chat models stay
// selectable in the UI. This module is the HTTP client for
// POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent,
// deliberately in the same style as groq-chat.js / groq-whisper.js: raw
// https requests, ZERO dependencies, actionable error classification, an
// abort hook, and polite retries on 429 / 5xx / network errors ONLY (never
// on 400/401/403/404 — those are the caller's problem, not the network's).
//
// This module is a PLAIN Node module (no Electron imports) so it can be
// smoke-tested directly:
//   node -e "require('./electron/gemini-chat')"
//
// Key storage mirrors groq-whisper.js EXACTLY: userData/gemini.json, mode
// 0600, NEVER inside project files, never synced anywhere. The renderer only
// ever sees a MASKED payload (geminiConfigPayload → hasKey + maskedKey).
//
// Script-writing text models (GEMINI_TEXT_MODELS), UI order:
//   gemini-3.5-flash-lite   (DEFAULT — fastest + generous free tier)
//   gemini-3.5-flash        (balanced)
//   gemini-3.1-flash-lite   (lightweight previous generation)
//   gemini-2.5-flash        (fast multimodal workhorse)
//   gemini-2.5-pro          (highest quality, tighter limits)
//
// Abort contract (same shape as groq-chat's groqChat):
//   const abortRef = { abort: null };
//   geminiChat({ ..., abortRef })   // abortRef.abort is populated
//   abortRef.abort()                // destroys the in-flight request AND any
//                                   // pending retry backoff, rejecting with
//                                   // "Gemini request cancelled"
// An AbortSignal may ALSO be passed as `signal` — it feeds the same cancel
// path (useful from APIs that only hand you a signal).

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

const GEMINI_API_HOST = "generativelanguage.googleapis.com";
const GENERATE_PATH_ROOT = "/v1beta/models/";
const MODELS_PATH = "/v1beta/models";

/** Sanity cap on the response body (generateContent replies are KBs). */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Retry backoff for retryable failures: 1.5s, then 4s. */
const BACKOFF_DELAYS_MS = [1500, 4000];

const CANCEL_MSG = "Gemini request cancelled";

/** The script-writing chat models, in UI order. */
const GEMINI_TEXT_MODELS = [
  {
    id: "gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash Lite",
    hint: "Default — fastest, generous free tier",
  },
  {
    id: "gemini-3.5-flash",
    label: "Gemini 3.5 Flash",
    hint: "Balanced speed and quality",
  },
  {
    id: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash Lite",
    hint: "Lightweight previous generation",
  },
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    hint: "Fast multimodal workhorse",
  },
  {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    hint: "Highest quality, slower + tighter limits",
  },
];
const GEMINI_DEFAULT_TEXT_MODEL = "gemini-3.5-flash-lite";

function normalizeTextModel(id) {
  return GEMINI_TEXT_MODELS.some((m) => m.id === id) ? id : GEMINI_DEFAULT_TEXT_MODEL;
}

// ---------------------------------------------------------------------------
// Config storage — userData/gemini.json, mode 0600, NEVER inside project
// files, never synced anywhere. The key stays on the user's device.
// (Mirrors groq-whisper.js's loadGroqConfig/saveGroqConfig exactly.)
// ---------------------------------------------------------------------------

function geminiConfigPath(userDataDir) {
  return path.join(userDataDir, "gemini.json");
}

function loadGeminiConfig(userDataDir) {
  try {
    const raw = fs.readFileSync(geminiConfigPath(userDataDir), "utf8");
    const cfg = JSON.parse(raw);
    return { apiKey: typeof cfg.apiKey === "string" ? cfg.apiKey : "" };
  } catch (_) {
    return { apiKey: "" };
  }
}

function saveGeminiConfig(userDataDir, patch) {
  const cur = loadGeminiConfig(userDataDir);
  const next = {
    apiKey:
      patch && typeof patch.apiKey === "string" ? patch.apiKey : cur.apiKey,
  };
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(geminiConfigPath(userDataDir), JSON.stringify(next, null, 2), {
    mode: 0o600,
  });
  return next;
}

/** Remove gemini.json entirely → true when a file was deleted. */
function removeGeminiConfig(userDataDir) {
  try {
    fs.unlinkSync(geminiConfigPath(userDataDir));
    return true;
  } catch (_) {
    return false;
  }
}

/** "AIzaSyB…9xY2" → "AIzaSyB…9xY2" (first 7 + last 4) for safe display. */
function maskGeminiKey(key) {
  if (!key) return "";
  if (key.length <= 12) return `${key.slice(0, 3)}…`;
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

/** Masked payload for the renderer — the raw key NEVER crosses the bridge. */
function geminiConfigPayload(userDataDir) {
  const cfg = loadGeminiConfig(userDataDir);
  return { hasKey: !!cfg.apiKey, maskedKey: maskGeminiKey(cfg.apiKey) };
}

// ---------------------------------------------------------------------------
// Error classification (same approach as groq-chat's classifyChatError,
// with generateContent wording).
// ---------------------------------------------------------------------------

/** Classify a Gemini API failure into an actionable message. */
function classifyGeminiError(status, bodyText) {
  let apiMessage = "";
  try {
    const j = JSON.parse(bodyText);
    apiMessage = j?.error?.message || j?.message || "";
  } catch (_) { /* non-JSON body */ }
  const raw = apiMessage ? ` [${apiMessage}]` : "";
  switch (status) {
    case 400:
      return `Gemini rejected the request (invalid request — check the prompt and parameters)${raw}`;
    case 401:
    case 403:
      return `Gemini API key invalid or missing access — get a key at aistudio.google.com/apikey and check it's enabled${raw}`;
    case 404:
      return `Gemini model not found — pick another model in the dropdown${raw}`;
    case 429:
      return `Gemini rate limit reached — wait a moment and try again${raw}`;
    default:
      if (status >= 500) {
        return `Gemini server error (${status}) — usually transient, try again${raw}`;
      }
      return `Gemini request failed (HTTP ${status})${raw}`;
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
// One generateContent request (no retries — the wrapper handles those).
// ---------------------------------------------------------------------------

function geminiRequestOnce(o) {
  const { apiKey, modelId, systemPrompt, userPrompt, temperature, maxOutputTokens, timeoutMs, ctl } = o;
  return new Promise((resolve, reject) => {
    const payload = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: { temperature, maxOutputTokens },
    };
    const body = Buffer.from(JSON.stringify(payload), "utf8");

    let timer = null;
    const req = https.request(
      {
        host: GEMINI_API_HOST,
        path: `${GENERATE_PATH_ROOT}${encodeURIComponent(modelId)}:generateContent`,
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json",
          "Content-Length": body.length,
        },
      },
      (res) => {
        const chunks = [];
        let bytes = 0;
        res.on("data", (d) => {
          chunks.push(d);
          bytes += d.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            req.destroy(new Error("Gemini response exceeded 10 MB"));
          }
        });
        res.on("end", () => {
          clearTimeout(timer);
          const bodyText = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) {
            reject(makeChatError(classifyGeminiError(res.statusCode, bodyText), {
              status: res.statusCode,
              retryable: res.statusCode === 429 || res.statusCode >= 500,
            }));
            return;
          }
          let j;
          try {
            j = JSON.parse(bodyText);
          } catch (err) {
            // A 200 with an unparseable body is almost always a transient
            // gateway hiccup — retryable.
            reject(makeChatError(`Could not parse the Gemini response: ${err.message}`, { retryable: true }));
            return;
          }
          const cand = j && Array.isArray(j.candidates) ? j.candidates[0] : null;
          const parts =
            cand && cand.content && Array.isArray(cand.content.parts)
              ? cand.content.parts
              : [];
          const text = parts
            .map((p) => (p && typeof p.text === "string" ? p.text : ""))
            .join("")
            .trim();
          const finishReason =
            cand && typeof cand.finishReason === "string" ? cand.finishReason : null;
          // Safety blocks: candidate-level SAFETY/RECITATION or a
          // promptFeedback blockReason — the content is withheld by policy.
          const blockReason =
            j && j.promptFeedback && typeof j.promptFeedback.blockReason === "string"
              ? j.promptFeedback.blockReason
              : null;
          if (finishReason === "SAFETY" || finishReason === "RECITATION" || blockReason) {
            reject(makeChatError(
              `Gemini blocked this response (${finishReason || blockReason}) — rephrase the prompt and try again`,
              { retryable: false },
            ));
            return;
          }
          if (!text) {
            // Empty content: STOP/no-reason is usually a transient hiccup
            // (retry); a named reason (e.g. MAX_TOKENS spent on internal
            // thinking) will not fix itself on retry.
            if (!finishReason || finishReason === "STOP") {
              reject(makeChatError(
                "Gemini returned an empty script — usually transient, try again",
                { retryable: true },
              ));
            } else {
              reject(makeChatError(
                `Gemini returned an empty script (finishReason ${finishReason}) — try again or pick another model`,
                { retryable: false },
              ));
            }
            return;
          }
          resolve({
            text,
            finishReason,
            usage:
              j && typeof j.usageMetadata === "object" && j.usageMetadata
                ? j.usageMetadata
                : null,
          });
        });
      },
    );
    ctl.req = req;

    // Total-request timeout (connect + headers + body).
    timer = setTimeout(() => {
      try { req.destroy(new Error("Gemini request timed out")); } catch (_) { /* already gone */ }
    }, Math.max(1000, timeoutMs));

    req.on("error", (err) => {
      clearTimeout(timer);
      const msg = err && err.message ? err.message : String(err);
      if (msg === CANCEL_MSG) {
        reject(makeChatError(msg, { retryable: false }));
        return;
      }
      reject(makeChatError(`Gemini request failed: ${msg}`, { retryable: isNetworkError(err) }));
    });

    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// geminiChat — the public client with retry/backoff/abort.
// ---------------------------------------------------------------------------

/**
 * Run one generateContent request and return the joined candidate text.
 *
 * @param {object} o
 * @param {string} o.apiKey                  Gemini key ("AIza…").
 * @param {string} [o.model]                 Model id (normalized against
 *                                           GEMINI_TEXT_MODELS; unknown →
 *                                           GEMINI_DEFAULT_TEXT_MODEL).
 * @param {string} o.systemPrompt            The system instruction text.
 * @param {string} o.userPrompt              The user prompt text.
 * @param {number} [o.temperature=0.8]
 * @param {number} [o.maxOutputTokens=4096]  Generous default: Gemini 2.5+
 *                                           models spend part of this budget
 *                                           on internal thinking.
 * @param {number} [o.timeoutMs=120000]      Total request timeout.
 * @param {number} [o.retries=2]             Retries on 429/5xx/network only.
 * @param {{abort:Function}} [o.abortRef]    Populated with a cancel function.
 * @param {AbortSignal} [o.signal]           Optional AbortSignal — aborts
 *                                           the same way abortRef.abort does.
 * @returns {Promise<{text:string, finishReason:string|null, usage:object|null}>}
 */
async function geminiChat(o) {
  const opts = o || {};
  const apiKey = typeof opts.apiKey === "string" ? opts.apiKey.trim() : "";
  if (!apiKey) throw makeChatError("geminiChat: no API key provided");
  const systemPrompt = typeof opts.systemPrompt === "string" ? opts.systemPrompt : "";
  const userPrompt = typeof opts.userPrompt === "string" ? opts.userPrompt : "";
  if (!systemPrompt || !userPrompt) {
    throw makeChatError("geminiChat: systemPrompt and userPrompt are required");
  }
  const modelId = normalizeTextModel(opts.model);
  const temperature = Number.isFinite(Number(opts.temperature)) ? Number(opts.temperature) : 0.8;
  const maxOutputTokens = Number.isFinite(Number(opts.maxOutputTokens)) ? Math.max(1, Math.round(Number(opts.maxOutputTokens))) : 4096;
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) ? Number(opts.timeoutMs) : 120000;
  const retries = Math.max(0, Math.min(5, Number.isFinite(Number(opts.retries)) ? Math.round(Number(opts.retries)) : 2));
  const abortRef = opts.abortRef && typeof opts.abortRef === "object" ? opts.abortRef : null;
  const signal =
    opts.signal && typeof opts.signal.addEventListener === "function" ? opts.signal : null;

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
  if (signal) {
    if (signal.aborted) throw makeChatError(CANCEL_MSG);
    signal.addEventListener("abort", doAbort);
  }
  const unhookSignal = () => {
    if (signal) {
      try { signal.removeEventListener("abort", doAbort); } catch (_) { /* best effort */ }
    }
  };

  /** Backoff sleep that a late abort can interrupt. */
  const cancellableSleep = (ms) => new Promise((res, rej) => {
    const timer = setTimeout(() => { ctl.wake = null; res(); }, ms);
    ctl.wake = (err) => { clearTimeout(timer); rej(err); };
  });

  let attempt = 0;
  try {
    for (;;) {
      if (ctl.aborted) throw makeChatError(CANCEL_MSG);
      let result;
      try {
        result = await geminiRequestOnce({
          apiKey, modelId, systemPrompt, userPrompt, temperature, maxOutputTokens, timeoutMs, ctl,
        });
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        if (ctl.aborted || msg === CANCEL_MSG) throw makeChatError(CANCEL_MSG);
        if (!err.retryable || attempt >= retries) throw err;
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
      return { text: result.text, finishReason: result.finishReason, usage: result.usage };
    }
  } finally {
    unhookSignal();
  }
}

// ---------------------------------------------------------------------------
// Key validation — GET /v1beta/models with the key header.
// ---------------------------------------------------------------------------

/** Validate a Gemini key. Accepts `{ apiKey }` (the task contract) or a bare
 *  string (groqTestKey style). Resolves
 *  { ok:boolean, message:string, modelCount:number } — modelCount is the
 *  number of models visible to this key (informational, reported when ok). */
function geminiTestKey(input) {
  return new Promise((resolve) => {
    const apiKey =
      typeof input === "string"
        ? input.trim()
        : input && typeof input.apiKey === "string"
          ? input.apiKey.trim()
          : "";
    if (!apiKey) {
      resolve({
        ok: false,
        message: "No API key yet — paste a key from aistudio.google.com/apikey first",
        modelCount: 0,
      });
      return;
    }
    const req = https.request(
      {
        host: GEMINI_API_HOST,
        path: MODELS_PATH,
        method: "GET",
        headers: { "x-goog-api-key": apiKey },
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) {
            resolve({ ok: false, message: classifyGeminiError(res.statusCode, body), modelCount: 0 });
            return;
          }
          let modelCount = 0;
          try {
            const j = JSON.parse(body);
            modelCount = Array.isArray(j.models) ? j.models.length : 0;
          } catch (_) { /* non-fatal */ }
          resolve({
            ok: true,
            message: `Key works — ${modelCount} models visible to this key`,
            modelCount,
          });
        });
      },
    );
    req.setTimeout(15000, () => {
      req.destroy(new Error("Connection to generativelanguage.googleapis.com timed out"));
    });
    req.on("error", (err) =>
      resolve({
        ok: false,
        message: err && err.message ? err.message : String(err),
        modelCount: 0,
      }),
    );
    req.end();
  });
}

module.exports = {
  GEMINI_API_HOST,
  GEMINI_TEXT_MODELS,
  GEMINI_DEFAULT_TEXT_MODEL,
  normalizeTextModel,
  geminiConfigPath,
  loadGeminiConfig,
  saveGeminiConfig,
  removeGeminiConfig,
  maskGeminiKey,
  geminiConfigPayload,
  classifyGeminiError,
  geminiChat,
  geminiTestKey,
};
