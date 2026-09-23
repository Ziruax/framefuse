#!/usr/bin/env node
/**
 * scripts/bench-disclaimer.js — v1.14 regression hunt: does the prepended
 * disclaimer segment (the v1.14 display-time payload: virtual image clip at
 * [0,N) + every segment shifted +N + musicStartMs +N) slow the native
 * export, and WHERE (mode fallback? more windows? heavier graphs?).
 *
 * Drives the REAL ipcMain "export-native" handler (main.js through the
 * electron stub — bench-export.js pattern) against real fixtures, paired
 * WITHOUT vs WITH a 3s disclaimer lead-in:
 *   D1 smart-render:  6 clean copyable videos + music (no effects) — the
 *                     stream-copy path; the disclaimer must stay a bounded
 *                     dirty window [0,3s), NOT fall back to the two-step pool.
 *   D2 image+music:   10 images + music (the classic FrameFuse storyboard).
 *   D3 heavy:         images + Ken Burns + captions + dissolve transitions.
 * Each pair runs also under an 8-core mask (Tier-2 shape) for D1.
 *
 * Run: node scripts/bench-disclaimer.js [--only D1|D2|D3]
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { spawnSync, spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FF = require(path.join(ROOT, "node_modules", "ffmpeg-static"));
const TMP = "/tmp/ffdisc";
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// ── spawn instrumentation: count + argv of ffmpeg children ───────────
let spawnLog = [];
const realSpawn = spawn;
const cp = require("child_process");
cp.spawn = function (bin, args, opts) {
  if (String(bin).includes("ffmpeg")) spawnLog.push(args.join(" "));
  return realSpawn.call(this, bin, args, opts);
};

// ── electron stub (bench-export.js pattern) ─────────────────────────
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
for (let v = 0; v < 8; v++) genVideo(`v${v}.mp4`, 4, true, 48);
for (let im = 0; im < 12; im++) genImage(`i${im}.png`);
genMusic(60);

const LEAD_MS = 3000;

/** The exact virtual segment the v1.14 renderer prepends. */
function disclaimerSegment(imagePath) {
  return {
    id: "__ff_disclaimer__",
    fileName: "my-disclaimer-any-name.png",
    kind: "duration",
    mediaType: "image",
    imagePath,
    startMs: 0,
    endMs: LEAD_MS,
    durationMs: LEAD_MS,
    direction: "in",
    track: 0,
    volume: 1,
    trimInMs: 0,
    speed: 1,
    sourceDurationMs: null,
  };
}

/** v1.14 payload transform: prepend the virtual clip, shift everything +N. */
function withDisclaimer(segs, imagePath) {
  return [
    disclaimerSegment(imagePath),
    ...segs.map((s) => ({ ...s, startMs: s.startMs + LEAD_MS, endMs: s.endMs + LEAD_MS })),
  ];
}

const cueList = [];
for (let c = 0; c < 30; c++) {
  cueList.push({
    startMs: 500 + c * 1100, endMs: 1400 + c * 1100,
    text: `caption line ${c + 1}`,
    words: [
      { text: `caption`, startMs: 500 + c * 1100, endMs: 950 + c * 1100 },
      { text: `line`, startMs: 950 + c * 1100, endMs: 1400 + c * 1100 },
    ],
  });
}
const captionSettings = {
  enabled: true, presetId: "clean", fontSizeScale: 1, wordMode: "off", animation: "none",
  customColor: null, customPosition: null, fontName: "Arial", fontWeight: 600,
};

const BASE = {
  D1: {
    name: "smart-render (6 clean copyable videos + music)",
    segments: Array.from({ length: 6 }, (_, k) => ({
      id: `sv${k}`, mediaType: "video", videoPath: `${TMP}/v${k}.mp4`,
      durationMs: 4000, trimInMs: 0, volume: 1, startMs: k * 4000, endMs: k * 4000 + 4000,
    })),
    audio: true, captions: false, kenBurns: false, transition: null,
  },
  D2: {
    name: "image+music storyboard (10 images)",
    segments: Array.from({ length: 10 }, (_, k) => ({
      id: `si${k}`, mediaType: "image", imagePath: `${TMP}/i${k}.png`,
      durationMs: 4000, trimInMs: 0, volume: 1, startMs: k * 4000, endMs: k * 4000 + 4000,
      direction: "in",
    })),
    audio: true, captions: false, kenBurns: false, transition: null,
  },
  D3: {
    name: "heavy (10 images + Ken Burns + captions + dissolve)",
    segments: Array.from({ length: 10 }, (_, k) => ({
      id: `hi${k}`, mediaType: "image", imagePath: `${TMP}/i${k + 2}.png`,
      durationMs: 4000, trimInMs: 0, volume: 1, startMs: k * 4000, endMs: k * 4000 + 4000,
      direction: k % 2 ? "out" : "in",
    })),
    audio: true, captions: true, kenBurns: true, transition: { style: "dissolve", durationMs: 300, fadeStartEnd: true },
  },
};

