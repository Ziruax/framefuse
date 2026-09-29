// Cross-platform pre-build step: stages into resources/ffmpeg/win/:
//   1. a FULL Windows FFmpeg build (ffmpeg.exe + ffprobe.exe) — the CLI
//      export/probe pipeline, and
//   2. the FFmpeg 7.1 SHARED libraries (avcodec-61.dll, avformat-61.dll,
//      avutil-59.dll, swscale-8.dll, swresample-5.dll) under dll/ — the
//      runtime-FFI DLLs the Rust native export engine (rust-engine/) dlopens
//      at runtime (the "No-Link" rule: libloading, never build-time linking).
//      electron-builder's extraResources already copies resources/ffmpeg →
//      resources/ffmpeg wholesale, and electron/rust-engine-router.js
//      ffmpegDllDir() passes <dir-of-ffmpeg.exe>/dll as the engine's
//      ffmpeg_dir — so the DLLs ride along automatically. The sonames are
//      version-pinned by the Rust engine's ABI guard (ffmpeg_ffi.rs load():
//      avcodec 61 / avformat 61 / avutil 59 / swscale 8 / swresample 5):
//      any other family hard-fails the engine and exports route to the CLI
//      fallback — so the DLL set is VERIFIED by soname after extraction.
//
// WHY (v1.5): the app previously shipped the ffmpeg-static win32 build — a
// MINIMAL static build with NO hardware encoders (no h264_nvenc/h264_qsv/
// h264_amf) and NO ffprobe. On packaged Windows installs the GPU encoder probe
// could never find a hardware encoder (every GPU user silently exported on
// CPU), and fastProbe's ffprobe path never resolved (every media probe fell
// back to the slow `ffmpeg -i` stderr parser). A full GPL build fixes both.
//
// Exe sources, tried in order (both contain ffmpeg.exe + ffprobe.exe with
// nvenc/qsv/amf + libass):
//   1. BtbN FFmpeg-Builds "ffmpeg-master-latest-win64-gpl.zip" — git master,
//      plain zip (stdlib extraction).
//   2. gyan.dev "release-full" 7z  — STABLE release FFmpeg (matches the
//      feature set our argv was verified against). Needs a 7z extractor
//      (7z/7za/bsdtar binary, else py7zr via pip).
//   3. LEGACY fallback: the ffmpeg-static win32 binary (minimal build, no
//      ffprobe, no hw encoders) into node_modules/ffmpeg-static/ffmpeg.exe —
//      the app's resolution matrix still finds it, so the installer always
//      builds even if both full-build sources are unreachable.
//
// Shared-DLL sources, tried in order (ALL soname-checked after extraction —
// a family drift is a clean rejection, never a wrong-family staging):
//   1. gyan.dev "release-full-shared" 7z — the shared twin of the static
//      release build (same FFmpeg line, needs the same 7z extractor).
//   2. BtbN FFmpeg-Builds pinned "ffmpeg-n7.1-latest-win64-gpl-shared-7.1.zip"
//      (plain zip). When the pinned asset 404s (the rolling "latest" release
//      prunes old families), the GitHub API is queried for a live n7.1
//      win64-gpl-shared asset.
//   3. gyan.dev GitHub mirror (GyanD/codexffmpeg) tag-pinned 7.1.1
//      full_build-shared.zip — IMMUTABLE pin. The rolling aliases above can
//      silently drift to a newer FFmpeg family (observed: gyan's "release"
//      line later moved to ffmpeg 9); the soname check merely rejects them,
//      this source guarantees the 7.1 family regardless.
//      On ANY mismatch the dll/ dir is left ABSENT (never half-staged) — the
//      app still works (Rust path off, CLI fallback on), so a DLL failure is
//      a LOUD WARNING, never a build failure.
//
// Idempotent — skips a phase when its outputs already exist with sane sizes
// (FFMPEG_FETCH_FORCE=1 re-downloads both phases). The two phases are
// independent: exe staging can't kill DLL staging and vice versa; a summary
// log reports both at the end.
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

