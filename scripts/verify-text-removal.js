#!/usr/bin/env node
/**
 * scripts/verify-text-removal.js — v1.15 burn-in text detection & removal.
 *
 * The user directive: "detect the text on the video and add a blur effect,
 * or use better tech like inpainting, to remove that text" — default OFF.
 *
 * Verifies the export integration end-to-end against real ffmpeg:
 *   U1 unit — single-pass INPAINT graph: delogo per region AHEAD of the
 *        cover-fit chain; no split/overlay pads.
 *   U2 unit — single-pass BLUR graph: split → crop → boxblur → overlay per
 *        region, chaining into the segment's normal chain.
 *   U3 unit — REGRESSION GUARD: textRemoval OFF (or invalid) keeps the
 *        graph byte-identical to a pre-v1.15 build (no delogo/drawbox/split).
 *   E1 e2e — real export of a video with burned-in text (INPAINT): exact
 *        frame count; the text region's pixels are GONE (luma range collapses
 *        vs. the no-TR control).
 *   E2 e2e — BLUR mode: same shape check.
 *   E3 e2e — COVER mode: the region is solid black (avg luma ≈ 0).
 *   P1 e2e — two-step path (G.buildClipArgs) with TR: the complex graph
 *        branch is forced and the delogo runs ahead of the chain (exit 0).
 *
 * Run: node scripts/verify-text-removal.js
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FF = "/usr/bin/ffmpeg";
const FFPROBE = "/usr/bin/ffprobe";
const TMP = "/tmp/fftextremoval";
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// ── electron stub (verify-image-singledecode.js pattern) ──────────
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
  ipcMain: { handle: () => {}, on: () => {} },
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
  if (r.status !== 0) {
    throw new Error(`${bin} failed: ${r.stderr && r.stderr.toString().slice(0, 600)}`);
  }
  return r;
}
function frameCount(p) {
  return parseInt(spawnSync(FFPROBE, ["-v", "error", "-select_streams", "v", "-count_packets",
    "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", p], { encoding: "utf8" }).stdout || "0", 10);
}

const results = [];
function report(id, name, pass, detail) {
  console.log(`── ${id}: ${name} → ${pass ? "PASS" : "FAIL"}${detail ? `  (${detail})` : ""}`);
  results.push({ id, pass });
}

// ── fixture: 3 s of 1280×720@30 with BURNED-IN text (white on dark box) ──
const W = 1280, H = 720, FPS = 30, DUR_S = 3;
const SRC = `${TMP}/src_text.mp4`;
console.log("── generating fixture (burned-in text) ──");
run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
  "-i", `testsrc2=size=${W}x${H}:rate=${FPS}:duration=${DUR_S}`,
  "-vf", "drawtext=text='WATERMARK TEXT':fontsize=72:fontcolor=white:box=1:boxcolor=black@0.75:x=(w-text_w)/2:y=h-150:font=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-bf", "0", SRC]);

// The text occupies roughly x 22%..78%, y 78%..90% of the frame.
const REGIONS = [{ x: 0.2, y: 0.76, w: 0.6, h: 0.15 }];

/** Region-average luma of frame N via a gray crop dump. */
function regionLuma(p, frameN, crop) {
  const out = `${TMP}/px.bin`;
  run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-i", p,
    "-vf", `select=eq(n\\,${frameN}),crop=${crop},format=gray`,
    "-frames:v", "1", "-f", "rawvideo", out]);
  const b = fs.readFileSync(out);
  if (!b.length) return NaN;
  let sum = 0, mn = 255, mx = 0;
  for (const v of b) { sum += v; mn = Math.min(mn, v); mx = Math.max(mx, v); }
  return { avg: sum / b.length, mn, mx };
}

const SP = require(path.join(ROOT, "electron", "export-singlepass.js"));
const G = require(path.join(ROOT, "electron", "export-graph.js"));
const TR = require(path.join(ROOT, "electron", "textremoval.js"));

