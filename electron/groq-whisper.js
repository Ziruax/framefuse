// electron/groq-whisper.js — Groq Whisper API engine (cloud STT).
//
// v1.15 — the user directive: stop shipping the 300 MB faster-whisper
// Python runtime inside the installer by default; offer Groq's hosted
// whisper-large-v3 / whisper-large-v3-turbo instead, with the user's OWN
// API key stored ONLY on their device. The local engines (offline tiny
// ONNX, and faster-whisper when staged) remain as fallbacks.
//
// This module is a PLAIN Node module (zero Electron imports) so it can be
// smoke-tested directly:
//   node -e "require('./electron/groq-whisper').groqTestKey('gsk_…')"
//
// API shape (OpenAI-compatible, host api.groq.com):
//   POST /openai/v1/audio/transcriptions
//     multipart/form-data:
//       file                      — the audio (compressed by us, see below)
//       model                     — whisper-large-v3-turbo | whisper-large-v3
//       response_format           — verbose_json
//       timestamp_granularities[] — word, segment
//       language?                 — ISO-639-1 (omitted for auto-detect)
//   Headers: Authorization: Bearer <key>
//   200 → { text, language, duration, words:[{word,start,end}],
//           segments:[{start,end,text}] }
//
// Upload budget: Groq caps the request body at 25 MB. We therefore
// re-encode the source to mono 16 kHz MP3 through a bitrate LADDER
// (64→48→32→24→16 kbps) until the payload fits — 64 kbps mono covers ~55
// minutes of speech, and the ladder keeps even multi-hour files inside
// the cap at slightly lower fidelity (16 kbps mono is still comfortably
// above Whisper's effective input resolution: the model itself resamples
// everything to 16 kHz mel features).
//
// The returned `chunks` use the EXACT contract of the local engines
// (transformers.js / faster-whisper sidecar): word-level mode returns one
// chunk per word {text, timestamp:[s,e]} — parseWhisperOutput on the
// renderer handles the cue grouping from there.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { transportName } = require("./net-transport");
const { sdkClient, transportsDiffer } = require("./groq-fetch-adapter");
const { validateAudioFile } = require("./audio-format");

const GROQ_API_HOST = "api.groq.com";
const TRANSCRIBE_PATH = "/openai/v1/audio/transcriptions";
const MODELS_PATH = "/openai/v1/models";

/** 25 MB hard server cap minus a multipart slop margin. */
const GROQ_MAX_UPLOAD_BYTES = 24.5 * 1024 * 1024;

/** The two supported Groq Whisper models, in UI order. DEFAULT = turbo
 *  (the faster one, per the user directive). */
const GROQ_MODELS = [
  {
    id: "whisper-large-v3-turbo",
    label: "Large v3 Turbo",
    hint: "Fastest — recommended default",
  },
  {
    id: "whisper-large-v3",
    label: "Large v3",
    hint: "Maximum accuracy, slower",
  },
];
const DEFAULT_GROQ_MODEL = "whisper-large-v3-turbo";

function normalizeGroqModel(id) {
  return GROQ_MODELS.some((m) => m.id === id) ? id : DEFAULT_GROQ_MODEL;
}

/** The OTHER whisper model (404/deprecation auto-fallback). */
function alternateGroqModel(id) {
  return id === "whisper-large-v3" ? "whisper-large-v3-turbo" : "whisper-large-v3";
}

/** Normalize a language hint into a STRICT ISO-639-1 code the Groq API
 * accepts, or null (omit → auto-detect). Accepts "auto", "en", "en-US",
 * "EN", "english" (common full names) — anything unrecognizable is
 * dropped rather than 400-ing the whole request (v1.22 fix). */
const LANGUAGE_FULL_NAMES = {
  english: "en", spanish: "es", french: "fr", german: "de", italian: "it",
  portuguese: "pt", russian: "ru", chinese: "zh", japanese: "ja", korean: "ko",
  hindi: "hi", urdu: "ur", arabic: "ar", bengali: "bn", tamil: "ta",
  telugu: "te", marathi: "mr", punjabi: "pa", gujarati: "gu", dutch: "nl",
  turkish: "tr", indonesian: "id", vietnamese: "vi", thai: "th", ukrainian: "uk",
  persian: "fa", hebrew: "he", polish: "pl", swedish: "sv", czech: "cs",
};
function normalizeLanguageCode(input) {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw || raw === "auto" || raw === "unknown") return null;
  if (/^[a-z]{2}$/.test(raw)) return raw;
  if (/^[a-z]{2}[-_]/.test(raw)) return raw.slice(0, 2);
  if (LANGUAGE_FULL_NAMES[raw]) return LANGUAGE_FULL_NAMES[raw];
  return null;
}

// ---------------------------------------------------------------------------
// Config storage — userData/groq.json, NEVER inside project files, never
// synced anywhere. The key stays on the user's device.
// ---------------------------------------------------------------------------

function groqConfigPath(userDataDir) {
  return path.join(userDataDir, "groq.json");
}