// ── Rust-engine shared-DLL staging (runtime FFI, FFmpeg 7.1 family) ─────────
const OUT_DLL_DIR = path.join(OUT_DIR, "dll");
const GYAN_SHARED_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-full-shared.7z";
const BTBN_SHARED_URL = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-win64-gpl-shared-7.1.zip";
const BTBN_LATEST_API = "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/tags/latest";
const GYAN_MIRROR_TAG = "7.1.1"; // immutable tag — see header note on rolling-alias drift
const GYAN_MIRROR_SHARED_ZIP = `https://github.com/GyanD/codexffmpeg/releases/download/${GYAN_MIRROR_TAG}/ffmpeg-${GYAN_MIRROR_TAG}-full_build-shared.zip`;

// FFmpeg 7.1 sonames, pinned by rust-engine/src/ffmpeg_ffi.rs's ABI guard
// (avcodec 61 / avformat 61 / avutil 59 / swscale 8 / swresample 5).
const SHARED_DLLS = [
  { name: "avcodec-61.dll", minBytes: 2 * 1024 * 1024 }, // real: ~12-25 MB
  { name: "avformat-61.dll", minBytes: 200 * 1024 },
  { name: "avutil-59.dll", minBytes: 200 * 1024 },
  { name: "swscale-8.dll", minBytes: 200 * 1024 },
  { name: "swresample-5.dll", minBytes: 200 * 1024 },
];

const MIN_FFMPEG_BYTES = 50 * 1024 * 1024;  // full builds are ~80-180 MB
const MIN_FFPROBE_BYTES = 30 * 1024 * 1024;

function log(msg) {
  console.log(`[fetch-windows-ffmpeg] ${msg}`);
}

function downloadTo(url, destPath) {
  return new Promise((resolve, reject) => {
    // guard: the dest dir may have been wiped mid-run (observed: sandbox
    // housekeeping prunes generated dirs) — a missing dir must reject cleanly,
    // never crash the process with an uncaught stream exception.
    try { fs.mkdirSync(path.dirname(destPath), { recursive: true }); } catch {}
    const file = fs.createWriteStream(destPath);
    file.on("error", reject);
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
            try { file.destroy(); } catch {} // don't leak the fd on 404/403
            reject(new Error(`HTTP ${res.statusCode} for ${u}`));
            return;
          }
          total = Number(res.headers["content-length"]) || 0;
          res.pipe(file);
          file.on("finish", () => {
            file.close(() => {
              try { resolve(fs.statSync(destPath).size); } catch (err) { reject(err); }
            });
          });
        })
        .on("error", (err) => {
          try { file.destroy(); } catch {}
          reject(err);
        });
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

