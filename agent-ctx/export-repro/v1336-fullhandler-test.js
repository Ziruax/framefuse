// agent-ctx/export-repro/v1336-fullhandler-test.js — the FULL-HANDLER repro
// the v1.33.5 tests sliced FUNCTIONS; this one loads the REAL electron/main.js
// through an electron stub with a CAPTURING ipcMain and invokes the actual
// "export-native" handler with the user's EXACT payload shape (10s loop video
// + long voice-role audio + burned captions + audio-extended timeline).
// Goal: find flow-level hangs (await wiring / phase ordering / completion IPC)
// that function-level harnesses can never see.
//
// Usage: node agent-ctx/export-repro/v1336-fullhandler-test.js [loop|noloop]
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { spawn, spawnSync } = require("child_process");

const MODE = process.argv[2] === "noloop" ? "noloop" : process.argv[2] === "audioonly" ? "audioonly" : "loop";
const FFMPEG = "/usr/bin/ffmpeg";
const ROOT = path.join(__dirname, "..", "..");
const WORK = fs.mkdtempSync("/tmp/v1336-");

// scale: the user's exact timeline (4174.8s) but a tiny frame size so the
// encode completes on this 2-CPU sandbox. Every duration-scaled budget
// (measure windows, maxMs caps, mux band) sees the REAL 4174.8s numbers.
const TOTAL_SEC = MODE === "loop" ? 4174.8 : 4174.8;
const W = 320, H = 180, FPS = 24;

// ── electron stub with CAPTURING ipcMain ─────────────────────────────────
const handlers = new Map();
const electronStub = {
  app: {
    whenReady: () => Promise.resolve(),
    on: () => {},
    getPath: (k) => path.join(WORK, "userData"),
    getAppPath: () => ROOT,
    getName: () => "FrameFuse",
    getVersion: () => "1.33.5",
    isReady: () => true,
    isPackaged: false,
    quit: () => {},
    setAppUserModelId: () => {},
    getGPUInfo: async () => ({}),
    commandLine: { appendSwitch: () => {} },
  },
  BrowserWindow: class {
    constructor() {
      this.webContents = {
        setWindowOpenHandler: () => ({ action: "deny" }),
        on: () => {},
        send: () => {},
        isLoadingMainFrame: () => false,
      };
    }
    loadURL() {}
    loadFile() {}
    on() {}
    static getAllWindows() { return []; }
  },
  ipcMain: {
    handle: (name, fn) => { handlers.set(name, fn); },
    on: () => {},
    removeHandler: () => {},
  },
  dialog: {
    showSaveDialog: async () => ({ filePath: path.join(WORK, "out.mp4"), canceled: false }),
    showOpenDialog: async () => ({ filePaths: [], canceled: true }),
    showMessageBox: async () => ({ response: 0 }),
  },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  shell: { openExternal: () => {}, showItemInFolder: () => {} },
  utilityProcess: { fork: () => ({}) },
  net: {},
};
const resolvedElectron = require.resolve("electron");
const stubModule = new Module(resolvedElectron, null);
stubModule.filename = resolvedElectron;
stubModule.loaded = true;
stubModule.exports = electronStub;
require.cache[resolvedElectron] = stubModule;

console.log(`[harness] MODE=${MODE} · timeline ${TOTAL_SEC}s · ${W}x${H}@${FPS} · ${WORK}`);
const t0 = Date.now();
require(path.join(ROOT, "electron", "main.js"));
console.log(`[harness] main.js loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s · handlers: ${[...handlers.keys()].length}`);

// ── progress recorder ─────────────────────────────────────────────────────
const events = [];
let lastLog = 0;
const fakeEvent = {
  sender: {
    isDestroyed: () => false,
    send: (channel, payload) => {
      if (channel !== "export-progress") return;
      events.push(payload);
      const now = Date.now();
      if (now - lastLog > 2000 || payload.progress >= 100) {
        lastLog = now;
        console.log(
          `  [${((now - t0) / 1000).toFixed(1).padStart(7)}s] ${String(payload.progress).padStart(6)}%  phase=${payload.phase ?? "?"}  t=${payload.timemark ?? "—"}  eta=${payload.eta ?? "—"}  rate=${payload.rate ?? "—"}`,
        );
      }
    },
  },
};

// ── media fixtures (the user's media at repro scale) ──────────────────────
function gen(tag, args) {
  const t = Date.now();
  const r = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error", ...args], { encoding: "utf8", timeout: 300000 });
  if (r.status !== 0) throw new Error(`gen ${tag}: ${r.stderr}`);
  console.log(`[gen] ${tag} ${((Date.now() - t) / 1000).toFixed(1)}s`);
}

const loopSrc = path.join(WORK, "loop10.mp4");
gen("10s loop source (video + own audio)", [
  "-f", "lavfi", "-i", `testsrc2=size=${W}x${H}:rate=${FPS}`,
  "-f", "lavfi", "-i", "sine=frequency=220:duration=10",
  "-t", "10", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "400k",
  "-c:a", "aac", "-b:a", "128k", "-shortest", "-y", loopSrc,
]);
const voice = path.join(WORK, "voice.m4a"); // 69-min narration-style audio
gen(`${TOTAL_SEC}s voice audio`, [
  "-f", "lavfi", "-i", `sine=frequency=330:duration=${TOTAL_SEC},tremolo=f=2:d=0.3`,
  "-c:a", "aac", "-b:a", "128k", "-y", voice,
]);

