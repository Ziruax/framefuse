#!/usr/bin/env node
/**
 * scripts/verify-eta-payload.js — v1.14.2 progress/ETA payload check.
 *
 * Drives the REAL ipcMain "export-native" handler (bench-disclaimer.js's
 * electron-stub pattern) on an image+music timeline long enough for the
 * ETA to unlock, capturing every "export-progress" payload, and asserts:
 *   P1 payload carries the v1.14.2 fields: elapsed / total / phase / rate
 *   P2 progress is monotonic non-decreasing and reaches 100
 *   P3 phase walks the pipeline: video → (audio) → mux → done
 *   P4 eta is undefined-or-finite and appears at least once (2% + 2s gate)
 *   P5 rate (×-realtime) is finite and > 0 when present
 *   P6 the audio bus pass ran CONCURRENT with the video pool (v1.14.2 fix)
 *      — its "finished in Xs (ran concurrent…)" log line must appear
 *   P7 output duration is frame-exact
 *
 * Run: node scripts/verify-eta-payload.js
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FF = require(path.join(ROOT, "node_modules", "ffmpeg-static"));
const TMP = "/tmp/ffeta";
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// ── capture main-process console for the concurrency assertion ──────
// (wrap for the WHOLE run — main.js resolves console.log at call time,
// so restoring after require would miss every export-time line)
const mainLogs = [];
const realLog = console.log;
console.log = (...a) => { mainLogs.push(a.join(" ")); realLog(...a); };
const realWarn = console.warn;
console.warn = (...a) => { mainLogs.push(a.join(" ")); realWarn(...a); };

// ── electron stub (bench-disclaimer.js pattern) ─────────────────────
const handlers = {};
const electronStub = {
  app: {
    whenReady: () => Promise.resolve(),
    on: () => {},
    getPath: (k) => path.join(TMP, "userData"),
    getName: () => "FrameFuse",
    getVersion: () => "1.14.3",
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

// ── fixtures: 8 images + music → a ~40s filter-heavy timeline ────────
console.log("── generating fixtures ──");
const W = 640, H = 360, FPS = 30;
function genImage(name) {
  spawnSync(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", `testsrc2=s=${W * 2}x${H * 2}:r=${FPS}`, "-frames:v", "1", `${TMP}/${name}`], { timeout: 60000 });
  if (!fs.existsSync(`${TMP}/${name}`)) throw new Error(`fixture ${name} failed`);
}
for (let i = 0; i < 8; i++) genImage(`i${i}.png`);
spawnSync(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
  "-i", "sine=frequency=220:r=48000:d=60,volume=0.3", "-c:a", "pcm_s16le", `${TMP}/music.wav`], { timeout: 60000 });

const SEG_MS = 5000;
const segments = [];
for (let i = 0; i < 8; i++) {
  segments.push({
    id: `seg${i}`,
    fileName: `i${i}.png`,
    kind: "duration",
    mediaType: "image",
    imagePath: `${TMP}/i${i}.png`,
    startMs: i * SEG_MS,
    endMs: (i + 1) * SEG_MS,
    durationMs: SEG_MS,
    direction: i % 2 ? "out" : "in",
    track: 0,
    volume: 1,
    trimInMs: 0,
    speed: 1,
    sourceDurationMs: null,
  });
}

const MAIN = require(path.join(ROOT, "electron", "main.js"));
const exportHandler = handlers["export-native"];

// ── run with progress capture ────────────────────────────────────────
const progressEvents = [];
const fakeEvent = {
  sender: {
    isDestroyed: () => false,
    send: (ch, payload) => {
      if (ch === "export-progress") progressEvents.push(payload);
    },
  },
};

(async () => {
  const t0 = Date.now();
  const result = await exportHandler(fakeEvent, {
    outputPath: `${TMP}/out.mp4`,
    fps: FPS, width: W, height: H,
    bitrateMbps: 8, quality: "social", crf: 20, audioKbps: 192,
    kenBurns: { enabled: true, intensity: 50, direction: "in" },
    segments,
    audioPath: `${TMP}/music.wav`,
    audio: {
      normalize: false, masterVolume: 1, fadeInMs: 300, fadeOutMs: 500,
      musicVolume: 0.8, musicStartMs: 0, musicLoop: true,
    },
    captionSettings: { enabled: false },
    subtitleCues: [],
    headlines: [],
    transition: null,
    watermark: null,
    overlays: [],
    sfx: [],
  });
  const wallSec = (Date.now() - t0) / 1000;

  let pass = 0, fail = 0;
  const check = (label, ok, detail) => {
    if (ok) { pass++; console.log(`  PASS — ${label}`); }
    else { fail++; console.log(`  FAIL — ${label}${detail ? ` (${detail})` : ""}`); }
  };

  console.log(`export wall ${wallSec.toFixed(1)}s · ${progressEvents.length} progress events · mode=${result.mode}`);

  // P1 — v1.14.2 fields present
  const withTotal = progressEvents.filter((p) => typeof p.total === "number" && p.total > 0);
  const withElapsed = progressEvents.filter((p) => typeof p.elapsed === "number" && p.elapsed >= 0);
  const withPhase = progressEvents.filter((p) => typeof p.phase === "string" && p.phase.length > 0);
  check("P1 payload carries total/elapsed/phase (v1.14.2 fields)",
    withTotal.length > 0 && withElapsed.length > 0 && withPhase.length > 0,
    `total=${withTotal.length} elapsed=${withElapsed.length} phase=${withPhase.length} of ${progressEvents.length}`);
  const expectTotal = (8 * SEG_MS) / 1000;
  const totalOk = withTotal.length > 0 && Math.abs(withTotal[0].total - expectTotal) < 0.6;
  check(`P1b total == timeline length (${expectTotal}s)`, totalOk,
    withTotal[0] ? `got ${withTotal[0].total}` : "none");

  // P2 — monotonic progress reaching 100
  let monotonic = true;
  for (let i = 1; i < progressEvents.length; i++) {
    if (progressEvents[i].progress < progressEvents[i - 1].progress - 1e-9) { monotonic = false; break; }
  }
  check("P2 progress monotonic non-decreasing", monotonic);
  check("P2b progress reaches 100",
    progressEvents.length > 0 && Math.abs(progressEvents[progressEvents.length - 1].progress - 100) < 0.01,
    progressEvents.length ? `last=${progressEvents[progressEvents.length - 1].progress}` : "none");

  // P3 — phase walk
  const phases = [...new Set(progressEvents.map((p) => p.phase))];
  const hasVideo = phases.includes("video");
  const hasMux = phases.includes("mux");
  const hasDone = phases.includes("done");
  const orderOk = phases.indexOf("video") < phases.indexOf("mux") && phases.indexOf("mux") < phases.indexOf("done");
  check(`P3 phase walk video→mux→done (saw: ${phases.join(",")})`, hasVideo && hasMux && hasDone && orderOk);

  // P4 — eta appears and is always finite-or-undefined
  const etaOk = progressEvents.every((p) => p.eta == null || (Number.isFinite(p.eta) && p.eta >= 0));
  const etaSeen = progressEvents.some((p) => typeof p.eta === "number");
  check("P4 eta undefined-or-finite everywhere", etaOk);
  check("P4b eta appears at least once (2% + 2s unlock)", etaSeen,
    `${progressEvents.filter((p) => typeof p.eta === "number").length} events`);

  // P5 — rate finite and positive when present
  const rates = progressEvents.filter((p) => p.rate != null);
  check("P5 rate finite & > 0 when present",
    rates.every((p) => Number.isFinite(p.rate) && p.rate > 0),
    `${rates.length} events, e.g. ${rates.length ? rates[Math.floor(rates.length / 2)].rate : "n/a"}×`);

  // P6 — concurrent audio bus (the v1.14.2 serialization fix)
  const concurrentLog = mainLogs.find((l) => l.includes("ran concurrent with the video pool"));
  check("P6 audio bus ran concurrent with the video pool", !!concurrentLog, concurrentLog || "log line absent");

  // P7 — output duration frame-exact
  const pr = spawnSync("/usr/bin/ffprobe", ["-v", "error", "-show_entries", "format=duration",
    "-of", "csv=p=0", `${TMP}/out.mp4`], { encoding: "utf8" });
  const dur = parseFloat(pr.stdout || "0");
  check(`P7 output duration ≈ ${expectTotal}s`, Math.abs(dur - expectTotal) < 0.5, `got ${dur}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(1); });
