#!/usr/bin/env node
/**
 * scripts/verify-overlay-caption-order.js — v1.14.3 bug hunt: "the overlap
 * (overlay/PiP clip) renders ON TOP of the burned-in captions in video
 * exports; captions must be the topmost layer."
 *
 * Drives the REAL ipcMain "export-native" handler (bench-disclaimer.js
 * harness pattern) with a VIDEO base + a full-frame solid-magenta overlay
 * (image in T1, video in T2) + white-bottom captions. If captions are
 * burned ABOVE the overlay, the exported frame at t=3s shows white text
 * pixels over the magenta; if the overlay wins, the frame is pure magenta.
 *
 * T0 control: same timeline without the overlay (captions must be visible
 * over the plain video — proves the caption pipeline itself works).
 *
 * Run: node scripts/verify-overlay-caption-order.js
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FF = "/usr/bin/ffmpeg";
const FFPROBE = "/usr/bin/ffprobe";
const TMP = "/tmp/ffzorder";
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// ── electron stub (bench-export.js pattern) ─────────────────────────
const handlers = {};
const electronStub = {
  app: {
    whenReady: () => Promise.resolve(),
    on: () => {},
    getPath: (k) => path.join(TMP, "userData"),
    getName: () => "FrameFuse",
    getVersion: () => "1.14.2",
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

// ── fixtures ──────────────────────────────────────────────────────────
console.log("── generating fixtures ──");
const W = 640, H = 360, FPS = 30, DUR = 6;
function run(bin, args, timeout = 120000) {
  const r = spawnSync(bin, args, { timeout });
  if (r.status !== 0) throw new Error(`${bin} failed: ${r.stderr && r.stderr.toString().slice(0, 300)}`);
}
// base video: testsrc2 + audio, gop 48 (1.6s — smart-render copyable)
run(FF, ["-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", `testsrc2=s=${W}x${H}:r=${FPS}`,
  "-f", "lavfi", "-i", "sine=frequency=440:r=48000",
  "-t", String(DUR), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
  "-g", "48", "-keyint_min", "48", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "128k", `${TMP}/base.mp4`]);
// overlay image: solid magenta full resolution
run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
  "-i", `color=c=0xFF00FF:s=${W}x${H}:r=${FPS}`, "-frames:v", "1", `${TMP}/ovimg.png`]);
// overlay video: solid magenta, 6s, no audio
run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
  "-i", `color=c=0xFF00FF:s=${W}x${H}:r=${FPS}`, "-t", String(DUR),
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
  "-g", "48", "-keyint_min", "48", "-pix_fmt", "yuv420p", `${TMP}/ovvid.mp4`]);
for (let k = 0; k < 6; k++) run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
  "-i", `testsrc2=s=${W}x${H}:r=${FPS}`, "-frames:v", "1", `${TMP}/i${k}.png`]);
// music bed (keeps the payload close to a real project)
run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
  "-i", "sine=frequency=220:r=48000:d=30,volume=0.3", "-c:a", "pcm_s16le", `${TMP}/music.wav`]);

const cueList = [{
  startMs: 500, endMs: 5500,
  text: "CAPTIONS ON TOP TEST",
  words: [
    { text: "CAPTIONS", startMs: 500, endMs: 3000 },
    { text: "ON", startMs: 3000, endMs: 4000 },
    { text: "TOP", startMs: 4000, endMs: 5500 },
  ],
}];
const captionSettings = {
  enabled: true, presetId: "clean", fontSizeScale: 1, wordMode: "off", animation: "none",
  customColor: null, customPosition: null, fontId: "arial", fontWeight: 600,
};

function overlaySegment(mediaType, filePath, track) {
  return {
    id: `ov_${mediaType}_${track}`,
    fileName: path.basename(filePath),
    kind: "duration",
    mediaType,
    [mediaType === "video" ? "videoPath" : "imagePath"]: filePath,
    sourceWidth: W, sourceHeight: H,
    startMs: 0, endMs: DUR * 1000, durationMs: DUR * 1000,
    track, volume: 1, trimInMs: 0, speed: 1,
    sourceDurationMs: mediaType === "video" ? DUR * 1000 : null,
    overlay: { scalePercent: 100, position: "center", x: 0.5, y: 0.5 },
    chroma: null, overlayLoop: false,
  };
}

const IMG_SEGS = Array.from({ length: 6 }, (_, k) => ({
  id: "img" + k, fileName: "i" + k + ".png", mediaType: "image",
  imagePath: `${TMP}/i${k}.png`,
  startMs: k * 4000, endMs: k * 4000 + 4000, durationMs: 4000,
  track: 0, volume: 1, trimInMs: 0, speed: 1, sourceDurationMs: null,
  direction: k % 2 ? "out" : "in",
}));
const BASE_SEG = {
  id: "base0", fileName: "base.mp4", mediaType: "video",
  videoPath: `${TMP}/base.mp4`,
  startMs: 0, endMs: DUR * 1000, durationMs: DUR * 1000,
  track: 0, volume: 1, trimInMs: 0, speed: 1, sourceDurationMs: DUR * 1000,
  direction: "in",
};

/** 6 image clips × 4s — the classic storyboard; filter-dominant → parallel-pass. */
function imageSegments() {
  return Array.from({ length: 6 }, (_, k) => ({
    id: `img${k}`, fileName: `i${k}.png`, mediaType: "image",
    imagePath: `${TMP}/i${k}.png`,
    startMs: k * 4000, endMs: k * 4000 + 4000, durationMs: 4000,
    track: 0, volume: 1, trimInMs: 0, speed: 1, sourceDurationMs: null,
    direction: k % 2 ? "out" : "in",
  }));
}