function vidSeg(durMs, startMs) {
  return {
    id: "v0", fileName: "src_text.mp4", mediaType: "video",
    videoPath: SRC,
    startMs: startMs, endMs: startMs + durMs, durationMs: durMs,
    track: 0, volume: 1, trimInMs: 0, speed: 1, sourceDurationMs: DUR_S * 1000,
  };
}

const FACTS = [{ srcW: W, srcH: H, srcFps: FPS, rFps: FPS, sar: 1, pixFmt: "yuv420p", rotated: false }];

function planFor(mode, enabled) {
  return SP.buildSinglePassPlan({
    segments: [vidSeg(DUR_S * 1000, 0)],
    fullSegments: [vidSeg(DUR_S * 1000, 0)],
    fps: FPS, width: W, height: H, totalMs: DUR_S * 1000,
    kbEnabled: false, zoomMax: 1.25, globalDir: "in",
    transition: null, wm: null, assSuffix: null, overlaySpecs: [],
    audio: {}, audioPath: null, sfx: [], clipAudio: [],
    loudnorm: null, masterLoudnorm: null,
    srcFacts: FACTS,
    textRemoval: { enabled: !!enabled, mode, regions: REGIONS },
  });
}

// ── U1: inpaint graph shape ───────────────────────────────────────────
{
  const p = planFor("inpaint", true);
  const delogoCount = (p.script.match(/delogo=x=/g) || []).length;
  const hasSplit = /split=2/.test(p.script);
  const ahead = /\[0:v\]delogo=x=256:y=547:w=768:h=108,setpts=PTS-STARTPTS\[s0\]/.test(p.script);
  report("U1", "inpaint: chained delogo AHEAD of the segment chain, no split pads",
    delogoCount === 1 && !hasSplit && ahead,
    `delogo=${delogoCount} split=${hasSplit}`);
}

// ── U2: blur graph shape ──────────────────────────────────────────────
{
  const p = planFor("blur", true);
  const shape = /\[0:v\]split=2\[tr0bg0\]\[tr0fg0\];\[tr0fg0\]crop=768:108:256:547,boxblur=luma_radius=\d+:luma_power=2:chroma_radius=\d+:chroma_power=2\[tr0fg0b\];\[tr0bg0\]\[tr0fg0b\]overlay=x=256:y=547\[tr0ov0\];\[tr0ov0\]setpts=PTS-STARTPTS\[s0\]/.test(p.script);
  report("U2", "blur: split→crop→boxblur→overlay graph chaining into the segment chain",
    shape, p.script.split("\n").slice(0, 2).join(" ⏎ ").slice(0, 120));
}

// ── U3: OFF keeps the graph byte-identical ────────────────────────────
{
  const off = planFor("inpaint", false);
  const legacy = SP.buildSinglePassPlan({
    segments: [vidSeg(DUR_S * 1000, 0)],
    fullSegments: [vidSeg(DUR_S * 1000, 0)],
    fps: FPS, width: W, height: H, totalMs: DUR_S * 1000,
    kbEnabled: false, zoomMax: 1.25, globalDir: "in",
    transition: null, wm: null, assSuffix: null, overlaySpecs: [],
    audio: {}, audioPath: null, sfx: [], clipAudio: [],
    loudnorm: null, masterLoudnorm: null,
    srcFacts: FACTS,
  });
  const identical = off.script === legacy.script;
  const clean = !/delogo|drawbox|boxblur/.test(off.script);
  report("U3", "TR off (and invalid payloads) keep the graph byte-identical (regression guard)",
    identical && clean, `identical=${identical} clean=${clean}`);
  // Invalid payload → sanitizeTextRemoval null.
  const junk = TR.sanitizeTextRemoval({ enabled: "yes", mode: "nonsense", regions: "nope" });
  report("U3b", "sanitizeTextRemoval rejects junk payloads",
    junk === null, `junk=${JSON.stringify(junk)}`);
}

