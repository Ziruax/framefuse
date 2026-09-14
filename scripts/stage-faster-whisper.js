// scripts/stage-faster-whisper.js — build the packaged faster-whisper runtime.
//
// Creates faster-whisper-runtime/ — a SELF-CONTAINED Windows Python sidecar
// the app spawns for transcription (user request: replace the slow
// onnxruntime whisper with faster-whisper, bundled into the installer):
//
//   faster-whisper-runtime/
//     transcriber.py                    sidecar entry (from electron/)
//     python/                           Windows embeddable CPython 3.11
//       python.exe, python311.dll, python311._pth (site-packages enabled)
//       Lib/site-packages/              faster-whisper + deps (win_amd64
//                                       binary wheels: ctranslate2, PyAV,
//                                       onnxruntime for VAD, tokenizers,
//                                       huggingface-hub, numpy)
//
// Cross-built from Linux: pip resolves win_amd64 wheels with
// --platform/--only-binary (everything ships binary wheels — no compiled
// steps), and the embeddable zip is extracted with python3 -m zipfile (the
// build host always has python3). electron-builder picks the folder up via
// the extraResources entry in package.json.
//
// Run by `npm run electron:build` before electron-builder. Idempotent —
// wipes and rebuilds each run. Dev note: FRAMEFUSE_FW_PYTHON=<python> lets
// electron/main.js use a system interpreter instead (Linux dev boxes).

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const https = require("https");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "faster-whisper-runtime");
const PY_OUT = path.join(OUT, "python");
const SITE = path.join(PY_OUT, "Lib", "site-packages");
const CACHE = path.join(ROOT, ".cache", "faster-whisper-runtime");
// v1.7: the bundled CTranslate2 model lives at OUT/models (staged by
// stage-faster-whisper-model.js). This script WIPES OUT on every run, so
// the models dir moves aside here and back after the rebuild (the same
// preserve pattern stage-whisper-service.js uses for ONNX models).
const MODELS_DIR = path.join(OUT, "models");
const MODELS_BACKUP = path.join(ROOT, ".cache", "fw-models-stash");

const PYTHON_EMBED_URL =
  "https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip";
const FASTER_WHISPER_SPEC = "faster-whisper>=1.2.1,<1.3";
// v1.4.2 CRITICAL FIX — resolve wheels for the BUNDLED 3.11 interpreter.
// The old install resolved wheels for the BUILD HOST's Python (3.12 →
// cp312 .pyd files) which cannot load on the 3.11 embeddable runtime:
//   "Importing the numpy C-extensions failed ... _multiarray_umath.
//   cp312-win_amd64.pyd ... incompatible with python 'cpython-311'"
// pip flags + a hard verification guard (see verifyWheelTags) make the
// target interpreter EXPLICIT and the failure mode impossible to ship.
const PY_MAJOR = 3;
const PY_MINOR = 11;
const PY_TAG = `cp${PY_MAJOR}${PY_MINOR}`; // "cp311"
// huggingface-hub <1.0: faster-whisper 1.2.1 passes the deprecated
// `local_dir_use_symlinks` kwarg to snapshot_download() — hub 1.x REMOVED
// that parameter (TypeError on first model download). The 0.x line still
// accepts it. Pin until faster-whisper ships a hub-1.x-compatible release.
const EXTRA_PINS = ["huggingface-hub>=0.21,<1.0"];

function die(msg) {
  console.error(`[stage-faster-whisper] ${msg}`);
  process.exit(1);
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

/** Download with redirect following into a cache file. */
function download(url, dest) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) return resolve(dest);
    mkdirp(path.dirname(dest));
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const tmp = `${dest}.part`;
      const ws = fs.createWriteStream(tmp);
      res.pipe(ws);
      ws.on("error", reject);
      ws.on("finish", () => {
        fs.renameSync(tmp, dest);
        resolve(dest);
      });
    });
    req.on("error", reject);
    req.setTimeout(180000, () => {
      req.destroy(new Error("download timeout"));
    });
  });
}

/** Resolve a pip entry point on the build host. */
function pipBin() {
  if (process.env.PIP) return process.env.PIP;
  for (const cand of ["/home/z/.venv/bin/pip3", "/usr/bin/pip3"]) {
    if (fs.existsSync(cand)) return cand;
  }
  return null; // fall back to python3 -m pip
}

/** v1.4.2 GUARD — every compiled extension (.pyd) in the staged runtime
 * must be loadable by the bundled Python 3.11:
 *   - non-abi3 wheels: tag MUST be exactly cp311 (cp312/cp313 → hard fail —
 *     exactly the field bug the user hit);
 *   - abi3 wheels (stable ABI): tag MUST be cp311 OR LOWER (cp38-abi3,
 *     cp310-abi3, ... all load on 3.11);
 *   - extensionless .pyd (no cp tag) are fine.
 * Returns the list of offending files (empty = pass). */
