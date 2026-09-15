// Cross-platform post-build step: copies @xenova/transformers' WASM
// files (ONNX runtime web) from node_modules into the Next.js export
// directory so the Whisper caption feature works in the Electron
// desktop app and the static export.
//
// Without this, the dynamic `import("@xenova/transformers")` succeeds
// (the JS is bundled by webpack) but at runtime the WASM binaries
// aren't found, and Whisper transcription fails with a cryptic
// "Cannot find module" or "wasm fetch failed" error.
//
// Copies:
//   node_modules/@xenova/transformers/dist/*.wasm
//     → out/_next/static/chunks/
//     → out/                       (root, for direct file:// loading)
//
// Also copies the .mjs worker files used by the threaded WASM variants.

const fs = require("fs");
const path = require("path");

const SRC_DIR = path.join(
  process.cwd(),
  "node_modules",
  "@xenova",
  "transformers",
  "dist",
);
const OUT_DIR = path.join(process.cwd(), "out");
const CHUNKS_DIR = path.join(OUT_DIR, "_next", "static", "chunks");

if (!fs.existsSync(SRC_DIR)) {
  console.log(`[copy-wasm] Skip — ${SRC_DIR} not found (Whisper optional)`);
  process.exit(0);
}
if (!fs.existsSync(OUT_DIR)) {
  console.log(`[copy-wasm] Skip — ${OUT_DIR} not found (build didn't run?)`);
  process.exit(0);
}

// Make sure the chunks dir exists (Next.js normally creates it).
fs.mkdirSync(CHUNKS_DIR, { recursive: true });

// Copy .wasm and .mjs (worker) files from transformers/dist.
let copied = 0;
for (const file of fs.readdirSync(SRC_DIR)) {
  if (!/\.(wasm|mjs)$/.test(file)) continue;
  const src = path.join(SRC_DIR, file);
  const stat = fs.statSync(src);
  if (!stat.isFile()) continue;
  // Copy to chunks dir (where transformers.js's relative fetch expects them).
  const dst1 = path.join(CHUNKS_DIR, file);
  fs.copyFileSync(src, dst1);
  // Also copy to out/ root as a fallback for file:// loading in Electron.
  const dst2 = path.join(OUT_DIR, file);
  fs.copyFileSync(src, dst2);
  copied++;
  console.log(`[copy-wasm] ${file} → ${path.relative(process.cwd(), dst1)}`);
}

console.log(`[copy-wasm] Done. ${copied} file(s) copied.`);
