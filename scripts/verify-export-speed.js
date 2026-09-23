#!/usr/bin/env node
/**
 * scripts/verify-export-speed.js — v1.14.4 export-speed regression round.
 * Field report: "after version 12 and 13 export speed became terrible."
 *
 * Unit-verifies the four v1.14.4 fixes against the REAL export-native
 * handler + real ffmpeg on this (genuinely Tier-3, 2-core) sandbox:
 *
 *   S1  hwDecodeGate — the pure v1.12-regression gate: ride hardware decode
 *       ONLY when it measured not-slower (the v1.12 gate rode up to 1.5×
 *       SLOWER decode on every worker input).
 *   S2  mapBoundedConcurrent — order preservation + the concurrency bound
 *       (the srcFacts gathering was a serial for-await).
 *   S3  probeHwDecode disk persistence — a fresh session must return the
 *       same verdict with ZERO probe-arm ffmpeg spawns (the in-memory-only
 *       cache re-paid 2×72-frame decodes per ≥20s source after every app
 *       restart).
 *   S4  THE A/B BENCH — the user's shape (image storyboard + burned
 *       captions + music, 240 s, 1080p) exported twice: fast mode ON
 *       (auto 720p-class) vs OFF (1080p). Asserts the payload, the real
 *       output dimensions, duration, caption visibility at the downscaled
 *       dims, and prints the measured wall-clock speedup.
 *   S5  the fast-mode gate matrix — below-duration / off / cinema /
 *       portrait / square / 720p-request all keep (or map) the right
 *       resolution, never silently.
 *   S6  smart-mode pool widening (A8 4-logical mask) — a 50 %-clean
 *       image-heavy timeline now widens to 4×1 (v1.14.1 widened only the
 *       parallel pass; smart-mode 30–70 % dirty ran 2×2).
 *
 * Run: node scripts/verify-export-speed.js
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { spawnSync, spawn: realSpawn } = require("child_process");
const cp = require("child_process");

const ROOT = path.join(__dirname, "..");
const FF = require(path.join(ROOT, "node_modules", "ffmpeg-static"));
const FFPROBE = "/usr/bin/ffprobe";
const TMP = "/tmp/ffspeed";
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(TMP, "userData"), { recursive: true });

// ── spawn interception (BEFORE main.js loads — it destructures at require) ──
let spawnLog = [];
cp.spawn = function (bin, args, opts) {
  if (String(bin).includes("ffmpeg")) spawnLog.push(args.join(" "));
  return realSpawn.call(this, bin, args, opts);
};

// ── electron stub (verify-tier-pools pattern) ──────────────────────────
const handlers = {};
const electronStub = {
  app: {
    whenReady: () => Promise.resolve(),
    on: () => {},
    getPath: (k) => path.join(TMP, "userData"),
    getName: () => "FrameFuse",
    getVersion: () => "1.14.4",
    isReady: () => true,
    isPackaged: false,
    quit: () => {},
    commandLine: { appendSwitch: () => {} },
  },
  BrowserWindow: class {
    constructor() {
      this.webContents = { setWindowOpenHandler: () => ({ action: "deny" }), on: () => {}, send: () => {} };
    }
    loadURL() {}
    loadFile() {}
    on() {}
    static getAllWindows() { return []; }
  },
  ipcMain: { handle: (name, fn) => { handlers[name] = fn; }, on: () => {} },
  dialog: {},
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  shell: {},
  utilityProcess: { fork: () => ({}) },
};
const resolvedElectron = require.resolve("electron");

function loadMain() {
  // Fresh module state per mask (main.js caches topology + hardware profile
  // at require time). Re-installs the electron stub + the spawn interceptor.
  delete require.cache[resolvedElectron];
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(path.join(ROOT, "electron"))) delete require.cache[k];
  }
  spawnLog = [];
  const stubModule = new Module(resolvedElectron, null);
  stubModule.filename = resolvedElectron;
  stubModule.loaded = true;
  stubModule.exports = electronStub;
  require.cache[resolvedElectron] = stubModule;
  const main = require(path.join(ROOT, "electron", "main.js"));
  return { handler: handlers["export-native"], main };
}

// ── fixtures ────────────────────────────────────────────────────────────
console.log("── fixtures ──");
function run(bin, args, timeout = 180000) {
  const r = spawnSync(bin, args, { timeout });
  if (r.status !== 0) throw new Error(`${bin} failed: ${r.stderr && r.stderr.toString().slice(0, 400)}`);
}
// 1920×1080 source images (the user's storyboard shape)
for (let k = 0; k < 8; k++) {
  run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", `testsrc2=s=1920x1080:r=30`, "-frames:v", "1", `${TMP}/img${k}.png`]);
}
// portrait + square masters for the aspect-ladder checks
run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
  "-i", `testsrc2=s=1080x1920:r=30`, "-frames:v", "1", `${TMP}/port0.png`]);
run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
  "-i", `testsrc2=s=1080x1080:r=30`, "-frames:v", "1", `${TMP}/sq0.png`]);
// 240 s music bed (no loop — keeps the audio bus deterministic)
run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
  "-i", "sine=frequency=220:r=48000:d=240,volume=0.3", "-c:a", "pcm_s16le", `${TMP}/music240.wav`]);
// small video for the hw-decode persistence round trip
run(FF, ["-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30",
  "-t", "4", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
  "-g", "48", "-keyint_min", "48", "-pix_fmt", "yuv420p", `${TMP}/probe_src.mp4`]);
// 640×360 video + music for the smart-widening case. GOP 12 (0.4 s) keeps
// the keyframe-snapping expansion around the image windows tight — the
// timeline stays comfortably ≥30 % clean (smart-render, not parallel-pass).
for (let v = 0; v < 3; v++) {
  run(FF, ["-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30",
    "-t", "4", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-g", "12", "-keyint_min", "12", "-pix_fmt", "yuv420p", `${TMP}/sv${v}.mp4`]);
}
for (let k = 0; k < 3; k++) {
  run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", `testsrc2=s=1280x720:r=30`, "-frames:v", "1", `${TMP}/si${k}.png`]);
}
run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
  "-i", "sine=frequency=220:r=48000:d=30,volume=0.3", "-c:a", "pcm_s16le", `${TMP}/music30.wav`]);

const captionSettings = {
  enabled: true, presetId: "clean", fontSizeScale: 1, wordMode: "off", animation: "none",
  customColor: null, customPosition: null, fontId: "arial", fontWeight: 600,
};
/** Cues spanning [0, totalMs) so the timeline is 100 % dirty (parallel-pass). */
function fullCues(totalMs, stepMs = 6000) {
  const cues = [];
  for (let t = 0; t + stepMs <= totalMs; t += stepMs) {
    cues.push({ startMs: t + 200, endMs: t + stepMs - 200, text: "SPEED TEST CAPTIONS", words: [] });
  }
  return cues;
}
function imageTimeline(count, eachMs, prefix = "img", offset = 0) {
  return Array.from({ length: count }, (_, k) => ({
    id: `${prefix}${k}`, fileName: `${prefix}${k}.png`, mediaType: "image",
    imagePath: `${TMP}/${prefix}${k}.png`,
    startMs: offset + k * eachMs, endMs: offset + k * eachMs + eachMs, durationMs: eachMs,
    track: 0, volume: 1, trimInMs: 0, speed: 1, sourceDurationMs: null,
    direction: k % 2 ? "out" : "in",
  }));
}

