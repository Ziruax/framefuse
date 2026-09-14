#!/usr/bin/env node
/**
 * scripts/bench-export.js — FrameFuse v6 export performance benchmark.
 *
 * Drives the REAL ipcMain "export-native" handler (main.js loaded through
 * an electron stub — the verify-chunked-encode.js pattern) against real
 * fixtures, for BOTH the current tree (v6: single-pass route + smart turbo)
 * and the PRE-v6 pipeline checked out from git HEAD (old two-step). Every
 * ffmpeg spawn is counted (child_process.spawn monkey-patch) so the
 * "process count / audio passes" claims are measured, not asserted.
 *
 * Fixtures (640x360@30 — sized for the 2-core CI-style box; the KPI fixture
 * is the same SHAPE as the 5-min 1080p target, scaled):
 *   F1 "kpi"   : 12 clips (6 videos w/ audio + 6 images) + 2 chroma overlays
 *                + captions + music + xfade/dip transitions
 *   F2 "turbo" : 1 video, no effects (the stream-copy fast path)
 *   F3 "sp"    : 10 clips + captions + 1 overlay
 *
 * Run: node scripts/bench-export.js [--only F1|F2|F3] [--quick]
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { spawnSync, spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FF = require(path.join(ROOT, "node_modules", "ffmpeg-static"));
const TMP = "/tmp/ffbench";
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// ── spawn instrumentation: count ffmpeg children per export ──────────
let spawnLog = [];
const realSpawn = spawn;
const cp = require("child_process");
cp.spawn = function (bin, args, opts) {
  if (String(bin).includes("ffmpeg")) spawnLog.push(args.slice(0, 4).join(" "));
  return realSpawn.call(this, bin, args, opts);
};

// ── electron stub with handler recording ─────────────────────────────
const handlers = {};
const electronStub = {
  app: {
    whenReady: () => Promise.resolve(),
    on: () => {},
    getPath: (k) => path.join(TMP, "userData"),
    getName: () => "FrameFuse",
    getVersion: () => "6.0.0",
    isReady: () => true,
    isPackaged: false,
    quit: () => {},
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
  ipcMain: {
    handle: (name, fn) => { handlers[name] = fn; },
    on: () => {},
  },
  dialog: {},
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  shell: {},
  utilityProcess: { fork: () => ({}) },
};
const resolvedElectron = require.resolve("electron");
function installElectronStub() {
  const stubModule = new Module(resolvedElectron, null);
  stubModule.filename = resolvedElectron;
  stubModule.loaded = true;
  stubModule.exports = electronStub;
  require.cache[resolvedElectron] = stubModule;
}
installElectronStub();

// ── fixtures ──────────────────────────────────────────────────────────
console.log("── generating fixtures ──");
const W = 640, H = 360, FPS = 30;
function genVideo(name, dur, withAudio, gop) {
  const args = ["-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc2=s=${W}x${H}:r=${FPS}`];
  if (withAudio) args.push("-f", "lavfi", "-i", `sine=frequency=${440 + Math.floor(Math.random() * 400)}:r=48000`);
  args.push("-t", String(dur), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-g", String(gop), "-keyint_min", String(gop), "-pix_fmt", "yuv420p");
  if (withAudio) args.push("-c:a", "aac", "-b:a", "128k");
  args.push(`${TMP}/${name}`);
  spawnSync(FF, args, { timeout: 120000 });
  if (!fs.existsSync(`${TMP}/${name}`)) throw new Error(`fixture ${name} failed`);
}
function genImage(name) {
  spawnSync(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", `testsrc2=s=${W * 2}x${H * 2}:r=${FPS}`, "-frames:v", "1", `${TMP}/${name}`], { timeout: 60000 });
  if (!fs.existsSync(`${TMP}/${name}`)) throw new Error(`fixture ${name} failed`);
}
function genMusic(dur) {
  spawnSync(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", `sine=frequency=220:r=48000:d=${dur},volume=0.3`, "-c:a", "pcm_s16le", `${TMP}/music.wav`], { timeout: 60000 });
}
for (let v = 0; v < 6; v++) genVideo(`v${v}.mp4`, 2.5, true, 48);
genVideo(`solo.mp4`, 8, true, 48);
for (let im = 0; im < 8; im++) genImage(`i${im}.png`);
genMusic(30);

const FIXTURES = {
  F1: {
    name: "kpi-shaped (12 clips + 2 chroma overlays + captions + music + xfade/dip)",
    segments: [
      ...Array.from({ length: 6 }, (_, k) => ({
        id: `sv${k}`, mediaType: "video", videoPath: `${TMP}/v${k}.mp4`,
        durationMs: 2500, trimInMs: 0, volume: 1, startMs: k * 4000, endMs: k * 4000 + 2500,
      })),
      ...Array.from({ length: 6 }, (_, k) => ({
        id: `si${k}`, mediaType: "image", imagePath: `${TMP}/i${k}.png`,
        durationMs: 1500, trimInMs: 0, volume: 1, startMs: k * 4000 + 2500, endMs: k * 4000 + 4000,
        direction: "in",
      })),
    ].sort((a, b) => a.startMs - b.startMs),
    overlays: [
      { id: "ov0", mediaType: "image", imagePath: `${TMP}/i6.png`, track: 1, startMs: 2000, endMs: 10000, durationMs: 8000, trimInMs: 0, volume: 1, overlay: { scalePercent: 40, position: "top-right" }, chroma: null },
      { id: "ov1", mediaType: "image", imagePath: `${TMP}/i7.png`, track: 1, startMs: 12000, endMs: 22000, durationMs: 10000, trimInMs: 0, volume: 1, overlay: { scalePercent: 30, x: 0.5, y: 0.5 }, chroma: { mode: "chroma", color: "#00e000", similarity: 0.32, blend: 0.08, spill: 0.6 } },
    ],
    captions: true,
    audioPath: `${TMP}/music.wav`,
    transition: { style: "dissolve", durationMs: 300, fadeStartEnd: true },
  },
  F2: {
    name: "turbo (1 clip, no effects — stream-copy fast path)",
    segments: [
      { id: "solo", mediaType: "video", videoPath: `${TMP}/solo.mp4`, durationMs: 8000, trimInMs: 0, volume: 1, startMs: 0, endMs: 8000 },
    ],
    overlays: [],
    captions: false,
    audioPath: null,
    transition: null,
  },
  F3: {
    name: "single-pass (10 clips + captions + 1 overlay)",
    segments: [
      ...Array.from({ length: 5 }, (_, k) => ({
        id: `fv${k}`, mediaType: "video", videoPath: `${TMP}/v${k}.mp4`,
        durationMs: 2500, trimInMs: 0, volume: 1, startMs: k * 5000, endMs: k * 5000 + 2500,
      })),
      ...Array.from({ length: 5 }, (_, k) => ({
        id: `fi${k}`, mediaType: "image", imagePath: `${TMP}/i${k}.png`,
        durationMs: 2500, trimInMs: 0, volume: 1, startMs: k * 5000 + 2500, endMs: k * 5000 + 5000,
      })),
    ],
    overlays: [
      { id: "ov2", mediaType: "image", imagePath: `${TMP}/i6.png`, track: 1, startMs: 1000, endMs: 12000, durationMs: 11000, trimInMs: 0, volume: 1, overlay: { scalePercent: 35, position: "bottom-left" }, chroma: null },
    ],
    captions: true,
    audioPath: `${TMP}/music.wav`,
    transition: { style: "dip-black", durationMs: 300 },
  },
};

const cueList = [];
for (let c = 0; c < 20; c++) {
  cueList.push({
    startMs: 500 + c * 1100, endMs: 1400 + c * 1100,
    text: `caption line ${c + 1}`,
    words: [{ text: `caption`, startMs: 500 + c * 1100, endMs: 950 + c * 1100 }, { text: `line`, startMs: 950 + c * 1100, endMs: 1400 + c * 1100 }],
  });
}
const captionSettings = {
  enabled: true, presetId: "clean", fontSizeScale: 1, wordMode: "off", animation: "none",
  customColor: null, customPosition: null, fontName: "Arial", fontWeight: 600,
};

// ── run one export through a loaded main.js handler ────────────────────
async function runExport(handler, fixture, outPath, normalize) {
  const progressEvents = [];
  const fakeEvent = {
    sender: {
      isDestroyed: () => false,
      send: (ch, payload) => { progressEvents.push(payload); },
    },
  };
  const opts = {
    outputPath: outPath,
    fps: FPS, width: W, height: H,
    bitrateMbps: 8, quality: "social", crf: 20, audioKbps: 192,
    kenBurns: { enabled: true, intensity: 50, direction: "in" },
    segments: fixture.segments,
    audioPath: fixture.audioPath,
    audio: {
      normalize: !!normalize,
      masterVolume: 1, fadeInMs: 300, fadeOutMs: 500,
      musicVolume: 0.8, musicStartMs: 0, musicLoop: true,
    },
    captionSettings: fixture.captions ? captionSettings : { enabled: false },
    subtitleCues: fixture.captions ? cueList : [],
    headlines: [],
    transition: fixture.transition,
    watermark: null,
    overlays: fixture.overlays,
    sfx: [],
  };
  spawnLog = [];
  const t0 = Date.now();
  const result = await handler(fakeEvent, opts);
  const ms = Date.now() - t0;
  return { ms, result, spawns: spawnLog.length, spawnLog: spawnLog.slice(), progressEvents: progressEvents.length };
}

function probeDuration(p) {
  const r = spawnSync("/usr/bin/ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p], { encoding: "utf8" });
  return parseFloat(r.stdout || "0");
}

// ── load BOTH pipelines ────────────────────────────────────────────────
// NEW (working tree): main.js + export-graph.js + export-singlepass.js.
const NEW_MAIN = require(path.join(ROOT, "electron", "main.js"));
const newHandlers = { ...handlers };

// OLD (git HEAD): stage pre-v6 main.js + export-graph.js under the project
// tree so require("ffmpeg-static") and require("./export-graph") resolve.
const OLD_DIR = path.join(ROOT, ".bench-old", "electron");
fs.mkdirSync(OLD_DIR, { recursive: true });
const { execSync } = require("child_process");
fs.writeFileSync(path.join(OLD_DIR, "main.js"), execSync("git show HEAD:electron/main.js"));
fs.writeFileSync(path.join(OLD_DIR, "export-graph.js"), execSync("git show HEAD:electron/export-graph.js"));
fs.writeFileSync(path.join(OLD_DIR, "preload.js"), "// stub");
for (const k of Object.keys(handlers)) delete handlers[k];
for (const k of Object.keys(require.cache)) {
  if (k.startsWith(path.join(ROOT, "electron"))) delete require.cache[k];
}
const OLD_MAIN = require(path.join(OLD_DIR, "main.js"));
const oldHandlers = { ...handlers };

// ── benchmark loop ────────────────────────────────────────────────────
const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : null;
const report = { box: `${require("os").cpus().length}× ${require("os").cpus()[0].model}`, fixtures: {} };

async function benchOne(key) {
  const fx = FIXTURES[key];
  console.log(`\n══ ${key}: ${fx.name} ══`);
  const entry = { name: fx.name, runs: [] };
  for (const [label, handler, normalize] of [
    ["old-two-step", oldHandlers["export-native"], false],
    ["old+normalize", oldHandlers["export-native"], true],
    ["v6", newHandlers["export-native"], false],
    ["v6+normalize", newHandlers["export-native"], true],
  ]) {
    const out = `${TMP}/${key}_${label}.mp4`;
    try {
      const run = await runExport(handler, fx, out, normalize);
      const { ms, result, spawns, progressEvents } = run;
      if (process.env.BENCH_DEBUG) console.log("    spawn-log:", JSON.stringify(run.spawnLog));
      const dur = probeDuration(out);
      const size = fs.statSync(out).size;
      const expectDur = fx.segments.reduce((a, s) => a + s.durationMs, 0) / 1000;
      console.log(`  ${label.padEnd(15)} ${(ms / 1000).toFixed(1)}s  ffmpeg-spawns=${spawns}  out=${dur.toFixed(2)}s/${(size / 1024).toFixed(0)}KB  mode=${result.mode || "two-step"}  copied=${result.copiedClips}/${result.copiedClips + result.encodedClips}`);
      if (Math.abs(dur - expectDur) > 0.4) console.error(`    ⚠ duration ${dur} vs expected ${expectDur}`);
      entry.runs.push({ label, ms, spawns, duration: dur, sizeKb: size, copied: result.copiedClips, encoded: result.encodedClips, mode: result.mode || "two-step", progressEvents });
    } catch (e) {
      console.error(`  ${label} FAILED: ${e.message}`);
      entry.runs.push({ label, error: String(e.message) });
    }
  }
  if (entry.runs.length === 2 && entry.runs[0].ms && entry.runs[1].ms) {
    entry.speedup = (entry.runs[0].ms / entry.runs[1].ms).toFixed(2) + "×";
    console.log(`  speedup: ${entry.speedup}`);
  }
  report.fixtures[key] = entry;
}

(async () => {
  for (const key of ["F1", "F2", "F3"]) {
    if (only && key !== only) continue;
    await benchOne(key);
  }

  // ── cancellation test: start the v6 single-pass export, cancel at 2s ──
  console.log("\n══ cancellation: v6 export killed at ~2s ══");
  const cancelRun = (async () => {
    try {
      await runExport(newHandlers["export-native"], FIXTURES.F3, `${TMP}/cancel.mp4`, false);
      return { completed: true };
    } catch (e) {
      return { completed: false, error: String(e.message) };
    }
  })();
  await new Promise((r) => setTimeout(r, 2000));
  const cancelRes = await newHandlers["cancel-export"]();
  const outcome = await cancelRun;
  await new Promise((r) => setTimeout(r, 500));
  const ps = spawnSync("ps", ["-eo", "comm"], { encoding: "utf8" });
  const strays = (ps.stdout || "").split("\n").filter((l) => l.trim() === "ffmpeg").length;
  console.log(`  cancel-export returned ${cancelRes}; handler error: ${outcome.error || "(completed)"}; stray ffmpeg processes: ${strays}`);
  report.cancellation = { error: outcome.error, strays, pass: !outcome.completed && /cancel/i.test(outcome.error || "") && strays === 0 };

  fs.writeFileSync(path.join(ROOT, "docs", "bench-v6.json"), JSON.stringify(report, null, 2));
  console.log(`\nreport → docs/bench-v6.json`);
  console.log(`cancellation: ${report.cancellation.pass ? "PASS" : "FAIL"}`);
})();
