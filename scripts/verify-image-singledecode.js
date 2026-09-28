#!/usr/bin/env node
/**
 * scripts/verify-image-singledecode.js — v1.14.6 root-cause fix:
 * "a 22-min audio with 85 images and one with 259 images take the SAME
 * export time."
 *
 * ROOT CAUSE (measured): static images (Ken Burns off — the app default)
 * rode `-loop 1 -framerate <fps> -t <dur>` inputs, which makes the image2
 * demuxer RE-DECODE the full-resolution still once per OUTPUT FRAME. Cost
 * therefore scales with duration × fps (total frames), NOT with image
 * count — 85 vs 259 images over the same 22 min are the same 31,680 frames
 * of full-res decode+scale, so identical wall time.
 *
 * FIX: every image now rides the single-frame input (no -loop): decode +
 * supersample ONCE, zoompan emits exactly the window's frames (kbEnabled
 * false → the frozen z=1.1 chain; the v6.5 frame-exactness machinery).
 * A/B on a 12 MP still: 5.37 s → 0.87 s per 10 s of 1080p24 (6.2×).
 *
 * U1 unit — STATIC images (kbEnabled=false) get the single-frame input (no
 *      -loop/-framerate) and the zoompan chain (frozen z='1.1', d=segFrames).
 * U2 unit — WINDOWED static image keeps d=emitFrames (meta k1-k0) + onOffset.
 * E1 e2e — 4 static images + music (KB OFF, slideshow off): EXACTLY
 *      16 s × 30 fps = 480 frames, audio present, audioNormalize=false.
 * E1b e2e — same with the default slideshow 24 fps: 384 frames exact.
 * E2 e2e — fractional durations: 3 × 3.5 s @ 30 fps = 315 frames exact.
 * E3 e2e — Ken Burns ON regression (animated zoompan still frame-exact).
 * B1 bench — raw ffmpeg A/B loop-decode vs single-decode (informational
 *      ratio print; NOT gating — the sandbox's 2 cores are shared).
 *
 * Run: node scripts/verify-image-singledecode.js
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FF = "/usr/bin/ffmpeg";
const FFPROBE = "/usr/bin/ffprobe";
const TMP = "/tmp/ffsingledecode";
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// ── electron stub (verify-overlay-caption-order.js pattern) ──────────
const handlers = {};
const electronStub = {
  app: {
    whenReady: () => Promise.resolve(),
    on: () => {},
    getPath: (k) => path.join(TMP, "userData"),
    getName: () => "FrameFuse",
    getVersion: () => "1.15.2",
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
const stubModule = new Module(resolvedElectron, null);
stubModule.filename = resolvedElectron;
stubModule.loaded = true;
stubModule.exports = electronStub;
require.cache[resolvedElectron] = stubModule;

function run(bin, args, timeout = 120000) {
  const r = spawnSync(bin, args, { timeout });
  if (r.status !== 0) throw new Error(`${bin} failed: ${r.stderr && r.stderr.toString().slice(0, 400)}`);
  return r;
}
function frameCount(p) {
  return parseInt(spawnSync(FFPROBE, ["-v", "error", "-select_streams", "v", "-count_packets",
    "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", p], { encoding: "utf8" }).stdout || "0", 10);
}
function durationSec(p) {
  return parseFloat(spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p], { encoding: "utf8" }).stdout || "0");
}
function hasAudio(p) {
  return /audio/i.test(spawnSync(FFPROBE, ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", p], { encoding: "utf8" }).stdout || "");
}

const results = [];
function report(id, name, pass, detail) {
  console.log(`── ${id}: ${name} → ${pass ? "PASS" : "FAIL"}${detail ? `  (${detail})` : ""}`);
  results.push({ id, pass });
}

// ── fixtures ──────────────────────────────────────────────────────────
const W = 640, H = 360, FPS = 30;
console.log("── generating fixtures ──");
for (let k = 0; k < 4; k++) {
  run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", `testsrc2=s=${W}x${H}:r=${FPS}`, "-frames:v", "1", `${TMP}/i${k}.png`]);
}
run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
  "-i", "sine=frequency=220:r=48000:d=30,volume=0.3", "-c:a", "pcm_s16le", `${TMP}/music.wav`]);
// 12 MP still for the A/B bench (the user's real-world shape).
run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
  "-i", "testsrc2=size=4000x3000:duration=1", "-frames:v", "1", "-q:v", "2", `${TMP}/big.jpg`]);

function imgSeg(k, durMs, startMs) {
  const s = startMs != null ? startMs : durMs * 0; // explicit cumulative start
  return {
    id: `img${k}`, fileName: `i${k}.png`, mediaType: "image",
    imagePath: `${TMP}/i${k}.png`,
    startMs: s, endMs: s + durMs, durationMs: durMs,
    track: 0, volume: 1, trimInMs: 0, speed: 1, sourceDurationMs: null,
    direction: "in",
  };
}
/** N static images × durMs with CUMULATIVE timeline positions (the app's
 * buildTimeline always ships cumulative startMs/endMs — the planner's
 * totalMs = max(endMs) and zone math depend on it). */