async function runExport(handler, overlays, outPath, o = {}) {
  const fakeEvent = {
    sender: { isDestroyed: () => false, send: () => {} },
  };
  const segments = o.segments || [BASE_SEG];
  const totalMs = segments.reduce((a, s) => a + s.durationMs, 0);
  const opts = {
    outputPath: outPath,
    fps: FPS, width: W, height: H,
    bitrateMbps: 8, quality: "social", crf: 20, audioKbps: 192,
    kenBurns: { enabled: !!(o.kenBurns), intensity: 50, direction: "in" },
    segments,
    audioPath: `${TMP}/music.wav`,
    audio: { normalize: false, masterVolume: 1, fadeInMs: 300, fadeOutMs: 500, musicVolume: 0.8, musicStartMs: 0, musicLoop: true },
    captionSettings,
    subtitleCues: (o.cues || cueList).map((c) => ({
      ...c,
      endMs: Math.min(c.endMs, totalMs - 100),
    })),
    headlines: [],
    transition: o.transition ?? null,
    watermark: null,
    overlays,
    sfx: [],
  };
  const t0 = Date.now();
  const result = await handler(fakeEvent, opts);
  return { ms: Date.now() - t0, result };
}

/** Extract the raw rgb24 frame at t and count pixel classes. */
function analyzeFrame(videoPath, tSec) {
  const out = `${TMP}/frame.raw`;
  fs.rmSync(out, { force: true });
  const r = spawnSync(FF, ["-y", "-hide_banner", "-loglevel", "error", "-ss", String(tSec),
    "-i", videoPath, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", out]);
  if (r.status !== 0 || !fs.existsSync(out)) throw new Error("frame extract failed");
  const buf = fs.readFileSync(out);
  let magenta = 0, white = 0, black = 0, total = 0;
  for (let p = 0; p + 2 < buf.length; p += 3) {
    const rr = buf[p], gg = buf[p + 1], bb = buf[p + 2];
    total++;
    if (rr > 180 && gg < 80 && bb > 180) magenta++;
    else if (rr > 225 && gg > 225 && bb > 225) white++;
    else if (rr < 35 && gg < 35 && bb < 35) black++;
  }
  return { total, magenta, white, black };
}

(async () => {
  require(path.join(ROOT, "electron", "main.js"));
  const exportHandler = handlers["export-native"];
  if (!exportHandler) throw new Error("export-native handler not registered");

  const imgOv = overlaySegment("image", `${TMP}/ovimg.png`, 1);
  const imgOv24 = { ...imgOv, id: "ov_img_24", startMs: 2400, endMs: 14400, durationMs: 12000 };
  const vidOv = overlaySegment("video", `${TMP}/ovvid.mp4`, 1);
  const vidOv24 = { ...vidOv, id: "ov_vid_24", startMs: 2400, endMs: 14400, durationMs: 12000, overlayLoop: true };
  const imgCues = Array.from({ length: 6 }, (_, k) => ({
    startMs: k * 4000 + 500, endMs: k * 4000 + 3500,
    text: "CAPTIONS ON TOP TEST",
    words: [],
  }));
  const results = [];
  const cases = [
    { id: "T0", name: "control — captions, NO overlay (video base)", overlays: [] },
    { id: "T1", name: "video base + IMAGE overlay (full-frame magenta) + captions", overlays: [imgOv] },
    { id: "T2", name: "video base + VIDEO overlay (full-frame magenta) + captions", overlays: [vidOv] },
    { id: "T3", name: "IMAGE base (6 imgs) + IMAGE overlay + captions — parallel-pass", overlays: [imgOv24], opts: { segments: imageSegments(), cues: imgCues } },
    { id: "T4", name: "IMAGE base (6 imgs) + VIDEO overlay + captions — parallel-pass", overlays: [vidOv24], opts: { segments: imageSegments(), cues: imgCues } },
    { id: "T5", name: "IMAGE base + IMAGE overlay + Ken Burns + captions — parallel-pass", overlays: [imgOv24], opts: { segments: imageSegments(), cues: imgCues, kenBurns: true } },
    { id: "T6", name: "2 images + DISSOLVE 600ms + boundary-spanning cue", overlays: [], opts: { segments: [
      { ...imageSegments()[0], id: "txa", imagePath: `${TMP}/i0.png`, startMs: 0, endMs: 4000, durationMs: 4000 },
      { ...imageSegments()[1], id: "txb", imagePath: `${TMP}/i1.png`, startMs: 4000, endMs: 8000, durationMs: 4000 },
    ], cues: [{ startMs: 3500, endMs: 5200, text: "BOUNDARY CAPTION TEST", words: [] }], transition: { style: "dissolve", durationMs: 600, fadeStartEnd: true } }, tSec: 4.25 },
    { id: "T7", name: "USER SHAPE: 6 images + VIDEO overlay + KB + dissolve + captions", overlays: [vidOv24], opts: { segments: imageSegments(), cues: imgCues, kenBurns: true, transition: { style: "dissolve", durationMs: 300, fadeStartEnd: true } } },
    { id: "T8", name: "2 VIDEOS + DIP-to-black 800ms + boundary-spanning cue (THE v1.14.3 case)", overlays: [], opts: { segments: [
      { ...BASE_SEG, id: "dva", videoPath: `${TMP}/base.mp4`, startMs: 0, endMs: 6000, durationMs: 6000 },
      { ...BASE_SEG, id: "dvb", videoPath: `${TMP}/base.mp4`, startMs: 6000, endMs: 12000, durationMs: 6000 },
    ], cues: [{ startMs: 5200, endMs: 7600, text: "DIP CAPTION TEST", words: [] }], transition: { style: "dip-black", durationMs: 800, fadeStartEnd: true } }, tSec: 6.4 },
  ];
  for (const c of cases) {
    const outPath = `${TMP}/${c.id}.mp4`;
    process.stdout.write(`── ${c.id}: ${c.name} … `);
    const run = await runExport(exportHandler, c.overlays, outPath, c.opts || {});
    const dur = parseFloat(spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", outPath], { encoding: "utf8" }).stdout || "0");
    const f = analyzeFrame(outPath, c.tSec ?? 3.0);
    const pct = (n) => ((n / f.total) * 100).toFixed(2) + "%";
    // verdict: captions visible ON the magenta = white pixels present
    const captionVisible = f.white > f.total * 0.0008; // ≥0.08% white pixels
    const verdict = c.id === "T0"
      ? (captionVisible ? "PASS" : "FAIL")
      : (captionVisible ? `PASS (captions ON TOP, magenta=${pct(f.magenta)})` : `FAIL (overlay covered captions, magenta=${pct(f.magenta)})`);
    console.log(`${(run.ms / 1000).toFixed(1)}s  mode=${run.result.mode || "two-step"}  out=${dur.toFixed(2)}s  magenta=${pct(f.magenta)}  white=${pct(f.white)}  black=${pct(f.black)}  → ${verdict}`);
    results.push({ id: c.id, verdict, f, mode: run.result.mode, dur });
  }

  console.log("");
  const fails = results.filter((r) => r.verdict.startsWith("FAIL"));
  console.log(`RESULT: ${results.length - fails.length}/${results.length} PASS${fails.length ? " — FAILURES: " + fails.map((f) => f.id).join(", ") : ""}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
// ── extended cases (appended by the v1.14.3 round) ──────────────────
