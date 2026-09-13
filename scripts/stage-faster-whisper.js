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

const PYTHON_EMBED_URL =
  "https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip";
const FASTER_WHISPER_SPEC = "faster-whisper>=1.2.1,<1.3";

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

async function main() {
  console.log("[stage-faster-whisper] building the faster-whisper sidecar runtime…");
  rmrf(OUT);
  mkdirp(PY_OUT);
  mkdirp(SITE);
  mkdirp(CACHE);

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
  console.log("[stage-faster-whisper] pip resolving win_amd64 wheels …");
  const pip = pipBin();
  const pipArgs = [
    "install",
    "--platform", "win_amd64",
    "--only-binary=:all:",
    "--target", SITE,
    "--nocompile",
    FASTER_WHISPER_SPEC,
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

  // 5. Sanity report.
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
