// agent-ctx/release-1.33.8/verify-asar.js — verify the CI-built v1.33.8 app:
//   1. the v1.33.8 fix markers are INSIDE app.asar (extracted from the
//      shipped NSIS installer),
//   2. the engine in app.asar.unpacked is EXACTLY the CI smoke-tested binary,
//   3. the FFmpeg 7.1 DLLs + static export ride along,
//   4. packaged electron files parse clean.
const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
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

// ── 2. v1.33.8 markers ──
check("main.js: v1.33.8 audio-extended honest verification (visualTotalSec)",
  mainJs.includes("v1.33.8: audio-extended timelines (audio longer than the visuals) are") &&
  mainJs.includes("visualTotalSec") &&
  mainJs.includes("stopped at the last VISUAL frame instead of"));
check("main.js: both verify call sites pass the visual span",
  (mainJs.match(/verifyExportOutputAsync\(outputPath, (totalSec|actualTotalSec), "Export", segmentsTotalMs \/ 1000\)/g) || []).length === 2);
check("router: v1.33.8 etaMs NUMBER passthrough (done event ETA 0)",
  routerJs.includes("v1.33.8: etaMs is a NUMBER") && routerJs.includes("Number.isFinite(p.etaMs)"));

// ── 3. the engine binary identity ──
const enginePath = path.join(EX, "resources", "app.asar.unpacked", "rust-engine", "framefuse-engine.win32-x64.node");
const engineSha = fs.existsSync(enginePath) ? sha(enginePath) : "";
check("engine: EXACT CI smoke-tested binary", engineSha === EXPECTED_ENGINE_SHA, engineSha.slice(0, 16));
check("engine: version 0.4.0 shipped (engine-info from the artifact)",
  (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, "engine-info.json"), "utf8")).engineVersion === "0.4.0"; } catch { return false; } })());

// ── 4. FFmpeg 7.1 DLLs + CLI ──
for (const dll of ["avcodec-61.dll", "avformat-61.dll", "avutil-59.dll", "swscale-8.dll", "swresample-5.dll"]) {
  check(`ffmpeg dll staged: ${dll}`, fs.existsSync(path.join(EX, "resources", "ffmpeg", "win", "dll", dll)));
}
check("ffmpeg CLI staged (win)", fs.existsSync(path.join(EX, "resources", "ffmpeg", "win", "ffmpeg.exe")));

// ── 5. the static export ──
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
check("out chunks: v1.33.7 time-UI retained (elapsed + ETA)",
  chunkText.includes("Wall-clock time since the export started") && chunkText.includes("Estimated time remaining (this phase)"));

// ── 6. retained v1.33.4–7 markers (regression guard) ──
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
