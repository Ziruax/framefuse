// electron/dub-workflow.js — the video-dubbing pipeline brain.
//
// v1.16 (dubbing) — runs in the Electron main process. Pipeline:
//
//   prepare     → extract each timeline segment's audio (mono 16 kHz),
//                 concat them into one WAV, and remember the concat-time →
//                 timeline-time mapping (segments can have gaps/trims, so
//                 dubbed audio must be placed back on TIMELINE time).
//   transcribe  → Groq Whisper on the concat WAV (bitrate ladder; if even
//                 16 kbps won't fit the 25 MB cap, time-chunk into
//                 ≤10-minute pieces), group words into utterances.
//   speakers    → Groq chat model labels 1–4 speakers per utterance
//                 (JSON mode); pause-based heuristic as fallback.
//   translate   → Groq chat model translates utterances into the target
//                 language, batches of ≤15 (free-tier rate limits), one
//                 retry round for missing indices, then original-text
//                 fallback with a warning.
//   synthesize  → Edge TTS (electron/edge-tts.js, built by agent 57-b)
//                 renders one MP3 per utterance, 2 workers max.
//   fit         → atempo speed-up (clamped), lead-in into the preceding
//                 gap, capped spill into the following gap; final 48 kHz
//                 stereo WAVs (the export pipeline mixes at 48 kHz).
//   done        → result object; only the final dub_*.wav files survive
//                 inside tempDir/framefuse-dub-<ts>/ (the caller owns their
//                 lifetime via cleanupDubTemp()).
//
// Reuses groq-whisper.js (extractAudioForGroq, groqTranscribe,
// GROQ_MAX_UPLOAD_BYTES, normalizeGroqModel) and groq-chat.js (groqChat,
// parseJsonish, normalizeTextModel). Edge TTS is loaded LAZILY because the
// module is built in parallel (57-b); the contract used here:
//   TTS.synthesize({ text, voice, ratePct, pitchHz, volumePct, outFile, abortRef? })
//     → Promise<{ filePath, bytes, bytesLen }>   (prosody values are DELTAS: 0 = neutral)
//   TTS.voicePairsByLocale() → { "hi-IN": { female, male }, … } (SYNC map)
//
// NOTE — groqTranscribe (v1.15 signature: apiKey, model, filePath,
// language, onProgress, abortRef) does NOT accept a `prompt` field, so the
// "carry the previous chunk's tail text as a Whisper prompt" idea is
// skipped by design; chunks are cut at fixed 10-minute marks instead.
//
// This module is a PLAIN Node module (zero deps, no Electron imports) with
// injectable seams (_setDepsForTesting) so the whole pipeline can be
// smoke-tested without a Groq key or the network.
//
// Writes ONLY inside tempDir/framefuse-dub-<ts>/.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const GW = require("./groq-whisper");
const GC = require("./groq-chat");

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Word gap that starts a new utterance (ms). */
const UTTERANCE_GAP_MS = 800;
/** Hard cap on one utterance — longer runs are split (TTS + translation
 *  both behave better on sentence-ish units). */
const UTTERANCE_MAX_MS = 15000;
/** A gap below this is not a useful split point inside an over-long
 *  utterance (we then split at the word midpoint instead). */
const UTTERANCE_SPLIT_MIN_GAP_MS = 250;
/** Pause that hints a speaker change in the heuristic fallback (ms). */
const HEURISTIC_SPEAKER_GAP_MS = 1200;
/** Translation batch size — free-tier rate limits. */
const TRANSLATE_BATCH_SIZE = 15;
/** Edge TTS workers — rate-friendly. */
const TTS_CONCURRENCY = 2;
/** Whisper time-chunk length (rate limits + reliability). */
const MAX_CHUNK_SEC = 600;
/** How far a too-long dub may run into the NEXT utterance's speech (ms). */
const SPILL_CAP_MS = 300;
/** Minimum plausible speech window (ms) — guards degenerate timestamps. */
const MIN_WINDOW_MS = 120;

const DUB_DIR_PREFIX = "framefuse-dub-";
const CANCEL_DUB_MSG = "Dubbing cancelled";

const PHASE_LABELS = {
  prepare: "audio preparation",
  transcribe: "transcription",
  speakers: "speaker detection",
  translate: "translation",
  synthesize: "voice synthesis",
  fit: "timing fit",
};

// ---------------------------------------------------------------------------
// Language names for the translation prompt (ISO-639-1 → English name).
// ---------------------------------------------------------------------------

const LANG_NAMES = {
  hi: "Hindi", en: "English", ur: "Urdu", ar: "Arabic", bn: "Bengali",
  ta: "Tamil", te: "Telugu", mr: "Marathi", es: "Spanish", fr: "French",
  de: "German", pt: "Portuguese", ru: "Russian", zh: "Chinese", ja: "Japanese",
  ko: "Korean", id: "Indonesian", tr: "Turkish", vi: "Vietnamese", th: "Thai",
  nl: "Dutch", pl: "Polish", it: "Italian", fa: "Persian", sw: "Swahili",
  pa: "Punjabi", gu: "Gujarati", kn: "Kannada", ml: "Malayalam", uk: "Ukrainian",
  // Extras beyond the required list.
  cs: "Czech", sv: "Swedish", da: "Danish", no: "Norwegian", fi: "Finnish",
  el: "Greek", he: "Hebrew", hu: "Hungarian", ro: "Romanian", ms: "Malay",
  ne: "Nepali", si: "Sinhala", af: "Afrikaans", bg: "Bulgarian", sk: "Slovak",
};

function languageName(code) {
  const c = String(code || "").toLowerCase().trim();
  return LANG_NAMES[c] || (c ? `the ${c} language` : "the target language");
}

// ---------------------------------------------------------------------------
// Injectable seams — tests monkey-patch these instead of hitting the
// network. ttsSynthesize/voicePairsByLocale default to null and are
// resolved lazily from ./edge-tts (the parallel-built module).
// ---------------------------------------------------------------------------

const deps = {
  groqTranscribe: GW.groqTranscribe,
  extractAudioForGroq: GW.extractAudioForGroq,
  groqChat: GC.groqChat,
  ttsSynthesize: null,
  voicePairsByLocale: null,
};

/** @returns the previous deps (so tests can restore them). */
function _setDepsForTesting(patch) {
  const prev = { ...deps };
  Object.assign(deps, patch || {});
  return prev;
}

/** Resolve the Edge TTS functions once (lazy require — the module may not
 *  exist yet while agent 57-b builds it). Throws an actionable error if
 *  it is missing. Tests must inject BOTH tts seams to avoid this. */
