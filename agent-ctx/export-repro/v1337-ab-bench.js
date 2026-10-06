// agent-ctx/export-repro/v1337-ab-bench.js — the A/B export benchmark:
// the SAME payload (the user's scenario shape: loop-to-fill video + long
// voice audio + burned captions + audio-extended timeline) through BOTH
// export methods in the REAL electron/main.js handler:
//   A) useRustEngine: true  → the v0.3 Rust native engine (single pass)
//   B) useRustEngine: false → the v1.33.6 FFmpeg-CLI two-step pipeline
// Wall-clock + output probe + intermediate disk footprint are compared.
//
// Usage: node agent-ctx/export-repro/v1337-ab-bench.js [totalSec]
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { spawn, spawnSync } = require("child_process");

const TOTAL_SEC = Number(process.argv[2]) || 300;
const ONLY = process.argv[3] || "both"; // rust | cli | both (one pass per run)
const FFMPEG = "/usr/bin/ffmpeg";
const FFPROBE = "/usr/bin/ffprobe";
const ROOT = path.join(__dirname, "..", "..");
const WORK = fs.mkdtempSync("/tmp/v1337-");
const W = 320, H = 180, FPS = 24;

// ── electron stub with CAPTURING ipcMain (the v1336 pattern) ───────────────
const handlers = new Map();
const electronStub = {
  app: {
    whenReady: () => Promise.resolve(),
    on: () => {},
    getPath: (k) => path.join(WORK, "userData"),
    getAppPath: () => ROOT,
    getName: () => "FrameFuse",
    getVersion: () => "1.33.7",
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

require(path.join(ROOT, "electron", "main.js"));

function mkEvent(events) {
  let lastLog = 0;
  const t0 = Date.now();
  return {
    sender: {
      isDestroyed: () => false,
      send: (channel, payload) => {
        if (channel !== "export-progress") return;
        events.push(payload);
        const now = Date.now();
        if (now - lastLog > 15000 || payload.progress >= 100) {
          lastLog = now;
          console.log(`  [${((now - t0) / 1000).toFixed(0).padStart(5)}s] ${String(payload.progress).padStart(6)}% phase=${payload.phase ?? "?"} elapsed=${payload.elapsed ?? "—"} eta=${payload.eta ?? "—"}`);
        }
      },
    },
  };
}

// ── fixtures ───────────────────────────────────────────────────────────────
const loopSrc = path.join(WORK, "loop10.mp4");
{
  const r = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc2=size=${W}x${H}:rate=${FPS}`,
    "-f", "lavfi", "-i", "sine=frequency=220:duration=10",
    "-t", "10", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "400k",
    "-c:a", "aac", "-b:a", "128k", "-shortest", "-y", loopSrc], { timeout: 120000 });
  if (r.status !== 0) throw new Error("fixture loop: " + r.stderr);
}
const voice = path.join(WORK, "voice.m4a");
{
  const r = spawnSync(FFMPEG, ["-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `sine=frequency=330:duration=${TOTAL_SEC},tremolo=f=2:d=0.3`,
    "-c:a", "aac", "-b:a", "128k", "-y", voice], { timeout: 300000 });
  if (r.status !== 0) throw new Error("fixture voice: " + r.stderr);
}
const cues = [];
for (let s = 0; s < TOTAL_SEC - 5; s += 20) {
  cues.push({ startMs: s * 1000, endMs: (s + 4) * 1000, text: `caption @ ${s}s` });
}

function buildPayload(outPath, useRust) {
  return {
    outputPath: outPath,
    fps: FPS, width: W, height: H,
    bitrateMbps: 4, quality: "social", crf: 20, audioKbps: 192,
    fastMode: true, slideshowFps24: true,
    totalMs: Math.round(TOTAL_SEC * 1000),
    segments: [{
      id: "seg1", videoPath: loopSrc, direction: null,
      durationMs: Math.round(TOTAL_SEC * 1000),
      startMs: 0, endMs: Math.round(TOTAL_SEC * 1000),
      mediaType: "video", track: 0, volume: 1, trimInMs: 0,
      sourceDurationMs: 10000, chroma: null, overlay: null, loop: true,
    }],
    audioPath: null,
    musicClips: [
      { path: voice, startMs: 0, volume: 1, loop: false, durationMs: Math.round(TOTAL_SEC * 1000), fileName: "voice.m4a", role: "voice" },
    ],
    audio: { normalize: false, masterVolume: 1, fadeInMs: 0, fadeOutMs: 0, musicVolume: 1, musicStartMs: 0, musicLoop: false },
    captionSettings: {
      // faithful to native.ts ipcCaptionSettings (the REAL renderer payload)
      enabled: true, presetId: "classic", fontId: "montserrat",
      fontName: "Montserrat", fontSize: 0.085, fontSizeScale: 1,
      fontWeight: 700, fontStyle: "normal",
      textColor: "#FFFFFF", customColor: null,
      borderColor: "#000000", borderWidth: 4,
      highlightColor: null,
      bgColor: null, bgAlpha: 0.75, bgPadding: 12,
      shadow: true, shadowBlur: 3,
      textTransform: "none", letterSpacing: 0,
      alignment: "center", customPosition: null, position: "bottom", positionY: 82,
      maxWidth: 0.84, balancedWrap: true, wordMode: "off",
      animation: null, kinetic: { enabled: false },
    },
    subtitleCues: cues,
    headlines: null, transition: null, watermark: null,
    kenBurns: { enabled: false, intensity: 0, direction: "in" },
    useRustEngine: useRust,
  };
}

function probe(file) {
  const r = spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration,size", "-of", "csv=p=0", file], { encoding: "utf8", timeout: 60000 });
  const [dur, size] = String(r.stdout || "").trim().split(",");
  return { dur: Number(dur) || 0, size: Number(size) || 0 };
}

function duWork() {
  // intermediate footprint = everything in WORK except the fixtures + outputs
  let total = 0;
  const skip = new Set([path.basename(loopSrc), path.basename(voice), "out_rust.mp4", "out_cli.mp4"]);
  for (const f of fs.readdirSync(WORK)) {
    if (skip.has(f)) continue;
    try { total += fs.statSync(path.join(WORK, f)).size; } catch {}
  }
  return total;
}

(async () => {
  const handler = handlers.get("export-native");
  if (!handler) throw new Error("export-native not captured");
  const results = {};

  const passes = ONLY === "rust" ? [["RUST", true]] : ONLY === "cli" ? [["CLI", false]] : [["RUST", true], ["CLI", false]];
  for (const [name, useRust] of passes) {
    const events = [];
    const out = path.join(WORK, name === "RUST" ? "out_rust.mp4" : "out_cli.mp4");
    const t0 = Date.now();
    let err = null;
    try {
      const res = await handler(mkEvent(events), buildPayload(out, useRust));
      results[name] = {
        wallSec: (Date.now() - t0) / 1000,
        method: res.method || res.engine || "?",
        encoder: res.encoder || "?",
        frames: res.framesEncoded ?? 0,
        size: res.size ?? 0,
        probe: probe(out),
        events: events.length,
        lastProgress: events.length ? events[events.length - 1].progress : null,
        etaZeroEvents: events.filter((e) => e.eta === 0).length,
        telemetry: res.rustCompositorMs != null
          ? `composite=${res.rustCompositorMs}ms encode=${res.rustEncodeMs}ms decode=${res.rustDecodeMs}ms audio=${res.rustAudioMs}ms`
          : undefined,
      };
    } catch (e) {
      err = e;
      results[name] = { wallSec: (Date.now() - t0) / 1000, ERROR: String(e.message) };
    }
    const r = results[name];
    console.log(`\n[${name}] ${r.ERROR ? "FAILED: " + r.ERROR : "ok"} — wall ${r.wallSec.toFixed(1)}s` +
      (r.probe ? ` · ${r.probe.dur.toFixed(1)}s @ ${(r.probe.size / 1e6).toFixed(1)}MB` : "") +
      (r.method ? ` · method=${r.method}` : "") +
      (r.frames ? ` · frames=${r.frames}` : "") +
      (r.events != null ? ` · progEvents=${r.events} (last=${r.lastProgress}%, eta0=${r.etaZeroEvents})` : "") +
      (r.telemetry ? ` · telem=${r.telemetry}` : ""));
    // clean intermediates for the next pass's footprint measurement
    for (const f of fs.readdirSync(WORK)) {
      if (["out_rust.mp4", "out_cli.mp4", path.basename(loopSrc), path.basename(voice)].includes(f)) continue;
      try { fs.unlinkSync(path.join(WORK, f)); } catch {}
    }
  }

  console.log("\n==== A/B SUMMARY (timeline " + TOTAL_SEC + "s, " + W + "x" + H + "@" + FPS + ") ====");
  for (const name of ["RUST", "CLI"]) {
    const r = results[name];
    if (!r) { console.log(`${name}: (not run in this pass)`); continue; }
    if (r.ERROR) { console.log(`${name}: ERROR ${r.ERROR}`); continue; }
    console.log(`${name}: wall=${r.wallSec.toFixed(1)}s  out=${r.probe.dur.toFixed(2)}s/${(r.probe.size/1e6).toFixed(1)}MB  events=${r.events}  eta0=${r.etaZeroEvents}`);
  }
  if (results.RUST && results.RUST.probe && results.CLI && results.CLI.probe) {
    const speedup = results.CLI.wallSec / results.RUST.wallSec;
    console.log(`speedup (CLI/RUST wall): ${speedup.toFixed(2)}x`);
    console.log(`duration parity: |Δ|=${Math.abs(results.RUST.probe.dur - results.CLI.probe.dur).toFixed(2)}s (both should be ~${TOTAL_SEC}s)`);
  }
  process.exit(0);
})().catch((e) => { console.error("bench failed:", e); process.exit(1); });
