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
const https = require("https");
const crypto = require("crypto");
const { spawn } = require("child_process");

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
// HTTPS plumbing (raw https.request — upload progress + no deps).
// ---------------------------------------------------------------------------

/** Classify a Groq API failure into an actionable message. */
function classifyGroqError(status, bodyText) {
  let apiMessage = "";
  try {
    const j = JSON.parse(bodyText);
    apiMessage = j?.error?.message || j?.message || "";
  } catch (_) { /* non-JSON body */ }
  const raw = apiMessage ? ` [${apiMessage}]` : "";
  switch (status) {
    case 401:
    case 403:
      // Groq returns 403 (not 401) for invalid/revoked keys.
      return `Groq rejected the API key — check that it's valid (console.groq.com → API Keys) and has audio model access${raw}`;
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
  return new Promise((resolve, reject) => {
    const { apiKey, model, filePath } = o;
    const modelId = normalizeGroqModel(model);
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
    field("timestamp_granularities[]", "word");
    field("timestamp_granularities[]", "segment");
    if (o.language && o.language !== "auto") field("language", o.language);

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

    const req = https.request(
      {
        host: GROQ_API_HOST,
        path: TRANSCRIBE_PATH,
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": totalBytes,
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
            reject(new Error(classifyGroqError(res.statusCode, body)));
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
        req.once("drain", writeNext);
      } else {
        writeNext();
      }
    };
    writeNext();
  });
}

/** Validate an API key (GET /openai/v1/models). Resolves
 *  { ok:boolean, message:string, whisperModels:string[] }. */
function groqTestKey(apiKey) {
  return new Promise((resolve) => {
    const req = https.request(
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
            resolve({ ok: false, message: classifyGroqError(res.statusCode, body), whisperModels: [] });
            return;
          }
          let whisperModels = [];
          try {
            const j = JSON.parse(body);
            whisperModels = (Array.isArray(j.data) ? j.data : [])
              .map((m) => m && m.id)
              .filter((id) => typeof id === "string" && id.startsWith("whisper"));
          } catch (_) { /* non-fatal */ }
          resolve({
            ok: true,
            message: "Key works — Whisper is available on this account",
            whisperModels,
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
  groqConfigPath,
  loadGroqConfig,
  saveGroqConfig,
  maskApiKey,
  encodeCompactAudio,
  extractAudioForGroq,
  classifyGroqError,
  groqTranscribe,
  groqTestKey,
};
