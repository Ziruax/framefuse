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
//
// v1.22 DIAGNOSTICS (the "why is the engine always falling back" fix):
// candidate paths are recorded, the FIRST error from EVERY attempt is kept,
// and `loadDiagnostics()` reports exactly what was tried + why each failed —
// the Settings → Engine card and the engine:selftest IPC surface this so a
// silent CLI fallback can never be a mystery again.

const fs = require("fs");
const path = require("path");

const BINARY = `framefuse-engine.${process.platform}-${process.arch}.node`;

/** Extra safety net when process.resourcesPath is unavailable: derive the
 * resources dir from the executable (packaged: <resources>/FrameFuse.exe;
 * dev: node_modules/electron/dist/electron). */
function resourcesDirCandidates() {
  const out = [];
  if (process.resourcesPath) out.push(process.resourcesPath);
  try {
    const execDir = path.dirname(process.execPath);
    // packaged Electron: the exe sits directly in <resources>/ ; dev runs
    // from node_modules/electron/dist — both resolve "resources" the same
    // way when it exists, and are skipped otherwise.
    const beside = path.join(execDir, "resources");
    if (fs.existsSync(beside)) out.push(beside);
    const upBeside = path.join(path.dirname(execDir), "resources");
    if (fs.existsSync(upBeside)) out.push(upBeside);
  } catch (_) { /* best effort */ }
  return out;
}

function candidatePaths() {
  const cands = [
    path.join(__dirname, BINARY),
    // asar-adjacent unpacked copy (when the module itself runs from inside
    // app.asar, the binary sits in the .unpacked sibling — require() of a
    // .node from INSIDE an asar archive is impossible, so try the unpacked
    // path FIRST whenever we are packaged).
    path.join(__dirname, "..", "app.asar.unpacked", "rust-engine", BINARY),
    // dev tree fallback: staged next to electron/ by build-rust-engine.js
    path.join(__dirname, "..", "electron", "rust-engine", BINARY),
  ];
  for (const res of resourcesDirCandidates()) {
    cands.push(path.join(res, "app.asar.unpacked", "rust-engine", BINARY));
    // belt & braces: a build whose asarUnpack config was lost still works
    // if the binary rides along via extraResources "rust-engine".
    cands.push(path.join(res, "rust-engine", BINARY));
  }
  // de-dup, keep order
  return [...new Set(cands.filter(Boolean))];
}

let native = null;
let loadError = null;
const attempts = [];
for (const p of candidatePaths()) {
  try {
    if (!fs.existsSync(p)) {
      attempts.push({ path: p, ok: false, error: "not found" });
      continue;
    }
    native = require(p);
    native.__loadedFrom = p;
    attempts.push({ path: p, ok: true });
    break;
  } catch (err) {
    loadError = err;
    attempts.push({
      path: p,
      ok: false,
      error: String((err && err.message) || err).slice(0, 400),
    });
  }
}

if (!native) {
  // Don't throw at require time — the Electron router probes `available()`.
  module.exports = {
    available: () => false,
    loadError: () =>
      loadError
        ? String(loadError.message || loadError)
        : "binary not found: " + BINARY,
    binaryName: BINARY,
    candidatePaths: candidatePaths,
    /** v1.22: the full story for the diagnostics UI. */
    loadDiagnostics: () => ({
      binary: BINARY,
      platform: `${process.platform}-${process.arch}`,
      electron: !!process.versions.electron,
      attempts,
      loadError: loadError ? String(loadError.message || loadError) : "binary not found",
    }),
  };
} else {
  module.exports = {
    // full napi surface (exportVideo, engineVersion, probeFfmpegFamily,
    // cancelExport, …) + loader metadata
    ...native,
    available: () => true,
    loadedFrom: native.__loadedFrom,
    binaryName: BINARY,
    loadDiagnostics: () => ({
      binary: BINARY,
      platform: `${process.platform}-${process.arch}`,
      electron: !!process.versions.electron,
      attempts,
      loadError: null,
    }),
  };
}