function findIncompatiblePyds(siteDir) {
  const bad = [];
  const cpRe = /\.cp(\d{2,3})(-abi3)?-win(?:32|_amd64)\.pyd$/i;
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "__pycache__") continue;
        walk(p);
      } else if (/\.pyd$/i.test(ent.name)) {
        const m = ent.name.match(cpRe);
        if (!m) continue; // untagged extension — fine
        const tag = parseInt(m[1], 10);
        const abi3 = !!m[2];
        const ok = abi3 ? tag <= PY_MAJOR * 100 + PY_MINOR : tag === PY_MAJOR * 100 + PY_MINOR;
        if (!ok) bad.push(`${ent.name}  (in ${path.relative(siteDir, path.dirname(p))})`);
      }
    }
  };
  walk(siteDir);
  return bad;
}

async function main() {
  console.log("[stage-faster-whisper] building the faster-whisper sidecar runtime…");
  // v1.7: preserve the bundled CT2 model dir across the wipe.
  let modelsPreserved = false;
  try {
    fs.rmSync(MODELS_BACKUP, { recursive: true, force: true });
    if (fs.existsSync(MODELS_DIR)) {
      fs.renameSync(MODELS_DIR, MODELS_BACKUP);
      modelsPreserved = true;
    }
  } catch (_) { /* no models to preserve (fresh build) */ }
  rmrf(OUT);
  mkdirp(PY_OUT);
  mkdirp(SITE);
  mkdirp(CACHE);
  if (modelsPreserved) {
    try {
      fs.renameSync(MODELS_BACKUP, MODELS_DIR);
    } catch (_) { /* restore failed — stage-faster-whisper-model re-downloads */ }
  }

  // 1. Windows embeddable CPython.
  const zipName = PYTHON_EMBED_URL.split("/").pop();
  const zipPath = path.join(CACHE, zipName);
  if (!fs.existsSync(zipPath)) {
    console.log(`[stage-faster-whisper] downloading ${zipName} …`);
    await download(PYTHON_EMBED_URL, zipPath);
  }
  if (!fs.existsSync(zipPath)) die(`python embeddable zip missing (${zipPath})`);
  console.log(`[stage-faster-whisper] extracting ${zipName} …`);
  execFileSync("python3", ["-m", "zipfile", "-e", zipPath, PY_OUT], {
    stdio: "inherit",
  });

  // 2. ._pth — enable site-packages + import site (the embeddable default
  // is isolated). Paths are relative to the python.exe directory.
  const pth = ["python311.zip", ".", "Lib/site-packages", "", "import site"].join("\n");
  fs.writeFileSync(path.join(PY_OUT, "python311._pth"), pth, "utf8");

  // 3. Windows binary wheels for faster-whisper (cross-platform resolve —
  // no post-install scripts run, everything is a prebuilt win_amd64 wheel).
  // v1.4.2: --python-version/--implementation/--abi pin the resolution to
  // the BUNDLED interpreter. Without them pip resolves for the build host
  // (Python 3.12 here) and stages cp312 .pyd files that crash the 3.11
  // runtime on import — the exact field error this build fixes.
  console.log("[stage-faster-whisper] pip resolving win_amd64 wheels for Python 3.11 …");
  const pip = pipBin();
  const pipArgs = [
    "install",
    "--platform", "win_amd64",
    `--python-version`, `${PY_MAJOR}.${PY_MINOR}`,
    "--implementation", "cp",
    "--abi", PY_TAG,
    "--only-binary=:all:",
    "--target", SITE,
    "--no-compile",
    FASTER_WHISPER_SPEC,
    ...EXTRA_PINS,
  ];
  try {
    if (pip) execFileSync(pip, pipArgs, { stdio: "inherit" });
    else execFileSync("python3", ["-m", "pip", ...pipArgs], { stdio: "inherit" });
  } catch (e) {
    die(`pip install failed: ${e.message}`);
  }

  // 4. The sidecar script.
  fs.copyFileSync(
    path.join(ROOT, "electron", "faster-whisper-transcriber.py"),
    path.join(OUT, "transcriber.py"),
  );

  // 5. WHEEL-TAG GUARD — die loudly if any compiled extension in the staged
  // runtime cannot load on the bundled 3.11 interpreter (v1.4.2: the cp312
  // numpy/ctranslate2 wheels shipped silently before this check existed).
  const badPyds = findIncompatiblePyds(SITE);
  if (badPyds.length > 0) {
    die(
      `incompatible compiled extensions staged for Python ${PY_MAJOR}.${PY_MINOR}:\n  ` +
        badPyds.join("\n  ") +
        "\nThis means pip resolved wheels for a DIFFERENT Python version —" +
        " check the --python-version/--implementation/--abi flags.",
    );
  }
  console.log(
    `[stage-faster-whisper] wheel-tag guard: all .pyd files load on ${PY_TAG} ✓`,
  );

  // 6. Sanity report.
  const mustExist = [
    path.join(PY_OUT, "python.exe"),
    path.join(SITE, "faster_whisper"),
    path.join(SITE, "ctranslate2"),
    path.join(OUT, "transcriber.py"),
  ];
  for (const p of mustExist) {
    if (!fs.existsSync(p)) die(`missing staged artifact: ${p}`);
  }
  console.log(
    `[stage-faster-whisper] done — ${mustExist.length} artifacts verified at ${OUT}`,
  );
}

main().catch((e) => die(e.message || String(e)));
