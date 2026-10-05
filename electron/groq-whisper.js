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
const { createRequest, transportName } = require("./net-transport");

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
  try {
    const raw = fs.readFileSync(groqConfigPath(userDataDir), "utf8");
    const cfg = JSON.parse(raw);
    return {
      apiKey: typeof cfg.apiKey === "string" ? cfg.apiKey : "",
      model: normalizeGroqModel(cfg.model),
    };
  } catch (_) {
    return { apiKey: "", model: DEFAULT_GROQ_MODEL };
  }
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
    case 404:
      return `Groq model not found — whisper-large-v3 access may not be enabled for this key${raw}`;
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

  /** 404 model-not-found / decommisioned-model — swap to the other whisper. */
  const isModel404 = (err) =>
    err && err.status === 404 &&
    /model|decommission/i.test(String(err.apiMessage || err.message || ""));

  // v1.22 RESILIENCE (the "error while transcribing" fixes):
  //   A) the turbo model has rejected word-level timestamps for some
  //      accounts/periods — a 400 naming timestamps retries once with plain
  //      verbose_json (segment-level cues still parse + even-distribute).
  //   B) a 404/decommissioned model id retries once with the OTHER whisper
  //      model (turbo ↔ v3) — silent, logged through the status message.
  //   Everything else propagates VERBATIM (the classified, actionable text).
  return (async () => {
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

/** One raw multipart request (no retries — groqTranscribe owns those). */
function groqTranscribeOnce(o, modelId, wantWordTimestamps, language) {
  return new Promise((resolve, reject) => {
    const { apiKey, filePath } = o;
    const onProgress = typeof o.onProgress === "function" ? o.onProgress : null;
    const fileName = path.basename(filePath) || "audio.mp3";
    const fileBytes = fs.statSync(filePath).size;

    const boundary = `----FrameFuseGroq${crypto.randomBytes(16).toString("hex")}`;
    const crlf = "\r\n";

    const textParts = [];
    const field = (name, value) => {
      textParts.push(
        `--${boundary}${crlf}` +
          `Content-Disposition: form-data; name="${name}"${crlf}${crlf}` +
          `${value}${crlf}`,
      );
    };
    field("model", modelId);
    field("response_format", "verbose_json");
    // Word-level timestamps are requested when the caller wants them AND
    // the model supports them; the segment granularity rides along. When
    // the timestamp set is omitted entirely Groq defaults to segments —
    // still parseable, just evenly-distributed word timing.
    if (wantWordTimestamps) {
      field("timestamp_granularities[]", "word");
      field("timestamp_granularities[]", "segment");
    }
    if (language) field("language", language);

    const fileHeader =
      `--${boundary}${crlf}` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"${crlf}` +
      `Content-Type: audio/mpeg${crlf}${crlf}`;
    const closing = `--${boundary}--${crlf}`;

    const head = Buffer.concat([
      Buffer.from(textParts.join(""), "utf8"),
      Buffer.from(fileHeader, "utf8"),
    ]);
    const totalBytes = head.length + fileBytes + Buffer.byteLength(closing);

    const req = createRequest(
      {
        host: GROQ_API_HOST,
        path: TRANSCRIBE_PATH,
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          // Node transport: exact framing. Electron transport: Chromium owns
          // this header (it is skipped there — chunked upload, valid HTTP).
          "Content-Length": String(totalBytes),
        },
      },
      (res) => {
        const chunks = [];
        let bytes = 0;
        res.on("data", (d) => {
          chunks.push(d);
          bytes += d.length;
          if (bytes > 20 * 1024 * 1024) {
            req.destroy();
            reject(new Error("Groq response exceeded 20 MB — aborted"));
          }
        });
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) {
            // v1.22: attach the machine-readable facts so groqTranscribe's
            // retry layer can classify (400 timestamps / 404 model).
            // v1.29: thread the MASKED form of the key we actually sent so
            // the rejection message names the culprit key.
            let apiMessage = "";
            try {
              const j = JSON.parse(body);
              apiMessage = j?.error?.message || j?.message || "";
            } catch (_) { /* non-JSON body */ }
            const err = new Error(
              classifyGroqError(res.statusCode, body, maskApiKey(apiKey)),
            );
            err.status = res.statusCode;
            err.apiMessage = apiMessage;
            reject(err);
            return;
          }
          try {
            const j = JSON.parse(body);
            const words = Array.isArray(j.words) ? j.words : null;
            const segments = Array.isArray(j.segments) ? j.segments : [];
            let outChunks = [];
            let wordLevel = false;
            if (words && words.length > 0) {
              wordLevel = true;
              outChunks = words.map((w) => ({
                text: String(w.word || "").trim(),
                timestamp: [
                  typeof w.start === "number" ? w.start : null,
                  typeof w.end === "number" ? w.end : null,
                ],
              }));
            } else if (segments.length > 0) {
              wordLevel = false;
              outChunks = segments.map((s) => ({
                text: String(s.text || "").trim(),
                timestamp: [
                  typeof s.start === "number" ? s.start : null,
                  typeof s.end === "number" ? s.end : null,
                ],
              }));
            }
            // Drop empty texts (trailing punctuation-only tokens).
            outChunks = outChunks.filter((c) => c.text && c.text.length > 0);
            resolve({
              chunks: outChunks,
              language:
                typeof j.language === "string" && j.language ? j.language : null,
              wordLevel,
              durationMs:
                typeof j.duration === "number" ? Math.round(j.duration * 1000) : 0,
              text: typeof j.text === "string" ? j.text : "",
            });
          } catch (err) {
            reject(new Error(`Could not parse the Groq response: ${err.message}`));
          }
        });
      },
    );

    // Cancel hook — used by whisper:cancel (destroys the socket; the exit
    // handler rejects with a cancellation sentinel).
    if (o.abortRef && typeof o.abortRef === "object") {
      o.abortRef.abort = () => {
        try { req.destroy(new Error("Transcription cancelled")); } catch (_) {}
      };
    }

    const CONNECT_TIMEOUT_MS = 30000;
    req.setTimeout(CONNECT_TIMEOUT_MS, () => {
      req.destroy(new Error("Could not reach api.groq.com (connection timed out)"));
    });

    req.on("error", (err) => {
      reject(err instanceof Error ? err : new Error(String(err)));
    });

    // Write the multipart body with backpressure + upload progress.
    let uploaded = 0;
    const sendProgress = (n) => {
      if (!onProgress) return;
      const pct = Math.min(60, 25 + Math.round((n / totalBytes) * 35));
      onProgress({
        progress: pct,
        status: `Uploading audio to Groq (${(n / 1048576).toFixed(1)} / ${(totalBytes / 1048576).toFixed(1)} MB)…`,
      });
    };
    req.write(head);
    uploaded += head.length;
    sendProgress(uploaded);
    const CHUNK = 1024 * 512;
    let offset = 0;
    const fd = fs.openSync(filePath, "r");
    const writeNext = () => {
      if (req.destroyed) { try { fs.closeSync(fd); } catch (_) {} return; }
      if (offset >= fileBytes) {
        req.end(closing, () => {
          try { fs.closeSync(fd); } catch (_) {}
        });
        onProgress?.({
          progress: 65,
          status: `Groq ${modelId} is transcribing…`,
        });
        return;
      }
      const len = Math.min(CHUNK, fileBytes - offset);
      const buf = Buffer.allocUnsafe(len);
      const n = fs.readSync(fd, buf, 0, len, offset);
      if (n <= 0) {
        try { fs.closeSync(fd); } catch (_) {}
        req.destroy(new Error("Audio file changed while uploading"));
        return;
      }
      offset += n;
      const ok = req.write(buf, () => {
        uploaded += n;
        sendProgress(uploaded);
      });
      if (!ok) {
        // Backpressure: resume on drain. The 400 ms fallback timer covers
        // transports whose write() returns false but 'drain' is late/absent
        // (Chromium's net stack has its own buffering) — without it a
        // missing drain would stall the upload forever.
        let resumed = false;
        const go = () => {
          if (resumed) return;
          resumed = true;
          clearTimeout(fallback);
          writeNext();
        };
        req.once("drain", go);
        const fallback = setTimeout(go, 400);
      } else {
        writeNext();
      }
    };
    writeNext();
  });
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