function ttsDeps() {
  if (typeof deps.ttsSynthesize !== "function" || typeof deps.voicePairsByLocale !== "function") {
    let TTS;
    try {
      TTS = require("./edge-tts");
    } catch (_) {
      throw new Error("Edge TTS module (electron/edge-tts.js) is missing — dubbing needs it to synthesize voices");
    }
    if (typeof deps.ttsSynthesize !== "function") deps.ttsSynthesize = TTS.synthesize;
    if (typeof deps.voicePairsByLocale !== "function") deps.voicePairsByLocale = TTS.voicePairsByLocale;
  }
  return deps;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function pad(i) { return String(i).padStart(4, "0"); }

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

function fileNonEmpty(p) {
  try { return fs.statSync(p).size > 0; } catch (_) { return false; }
}

function truncate(s, n) {
  const t = String(s || "");
  return t.length <= n ? t : `${t.slice(0, Math.max(1, n - 1))}…`;
}

function isCancelMessage(msg) {
  return /cancel/i.test(String(msg || ""));
}

/** One concat-demuxer list line. Backslashes are normalised to forward
 *  slashes (ffmpeg's concat demuxer treats "\" as an escape character, and
 *  forward slashes work on Windows too) and single quotes are escaped. */
function concatListLine(p) {
  const norm = String(p).replace(/\\/g, "/");
  return `file '${norm.replace(/'/g, "'\\''")}'\n`;
}

/** Promisified ffmpeg (same error shape as groq-whisper's encodeCompactAudio). */
function runFfmpeg(ffmpegPath, args, label) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      ffmpegPath,
      ["-hide_banner", "-loglevel", "error", "-y", ...args],
      { windowsHide: true },
    );
    let stderrTail = "";
    proc.stderr.on("data", (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-1200);
    });
    proc.on("error", (err) =>
      reject(new Error(`${label}: could not run ffmpeg: ${err.message}`)),
    );
    proc.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(
        `${label} failed (exit ${code}${signal ? `, signal ${signal}` : ""})` +
        `${stderrTail ? `: ${stderrTail.trim().split("\n").slice(-2).join(" ")}` : ""}`,
      ));
    });
  });
}

/** Duration of a media file in ms via ffprobe (format=duration). */
function probeDurationMs(ffprobePath, filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      ffprobePath,
      [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        filePath,
      ],
      { windowsHide: true },
    );
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => { out += d.toString(); });
    proc.stderr.on("data", (d) => { err += d.toString(); });
    proc.on("error", (e) =>
      reject(new Error(`Could not run ffprobe: ${e.message}`)),
    );
    proc.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(
          `ffprobe failed on ${path.basename(filePath)}` +
          `${err ? `: ${err.trim().split("\n").slice(-2).join(" ")}` : ""}`,
        ));
        return;
      }
      const sec = parseFloat(out.trim());
      if (!Number.isFinite(sec) || sec < 0) {
        reject(new Error(`ffprobe returned no duration for ${path.basename(filePath)}`));
        return;
      }
      resolve(Math.round(sec * 1000));
    });
  });
}

// ---------------------------------------------------------------------------
// PURE pipeline pieces (unit-tested directly)
// ---------------------------------------------------------------------------

/**
 * concat-time → timeline-time mapping.
 *
 * The concat WAV squeezes the segments together (gaps/trims disappear), so
 * every whisper timestamp must be mapped back: inside segment i, timeline =
 * segments[i].startMs + (concatMs - concatStartOf(i)), where concatStart is
 * the sum of the EXTRACTED audio durations before it.
 *
 * @param {number[]} durationsMs  Extracted audio duration per segment.
 * @param {Array<{startMs:number}>} segments  Timeline segments (sorted by startMs).
 * @returns {{entries:Array<{concatStartMs,durMs,timelineStartMs}>, totalConcatMs:number}}
 */
function buildTimelineMap(durationsMs, segments) {
  const entries = [];
  let acc = 0;
  for (let i = 0; i < segments.length; i++) {
    const dur = Math.max(0, Math.round(durationsMs[i] || 0));
    entries.push({
      concatStartMs: acc,
      durMs: dur,
      timelineStartMs: Math.max(0, Math.round(segments[i].startMs || 0)),
    });
    acc += dur;
  }
  return { entries, totalConcatMs: acc };
}

/** Map a concat-time (ms) onto timeline time (ms) using buildTimelineMap's
 *  result. Times beyond the last segment extrapolate from the last entry. */
function concatMsToTimelineMs(map, concatMs) {
  const es = map && map.entries;
  if (!es || es.length === 0) return concatMs;
  for (let i = 0; i < es.length; i++) {
    const e = es[i];
    if (concatMs < e.concatStartMs + e.durMs) {
      return e.timelineStartMs + (concatMs - e.concatStartMs);
    }
  }
  const last = es[es.length - 1];
  return last.timelineStartMs + (concatMs - last.concatStartMs);
}

/**
 * Group whisper WORDS into utterance segments.
 *
 * @param {Array<{text:string, timestamp:[number|null, number|null]}>} words
 *        groqTranscribe's wordLevel chunks (seconds).
 * @param {object} [opts] { gapMs=800, maxDurMs=15000 }
 * @returns {Array<{startMs:number, endMs:number, text:string}>} in ms.
 */
function groupWordsToUtterances(words, opts) {
  const gapMs = (opts && Number(opts.gapMs)) || UTTERANCE_GAP_MS;
  const maxDurMs = (opts && Number(opts.maxDurMs)) || UTTERANCE_MAX_MS;
  const ws = [];
  for (const w of words || []) {
    if (!w || typeof w.text !== "string" || !w.text.trim()) continue;
    const ts = Array.isArray(w.timestamp) ? w.timestamp : [];
    const start = typeof ts[0] === "number" ? ts[0] : null;
    if (start == null) continue; // unusable timing — drop the word
    const end = typeof ts[1] === "number" && ts[1] >= start ? ts[1] : start;
    ws.push({ text: w.text.trim(), start, end });
  }
  ws.sort((a, b) => a.start - b.start);

  // 1) group on inter-word gaps
  const groups = [];
  let cur = null;
  for (const w of ws) {
    if (!cur || (w.start - cur.end) * 1000 > gapMs) {
      cur = { words: [w], start: w.start, end: w.end };
      groups.push(cur);
    } else {
      cur.words.push(w);
      cur.end = Math.max(cur.end, w.end);
    }
  }

  // 2) split over-long groups (largest internal gap, else the midpoint)
  const out = [];
  const emit = (g) => out.push({
    startMs: Math.round(g.start * 1000),
    endMs: Math.round(g.end * 1000),
    text: g.words.map((x) => x.text).join(" "),
  });
  const splitRec = (g) => {
    if ((g.end - g.start) * 1000 <= maxDurMs || g.words.length < 2) {
      emit(g);
      return;
    }
    let cut = -1;
    let bestGap = 0;
    for (let i = 1; i < g.words.length; i++) {
      const gap = (g.words[i].start - g.words[i - 1].end) * 1000;
      if (gap > bestGap) { bestGap = gap; cut = i; }
    }
    if (bestGap < UTTERANCE_SPLIT_MIN_GAP_MS) cut = Math.ceil(g.words.length / 2);
    splitRec({ words: g.words.slice(0, cut), start: g.words[0].start, end: g.words[cut - 1].end });
    splitRec({ words: g.words.slice(cut), start: g.words[cut].start, end: g.words[g.words.length - 1].end });
  };
  for (const g of groups) splitRec(g);

  return out.filter((u) => u.text && u.endMs > u.startMs);
}