function loadGroqConfig(userDataDir) {
  let cfg = { apiKey: "", model: DEFAULT_GROQ_MODEL };
  try {
    const raw = fs.readFileSync(groqConfigPath(userDataDir), "utf8");
    const parsed = JSON.parse(raw);
    cfg = {
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
      model: normalizeGroqModel(parsed.model),
    };
  } catch (_) { /* defaults */ }
  // v1.33 (user brief Part 2): GROQ_API_KEY from the environment is the
  // fallback when no key was saved in Settings — the SDK's own default
  // resolution order, honored by the app's config layer too.
  if (!cfg.apiKey.trim() && process.env.GROQ_API_KEY && process.env.GROQ_API_KEY.trim()) {
    cfg.apiKey = process.env.GROQ_API_KEY.trim();
    cfg.fromEnv = true;
  }
  return cfg;
}

function saveGroqConfig(userDataDir, patch) {
  const cur = loadGroqConfig(userDataDir);
  const next = {
    apiKey:
      patch && typeof patch.apiKey === "string" ? patch.apiKey : cur.apiKey,
    model:
      patch && typeof patch.model === "string"
        ? normalizeGroqModel(patch.model)
        : cur.model,
  };
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(groqConfigPath(userDataDir), JSON.stringify(next, null, 2), {
    mode: 0o600,
  });
  return next;
}

