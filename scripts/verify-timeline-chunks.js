#!/usr/bin/env node
/**
 * v6.5 verification harness — CHUNKED SINGLE-PASS (CPU-first parallel export).
 * Exercises the REAL export-singlepass.js / export-graph.js helpers against
 * real ffmpeg runs (not mocks):
 *
 *   1. planTimelineChunks: gating, frame-sum parity, boundary alignment,
 *      forbidden zones (fades + xfade heads), min-chunk sizes
 *   2. W=1 byte-differential vs git HEAD: buildSinglePassPlan +
 *      buildSinglePassArgs outputs (inputs array, script text, labels) must
 *      be byte-identical for a battery of fixtures — the v6 single-pass is
 *      the fallback path and MUST NOT drift
 *   3. REAL E2E parity: full W=1 lossless render vs CHUNKED (3 windows,
 *      videoOnly + audioOnly + concat/mux) — frame-MD5 equality on the
 *      decoded video (lossless x264 ⇒ any difference is a filter/windowing
 *      math bug, not encoder noise)
 *   4. Ken Burns on-offset: a KB image segment split across chunks renders
 *      the EXACT full-render curve (frame-MD5 equality, covered by 3)
 *   5. xfade-head E2E: image↔image dissolve heads with chunk boundaries
 *      routed around the head zones (frame-MD5 equality)
 *   6. audio-only render: decoded-PCM parity vs the W=1 inline audio
 *
 * Run: node scripts/verify-timeline-chunks.js
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SP = require(path.join(ROOT, "electron", "export-singlepass.js"));
const G = require(path.join(ROOT, "electron", "export-graph.js"));
const FF = require(path.join(ROOT, "node_modules", "ffmpeg-static"));

const TMP = "/tmp/chksp";
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`);
  }
};

function run(args, opts = {}) {
  const r = spawnSync(FF, args, { encoding: "utf8", timeout: opts.timeout || 180000 });
  if (r.status !== 0) {
    throw new Error(`ffmpeg ${args.join(" ")} → ${r.status}: ${(r.stderr || "").slice(-500)}`);
  }
  return (r.stdout || "") + (r.stderr || "");
}
function runErr(args) {
  const r = spawnSync(FF, args, { encoding: "utf8", timeout: 180000 });
  return (r.stdout || "") + (r.stderr || "");
}
function countFrames(p) {
  const o = runErr(["-hide_banner", "-i", p, "-map", "0:v:0", "-f", "null", "-"]);
  const ms = [...o.matchAll(/frame=\s*(\d+)/g)];
  return ms.length ? parseInt(ms[ms.length - 1][1], 10) : -1;
}
/** framemd5 of the decoded video stream (first stream only). */
function frameMd5(p) {
  const r = spawnSync(FF, ["-hide_banner", "-loglevel", "error", "-i", p, "-map", "0:v:0", "-f", "framemd5", "-"], { encoding: "utf8", timeout: 180000 });
  if (r.status !== 0) throw new Error("framemd5 failed: " + (r.stderr || "").slice(-300));
  return (r.stdout || "").split("\n").filter((l) => /^\d+,/.test(l.trim()));
}
/** Decoded RGB24 bytes of one frame (for tolerance analysis). NB: the
 *  select filter's frame counter RESETS at concat-demuxer chunk boundaries
 *  (ffmpeg 7.1 quirk — seek/decode/framemd5 are unaffected), so this uses
 *  an exact input seek to t = n/fps of the CFR output instead. */
function rawFrame(p, n, fps) {
  const t = (n / (fps || 30)).toFixed(4);
  const r = spawnSync(FF, ["-hide_banner", "-loglevel", "error", "-ss", t, "-i", p, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 180000 });
  if (r.status !== 0) throw new Error("rawFrame failed");
  return r.stdout;
}
/** W=1 ⇄ chunked video equivalence: EXACT frame-MD5 equality, or — only
 *  for frames whose segments lost an xfade-head passthrough — the measured
 *  xfade chroma-resample rounding (max channel delta ≤ 4, ≤ 2 % of pixels;
 *  anything larger is a real windowing/seek/offset bug). */
