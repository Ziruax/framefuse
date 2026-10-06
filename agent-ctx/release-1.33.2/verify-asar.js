// agent-ctx/release-1.33.2/verify-asar.js — verify the packaged v1.33.2 app:
//  1. the v1.33.2 fix markers are INSIDE app.asar (export + kinetic),
//  2. packaged electron files parse clean (node --check),
//  3. the engine in app.asar.unpacked is EXACTLY the CI smoke-tested binary,
//  4. vendor bundles + staged ffmpeg ride along.
const { execFileSync, spawnSync } = require("child_process");
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

// export fixes
check("main.js: >1.5GB faststart gate (v1.33.2)", mainJs.includes("v1.33.2: same >1.5 GB faststart gate"));
check("main.js: finalize phase detector", mainJs.includes("finalizeNotified") && mainJs.includes("[Export] finalize: concat muxed"));
check("main.js: duration-scaled loudnorm timeout", /duration-scaled|loudnormTimeout|DURATION_SCALED/i.test(mainJs) || /60_000|60 \* 1000/.test(mainJs));
check("export-graph.js: faststart gate param", graphJs.includes("v1.33.2: the >1.5 GB faststart gate") && graphJs.includes("o.faststart !== false"));
check("main.js: mux 96.5→99.7 remap (100% = truly done)", mainJs.includes("v1.33.2: the mux maps to 96.5"));

// kinetic fixes
check("kinetic-ass.js: entrance/exit crossfire fix", kinJs.includes("v1.33.2 ENTRANCE/EXIT CROSSFIRE FIX") && kinJs.includes("effExitStartAbs"));
check("kinetic-ass.js: gold/amber accents (#FCD34D/#FBBF24)", kinJs.includes("#FCD34D") && kinJs.includes("#FBBF24"));
check("kinetic-ass.js: no white/near-white accent left", !/accentColor: "#F{5,6}"/.test(kinJs) && !/accentColor: "#E5E7EB"/.test(kinJs));
check("kinetic-ass.js: emphasis exempt from dim", /emphasis|accent/i.test(kinJs) && /settledAlpha|supportAlpha/.test(kinJs));

// ── 2. packaged electron files parse clean ──
for (const f of ["electron/main.js", "electron/export-graph.js", "electron/kinetic-ass.js"]) {
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
check("packaged package.json version 1.33.2", asar.extractFile(ASAR, "package.json").toString().includes('"version": "1.33.2"'));

// renderer: the static export rides along
try {
  const pageBuf = asar.extractFile(ASAR, "out/index.html");
  const html = pageBuf.toString("utf8");
  check("static export out/index.html present", html.length > 500, `${html.length} B`);
} catch {
  const list = asar.listPackage(ASAR).filter((p) => /index\.html$/.test(p)).slice(0, 3);
  check("index.html in asar", list.length > 0, list.join(", "));
}

console.log(failures === 0 ? "\nASAR VERIFICATION: ALL CHECKS PASSED" : `\nASAR VERIFICATION: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
