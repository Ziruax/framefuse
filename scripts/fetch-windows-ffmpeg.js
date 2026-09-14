// Cross-platform pre-build step: stages a FULL Windows FFmpeg build (ffmpeg.exe
// + ffprobe.exe) into resources/ffmpeg/win/.
//
// WHY (v1.5): the app previously shipped the ffmpeg-static win32 build — a
// MINIMAL static build with NO hardware encoders (no h264_nvenc/h264_qsv/
// h264_amf) and NO ffprobe. On packaged Windows installs the GPU encoder probe
// could never find a hardware encoder (every GPU user silently exported on
// CPU), and fastProbe's ffprobe path never resolved (every media probe fell
// back to the slow `ffmpeg -i` stderr parser). A full GPL build fixes both.
//
// Sources, tried in order (both contain ffmpeg.exe + ffprobe.exe with
// nvenc/qsv/amf + libass):
//   1. gyan.dev "release-full" 7z  — STABLE release FFmpeg (matches the
//      feature set our argv was verified against). Needs a 7z extractor
//      (7z/7za/bsdtar binary, else py7zr via pip).
//   2. BtbN FFmpeg-Builds "ffmpeg-master-latest-win64-gpl.zip" — git master,
//      plain zip (stdlib extraction).
//   3. LEGACY fallback: the ffmpeg-static win32 binary (minimal build, no
//      ffprobe, no hw encoders) into node_modules/ffmpeg-static/ffmpeg.exe —
//      the app's resolution matrix still finds it, so the installer always
//      builds even if both full-build sources are unreachable.
//
// Idempotent — skips when both exes already exist with sane sizes
// (FFMPEG_FETCH_FORCE=1 re-downloads).
//
// Run automatically before `electron-builder` via `npm run electron:build`.

const fs = require("fs");
const path = require("path");
const https = require("https");
const zlib = require("zlib");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "resources", "ffmpeg", "win");
const OUT_FFMPEG = path.join(OUT_DIR, "ffmpeg.exe");
const OUT_FFPROBE = path.join(OUT_DIR, "ffprobe.exe");
const TMP_DIR = path.join(ROOT, "resources", "ffmpeg", ".download");

const GYAN_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-full.7z";
const BTBN_URL = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";
const STATIC_RELEASE_TAG = "b6.1.1"; // matches ffmpeg-static@5.3.0
const STATIC_URL = `https://github.com/eugeneware/ffmpeg-static/releases/download/${STATIC_RELEASE_TAG}/ffmpeg-win32-x64.gz`;

const MIN_FFMPEG_BYTES = 50 * 1024 * 1024;  // full builds are ~80-180 MB
const MIN_FFPROBE_BYTES = 30 * 1024 * 1024;

function log(msg) {
  console.log(`[fetch-windows-ffmpeg] ${msg}`);
}

function downloadTo(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let total = 0;
    const get = (u, redirectsLeft = 8) =>
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
            res.resume();
            get(new URL(res.headers.location, u).toString(), redirectsLeft - 1);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode} for ${u}`));
            return;
          }
          total = Number(res.headers["content-length"]) || 0;
          res.pipe(file);
          file.on("finish", () => {
            file.close(() => resolve(fs.statSync(destPath).size));
          });
        })
        .on("error", reject);
    get(url);
  });
}

/** Find an available 7z extractor: a binary, else python3 + py7zr
 *  (auto-installed with pip when missing). Returns null when unavailable. */
function sevenZipExtractor() {
  for (const bin of ["7z", "7za", "7zr", "bsdtar"]) {
    const r = spawnSync(bin, ["-h"], { encoding: "utf8", timeout: 8000 });
    // 7z prints usage to stderr with exit code 0/1; bsdtar exits 1 with usage.
    if (!r.error) {
      log(`using ${bin} for 7z extraction`);
      return (archive, outDir) => {
        if (bin === "bsdtar") {
          const r = spawnSync(bin, ["-xf", archive, "-C", outDir], { timeout: 300000 });
          if (r.status !== 0) throw new Error(`bsdtar failed: ${(r.stderr || "").slice(-200)}`);
          return;
        }
        const r = spawnSync(bin, ["x", "-y", `-o${outDir}`, archive], { timeout: 300000 });
        if (r.status !== 0) throw new Error(`${bin} failed: ${(r.stderr || "").slice(-200)}`);
      };
    }
  }
  const py = spawnSync("python3", ["-c", "import py7zr"], { encoding: "utf8", timeout: 15000 });
  if (py.status === 0) return py7zrExtractor("py7zr already available");
  log("installing py7zr via pip (7z extraction for the gyan full build)…");
  const pip = spawnSync("python3", ["-m", "pip", "install", "--quiet", "py7zr"], { encoding: "utf8", timeout: 240000 });
  if (pip.status === 0) return py7zrExtractor("py7zr installed via pip");
  log("py7zr unavailable — will fall back to the BtbN zip build");
  return null;
}

function py7zrExtractor(note) {
  log(`using python3 py7zr for 7z extraction (${note})`);
  return (archive, outDir) => {
    const code = `