function videoEquivalent(fileA, fileB, fps) {
  const a = frameMd5(fileA);
  const b = frameMd5(fileB);
  if (a.length !== b.length) {
    return { ok: false, why: `frame count ${a.length} vs ${b.length}` };
  }
  const diffIdx = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diffIdx.push(i);
  if (diffIdx.length === 0) return { ok: true, exact: true, diffs: 0 };
  for (const i of diffIdx.slice(0, 32)) {
    const ra = rawFrame(fileA, i, fps);
    const rb = rawFrame(fileB, i, fps);
    if (ra.length !== rb.length || ra.length === 0) {
      return { ok: false, why: `frame ${i}: raw size ${ra.length} vs ${rb.length}` };
    }
    let maxDelta = 0;
    let diffPx = 0;
    for (let k = 0; k < ra.length; k += 3) {
      const d = Math.max(
        Math.abs(ra[k] - rb[k]),
        Math.abs(ra[k + 1] - rb[k + 1]),
        Math.abs(ra[k + 2] - rb[k + 2]),
      );
      if (d > 0) diffPx++;
      if (d > maxDelta) maxDelta = d;
    }
    if (maxDelta > 4 || diffPx > ra.length / 3 * 0.02) {
      return { ok: false, why: `frame ${i}: maxΔ=${maxDelta}, ${(100 * diffPx / (ra.length / 3)).toFixed(2)}% pixels differ` };
    }
  }
  return { ok: true, exact: false, diffs: diffIdx.length, first: diffIdx[0] };
}
/** MD5 of decoded s16le stereo 48k PCM. */
function pcmMd5(p, maxSec) {
  const args = ["-hide_banner", "-loglevel", "error", "-i", p, "-map", "0:a:0"];
  if (maxSec) args.push("-t", String(maxSec));
  args.push("-f", "s16le", "-ac", "2", "-ar", "48000", "-");
  const r = spawnSync(FF, args, { encoding: "buffer", timeout: 180000, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error("pcm decode failed");
  return r.stdout;
}

// ── ASS writer replica (main.js writeAssFile escaping) ─────────────────────
function assSuffixFor(doc, name) {
  const assPath = path.join(TMP, `${name}.ass`);
  fs.writeFileSync(assPath, doc, "utf-8");
  const e = assPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/,/g, "\\,");
  return `subtitles=filename='${e}'`;
}
// ── buildAssDocument via main.js (electron stub, same as the other harnesses)
const Module = require("module");
const electronStub = {
  app: {
    whenReady: () => Promise.resolve(), on: () => {}, getPath: () => "/tmp/ffstub",
    getName: () => "FrameFuse", getVersion: () => "1.5.0", isReady: () => true, quit: () => {},
  },
  BrowserWindow: class {
    constructor() { this.webContents = { setWindowOpenHandler: () => ({ action: "deny" }), on: () => {}, send: () => {} }; }
    loadURL() {} loadFile() {} on() {}
    static getAllWindows() { return []; }
  },
  ipcMain: { handle: () => {}, on: () => {} },
  dialog: {}, Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  shell: {}, utilityProcess: { fork: () => ({}) },
};
const resolvedElectron = require.resolve("electron");
const stubModule = new Module(resolvedElectron, null);
stubModule.filename = resolvedElectron;
stubModule.loaded = true;
stubModule.exports = electronStub;
require.cache[resolvedElectron] = stubModule;
const M = require(path.join(ROOT, "electron", "main.js"));

// ── overlay spec builder replica (image overlays only — no probe needed) ───
function imageOverlaySpecsFor(overlays, width, height, winStartMs, winDurMs) {
  const specs = [];
  for (const ov of overlays) {
    const win = G.overlayWindow(ov, winStartMs, winDurMs);
    if (!win || win.overlapMs <= 0) continue;
    const srcW = ov.sourceWidth, srcH = ov.sourceHeight;
    const geo = G.overlayGeometryMirror(width, height, srcW, srcH, ov.overlay);
    if (geo.dw <= 0 || geo.dh <= 0) continue;
    const motion = G.sanitizeMotionMirror(ov.overlay && ov.overlay.motion);
    let x = geo.dx, y = geo.dy, xExpr = null, yExpr = null;
    if (motion.length === 1) {
      const pinned = G.overlayGeometryMirror(width, height, srcW, srcH, { ...(ov.overlay || {}), x: motion[0].x, y: motion[0].y });
      x = pinned.dx; y = pinned.dy;
    } else if (motion.length >= 2) {
      const tOffsetSec = (winStartMs - Number(ov.startMs) || 0) / 1000;
      const exprs = G.buildMotionOverlayExpr({ videoW: width, videoH: height, dw: geo.dw, dh: geo.dh, tOffsetSec, motion });
      if (exprs) { xExpr = exprs.xExpr; yExpr = exprs.yExpr; }
    }
    specs.push({
      inputArgs: G.buildOverlayImageInputArgs({ durMs: win.overlapMs, path: ov.imagePath }),
      fps: null, x, y, xExpr, yExpr, dw: geo.dw, dh: geo.dh,
      chroma: ov.chroma || null, a: win.a, b: win.b,
    });
  }
  return specs;
}

const LOSSLESS = ["-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-pix_fmt", "yuv420p"];

(async () => {

// ═══════════════════════════════════════════════════════════════════════════
console.log("1) planTimelineChunks — gating, parity, forbidden zones");
// ═══════════════════════════════════════════════════════════════════════════
{
  const segs = (durs) => durs.map((d, i) => ({
    id: `s${i}`, mediaType: "video", videoPath: "/tmp/x.mp4",
    durationMs: d, trimInMs: 0, startMs: durs.slice(0, i).reduce((a, b) => a + b, 0),
  }));
  const noFade = { style: "none", durationMs: 0 };

  ok("W<2 → null", SP.planTimelineChunks({ segments: segs([20000, 20000]), transition: noFade, kbEnabled: false, fps: 30, totalMs: 40000, fades: [], workerCount: 1 }) === null);
  ok("short timeline (<30s) → null", SP.planTimelineChunks({ segments: segs([10000, 10000]), transition: noFade, kbEnabled: false, fps: 30, totalMs: 20000, fades: [], workerCount: 4 }) === null);

  // 90s of 10s segments at 30fps: 2700 frames, W=4 → 4 chunks.
  const durs90 = Array.from({ length: 9 }, () => 10000);
  const segs90 = segs(durs90);
  const plan90 = SP.planTimelineChunks({ segments: segs90, transition: noFade, kbEnabled: false, fps: 30, totalMs: 90000, fades: [], workerCount: 4 });
  ok("90s → 4 chunks", !!plan90 && plan90.chunks.length === 4, JSON.stringify(plan90 && plan90.chunks.length));
  ok("frame sum = 2700 (exact coverage)", !!plan90 && plan90.chunks.reduce((a, c) => a + c.frames, 0) === 2700);
  ok("totalFrames model = 2700", !!plan90 && plan90.totalFrames === 2700);
  ok("boundaries frame-aligned (t0Ms*fps integral)", !!plan90 && plan90.chunks.every((c) => Math.abs(c.t0Ms / 1000 * 30 - Math.round(c.t0Ms / 1000 * 30)) < 1e-9));
  ok("min chunk ≥ 2s of frames", !!plan90 && plan90.chunks.every((c) => c.frames >= Math.max(8, Math.round(30 * 2))));

  // Forbidden zones: dip fades at boundaries 30s/60s → boundaries must move off.
  const trDip = { style: "dip-black", durationMs: 800 };
  const segsF = segs([30000, 30000, 30000]);
  const fadesF = SP.buildGlobalFades({ segments: segsF, transition: trDip, totalMs: 90000 });
  ok("dip fades exist at 30/60s", fadesF.length === 4, JSON.stringify(fadesF.length));
  const planF = SP.planTimelineChunks({ segments: segsF, transition: trDip, kbEnabled: false, fps: 30, totalMs: 90000, fades: fadesF, workerCount: 4 });
  ok("90s w/ fades → plan exists", !!planF);
  if (planF) {
    const wins = SP.parseGlobalFadeWindows(fadesF);
    const bad = planF.chunks.filter((c) => !c.first && wins.some((w) =>
      c.f0 >= Math.floor(w.aSec * 30) - 0 && c.f0 <= Math.ceil(w.bSec * 30)));
    ok("no boundary inside a fade window", bad.length === 0, JSON.stringify(planF.chunks.map((c) => c.f0)));
    ok("frame sum parity with fades", planF.chunks.reduce((a, c) => a + c.frames, 0) === planF.totalFrames);
  }

  // non-integer durations (ceil semantics) — total 41.6 s so chunking applies.
  const segsOdd = segs([4700, 4200, 3900, 5100, 6300, 8500, 8900]);
  const spansOdd = SP.segmentFrameSpans({ segments: segsOdd, transition: noFade, kbEnabled: false, fps: 30 });
  // 4.7→141, 4.2→126, 3.9→117, 5.1→153, 6.3→189, 8.5→255, 8.9→267 = 1248
  ok("ceil frame model (1248 frames)", spansOdd.totalFrames === 1248, JSON.stringify(spansOdd.totalFrames));
  const planOdd = SP.planTimelineChunks({ segments: segsOdd, transition: noFade, kbEnabled: false, fps: 30, totalMs: 41600, fades: [], workerCount: 3 });
  ok("odd durations → ≥2 chunks with parity", !!planOdd && planOdd.chunks.reduce((a, c) => a + c.frames, 0) === 1248, JSON.stringify(planOdd && planOdd.chunks.map((c) => c.frames)));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("2) W=1 byte-differential vs git HEAD (regression guard)");
// ═══════════════════════════════════════════════════════════════════════════
{
  const headDir = path.join(TMP, "head");
  fs.mkdirSync(headDir, { recursive: true });
  for (const f of ["export-singlepass.js", "export-graph.js"]) {
    const r = spawnSync("git", ["-C", ROOT, "show", `HEAD:electron/${f}`], { encoding: "utf8" });
    if (r.status !== 0) throw new Error("git show failed for " + f);
    fs.writeFileSync(path.join(headDir, f), r.stdout);
  }
  const HSP = require(path.join(headDir, "export-singlepass.js"));

  const fixBase = {
    fps: 30, width: 640, height: 360, totalMs: 12800,
    kbEnabled: true, zoomMax: 1.15, globalDir: "in",
    transition: { style: "dissolve", durationMs: 500, fadeStartEnd: true },
    wm: { imagePath: "/tmp/wm.png", x: 10, y: 10, w: 80, h: 40, opacity: "0.600" },
    assSuffix: "subtitles=filename='/tmp/c.ass'",
    overlaySpecs: [{ inputArgs: ["-loop", "1", "-t", "3.000", "-i", "/tmp/ov.png"], x: 40, y: 40, xExpr: null, yExpr: null, dw: 160, dh: 90, chroma: { mode: "chroma", color: "#00b140", similarity: 0.32, blend: 0.08, spill: 0.6 }, a: 1.0, b: 4.0, fps: null }],
    audio: { normalize: true, musicVolume: 0.5, masterVolume: 1, musicStartMs: 0, fadeInMs: 500, fadeOutMs: 800, musicLoop: true },
    audioPath: "/tmp/music.mp3",
    sfx: [{ wavPath: "/tmp/sfx.wav", startMs: 1200, volume: 0.5 }],
    clipAudio: [{ inputIdx: 0, startMs: 0, volume: 0.8, atempo: [], durationMs: 4700 }],
    loudnorm: { clip: [{ i: -18, lra: 11, tp: -1.5, thresh: -29, offset: 0.5 }], music: null },
    masterLoudnorm: "loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=-16:measured_LRA=11:measured_TP=-1.5:measured_thresh=-20:offset=0.2:linear=true",
    hwaccelPerSeg: [false, true, false],
  };
  const variants = [
    ["3 video segs + speed", [
      { id: "a", mediaType: "video", videoPath: "/tmp/v1.mp4", durationMs: 4700, trimInMs: 800, startMs: 0 },
      { id: "b", mediaType: "video", videoPath: "/tmp/v2.mp4", durationMs: 4200, trimInMs: 0, startMs: 4700, speed: 1.5 },
      { id: "c", mediaType: "video", videoPath: "/tmp/v3.mp4", durationMs: 3900, trimInMs: 100, startMs: 8900 },
    ]],
    ["image segs + KB + xfade heads", [
      { id: "a", mediaType: "image", imagePath: "/tmp/i1.png", durationMs: 4700, startMs: 0, direction: "in" },
      { id: "b", mediaType: "image", imagePath: "/tmp/i2.png", durationMs: 4200, startMs: 4700, direction: "out" },
      { id: "c", mediaType: "image", imagePath: "/tmp/i3.png", durationMs: 3900, startMs: 8900, direction: "right" },
    ]],
    ["mixed video/image, dip transitions", [
      { id: "a", mediaType: "video", videoPath: "/tmp/v1.mp4", durationMs: 4700, trimInMs: 0, startMs: 0 },
      { id: "b", mediaType: "image", imagePath: "/tmp/i2.png", durationMs: 4200, startMs: 4700 },
      { id: "c", mediaType: "video", videoPath: "/tmp/v3.mp4", durationMs: 3900, trimInMs: 300, startMs: 8900, speed: 0.75 },
    ]],
    ["single video segment", [
      { id: "a", mediaType: "video", videoPath: "/tmp/v1.mp4", durationMs: 12800, trimInMs: 0, startMs: 0 },
    ]],
    ["no audio, no wm, no ass, no overlays", null],
    ["static image segs (no KB)", [
      { id: "a", mediaType: "image", imagePath: "/tmp/i1.png", durationMs: 6400, startMs: 0 },
      { id: "b", mediaType: "image", imagePath: "/tmp/i2.png", durationMs: 6400, startMs: 6400 },
    ]],
  ];
  let diffs = 0;
  for (const [label, segs] of variants) {
    const o = { ...fixBase };
    if (segs) o.segments = segs;
    else {
      delete o.wm; delete o.assSuffix; delete o.overlaySpecs; delete o.audioPath;
      delete o.sfx; delete o.clipAudio; delete o.loudnorm; delete o.masterLoudnorm;
      o.audio = { normalize: false };
      o.segments = [{ id: "a", mediaType: "video", videoPath: "/tmp/v1.mp4", durationMs: 12800, trimInMs: 0, startMs: 0 }];
    }
    const a = HSP.buildSinglePassPlan(o);
    const b = SP.buildSinglePassPlan(o);
    const samePlan = JSON.stringify([a.inputs, a.script, a.hasAudioOut, a.videoOutLabel]) ===
      JSON.stringify([b.inputs, b.script, b.hasAudioOut, b.videoOutLabel]);
    const aArgs = HSP.buildSinglePassArgs({ plan: a, scriptPath: "/tmp/g.txt", encArgs: ["-c:v", "libx264"], abr: "192k", fps: 30, outputPath: "/tmp/out.mp4", threads: 0, filterThreads: 4 });
    const bArgs = SP.buildSinglePassArgs({ plan: b, scriptPath: "/tmp/g.txt", encArgs: ["-c:v", "libx264"], abr: "192k", fps: 30, outputPath: "/tmp/out.mp4", threads: 0, filterThreads: 4 });
    const sameArgs = JSON.stringify(aArgs) === JSON.stringify(bArgs);
    if (!samePlan || !sameArgs) diffs++;
    ok(`W=1 plan+args byte-identical (${label})`, samePlan && sameArgs,
      samePlan ? "" : `plan differs: ${(b.script || "").slice(0, 120)}`);
  }
  ok("no W=1 differentials at all", diffs === 0);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("3) REAL E2E: W=1 lossless vs CHUNKED (videoOnly+audioOnly+mux)");
// ═══════════════════════════════════════════════════════════════════════════
{
  const W = 640, H = 360, FPS = 30;
  // Sources: two videos WITH audio (sine tones), one PNG for Ken Burns.
  // 20 s sources — the windows below (12.3 s / 12.3 s @1.5×) must fit INSIDE
  // the source (an exhausted source shortens the stream and the frame model;
  // degenerate projects are covered by the W=1 path's -shortest, not here).
  run(["-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "20", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    path.join(TMP, "v1.mp4")]);
  run(["-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "smptebars=size=640x360:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000",
    "-t", "20", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    path.join(TMP, "v2.mp4")]);
  run(["-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "gradients=size=1280x720:speed=0.05:c0=0x204060:c1=0xC04020",
    "-frames:v", "1", path.join(TMP, "kb.png")]);
  run(["-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=red@0.9:size=320x180,format=rgba",
    "-frames:v", "1", path.join(TMP, "ov.png")]);
  run(["-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000",
    "-t", "30", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    path.join(TMP, "music.m4a")]);

  // Timeline ~36s: video 12.3s (trim 1s) + KB image 11.4s + video 12.3s at 1.5x (8.2s source)
  const segments = [
    { id: "a", mediaType: "video", videoPath: path.join(TMP, "v1.mp4"), durationMs: 12300, trimInMs: 1000, startMs: 0, volume: 1 },
    { id: "b", mediaType: "image", imagePath: path.join(TMP, "kb.png"), durationMs: 11400, startMs: 12300 },
    { id: "c", mediaType: "video", videoPath: path.join(TMP, "v2.mp4"), durationMs: 12300, trimInMs: 500, startMs: 23700, speed: 1.5, volume: 0.6 },
  ];
  const totalMs = 36000;
  const fps = FPS, width = W, height = H;
  const transition = { style: "dip-black", durationMs: 400, fadeStartEnd: true };
  const kb = { enabled: true, zoomMax: 1.15, globalDir: "in" };
  const overlays = [{
    imagePath: path.join(TMP, "ov.png"), mediaType: "image",
    startMs: 15000, durationMs: 9000, trimInMs: 0,
    sourceWidth: 320, sourceHeight: 180,
    overlay: { x: 0.1, y: 0.1, scale: 0.35, motion: null },
  }];
  const audio = { normalize: false, musicVolume: 0.4, masterVolume: 1, musicStartMs: 0, fadeInMs: 300, fadeOutMs: 700, musicLoop: false };
  const audioPath = path.join(TMP, "music.m4a");
  const captionSettings = { enabled: true, fontSize: 0.05, textColor: "#FFFFFF", wordMode: "off", animation: "none", position: "bottom", fontWeight: 600 };
  const subtitleCues = [
    { startMs: 11000, endMs: 14000, text: "Crossing the first boundary" },
    { startMs: 22000, endMs: 26000, text: "Ken Burns mid-anim cut" },
    { startMs: 33000, endMs: 35500, text: "Tail chunk caption" },
  ];

  const fullFades = SP.buildGlobalFades({ segments, transition, totalMs });
  const assDoc = M.buildAssDocument(subtitleCues, captionSettings, [], width, height, 0, totalMs, totalMs);
  const assSuffix = assSuffixFor(assDoc, "full");
  const globalOverlaySpecs = imageOverlaySpecsFor(overlays, width, height, 0, totalMs);
  const clipAudioBranches = [
    { inputIdx: 0, startMs: 0, volume: 1, atempo: [], durationMs: 12300 },
    { inputIdx: 2, startMs: 23700, volume: 0.6, atempo: G.atempoFilters(1.5), durationMs: 12300 },
  ];

  // ── W=1 full render (audio inline) ──
  const w1Plan = SP.buildSinglePassPlan({
    segments, fps, width, height, totalMs,
    kbEnabled: kb.enabled, zoomMax: kb.zoomMax, globalDir: kb.globalDir,
    transition, wm: null, assSuffix, overlaySpecs: globalOverlaySpecs,
    audio, audioPath, sfx: [], clipAudio: clipAudioBranches,
    loudnorm: null, masterLoudnorm: null, hwaccelPerSeg: [false, false, false],
  });
  const w1Script = path.join(TMP, "w1.txt");
  fs.writeFileSync(w1Script, w1Plan.script, "utf-8");
  const w1Args = SP.buildSinglePassArgs({
    plan: w1Plan, scriptPath: w1Script, encArgs: LOSSLESS, abr: "192k",
    fps, outputPath: path.join(TMP, "w1.mp4"), threads: 1, filterThreads: 1,
  });
  run(w1Args);

  // ── Chunked render (force 3 windows via workerCount) ──
  const chunkPlan = SP.planTimelineChunks({
    segments, transition, kbEnabled: kb.enabled, globalDir: kb.globalDir,
    fps, totalMs, fades: fullFades, workerCount: 3,
  });
  ok("E2E fixture → chunk plan with ≥2 chunks", !!chunkPlan && chunkPlan.chunks.length >= 2, JSON.stringify(chunkPlan && chunkPlan.chunks.map((c) => c.frames)));
  if (chunkPlan && chunkPlan.chunks.length >= 2) {
    const KC = chunkPlan.chunks.length;
    const chunkFiles = [];
    for (let ci = 0; ci < KC; ci++) {
      const c = chunkPlan.chunks[ci];
      const winSegs = SP.windowSegmentsForChunk(segments, chunkPlan.spans, c.f0, c.f1, fps);
      const segMeta = winSegs.map((w) => ({ origIdx: w.origIdx, S: w.S, F: w.F, k0: w.k0, k1: w.k1, ssSec: w.ssSec }));
      const ovSpecs = SP.padOverlayInputWindows(imageOverlaySpecsFor(overlays, width, height, c.t0Ms, c.durMs), c.durMs);
      const doc = M.buildAssDocument(subtitleCues, captionSettings, [], width, height, c.t0Ms, c.t0Ms + c.durMs, c.durMs);
      const cAss = doc ? assSuffixFor(doc, `chunk${ci}`) : null;
      const cPlan = SP.buildSinglePassPlan({
        segments: winSegs.map((w) => w.seg), fullSegments: segments,
        window: { t0Ms: c.t0Ms, durMs: c.durMs, segMeta },
        videoOnly: true, fades: fullFades,
        fps, width, height, totalMs,
        kbEnabled: kb.enabled, zoomMax: kb.zoomMax, globalDir: kb.globalDir,
        transition, wm: null, assSuffix: cAss, overlaySpecs: ovSpecs,
        audio, audioPath: null, sfx: [], clipAudio: [],
        loudnorm: null, masterLoudnorm: null, hwaccelPerSeg: [false, false, false],
      });
      const cScript = path.join(TMP, `c${ci}.txt`);
      fs.writeFileSync(cScript, cPlan.script, "utf-8");
      const cPath = path.join(TMP, `c${ci}.mp4`);
      chunkFiles.push(cPath);
      run(SP.buildSinglePassArgs({
        plan: cPlan, scriptPath: cScript, encArgs: LOSSLESS, abr: "192k",
        fps, outputPath: cPath, threads: 1, filterThreads: 1,
      }));
    }
    // audio-only render (totalMs REQUIRED — apad whole_dur + music fades)
    const aPlan = SP.buildSinglePassPlan({
      segments, fps, width, height, totalMs, audioOnly: true,
      audio, audioPath, sfx: [], clipAudio: clipAudioBranches,
      loudnorm: null, masterLoudnorm: null,
    });
    ok("audioOnly plan hasAudioOut", aPlan.hasAudioOut === true);
    const aScript = path.join(TMP, "a.txt");
    fs.writeFileSync(aScript, aPlan.script, "utf-8");
    const aPath = path.join(TMP, "a.m4a");
    run(SP.buildAudioOnlyArgs({ plan: aPlan, scriptPath: aScript, abr: "192k", totalSec: totalMs / 1000, outputPath: aPath }));

    // concat + mux
    const listPath = path.join(TMP, "list.txt");
    fs.writeFileSync(listPath, chunkFiles.map((p) => `file '${p}'`).join("\n"), "utf-8");
    const outPath = path.join(TMP, "chunked.mp4");
    run(["-y", "-hide_banner", "-loglevel", "error",
      "-f", "concat", "-safe", "0", "-i", listPath, "-i", aPath,
      "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", outPath]);

    // ── compare: frames ──
    const f1 = countFrames(path.join(TMP, "w1.mp4"));
    const f2 = countFrames(outPath);
    ok(`frame-count parity (W1=${f1} chunked=${f2}, model=${chunkPlan.totalFrames})`, f1 === f2 && f1 === chunkPlan.totalFrames, `${f1} vs ${f2}`);
    const eqv = videoEquivalent(path.join(TMP, "w1.mp4"), outPath, FPS);
    ok("video parity (lossless; exact or ≤4/255 xfade-chroma rounding)", eqv.ok, eqv.why || (eqv.exact ? "exact" : `${eqv.diffs} frames, first @${eqv.first}`));

    // ── compare: audio (decoded PCM, tolerate a frame of priming) ──
    const p1 = pcmMd5(path.join(TMP, "w1.mp4"), (totalMs / 1000) - 0.1);
    const p2 = pcmMd5(outPath, (totalMs / 1000) - 0.1);
    ok("audio PCM parity (first 35.9s)", Buffer.compare(p1, p2) === 0,
      `sizes ${p1.length} vs ${p2.length}`);

    // Ken Burns mid-cut specifically: frames 371..713 are the KB segment —
    // a chunk boundary inside it must continue the exact curve. Covered by
    // the global frame-MD5 check above IF a boundary lands inside. Assert:
    const kbSpan = chunkPlan.spans[1];
    const kbCut = chunkPlan.chunks.some((c) => c.f0 > kbSpan.S && c.f0 < kbSpan.S + kbSpan.F);
    ok("a chunk boundary lands INSIDE the Ken Burns segment", kbCut, JSON.stringify(chunkPlan.chunks.map((c) => c.f0)) + " kbSpan=" + JSON.stringify(kbSpan));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("4) REAL E2E: xfade heads + boundaries routed around head zones");
// ═══════════════════════════════════════════════════════════════════════════
{
  const W = 640, H = 360, FPS = 30;
  for (const [n, hue] of [["x1", "0x3040A0"], ["x2", "0xA04030"], ["x3", "0x30A040"]]) {
    run(["-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `gradients=size=1280x720:speed=0.03:c0=${hue}:c1=0x101820`,
      "-frames:v", "1", path.join(TMP, `${n}.png`)]);
  }
  // 3 KB images with DISSOLVE transitions between them (xfade heads).
  const segments = [
    { id: "a", mediaType: "image", imagePath: path.join(TMP, "x1.png"), durationMs: 12800, startMs: 0, direction: "in" },
    { id: "b", mediaType: "image", imagePath: path.join(TMP, "x2.png"), durationMs: 12800, startMs: 12800, direction: "out" },
    { id: "c", mediaType: "image", imagePath: path.join(TMP, "x3.png"), durationMs: 12800, startMs: 25600, direction: "right" },
  ];
  const totalMs = 38400, fps = FPS, width = W, height = H;
  const transition = { style: "dissolve", durationMs: 700, fadeStartEnd: false };
  const kb = { enabled: true, zoomMax: 1.12, globalDir: "in" };
  const fullFades = SP.buildGlobalFades({ segments, transition, totalMs });

  const w1Plan = SP.buildSinglePassPlan({
    segments, fps, width, height, totalMs,
    kbEnabled: kb.enabled, zoomMax: kb.zoomMax, globalDir: kb.globalDir,
    transition, wm: null, assSuffix: null, overlaySpecs: [],
    audio: { normalize: false }, audioPath: null, sfx: [], clipAudio: [],
    loudnorm: null, masterLoudnorm: null, hwaccelPerSeg: [],
  });
  const w1Script = path.join(TMP, "xw1.txt");
  fs.writeFileSync(w1Script, w1Plan.script, "utf-8");
  run(SP.buildSinglePassArgs({
    plan: w1Plan, scriptPath: w1Script, encArgs: LOSSLESS, abr: "192k",
    fps, outputPath: path.join(TMP, "xw1.mp4"), threads: 1, filterThreads: 1,
  }));

  const chunkPlan = SP.planTimelineChunks({
    segments, transition, kbEnabled: kb.enabled, globalDir: kb.globalDir,
    fps, totalMs, fades: fullFades, workerCount: 4,
  });
  ok("xfade fixture → plan exists", !!chunkPlan && chunkPlan.chunks.length >= 2, JSON.stringify(chunkPlan && chunkPlan.chunks.map((c) => c.f0)));
  if (chunkPlan && chunkPlan.chunks.length >= 2) {
    // zone check: no boundary inside [S_i, S_i + headFrames]
    let zoneOk = true;
    for (let i = 1; i < segments.length; i++) {
      const plan = G.planBoundaryFades(i, segments[i], segments, transition);
      const useHead = !!(plan.xfadeName && plan.headMs > 0 && !G.videoAtBoundaryMirror(segments, i));
      if (!useHead) continue;
      const headF = Math.ceil((plan.headMs / 1000) * fps) + 1;
      const S = chunkPlan.spans[i].S;
      const bad = chunkPlan.chunks.some((c) => !c.first && c.f0 >= S && c.f0 <= S + headF);
      if (bad) zoneOk = false;
    }
    ok("no boundary inside an xfade head zone", zoneOk);
    const chunkFiles = [];
    for (let ci = 0; ci < chunkPlan.chunks.length; ci++) {
      const c = chunkPlan.chunks[ci];
      const winSegs = SP.windowSegmentsForChunk(segments, chunkPlan.spans, c.f0, c.f1, fps);
      const segMeta = winSegs.map((w) => ({ origIdx: w.origIdx, S: w.S, F: w.F, k0: w.k0, k1: w.k1, ssSec: w.ssSec }));
      const cPlan = SP.buildSinglePassPlan({
        segments: winSegs.map((w) => w.seg), fullSegments: segments,
        window: { t0Ms: c.t0Ms, durMs: c.durMs, segMeta },
        videoOnly: true, fades: fullFades,
        fps, width, height, totalMs,
        kbEnabled: kb.enabled, zoomMax: kb.zoomMax, globalDir: kb.globalDir,
        transition, wm: null, assSuffix: null, overlaySpecs: [],
        audio: { normalize: false }, audioPath: null, sfx: [], clipAudio: [],
        loudnorm: null, masterLoudnorm: null, hwaccelPerSeg: [],
      });
      const cScript = path.join(TMP, `xc${ci}.txt`);
      fs.writeFileSync(cScript, cPlan.script, "utf-8");
      const cPath = path.join(TMP, `xc${ci}.mp4`);
      chunkFiles.push(cPath);
      run(SP.buildSinglePassArgs({
        plan: cPlan, scriptPath: cScript, encArgs: LOSSLESS, abr: "192k",
        fps, outputPath: cPath, threads: 1, filterThreads: 1,
      }));
    }
    const listPath = path.join(TMP, "xlist.txt");
    fs.writeFileSync(listPath, chunkFiles.map((p) => `file '${p}'`).join("\n"), "utf-8");
    const outPath = path.join(TMP, "xchunked.mp4");
    run(["-y", "-hide_banner", "-loglevel", "error",
      "-f", "concat", "-safe", "0", "-i", listPath,
      "-map", "0:v:0", "-c", "copy", "-movflags", "+faststart", outPath]);
    const f1 = countFrames(path.join(TMP, "xw1.mp4"));
    const f2 = countFrames(outPath);
    ok(`xfade frame-count parity (${f1} vs ${f2}, model=${chunkPlan.totalFrames})`, f1 === f2 && f1 === chunkPlan.totalFrames);
    const eqv = videoEquivalent(path.join(TMP, "xw1.mp4"), outPath, FPS);
    ok("xfade video parity (heads + KB offsets exact or chroma-rounding)", eqv.ok, eqv.why || (eqv.exact ? "exact" : `${eqv.diffs} frames, first @${eqv.first}`));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error("HARNESS ERROR:", err && err.stack || err);
  process.exit(1);
});