/** Build the probe multipart body (same builder style as
 *  groqTranscribeOnce — field order: model, response_format, then file). */
function buildProbeBody(modelId) {
  const boundary = `----FrameFuseProbe${crypto.randomBytes(12).toString("hex")}`;
  const crlf = "\r\n";
  const fileBytes = Buffer.from(PROBE_MP3_B64, "base64");
  const parts = [];
  const field = (name, value) => {
    parts.push(
      `--${boundary}${crlf}` +
        `Content-Disposition: form-data; name="${name}"${crlf}${crlf}` +
        `${value}${crlf}`,
    );
  };
  field("model", modelId);
  field("response_format", "json");
  const fileHeader =
    `--${boundary}${crlf}` +
    `Content-Disposition: form-data; name="file"; filename="probe.mp3"${crlf}` +
    `Content-Type: audio/mpeg${crlf}${crlf}`;
  const closing = `--${boundary}--${crlf}`;
  const body = Buffer.concat([
    Buffer.from(parts.join(""), "utf8"),
    Buffer.from(fileHeader, "utf8"),
    fileBytes,
    Buffer.from(closing, "utf8"),
  ]);
  return { boundary, body };
}

/** POST the embedded silence to /audio/transcriptions. Resolves
 *  { ok:boolean, message:string } — ok ONLY on a real 200. */