function staticTimeline(n, durMs) {
  return Array.from({ length: n }, (_, k) => imgSeg(k, durMs, k * durMs));
}

// ── U1/U2: unit — the graph builder itself ────────────────────────────
{
  const SP = require(path.join(ROOT, "electron", "export-singlepass.js"));
  // U1: whole-timeline static plan.
  const segs = [imgSeg(0, 4000), imgSeg(1, 4000)];
  const plan = SP.buildSinglePassPlan({
    segments: segs, fullSegments: segs,
    fps: FPS, width: W, height: H, totalMs: 8000,
    kbEnabled: false, zoomMax: 1.25, globalDir: "in",
    transition: null, wm: null, assSuffix: null, overlaySpecs: [],
    audio: {}, audioPath: null, sfx: [], clipAudio: [],
    loudnorm: null, masterLoudnorm: null,
  });
  const loopInputs = [];
  for (let i = 0; i < plan.inputs.length; i++) {
    if (plan.inputs[i] === "-loop") loopInputs.push(plan.inputs.slice(i, i + 5).join(" "));
  }
  const staticChains = (plan.script.match(/loop=loop=\d+:size=1,settb=1\/30,setpts=N/g) || []).length;
  const coverFit = plan.script.includes(
    `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,format=yuv420p,loop=`,
  );
  const legacyChain = plan.script.includes(`scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=`);
  const frozenZ = /zoompan=z='1\.1':/.test(plan.script);
  report("U1", "static plan: single-frame inputs + cover-fit loop chains (no zoompan)",
    loopInputs.length === 0 && staticChains === 2 && coverFit && !frozenZ && !legacyChain,
    `loops=${loopInputs.length} loopChains=${staticChains} coverFit=${coverFit} frozenZ=${frozenZ} legacy=${legacyChain}`);

  // U2: windowed static plan — loop=emitFrames-1 (k1-k0) + single-frame input.
  const wsegs = [imgSeg(0, 3500)];
  const wplan = SP.buildSinglePassPlan({
    segments: wsegs, fullSegments: [imgSeg(0, 3500)],
    window: { t0Ms: 2000, durMs: 3000, segMeta: [{ origIdx: 0, S: 0, F: 105, k0: 60, k1: 135, ssSec: null }] },
    fps: FPS, width: W, height: H, totalMs: 3500,
    kbEnabled: false, zoomMax: 1.25, globalDir: "in",
    transition: null, wm: null, assSuffix: null, overlaySpecs: [],
    audio: {}, audioPath: null, sfx: [], clipAudio: [],
    loudnorm: null, masterLoudnorm: null,
  });
  const dOk = /loop=loop=74:size=1,settb=1\/30,setpts=N/.test(wplan.script);
  const wLoops = wplan.inputs.includes("-loop");
  report("U2", "windowed static: loop=74 (k1-k0) + single-frame input",
    dOk && !wLoops, `loop74=${dOk} loop=${wLoops}`);
}

