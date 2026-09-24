#!/usr/bin/env node
/**
 * scripts/verify-tier-pools.js — v1.14.1 engine regression check.
 *
 * Drives the REAL export-native handler (electron stub pattern) through the
 * two pool shapes that changed:
 *   T1: 4-logical mask (the A8-5550M shape) + an IMAGE-heavy timeline →
 *       the pool must WIDEN to 4 single-thread processes (parallel-pass
 *       windows = 4, two-step poolN = 4) — the v1.12.1 filter shape the
 *       v1.13 Tier-3 2×2 recipe took away.
 *   T2: 4-logical mask + a VIDEO-dominated timeline → encode pool stays
 *       2×2 (the module-FPU-friendly shape for x264-dominant work).
 *   T3: 6-strong-core mask (modern CPU) → Tier 2, no widening.
 *   T4: the disclaimer payload (v1.14 display-time shift) still exports
 *       correctly through the widened pool (duration + parity).
 *
 * Run: node scripts/verify-tier-pools.js
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { spawnSync, spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FF = require(path.join(ROOT, "node_modules", "ffmpeg-static"));
const TMP = "/tmp/fftiercheck";
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let spawnLog = [];
const realSpawn = spawn;
const cp = require("child_process");
cp.spawn = function (bin, args, opts) {
  if (String(bin).includes("ffmpeg")) spawnLog.push(args.join(" "));
  return realSpawn.call(this, bin, args, opts);
};

const handlers = {};
const electronStub = {
  app: {
    whenReady: () => Promise.resolve(),
    on: () => {},
    getPath: (k) => path.join(TMP, "userData"),
    getName: () => "FrameFuse",
    getVersion: () => "1.14.5",
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
const stubModule = new Module(resolvedElectron, null);
stubModule.filename = resolvedElectron;
stubModule.loaded = true;
stubModule.exports = electronStub;
require.cache[resolvedElectron] = stubModule;

console.log("── fixtures ──");
const W = 640, H = 360, FPS = 30;
function genVideo(name, dur) {
  spawnSync(FF, ["-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc2=s=${W}x${H}:r=${FPS}`,
    "-f", "lavfi", "-i", "sine=frequency=440:r=48000",
    "-t", String(dur), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-g", "48", "-keyint_min", "48", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", `${TMP}/${name}`], { timeout: 120000 });
  if (!fs.existsSync(`${TMP}/${name}`)) throw new Error(`fixture ${name} failed`);
}
function genImage(name) {
  spawnSync(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", `testsrc2=s=${W * 2}x${H * 2}:r=${FPS}`, "-frames:v", "1", `${TMP}/${name}`], { timeout: 60000 });
}
function genMusic(dur) {
  spawnSync(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", `sine=frequency=220:r=48000:d=${dur},volume=0.3`, "-c:a", "pcm_s16le", `${TMP}/music.wav`], { timeout: 60000 });
}
for (let v = 0; v < 6; v++) genVideo(`v${v}.mp4`, 4);
for (let im = 0; im < 8; im++) genImage(`i${im}.png`);
genMusic(60);

const IMAGE_TIMELINE = Array.from({ length: 8 }, (_, k) => ({
  id: `pi${k}`, mediaType: "image", imagePath: `${TMP}/i${k}.png`,
  durationMs: 4000, trimInMs: 0, volume: 1, startMs: k * 4000, endMs: k * 4000 + 4000,
  direction: k % 2 ? "out" : "in",
}));
const VIDEO_TIMELINE = Array.from({ length: 6 }, (_, k) => ({
  id: `pv${k}`, mediaType: "video", videoPath: `${TMP}/v${k}.mp4`,
  durationMs: 4000, trimInMs: 0, volume: 1, startMs: k * 4000, endMs: k * 4000 + 4000,
}));

function loadMain() {
  // Fresh module state per mask: main.js caches the topology + hardware
  // profile at require time (the warm-up), so each scenario re-requires
  // the module under its CURRENT os.cpus() mask.
  delete require.cache[resolvedElectron];
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(path.join(ROOT, "electron"))) delete require.cache[k];
  }
  const stubModule = new Module(resolvedElectron, null);
  stubModule.filename = resolvedElectron;
  stubModule.loaded = true;
  stubModule.exports = electronStub;
  require.cache[resolvedElectron] = stubModule;
  require(path.join(ROOT, "electron", "main.js"));
  return handlers["export-native"];
}
let exportHandler = loadMain();

async function runExport(fx, outPath, opts = {}) {
  const fakeEvent = { sender: { isDestroyed: () => false, send: () => {} } };
  spawnLog = [];
  const result = await exportHandler(fakeEvent, {
    outputPath: outPath,
    fps: FPS, width: W, height: H,
    bitrateMbps: 8, quality: "social", crf: 20, audioKbps: 192,
    kenBurns: { enabled: !!fx.kenBurns, intensity: 50, direction: "in" },
    segments: fx.segments,
    audioPath: fx.audio ? `${TMP}/music.wav` : null,
    audio: { normalize: false, masterVolume: 1, fadeInMs: 300, fadeOutMs: 500, musicVolume: 0.8, musicStartMs: 0, musicLoop: true },
    captionSettings: { enabled: false },
    subtitleCues: [],
    headlines: [],
    transition: null,
    watermark: null,
    overlays: [],
    sfx: [],
    ...opts,
  });
  return { result, spawnLog: spawnLog.slice() };
}

function probeDuration(p) {
  const r = spawnSync("/usr/bin/ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p], { encoding: "utf8" });
  return parseFloat(r.stdout || "0");
}

const os = require("os");
const realCpus = os.cpus;
function maskCpus(n, model) {
  const sample = { model: model || realCpus()[0].model };
  os.cpus = () => Array.from({ length: n }, () => sample);
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  cond ? pass++ : fail++;
}

(async () => {
  // T1: 4-logical mask + image timeline → parallel-pass with 4 windows
  console.log("\n══ T1: 4-logical mask (A8 shape) + image-heavy timeline ══");
  maskCpus(4, "AMD A8-5550M APU with Radeon(tm) HD Graphics");
  exportHandler = loadMain();
  let r = await runExport({ segments: IMAGE_TIMELINE, audio: true, kenBurns: true }, `${TMP}/t1.mp4`);
  let argvThreads = r.spawnLog.filter((a) => a.includes("-threads 1")).length;
  check("mode = parallel-pass", r.result.mode === "parallel-pass", r.result.mode);
  check("poolWorkers = 4 (widened filter pool)", r.result.poolWorkers === 4, String(r.result.poolWorkers));
  check("filterPool flag set", r.result.filterPool === true, String(r.result.filterPool));
  check("cpu topology reported", /modules? · 4 threads/.test(r.result.cpuTopology || ""), r.result.cpuTopology);
  check("cpuPhysicalCores = 2 (module-aware)", r.result.cpuPhysicalCores === 2, String(r.result.cpuPhysicalCores));
  check("windows use -threads 1", argvThreads >= r.result.poolWorkers, `${argvThreads} argv with -threads 1`);
  check("output duration 32s", Math.abs(probeDuration(`${TMP}/t1.mp4`) - 32) <= 0.4, probeDuration(`${TMP}/t1.mp4`).toFixed(2) + "s");

  // T2: same mask + video timeline → two-step encode pool stays 2×2
  console.log("\n══ T2: 4-logical mask + video-dominated timeline ══");
  r = await runExport({ segments: VIDEO_TIMELINE, audio: true }, `${TMP}/t2.mp4`);
  check("mode = two-step (all clean, nothing to plan)", r.result.mode === "two-step", r.result.mode);
  check("poolWorkers = 2 (encode pool NOT widened)", r.result.poolWorkers === 2, String(r.result.poolWorkers));
  check("filterPool flag unset", !r.result.filterPool, String(r.result.filterPool));
  check("copied all 6", r.result.copiedClips === 6, String(r.result.copiedClips));

  // T3: 6-physical/12-logical modern mask → Tier 2, no widening
  console.log("\n══ T3: 12-logical mask (modern 6C/12T) + image timeline ══");
  // Linux harness: wmic/CIM absent → the SMT heuristic path (Intel model +
  // even logical ≥4 halves). On real Windows the CIM/wmic query supplies
  // the physical count directly.
  maskCpus(12, "Intel(R) Xeon(R) CPU E5-2650 v4 @ 2.20GHz");
  exportHandler = loadMain();
  r = await runExport({ segments: IMAGE_TIMELINE, audio: true, kenBurns: true }, `${TMP}/t3.mp4`);
  check("tier = TIER_2", r.result.tier === "TIER_2_MODERN_CPU", r.result.tier);
  check("poolWorkers = 3 (min(4, 6/2) — not widened)", r.result.poolWorkers === 3, String(r.result.poolWorkers));
  check("cpuTopology reports 6 cores/12 threads", /6 cores · 12 threads/.test(r.result.cpuTopology || ""), r.result.cpuTopology);

  // T4: disclaimer payload through the widened pool (display-time shift)
  console.log("\n══ T4: v1.14 disclaimer payload through the widened pool ══");
  maskCpus(4, "AMD A8-5550M APU with Radeon(tm) HD Graphics");
  exportHandler = loadMain();
  const LEAD = 3000;
  const discTimeline = [
    {
      id: "__ff_disclaimer__", fileName: "disc.png", kind: "duration", mediaType: "image",
      imagePath: `${TMP}/i0.png`, startMs: 0, endMs: LEAD, durationMs: LEAD,
      direction: "in", track: 0, volume: 1, trimInMs: 0, speed: 1, sourceDurationMs: null,
    },
    ...IMAGE_TIMELINE.map((s) => ({ ...s, startMs: s.startMs + LEAD, endMs: s.endMs + LEAD })),
  ];
  r = await runExport(
    { segments: discTimeline, audio: true, kenBurns: true },
    `${TMP}/t4.mp4`,
    { audio: { normalize: false, masterVolume: 1, fadeInMs: 300, fadeOutMs: 500, musicVolume: 0.8, musicStartMs: LEAD, musicLoop: true } },
  );
  check("widened pool still 4", r.result.poolWorkers === 4, String(r.result.poolWorkers));
  check("disclaimer rides along: 35s out", Math.abs(probeDuration(`${TMP}/t4.mp4`) - 35) <= 0.4, probeDuration(`${TMP}/t4.mp4`).toFixed(2) + "s");

  os.cpus = realCpus;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