function groqTranscribeProbe(apiKey, modelId) {
  return new Promise((resolve) => {
    const model = normalizeGroqModel(modelId);
    const { boundary, body } = buildProbeBody(model);
    const req = createRequest(
      {
        host: GROQ_API_HOST,
        path: TRANSCRIBE_PATH,
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(body.length),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const bodyText = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode === 200) {
            resolve({ ok: true, message: "" });
            return;
          }
          resolve({
            ok: false,
            message: classifyGroqError(res.statusCode, bodyText, maskApiKey(apiKey)),
          });
        });
      },
    );
    req.setTimeout(20000, () => {
      req.destroy(new Error("Probe timed out connecting to api.groq.com"));
    });
    req.on("error", (err) =>
      resolve({ ok: false, message: err instanceof Error ? err.message : String(err) }),
    );
    req.end(body);
  });
}

/** Validate a key END TO END (v1.30):
 *  1. GET /openai/v1/models — does the key authenticate at all?
 *  2. POST the 1s probe to /openai/v1/audio/transcriptions with the
 *     selected whisper model — does TRANSCRIPTION actually work?
 *  Resolves { ok:boolean, message:string, whisperModels:string[] }. */
function groqTestKey(apiKey, opts) {
  const model = normalizeGroqModel(opts && opts.model);
  return new Promise((resolve) => {
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
            // v1.29: masked fingerprint of the key we just probed.
            resolve({
              ok: false,
              message: classifyGroqError(res.statusCode, body, maskApiKey(apiKey)),
              whisperModels: [],
            });
            return;
          }
          let whisperModels = [];
          try {
            const j = JSON.parse(body);
            whisperModels = (Array.isArray(j.data) ? j.data : [])
              .map((m) => m && m.id)
              .filter((id) => typeof id === "string" && id.startsWith("whisper"));
          } catch (_) { /* non-fatal */ }
          // v1.30: /models passing is no longer enough — run the REAL
          // transcription probe so "key works" means "transcription works".
          groqTranscribeProbe(apiKey, model).then((probe) => {
            if (probe.ok) {
              resolve({
                ok: true,
                message: `Key works — real transcription verified end to end (${model}; the key, the model and the upload all passed)`,
                whisperModels,
              });
              return;
            }
            // Auth OK but transcription failed — a DIFFERENT problem, and
            // the message must say so (not "rejected key").
            resolve({
              ok: false,
              message: `The key authenticates, but a real transcription test failed: ${probe.message}`,
              whisperModels,
            });
          });
        });
      },
    );
    req.setTimeout(15000, () => {
      req.destroy(new Error("Connection to api.groq.com timed out"));
    });
    req.on("error", (err) =>
      resolve({ ok: false, message: err.message, whisperModels: [] }),
    );
    req.end();
  });
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
  transportName,
  groqTranscribe,
  groqTestKey,
  groqTranscribeProbe,
};