// ── E1/E2/E3: real exports, frame counts + pixel effect ───────────────
const ENC = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];
function exportWith(mode, out) {
  const plan = planFor(mode, true);
  const scriptPath = `${TMP}/graph_${mode}.txt`;
  fs.writeFileSync(scriptPath, plan.script, "utf-8");
  const args = SP.buildSinglePassArgs({
    plan,
    scriptPath,
    encArgs: ENC,
    abr: "192k",
    fps: FPS,
    outputPath: out,
    threads: 2,
    filterThreads: 2,
    frameCap: DUR_S * FPS,
  });
  run(FF, args);
  return frameCount(out);
}

// Control export (no TR) for the pixel comparison.
{
  const plan = planFor("inpaint", false);
  const scriptPath = `${TMP}/graph_control.txt`;
  fs.writeFileSync(scriptPath, plan.script, "utf-8");
  const args = SP.buildSinglePassArgs({
    plan, scriptPath, encArgs: ENC, abr: "192k", fps: FPS,
    outputPath: `${TMP}/control.mp4`, threads: 2, filterThreads: 2,
    frameCap: DUR_S * FPS,
  });
  run(FF, args);
}

const CROP = "240:30:520:575"; // inside the burned text area
const controlPx = regionLuma(`${TMP}/control.mp4`, 30, CROP);
console.log(`   control region luma: avg ${controlPx.avg.toFixed(1)} (mn ${controlPx.mn} mx ${controlPx.mx})`);

for (const [mode, check] of [
  // Inpaint replaces the text with interpolated surroundings — the extreme
  // pixels (white glyphs) must vanish (max drops well below the control's).
  ["inpaint", (px) => px.mx < 235 && Math.abs(px.avg - controlPx.avg) > 8],
  // Blur preserves the REGION AVERAGE (it smudges, doesn't remove) — the
  // signal is the CONTRAST collapse: the control's white-on-dark text spans
  // ~1..255; a real blur crushes that spread by ≥ 25% and kills the pure
  // white glyph peaks.
  ["blur", (px) =>
    px.mx - px.mn < (controlPx.mx - controlPx.mn) * 0.75 && px.mx < 240],
  ["cover", (px) => Math.abs(px.avg) < 4],
]) {
  const out = `${TMP}/out_${mode}.mp4`;
  const frames = exportWith(mode, out);
  const px = regionLuma(out, 30, CROP);
  const okFrames = frames === DUR_S * FPS;
  const okPixels = Number.isFinite(px.avg) && check(px);
  report(`E-${mode}`, `real export: exact frames + text pixels removed`,
    okFrames && okPixels,
    `frames=${frames}/${DUR_S * FPS} luma avg ${px.avg.toFixed(1)} (mn ${px.mn} mx ${px.mx}) vs control ${controlPx.avg.toFixed(1)}`);
}

// ── P1: two-step path (G.buildClipArgs) with TR ────────────────────────
{
  const built = G.buildClipArgs({
    i: 0,
    seg: vidSeg(DUR_S * 1000, 0),
    segments: [vidSeg(DUR_S * 1000, 0)],
    fps: FPS, width: W, height: H,
    kbEnabled: false, zoomMax: 1.25, globalDir: "in",
    transition: null, wm: null, assSuffix: null,
    clipPath: `${TMP}/twostep.mp4`,
    encArgs: ENC,
    anyAudio: false,
    segHasAudio: false,
    overlaySpecs: [],
    hwaccel: false,
    textRemoval: { enabled: true, mode: "inpaint", regions: REGIONS },
    srcFacts: FACTS[0],
  });
  const hasDelogo = /delogo=x=/.test(built.graph || "");
  const usesComplex = built.args.includes("-filter_complex");
  run(FF, built.args);
  const frames = frameCount(`${TMP}/twostep.mp4`);
  report("P1", "two-step path: delogo in the (forced) complex graph, exit 0, frames ok",
    hasDelogo && usesComplex && Math.abs(frames - DUR_S * FPS) <= 1,
    `delogo=${hasDelogo} complex=${usesComplex} frames=${frames}`);
}

// ── Summary ────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.pass);
console.log(
  failed.length === 0
    ? `\nALL ${results.length} text-removal checks PASSED`
    : `\n${failed.length}/${results.length} FAILED: ${failed.map((f) => f.id).join(", ")}`,
);
process.exit(failed.length === 0 ? 0 : 1);