/** GET a URL as text (redirect-aware; used for the GitHub API discovery). */
function fetchText(url) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const get = (u, redirectsLeft = 5) =>
      https
        .get(u, { headers: { "User-Agent": "FrameFuse-fetch-windows-ffmpeg" } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (redirectsLeft <= 0) { reject(new Error("Too many redirects")); return; }
            res.resume();
            get(new URL(res.headers.location, u).toString(), redirectsLeft - 1);
            return;
          }
          if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} for ${u}`)); return; }
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        })
        .on("error", reject);
    get(url);
  });
}

/** Plain-zip extraction via python3 stdlib (no native deps). */
function extractZip(archive, outDir) {
  const r = spawnSync(
    "python3",
    ["-c", `import zipfile; zipfile.ZipFile(${JSON.stringify(archive)}).extractall(${JSON.stringify(outDir)})`],
    { encoding: "utf8", timeout: 600000 },
  );
  if (r.status !== 0) throw new Error(`zip extraction failed: ${(r.stderr || "").slice(-300)}`);
}

/** Depth-first walk of every file under dir (unreadable dirs skipped). */
function walkTree(dir, visit) {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else visit(full, e.name);
    }
  }
}

/** Case-insensitive recursive file search (first match, DFS order). */
function findInTree(dir, name) {
  let hit = null;
  walkTree(dir, (full, fname) => {
    if (!hit && fname.toLowerCase() === name.toLowerCase()) hit = full;
  });
  return hit;
}

/** All distinct file names under dir matching regex (lowercased). */
function findAllInTree(dir, regex) {
  const hits = new Set();
  walkTree(dir, (full, fname) => {
    if (regex.test(fname)) hits.add(fname.toLowerCase());
  });
  return [...hits];
}

/** Locate bin/ffmpeg.exe + bin/ffprobe.exe under the extracted tree and copy
 *  them into OUT_DIR. Returns true when both land with sane sizes. */
function harvestExtractedTree(dir) {
  const ff = findInTree(dir, "ffmpeg.exe");
  const fp = findInTree(dir, "ffprobe.exe");
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
  extractZip(archive, extractDir); // plain zip — stdlib extraction
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

// ── PHASE: FFmpeg 7.1 shared DLLs for the Rust engine (runtime FFI) ─────────

/** True when all 5 pinned DLLs sit in OUT_DLL_DIR with sane sizes. */
function dllsStaged() {
  try {
    for (const { name, minBytes } of SHARED_DLLS) {
      const p = path.join(OUT_DLL_DIR, name);
      if (!fs.existsSync(p) || fs.statSync(p).size < minBytes) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** After a failed source: keep a previously COMPLETE set, wipe anything
 *  partial — never leave a half-staged dll/ dir that looks loadable. */
function cleanPartialDllDir() {
  if (!fs.existsSync(OUT_DLL_DIR)) return; // absent — the required end state
  if (dllsStaged()) {
    log(`keeping the previously staged complete 7.1 DLL set in ${path.relative(ROOT, OUT_DLL_DIR)}`);
    return;
  }
  fs.rmSync(OUT_DLL_DIR, { recursive: true, force: true });
  log(`removed partial/corrupt ${path.relative(ROOT, OUT_DLL_DIR)} (staging is all-5-or-nothing)`);
}

/** Verify + copy the 5 pinned DLLs from an extracted archive tree into
 *  OUT_DLL_DIR. Throws (clean, descriptive) on ANY soname/size mismatch —
 *  nothing is written unless the COMPLETE, exact-family set is verified. */
function harvestSharedDlls(dir) {
  const verified = [];
  const missing = [];
  for (const { name, minBytes } of SHARED_DLLS) {
    const p = findInTree(dir, name);
    if (!p) { missing.push(name); continue; }
    const size = fs.statSync(p).size;
    if (size < minBytes) throw new Error(`${name} present but only ${size}B (< ${minBytes}B sanity floor) — rejecting the whole set`);
    verified.push({ name, p, size });
  }
  if (missing.length > 0) {
    // Family-drift diagnostic: which FFmpeg sonames does this tree carry?
    const carried = findAllInTree(dir, /^(av|sw)\w+-\d+\.dll$|^postproc-\d+\.dll$/).sort();
    const hint = carried.length ? ` The archive carries: ${carried.join(", ")}.` : "";
    throw new Error(
      `FFmpeg family mismatch — missing [${missing.join(", ")}].${hint}The Rust engine is ABI-pinned to the FFmpeg 7.1 sonames (${SHARED_DLLS.map((d) => d.name).join(", ")}); this build is a different family`,
    );
  }
  fs.rmSync(OUT_DLL_DIR, { recursive: true, force: true }); // fresh dir (all-5-or-nothing)
  fs.mkdirSync(OUT_DLL_DIR, { recursive: true });
  for (const { name, p, size } of verified) {
    fs.copyFileSync(p, path.join(OUT_DLL_DIR, name));
    log(`staged ${name} (${Math.round(size / 1048576)}MB)`);
  }
  return true;
}

/** Source 1: gyan.dev "release-full-shared" 7z (the shared twin of the static
 *  release build). Needs the 7z extractor chain. */
async function tryGyanShared() {
  const archive = path.join(TMP_DIR, "ffmpeg-release-full-shared.7z");
  log(`downloading gyan release-full-shared build from ${GYAN_SHARED_URL}`);
  const size = await downloadTo(GYAN_SHARED_URL, archive);
  log(`downloaded ${Math.round(size / 1048576)} MB — extracting (DLLs only)`);
  const extractDir = path.join(TMP_DIR, "gyan-shared");
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  const extractor = sevenZipExtractor();
  if (!extractor) throw new Error("no 7z extractor available");
  extractor(archive, extractDir);
  harvestSharedDlls(extractDir);
  return "gyan-release-full-shared";
}

/** Source 2: BtbN pinned n7.1 win64-gpl-shared zip. When the pinned asset
 *  404s (the rolling "latest" release prunes old families), discover a live
 *  n7.1 shared asset via the GitHub API — NEVER the master/8/9 builds. */
async function tryBtbNShared() {
  const archive = path.join(TMP_DIR, "ffmpeg-n7.1-win64-gpl-shared.zip");
  let url = BTBN_SHARED_URL;
  let size;
  log(`downloading BtbN n7.1 shared build from ${url}`);
  try {
    size = await downloadTo(url, archive);
  } catch (err) {
    if (!/HTTP 404/.test(String(err.message))) throw err;
    log(`pinned asset 404 — querying the GitHub API for a live n7.1 win64-gpl-shared asset`);
    let rel;
    try {
      rel = JSON.parse(await fetchText(BTBN_LATEST_API));
    } catch (apiErr) {
      throw new Error(`GitHub API discovery failed (${apiErr.message} — unauthenticated API is rate-limited to 60 req/h) while the pinned n7.1 asset is gone`);
    }
    const hit = (rel.assets || [])
      .map((a) => a.browser_download_url)
      .find((u) => /ffmpeg-n7\.1[\w.-]*win64-gpl-shared[\w.-]*\.zip$/.test(u));
    if (!hit) throw new Error("no n7.1 win64-gpl-shared asset in the BtbN 'latest' release (family drifted past 7.1)");
    url = hit;
    log(`discovered ${url}`);
    size = await downloadTo(url, archive);
  }
  log(`downloaded ${Math.round(size / 1048576)} MB — extracting (DLLs only)`);
  const extractDir = path.join(TMP_DIR, "btbn-shared");
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  extractZip(archive, extractDir); // plain zip — stdlib extraction
  harvestSharedDlls(extractDir);
  return "btbn-n7.1-gpl-shared";
}

/** Source 3: the gyan GitHub mirror (GyanD/codexffmpeg), tag-pinned at 7.1.1.
 *  IMMUTABLE — immune to the rolling-alias family drift that sources 1-2 can
 *  hit (their drift is caught by the soname check, this one can't drift).
 *  Plain zip: no 7z tooling required. */
async function tryGyanMirrorShared() {
  const archive = path.join(TMP_DIR, `ffmpeg-${GYAN_MIRROR_TAG}-full_build-shared.zip`);
  log(`downloading version-pinned gyan mirror ${GYAN_MIRROR_TAG} shared build from ${GYAN_MIRROR_SHARED_ZIP}`);
  const size = await downloadTo(GYAN_MIRROR_SHARED_ZIP, archive);
  log(`downloaded ${Math.round(size / 1048576)} MB — extracting (DLLs only)`);
  const extractDir = path.join(TMP_DIR, "gyan-mirror-shared");
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  extractZip(archive, extractDir); // plain zip — stdlib extraction
  harvestSharedDlls(extractDir);
  return `gyan-mirror-${GYAN_MIRROR_TAG}-full_build-shared (tag-pinned)`;
}

/** Stage the 5 FFmpeg 7.1 shared DLLs into resources/ffmpeg/win/dll/.
 *  SOFT failure: a miss only means the Rust engine stays off (CLI fallback
 *  on) — never fatal for the build. */
async function stageSharedDlls(force) {
  if (!force && dllsStaged()) {
    log(`shared DLLs already staged in ${path.relative(ROOT, OUT_DLL_DIR)} — skipping`);
    return { staged: true, source: "already staged" };
  }
  const failures = [];
  for (const [label, fn] of [
    ["gyan-shared", tryGyanShared],
    ["btbn-shared", tryBtbNShared],
    ["gyan-mirror-shared", tryGyanMirrorShared],
  ]) {
    try {
      const source = await fn();
      log(`Done. FFmpeg 7.1 shared DLLs staged from ${source} → ${path.relative(ROOT, OUT_DLL_DIR)}`);
      return { staged: true, source };
    } catch (err) {
      failures.push(`${label}: ${err.message}`);
      console.error(`[fetch-windows-ffmpeg] ${label} FAILED: ${err.message}`);
    }
    cleanPartialDllDir();
  }
  cleanPartialDllDir();
  if (dllsStaged()) return { staged: true, source: "previously staged (sources failed, complete set intact)" };
  console.error("[fetch-windows-ffmpeg] WARNING: could not stage the FFmpeg 7.1 shared DLLs from any source —");
  console.error(`[fetch-windows-ffmpeg] ${failures.join(" | ")}`);
  console.error("[fetch-windows-ffmpeg] The Rust native export engine will be UNAVAILABLE in the packaged app (all exports ride the FFmpeg CLI pipeline — fully functional, no native engine).");
  return { staged: false, error: failures.join(" | ") };
}

// ── PHASE: full static build (ffmpeg.exe + ffprobe.exe) ─────────────────────

/** Mirrors the pre-v1.17 single-phase script exactly: BtbN → gyan → the
 *  ffmpeg-static legacy fallback. */
async function stageExes(force) {
  if (
    !force &&
    fs.existsSync(OUT_FFMPEG) && fs.existsSync(OUT_FFPROBE) &&
    fs.statSync(OUT_FFMPEG).size >= MIN_FFMPEG_BYTES &&
    fs.statSync(OUT_FFPROBE).size >= MIN_FFPROBE_BYTES
  ) {
    log(`full build already staged (${Math.round(fs.statSync(OUT_FFMPEG).size / 1048576)}MB ffmpeg.exe + ${Math.round(fs.statSync(OUT_FFPROBE).size / 1048576)}MB ffprobe.exe) — skipping`);
    return { ok: true, source: "already staged" };
  }

  const failures = [];
  // BtbN first: the GitHub CDN measures ~35× faster than gyan.dev from build
  // machines, and the plain zip needs no 7z tooling. gyan (stable release
  // line) stays as the fallback when BtbN is unreachable.
  for (const [label, fn] of [["btbn", tryBtbN], ["gyan", tryGyan]]) {
    try {
      const source = await fn();
      log(`Done. Full Windows FFmpeg staged from ${source} → ${path.relative(ROOT, OUT_DIR)}`);
      return { ok: true, source };
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
      console.error(`[fetch-windows-ffmpeg] WARNING: staged the MINIMAL ffmpeg-static build (${source}).`);
      console.error("[fetch-windows-ffmpeg] The packaged app will have NO ffprobe (slow probes) and NO NVENC/QSV/AMF (CPU-only exports).");
      return { ok: true, source: "ffmpeg-static (minimal)", legacy: true };
    }
  } catch (err) {
    failures.push(`ffmpeg-static: ${err.message}`);
  }

  return { ok: false, error: failures.join(" | ") };
}

// ── orchestration ───────────────────────────────────────────────────────────

async function main() {
  const force = process.env.FFMPEG_FETCH_FORCE === "1";
  fs.mkdirSync(TMP_DIR, { recursive: true });

  // PHASE 1 — shared DLLs FIRST: small payload, and a failure here must never
  // starve or kill anything else (it is a feature downgrade, not an error).
  let dllStatus = { staged: false, error: "phase not run" };
  try {
    dllStatus = await stageSharedDlls(force);
  } catch (err) {
    // belt & braces — stageSharedDlls already swallows source-level errors
    dllStatus = { staged: dllsStaged(), error: err.message };
    console.error(`[fetch-windows-ffmpeg] dll staging phase CRASHED: ${err.message}`);
  }

  // PHASE 2 — the full static exe build (the CLI pipeline). Independent of
  // phase 1: a crash/slow run here can't retroactively un-stage the DLLs.
  let exeStatus = { ok: false, error: "phase not run" };
  try {
    exeStatus = await stageExes(force);
  } catch (err) {
    exeStatus = { ok: false, error: err.message };
    console.error(`[fetch-windows-ffmpeg] exe staging phase CRASHED: ${err.message}`);
  }

  // ── summary ──
  const dllLine = dllStatus.staged
    ? `OK (${dllStatus.source}) — ${path.relative(ROOT, OUT_DLL_DIR)}/: ${SHARED_DLLS.map((d) => d.name).join(", ")}`
    : `ABSENT — Rust engine off, CLI fallback on (see warnings above)`;
  const exeLine = exeStatus.ok
    ? `OK (${exeStatus.source}) — ${path.relative(ROOT, OUT_FFMPEG)} + ${path.relative(ROOT, OUT_FFPROBE)}`
    : `FAILED — the packaged app has no FFmpeg CLI (see errors above)`;
  log("─".repeat(76));
  log(`SUMMARY  rust dlls: ${dllLine}`);
  log(`SUMMARY  cli exes : ${exeLine}`);

  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}

  if (!exeStatus.ok) {
    console.error(`[fetch-windows-ffmpeg] FAILED all exe sources: ${exeStatus.error}`);
    console.error("[fetch-windows-ffmpeg] The Windows .exe build will fail to run FFmpeg.");
    process.exit(1);
  }
}

main();
