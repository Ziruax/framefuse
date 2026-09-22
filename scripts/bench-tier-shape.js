#!/usr/bin/env node
/**
 * scripts/bench-tier-shape.js — issue-1 root-cause hunt: on a 4-logical-core
 * box (the user's A8-5550M class), does the v1.13+ Tier-3 shape
 * (2 workers × 2 threads) actually SLOW image-heavy exports vs the v1.12.1
 * shape (strict 4 workers × 1 thread)? Filter graphs (zoompan/scale/libass)
 * are single-threaded per PROCESS, so process COUNT — not x264 threads —
 * is the parallelism that matters when filters dominate.
 *
 * Races the REAL export-native handler from the working tree (v1.14) vs
 * the v1.12.1 tag (checked out like bench-export.js does), both under a
 * 4-core os.cpus() mask:
 *   T1 image storyboard: 12 images + Ken Burns + music (filter-dominated)
 *   T2 video project:    6 clean videos + music (copy/x264-dominated)
 *
 * Run: node scripts/bench-tier-shape.js
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { spawnSync, spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FF = require(path.join(ROOT, "node_modules", "ffmpeg-static"));
const TMP = "/tmp/fftier";
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
    getVersion: () => "1.14.0",
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
function genVideo(name, dur, gop) {
  spawnSync(FF, ["-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc2=s=${W}x${H}:r=${FPS}`,
    "-f", "lavfi", "-i", `sine=frequency=440:r=48000`,
    "-t", String(dur), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-g", String(gop), "-keyint_min", String(gop), "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", `${TMP}/${name}`], { timeout: 120000 });
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
for (let v = 0; v < 6; v++) genVideo(`v${v}.mp4`, 6, 48);
for (let im = 0; im < 14; im++) genImage(`i${im}.png`);
genMusic(120);

const CASES = {
  T1: {
    name: "image storyboard + Ken Burns + music (filter-dominated), 48s",
    segments: Array.from({ length: 12 }, (_, k) => ({
      id: `ti${k}`, mediaType: "image", imagePath: `${TMP}/i${k}.png`,
      durationMs: 4000, trimInMs: 0, volume: 1, startMs: k * 4000, endMs: k * 4000 + 4000,
      direction: k % 2 ? "out" : "in",
    })),
    kenBurns: true, audio: true,
  },
  T2: {
    name: "video project (6 clean h264 videos + music), 36s",
    segments: Array.from({ length: 6 }, (_, k) => ({
      id: `tv${k}`, mediaType: "video", videoPath: `${TMP}/v${k}.mp4`,
      durationMs: 6000, trimInMs: 0, volume: 1, startMs: k * 6000, endMs: k * 6000 + 6000,
    })),
    kenBurns: false, audio: true,
  },
};

async function runExport(handler, fx, outPath) {
  const fakeEvent = { sender: { isDestroyed: () => false, send: () => {} } };
  const opts = {
    outputPath: outPath,
    fps: FPS, width: W, height: H,
    bitrateMbps: 8, quality: "social", crf: 20, audioKbps: 192,
    kenBurns: { enabled: fx.kenBurns, intensity: 50, direction: "in" },
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
  };
  spawnLog = [];
  const t0 = Date.now();
  const result = await handler(fakeEvent, opts);
  return { ms: Date.now() - t0, result, spawns: spawnLog.length, spawnLog: spawnLog.slice() };
}

// ── load current tree ─────────────────────────────────────────────────
const CUR = require(path.join(ROOT, "electron", "main.js"));
const curHandler = handlers["export-native"];
for (const k of Object.keys(handlers)) delete handlers[k];

// ── load v1.12.1 tree ─────────────────────────────────────────────────
const OLD_DIR = path.join(ROOT, ".bench-121", "electron");
fs.mkdirSync(OLD_DIR, { recursive: true });
const { execSync } = require("child_process");
for (const f of ["main.js", "export-graph.js", "export-singlepass.js"]) {
  fs.writeFileSync(path.join(OLD_DIR, f), execSync(`git show v1.12.1:electron/${f}`));
}
fs.writeFileSync(path.join(OLD_DIR, "preload.js"), "// stub");
for (const k of Object.keys(require.cache)) {
  if (k.startsWith(path.join(ROOT, "electron"))) delete require.cache[k];
}
const OLD = require(path.join(OLD_DIR, "main.js"));
const oldHandler = handlers["export-native"];

function probeDuration(p) {
  const r = spawnSync("/usr/bin/ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p], { encoding: "utf8" });
  return parseFloat(r.stdout || "0");
}

(async () => {
  const os = require("os");
  const realCpus = os.cpus;
  const sample = realCpus()[0] || { model: "bench-mask" };
  // 4-logical mask — the A8-5550M shape (2 modules × 2 int-cores).
  os.cpus = () => Array.from({ length: 4 }, () => sample);

  const report = { mask: "4 logical", box: `${realCpus().length}× ${sample.model}`, cases: {} };
  for (const [key, fx] of Object.entries(CASES)) {
    console.log(`\n══ ${key}: ${fx.name} ══`);
    const entry = {};
    // warm once (probes, profile caches) then 2 measured runs each
    await runExport(curHandler, fx, `${TMP}/${key}_warm.mp4`).catch(() => {});
    for (const [label, handler, out] of [
      ["v1.12.1 (4×1)", oldHandler, `${TMP}/${key}_old.mp4`],
      ["v1.14 (T3 2×2)", curHandler, `${TMP}/${key}_new.mp4`],
    ]) {
      const runs = [];
      let last = null;
      for (let r = 0; r < 2; r++) {
        const run = await runExport(handler, fx, out);
        runs.push(run.ms);
        last = run;
      }
      const ms = Math.min(...runs);
      const dur = probeDuration(out);
      entry[label] = {
        ms, runs, spawns: last.spawns, duration: dur,
        mode: last.result.mode || "two-step",
        copied: last.result.copiedClips, encoded: last.result.encodedClips,
        parallelChunks: last.result.parallelChunks,
      };
      console.log(`  ${label.padEnd(15)} best=${ms}ms (runs ${runs.join(",")})  spawns=${last.spawns}  mode=${entry[label].mode}  copied=${entry[label].copied ?? "-"}/${(entry[label].copied ?? 0) + (entry[label].encoded ?? 0)}  out=${dur.toFixed(2)}s`);
    }
    const ratio = (entry["v1.14 (T3 2×2)"].ms / entry["v1.12.1 (4×1)"].ms).toFixed(2);
    console.log(`  v1.14 / v1.12.1 wall-clock ratio: ${ratio}×`);
    entry.ratio = ratio;
    report.cases[key] = entry;
  }
  os.cpus = realCpus;
  fs.writeFileSync(path.join(ROOT, "docs", "bench-tier-shape.json"), JSON.stringify(report, null, 2));
  console.log(`\nreport → docs/bench-tier-shape.json`);
})();