/**
 * Validate an LLM speaker-assignment reply.
 * @param {*} parsed  parseJsonish output (object or null).
 * @param {number} count  number of utterance segments.
 * @returns {{ok:true, speakerCount:number, speakers:number[]}|{ok:false}}
 *          ok only when EVERY index 0..count-1 is covered with a valid
 *          0-based speaker id (0..3).
 */
function parseSpeakerAssignment(parsed, count) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false };
  const entries = Array.isArray(parsed.segments) ? parsed.segments : null;
  if (!entries) return { ok: false };
  const ids = new Array(count).fill(-1);
  let maxSpeaker = -1;
  for (const e of entries) {
    if (!e || typeof e !== "object") continue;
    const i = e.i;
    const s = e.speaker;
    if (Number.isInteger(i) && i >= 0 && i < count &&
        Number.isInteger(s) && s >= 0 && s <= 3) {
      ids[i] = s;
      if (s > maxSpeaker) maxSpeaker = s;
    }
  }
  if (ids.includes(-1)) return { ok: false };
  let speakerCount = Number.isFinite(Number(parsed.speakerCount))
    ? Math.round(Number(parsed.speakerCount))
    : maxSpeaker + 1;
  speakerCount = Math.min(4, Math.max(1, speakerCount, Math.min(4, maxSpeaker + 1)));
  return { ok: true, speakerCount, speakers: ids };
}

/**
 * Fallback speaker labelling when the LLM fails or returns garbage:
 * 2 alternating speakers when the text looks like dialogue (question marks
 * + short turns) with >1.2s pauses between turns, else 1 speaker.
 * @param {Array<{startMs:number,endMs:number,text:string}>} utts
 */
function heuristicSpeakers(utts) {
  const n = utts.length;
  if (n < 2) return { speakerCount: 1, speakers: new Array(Math.max(0, n)).fill(0) };
  const hasQuestion = utts.some((u) => (u.text || "").includes("?"));
  const shortTurns = utts.filter((u) => (u.endMs - u.startMs) < 7000).length;
  if (!hasQuestion || shortTurns < 2) {
    return { speakerCount: 1, speakers: new Array(n).fill(0) };
  }
  const speakers = new Array(n).fill(0);
  let cur = 0;
  for (let i = 1; i < n; i++) {
    if (utts[i].startMs - utts[i - 1].endMs > HEURISTIC_SPEAKER_GAP_MS) cur = 1 - cur;
    speakers[i] = cur;
  }
  return { speakerCount: 2, speakers };
}

/** Split 0..count-1 into batches of ≤size (e.g. 40 → [0..14, 15..29, 30..39]). */
function splitBatches(count, size) {
  const s = Math.max(1, Math.floor(size));
  const batches = [];
  for (let i = 0; i < count; i += s) {
    const batch = [];
    for (let j = i; j < Math.min(i + s, count); j++) batch.push(j);
    batches.push(batch);
  }
  return batches;
}

/**
 * Timing-fit decision for one dub segment (spec order: speed first, then
 * lead-in into the preceding gap, then capped spill into the following
 * gap; whatever still doesn't fit is reported as overrun).
 *
 * @param {object} o { ttsDurMs, windowMs, leadInMs, spillMs, fitSpeedMax }
 * @returns {{speed:number, effDurMs:number, startShiftMs:number,
 *            spillUsedMs:number, overrunMs:number}}
 */
function computeFitPlan(o) {
  const ttsDurMs = Math.max(0, Number(o.ttsDurMs) || 0);
  const windowMs = Math.max(1, Number(o.windowMs) || 1);
  const leadInMs = Math.max(0, Number(o.leadInMs) || 0);
  const spillMs = Math.max(0, Number(o.spillMs) || 0);
  const fitSpeedMax = Math.min(2, Math.max(1, Number(o.fitSpeedMax) || 1.35)); // atempo 0.5–2.0
  let speed = ttsDurMs > windowMs ? ttsDurMs / windowMs : 1;
  speed = Math.min(fitSpeedMax, Math.max(1, speed));
  speed = Math.round(speed * 1000) / 1000;
  const effDurMs = speed > 0 ? ttsDurMs / speed : ttsDurMs;
  let startShiftMs = 0;
  let spillUsedMs = 0;
  let overrunMs = 0;
  if (effDurMs > windowMs) {
    const need = effDurMs - windowMs;
    startShiftMs = Math.round(Math.min(leadInMs, need));
    const need2 = need - startShiftMs;
    if (need2 > 0) {
      spillUsedMs = Math.round(Math.min(spillMs, need2));
      overrunMs = Math.round(need2 - spillUsedMs);
    }
  }
  return { speed, effDurMs: Math.round(effDurMs), startShiftMs, spillUsedMs, overrunMs };
}

/**
 * Pick the female/male Edge TTS voice pair for a locale:
 * exact locale → any locale of the language → en-US (warned) → failure.
 * @returns {{ok:boolean, locale:string, female:string|null, male:string|null, warnings:string[]}}
 */
function pickVoicePair(voicePairs, targetLocale, targetLanguage) {
  const warnings = [];
  const pairs = voicePairs && typeof voicePairs === "object" ? voicePairs : null;
  let resolvedLocale = String(targetLocale || "");
  let pair = null;
  if (pairs) {
    pair = pairs[targetLocale] || pairs[String(targetLocale).toLowerCase()] || null;
    if (!pair) {
      const lang = String(targetLanguage || "").toLowerCase();
      const key = Object.keys(pairs).find((k) => {
        const kl = k.toLowerCase();
        return kl === lang || kl.startsWith(`${lang}-`);
      });
      if (key) {
        pair = pairs[key];
        resolvedLocale = key;
        warnings.push(`No Edge TTS voice pair for ${targetLocale} — using ${key} voices.`);
      }
    }
  }
  if (pair && typeof pair === "object" && (pair.female || pair.male)) {
    const female = typeof pair.female === "string" && pair.female ? pair.female : (pair.male || null);
    const male = typeof pair.male === "string" && pair.male ? pair.male : (pair.female || null);
    return { ok: true, locale: resolvedLocale, female, male, warnings };
  }
  const enUs = pairs ? (pairs["en-US"] || pairs["en-us"] || null) : null;
  if (enUs && typeof enUs === "object" && (enUs.female || enUs.male)) {
    warnings.push(`No Edge TTS voices for ${targetLocale} — dubbing will use the en-US pair.`);
    return {
      ok: true,
      locale: "en-US",
      female: enUs.female || enUs.male,
      male: enUs.male || enUs.female,
      warnings,
    };
  }
  return {
    ok: false,
    locale: "",
    female: null,
    male: null,
    warnings: [...warnings, "Edge TTS returned no usable voice pairs."],
  };
}

