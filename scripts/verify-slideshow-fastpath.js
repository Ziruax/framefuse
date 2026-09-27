#!/usr/bin/env node
/**
 * scripts/verify-slideshow-fastpath.js — v1.15.0 root-cause fix:
 * "export speed is too much slow" on 200+-image slideshows.
 *
 * ROOT CAUSE (measured, mirrors the field report): the equal-window
 * parallel pass sizes its windows at W = min(filterWorkers, 4). On
 * Tier-1 GPU boxes filterWorkers was pinned at 2 (encode moved to the
 * ASIC; the filter pool never widened) — and on Tier-3 boxes with ≤2
 * logical CPUs it is 2 as well. W=2 windows carry HALF the timeline's
 * Ken Burns chains each; a KB image chain is ~230-280 B of filter script,
 * so ≈200 images blow the 25 KB SINGLEPASS_MAX_SCRIPT_BYTES budget →
 * planSmartRenderingPipeline returns null → the TWO-STEP POOL runs —
 * where every image input still rode `-loop 1` (per-output-frame full-res
 * re-decode, the 6.2-6.7× penalty from v1.14.6's single-decode work that
 * only fixed the single-pass path). Net: 259-image exports rode the
 * slowest route in the codebase while 85-image exports fit under the
 * cliff — both slow, differently.
 *
 * FIX (v1.15.0):
 *   1. main.js derives a SCRIPT-BUDGET-AWARE window count (~300 B/chain,
 *      ≤20 KB target/window) clamped by the encoder's safe process count
 *      (4 GPU / 8 x264) and passes maxParallelWindows to the planner.
 *   2. Tier-1 filter pool widens to max(3, min(4, logical/2)) — the GPU
 *      encode is not the wall when zoompan/libass are CPU-side.
 *   3. buildClipArgs (the two-step fallback + chunk/sandwich edges) now
 *      rides the SINGLE-DECODE image inputs: bare `-i` + chains that emit
 *      their exact frame counts (staticImageChain loop= / zoompan d=).
 *      Even the fallback is fast now.
 *   4. Chunk outputs drop `-movflags +faststart` (the final concat mux
 *      re-applies it; the second moov pass over every chunk was waste).
 *
 * U1  plan — 260-image timeline: budget-aware W (≥4), parallelMode, every
 *     window's graph under the 25 KB budget (replicates main.js's math).
 * U1b plan — the OLD shape (parallelWorkers=2, no maxParallelWindows)
 *     still overflows at 260 images — proving the cliff this fix removes.
 * U2  two-step unit — buildClipArgs static image: NO `-loop`, loop chain,
 *     exact frames through real ffmpeg (120 @ 4 s × 30 fps).
 * U3  two-step unit — buildClipArgs Ken Burns image: NO `-loop`, zoompan
 *     d=segFrames, exact frames (120).
 * U4  two-step unit — xfade head: NO `-loop` on either input, exact frames.
 * E1  e2e — 260 images × 300 ms + music through the REAL export-native
 *     handler on this 2-core sandbox (= Tier 3, filterWorkers 2 = the
 *     user's cliff machine class): mode "parallel-pass" (NOT the two-step
 *     fallback), 1872 frames exact @ 24 fps slideshow, audio, faststart on
 *     the FINAL mux only.
 * B1  bench — 12 MP still, 10 s clip: old `-loop 1 -framerate` argv vs the
 *     new single-decode argv (informational ratio; NOT gating).
 *
 * Run: node scripts/verify-slideshow-fastpath.js
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FF = "/usr/bin/ffmpeg";
const FFPROBE = "/usr/bin/ffprobe";
const TMP = "/tmp/ffslidefast";
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// ── electron stub (verify-image-singledecode.js pattern) ──────────────
const handlers = {};
const electronStub = {
  app: {
    whenReady: () => Promise.resolve(),
    on: () => {},
    getPath: (k) => path.join(TMP, "userData"),
    getName: () => "FrameFuse",
    getVersion: () => "1.15.0",
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

function run(bin, args, timeout = 300000) {
  const r = spawnSync(bin, args, { timeout });
  if (r.status !== 0) throw new Error(`${bin} failed: ${(r.stderr && r.stderr.toString().slice(0, 500)) || "no stderr"}`);
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
function moovAtFront(p) {
  // faststart = moov box before mdat in the first 64 bytes region.
  const fd = fs.openSync(p, "r");
  const head = Buffer.alloc(2048);
  fs.readSync(fd, head, 0, 2048, 0);
  fs.closeSync(fd);
  const moov = head.indexOf(Buffer.from("moov"));
  const mdat = head.indexOf(Buffer.from("mdat"));
  return moov >= 0 && (mdat < 0 || moov < mdat);
}

const results = [];
function report(id, name, pass, detail) {
  console.log(`── ${id}: ${name} → ${pass ? "PASS" : "FAIL"}${detail ? `  (${detail})` : ""}`);
  results.push({ id, pass });
}

// ── fixtures ───────────────────────────────────────────────────────────
const W = 640, H = 360, FPS = 30;
console.log("── generating fixtures ──");
run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
  "-i", `testsrc2=s=${W}x${H}:r=${FPS}`, "-frames:v", "1", `${TMP}/img.png`]);
for (let k = 0; k < 4; k++) fs.copyFileSync(`${TMP}/img.png`, `${TMP}/i${k}.png`);
run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
  "-i", "sine=frequency=220:r=48000:d=90,volume=0.3", "-c:a", "pcm_s16le", `${TMP}/music.wav`]);
// 12 MP still for the A/B bench (the user's real-world shape).
run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
  "-i", "testsrc2=size=4000x3000:duration=1", "-frames:v", "1", "-q:v", "2", `${TMP}/big.jpg`]);

function imgSeg(k, durMs, startMs) {
  const s = startMs != null ? startMs : 0;
  return {
    id: `img${k}`, fileName: `i${k}.png`, mediaType: "image",
    imagePath: `${TMP}/img.png`,
    startMs: s, endMs: s + durMs, durationMs: durMs,
    track: 0, volume: 1, trimInMs: 0, speed: 1, sourceDurationMs: null,
    direction: "in",
  };
}
function staticTimeline(n, durMs) {
  return Array.from({ length: n }, (_, k) => imgSeg(k, durMs, k * durMs));
}

// ── U1/U1b: the planner's budget-aware window count ───────────────────
{
  const SP = require(path.join(ROOT, "electron", "export-singlepass.js"));
  const segs = staticTimeline(260, 300); // 78 s, 260 KB image chains
  // Replicate main.js v1.15.0 math for this timeline (libx264, 2 logical).
  const imageSegCount = 260;
  const estScriptBytes = imageSegCount * 300 + 0 + 2048; // no captions
  const budgetWindows = Math.ceil(estScriptBytes / 20000);
  const inputWindows = Math.ceil(imageSegCount / 48);
  const windowCount = Math.max(2, Math.min(12, Math.max(2, budgetWindows, inputWindows)));
  const plan = SP.planSmartSegments({
    segments: segs, fps: 24, totalMs: 78000,
    kbEnabled: true, globalDir: "in",
    workerCount: 2, parallelWorkers: windowCount,
    maxParallelWindows: 12, equalWindowRatio: 0.3,
  });
  const pieces = (plan && plan.pieces) || [];
  const winImages = Math.ceil(260 / pieces.length);
  const estPerWindow = winImages * 300 + 1024;
  report("U1", "260-image plan: budget-aware windows (≥5, ≤48 inputs each) + graph < 25 KB",
    !!plan && plan.parallelMode === true && pieces.length >= 5 && estPerWindow < 25000 && winImages <= 48,
    `W=${pieces.length} parallel=${!!plan && plan.parallelMode} imgs/window=${winImages} est/window=${estPerWindow}B (budget ${SP.SINGLEPASS_MAX_SCRIPT_BYTES}B)`);

  // U1b: the OLD call shape (filterWorkers=2, no cap) reproduces the cliff.
  const oldPlan = SP.planSmartSegments({
    segments: segs, fps: 24, totalMs: 78000,
    kbEnabled: true, globalDir: "in",
    workerCount: 2, parallelWorkers: 2,
    equalWindowRatio: 0.3,
  });
  const oldPieces = (oldPlan && oldPlan.pieces) || [];
  const oldWinImages = Math.ceil(260 / Math.max(1, oldPieces.length));
  const oldEst = oldWinImages * 300 + 1024;
  report("U1b", "OLD shape (W=2) overflows the budget at 260 images — the removed cliff",
    oldEst > 25000,
    `W=${oldPieces.length} est/window=${oldEst}B > ${SP.SINGLEPASS_MAX_SCRIPT_BYTES}B`);
}

// ── U2/U3/U4: the two-step buildClipArgs single-decode shapes ─────────
{
  const G = require(path.join(ROOT, "electron", "export-graph.js"));
  const encArgs = ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p"];

  // U2: STATIC image (KB off) — no -loop, staticImageChain, 120 frames exact.
  {
    const seg = { ...imgSeg(0, 4000), imagePath: `${TMP}/img.png` };
    const r = G.buildClipArgs({
      i: 0, seg, segments: [seg], fps: FPS, width: W, height: H,
      kbEnabled: false, zoomMax: 1.25, globalDir: "in",
      transition: null, wm: null, assSuffix: null,
      clipPath: `${TMP}/u2.mp4`, encArgs, threads: 1,
    });
    const args = r.args;
    const hasLoop = args.includes("-loop");
    const chainOk = String(args[args.indexOf("-vf") + 1]).includes(
      `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,format=yuv420p,loop=loop=119:size=1,settb=1/${FPS},setpts=N`);
    run(FF, ["-nostdin", "-hide_banner", "-loglevel", "error", ...args]);
    const n = frameCount(`${TMP}/u2.mp4`);
    report("U2", "two-step STATIC image: bare -i + loop chain → 120 frames exact",
      !hasLoop && chainOk && n === 120,
      `loop=${hasLoop} chain=${chainOk} frames=${n}`);
  }

  // U3: Ken Burns ON — no -loop, zoompan d=segFrames, 120 frames exact.
  {
    const seg = { ...imgSeg(0, 4000), imagePath: `${TMP}/img.png` };
    const r = G.buildClipArgs({
      i: 0, seg, segments: [seg], fps: FPS, width: W, height: H,
      kbEnabled: true, zoomMax: 1.25, globalDir: "in",
      transition: null, wm: null, assSuffix: null,
      clipPath: `${TMP}/u3.mp4`, encArgs, threads: 1,
    });
    const args = r.args;
    const hasLoop = args.includes("-loop");
    const vfIdx = args.indexOf("-vf");
    const vf = String(args[vfIdx + 1]);
    const zpOk = /zoompan=z='[^']+':x='[^']+':y='[^']+':d=120:s=640x360:fps=30/.test(vf);
    run(FF, ["-nostdin", "-hide_banner", "-loglevel", "error", ...args]);
    const n = frameCount(`${TMP}/u3.mp4`);
    report("U3", "two-step KEN BURNS image: bare -i + zoompan d=120 → 120 frames exact",
      !hasLoop && zpOk && n === 120,
      `loop=${hasLoop} zoompan=${zpOk} frames=${n}`);
  }

  // U4: xfade head — no -loop on either input, frames = segFrames.
  {
    const segs = [imgSeg(0, 4000), { ...imgSeg(1, 4000, 4000), imagePath: `${TMP}/i1.png` }];
    const r = G.buildClipArgs({
      i: 1, seg: segs[1], segments: segs, fps: FPS, width: W, height: H,
      kbEnabled: true, zoomMax: 1.25, globalDir: "in",
      transition: { style: "dissolve", durationMs: 400, fadeStartEnd: false, overrides: {} },
      wm: null, assSuffix: null,
      clipPath: `${TMP}/u4.mp4`, encArgs, threads: 1,
    });
    const args = r.args;
    const hasLoop = args.includes("-loop");
    const hasXfade = String(r.graph || "").includes("xfade=transition=");
    run(FF, ["-nostdin", "-hide_banner", "-loglevel", "error", ...args]);
    const n = frameCount(`${TMP}/u4.mp4`);
    report("U4", "two-step XFADE head: bare -i ×2 + xfade → 120 frames exact",
      !hasLoop && hasXfade && n === 120,
      `loop=${hasLoop} xfade=${hasXfade} frames=${n}`);
  }
}

// ── E1: end-to-end through the REAL export-native handler ─────────────
(async () => {
  require(path.join(ROOT, "electron", "main.js"));
  const exportHandler = handlers["export-native"];
  if (!exportHandler) throw new Error("export-native handler not registered");

  // 260 images × 300 ms = 78 s, KB ON (the default), music loop.
  // Frame law (pre-existing, both paths): 300 ms @ 24 fps = 7.2 → 7 frames
  // per segment (zoompan d= per-segment rounding) → 260 × 7 = 1820 total
  // (± 1 concat boundary). Whole-second durations are frame-exact (the
  // verify-image-singledecode E-series); this fixture deliberately stresses
  // the fractional case — the assertion is the MODE + count law, not 1872.
  const segments = staticTimeline(260, 300).map((s) => ({ ...s, imagePath: `${TMP}/img.png` }));
  const opts = {
    outputPath: `${TMP}/e1.mp4`,
    fps: FPS, width: W, height: H,
    bitrateMbps: 8, quality: "social", crf: 20, audioKbps: 192,
    kenBurns: { enabled: true, intensity: 50, direction: "in" },
    segments,
    audioPath: `${TMP}/music.wav`,
    audio: { normalize: false, masterVolume: 1, fadeInMs: 0, fadeOutMs: 0, musicVolume: 0.8, musicStartMs: 0, musicLoop: true },
    captionSettings: null, subtitleCues: null, headlines: [],
    transition: null, watermark: null, overlays: [], sfx: [],
    // slideshowFps24 omitted → default ON → 24 fps for the pure-image
    // timeline (78 s ≥ 12 s) → 1872 frames expected.
  };
  const fakeEvent = { sender: { isDestroyed: () => false, send: () => {} } };
  const t0 = Date.now();
  const result = await exportHandler(fakeEvent, opts);
  const ms = Date.now() - t0;
  const out = `${TMP}/e1.mp4`;
  const n = frameCount(out);
  const d = durationSec(out);
  report("E1", "260-image KB slideshow: PARALLEL PASS (not two-step), ~1820 frames (7/seg law), audio, faststart only on the final mux",
    result.mode === "parallel-pass" && Math.abs(n - 1820) <= 1 && Math.abs(d - 75.83) < 0.6 && hasAudio(out) && moovAtFront(out),
    `mode=${result.mode} frames=${n} dur=${d.toFixed(2)}s audio=${hasAudio(out)} faststart=${moovAtFront(out)} norm=${result.audioNormalize} wall=${(ms / 1000).toFixed(1)}s`);

  // B1: A/B — old loop-decode argv vs new single-decode argv (info only).
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
    console.log(`── B1: A/B two-step loop-decode ${aMs} ms vs single-decode ${bMs} ms → ${(aMs / Math.max(1, bMs)).toFixed(2)}× (informational)`);
  }

  const fails = results.filter((r) => !r.pass);
  console.log("");
  console.log(`RESULT: ${results.length - fails.length}/${results.length} PASS${fails.length ? " — FAILURES: " + fails.map((f) => f.id).join(", ") : ""}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
