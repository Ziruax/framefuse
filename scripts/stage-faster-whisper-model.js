// scripts/stage-faster-whisper-model.js — build-time CTranslate2 model download.
//
// v1.7 — fixes the "faster-whisper is very slow / not working, user waits a
// lot" escalation. ROOT CAUSE (verified against the user's own fast app):
// the sidecar's WhisperModel("tiny") DOWNLOADED the CTranslate2 tiny model
// from HuggingFace on first use (into userData/faster-whisper-models) —
// on a slow/blocked connection that download stalls the load phase until
// the v7 watchdog kills the sidecar (300 s) and the app falls back to the
// SLOWER onnxruntime engine. The user's separate Streamlit app was fast
// only because its model already sat in ~/.cache/huggingface.
//
// FIX: stage Systran/faster-whisper-tiny (the exact CTranslate2 file set
// faster-whisper loads) INTO the packaged runtime:
//
//   faster-whisper-runtime/models/faster-whisper-tiny/
//     config.json
//     model.bin                       (~75 MB — int8-ready CT2 weights)
//     preprocessor_config.json
//     tokenizer.json
//     vocabulary.json
//
// electron/main.js passes this DIRECTORY as --model (WhisperModel accepts a
// local dir), so model load is a local disk read: no first-run download, no
// HF connectivity, no watchdog kills. Config parity with the user's fast
// app is already in transcriber.py (device=cpu, compute_type=int8,
// beam_size=5, word_timestamps=True, cpu_threads=all cores).
//
// Hosts: huggingface.co first, hf-mirror.com fallback (same layout).
// Idempotent — skips files already staged with a sane size
// (FW_MODEL_FETCH_FORCE=1 re-downloads).
//
// stage-faster-whisper.js preserves faster-whisper-runtime/models/ across
// its wipe, so this runs ONCE per machine (and re-runs cheap).
// Run by `npm run electron:build` (after stage-faster-whisper).

const fs = require("fs");
const path = require("path");
const https = require("https");

const OUT_ROOT = path.join(__dirname, "..", "faster-whisper-runtime", "models");
const MODEL_DIR = path.join(OUT_ROOT, "faster-whisper-tiny");

const HOSTS = ["https://huggingface.co/", "https://hf-mirror.com/"];
const REPO = "Systran/faster-whisper-tiny";

// [relative path, minimum sane bytes] — the ACTUAL Systran/faster-whisper-tiny
// repo contents (verified via the HF API): config.json, model.bin,
// tokenizer.json, vocabulary.txt. No preprocessor_config.json ships with the
// tiny repo — WhisperModel(dir) needs exactly these four.
const FILES = [
  ["config.json", 200],
  ["model.bin", 60 * 1024 * 1024],
  ["tokenizer.json", 1024 * 1024],
  ["vocabulary.txt", 50 * 1024],
];

function log(msg) {
  console.log(`[stage-faster-whisper-model] ${msg}`);
}

function downloadTo(url, destPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const file = fs.createWriteStream(destPath + ".part");
    const get = (u, redirectsLeft = 8) =>
      https
        .get(u, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (redirectsLeft <= 0) { reject(new Error("Too many redirects")); return; }
            res.resume();
            get(new URL(res.headers.location, u).toString(), redirectsLeft - 1);
            return;
          }
          if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} for ${u}`)); return; }
          res.pipe(file);
          file.on("finish", () => {
            file.close(() => {
              try {
                fs.renameSync(destPath + ".part", destPath);
                resolve(fs.statSync(destPath).size);
              } catch (e) {
                reject(e);
              }
            });
          });
        })
        .on("error", reject);
    get(url);
  });
}

async function fetchFile(rel, minBytes) {
  const dest = path.join(MODEL_DIR, rel);
  if (process.env.FW_MODEL_FETCH_FORCE !== "1") {
    try {
      if (fs.existsSync(dest) && fs.statSync(dest).size >= minBytes) {
        return { skipped: true, size: fs.statSync(dest).size };
      }
    } catch (_) { /* re-download */ }
  }
  let lastErr = null;
  for (const host of HOSTS) {
    const url = `${host}${REPO}/resolve/main/${rel}`;
    try {
      const size = await downloadTo(url, dest);
      if (size < minBytes) {
        try { fs.unlinkSync(dest); } catch (_) {}
        throw new Error(`size ${size} < ${minBytes} (truncated?)`);
      }
      return { skipped: false, size };
    } catch (err) {
      lastErr = err;
      log(`${rel} failed via ${host}: ${err.message}`);
    }
  }
  throw new Error(`could not download ${rel}: ${lastErr && lastErr.message}`);
}

function dirSize(p) {
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, e.name);
    total += e.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

async function main() {
  log(`staging ${REPO} (CTranslate2 tiny, ~78 MB) → ${path.relative(process.cwd(), MODEL_DIR)}`);
  let downloaded = 0;
  let skipped = 0;
  for (const [rel, minBytes] of FILES) {
    const r = await fetchFile(rel, minBytes);
    if (r.skipped) {
      skipped++;
      log(`  ${rel} — already staged (${Math.round(r.size / 1048576)} MB)`);
    } else {
      downloaded++;
      log(`  ${rel} — downloaded ${Math.round(r.size / 1048576)} MB`);
    }
  }
  const total = dirSize(MODEL_DIR);
  log(`done: ${downloaded} downloaded, ${skipped} reused — model dir is ${Math.round(total / 1048576)} MB`);
  // Integrity gate — every file faster-whisper needs must be present.
  for (const [rel] of FILES) {
    if (!fs.existsSync(path.join(MODEL_DIR, rel))) {
      throw new Error(`missing staged file ${rel}`);
    }
  }
}

main().catch((err) => {
  console.error(`[stage-faster-whisper-model] FAILED: ${err.message}`);
  console.error("[stage-faster-whisper-model] The packaged app will fall back to downloading the model on first use (requires internet).");
  process.exit(1);
});