// ── E1/E1b/E2/E3: end-to-end through the REAL export-native handler ──
(async () => {
  require(path.join(ROOT, "electron", "main.js"));
  const exportHandler = handlers["export-native"];
  if (!exportHandler) throw new Error("export-native handler not registered");

  async function runExport(outPath, o) {
    const segments = o.segments;
    const totalMs = segments.reduce((a, s) => a + s.durationMs, 0);
    const opts = {
      outputPath: outPath,
      fps: o.fps || FPS, width: W, height: H,
      bitrateMbps: 8, quality: "social", crf: 20, audioKbps: 192,
      slideshowFps24: o.slideshowFps24,
      kenBurns: { enabled: !!o.kenBurns, intensity: 50, direction: "in" },
      segments,
      audioPath: `${TMP}/music.wav`,
      audio: { normalize: false, masterVolume: 1, fadeInMs: 0, fadeOutMs: 0, musicVolume: 0.8, musicStartMs: 0, musicLoop: true },
      captionSettings: null, subtitleCues: null, headlines: [],
      transition: null, watermark: null, overlays: [], sfx: [],
    };
    const fakeEvent = { sender: { isDestroyed: () => false, send: () => {} } };
    const t0 = Date.now();
    const result = await exportHandler(fakeEvent, opts);
    return { ms: Date.now() - t0, result };
  }

  function nonBlackRatio(p, tSec) {
    const out = `${TMP}/frame.raw`;
    fs.rmSync(out, { force: true });
    run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(tSec), "-i", p,
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", out]);
    const buf = fs.readFileSync(out);
    let black = 0;
    for (let i = 0; i + 2 < buf.length; i += 3) {
      if (buf[i] < 35 && buf[i + 1] < 35 && buf[i + 2] < 35) black++;
    }
    return 1 - black / (buf.length / 3);
  }

  // E1: 4 static images × 4 s @ 30 fps (slideshow OFF) → 480 frames EXACT.
  {
    const out = `${TMP}/e1.mp4`;
    const r = await runExport(out, { segments: staticTimeline(4, 4000), slideshowFps24: false });
    const n = frameCount(out);
    const d = durationSec(out);
    const content = nonBlackRatio(out, 2.0);
    report("E1", "4 static imgs · 16 s @ 30 fps → 480 frames, audio, normalize OFF",
      n === 480 && Math.abs(d - 16) < 0.35 && hasAudio(out) && content > 0.5 && r.result.audioNormalize === false,
      `frames=${n} dur=${d.toFixed(2)}s audio=${hasAudio(out)} content=${(content * 100).toFixed(0)}% norm=${r.result.audioNormalize} mode=${r.result.mode} ${(r.ms / 1000).toFixed(1)}s`);
  }

  // E1b: default slideshow 24 fps path → 384 frames.
  {
    const out = `${TMP}/e1b.mp4`;
    const r = await runExport(out, { segments: staticTimeline(4, 4000) });
    const n = frameCount(out);
    report("E1b", "slideshow 24 fps path → 384 frames exact",
      n === 384, `frames=${n} mode=${r.result.mode} slideshow=${!!r.result.slideshowFps} ${(r.ms / 1000).toFixed(1)}s`);
  }

  // E2: fractional durations 3 × 3.5 s @ 30 fps → 315 frames.
  {
    const out = `${TMP}/e2.mp4`;
    const r = await runExport(out, { segments: staticTimeline(3, 3500), slideshowFps24: false });
    const n = frameCount(out);
    report("E2", "3 × 3.5 s (fractional) → 315 frames exact",
      n === 315, `frames=${n} mode=${r.result.mode} ${(r.ms / 1000).toFixed(1)}s`);
  }

  // E3: Ken Burns ON regression.
  {
    const out = `${TMP}/e3.mp4`;
    const r = await runExport(out, { segments: staticTimeline(4, 4000), kenBurns: true, slideshowFps24: false });
    const n = frameCount(out);
    const content = nonBlackRatio(out, 2.0);
    report("E3", "Ken Burns ON regression → 480 frames + motion content",
      n === 480 && content > 0.5, `frames=${n} content=${(content * 100).toFixed(0)}% mode=${r.result.mode} ${(r.ms / 1000).toFixed(1)}s`);
  }

  // B1: raw A/B — informational only (shared 2-core sandbox).
  {
    const t = (args) => {
      const t0 = Date.now();
      run(FF, ["-nostdin", "-hide_banner", "-loglevel", "error", ...args], 300000);
      return Date.now() - t0;
    };
    const aMs = t(["-loop", "1", "-framerate", "24", "-t", "10", "-i", `${TMP}/big.jpg`,
      "-vf", "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=24,setsar=1,format=yuv420p",
      "-c:v", "libx264", "-preset", "ultrafast", "-f", "null", "-"]);
    const bMs = t(["-i", `${TMP}/big.jpg`,
      "-vf", "scale=2112:1188:force_original_aspect_ratio=increase:flags=lanczos,crop=2112:1188,zoompan=z='1.1':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=240:s=1920x1080:fps=24,setsar=1,format=yuv420p",
      "-c:v", "libx264", "-preset", "ultrafast", "-f", "null", "-"]);
    console.log(`── B1: A/B loop-decode ${aMs} ms vs single-decode ${bMs} ms → ${(aMs / Math.max(1, bMs)).toFixed(2)}× (informational)`);
  }

  const fails = results.filter((r) => !r.pass);
  console.log("");
  console.log(`RESULT: ${results.length - fails.length}/${results.length} PASS${fails.length ? " — FAILURES: " + fails.map((f) => f.id).join(", ") : ""}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