/** Voice + gender for one speaker id: explicit override first, then
 *  even ids → female, odd ids → male (single-gender pairs degrade
 *  gracefully to the one available voice). */
function pickVoiceForSpeaker(speakerId, pair, speakerVoices) {
  const override = speakerVoices ? speakerVoices[speakerId] : null;
  if (typeof override === "string" && override.trim()) {
    return { voice: override.trim(), gender: null };
  }
  const wantFemale = speakerId % 2 === 0;
  const voice = wantFemale ? (pair.female || pair.male) : (pair.male || pair.female);
  const gender = wantFemale ? (pair.female ? "female" : "male") : (pair.male ? "male" : "female");
  return { voice, gender };
}

// ---------------------------------------------------------------------------
// Prompt builders (both mention "JSON" — required for json_object mode).
// ---------------------------------------------------------------------------

const SPEAKER_SYSTEM =
  "You analyse transcripts of videos that may contain several people talking. " +
  "You label which speaker said each transcript segment. " +
  "You always reply with JSON only — no commentary.";

function speakerUserPrompt(utts) {
  const lines = utts
    .map((u, i) => `${i} | ${(u.startMs / 1000).toFixed(1)}s–${(u.endMs / 1000).toFixed(1)}s | ${truncate(u.text, 160)}`)
    .join("\n");
  return (
    "Numbered transcript segments from one video, in time order:\n\n" +
    `${lines}\n\n` +
    "Identify the distinct speakers — between 1 and 4. Clues: turn-taking with pauses, " +
    "questions and answers, greetings, names, changes of style.\n\n" +
    'Return JSON exactly like {"speakerCount":2,"segments":[{"i":0,"speaker":0},…]} — ' +
    '"speaker" is a 0-based id, the same voice always gets the same id, ' +
    "and EVERY segment index appears exactly once."
  );
}

function translateSystemPrompt(langName) {
  return (
    "You are a professional dubbing translator. You translate transcript segments " +
    `so a text-to-speech voice can re-record them in ${langName}. ` +
    "You always reply with JSON only — no commentary."
  );
}

function translateUserPrompt(utts, idxs, langName) {
  const lines = idxs.map((i) => `${i} | ${utts[i].text}`).join("\n");
  return (
    `Translate each numbered segment into ${langName}.\n\n` +
    `Segments:\n${lines}\n\n` +
    "Requirements:\n" +
    "- Preserve the meaning and the tone of every segment.\n" +
    `- Write natural, spoken-style ${langName} — it will be spoken aloud by TTS, so prefer everyday wording and no stage directions.\n` +
    "- NEVER merge, reorder, drop, or add segments: exactly one translation per input index, the same index back.\n" +
    "- Keep each translation about as long to speak as the original.\n" +
    "- Write numbers and dates the way they are spoken.\n\n" +
    'Return JSON exactly like {"segments":[{"i":0,"text":"…"},…]} with every input index exactly once.'
  );
}

// ---------------------------------------------------------------------------
// runDub
// ---------------------------------------------------------------------------

/**
 * Run the full dubbing pipeline.
 *
 * @param {object} o
 * @param {Array<{videoPath:string, startMs:number, endMs?:number, volume?:number}>} o.segments
 *        Base-lane timeline segments (already-uploaded temp files), sorted
 *        however — they get sorted by startMs. endMs/volume are unused:
 *        durations come from the ACTUAL extracted audio.
 * @param {string} [o.sourceLanguage="auto"]  ISO-639-1 or "auto".
 * @param {string} [o.targetLanguage="en"]    ISO-639-1 target.
 * @param {string} [o.targetLocale]           Full locale for the voice pick
 *        (defaults to targetLanguage; pickVoicePair falls back by language).
 * @param {string} [o.groqModel]              Chat model id (normalized).
 * @param {string} [o.whisperModel]           Groq Whisper model id
 *        (normalized; default whisper-large-v3-turbo).
 * @param {Object} [o.speakerVoices]          { 0: "hi-IN-SwaraNeural", … } overrides.
 * @param {string} [o.voiceMode="multi"]      "single" = ONE voice for every line
 *        (the speakers phase skips detection entirely); "multi" (or
 *        absent) = per-speaker voices (legacy behavior).
 * @param {string} [o.singleVoice]            Edge-TTS ShortName for single
 *        mode. Non-empty → it overrides the voice of EVERY speaker id;
 *        empty/null + voiceMode "single" → the locale pair's female.
 * @param {number} [o.ttsRatePct=0] [o.ttsPitchHz=0] [o.ttsVolumePct=0]  (Edge TTS prosody DELTAS)
 * @param {number} [o.fitSpeedMax=1.35]       atempo clamp (1–2).
 * @param {string} o.tempDir                  Caller-provided temp dir; all
 *        intermediates + final WAVs live in tempDir/framefuse-dub-<ts>/.
 * @param {string} o.ffmpegPath  @param {string} o.ffprobePath
 * @param {string} o.apiKey                   Groq key (caller loads it).
 * @param {(p:{phase:string,progress:number,status:string,detail?:object})=>void} [o.onProgress]
 *        Phases: prepare, transcribe, speakers, translate, synthesize, fit, done.
 * @param {{abort:Function}} [o.abortRef]     Populated; abort() rejects the
 *        run with "Dubbing cancelled" and auto-cleans the dub dir.
 * @returns {Promise<{language:string, speakers:Array<{id,voice,gender}>,
 *   segments:Array<{startMs,endMs,speaker,sourceText,translatedText,wavPath,ttsDurMs,speedApplied}>,
 *   wavPaths:string[], totalDurationMs:number, warnings:string[], dubDir:string}>}
 *   startMs is the FITTED start; endMs is the source utterance end; the
 *   actual dub end is startMs + ttsDurMs (probed from the final WAV).
 */
