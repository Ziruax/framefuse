// scripts/stage-whisper-service.js — build the packaged Whisper service.
//
// Creates whisper-service/ — a SELF-CONTAINED folder the packaged app loads
// via utilityProcess.fork(<resources>/whisper-service/whisper-child.js):
//
//   whisper-service/
//     whisper-child.js           utilityProcess entry (host wiring)
//     whisper-core.js            pipeline build + transcribe (Node module)
//     node_modules/
//       @xenova/transformers/    ESM src (the "type":"module" package)
//       onnxruntime-node/        native CPU inference (win32 + linux bindings)
//       onnxruntime-web/         node entry only (import-chain requirement)
//       @huggingface/jinja/      template engine (tokenizer chat utils)
//       sharp/                   STUB — image processing is never used for
//                                 Whisper; stubbing satisfies transformers'
//         `import sharp from 'sharp'` without shipping ~10 MB of
//         cross-platform binaries
//
// Everything lives OUTSIDE app.asar on purpose: ESM imports cannot resolve
// from inside asar archives, and native .node bindings must not be packed
// (asarUnpack quirks with ESM loaders make the extraResources route the
// reliable one). electron-builder picks the folder up via the
// extraResources entry in package.json ("whisper-service" → "whisper-service").
//
// Run by `npm run electron:build` before electron-builder. Idempotent —
// wipes and rebuilds the folder each run.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const NM = path.join(ROOT, "node_modules");
const OUT = path.join(ROOT, "whisper-service");

function die(msg) {
  console.error(`[stage-whisper-service] ${msg}`);
  process.exit(1);
}

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

/** Recursive copy with an include/exclude filter per relative path. */
function copyDir(src, dest, filter) {
  mkdirp(dest);
  const walk = (s, d) => {
    for (const entry of fs.readdirSync(s, { withFileTypes: true })) {
      const rel = path.relative(src, path.join(s, entry.name));
      if (filter && !filter(rel, entry.isDirectory())) continue;
      const from = path.join(s, entry.name);
      const to = path.join(d, entry.name);
      if (entry.isDirectory()) {
        mkdirp(to);
        walk(from, to);
      } else {
        fs.copyFileSync(from, to);
      }
    }
  };
  walk(src, dest);
}