// captions across the WHOLE timeline (the user's 69-min burned captions)
const cues = [];
const ts = (sec) => {
  const h = String(Math.floor(sec / 3600));
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
  const s = String(Math.floor(sec % 60)).padStart(2, "0");
  return `${h}:${m}:${s}.00`;
};
for (let s = 0; s < TOTAL_SEC - 5; s += 20) {
  cues.push({ startMs: s * 1000, endMs: (s + 4) * 1000, text: `caption @ ${s}s` });
}

// ── the payload — EXACTLY the renderer's shape ───────────────────────────
const seg = {
  id: "seg1",
  videoPath: loopSrc,
  direction: null,
  // noloop ⇒ the segment keeps its NATURAL 10s window (no fill); the
  // timeline still runs to the audio's 4174.8s via payload totalMs.
  durationMs: MODE === "loop" ? Math.round(TOTAL_SEC * 1000) : 10000,
  startMs: 0,
  endMs: MODE === "loop" ? Math.round(TOTAL_SEC * 1000) : 10000,
  mediaType: "video",
  track: 0,
  volume: 1,
  trimInMs: 0,
  sourceDurationMs: 10000,
  chroma: null,
  overlay: null,
};
if (MODE === "loop") seg.loop = true; // v1.29 LOOP-TO-FILL
const payload = {
  outputPath: path.join(WORK, "out.mp4"),
  fps: FPS,
  width: W,
  height: H,
  bitrateMbps: 4,
  quality: "social",
  crf: 20,
  audioKbps: 192,
  fastMode: true,
  slideshowFps24: true,
  totalMs: Math.round(TOTAL_SEC * 1000),
  segments: MODE === "audioonly" ? [] : [seg],
  audioPath: null,
  musicClips: [
    { path: voice, startMs: 0, volume: 1, loop: false, durationMs: Math.round(TOTAL_SEC * 1000), fileName: "voice.m4a", role: "voice" },
  ],
  audio: { normalize: false, masterVolume: 1, fadeInMs: 0, fadeOutMs: 0, musicVolume: 1, musicStartMs: 0, musicLoop: false },
  captionSettings: {
    enabled: true, presetId: "classic", fontId: "montserrat", customColor: null,
    customPosition: null, fontSizeScale: 1, balancedWrap: true, wordMode: "off",
    animation: null, kinetic: { enabled: false },
  },
  subtitleCues: cues,
  headlines: null,
  transition: null,
  watermark: null,
  kenBurns: { enabled: false, intensity: 0, direction: "in" },
  useRustEngine: false, // force the CLI pipeline (the user's path)
};

// ── run the REAL handler with a hard global watchdog ──────────────────────
(async () => {
  const handler = handlers.get("export-native");
  if (!handler) throw new Error("export-native handler not captured");
  const HARD_TIMEOUT_MS = 15 * 60 * 1000;
  let settled = false;
  const watchdog = setTimeout(() => {
    if (settled) return;
    console.log("\n[HANG] export-native did not settle — dumping state:");
    console.log(`  events: ${events.length}, last:`);
    for (const e of events.slice(-8)) console.log("   ", JSON.stringify(e));
    console.log("  (process will exit non-zero)");
    process.exit(2);
  }, HARD_TIMEOUT_MS);

  console.log("[run] invoking export-native …");
  try {
    const res = await handler(fakeEvent, payload);
    settled = true;
    clearTimeout(watchdog);
    console.log(`\n[OK] export-native RESOLVED in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(`  path=${res.path} size=${res.size} mode=${res.mode} elapsed=${res.elapsedSec}s faststartSkipped=${res.faststartSkipped ?? false}`);
    const pr = spawnSync(FFMPEG, ["-hide_banner", "-i", res.path], { encoding: "utf8" });
    const m = (pr.stderr || "").match(/Duration: (\d+):(\d+):(\d+\.?\d*)/);
    console.log(`  probed output duration: ${m ? `${m[1]}:${m[2]}:${m[3]}` : "?"}`);
    // phase timeline summary
    const phases = [];
    for (const e of events) {
      if (!phases.length || phases[phases.length - 1].phase !== e.phase) {
        phases.push({ phase: e.phase, at: e.at ?? 0, pct: e.progress });
      }
    }
    const last = events[events.length - 1];
    console.log("  last event:", JSON.stringify(last));
    const pctSeries = events.map((e) => e.progress);
    console.log(`  events=${events.length} · pct min→max ${Math.min(...pctSeries).toFixed(2)}→${Math.max(...pctSeries).toFixed(2)} · phases seen: ${[...new Set(events.map((e) => e.phase))].join(",")}`);
    const zeroEta = events.filter((e) => e.eta === 0 && e.progress < 99.9).length;
    console.log(`  events with eta=0 while <99.9%: ${zeroEta}`);
  } catch (e) {
    settled = true;
    clearTimeout(watchdog);
    console.log(`\n[ERROR] export-native REJECTED after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${e.message}`);
    const last = events[events.length - 1];
    console.log("  last event:", JSON.stringify(last));
    process.exitCode = 3;
  } finally {
    // keep temp files for inspection? remove to save disk
    if (!process.env.KEEP) fs.rmSync(WORK, { recursive: true, force: true });
  }
})();
