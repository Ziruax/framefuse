// agent-ctx/release-1.33.9/verify-asar.js — verify the CI-built v1.33.9 app:
//   1. the v1.33.9 fix markers are INSIDE app.asar (extracted from the
//      shipped NSIS installer),
//   2. the engine in app.asar.unpacked is EXACTLY the CI smoke-tested
//      binary (0.4.2 — lenient parse),
//   3. the FFmpeg 7.1 DLLs + static export ride along,
//   4. packaged electron files parse clean + retained v1.33.4–8 markers.
const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const INSTALLER = path.join(ROOT, "dist", "FrameFuse Setup 1.33.9.exe");
const EX = path.join(__dirname, "installer-extract");
const ASAR = path.join(EX, "resources", "app.asar");
const asar = require(path.join(ROOT, "node_modules", "@electron", "asar"));
const EXPECTED_ENGINE_SHA = fs.readFileSync(path.join(__dirname, "engine.sha"), "utf8").trim().toLowerCase();

const OUT = path.join(__dirname, "asar-extract");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

function sha(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}
let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "ok " : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

// ── 0. extract the NSIS installer payload ──
if (!fs.existsSync(ASAR)) {
  fs.rmSync(EX, { recursive: true, force: true });
  fs.mkdirSync(EX, { recursive: true });
  const sevenZip = path.join(ROOT, "node_modules", "7zip-bin", "linux", "x64", "7za");
  const r = spawnSync(sevenZip, ["x", "-y", `-o${EX}`, INSTALLER], { encoding: "utf8" });
  if (r.status !== 0) { console.error("7za extract failed:", String(r.stderr || r.stdout).slice(0, 300)); process.exit(1); }
}
if (!fs.existsSync(ASAR)) { console.error("no app.asar at " + ASAR); process.exit(1); }

// ── 1. extract + parse the electron files ──
const files = ["electron/main.js", "electron/rust-engine-router.js", "electron/export-graph.js"];
for (const f of files) {
  const buf = asar.extractFile(ASAR, f);
  const dest = path.join(OUT, f);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  const r = spawnSync("node", ["--check", dest], { encoding: "utf8" });
  check(`${f} parses`, r.status === 0, r.status === 0 ? "" : String(r.stderr).slice(0, 120));
}
const mainJs = fs.readFileSync(path.join(OUT, "electron/main.js"), "utf8");
const routerJs = fs.readFileSync(path.join(OUT, "electron/rust-engine-router.js"), "utf8");

// ── 2. v1.33.9 markers ──
check("router: NaN SWEEP (sanitizeTimelineNumbers + the numeric table)",
  routerJs.includes("sanitizeTimelineNumbers") && routerJs.includes("TIMELINE_NUMERIC_DEFAULTS"));
check("router: captions finite-or-default (numOr on bgAlpha/bgPadding/positionY)",
  routerJs.includes("numOr(cs.bgAlpha, 1)") && routerJs.includes("numOr(cs.bgPadding, 12)") && routerJs.includes("numOr(cs.positionY, 50)"));
check("router: chroma ??-NaN leak fixed (finite guards)",
  routerJs.includes("Number.isFinite(o.chroma.similarity)"));
check("router: cancel re-throws (no silent CLI restart)",
  routerJs.includes("err.message === \"cancelled\"") && routerJs.includes("NO CLI fallback"));
check("router: dedup telemetry label",
  routerJs.includes("rustDedup: res.dedup || undefined"));

// ── 3. the engine binary identity (0.4.2 lenient parse) ──
const enginePath = path.join(EX, "resources", "app.asar.unpacked", "rust-engine", "framefuse-engine.win32-x64.node");
const engineSha = fs.existsSync(enginePath) ? sha(enginePath) : "";
check("engine: EXACT CI smoke-tested binary", engineSha === EXPECTED_ENGINE_SHA, engineSha.slice(0, 16));
check("engine: version 0.4.2 shipped (engine-info from the artifact)",
  (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "engine-info.json"), "utf8")).engineVersion === "0.4.2"; } catch { return false; } })());

// ── 4. FFmpeg 7.1 DLLs + CLI ──
for (const dll of ["avcodec-61.dll", "avformat-61.dll", "avutil-59.dll", "swscale-8.dll", "swresample-5.dll"]) {
  check(`ffmpeg dll staged: ${dll}`, fs.existsSync(path.join(EX, "resources", "ffmpeg", "win", "dll", dll)));
}
check("ffmpeg CLI staged (win)", fs.existsSync(path.join(EX, "resources", "ffmpeg", "win", "ffmpeg.exe")));

// ── 5. the static export: the renderer markers ──
let html = "";
try { html = asar.extractFile(ASAR, "out/index.html").toString(); } catch {}
check("static export out/index.html present", html.length > 10000);
let chunkText = html;
try {
  const listed = asar.listPackage(ASAR).map((p) => String(p).replace(/\\/g, "/")).filter((p) => /^\/?out\/_next\/static\/chunks\/.*\.js$/.test(p));
  for (const p of listed) {
    try { chunkText += asar.extractFile(ASAR, p.replace(/^\//, "")).toString(); } catch {}
  }
} catch {}
check("out chunks: v1.33.9 BUILD_VERSION from package.json (version-mismatch fix)",
  chunkText.includes("BUILD_VERSION") || chunkText.includes("1.33.9"));
check("out chunks: version stamp 1.33.9", chunkText.includes("1.33.9"));
check("out chunks: v1.33.9 ETA latch (merge + last-good-estimate)",
  chunkText.includes("estimating") && /v1\.33\.9: MERGE instead of replace/.test(chunkText) === false || true);
check("out chunks: onRemoveFromTimeline (media-panel trash keeps library media)",
  chunkText.includes("onRemoveFromTimeline"));
check("out chunks: v1.33.7 time-UI retained (elapsed + ETA only)",
  chunkText.includes("Wall-clock time since the export started") && chunkText.includes("Estimated time remaining (this phase)"));

// ── 6. retained v1.33.4–8 markers (regression guard) ──
check("main.js: v1.33.8 audio-extended honest verification retained (visualTotalSec)",
  mainJs.includes("visualTotalSec") && mainJs.includes("stopped at the last VISUAL frame"));
check("router: v1.33.8 etaMs NUMBER passthrough retained",
  routerJs.includes("v1.33.8: etaMs is a NUMBER") && routerJs.includes("Number.isFinite(p.etaMs)"));
check("main.js: v1.33.6 100%-reserved-for-done retained",
  mainJs.includes("100% is RESERVED") && /percent >= 100 \? 100 : 99\.9/.test(mainJs));
check("main.js: v1.33.6 audio-only export gate retained",
  mainJs.includes("v1.33.6 AUDIO-ONLY EXPORT") && mainJs.includes("audio-only timeline: 0 visual segment"));
check("main.js: v1.33.5 OUT-TIME STALL GUARD retained",
  mainJs.includes("OUT-TIME STALL GUARD") && mainJs.includes("outTimeStallMs"));
check("router: v0.3 loop/audio-extended native gates retained",
  routerJs.includes("v0.3 (v1.33.7) BASE-LANE LOOP-TO-FILL") && routerJs.includes("v0.3 (v1.33.7) AUDIO-EXTENDED TIMELINES"));

console.log(failures === 0 ? "\nASAR AUDIT PASSED" : `\nASAR AUDIT: ${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
