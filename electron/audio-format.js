// electron/audio-format.js — magic-byte audio sniffing + pre-upload validation.
//
// v1.33 (user brief "Part 3: Audio validation"): never trust a file
// extension — a renamed .mp4 is not an MP3, a truncated upload is not
// audio. Every audio consumer (Groq transcription, TTS output checks)
// validates REAL bytes here before work begins.
//
// Groq documents: MP3, MP4, MPEG, MPGA, M4A, OGG, WAV, FLAC, WebM.

const fs = require("fs");

/** Formats Groq's transcription API documents. */
const GROQ_SUPPORTED = [
  "mp3", "mp4", "m4a", "ogg", "wav", "flac", "webm", "mpga",
];

/** Default conservative upload cap (25 MB, Groq free tier). Overridable. */
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Sniff the real container/codec family from the first bytes.
 * Returns a format id ("mp3" | "wav" | "ogg" | "flac" | "mp4" | "webm" |
 * "unknown") — never throws; short/empty buffers → "unknown".
 */
function sniffAudioFormat(buf) {
  if (!buf || buf.length < 4) return "unknown";
  // ID3v2 tag → MP3 family
  if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return "mp3";
  // MPEG audio frame sync (0xFF Ex) — MPGA/MP3 without ID3
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "mp3";
  // RIFF....WAVE
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45
  ) return "wav";
  // OggS
  if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) return "ogg";
  // fLaC
  if (buf[0] === 0x66 && buf[1] === 0x4c && buf[2] === 0x61 && buf[3] === 0x43) return "flac";
  // ISO-BMFF ftyp (mp4/m4a)
  if (buf.length >= 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = buf.slice(8, 12).toString("ascii").toLowerCase();
    if (brand.startsWith("m4a") || brand.startsWith("mp4") || brand.startsWith("iso")) return "mp4";
    return "mp4";
  }
  // EBML (webm/mkv)
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return "webm";
  return "unknown";
}

/** Read the first N bytes of a file (safe on empty/missing files). */
function headBytes(filePath, n) {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const b = Buffer.alloc(Math.max(4, Math.min(n || 64, 4096)));
      const read = fs.readSync(fd, b, 0, b.length, 0);
      return b.slice(0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return Buffer.alloc(0);
  }
}

/** Is this buffer a plausible MP3 stream (ID3 tag or MPEG frame sync)? */
function isMp3Buffer(buf) {
  if (!buf || buf.length < 3) return false;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true; // "ID3"
  return buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
}

/**
 * Validate a file for Groq upload BEFORE any network work.
 * Resolves { ok: true, format, size, ext } or { ok: false, code, message }
 * — codes: TRANSCRIPTION_FILE_MISSING | TRANSCRIPTION_INVALID_FILE
 * (empty/not a file) | TRANSCRIPTION_FORMAT_UNRECOGNIZED |
 * TRANSCRIPTION_FORMAT_UNSUPPORTED | TRANSCRIPTION_FILE_TOO_LARGE.
 * @param {string} filePath
 * @param {{maxBytes?: number, supported?: string[]}} [opts]
 */
function validateAudioFile(filePath, opts) {
  const maxBytes = (opts && opts.maxBytes) || DEFAULT_MAX_BYTES;
  const supported = (opts && opts.supported) || GROQ_SUPPORTED;
  const ext = String(filePath || "").split(".").pop().toLowerCase();
  let st = null;
  try {
    st = fs.statSync(filePath);
  } catch (_) {
    return {
      ok: false,
      code: "TRANSCRIPTION_FILE_MISSING",
      message: `The audio file does not exist: ${filePath}`,
    };
  }
  if (!st.isFile() || st.size === 0) {
    return {
      ok: false,
      code: "TRANSCRIPTION_INVALID_FILE",
      message: `The audio file is empty or not a regular file: ${filePath}`,
    };
  }
  if (st.size > maxBytes) {
    return {
      ok: false,
      code: "TRANSCRIPTION_FILE_TOO_LARGE",
      message:
        `The audio file is ${(st.size / 1048576).toFixed(1)} MB — over the ${(maxBytes / 1048576)
          .toFixed(0)} MB upload limit. The app will normally auto-compress long audio; ` +
        `if you see this, retry or trim the clip.`,
    };
  }
  const head = headBytes(filePath, 64);
  const format = sniffAudioFormat(head);
  if (format === "unknown") {
    return {
      ok: false,
      code: "TRANSCRIPTION_FORMAT_UNRECOGNIZED",
      message:
        `The audio file's real content is not recognized as audio (its bytes do not match ` +
        `any supported container). Renaming a file does not convert it — re-export the audio ` +
        `as MP3, WAV, M4A, OGG, FLAC or WebM. File: ${filePath}`,
    };
  }
  if (!supported.includes(format)) {
    return {
      ok: false,
      code: "TRANSCRIPTION_FORMAT_UNSUPPORTED",
      message:
        `The audio is ${format.toUpperCase()} (${format}), which the transcription service does not ` +
        `accept. Convert it to MP3 or WAV first. File: ${filePath}`,
    };
  }
  return { ok: true, format, size: st.size, ext };
}

module.exports = {
  GROQ_SUPPORTED,
  DEFAULT_MAX_BYTES,
  sniffAudioFormat,
  headBytes,
  isMp3Buffer,
  validateAudioFile,
};
