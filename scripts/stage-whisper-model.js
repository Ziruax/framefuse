// scripts/stage-whisper-model.js — build-time Whisper-tiny model download.
//
// Downloads the Xenova/whisper-tiny QUANTIZED ONNX model (the exact file set
// transformers.js fetches at runtime — measured ~42 MB) into
//   whisper-service/models/Xenova/whisper-tiny/
// so the PACKAGED app can build its first transcription pipeline fully
// OFFLINE from <resourcesPath>/whisper-service/models (whisper-core's
// local-first path). No first-run download, no firewall prompts, no mirror
// retries — captions work out of the installer.
//
// Layout mirrors transformers.js env.localModelPath expectations:
//   Xenova/whisper-tiny/config.json
//   Xenova/whisper-tiny/generation_config.json
//   Xenova/whisper-tiny/preprocessor_config.json
//   Xenova/whisper-tiny/tokenizer.json
//   Xenova/whisper-tiny/tokenizer_config.json
//   Xenova/whisper-tiny/onnx/encoder_model_quantized.onnx       (~10.1 MB)
//   Xenova/whisper-tiny/onnx/decoder_model_merged_quantized.onnx (~30.7 MB)
//
// Hosts: huggingface.co first, hf-mirror.com fallback (same layout — the
// same mirror logic whisper-core.js uses at runtime).
//
// Idempotent — skips files already staged with a sane size
// (WHISPER_MODEL_FETCH_FORCE=1 re-downloads).
//
// Run by `npm run electron:build` (after stage-whisper-service, which wipes
// and rebuilds the whisper-service folder this script fills in).

const fs = require("fs");
const path = require("path");
const https = require("https");

const OUT_ROOT = path.join(__dirname, "..", "whisper-service", "models");
const MODEL_DIR = path.join(OUT_ROOT, "Xenova", "whisper-tiny");

const HOSTS = ["https://huggingface.co/", "https://hf-mirror.com/"];

// [relative path, minimum sane bytes]
const FILES = [
  ["config.json", 200],
  ["generation_config.json", 50],
  ["preprocessor_config.json", 200],
  ["tokenizer.json", 1024 * 1024],
  ["tokenizer_config.json", 50],
  ["onnx/encoder_model_quantized.onnx", 8 * 1024 * 1024],
  ["onnx/decoder_model_merged_quantized.onnx", 25 * 1024 * 1024],
];

function log(msg) {
  console.log(`[stage-whisper-model] ${msg}`);
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
  if (process.env.WHISPER_MODEL_FETCH_FORCE !== "1") {
    try {
      if (fs.existsSync(dest) && fs.statSync(dest).size >= minBytes) {
        return { skipped: true, size: fs.statSync(dest).size };
      }
    } catch (_) { /* re-download */ }
  }
  const relSlash = rel.split(path.sep).join("/");
  let lastErr = null;
  for (const host of HOSTS) {
    const url = `${host}Xenova/whisper-tiny/resolve/main/${relSlash}`;
    try {
      const size = await downloadTo(url, dest);
      if (size < minBytes) {
        try { fs.unlinkSync(dest); } catch (_) {}
        throw new Error(`size ${size} < ${minBytes} (truncated?)`);
      }
      return { skipped: false, size };
    } catch (err) {
      lastErr = err;
      log(`${relSlash} failed via ${host}: ${err.message}`);
    }
  }
  throw new Error(`could not download ${relSlash}: ${lastErr && lastErr.message}`);
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
  log(`staging Xenova/whisper-tiny (quantized, ~42 MB) → ${path.relative(process.cwd(), MODEL_DIR)}`);
  let downloaded = 0;
  let skipped = 0;
  let totalNew = 0;
  for (const [rel, minBytes] of FILES) {
    const r = await fetchFile(rel, minBytes);
    if (r.skipped) {
      skipped++;
      log(`  ${rel} — already staged (${Math.round(r.size / 1048576)} MB)`);
    } else {
      downloaded++;
      totalNew += r.size;
      log(`  ${rel} — downloaded ${Math.round(r.size / 1048576)} MB`);
    }
  }
  const total = dirSize(MODEL_DIR);
  log(`done: ${downloaded} downloaded, ${skipped} reused — model dir is ${Math.round(total / 1048576)} MB`);
  // Integrity gate — the same heuristic main.js whisperModelReady applies to
  // the runtime cache (encoder + merged decoder + configs + tokenizer).
  const names = new Set(
    FILES.map(([rel]) => rel.split(path.sep).join("/")),
  );
  for (const n of names) {
    if (!fs.existsSync(path.join(MODEL_DIR, ...n.split("/")))) {
      throw new Error(`missing staged file ${n}`);
    }
  }
}

main().catch((err) => {
  console.error(`[stage-whisper-model] FAILED: ${err.message}`);
  console.error("[stage-whisper-model] The packaged app will download the model on first use (requires internet).");
  process.exit(1);
});