function probeStream(p) {
  const r = spawnSync(FFPROBE, ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0", p], { encoding: "utf8" });
  const cells = String(r.stdout || "").trim().split(",");
  return { w: parseInt(cells[0], 10) || 0, h: parseInt(cells[1], 10) || 0 };
}
function probeDuration(p) {
  const r = spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p], { encoding: "utf8" });
  return parseFloat(r.stdout || "0");
}
/** White-pixel fraction of the frame at tSec (caption-visibility probe). */
function whiteFraction(videoPath, tSec) {
  const out = `${TMP}/frame.raw`;
  fs.rmSync(out, { force: true });
  const r = spawnSync(FF, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(tSec),
    "-i", videoPath, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", out]);
  if (r.status !== 0 || !fs.existsSync(out)) return 0;
  const buf = fs.readFileSync(out);
  let white = 0, total = 0;
  for (let p = 0; p + 2 < buf.length; p += 3) {
    total++;
    if (buf[p] > 225 && buf[p + 1] > 225 && buf[p + 2] > 225) white++;
  }
  return total ? white / total : 0;
}

async function runExport(handler, outPath, o = {}) {
  const fakeEvent = { sender: { isDestroyed: () => false, send: () => {} } };
  const segments = o.segments;
  const totalMs = segments.reduce((a, s) => Math.max(a, s.endMs ?? (s.startMs || 0) + s.durationMs), 0);
  spawnLog = [];
  const t0 = Date.now();
  const result = await handler(fakeEvent, {
    outputPath: outPath,
    fps: o.fps || 30,
    width: o.width, height: o.height,
    bitrateMbps: 8, quality: o.quality || "social", crf: 20, audioKbps: 192,
    kenBurns: { enabled: true, intensity: 50, direction: "in" },
    segments,
    audioPath: o.audioPath || `${TMP}/music240.wav`,
    audio: { normalize: false, masterVolume: 1, fadeInMs: 300, fadeOutMs: 500, musicVolume: 0.8, musicStartMs: 0, musicLoop: false },
    captionSettings: o.captions === false ? { enabled: false } : captionSettings,
    subtitleCues: o.captions === false ? [] : (o.cues || fullCues(totalMs)),
    headlines: [],
    transition: null,
    watermark: null,
    overlays: [],
    sfx: [],
    ...(o.fastMode === false ? { fastMode: false } : {}),
  });
  return { ms: Date.now() - t0, result, spawnLog: spawnLog.slice() };
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? "PASS" : "FAIL"} — ${name}${detail != null ? ` (${detail})` : ""}`);
  cond ? pass++ : fail++;
}

(async () => {
  // ══ S1: hwDecodeGate unit (the v1.12 regression gate) ════════════════
  console.log("\n══ S1: hwDecodeGate — ride hardware decode only when NOT slower ══");
  const { main } = loadMain();
  const gate = main.hwDecodeGate;
  check("hw arm 10 % faster → ride", gate(1000, 900) === true);
  check("hw arm equal → ride (noise margin ≤ +5 %)", gate(1000, 1000) === true);
  check("hw arm +4.9 % → ride (measurement noise)", gate(1000, 1049) === true);
  check("hw arm +5.1 % → CPU (v1.14.4 gate closes here)", gate(1000, 1051) === false);
  check("hw arm 1.4× SLOWER → CPU (v1.12 rode this — THE regression)", gate(1000, 1400) === false);
  check("hw arm ≥1.5× (WARP) → CPU", gate(1000, 2000) === false);
  check("invalid timings → CPU", gate(0, 100) === false && gate(100, 0) === false);

  // ══ S2: mapBoundedConcurrent unit ════════════════════════════════════
  console.log("\n══ S2: mapBoundedConcurrent — order + bounded parallelism ══");
  const mbc = main.mapBoundedConcurrent;
  let live = 0, peak = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);
  const out = await mbc(items, 4, async (v) => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5 + (v % 3) * 5));
    live--;
    return v * 10;
  });
  check("results in slot order", JSON.stringify(out) === JSON.stringify(items.map((v) => v * 10)));
  check("concurrency respected (peak ≤ 4)", peak <= 4, `peak=${peak}`);
  check("concurrency actually used (peak ≥ 2)", peak >= 2, `peak=${peak}`);
  const single = await mbc([1, 2, 3], 4, async (v) => v + 1);
  check("small array maps fine", JSON.stringify(single) === JSON.stringify([2, 3, 4]));

  // ══ S3: probeHwDecode disk persistence (fresh session = zero re-probe) ══
  console.log("\n══ S3: hw-decode verdict persists across sessions ══");
  const probeSrc = `${TMP}/probe_src.mp4`;
  const t1 = Date.now();
  const verdict1 = await main.probeHwDecode(probeSrc);
  const probeMs1 = Date.now() - t1;
  const arms = spawnLog.filter((a) => a.includes(probeSrc) && a.includes("-frames:v 48"));
  check("session 1 measured both arms (48-frame probes ran)", arms.length === 2, `${arms.length} arm(s)`);
  const cacheFile = path.join(TMP, "userData", "probe-cache-v9.json");
  const disk = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  const st = fs.statSync(probeSrc);
  const key = `${probeSrc}|${Math.round(st.mtimeMs)}|${st.size}`;
  check("verdict written to disk cache", disk.hwDecode && disk.hwDecode[key] &&
    disk.hwDecode[key].verdict === verdict1, `verdict=${JSON.stringify(verdict1)}`);
  // fresh session: re-require main.js (resets the in-memory Map) — the
  // verdict must come from DISK with zero probe-arm spawns. (The re-require
  // also kicks the async encoder warm-up; the arm-signature filter is immune
  // to those spawns.)
  const fresh = loadMain();
  const t2 = Date.now();
  const verdict2 = await fresh.main.probeHwDecode(probeSrc);
  const probeMs2 = Date.now() - t2;
  const arms2 = spawnLog.filter((a) => a.includes(probeSrc) && a.includes("-frames:v 48"));
  check("fresh session returns the SAME verdict", verdict2 === verdict1, `${JSON.stringify(verdict1)} → ${JSON.stringify(verdict2)}`);
  check("fresh session re-probed ZERO times (disk-served)", arms2.length === 0, `${arms2.length} arm(s)`);
  console.log(`  · probe cost: session 1 ${probeMs1}ms (2 real arms) → fresh session ${probeMs2}ms (disk hit)`);

  // ══ S4: THE A/B BENCH — fast mode vs 1080p on this Tier-3 box ═════════
  console.log("\n══ S4: A/B bench — 240s image storyboard + captions + music, 1080p request ══");
  const benchHandler = fresh.handler;
  const benchSegs = imageTimeline(8, 30000);
  // warm-up export first so both arms share warm probe caches
  await runExport(benchHandler, `${TMP}/warm.mp4`, {
    segments: imageTimeline(3, 2000, "img"), fps: 3, width: 320, height: 180,
    audioPath: `${TMP}/music30.wav`, captions: false,
  });
  const A = await runExport(benchHandler, `${TMP}/A_fast.mp4`, {
    segments: benchSegs, fps: 3, width: 1920, height: 1080,
  });
  const B = await runExport(benchHandler, `${TMP}/B_full.mp4`, {
    segments: benchSegs, fps: 3, width: 1920, height: 1080, fastMode: false,
  });
  const dimsA = probeStream(`${TMP}/A_fast.mp4`);
  const dimsB = probeStream(`${TMP}/B_full.mp4`);
  check("A: fastMode ran (payload)", A.result.fastMode === true);
  check("A: fastModeFrom/To reported", A.result.fastModeFrom === "1920x1080" && A.result.fastModeTo === "1280x720",
    `${A.result.fastModeFrom} → ${A.result.fastModeTo}`);
  check("A: output really is 1280x720", dimsA.w === 1280 && dimsA.h === 720, `${dimsA.w}x${dimsA.h}`);
  check("A: duration preserved (240s)", Math.abs(probeDuration(`${TMP}/A_fast.mp4`) - 240) <= 2.5,
    probeDuration(`${TMP}/A_fast.mp4`).toFixed(2) + "s");
  check("A: captions visible at the downscaled dims", whiteFraction(`${TMP}/A_fast.mp4`, 3.0) > 0.0008,
    (whiteFraction(`${TMP}/A_fast.mp4`, 3.0) * 100).toFixed(3) + "% white");
  check("B: fast mode honored OFF", !B.result.fastMode, JSON.stringify(B.result.fastMode));
  check("B: output stays 1920x1080", dimsB.w === 1920 && dimsB.h === 1080, `${dimsB.w}x${dimsB.h}`);
  check("B: duration preserved (240s)", Math.abs(probeDuration(`${TMP}/B_full.mp4`) - 240) <= 2.5,
    probeDuration(`${TMP}/B_full.mp4`).toFixed(2) + "s");
  const speedup = B.ms / Math.max(1, A.ms);
  console.log(`  · WALL CLOCK: fast mode ${(A.ms / 1000).toFixed(1)}s vs full-res ${(B.ms / 1000).toFixed(1)}s → ${speedup.toFixed(2)}× faster`);
  check("A/B: fast mode measurably faster (≥1.15×)", speedup >= 1.15, `${speedup.toFixed(2)}×`);

  // ══ S5: the fast-mode gate matrix (never silent, never wrong) ═════════
  console.log("\n══ S5: fast-mode gate matrix ══");
  // G1: 239 999ms — one millisecond below the ≥240s gate → no fast mode
  // (7 images × 30 s + 1 × 29 999 ms)
  const belowSegs = imageTimeline(7, 30000);
  belowSegs.push({
    ...imageTimeline(1, 29999)[0], id: "img7", fileName: "img7.png",
    imagePath: `${TMP}/img7.png`, startMs: 210000, endMs: 239999, durationMs: 29999,
  });
  const G1 = await runExport(benchHandler, `${TMP}/G1.mp4`, {
    segments: belowSegs, fps: 1, width: 1920, height: 1080,
  });
  check("G1: <240s keeps requested resolution", !G1.result.fastMode && probeStream(`${TMP}/G1.mp4`).w === 1920,
    `${probeStream(`${TMP}/G1.mp4`).w}x${probeStream(`${TMP}/G1.mp4`).h}`);
  // G2: fastMode:false (the Settings off switch)
  const G2 = await runExport(benchHandler, `${TMP}/G2.mp4`, {
    segments: benchSegs, fps: 1, width: 1920, height: 1080, fastMode: false,
  });
  check("G2: payload off-switch honored", !G2.result.fastMode && probeStream(`${TMP}/G2.mp4`).w === 1920);
  // G3: cinema quality keeps the master resolution
  const G3 = await runExport(benchHandler, `${TMP}/G3.mp4`, {
    segments: benchSegs, fps: 1, width: 1920, height: 1080, quality: "cinema",
  });
  check("G3: cinema keeps full resolution", !G3.result.fastMode && probeStream(`${TMP}/G3.mp4`).w === 1920);
  // G4: portrait 1080×1920 → 720×1280 (aspect ladder)
  const portSegs = imageTimeline(8, 30000, "img").map((s) => ({
    ...s, imagePath: `${TMP}/port0.png`, fileName: "port0.png",
  }));
  const G4 = await runExport(benchHandler, `${TMP}/G4.mp4`, {
    segments: portSegs, fps: 1, width: 1080, height: 1920,
  });
  const dimsG4 = probeStream(`${TMP}/G4.mp4`);
  check("G4: portrait maps to 720x1280", G4.result.fastModeTo === "720x1280" && dimsG4.w === 720 && dimsG4.h === 1280,
    `${dimsG4.w}x${dimsG4.h} · ${G4.result.fastModeTo}`);
  // G5: square 1080×1080 → 720×720
  const sqSegs = imageTimeline(8, 30000, "img").map((s) => ({
    ...s, imagePath: `${TMP}/sq0.png`, fileName: "sq0.png",
  }));
  const G5 = await runExport(benchHandler, `${TMP}/G5.mp4`, {
    segments: sqSegs, fps: 1, width: 1080, height: 1080,
  });
  const dimsG5 = probeStream(`${TMP}/G5.mp4`);
  check("G5: square maps to 720x720", G5.result.fastModeTo === "720x720" && dimsG5.w === 720 && dimsG5.h === 720,
    `${dimsG5.w}x${dimsG5.h}`);
  // G6: a 720p request never triggers fast mode
  const G6 = await runExport(benchHandler, `${TMP}/G6.mp4`, {
    segments: benchSegs, fps: 1, width: 1280, height: 720,
  });
  check("G6: 720p request untouched", !G6.result.fastMode && probeStream(`${TMP}/G6.mp4`).w === 1280);

  // ══ S6: smart-mode pool widening (A8 mask, 50 % clean image timeline) ══
  console.log("\n══ S6: smart-mode filter-pool widening (A8 4-logical mask) ══");
  const os = require("os");
  const realCpus = os.cpus;
  os.cpus = () => Array.from({ length: 4 }, () => ({ model: "AMD A8-5550M APU with Radeon(tm) HD Graphics" }));
  const a8 = loadMain();
  // 60 %-clean image-heavy timeline: v0(0-4) si0(4-6) v1(6-10) si1(10-12)
  // v2(12-16) siX(16-18) — 3 copyable videos + 3 Ken Burns images.
  const mkImg = (id, imgPath, startMs) => ({
    id, fileName: path.basename(imgPath), mediaType: "image", imagePath: imgPath,
    startMs, endMs: startMs + 2000, durationMs: 2000, track: 0, volume: 1,
    trimInMs: 0, speed: 1, sourceDurationMs: null, direction: "in",
  });
  const mkVid = (id, vp, startMs) => ({
    id, fileName: path.basename(vp), mediaType: "video", videoPath: vp,
    startMs, endMs: startMs + 4000, durationMs: 4000, track: 0, volume: 1,
    trimInMs: 0, speed: 1, sourceDurationMs: 4000, direction: "in",
  });
  const mixed = [
    mkVid("v0", `${TMP}/sv0.mp4`, 0),
    mkImg("si0", `${TMP}/si0.png`, 4000),
    mkVid("v1", `${TMP}/sv1.mp4`, 6000),
    mkImg("si1", `${TMP}/si1.png`, 10000),
    mkVid("v2", `${TMP}/sv2.mp4`, 12000),
    mkImg("siX", `${TMP}/si1.png`, 16000),
  ];
  const M = await runExport(a8.handler, `${TMP}/M.mp4`, {
    segments: mixed, fps: 30, width: 640, height: 360,
    audioPath: `${TMP}/music30.wav`, captions: false,
  });
  const encArgv = M.spawnLog.filter((a) => a.includes("-filter_complex_script"));
  const oneThreads = encArgv.filter((a) => a.includes("-threads 1")).length;
  check("M: mode = smart-render (50 % clean)", M.result.mode === "smart-render", M.result.mode);
  check("M: pool widened to 4 workers", M.result.poolWorkers === 4, String(M.result.poolWorkers));
  check("M: dirty windows ride -threads 1 (no 2× oversubscription)", oneThreads >= Math.min(2, encArgv.length),
    `${oneThreads}/${encArgv.length} graph argv`);
  check("M: clean copies present", (M.result.copiedClips || 0) >= 1, String(M.result.copiedClips));
  check("M: duration 18s", Math.abs(probeDuration(`${TMP}/M.mp4`) - 18) <= 0.4, probeDuration(`${TMP}/M.mp4`).toFixed(2) + "s");
  os.cpus = realCpus;

  console.log(`\nRESULT: ${pass} passed, ${fail} failed${fail ? " — FAILURES above" : ""}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
