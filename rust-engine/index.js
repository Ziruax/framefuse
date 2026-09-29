// FrameFuse Rust engine loader (napi-rs pattern).
//
// The cargo build produces a cdylib whose name differs per platform:
//   linux:   target/release/libframefuse_engine.so   -> framefuse-engine.linux-x64.node
//   windows: target/x86_64-pc-windows-msvc/release/framefuse_engine.dll -> framefuse-engine.win32-x64.node
//
// The rename is done by scripts/build-rust-engine.js (local) and by the CI
// workflow (windows runner). This loader resolves the platform binary and
// re-exports its napi surface; every consumer goes through try/catch so a
// missing/broken binary degrades to the FFmpeg-CLI Safe Mode instead of
// crashing the main process.

const fs = require("fs");
const path = require("path");

const BINARY = `framefuse-engine.${process.platform}-${process.arch}.node`;

function candidatePaths() {
  return [
    path.join(__dirname, BINARY),
    // dev tree fallback: staged next to electron/ by build-rust-engine.js
    path.join(__dirname, "..", "electron", "rust-engine", BINARY),
    // packaged (asar-unpacked) layout
    path.join(process.resourcesPath || "", "app.asar.unpacked", "rust-engine", BINARY),
  ].filter(Boolean);
}

let native = null;
let loadError = null;
for (const p of candidatePaths()) {
  try {
    if (!fs.existsSync(p)) continue;
    native = require(p);
    native.__loadedFrom = p;
    break;
  } catch (err) {
    loadError = err;
  }
}

if (!native) {
  // Don't throw at require time — the Electron router probes `available()`.
  module.exports = {
    available: () => false,
    loadError: () => (loadError ? String(loadError.message || loadError) : "binary not found: " + BINARY),
    binaryName: BINARY,
    candidatePaths: candidatePaths,
  };
} else {
  module.exports = {
    // full napi surface (exportVideo, engineVersion, probeFfmpegFamily,
    // cancelExport, …) + loader metadata
    ...native,
    available: () => true,
    loadedFrom: native.__loadedFrom,
    binaryName: BINARY,
  };
}