function copyFile(src, dest) {
  mkdirp(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

// ---------------------------------------------------------------------------
// 1. Clean + entry files.
// ---------------------------------------------------------------------------
rmrf(OUT);
mkdirp(path.join(OUT, "node_modules"));

for (const f of ["whisper-child.js", "whisper-core.js"]) {
  const src = path.join(ROOT, "electron", f);
  if (!fs.existsSync(src)) die(`missing ${src} (run from the repo root)`);
  copyFile(src, path.join(OUT, f));
}

// ---------------------------------------------------------------------------
// 2. @xenova/transformers — ESM src only (the "dist" browser bundles are not
//    used by the Node import; wasm files already ship via copy-wasm.js).
// ---------------------------------------------------------------------------
const TJS = path.join(NM, "@xenova", "transformers");
if (!fs.existsSync(path.join(TJS, "src", "transformers.js"))) {
  die("@xenova/transformers not installed — run bun install first");
}
copyDir(TJS, path.join(OUT, "node_modules", "@xenova", "transformers"), (rel) => {
  if (rel === "package.json" || rel === "LICENSE") return true;
  return rel.startsWith("src" + path.sep) || rel === "src";
});

// ---------------------------------------------------------------------------
// 3. onnxruntime-node — package metadata + dist/lib + win32 & linux bindings
//    (the platforms this pipeline targets; darwin/arm omitted for size).
// ---------------------------------------------------------------------------
const ORT = path.join(NM, "onnxruntime-node");
if (!fs.existsSync(path.join(ORT, "package.json"))) {
  die("onnxruntime-node not installed — run bun install first");
}
copyDir(ORT, path.join(OUT, "node_modules", "onnxruntime-node"), (rel, isDir) => {
  if (rel === "package.json" || rel === "README.md") return true;
  const p = rel.split(path.sep).join("/");
  // Files: dist/**, lib/**, bin/napi-v3/{win32,linux}/**.
  // Dirs: allow every prefix that can contain an allowed file (the walk
  // filters directory entries BEFORE recursing into them).
  const prefixes = ["dist/", "lib/", "bin/napi-v3/win32/", "bin/napi-v3/linux/"];
  const dirs = ["dist", "lib", "bin", "bin/napi-v3", "bin/napi-v3/win32", "bin/napi-v3/linux"];
  if (isDir) return dirs.includes(p) || prefixes.some((x) => p.startsWith(x));
  return prefixes.some((x) => p.startsWith(x));
});

// ---------------------------------------------------------------------------
// 3b. onnxruntime-common — REQUIRED by onnxruntime-node, and CRITICALLY the
//     1.14.x line: its Tensor stores data/dims/type as OWN properties, which
//     transformers 2.17's `Object.assign(this, new ONNXTensor(...))` wrapper
//     depends on. The 1.17.x line moved `data` to a prototype getter →
//     `this.data === undefined` → "Cannot use 'in' operator to search for
//     'subarray' in undefined" (caught by the staging smoke). onnxruntime-node
//     is therefore PINNED at 1.14.0 in package.json.
// ---------------------------------------------------------------------------
const ORTC = path.join(NM, "onnxruntime-common");
if (!fs.existsSync(path.join(ORTC, "package.json"))) {
  die("onnxruntime-common not installed — run bun install first");
}
copyDir(ORTC, path.join(OUT, "node_modules", "onnxruntime-common"), (rel, isDir) => {
  if (rel === "package.json" || rel === "README.md") return true;
  const p = rel.split(path.sep).join("/");
  if (isDir) return p === "dist" || p === "lib" || p.startsWith("dist/") || p.startsWith("lib/");
  return p.startsWith("dist/") || p.startsWith("lib/");
});

// ---------------------------------------------------------------------------
// 4. onnxruntime-web — STUB. transformers' backends/onnx.js imports BOTH
//    runtimes unconditionally, but the NODE branch only ever uses
//    ONNX_NODE (ONNX_WEB is dead code there). Executing the REAL web bundle
//    inside the staged tree resolves onnxruntime-common from the repo root
//    (1.17.x, thanks to onnxruntime-node) instead of the nested 1.14 copy —
//    a hard "not a valid backend" TypeError (caught by the staging smoke).
//    A inert stub keeps the import resolvable with zero execution.
// ---------------------------------------------------------------------------
const ORTW_OUT = path.join(OUT, "node_modules", "onnxruntime-web");
mkdirp(ORTW_OUT);
fs.writeFileSync(
  path.join(ORTW_OUT, "package.json"),
  JSON.stringify(
    {
      name: "onnxruntime-web",
      version: "0.0.0-stub",
      description: "STUB — the Node branch of transformers.js never calls the web runtime",
      main: "index.js",
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(ORTW_OUT, "index.js"),
  `"use strict";
// STUB (staged by scripts/stage-whisper-service.js). transformers.js imports
// onnxruntime-web at module load in EVERY environment; in Node the selected
// backend is onnxruntime-node and this module is never invoked. Exporting an
// inert env-shaped object keeps any incidental property reads safe.
module.exports = { env: { wasm: {} } };
`,
);

// ---------------------------------------------------------------------------
// 5. @huggingface/jinja — small pure-JS template engine.
// ---------------------------------------------------------------------------
const JINJA = path.join(NM, "@huggingface", "jinja");
if (fs.existsSync(path.join(JINJA, "dist"))) {
  copyDir(JINJA, path.join(OUT, "node_modules", "@huggingface", "jinja"), (rel) => {
    if (rel === "package.json" || rel === "LICENSE") return true;
    return rel.startsWith("dist" + path.sep) || rel === "dist";
  });
}

// ---------------------------------------------------------------------------
// 6. sharp STUB — transformers' `import sharp from 'sharp'` must resolve, but
//    Whisper never processes images. A 2-line stub replaces ~10 MB of
//    platform binaries (calling an image API throws a clear error).
// ---------------------------------------------------------------------------
const SHARP_OUT = path.join(OUT, "node_modules", "sharp");
mkdirp(SHARP_OUT);
fs.writeFileSync(
  path.join(SHARP_OUT, "package.json"),
  JSON.stringify(
    {
      name: "sharp",
      version: "0.0.0-stub",
      description: "STUB — FrameFuse whisper service never uses image processing",
      main: "index.js",
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(SHARP_OUT, "index.js"),
  `"use strict";
// STUB (staged by scripts/stage-whisper-service.js) — transformers.js imports
// sharp at module load; the Whisper audio pipeline never touches it.
module.exports = new Proxy({}, {
  get() { throw new Error("sharp is stubbed out in the FrameFuse Whisper service"); },
});
`,
);

// ---------------------------------------------------------------------------
// 7. Report.
// ---------------------------------------------------------------------------
function dirSize(p) {
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, e.name);
    total += e.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}
const mb = (dirSize(OUT) / 1024 / 1024).toFixed(1);
console.log(`[stage-whisper-service] staged ${OUT} (${mb} MB)`);
console.log("[stage-whisper-service] contents:");
for (const top of fs.readdirSync(OUT)) {
  console.log(`  ${top}`);
}
