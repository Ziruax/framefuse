// scripts/build-gpu-worker.js — bundles the GPU export worker entry into a
// SELF-CONTAINED classic worker script (v1.15.2 GPU-Shift worker migration).
//
//   src/lib/export/gpu-export-worker.ts
//     → public/gpu-worker.js   (the dev server serves it at the document root)
//     → out/gpu-worker.js      (the packaged static export loads it via file://)
//
// WHY a prebuilt single file (and NOT `new Worker(new URL(...))` through
// webpack): the packaged app serves the page over file:// with a RELATIVE
// assetPrefix, and webpack's worker chunk resolution is the documented v5.0
// whisper-worker landmine (chunk URLs duplicating the _next/static prefix
// inside app.asar, importScripts failing, every transcription erroring). One
// iife file with zero runtime imports is immune by construction — and it is
// the SAME file in dev and production, so the dev E2E exercises exactly what
// ships. bun build does no chunk splitting by default and resolves the
// tsconfig "@/" paths, which is why it (the repo's package manager) is the
// bundler here.
//
// DEV FRESHNESS: this file is a build artifact (gitignored). Re-run
//   npm run build:gpu-worker
// after touching anything under src/lib/export/ or its merger imports, or
// the dev server will happily exercise a STALE worker.

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const entry = path.join(root, "src", "lib", "export", "gpu-export-worker.ts");
const publicDir = path.join(root, "public");
const outFile = path.join(publicDir, "gpu-worker.js");
const outDir = path.join(root, "out");

if (!fs.existsSync(entry)) {
  console.error(`build-gpu-worker: entry not found: ${entry}`);
  process.exit(1);
}
fs.mkdirSync(publicDir, { recursive: true });

const args = [
  "build",
  entry,
  "--target=browser",
  "--format=iife",
  `--outfile=${outFile}`,
  "--minify",
];
console.log(`build-gpu-worker: bun ${args.join(" ")}`);
const res = spawnSync("bun", args, {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (res.error) {
  console.error(`build-gpu-worker: bun could not be executed (${res.error.message}) — bun is required on PATH`);
  process.exit(1);
}
if (res.status !== 0 && res.status !== null) {
  process.exit(res.status);
}
if (!fs.existsSync(outFile)) {
  console.error("build-gpu-worker: bun reported success but the output file is missing");
  process.exit(1);
}

const size = fs.statSync(outFile).size;

// The static export must also carry the worker next to out/index.html (next
// build copies public/ BEFORE this step runs, so copy explicitly; when out/
// does not exist yet — dev-only invocation — skip silently).
if (fs.existsSync(outDir)) {
  fs.copyFileSync(outFile, path.join(outDir, "gpu-worker.js"));
  console.log("build-gpu-worker: copied → out/gpu-worker.js");
}

console.log(
  `build-gpu-worker: ${path.relative(root, outFile)} (${(size / 1024).toFixed(1)} KB, self-contained classic worker)`,
);
