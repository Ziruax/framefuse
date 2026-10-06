// agent-ctx/release-1.33.6/verify-asar.js — verify the packaged v1.33.6 app:
//  1. the v1.33.2…v1.33.6 fix markers are INSIDE app.asar,
//  2. packaged electron files parse clean (node --check),
//  3. the engine in app.asar.unpacked is EXACTLY the CI smoke-tested binary,
//  4. vendor bundles + staged ffmpeg + DLLs ride along,
//  5. the static export carries the new UI (elapsed/ETA/library strings).
const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const UNPACKED = path.join(ROOT, "dist", "win-unpacked");
const ASAR = path.join(UNPACKED, "resources", "app.asar");
const asar = require(path.join(ROOT, "node_modules", "@electron", "asar"));

const EXPECTED_ENGINE_SHA = "367c910d5456f1abe3f0c38136242c2a5ddee9c597769c5ca69b95e2bea7d96f";
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

// ── 0. the app asar exists ──
if (!fs.existsSync(ASAR)) { console.error("no app.asar at " + ASAR); process.exit(1); }

// ── 1. extract the electron files + check markers ──
const files = [
  "electron/main.js",
  "electron/export-graph.js",
  "electron/export-singlepass.js",
  "electron/kinetic-ass.js",
  "electron/vendor/edge-tts-universal.cjs",
  "electron/vendor/groq-sdk.cjs",
];
for (const f of files) {
  const buf = asar.extractFile(ASAR, f.replace(/^\//, ""));
  const dest = path.join(OUT, f);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
}

const readSrc = (f) => fs.readFileSync(path.join(OUT, f), "utf8");

const mainJs = readSrc("electron/main.js");
const graphJs = readSrc("electron/export-graph.js");
const kinJs = readSrc("electron/kinetic-ass.js");
const spJs = readSrc("electron/export-singlepass.js");

// export fixes (v1.33.2 lineage)
check("main.js: finalize phase detector", mainJs.includes("finalizeNotified") && mainJs.includes("[Export] finalize: concat muxed"));
check("export-graph.js: faststart gate param", graphJs.includes("v1.33.2: the >1.5 GB faststart gate") && graphJs.includes("o.faststart !== false"));

// kinetic fixes
check("kinetic-ass.js: entrance/exit crossfire fix", kinJs.includes("v1.33.2 ENTRANCE/EXIT CROSSFIRE FIX") && kinJs.includes("effExitStartAbs"));
check("kinetic-ass.js: gold/amber accents (#FCD34D/#FBBF24)", kinJs.includes("#FCD34D") && kinJs.includes("#FBBF24"));

// v1.33.3 export hardening (stall watchdog + output verification)
check("main.js: STALL WATCHDOG present", mainJs.includes("v1.33.3 STALL WATCHDOG") && mainJs.includes("stallWatchdog"));
check("main.js: verifyExportOutputAsync defined + used twice", mainJs.split("verifyExportOutputAsync").length >= 3);
check("main.js: two-step path verifies output", /const size = await verifyExportOutputAsync\(outputPath, actualTotalSec, "Export"\)/.test(mainJs));
check("main.js: smart path verifies output", /const size = await verifyExportOutputAsync\(outputPath, totalSec, "Export"\)/.test(mainJs));

// ── 2. packaged electron files parse clean ──
for (const f of ["electron/main.js", "electron/export-graph.js", "electron/kinetic-ass.js", "electron/export-singlepass.js"]) {
  const r = spawnSync(process.execPath, ["--check", path.join(OUT, f)], { encoding: "utf8" });
  check(`node --check ${f}`, r.status === 0, r.status === 0 ? "" : String(r.stderr).slice(0, 200));
}

// ── 3. engine binary identity ──
const engineUnpacked = path.join(UNPACKED, "resources", "app.asar.unpacked", "rust-engine", "framefuse-engine.win32-x64.node");
if (fs.existsSync(engineUnpacked)) {
  const engineSha = sha(engineUnpacked);
  check("engine sha256 == CI smoke-tested binary", engineSha === EXPECTED_ENGINE_SHA, engineSha.slice(0, 16) + "…");
} else {
  check("engine present in app.asar.unpacked/rust-engine", false, "file missing");
}

// ── 4. staged ffmpeg + DLLs ride along ──
const ff = path.join(UNPACKED, "resources", "ffmpeg", "win", "ffmpeg.exe");
const fp = path.join(UNPACKED, "resources", "ffmpeg", "win", "ffprobe.exe");
check("packaged ffmpeg.exe", fs.existsSync(ff) && fs.statSync(ff).size > 100e6, fs.existsSync(ff) ? `${(fs.statSync(ff).size / 1e6).toFixed(0)} MB` : "missing");
check("packaged ffprobe.exe", fs.existsSync(fp) && fs.statSync(fp).size > 100e6);
const dllDir = path.join(UNPACKED, "resources", "ffmpeg", "win", "dll");
const need = ["avcodec-61.dll", "avformat-61.dll", "avutil-59.dll", "swscale-8.dll", "swresample-5.dll"];
check("packaged FFmpeg 7.1 shared DLLs", need.every((d) => fs.existsSync(path.join(dllDir, d))));

// ── 5. version stamp in the packaged app ──
check("packaged package.json version 1.33.6", asar.extractFile(ASAR, "package.json").toString().includes('"version": "1.33.6"'));

// ── 6. static export present + the NEW v1.33.6 UI strings ──
{
  let html = "";
  try { html = asar.extractFile(ASAR, "out/index.html").toString(); } catch {}
  check("static export out/index.html present", html.length > 10000);
  // the page JS chunks live next to index.html — scan them for the new UI
  let chunkText = html;
  try {
    const listed = asar.listPackage(ASAR).map((p) => String(p).replace(/\\/g, "/")).filter((p) => /^\/?out\/_next\/static\/chunks\/.*\.js$/.test(p));
    for (const p of listed) {
      try { chunkText += asar.extractFile(ASAR, p.replace(/^\//, "")).toString(); } catch {}
    }
  } catch {}
  check("out chunks: wall-clock elapsed label", chunkText.includes("elapsed"), chunkText.includes("elapsed") ? "" : "string 'elapsed' missing");
  check("out chunks: ETA estimating placeholder", chunkText.includes("estimating"));
  check("out chunks: Not-on-timeline library section", chunkText.includes("Not on timeline"));
  check("out chunks: hold-to-end image loop label", chunkText.includes("Hold to the timeline end") || chunkText.includes("Hold image to timeline end"));
  check("out chunks: audio-only export toast", chunkText.includes("Exporting audio-only timeline"));
}

// ── 7. v1.33.4 markers ──
check("main.js: >1.5GB faststart gates (two-step + smart)",
  /skipFaststart = expectedOutBytes > 1\.5 \* 1024 \* 1024 \* 1024/.test(mainJs) && /spSkipFaststart = spExpectedOutBytes > 1\.5 \* 1024 \* 1024 \* 1024/.test(mainJs));
check("main.js: v1.33.4 runFfmpeg (maxMs + faststart message + crawl + noFinalizeOnTotal)",
  mainJs.includes("opts.maxMs") && mainJs.includes("Starting second pass") && mainJs.includes("onFinalizeProgress") && mainJs.includes("__FFMAX__") && mainJs.includes("noFinalizeOnTotal"));
check("main.js: mux band 97→99.7 with video-length denominator (both paths)",
  mainJs.includes("0.97 + 0.027") && mainJs.includes("muxBandSec") && mainJs.includes("spMuxBandSec"));
check("main.js: master-measure live band 96.5→96.9", /96\.5 \+ 0\.4 \* Math\.min/.test(mainJs));

// ── 8. v1.33.5 markers ──
check("main.js: windowed measurement policy (90s window)",
  mainJs.includes("const MEASURE_WINDOW_MAX_SEC = 120") && mainJs.includes("const MEASURE_WINDOW_SEC = 90") &&
  mainJs.includes("function shrinkMeasureWindow") && mainJs.includes("function effectiveMeasureSec"));
check("main.js: OUT-TIME STALL GUARD in runFfmpeg",
  mainJs.includes("OUT-TIME STALL GUARD") && mainJs.includes("outTimeStallMs") && mainJs.includes("outTimeStalled"));
check("main.js: watchdog kills route through killProc (taskkill tree on win32)",
  mainJs.includes("killProc(proc); // v1.33.5: Windows needs taskkill /f /t for a clean tree kill"));
check("main.js: mux/mix hard duration caps", (mainJs.match(/maxMs: Math\.min\(7200000, Math\.max\(600000, (actualTotalSec|tailDurSec) \* 750\)\)/g) || []).length >= 2);
check("main.js: phase-local ETA (mux + mix)",
  mainJs.includes("const muxEta = { lastSec: 0, lastAt: 0, rate: 0 }") && mainJs.includes("const mixEta = { lastSec: 0, lastAt: 0, rate: 0 }"));
check("export-graph.js: NO dynamic-loudnorm fallback", !graphJs.includes('|| "loudnorm=I=-16:TP=-1.5:LRA=11"') && graphJs.includes("v1.33.5 (stuck-at-100% root cause): a missing/unusable measurement"));
check("export-graph.js: finite -stream_loop bounds", graphJs.includes("const loopCountFor =") && graphJs.includes("v1.33.5 FINITE LOOP BOUNDS"));
check("export-singlepass.js: finite loop bounds", spJs.includes("loopCountFor") && spJs.includes("v1.33.5 FINITE LOOP BOUNDS"));

// ── 9. v1.33.6 markers (THE stuck-at-100% progress-model root cause) ──
check("main.js: pool fraction uses the pool's OWN work total (no double-count)",
  mainJs.includes("v1.33.6 (stuck-at-100% ROOT CAUSE — full-handler repro)") &&
  mainJs.includes("poolJobs.reduce((n, j) => n + Math.max(1, Number(j.durationMs) || 1), 0)") &&
  mainJs.includes("Math.min(totalSec, doneMs / 1000)"));
check("main.js: 100% reserved for done (99.9 in-flight clamp)",
  mainJs.includes("v1.33.6 (stuck-at-100% report — full-handler repro): 100% is RESERVED") &&
  /percent >= 100 \? 100 : 99\.9/.test(mainJs));
check("main.js: in-flight ETA 0 → estimating",
  mainJs.includes('etaSec === 0 && exportPhase !== "done" ? undefined : etaSec'));
check("main.js: milestone ETA calls removed (95.4/95.5/96/96.5/96.9 → undefined)",
  !/etaFor\(0\.9(54|55|6|65|69)\)/.test(mainJs) &&
  mainJs.includes("etaFor is pool-fraction based — dishonest past the pool"));
check("main.js: finalize crawl caps at 99.9 (code uses 0.2, never 0.27)",
  /sendProgress\(99\.7 \+ 0\.2 \* Math\.min/.test(mainJs) && !/sendProgress\(99\.7 \+ 0\.27/.test(mainJs));
check("main.js: two-step tail filler (black tail when visuals end early)",
  mainJs.includes("v1.33.6 (the \"output is 10.0s long but the timeline is"));
check("main.js: smart-path tail filler",
  mainJs.includes("v1.33.6 SMART-PATH TAIL FILLER") && mainJs.includes("tail filler (smart)"));
check("main.js: audio-only export gate",
  mainJs.includes("v1.33.6 AUDIO-ONLY EXPORT") && mainJs.includes("audio-only timeline: 0 visual segment"));
check("main.js: tail-filler ASS caption window (captions continue on the black tail)",
  /buildAssDocument\([\s\S]{0,500}visualEndMs, visualEndMs \+ tailFillerMs, tailFillerMs/.test(mainJs) &&
  /buildAssDocument\([\s\S]{0,500}Math\.round\(spVisualSec \* 1000\), Math\.round\(totalSec \* 1000\), spFillMs/.test(mainJs));
check("main.js: filler phase-local ETA + hard cap",
  mainJs.includes("const fillEta = { lastSec: 0, lastAt: 0, rate: 0 }") && mainJs.includes("tailDurSec * 750"));

// renderer sources (v1.33.6)
{
  const headerSrc = fs.readFileSync(path.join(ROOT, "src", "components", "Header.tsx"), "utf8");
  check("Header.tsx (source): BUILD_VERSION 1.33.6", headerSrc.includes('const BUILD_VERSION = "1.33.6"'));
  check("Header.tsx (source): wall-clock elapsed chip", headerSrc.includes("v1.33.6: WALL-CLOCK elapsed"));
  check("Header.tsx (source): ETA 0 guard (in flight reads estimating)", headerSrc.includes("(exportProgress.eta > 0 || exportProgress.phase === \"done\")"));
  const pageSrc = fs.readFileSync(path.join(ROOT, "src", "app", "page.tsx"), "utf8");
  check("page.tsx (source): audio-only export gate", pageSrc.includes("v1.33.6 AUDIO-ONLY EXPORT"));
  check("page.tsx (source): image fallback for unparseable names", pageSrc.includes("v1.33.6: unparseable IMAGES get the same duration-kind fallback"));
  check("page.tsx (source): timelineHidden filter", pageSrc.includes("itemEdits[e.id]?.timelineHidden !== true"));
  const typesSrc = fs.readFileSync(path.join(ROOT, "src", "lib", "merger", "types.ts"), "utf8");
  check("types.ts (source): ItemEdit.timelineHidden + image loop doc", typesSrc.includes("timelineHidden?: boolean") && typesSrc.includes("IMAGES loop too"));
  const tlSrc = fs.readFileSync(path.join(ROOT, "src", "lib", "merger", "timeline.ts"), "utf8");
  check("timeline.ts (source): images loop-to-fill", tlSrc.includes("const baseLoop = edit?.loop === true && track === 0;"));
  const mpSrc = fs.readFileSync(path.join(ROOT, "src", "components", "MediaPanel.tsx"), "utf8");
  check("MediaPanel.tsx (source): Not-on-timeline library + image hold toggle", mpSrc.includes("Not on timeline") && mpSrc.includes("Hold to the timeline end"));
}

console.log(failures === 0 ? `\nASAR AUDIT v1.33.6: ALL CHECKS PASSED` : `\nASAR AUDIT v1.33.6: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