// ── run one export through the loaded main.js handler ────────────────
async function runExport(handler, fx, outPath, useDisclaimer) {
  const progressEvents = [];
  const fakeEvent = {
    sender: {
      isDestroyed: () => false,
      send: (ch, payload) => { progressEvents.push(payload); },
    },
  };
  const segments = useDisclaimer
    ? withDisclaimer(fx.segments, `${TMP}/i0.png`)
    : fx.segments;
  const opts = {
    outputPath: outPath,
    fps: FPS, width: W, height: H,
    bitrateMbps: 8, quality: "social", crf: 20, audioKbps: 192,
    kenBurns: { enabled: fx.kenBurns, intensity: 50, direction: "in" },
    segments,
    audioPath: fx.audio ? `${TMP}/music.wav` : null,
    audio: {
      normalize: false,
      masterVolume: 1, fadeInMs: 300, fadeOutMs: 500,
      musicVolume: 0.8,
      musicStartMs: useDisclaimer ? LEAD_MS : 0,
      musicLoop: true,
    },
    captionSettings: fx.captions ? captionSettings : { enabled: false },
    subtitleCues: fx.captions
      ? (useDisclaimer ? cueList.map((c) => ({ ...c, startMs: c.startMs + LEAD_MS, endMs: c.endMs + LEAD_MS, words: c.words.map((w) => ({ ...w, startMs: w.startMs + LEAD_MS, endMs: w.endMs + LEAD_MS })) })) : cueList)
      : [],
    headlines: [],
    transition: fx.transition,
    watermark: null,
    overlays: [],
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

const MAIN = require(path.join(ROOT, "electron", "main.js"));
const exportHandler = handlers["export-native"];

const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : null;

function summarize(label, run, expectDur) {
  const dur = probeDuration(`${TMP}/${label}.mp4`);
  console.log(
    `  ${label.padEnd(18)} ${(run.ms / 1000).toFixed(1)}s  spawns=${run.spawns}  mode=${run.result.mode || "two-step"}  copied=${run.result.copiedClips ?? "-"}/${(run.result.copiedClips ?? 0) + (run.result.encodedClips ?? 0)}  parallelChunks=${run.result.parallelChunks ?? "-"}  out=${dur.toFixed(2)}s (expect ${expectDur})`,
  );
  if (Math.abs(dur - expectDur) > 0.4) console.error(`    ⚠ DURATION ${dur} vs expected ${expectDur}`);
  return { ms: run.ms, spawns: run.spawns, mode: run.result.mode || "two-step", copied: run.result.copiedClips, encoded: run.result.encodedClips, parallelChunks: run.result.parallelChunks, duration: dur };
}

(async () => {
  const report = { box: `${require("os").cpus().length}× ${require("os").cpus()[0].model}`, leadMs: LEAD_MS, cases: {} };
  for (const key of ["D1", "D2", "D3"]) {
    if (only && key !== key.toUpperCase() && key !== only) continue;
    if (only && key !== only) continue;
    const fx = BASE[key];
    const baseSec = fx.segments.reduce((a, s) => a + s.durationMs, 0) / 1000;
    console.log(`\n══ ${key}: ${fx.name} — ${baseSec}s base ══`);
    const entry = {};

    const noRun = await runExport(exportHandler, fx, `${TMP}/${key}_no.mp4`, false);
    entry.no = summarize(`${key}_no`, noRun, baseSec);

    const withRun = await runExport(exportHandler, fx, `${TMP}/${key}_with.mp4`, true);
    entry.with = summarize(`${key}_with`, withRun, baseSec + LEAD_MS / 1000);

    // normalized: per-second-of-output cost
    entry.no.perSec = +(entry.no.ms / 1000 / baseSec).toFixed(3);
    entry.with.perSec = +(entry.with.ms / 1000 / (baseSec + LEAD_MS / 1000)).toFixed(3);
    entry.perSecDelta = +((entry.with.perSec / entry.no.perSec - 1) * 100).toFixed(1);
    console.log(`  per-output-second: no=${entry.no.perSec}s/s  with=${entry.with.perSec}s/s  delta=${entry.perSecDelta}%`);

    // dump the first smart/window argv lines for the WITH case (mode diagnosis)
    if (process.env.BENCH_DEBUG) {
      console.log("    WITH spawn[0..2]:", JSON.stringify(withRun.spawnLog.slice(0, 3), null, 1).slice(0, 1500));
    }
    report.cases[key] = entry;
  }

  // ── 8-core mask on D1: Tier-2 worker shape ± disclaimer ─────────────
  if (!only || only === "D1") {
    console.log("\n══ D1 @ 8-core mask (Tier-2 shape) ══");
    const os = require("os");
    const realCpus = os.cpus;
    const sample = realCpus()[0] || { model: "bench-mask" };
    os.cpus = () => Array.from({ length: 8 }, () => sample);
    try {
      const no8 = await runExport(exportHandler, BASE.D1, `${TMP}/D1_8_no.mp4`, false);
      const w8 = await runExport(exportHandler, BASE.D1, `${TMP}/D1_8_with.mp4`, true);
      report.cases.D1_8core = {
        no: summarize("D1_8_no", no8, BASE.D1.segments.reduce((a, s) => a + s.durationMs, 0) / 1000),
        with: summarize("D1_8_with", w8, BASE.D1.segments.reduce((a, s) => a + s.durationMs, 0) / 1000 + LEAD_MS / 1000),
      };
      const e = report.cases.D1_8core;
      console.log(`  ms delta: no=${e.no.ms} with=${e.with.ms} (+${((e.with.ms / e.no.ms - 1) * 100).toFixed(1)}%)`);
    } finally {
      os.cpus = realCpus;
    }
  }

  fs.writeFileSync(path.join(ROOT, "docs", "bench-disclaimer.json"), JSON.stringify(report, null, 2));
  console.log(`\nreport → docs/bench-disclaimer.json`);
})();