import py7zr, sys
with py7zr.SevenZipFile(${JSON.stringify(archive)}) as z:
    z.extractall(path=${JSON.stringify(outDir)})
`;
    const r = spawnSync("python3", ["-c", code], { encoding: "utf8", timeout: 600000 });
    if (r.status !== 0) throw new Error(`py7zr failed: ${(r.stderr || "").slice(-300)}`);
  };
}

/** Locate bin/ffmpeg.exe + bin/ffprobe.exe under the extracted tree and copy
 *  them into OUT_DIR. Returns true when both land with sane sizes. */
function harvestExtractedTree(dir) {
  const findBin = (name) => {
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop();
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.name.toLowerCase() === name) return full;
      }
    }
    return null;
  };
  const ff = findBin("ffmpeg.exe");
  const fp = findBin("ffprobe.exe");
  if (!ff || !fp) return false;
  const ffSize = fs.statSync(ff).size;
  const fpSize = fs.statSync(fp).size;
  if (ffSize < MIN_FFMPEG_BYTES || fpSize < MIN_FFPROBE_BYTES) {
    log(`harvest rejected (sizes ffmpeg ${Math.round(ffSize / 1048576)}MB, ffprobe ${Math.round(fpSize / 1048576)}MB — too small for a full build)`);
    return false;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.copyFileSync(ff, OUT_FFMPEG);
  fs.copyFileSync(fp, OUT_FFPROBE);
  try { fs.chmodSync(OUT_FFMPEG, 0o755); fs.chmodSync(OUT_FFPROBE, 0o755); } catch {}
  return true;
}

async function tryGyan() {
  const archive = path.join(TMP_DIR, "ffmpeg-release-full.7z");
  log(`downloading gyan release-full build from ${GYAN_URL}`);
  const size = await downloadTo(GYAN_URL, archive);
  log(`downloaded ${Math.round(size / 1048576)} MB — extracting`);
  const extractDir = path.join(TMP_DIR, "gyan");
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  const extractor = sevenZipExtractor();
  if (!extractor) throw new Error("no 7z extractor available");
  extractor(archive, extractDir);
  if (!harvestExtractedTree(extractDir)) throw new Error("ffmpeg.exe/ffprobe.exe not found in the gyan archive");
  return "gyan-release-full";
}

async function tryBtbN() {
  const archive = path.join(TMP_DIR, "ffmpeg-master-latest-win64-gpl.zip");
  log(`downloading BtbN master full build from ${BTBN_URL}`);
  const size = await downloadTo(BTBN_URL, archive);
  log(`downloaded ${Math.round(size / 1048576)} MB — extracting`);
  const extractDir = path.join(TMP_DIR, "btbn");
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  // Plain zip — python3 stdlib extraction (no native deps).
  const r = spawnSync(
    "python3",
    ["-c", `import zipfile; zipfile.ZipFile(${JSON.stringify(archive)}).extractall(${JSON.stringify(extractDir)})`],
    { encoding: "utf8", timeout: 600000 },
  );
  if (r.status !== 0) throw new Error(`zip extraction failed: ${(r.stderr || "").slice(-300)}`);
  if (!harvestExtractedTree(extractDir)) throw new Error("ffmpeg.exe/ffprobe.exe not found in the BtbN archive");
  return "btbn-master-gpl";
}

/** LEGACY fallback (kept so the installer always builds): the minimal
 *  ffmpeg-static win32 binary. Same code as the pre-v1.5 script. */
async function tryFfmpegStatic() {
  const destDir = path.join(ROOT, "node_modules", "ffmpeg-static");
  const destFile = path.join(destDir, "ffmpeg.exe");
  if (!fs.existsSync(destDir)) {
    log(`skip — ${destDir} not found (ffmpeg-static not installed)`);
    return null;
  }
  if (fs.existsSync(destFile) && fs.statSync(destFile).size > 10_000_000) {
    log(`ffmpeg-static fallback already present (${Math.round(fs.statSync(destFile).size / 1048576)} MB)`);
    return "ffmpeg-static (already present)";
  }
  log(`downloading Windows ffmpeg.exe from ${STATIC_URL}`);
  const size = await downloadAndGunzip(STATIC_URL, destFile);
  try { fs.chmodSync(destFile, 0o755); } catch {}
  log(`ffmpeg-static fallback saved (${Math.round(size / 1048576)} MB)`);
  return "ffmpeg-static (minimal — no ffprobe, no hw encoders)";
}

function downloadAndGunzip(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath + ".gz");
    const get = (u, redirectsLeft = 5) =>
      https
        .get(u, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (redirectsLeft <= 0) { reject(new Error("Too many redirects")); return; }
            res.resume();
            get(res.headers.location, redirectsLeft - 1);
            return;
          }
          if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
          res.pipe(file);
          file.on("finish", () => {
            file.close(() => {
              const gz = fs.readFileSync(destPath + ".gz");
              const out = zlib.gunzipSync(gz);
              fs.writeFileSync(destPath, out);
              fs.unlinkSync(destPath + ".gz");
              resolve(out.length);
            });
          });
        })
        .on("error", reject);
    get(url);
  });
}

async function main() {
  const force = process.env.FFMPEG_FETCH_FORCE === "1";
  if (
    !force &&
    fs.existsSync(OUT_FFMPEG) && fs.existsSync(OUT_FFPROBE) &&
    fs.statSync(OUT_FFMPEG).size >= MIN_FFMPEG_BYTES &&
    fs.statSync(OUT_FFPROBE).size >= MIN_FFPROBE_BYTES
  ) {
    log(`full build already staged (${Math.round(fs.statSync(OUT_FFMPEG).size / 1048576)}MB ffmpeg.exe + ${Math.round(fs.statSync(OUT_FFPROBE).size / 1048576)}MB ffprobe.exe) — skipping`);
    return;
  }

  fs.mkdirSync(TMP_DIR, { recursive: true });
  const failures = [];
  // BtbN first: the GitHub CDN measures ~35× faster than gyan.dev from build
  // machines, and the plain zip needs no 7z tooling. gyan (stable release
  // line) stays as the fallback when BtbN is unreachable.
  for (const [label, fn] of [["btbn", tryBtbN], ["gyan", tryGyan]]) {
    try {
      const source = await fn();
      log(`Done. Full Windows FFmpeg staged from ${source} → ${path.relative(ROOT, OUT_DIR)}`);
      try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
      return;
    } catch (err) {
      failures.push(`${label}: ${err.message}`);
      console.error(`[fetch-windows-ffmpeg] ${label} FAILED: ${err.message}`);
    }
  }

  // Legacy fallback — the build still succeeds, but the packaged app loses
  // ffprobe + hardware encoders (log it LOUDLY; the release checklist treats
  // this as a warning, not an error).
  try {
    const source = await tryFfmpegStatic();
    if (source) {
      try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
      console.error(`[fetch-windows-ffmpeg] WARNING: staged the MINIMAL ffmpeg-static build (${source}).`);
      console.error("[fetch-windows-ffmpeg] The packaged app will have NO ffprobe (slow probes) and NO NVENC/QSV/AMF (CPU-only exports).");
      return;
    }
  } catch (err) {
    failures.push(`ffmpeg-static: ${err.message}`);
  }

  console.error(`[fetch-windows-ffmpeg] FAILED all sources: ${failures.join(" | ")}`);
  console.error("[fetch-windows-ffmpeg] The Windows .exe build will fail to run FFmpeg.");
  process.exit(1);
}

main();
