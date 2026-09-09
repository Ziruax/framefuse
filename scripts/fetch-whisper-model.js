// Pre-build step: downloads the original (non-quantized) Whisper-tiny
// model from HuggingFace and places it in public/whisper-tiny/.
//
// PROBLEM: The model files are too large for GitHub (114MB decoder
// exceeds the 100MB file limit), so they can't be committed directly.
// Without git-lfs, we download them at build time.
//
// This script downloads:
//   - config.json, generation_config.json, preprocessor_config.json
//   - tokenizer.json, tokenizer_config.json, vocab.json, merges.txt,
//     normalizer.json, special_tokens_map.json
//   - onnx/encoder_model.onnx (32MB, original non-quantized)
//   - onnx/decoder_model_merged.onnx (114MB, original non-quantized)
//
// We use the ORIGINAL (non-quantized) versions for maximum quality.
// The quantized versions would be ~40MB total but degrade transcription
// accuracy significantly.
//
// Run automatically before `electron:build` via the npm script. Also
// runnable manually: `node scripts/fetch-whisper-model.js`.

const fs = require("fs");
const path = require("path");
const https = require("https");

const HF_BASE = "https://huggingface.co/Xenova/whisper-tiny/resolve/main";
const DEST_DIR = path.join(process.cwd(), "public", "whisper-tiny");
const ONNX_DIR = path.join(DEST_DIR, "onnx");

const FILES = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "vocab.json",
  "merges.txt",
  "normalizer.json",
  "special_tokens_map.json",
];

const ONNX_FILES = [
  "encoder_model.onnx",          // 32MB
  "decoder_model_merged.onnx",   // 114MB
];

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const get = (u, redirectsLeft = 5) =>
      https
        .get(u, (res) => {
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            if (redirectsLeft <= 0) {
              reject(new Error("Too many redirects"));
              return;
            }
            get(res.headers.location, redirectsLeft - 1);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} for ${u}`));
            return;
          }
          const total = parseInt(res.headers["content-length"] || "0", 10);
          let received = 0;
          res.on("data", (chunk) => {
            received += chunk.length;
            if (total > 0) {
              const pct = Math.round((received / total) * 100);
              process.stdout.write(`\r  ${path.basename(destPath)}: ${pct}% (${Math.round(received / 1024 / 1024)}MB/${Math.round(total / 1024 / 1024)}MB)`);
            }
          });
          res.pipe(file);
          file.on("finish", () => {
            file.close(() => {
              process.stdout.write("\n");
              resolve();
            });
          });
        })
        .on("error", reject);
    get(url);
  });
}

async function main() {
  fs.mkdirSync(ONNX_DIR, { recursive: true });

  console.log("[fetch-whisper-model] Downloading Whisper-tiny (original, non-quantized)...");
  console.log("[fetch-whisper-model] Destination:", DEST_DIR);

  for (const f of FILES) {
    const dest = path.join(DEST_DIR, f);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 100) {
      console.log(`[fetch-whisper-model] Skip ${f} (already exists)`);
      continue;
    }
    console.log(`[fetch-whisper-model] Downloading ${f}...`);
    await downloadFile(`${HF_BASE}/${f}`, dest);
  }

  for (const f of ONNX_FILES) {
    const dest = path.join(ONNX_DIR, f);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 10_000_000) {
      console.log(`[fetch-whisper-model] Skip ${f} (already exists, ${Math.round(fs.statSync(dest).size / 1024 / 1024)}MB)`);
      continue;
    }
    console.log(`[fetch-whisper-model] Downloading ${f}...`);
    await downloadFile(`${HF_BASE}/onnx/${f}`, dest);
    console.log(`[fetch-whisper-model] Done. ${f} (${Math.round(fs.statSync(dest).size / 1024 / 1024)}MB)`);
  }

  console.log("[fetch-whisper-model] All files downloaded. Model is ready for bundling.");
}

main().catch((err) => {
  console.error(`[fetch-whisper-model] FAILED: ${err.message}`);
  process.exit(1);
});