/** "gsk_AbC…9xY2" → "gsk_AbC…9xY2" (first 7 + last 4) for safe display. */
function maskApiKey(key) {
  if (!key) return "";
  if (key.length <= 12) return `${key.slice(0, 3)}…`;
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

/** Normalize a user-pasted Groq API key BEFORE it is stored or sent (v1.29):
 *  trim, strip ONE pair of wrapping quotes (the classic copy artifact), and
 *  REJECT anything that still contains internal whitespace or quote
 *  characters — those can never authenticate and only produce a confusing
 *  403 "Groq rejected the API key" later. Returns "" for empty input.
 *  Throws an actionable Error the caller surfaces to the user. */
function normalizeGroqApiKey(raw) {
  let key = String(raw == null ? "" : raw).trim();
  if (!key) return "";
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }
  if (!key) return "";
  if (/\s/.test(key)) {
    throw new Error(
      "Groq API key contains spaces or line breaks — copy the full gsk_… key from console.groq.com/keys (no quotes, no spaces)",
    );
  }
  if (/["']/.test(key)) {
    throw new Error(
      "Groq API key contains quote characters — copy the raw gsk_… key from console.groq.com/keys",
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// Audio compression for upload (ffmpeg, bitrate ladder).
// ---------------------------------------------------------------------------

/** Encode `inputPath` to mono 16 kHz MP3 at `kbps`; resolves the output
 *  file path (written into `outDir`), or rejects with ffmpeg's tail. */
function encodeCompactAudio(ffmpegPath, inputPath, outDir, kbps) {
  return new Promise((resolve, reject) => {
    const out = path.join(
      outDir,
      `groq_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.mp3`,
    );
    const proc = spawn(
      ffmpegPath,
      [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", inputPath,
        "-vn", "-ac", "1", "-ar", "16000",
        "-c:a", "libmp3lame", "-b:a", `${kbps}k`,
        out,
      ],
      { windowsHide: true },
    );
    let stderrTail = "";
    proc.stderr.on("data", (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-1200);
    });
    proc.on("error", (err) =>
      reject(new Error(`Could not run ffmpeg: ${err.message}`)),
    );
    proc.on("exit", (code) => {
      if (code === 0) {
        try {
          if (!fs.existsSync(out) || fs.statSync(out).size === 0) {
            reject(new Error("Audio extraction produced an empty file"));
            return;
          }
          resolve(out);
        } catch (err) {
          reject(new Error(err.message));
        }
      } else {
        reject(
          new Error(
            `Audio extraction failed (exit ${code})${stderrTail ? `: ${stderrTail.trim().split("\n").slice(-2).join(" ")}` : ""}`,
          ),
        );
      }
    });
  });
}

/** Ladder-compress until the file fits the Groq upload cap.
 *  @returns {{filePath:string, bytes:number, kbps:number}} */
async function extractAudioForGroq(ffmpegPath, inputPath, outDir, onStage) {
  fs.mkdirSync(outDir, { recursive: true });
  const ladder = [64, 48, 32, 24, 16];
  let lastErr = null;
  for (const kbps of ladder) {
    onStage?.(`Preparing audio for upload (${kbps} kbps)…`);
    let out;
    try {
      out = await encodeCompactAudio(ffmpegPath, inputPath, outDir, kbps);
    } catch (err) {
      lastErr = err;
      // A ladder run failing at a HIGH bitrate (broken input) will also fail
      // lower — bail out now with the original error.
      if (kbps === ladder[0]) throw err;
      continue;
    }
    const bytes = fs.statSync(out).size;
    if (bytes <= GROQ_MAX_UPLOAD_BYTES) {
      return { filePath: out, bytes, kbps };
    }
    // Too big even at this rung — drop bitrate and retry.
    try { fs.unlinkSync(out); } catch (_) { /* best effort */ }
  }
  throw new Error(
    `The audio is too large for Groq even at 16 kbps mono${lastErr ? ` (${lastErr.message})` : ""} — try a shorter source`,
  );
}

// ---------------------------------------------------------------------------
// HTTP plumbing (net-transport: Chromium network stack inside Electron —
// browser TLS fingerprint + system proxy — https.request in plain Node).
// ---------------------------------------------------------------------------

/** Classify a Groq API failure into an actionable message.
 *  v1.29: `maskedKey` ("gsk_AbC…9xY2") appended to 401/403 text so the user
 *  can SEE which stored key was rejected.
 *  v1.30: non-JSON 401/403 = network-level block.
 *  v1.31 (THE REAL ROOT-CAUSE FIX): three DISTINCT 401/403 families —
 *  (1) non-JSON body: intercepted before Groq (VPN/proxy/TLS-interception);
 *  (2) JSON WITHOUT the documented error.type envelope — the bare
 *      {"error":{"message":"Forbidden"}} (33 bytes) — is Groq's CLOUDFLARE
 *      EDGE refusing the CONNECTION, not the Groq API answering. LIVE-VERIFIED
 *      from this codebase: that exact body returns for EVERY path, method and
 *      key shape — including requests with NO Authorization header and
 *      nonexistent paths — i.e. an IP-range-level block, while the Groq API's
 *      own errors always carry {message, type} per console.groq.com/docs/
 *      errors. Edge-blocked requests never reach the API, never show in
 *      console.groq.com request logs (the user's "zero API calls" mystery),
 *      and the key was NEVER checked — regenerating it changes nothing.
 *      This is what both previous "Groq rejected the API key" mislabels
 *      actually were on the failing machines.
 *  (3) JSON WITH error.type: the genuine Groq API answered — 401 = key
 *      refused, 403 = permission restriction (suspended org / restricted
 *      model).
 */
function classifyGroqError(status, bodyText, maskedKey) {
  let apiMessage = "";
  let errType = "";
  let errCode = "";
  let bodyIsJson = false;
  try {
    const j = JSON.parse(bodyText);
    const e = j && typeof j.error === "object" && j.error ? j.error : null;
    apiMessage = (e && typeof e.message === "string" && e.message) ||
      (j && typeof j.message === "string" ? j.message : "") || "";
    errType = (e && typeof e.type === "string" && e.type) || "";
    errCode = (e && typeof e.code === "string" && e.code) || "";
    bodyIsJson = true;
  } catch (_) { /* non-JSON body */ }
  // v1.32: a response is a GENUINE Groq API answer only when the documented
  // error envelope (error.type / error.code — console.groq.com/docs/errors)
  // is present. The bare {"error":{"message":"Forbidden"}} has neither and
  // is the edge/interceptor family.
  const raw = apiMessage ? ` [${apiMessage}]` : "";
  const keyPart = maskedKey ? ` (${maskedKey})` : "";
  switch (status) {
    case 401:
    case 403: {
      // (1) non-JSON: never reached Groq.
      if (!bodyIsJson) {
        return `The request to api.groq.com was BLOCKED before reaching Groq (status ${status}, non-JSON response — VPN, proxy, firewall or TLS interception) — the key was never checked${raw}`;
      }
      // (2) bare JSON without error.type: the Cloudflare EDGE refused the
      // connection. The key was never checked; the console will (correctly)
      // show zero requests. THIS is the failure family behind "my key is
      // accurate but Groq rejects it, and no API call appears in the console".
      if (!errType) {
        return `Groq's network edge (Cloudflare) REFUSED the connection (${status} Forbidden) — the request never reached Groq's API, so the key was never checked and console.groq.com will show ZERO requests (that is expected, not a bug). Cloudflare blocks whole IP ranges when any neighbor on your ISP/VPN range trips abuse rules, and Groq cannot whitelist individual IPs. Fix, in order: (1) switch networks (try a phone hotspot), (2) toggle your VPN/proxy on or off, (3) retry after ~15 minutes. Your key itself is almost certainly fine${raw}`;
      }
      // (3) the genuine Groq API answered.
      if (status === 401) {
        return `Groq rejected the API key${keyPart} — re-save the key in Settings → Default AI models (console.groq.com → API Keys)${raw}`;
      }
      return `Groq refused access for this key${keyPart} — a permission restriction (suspended organization or a model not enabled for this key; check console.groq.com)${raw}`;
    }
    case 404: {
      // v1.32: split the two 404 families. A GENUINE Groq 404 carries the
      // documented JSON envelope WITH error.type ("The model … does not
      // exist") — model availability. A 404 WITHOUT that envelope was
      // NEVER produced by Groq's API: something between this app and
      // api.groq.com (OS proxy, VPN, antivirus web-filter, captive portal)
      // swallowed the request and answered itself. That is the exact
      // signature of "the key authenticates (GET /models works) but the
      // real transcription returns 404" on interceptor machines.
      if (bodyIsJson && (errType || errCode)) {
        return `Groq does not recognize the model for this key${keyPart}${raw}`;
      }
      return `The endpoint answered 404 — but this response did NOT come from Groq's API (no Groq error envelope). Something on this machine or network (a proxy, VPN, or antivirus "web protection" that scans HTTPS) intercepted the request and answered it — the key is fine (it just authenticated) and the model is current. Fix: disable HTTPS/TLS scanning for this app in your antivirus, turn the VPN/proxy off (or on), or use a different network${raw}`;
    }
    case 413:
      return `Groq says the audio upload is too large (25 MB cap)${raw}`;
    case 429:
      return `Groq rate limit reached — wait a moment and transcribe again${raw}`;
    default:
      if (status >= 500) {
        return `Groq server error (${status}) — usually transient, try again${raw}`;
      }
      return `Groq request failed (HTTP ${status})${raw}`;
  }
}

/** Parse Groq's JSON error envelope (message + type + code) — shared with
 *  the retry layer so it can detect edge-block vs genuine API errors. */
function parseGroqErrorBody(bodyText) {
  try {
    const j = JSON.parse(bodyText);
    const e = j && typeof j.error === "object" && j.error ? j.error : null;
    return {
      isJson: true,
      message: (e && typeof e.message === "string" && e.message) || "",
      type: (e && typeof e.type === "string" && e.type) || "",
      code: (e && typeof e.code === "string" && e.code) || "",
    };
  } catch (_) {
    return { isJson: false, message: "", type: "", code: "" };
  }
}

/** v1.32: is this body a GENUINE Groq API answer? Groq's documented error
 *  envelope always carries error.type (and often error.code). The bare
 *  {"error":{"message":"Forbidden"}} and any non-JSON body are NOT from
 *  the Groq API layer (edge block / proxy / interceptor). */
function isGenuineGroqErrorBody(bodyText) {
  const p = parseGroqErrorBody(bodyText);
  return p.isJson && !!(p.type || p.code);
}

/** v1.32 TRANSPORT FAILOVER trigger: a 401/403/404 that the Groq API did
 *  not genuinely produce. When the first attempt rode Chromium's net stack
 *  (which honors the OS proxy), the caller re-issues the request through
 *  plain Node https — direct, proxy-ignoring — before surfacing anything. */
function transportFailoverWorthy(status, bodyText) {
  return (
    (status === 404 || status === 401 || status === 403) &&
    !isGenuineGroqErrorBody(bodyText)
  );
}

// ---------------------------------------------------------------------------
// v1.33 GROQ SDK LAYER (user brief: use the official groq-sdk).
//
// groqTranscribeOnceRaw / probeOnce / groqTestKey now issue their requests
// through the SDK client (groq-fetch-adapter.js), which rides the app's
// net-transport: Chromium net inside Electron (OS-proxy-honoring) and,
// on the v1.32 failover retry, direct Node https. The SDK's structured
// errors (.status, .error parsed body, APIConnectionError) feed the SAME
// classifier as before — the verdicts are unchanged, the request engine
// is official.
// ---------------------------------------------------------------------------

/** Derive the v1.33 structured job code (AudioJobError shape) from a
 *  classified Groq failure. v1.33.1: a client-side TIMEOUT is its own
 *  retryable code — it is NOT a connectivity verdict. */
function groqJobCode(status, bodyText, genuine) {
  if (!status) return "GROQ_CONNECTION";
  if (status === 404) return genuine ? "GROQ_MODEL_NOT_FOUND" : "GROQ_INTERCEPTED_404";
  if (status === 401) return genuine ? "GROQ_KEY_REJECTED" : "GROQ_BLOCKED_BEFORE_PROVIDER";
  if (status === 403) {
    if (genuine) return "GROQ_PERMISSION";
    return bodyText ? "GROQ_EDGE_BLOCK" : "GROQ_BLOCKED_BEFORE_PROVIDER";
  }
  if (status === 413) return "GROQ_FILE_TOO_LARGE";
  if (status === 429) return "GROQ_RATE_LIMIT";
  if (status >= 500) return "GROQ_SERVER_ERROR";
  if (status === 400) return "GROQ_BAD_REQUEST";
  return "GROQ_REQUEST_FAILED";
}

/** v1.33.1: is this groq-sdk error the SDK's own request timeout
 *  (APIConnectionTimeoutError / "Request timed out.")? Distinguishing it
 *  from a genuine network failure is the difference between "your audio
 *  is too long for one request" and "your VPN is broken" — v1.33 blurred
 *  them into one misleading "could not reach api.groq.com" message. */
function isSdkTimeoutError(e) {
  if (!e) return false;
  const name = e.constructor && e.constructor.name;
  if (name === "APIConnectionTimeoutError") return true;
  if (name === "APIUserAbortError") return false;
  return /timed? ?out/i.test(String(e.message || "")) ||
    (e.cause ? /timed? ?out|ETIMEDOUT/i.test(String(e.cause.message || e.cause)) : false);
}

/** Map a groq-sdk error (APIError family / APIConnectionError) to the app's
 *  classified Error with status, apiMessage, the v1.32 transport-failover
 *  marker and the v1.33 structured job shape attached. */
function mapSdkError(e, apiKey, transportMode) {
  const status = e && typeof e.status === "number" ? e.status : 0;
  const bodyText = e && e.error ? safeJsonStringify(e.error) : "";
  let apiMessage = "";
  try {
    const j = JSON.parse(bodyText);
    apiMessage = (j && j.error && typeof j.error.message === "string" && j.error.message) ||
      (j && typeof j.message === "string" ? j.message : "") || "";
  } catch (_) { /* non-JSON body */ }
  const genuine = isGenuineGroqErrorBody(bodyText);
  // v1.33.1: a client-side timeout gets its own honest verdict. The old
  // text blamed the network ("VPN/proxy/firewall or the provider is
  // down") while the app's own request cap had killed the request —
  // with a green key test right next to it, users concluded the app was
  // broken. Now it names the cap, states the key is fine, and says what
  // to do.
  const timedOut = isSdkTimeoutError(e);
  let message;
  if (!status && timedOut) {
    message =
      "The Groq transcription request timed out (the app's 15-minute cap) — " +
      "the key and network are fine (the test probe passes); this audio is " +
      "too long or the upload too slow for one request. Retry, use a shorter " +
      "audio file, or check the connection speed";
  } else if (!status) {
    message = `Could not reach api.groq.com: ${e && e.message ? e.message : e}` +
      " — a network-level failure (VPN/proxy/firewall or the provider is down)";
  } else {
    message = classifyGroqError(status, bodyText, maskApiKey(apiKey));
  }
  const err = new Error(message);
  err.status = status;
  err.apiMessage = apiMessage;
  err.cause = e;
  err.timedOut = timedOut;
  // v1.32 TRANSPORT FAILOVER at the SDK layer: an interceptor-shaped
  // response (401/403/404 with NO genuine Groq envelope) on the
  // OS-proxy-honoring transport retries once through direct Node https.
  if (
    transportMode !== "node" &&
    transportsDiffer() &&
    status &&
    transportFailoverWorthy(status, bodyText)
  ) {
    err._transportFailover = true;
  }
  err.job = {
    service: "groq",
    code: !status && timedOut ? "GROQ_TIMEOUT" : groqJobCode(status, bodyText, genuine),
    message,
    retryable: timedOut || status === 429 || status >= 500 || !status,
  };
  return err;
}

/** JSON.stringify that never throws (SDK bodies may contain cycles). */
function safeJsonStringify(v) {
  try {
    return JSON.stringify(v);
  } catch (_) {
    return "";
  }
}

/** Run one multipart transcription request.
 *
 * @param {object} o
 * @param {string} o.apiKey
 * @param {string} o.model
 * @param {string} o.filePath     MP3 prepared by extractAudioForGroq
 * @param {string} [o.language]   ISO-639-1 or "auto"/"" (omit when auto)
 * @param {(p:{progress:number,status:string})=>void} [o.onProgress]
 *        Upload phase 25→60; the inference phase is indeterminate from the
 *        client side and holds at 65.
 * @param {{abort:()=>void}} [o.abortRef]  Populated with a cancel function.
 * @returns {Promise<{chunks:Array,language:string,wordLevel:boolean,durationMs:number,text:string}>}
 */
function groqTranscribe(o) {
  const requestedModel = normalizeGroqModel(o.model);
  const language = normalizeLanguageCode(o.language);

  const isCancelErr = (err) =>
    err && /cancel/i.test(String(err.message || err));

  /** 400 that names timestamp granularities / word-level output — the
   *  known turbo-model limitation; retry once WITHOUT the granularities. */
  const isTimestamp400 = (err) =>
    err && err.status === 400 &&
    /timestamp|granularit|word[-_ ]level/i.test(String(err.apiMessage || err.message || ""));

  /** v1.22→v1.32: a 404 retries with the other whisper model. v1.22 gated
   *  this on the message naming "model"/"decommission" — but a genuine
   *  Groq 404 body does not always match that regex (and an intercepted 404
   *  has no body at all), so the retry silently never fired. ANY 404 now
   *  gets exactly one alternate-model attempt (bounded, silent, logged
   *  through the status message). */
  const isModel404 = (err) => err && err.status === 404;

  // v1.22 RESILIENCE (the "error while transcribing" fixes):
  //   A) the turbo model has rejected word-level timestamps for some
  //      accounts/periods — a 400 naming timestamps retries once with plain
  //      verbose_json (segment-level cues still parse + even-distribute).
  //   B) a 404/decommissioned model id retries once with the OTHER whisper
  //      model (turbo ↔ v3) — silent, logged through the status message.
  //   Everything else propagates VERBATIM (the classified, actionable text).
  return (async () => {
    // v1.33 PRE-UPLOAD VALIDATION (user brief "Part 3"): the file must
    // exist, be non-empty, sniff as REAL audio (magic bytes — never the
    // extension) and fit the upload cap, BEFORE any network work. The cap
    // is configurable (o.maxBytes) with the 24.5 MB server default.
    const vv = validateAudioFile(o.filePath, {
      maxBytes:
        typeof o.maxBytes === "number" && o.maxBytes > 0
          ? Math.floor(o.maxBytes)
          : GROQ_MAX_UPLOAD_BYTES,
    });
    if (!vv.ok) {
      const err = new Error(vv.message);
      err.status = 400;
      err.job = { service: "groq", code: vv.code, message: vv.message, retryable: false };
      throw err;
    }
    if (!o.apiKey || !String(o.apiKey).trim()) {
      const msg = "No Groq API key is configured — save one in Settings → Default AI models (console.groq.com → API Keys)";
      const err = new Error(msg);
      err.status = 401;
      err.job = { service: "groq", code: "GROQ_KEY_MISSING", message: msg, retryable: false };
      throw err;
    }
    try {
      return await groqTranscribeOnce(o, requestedModel, true, language);
    } catch (err) {
      if (isCancelErr(err)) throw err;
      if (isTimestamp400(err)) {
        o.onProgress?.({
          progress: 65,
          status: "Word timestamps unavailable on this model — retrying with segment timing…",
        });
        try {
          return await groqTranscribeOnce(o, requestedModel, false, language);
        } catch (err2) {
          if (isCancelErr(err2)) throw err2;
          if (isModel404(err2)) {
            return await groqTranscribeOnce(
              o, alternateGroqModel(requestedModel), false, language,
            );
          }
          throw err2;
        }
      }
      if (isModel404(err)) {
        const alt = alternateGroqModel(requestedModel);
        o.onProgress?.({
          progress: 65,
          status: `${requestedModel} is unavailable on this key — retrying with ${alt}…`,
        });
        try {
          return await groqTranscribeOnce(o, alt, true, language);
        } catch (err2) {
          if (isCancelErr(err2)) throw err2;
          if (isTimestamp400(err2)) {
            return await groqTranscribeOnce(o, alt, false, language);
          }
          throw err2;
        }
      }
      throw err;
    }
  })();
}

/** One transcription request through the OFFICIAL groq-sdk (no retries —
 *  groqTranscribe owns those). v1.33: the SDK client rides the app's
 *  net-transport via groq-fetch-adapter (Chromium net inside Electron —
 *  honors the OS proxy; "node" mode = direct Node https, the v1.32
 *  proxy-bypassing failover path). Upload progress + cancellation + the
 *  classified/structured error mapping all survive the SDK layer.
 *  @param {"auto"|"node"} transportMode */
async function groqTranscribeOnceRaw(o, modelId, wantWordTimestamps, language, transportMode) {
  const { apiKey, filePath } = o;
  const onProgress = typeof o.onProgress === "function" ? o.onProgress : null;

  // Cancellation: the SDK forwards {signal} into our fetch adapter, which
  // destroys the request. (o.abortRef.abort is still callable immediately.)
  const abortCtl = new AbortController();
  if (o.abortRef && typeof o.abortRef === "object") {
    o.abortRef.abort = () => {
      try { abortCtl.abort(new Error("Transcription cancelled")); } catch (_) { /* gone */ }
    };
  }

  const fileBytes = fs.statSync(filePath).size;
  // v1.33.1 THE TRANSCRIPTION-TIMEOUT FIX: this client is TRANSIENT (never
  // cached — the upload-progress sink closes over THIS run) and carries a
  // 15-minute request cap. The v1.33 cache handed back groqTestKey's
  // 15-second probe client here, so every real transcription after a
  // successful key test aborted mid-request (APIConnectionTimeoutError has
  // NO status → "Could not reach api.groq.com") while the key test stayed
  // green. 900 s covers the ladder-compressed whole-file upload (hours of
  // 16 kbps mono audio ≈ tens of MB) plus whisper-large-v3-turbo's
  // processing time on top; the run stays user-cancellable the whole way.
  const GROQ_TRANSCRIBE_TIMEOUT_MS = 900000;
  const { client } = sdkClient(apiKey, transportMode, {
    timeoutMs: GROQ_TRANSCRIBE_TIMEOUT_MS,
    transient: true,
    onUploadProgress: ({ uploaded, total }) => {
      if (!onProgress) return;
      const t = Math.max(total || fileBytes, 1);
      const pct = Math.min(60, 25 + Math.round((uploaded / t) * 35));
      onProgress({
        progress: pct,
        status: `Uploading audio to Groq (${(uploaded / 1048576).toFixed(1)} / ${(t / 1048576).toFixed(1)} MB)…`,
      });
    },
  });

  try {
    const startedAt = Date.now();
    const response = await client.audio.transcriptions.create(
      {
        file: fs.createReadStream(filePath),
        model: modelId,
        // verbose_json: the only format that carries language/duration +
        // the word/segment timestamps the app's caption engine consumes.
        response_format: "verbose_json",
        ...(wantWordTimestamps ? { timestamp_granularities: ["word", "segment"] } : {}),
        ...(language ? { language } : {}),
        temperature: 0,
      },
      // v1.33.1: the per-request timeout is explicit so the 15-minute cap
      // survives even if a future refactor swaps in a cached client.
      { timeout: GROQ_TRANSCRIBE_TIMEOUT_MS, signal: abortCtl.signal },
    );
    onProgress?.({ progress: 65, status: `Groq ${modelId} is transcribing…` });

    if (!response || typeof response.text !== "string") {
      const err = new Error("Groq returned a transcription response without text — the API answer was not the documented shape");
      err.status = 200;
      err.job = { service: "groq", code: "GROQ_RESPONSE_INVALID", message: err.message, retryable: false };
      throw err;
    }
    const words = Array.isArray(response.words) ? response.words : null;
    const segments = Array.isArray(response.segments) ? response.segments : [];
    let outChunks = [];
    let wordLevel = false;
    if (words && words.length > 0) {
      wordLevel = true;
      outChunks = words.map((w) => ({
        text: String((w && w.word) || "").trim(),
        timestamp: [
          w && typeof w.start === "number" ? w.start : null,
          w && typeof w.end === "number" ? w.end : null,
        ],
      }));
    } else if (segments.length > 0) {
      wordLevel = false;
      outChunks = segments.map((s) => ({
        text: String((s && s.text) || "").trim(),
        timestamp: [
          s && typeof s.start === "number" ? s.start : null,
          s && typeof s.end === "number" ? s.end : null,
        ],
      }));
    }
    // Drop empty texts (trailing punctuation-only tokens).
    outChunks = outChunks.filter((c) => c.text && c.text.length > 0);
    return {
      chunks: outChunks,
      language:
        response.language && typeof response.language === "string" ? response.language : null,
      wordLevel,
      durationMs:
        typeof response.duration === "number" ? Math.round(response.duration * 1000)
          : Date.now() - startedAt,
      text: typeof response.text === "string" ? response.text : "",
    };
  } catch (e) {
    if (abortCtl.signal.aborted) {
      const err = new Error("Transcription cancelled");
      err.cancelled = true;
      throw err;
    }
    throw mapSdkError(e, apiKey, transportMode);
  }
}

/** One multipart transcription request WITH the v1.32 transport failover:
 *  when the Chromium-net attempt (which honors the OS proxy) yields an
 *  interceptor-shaped response — 401/403/404 with NO genuine Groq error
 *  envelope — the IDENTICAL request is re-issued through plain Node https,
 *  which ignores the OS proxy and connects directly. On proxy/AV/VPN
 *  machines where the GET /models passes (the key "authenticates") but the
 *  POST upload is answered by the interceptor (the "transcription returns
 *  404" signature), the direct retry is the request Groq actually
 *  receives. */
function groqTranscribeOnce(o, modelId, wantWordTimestamps, language) {
  return groqTranscribeOnceRaw(o, modelId, wantWordTimestamps, language, "auto").catch(
    (err) => {
      if (!err || !err._transportFailover) throw err;
      const onProgress = typeof o.onProgress === "function" ? o.onProgress : null;
      if (onProgress) {
        onProgress({
          progress: 60,
          status:
            "Response looked intercepted — retrying the upload through a direct connection (bypassing the system proxy)…",
        });
      }
      return groqTranscribeOnceRaw(o, modelId, wantWordTimestamps, language, "node");
    },
  );
}

// ---------------------------------------------------------------------------
// v1.30 END-TO-END KEY PROBE — a REAL transcription request.
//
// GET /models proves the key AUTHENTICATES, but the user-facing complaint is
// "transcription is not working". The probe POSTs a tiny embedded 1-second
// silent MP3 to /openai/v1/audio/transcriptions with the user's selected
// whisper model — the exact same endpoint, auth header and multipart field
// contract the real transcription uses (per console.groq.com/docs/speech-to-text:
// POST multipart file + model; Bearer key). Three distinct outcomes:
//   • 401/403 JSON  → Groq refused the key (this NEVER appears in the
//     console's request logs — an empty log can't rule it out)
//   • 401/403 non-JSON → blocked before Groq (VPN/proxy/Cloudflare)
//   • 200 → the key authenticates AND transcription works, end to end.
// The probe is 2.3 KB of 16 kbps silence — Groq's minimum billed length is
// 10s, so one Test click bills 10s of whisper time (~$0.0001 on turbo).
// ---------------------------------------------------------------------------

/** 1s of 16 kbps mono silence (2,384 B) — the probe audio. */
const PROBE_MP3_B64 =
  "SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYxLjcuMTAzAAAAAAAAAAAAAAD/81jAAAAAAAAAAAAASW5mbwAAAA8AAAAeAAAJJAAbGxsjIyMrKyszMzMzOzs7QkJCSkpKSlJSUlpaWmJiYmJqampycnJ6enp6gYGBiYmJkZGRkZmZmaGhoampqamxsbG5ubnAwMDAyMjI0NDQ2NjY2ODg4Ojo6PDw8PD4+Pj///8AAAAATGF2YzYxLjE5AAAAAAAAAAAAAAAAJALAAAAAAAAACSSDldJ3AAAAAAAAAAAAAAD/8yjEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjEOwAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjEdgAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjEsQAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/8yjExAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=";

/** POST the embedded silence to /audio/transcriptions through the OFFICIAL
 *  groq-sdk (one raw attempt). v1.32 resolves { ok, message, status, genuine,
 *  failover } so the orchestrator can retry through the other transport /
 *  other model. */
async function probeOnce(apiKey, modelId, transportMode) {
  try {
    const { client } = sdkClient(apiKey, transportMode, { timeoutMs: 20000 });
    const probeBytes = Buffer.from(PROBE_MP3_B64, "base64");
    await client.audio.transcriptions.create({
      file: new File([probeBytes], "probe.mp3", { type: "audio/mpeg" }),
      model: modelId,
      response_format: "json",
    });
    return { ok: true, message: "" };
  } catch (e) {
    const status = e && typeof e.status === "number" ? e.status : 0;
    const bodyText = e && e.error ? safeJsonStringify(e.error) : "";
    return {
      ok: false,
      message: status
        ? classifyGroqError(status, bodyText, maskApiKey(apiKey))
        : `Could not reach api.groq.com: ${e && e.message ? e.message : e}`,
      status,
      genuine: isGenuineGroqErrorBody(bodyText),
      failover:
        transportMode !== "node" &&
        transportsDiffer() &&
        status &&
        transportFailoverWorthy(status, bodyText),
    };
  }
}

/** Validate the REAL transcription path end to end (v1.30 + v1.32):
 *  1. one probe POST through the default transport (Chromium net inside
 *     Electron — honors the OS proxy);
 *  2. an interceptor-shaped failure (401/403/404 without a genuine Groq
 *     error envelope) retries the identical POST through direct Node
 *     https, which ignores the OS proxy;
 *  3. a GENUINE model-availability 404 retries once with the OTHER whisper
 *     model (Groq decommissions models; the stored selection may age out).
 *  Resolves { ok:boolean, message:string } — ok ONLY on a real 200. */
function groqTranscribeProbe(apiKey, modelId) {
  const model = normalizeGroqModel(modelId);
  return probeOnce(apiKey, model, "auto").then((r) => {
    if (r.ok) return r;
    if (r.failover) {
      // The Chromium-net path (OS-proxy-honoring) got an answer Groq never
      // sent — re-issue the probe directly.
      return probeOnce(apiKey, model, "node").then((r2) => {
        if (r2.ok) return r2;
        if (r2.status === 404 && r2.genuine) {
          return probeOnce(apiKey, alternateGroqModel(model), "node");
        }
        return r2;
      });
    }
    if (r.status === 404 && r.genuine) {
      // Genuine Groq 404: the model is not available for this key — one
      // silent attempt with the other whisper model.
      return probeOnce(apiKey, alternateGroqModel(model), "auto");
    }
    return r;
  });
}

/** Validate a key END TO END (v1.30 + v1.33 SDK):
 *  1. GET /openai/v1/models (client.models.list) — does the key authenticate?
 *  2. POST the 1s probe to /openai/v1/audio/transcriptions with the
 *     selected whisper model — does TRANSCRIPTION actually work?
 *  Resolves { ok:boolean, message:string, whisperModels:string[] }. */
async function groqTestKey(apiKey, opts) {
  const model = normalizeGroqModel(opts && opts.model);
  const whisperModels = [];
  try {
    const { client } = sdkClient(apiKey, "auto", { timeoutMs: 15000 });
    const page = await client.models.list();
    const models = page && typeof page[Symbol.iterator] === "function"
      ? [...page]
      : Array.isArray(page && page.data) ? page.data : [];
    for (const m of models) {
      const id = m && typeof m.id === "string" ? m.id : "";
      if (id.startsWith("whisper")) whisperModels.push(id);
    }
  } catch (e) {
    const mapped = mapSdkError(e, apiKey, "auto");
    return { ok: false, message: mapped.message, whisperModels };
  }
  // v1.30: /models passing is no longer enough — run the REAL
  // transcription probe so "key works" means "transcription works".
  const probe = await groqTranscribeProbe(apiKey, model);
  if (probe.ok) {
    return {
      ok: true,
      message: `Key works — real transcription verified end to end (${model}; the key, the model and the upload all passed)`,
      whisperModels,
    };
  }
  // Auth OK but transcription failed — a DIFFERENT problem, and the
  // message must say so (not "rejected key").
  return {
    ok: false,
    message: `The key authenticates, but a real transcription test failed: ${probe.message}`,
    whisperModels,
  };
}

module.exports = {
  GROQ_API_HOST,
  GROQ_MAX_UPLOAD_BYTES,
  GROQ_MODELS,
  DEFAULT_GROQ_MODEL,
  normalizeGroqModel,
  alternateGroqModel,
  normalizeLanguageCode,
  groqConfigPath,
  loadGroqConfig,
  saveGroqConfig,
  maskApiKey,
  normalizeGroqApiKey,
  encodeCompactAudio,
  extractAudioForGroq,
  classifyGroqError,
  parseGroqErrorBody,
  isGenuineGroqErrorBody,
  transportFailoverWorthy,
  transportName,
  groqTranscribe,
  groqTestKey,
  groqTranscribeProbe,
  groqJobCode,
  mapSdkError,
  isSdkTimeoutError,
  validateAudioFile,
  safeJsonStringify,
};