async function runDub(opts) {
  const o = opts || {};

  // ---- validation (fail fast, before touching the disk) ----
  if (!Array.isArray(o.segments) || o.segments.length === 0) {
    throw new Error("runDub: no source segments — pass the timeline's base-lane segments");
  }
  const segs = o.segments
    .map((s, i) => ({
      videoPath: String((s && s.videoPath) || ""),
      startMs: Math.max(0, Math.round(Number(s && s.startMs) || 0)),
    }))
    .sort((a, b) => a.startMs - b.startMs);
  for (let i = 0; i < segs.length; i++) {
    if (!segs[i].videoPath) {
      throw new Error(`runDub: segment ${i + 1} has no videoPath`);
    }
    if (!fs.existsSync(segs[i].videoPath)) {
      throw new Error(`runDub: source file not found for segment ${i + 1}: ${segs[i].videoPath}`);
    }
  }
  const apiKey = typeof o.apiKey === "string" ? o.apiKey.trim() : "";
  if (!apiKey) {
    throw new Error("runDub: no Groq API key — dubbing needs a key with Whisper + chat model access");
  }
  if (typeof o.tempDir !== "string" || !o.tempDir) {
    throw new Error("runDub: tempDir is required");
  }

  const dubDir = path.join(
    o.tempDir,
    `${DUB_DIR_PREFIX}${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
  );
  fs.mkdirSync(dubDir, { recursive: true });

  // ---- v1.20 single-voice mode ----
  // voiceMode "single" OR any non-empty singleVoice collapses the dub onto
  // ONE voice: the speakers phase skips detection entirely (no LLM call,
  // no heuristic — every utterance is speaker 0). A non-empty singleVoice
  // overrides the speakerVoices map for ids 0-3 so EVERY speaker resolves
  // to it; an empty one falls back to the locale pair's female via
  // pickVoiceForSpeaker's even-id rule. Multi mode with no singleVoice is
  // byte-identical to ≤ v1.19.
  const singleVoice = typeof o.singleVoice === "string" ? o.singleVoice.trim() : "";
  const singleMode = o.voiceMode === "single" || singleVoice.length > 0;

  const ctx = {
    segments: segs,
    apiKey,
    dubDir,
    ffmpegPath: o.ffmpegPath || "ffmpeg",
    ffprobePath: o.ffprobePath || "ffprobe",
    sourceLanguage: typeof o.sourceLanguage === "string" && o.sourceLanguage ? o.sourceLanguage : "auto",
    targetLanguage: String(o.targetLanguage || "en").toLowerCase().trim(),
    targetLocale: String(o.targetLocale || o.targetLanguage || "en").trim(),
    groqModel: GC.normalizeTextModel(o.groqModel),
    whisperModel: GW.normalizeGroqModel(o.whisperModel),
    speakerVoices: singleMode && singleVoice
      ? { 0: singleVoice, 1: singleVoice, 2: singleVoice, 3: singleVoice }
      : (o.speakerVoices && typeof o.speakerVoices === "object" ? o.speakerVoices : null),
    singleMode,
    ttsRatePct: Number.isFinite(Number(o.ttsRatePct)) ? Number(o.ttsRatePct) : 0,
    ttsPitchHz: Number.isFinite(Number(o.ttsPitchHz)) ? Number(o.ttsPitchHz) : 0,
    // Edge TTS prosody values are DELTAS (0 = neutral), per the 57-b contract.
    ttsVolumePct: Number.isFinite(Number(o.ttsVolumePct)) ? Number(o.ttsVolumePct) : 0,
    fitSpeedMax: Math.min(2, Math.max(1, Number(o.fitSpeedMax) || 1.35)),
    onProgress: typeof o.onProgress === "function" ? o.onProgress : null,
    tempFiles: [],      // intermediates — unlinked at "done"
    childAborts: [],    // { abort } refs handed to groq calls
    aborted: false,
    completed: false,
    rejectCancelled: null,
  };

  // ---- abort plumbing ----
  const cancelled = new Promise((_, rej) => { ctx.rejectCancelled = rej; });
  ctx.childAbortRef = () => {
    const ref = { abort: null };
    ctx.childAborts.push(ref);
    return ref;
  };
  ctx.checkAbort = () => {
    if (ctx.aborted) throw new Error(CANCEL_DUB_MSG);
  };
  const abortRef = o.abortRef && typeof o.abortRef === "object" ? o.abortRef : { abort: null };
  abortRef.abort = () => {
    if (ctx.completed || ctx.aborted) return;
    ctx.aborted = true;
    for (const ref of ctx.childAborts) {
      try { if (typeof ref.abort === "function") ref.abort(); } catch (_) { /* best effort */ }
    }
    ctx.rejectCancelled(new Error(CANCEL_DUB_MSG));
  };

  const work = runPipeline(ctx);
  try {
    const result = await Promise.race([work, cancelled]);
    ctx.completed = true;
    return result;
  } catch (err) {
    ctx.completed = true;
    removeDubDir(dubDir); // auto-clean on abort/error (caller keeps nothing)
    const msg = err && err.message ? err.message : String(err);
    throw new Error(isCancelMessage(msg) ? CANCEL_DUB_MSG : msg);
  }
}

/** Wrap one phase so failures carry the phase name (cancellations pass
 *  through unmangled). */
async function phase(ctx, name, fn) {
  try {
    return await fn();
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (isCancelMessage(msg)) throw new Error(CANCEL_DUB_MSG);
    throw new Error(`Dubbing failed at the ${PHASE_LABELS[name] || name} stage: ${msg}`, { cause: err });
  }
}

function report(ctx, phaseName, progress, status, detail) {
  if (!ctx.onProgress) return;
  try {
    const p = Math.max(0, Math.min(100, Math.round(Number(progress) || 0)));
    const payload = { phase: phaseName, progress: p, status: String(status || "") };
    if (detail) payload.detail = detail;
    ctx.onProgress(payload);
  } catch (_) { /* progress must never break the pipeline */ }
}

async function runPipeline(ctx) {
  const prep = await phase(ctx, "prepare", () => prepareSource(ctx));
  const trans = await phase(ctx, "transcribe", () => transcribeSource(ctx, prep));
  const speakerInfo = await phase(ctx, "speakers", () =>
    ctx.singleMode ? singleVoiceSpeakers(ctx, trans) : detectSpeakers(ctx, trans));
  const warnings = [...speakerInfo.warnings];
  const translations = await phase(ctx, "translate", () => translateSegments(ctx, trans, warnings));
  const synth = await phase(ctx, "synthesize", () => synthesizeVoices(ctx, trans, translations, speakerInfo));
  const fitted = await phase(ctx, "fit", () => fitSegments(ctx, trans, translations, synth, speakerInfo, warnings));

  // ---- done: drop every intermediate, keep only the final WAVs ----
  for (const f of ctx.tempFiles) {
    try { fs.unlinkSync(f); } catch (_) { /* best effort */ }
  }
  const wavPaths = fitted.map((s) => s.wavPath);
  const totalDurationMs = fitted.reduce((m, s) => Math.max(m, s.startMs + s.ttsDurMs), 0);
  const language = trans.language ||
    (ctx.sourceLanguage !== "auto" ? ctx.sourceLanguage : "unknown");
  report(ctx, "done", 100, "Dubbing complete", { language, segments: fitted.length });
  return {
    language,
    speakers: speakerInfo.voiceList,
    segments: fitted,
    wavPaths,
    totalDurationMs,
    warnings,
    dubDir: ctx.dubDir,
  };
}

// ---- phase 1: prepare ------------------------------------------------------

async function prepareSource(ctx) {
  const segWavs = [];
  for (let i = 0; i < ctx.segments.length; i++) {
    ctx.checkAbort();
    const out = path.join(ctx.dubDir, `seg_${pad(i)}.wav`);
    report(ctx, "prepare", (i / ctx.segments.length) * 90, `Extracting audio ${i + 1}/${ctx.segments.length}…`);
    await runFfmpeg(
      ctx.ffmpegPath,
      ["-i", ctx.segments[i].videoPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out],
      `Extracting segment ${i + 1} audio`,
    );
    if (!fileNonEmpty(out)) {
      throw new Error(`Segment ${i + 1} produced no audio — make sure it has an audio track`);
    }
    ctx.tempFiles.push(out);
    segWavs.push(out);
  }

  let concatWav;
  if (segWavs.length >= 2) {
    report(ctx, "prepare", 92, "Joining segment audio…");
    const listFile = path.join(ctx.dubDir, "list.txt");
    fs.writeFileSync(listFile, segWavs.map(concatListLine).join(""));
    ctx.tempFiles.push(listFile);
    concatWav = path.join(ctx.dubDir, "concat.wav");
    await runFfmpeg(
      ctx.ffmpegPath,
      ["-f", "concat", "-safe", "0", "-i", listFile, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", concatWav],
      "Joining segment audio",
    );
    ctx.tempFiles.push(concatWav);
  } else {
    concatWav = segWavs[0];
  }

  const durationsMs = [];
  for (const w of segWavs) {
    durationsMs.push(await probeDurationMs(ctx.ffprobePath, w));
  }
  const totalMs = await probeDurationMs(ctx.ffprobePath, concatWav);
  if (totalMs <= 0) {
    throw new Error("The source audio is empty — dubbing needs spoken audio");
  }
  const timelineMap = buildTimelineMap(durationsMs, ctx.segments);
  report(ctx, "prepare", 100, `Prepared ${(totalMs / 1000).toFixed(1)}s of audio`);
  return { concatWav, timelineMap, totalMs };
}

// ---- phase 2: transcribe ---------------------------------------------------

async function transcribeSource(ctx, prep) {
  const { concatWav, timelineMap, totalMs } = prep;
  const words = [];
  const segChunks = [];
  let language = null;

  const absorb = (res, offsetSec) => {
    if (res && res.language && !language) language = res.language;
    const chunks = res && Array.isArray(res.chunks) ? res.chunks : [];
    const target = res && res.wordLevel ? words : segChunks;
    for (const c of chunks) {
      const ts = Array.isArray(c.timestamp) ? c.timestamp : [];
      target.push({
        text: c.text,
        timestamp: [
          typeof ts[0] === "number" ? ts[0] + offsetSec : null,
          typeof ts[1] === "number" ? ts[1] + offsetSec : null,
        ],
      });
    }
  };

  // 16 kbps mono ≈ 2000 bytes/s → longest single upload that can fit the cap.
  const maxSingleSec = Math.floor(GW.GROQ_MAX_UPLOAD_BYTES / 2000);
  const totalSec = totalMs / 1000;
  let chunked = totalSec > maxSingleSec;

  if (!chunked) {
    try {
      report(ctx, "transcribe", 2, "Compressing audio for Groq…");
      const compact = await deps.extractAudioForGroq(
        ctx.ffmpegPath,
        concatWav,
        ctx.dubDir,
        (s) => report(ctx, "transcribe", 4, s),
      );
      ctx.tempFiles.push(compact.filePath);
      const res = await deps.groqTranscribe({
        apiKey: ctx.apiKey,
        model: ctx.whisperModel,
        filePath: compact.filePath,
        language: ctx.sourceLanguage,
        onProgress: (p) => report(
          ctx, "transcribe",
          Math.max(2, (p && Number(p.progress)) || 0),
          (p && p.status) || "Transcribing with Groq…",
        ),
        abortRef: ctx.childAbortRef(),
      });
      absorb(res, 0);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (isCancelMessage(msg)) throw err;
      // Ladder can only fail with "too large" here — a broken source would
      // have failed in prepare. Fall through to time-chunking.
      if (!/too large/i.test(msg)) throw err;
      chunked = true;
    }
  }

  if (chunked) {
    // NOTE: groqTranscribe has no `prompt` parameter (v1.15 signature), so
    // the previous chunk's tail text cannot prime the next chunk; skipped.
    const k = Math.max(1, Math.ceil(totalSec / MAX_CHUNK_SEC));
    for (let i = 0; i < k; i++) {
      ctx.checkAbort();
      const startSec = i * MAX_CHUNK_SEC;
      const chunkFile = path.join(ctx.dubDir, `chunk_${pad(i)}.mp3`);
      report(ctx, "transcribe", (i / k) * 100, `Cutting audio chunk ${i + 1}/${k}…`);
      await runFfmpeg(
        ctx.ffmpegPath,
        ["-ss", String(startSec), "-i", concatWav, "-t", String(MAX_CHUNK_SEC),
         "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "16k", chunkFile],
        `Cutting audio chunk ${i + 1}/${k}`,
      );
      ctx.tempFiles.push(chunkFile);
      const res = await deps.groqTranscribe({
        apiKey: ctx.apiKey,
        model: ctx.whisperModel,
        filePath: chunkFile,
        language: ctx.sourceLanguage,
        onProgress: (p) => {
          const inner = (p && Number(p.progress)) ? Math.max(0, Math.min(100, Number(p.progress))) / 100 : 0;
          report(
            ctx, "transcribe",
            ((i + inner) / k) * 100,
            `[chunk ${i + 1}/${k}] ${(p && p.status) || "Transcribing with Groq…"}`,
          );
        },
        abortRef: ctx.childAbortRef(),
      });
      absorb(res, startSec);
      try { fs.unlinkSync(chunkFile); } catch (_) { /* best effort */ }
    }
  }

  let rawUtts;
  if (words.length > 0) {
    rawUtts = groupWordsToUtterances(words);
  } else if (segChunks.length > 0) {
    // Segment-level fallback: chunk per utterance, pad unknown ends.
    rawUtts = segChunks.map((c) => ({
      startMs: Math.round(((c.timestamp && c.timestamp[0]) || 0) * 1000),
      endMs: Math.round((((c.timestamp && c.timestamp[1]) != null ? c.timestamp[1] : (c.timestamp && c.timestamp[0]) || 0) + 0.4) * 1000),
      text: c.text,
    }));
  } else {
    throw new Error("No speech was detected in the source audio — dubbing needs a track with spoken dialogue");
  }

  const utts = rawUtts
    .map((u) => ({
      startMs: concatMsToTimelineMs(timelineMap, u.startMs),
      endMs: concatMsToTimelineMs(timelineMap, u.endMs),
      text: String(u.text || "").replace(/\s+/g, " ").trim(),
    }))
    .filter((u) => u.text && u.endMs > u.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  if (utts.length === 0) {
    throw new Error("No speech was detected in the source audio — dubbing needs a track with spoken dialogue");
  }

  report(ctx, "transcribe", 100, `Transcribed ${utts.length} segments${language ? ` (detected ${language})` : ""}`);
  return { utts, language };
}

// ---- phase 3: speakers -----------------------------------------------------

/** v1.20 single-voice variant: ONE voice reads the whole dub. Speaker
 *  detection is skipped entirely — no LLM call, no heuristic — every
 *  utterance is speaker 0 (speakerCount = 1). Voice resolution keeps the
 *  exact machinery of detectSpeakers (pickVoicePair + the speakerVoices
 *  override map; runDub pre-fills ids 0-3 with the chosen single voice),
 *  so an EMPTY singleVoice falls back to the locale pair's default
 *  female via pickVoiceForSpeaker's even-id rule. */
async function singleVoiceSpeakers(ctx, trans) {
  report(ctx, "speakers", 5, "Single voice mode — skipping speaker detection");

  // Same locale-pair resolution as detectSpeakers (kept duplicated so the
  // multi-speaker path stays byte-identical).
  const pairPick = (() => {
    let pairs;
    try {
      pairs = ttsDeps().voicePairsByLocale();
    } catch (err) {
      throw new Error(`Could not load Edge TTS voices: ${err.message}`);
    }
    return pickVoicePair(pairs, ctx.targetLocale, ctx.targetLanguage);
  })();
  if (!pairPick.ok) {
    throw new Error(`No Edge TTS voices available for ${ctx.targetLocale} — cannot dub into this language`);
  }

  const { voice, gender } = pickVoiceForSpeaker(0, pairPick, ctx.speakerVoices);
  report(ctx, "speakers", 100, "Single voice — one narrator for every line");
  return {
    speakerCount: 1,
    voiceList: [{ id: 0, voice, gender }],
    ids: new Array(trans.utts.length).fill(0),
    warnings: [...pairPick.warnings],
  };
}

async function detectSpeakers(ctx, trans) {
  const utts = trans.utts;
  report(ctx, "speakers", 5, utts.length >= 2 ? `Detecting speakers across ${utts.length} segments…` : "One segment — single speaker…");

  let assign = null;
  if (utts.length >= 2) {
    try {
      const res = await deps.groqChat({
        apiKey: ctx.apiKey,
        model: ctx.groqModel,
        messages: [
          { role: "system", content: SPEAKER_SYSTEM },
          { role: "user", content: speakerUserPrompt(utts) },
        ],
        jsonMode: true,
        temperature: 0.2, // classification wants determinism, not creativity
        abortRef: ctx.childAbortRef(),
      });
      const parsed = GC.parseJsonish(res.content);
      const candidate = parseSpeakerAssignment(parsed, utts.length);
      if (candidate.ok) assign = candidate;
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (isCancelMessage(msg)) throw err;
      // fall through to the heuristic
    }
  }

  const warnings = [];
  let labelling;
  if (assign) {
    labelling = { speakerCount: assign.speakerCount, speakers: assign.speakers };
  } else {
    if (utts.length >= 2) warnings.push("Speaker detection fell back to a pause-based heuristic.");
    labelling = heuristicSpeakers(utts);
  }

  // Voice assignment (resolves ./edge-tts lazily — fails early & clearly).
  const pairPick = (() => {
    let pairs;
    try {
      pairs = ttsDeps().voicePairsByLocale();
    } catch (err) {
      throw new Error(`Could not load Edge TTS voices: ${err.message}`);
    }
    return pickVoicePair(pairs, ctx.targetLocale, ctx.targetLanguage);
  })();
  if (!pairPick.ok) {
    throw new Error(`No Edge TTS voices available for ${ctx.targetLocale} — cannot dub into this language`);
  }
  warnings.push(...pairPick.warnings);

  const voiceList = [];
  for (let id = 0; id < labelling.speakerCount; id++) {
    const { voice, gender } = pickVoiceForSpeaker(id, pairPick, ctx.speakerVoices);
    voiceList.push({ id, voice, gender });
  }

  report(ctx, "speakers", 100, `${labelling.speakerCount} speaker${labelling.speakerCount > 1 ? "s" : ""} detected`);
  return {
    speakerCount: labelling.speakerCount,
    voiceList,
    ids: labelling.speakers, // per-utterance speaker id
    warnings,
  };
}

// ---- phase 4: translate ----------------------------------------------------

async function translateSegments(ctx, trans, warnings) {
  const utts = trans.utts;
  const n = utts.length;
  const langName = languageName(ctx.targetLanguage);
  const translations = new Array(n).fill(null);

  const runBatch = async (idxs) => {
    const res = await deps.groqChat({
      apiKey: ctx.apiKey,
      model: ctx.groqModel,
      messages: [
        { role: "system", content: translateSystemPrompt(langName) },
        { role: "user", content: translateUserPrompt(utts, idxs, langName) },
      ],
      jsonMode: true,
      temperature: 0.3,
      abortRef: ctx.childAbortRef(),
    });
    const parsed = GC.parseJsonish(res.content);
    if (!parsed || !Array.isArray(parsed.segments)) return 0;
    let applied = 0;
    for (const e of parsed.segments) {
      if (!e || typeof e !== "object") continue;
      if (Number.isInteger(e.i) && e.i >= 0 && e.i < n &&
          typeof e.text === "string" && e.text.trim() &&
          translations[e.i] == null) {
        translations[e.i] = e.text.replace(/\s+/g, " ").trim();
        applied++;
      }
    }
    return applied;
  };

  const batches = splitBatches(n, TRANSLATE_BATCH_SIZE);
  for (let b = 0; b < batches.length; b++) {
    ctx.checkAbort();
    const idxs = batches[b];
    report(ctx, "translate", (translations.filter(Boolean).length / n) * 100, `Translating segment ${idxs[0] + 1}/${n}…`);
    try {
      await runBatch(idxs);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (isCancelMessage(msg)) throw err;
      // Batch failed even after groqChat's internal retries — it goes to
      // the retry round below.
    }
    report(ctx, "translate", (translations.filter(Boolean).length / n) * 100, `Translated ${translations.filter(Boolean).length}/${n} segments`);
  }

  // One retry round for whatever came back missing (batch of missing only).
  let missing = [];
  for (let i = 0; i < n; i++) if (translations[i] == null) missing.push(i);
  if (missing.length > 0) {
    report(ctx, "translate", (translations.filter(Boolean).length / n) * 100, `Retrying ${missing.length} missing translation(s)…`);
    const missingBatches = splitBatches(missing.length, TRANSLATE_BATCH_SIZE)
      .map((batch) => batch.map((j) => missing[j]));
    try {
      for (const idxs of missingBatches) {
        ctx.checkAbort();
        await runBatch(idxs);
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (isCancelMessage(msg)) throw err;
      // final fallback below
    }
  }

  missing = [];
  for (let i = 0; i < n; i++) if (translations[i] == null) missing.push(i);
  for (const i of missing) {
    translations[i] = utts[i].text;
    warnings.push(`Segment ${i + 1}: translation unavailable — the original text will be spoken.`);
  }
  report(ctx, "translate", 100, `Translated ${n - missing.length}/${n} segments`);
  return translations;
}

// ---- phase 5: synthesize ---------------------------------------------------

async function synthesizeVoices(ctx, trans, translations, speakerInfo) {
  const utts = trans.utts;
  const n = utts.length;
  const synth = ttsDeps().ttsSynthesize;
  const voiceOf = (id) => {
    const v = speakerInfo.voiceList.find((s) => s.id === id);
    return v ? v.voice : speakerInfo.voiceList[0].voice;
  };

  const results = new Array(n);
  let nextIdx = 0;
  let done = 0;

  const worker = async () => {
    for (;;) {
      const i = nextIdx++;
      if (i >= n) return;
      ctx.checkAbort();
      const outFile = path.join(ctx.dubDir, `dub_${pad(i)}.mp3`);
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) { // one retry for transient TTS hiccups
        if (attempt > 0) {
          await sleep(1000);
          ctx.checkAbort();
        }
        try {
          await synth({
            text: translations[i],
            voice: voiceOf(speakerInfo.ids[i]),
            ratePct: ctx.ttsRatePct,
            pitchHz: ctx.ttsPitchHz,
            volumePct: ctx.ttsVolumePct,
            outFile,
            // 57-b's synthesize accepts an optional abortRef — pass a child
            // ref so a dub cancel kills the in-flight WSS immediately.
            abortRef: ctx.childAbortRef(),
          });
          if (!fileNonEmpty(outFile)) {
            throw new Error("Edge TTS produced no audio file");
          }
          lastErr = null;
          break;
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          if (isCancelMessage(msg)) throw err;
          lastErr = err;
        }
      }
      if (lastErr) {
        throw new Error(`Edge TTS failed for segment ${i + 1} of ${n}: ${lastErr.message}`);
      }
      ctx.tempFiles.push(outFile);
      const durMs = await probeDurationMs(ctx.ffprobePath, outFile);
      if (durMs <= 0) {
        throw new Error(`Segment ${i + 1} TTS audio is empty (0s) — try a different voice`);
      }
      results[i] = { mp3Path: outFile, durMs };
      done++;
      report(ctx, "synthesize", (done / n) * 100, `Synthesized voice ${done}/${n}…`);
    }
  };

  const workerCount = Math.min(TTS_CONCURRENCY, Math.max(1, n));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// ---- phase 6: fit ----------------------------------------------------------

async function fitSegments(ctx, trans, translations, synth, speakerInfo, warnings) {
  const utts = trans.utts;
  const n = utts.length;
  const out = [];
  let prevSpeechEndMs = 0;

  for (let i = 0; i < n; i++) {
    ctx.checkAbort();
    const u = utts[i];
    const windowMs = Math.max(MIN_WINDOW_MS, u.endMs - u.startMs);
    const ttsDurMs = synth[i].durMs;
    const leadInMs = Math.max(0, u.startMs - prevSpeechEndMs); // gap before, never crossing the previous dub's end
    const nextStartMs = i + 1 < n ? utts[i + 1].startMs : null;
    const gapAfterMs = nextStartMs != null ? Math.max(0, nextStartMs - u.endMs) : 0;
    const spillAvailMs = gapAfterMs + SPILL_CAP_MS; // following gap + up to 300ms into next speech

    const plan = computeFitPlan({
      ttsDurMs,
      windowMs,
      leadInMs,
      spillMs: spillAvailMs,
      fitSpeedMax: ctx.fitSpeedMax,
    });

    let startMs = u.startMs - plan.startShiftMs;
    if (startMs < prevSpeechEndMs) startMs = prevSpeechEndMs; // rounding guard
    if (startMs < 0) startMs = 0;

    const wavPath = path.join(ctx.dubDir, `dub_${pad(i)}.wav`);
    const args = plan.speed > 1.001
      ? ["-i", synth[i].mp3Path, "-filter:a", `atempo=${plan.speed.toFixed(3)}`, "-ar", "48000", "-ac", "2", wavPath]
      : ["-i", synth[i].mp3Path, "-ar", "48000", "-ac", "2", wavPath];
    report(ctx, "fit", (i / n) * 100, `Fitting timing ${i + 1}/${n}${plan.speed > 1.001 ? ` (${plan.speed.toFixed(2)}× speed)` : ""}…`);
    await runFfmpeg(ctx.ffmpegPath, args, `Fitting segment ${i + 1}`);
    if (!fileNonEmpty(wavPath)) {
      throw new Error(`Segment ${i + 1} WAV conversion failed`);
    }
    const finalDurMs = await probeDurationMs(ctx.ffprobePath, wavPath);
    if (plan.overrunMs > 0) {
      warnings.push(`Segment ${i + 1}: the dub is ~${plan.overrunMs}ms longer than the available window — it will slightly overlap the next line.`);
    }

    const speaker = Number.isInteger(speakerInfo.ids[i]) ? speakerInfo.ids[i] : 0;
    out.push({
      startMs: Math.round(startMs),
      endMs: u.endMs,
      speaker,
      sourceText: u.text,
      translatedText: translations[i],
      wavPath,
      ttsDurMs: finalDurMs,
      speedApplied: plan.speed,
    });
    prevSpeechEndMs = Math.max(prevSpeechEndMs, Math.round(startMs) + finalDurMs);
  }

  report(ctx, "fit", 100, `Fitted ${n} segments to the timeline`);
  return out;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/** Remove a dub temp dir. Safe by construction: if handed a directory that
 *  is not itself a framefuse-dub-* dir (e.g. the whole tempDir by mistake),
 *  only its framefuse-dub-* CHILDREN are removed. */
function cleanupDubTemp(dir) {
  if (typeof dir !== "string" || !dir) return false;
  try {
    if (path.basename(dir).startsWith(DUB_DIR_PREFIX)) {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    }
    let removed = false;
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(DUB_DIR_PREFIX)) {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
        removed = true;
      }
    }
    return removed;
  } catch (_) {
    return false;
  }
}

/** Immediate + delayed removal (the delayed pass catches files that an
 *  in-flight ffmpeg/tts call was still writing when the abort landed). */
function removeDubDir(dir) {
  const once = () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  };
  once();
  const t = setTimeout(once, 2000);
  if (typeof t.unref === "function") t.unref();
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // The orchestrator
  runDub,
  cleanupDubTemp,
  // Language helpers
  LANG_NAMES,
  languageName,
  // Pure pipeline pieces (unit-tested)
  groupWordsToUtterances,
  parseSpeakerAssignment,
  heuristicSpeakers,
  splitBatches,
  computeFitPlan,
  buildTimelineMap,
  concatMsToTimelineMs,
  pickVoicePair,
  pickVoiceForSpeaker,
  // Injectable seams for tests
  _setDepsForTesting,
  // Convenience re-exports for callers (main.js)
  GROQ_TEXT_MODELS: GC.GROQ_TEXT_MODELS,
  DEFAULT_TEXT_MODEL: GC.DEFAULT_TEXT_MODEL,
  normalizeTextModel: GC.normalizeTextModel,
};
