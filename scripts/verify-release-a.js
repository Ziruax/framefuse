#!/usr/bin/env node
/**
 * scripts/verify-release-a.js — v1.14.5 "Release A" (the export-speed
 * improvement plan's low-risk optimization release). Unit + end-to-end
 * verification against the REAL export-native handler + real ffmpeg on
 * this (genuinely Tier-3, 2-core) sandbox:
 *
 *   P1   buildVideoFilterChain satisfied-transform skips (unit): the exact
 *        conditions the plan's Phase 1 demands — dims/fps(CFR)/sar/format
 *        dropped ONLY when the probed source already satisfies the output
 *        contract; unknown facts keep the byte-identical legacy chain.
 *   P2   loudnessGainDb + estimateMixLoudnessDb (unit) — the simple-audio
 *        fast path's static-gain math.
 *   P3   estimateRenderCost matrix (unit) — the cost-score thresholds that
 *        replace the duration-based Fast Mode trigger (incl. the 239 s vs
 *        240 s continuity + the v1.14.4 anchor case).
 *   P4   encoderArgs fast profile (unit) — NVENC p1/multipass disabled/
 *        lookahead+AQ off; cinema never fast-profiled; x264/QSV/AMF shapes.
 *   P5   detectHwCapsAsync capability matrix (real ffmpeg) + memoization.
 *   P6   measureLoudnessAsync disk cache (unit round trip) — second
 *        measurement = ZERO ffmpeg spawns, same numbers, disk file written.
 *   P7   SLIDESHOW 24 FPS MODE (E2E): pure-image timeline 30→24 fps, exact
 *        duration/fps of the real output; off switch / mixed video /
 *        cinema / 60 fps all keep the requested rate.
 *   P8   fps-skip FRAME EXACTNESS (E2E): a CFR@30 source + burned captions
 *        (100 % dirty → windowed smart graph) exports with the fps filter
 *        SKIPPED — the graph script proves it — and the output is frame
 *        exact (120 frames / 4.000 s). A 29.97 source KEEPS the filter.
 *   P9   the EXPORT PROFILER (E2E): result.profile + the on-disk JSON
 *        (stages, workers, class wall, frames, loudness cache stats).
 *   P10  loudness CACHE across sessions (E2E): export 1 measures the music
 *        (spawn with print_format=json), a FRESH module session re-measures
 *        nothing (0 spawns, cache hit in the payload).
 *   P11  SIMPLE-AUDIO FAST PATH (E2E): ≤3 branches + normalize ON →
 *        audioFastGain + the static-gain log line + the output lands at
 *        −16 LUFS (±2); a 5-branch timeline keeps the accurate path and
 *        ALSO lands at −16.
 *   P12  COST-BASED FAST MODE (E2E): the fps-12 240 s 1080p storyboard
 *        (score ≥ 14) down scales to 720p-class on Tier 3; the off switch
 *        and a 720p request keep the resolution; the strategy rides the
 *        result payload. (The cinema guard is the unchanged v1.14.4
 *        condition — exercised by G2's blocking-flag path here.)
 *   P13  hwCaps in the export result payload.
 *
 * Run: node scripts/verify-release-a.js
 */
const fs = require("fs");
const path = require("path");
const Module = require("module");
const { spawnSync, spawn: realSpawn } = require("child_process");
const cp = require("child_process");

const ROOT = path.join(__dirname, "..");
const FF = require(path.join(ROOT, "node_modules", "ffmpeg-static"));
const FFPROBE = "/usr/bin/ffprobe";
const TMP = "/tmp/ffrela";
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(TMP, "userData"), { recursive: true });

// ── spawn interception (BEFORE main.js loads) ───────────────────────────
let spawnLog = [];
cp.spawn = function (bin, args, opts) {
  if (String(bin).includes("ffmpeg")) spawnLog.push(args.join(" "));
  return realSpawn.call(this, bin, args, opts);
};

// ── graph-script capture: the smart path writes graph_sm<i>_*.txt ───────
let graphScripts = [];
const realWrite = fs.writeFileSync;
fs.writeFileSync = function (p, ...rest) {
  try {
    if (typeof p === "string" && /graph_sm\d+_/.test(path.basename(p))) {
      graphScripts.push(String(rest[0]));
    }
  } catch (_) { /* never break a real write */ }
  return realWrite.call(this, p, ...rest);
};

// ── electron stub (verify-export-speed pattern) ─────────────────────────
const handlers = {};
const electronStub = {
  app: {
    whenReady: () => Promise.resolve(),
    on: () => {},
    getPath: (k) => path.join(TMP, "userData"),
    getName: () => "FrameFuse",
    getVersion: () => "1.14.5",
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
  ipcMain: { handle: (name, fn) => { handlers[name] = fn; }, on: () => {} },
  dialog: {},
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  shell: {},
  utilityProcess: { fork: () => ({}) },
};
const resolvedElectron = require.resolve("electron");

function loadMain() {
  delete require.cache[resolvedElectron];
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(path.join(ROOT, "electron"))) delete require.cache[k];
  }
  spawnLog = [];
  graphScripts = [];
  const stubModule = new Module(resolvedElectron, null);
  stubModule.filename = resolvedElectron;
  stubModule.loaded = true;
  stubModule.exports = electronStub;
  require.cache[resolvedElectron] = stubModule;
  const main = require(path.join(ROOT, "electron", "main.js"));
  return { handler: handlers["export-native"], main };
}

// ── fixtures ────────────────────────────────────────────────────────────
console.log("── fixtures ──");
function run(bin, args, timeout = 120000) {
  const r = spawnSync(bin, args, { timeout });
  if (r.status !== 0) throw new Error(`${bin} failed: ${r.stderr && r.stderr.toString().slice(0, 400)}`);
}
// 640×360 slideshow images (small = fast harness renders)
for (let k = 0; k < 8; k++) {
  run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "testsrc2=s=640x360:r=30", "-frames:v", "1", `${TMP}/img${k}.png`]);
}
// 1920×1080 images for the fast-mode matrix (fps-12 render keeps it sane)
for (let k = 0; k < 8; k++) {
  run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", "testsrc2=s=1920x1080:r=12", "-frames:v", "1", `${TMP}/big${k}.png`]);
}
// CFR 640×360@30 with EXPLICIT sar 1:1 (the camera-file contract) — the
// all-satisfied skip fixture + its 29.97 twin (the filter-must-stay case).
// -bf 0: the clean-copy seam concat stays frame-exact WITHOUT the B-frame
// reordering that shifts the mp4 duration fields (a PRE-EXISTING v1.14.4
// concat trait, unrelated to the fps skip — verified by A/B in dev).
for (const [name, rate] of [["cfr30", "30"], ["cfr2997", "30000/1001"]]) {
  run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
    "-i", `testsrc2=s=640x360:r=${rate}`, "-t", "4",
    "-vf", "setsar=1", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-g", "48", "-keyint_min", "48", "-bf", "0", "-pix_fmt", "yuv420p", `${TMP}/${name}.mp4`]);
}
// 4 small audio-carrying videos (the accurate-path 5-branch timeline)
for (let v = 0; v < 4; v++) {
  run(FF, ["-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30",
    "-f", "lavfi", "-i", `sine=frequency=${300 + v * 60}:r=48000`,
    "-t", "3", "-vf", "setsar=1", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-g", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-shortest", `${TMP}/av${v}.mp4`]);
}
// 30 s + 240 s music beds (user-source files — NOT under tempDir)
run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
  "-i", "sine=frequency=220:r=48000:d=30,volume=0.3", "-c:a", "pcm_s16le", `${TMP}/music30.wav`]);
run(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
  "-i", "sine=frequency=220:r=48000:d=240,volume=0.3", "-c:a", "pcm_s16le", `${TMP}/music240.wav`]);

const captionSettings = {
  enabled: true, presetId: "clean", fontSizeScale: 1, wordMode: "off", animation: "none",
  customColor: null, customPosition: null, fontId: "arial", fontWeight: 600,
};
function fullCues(totalMs, stepMs = 1500) {
  const cues = [];
  for (let t = 0; t + stepMs <= totalMs; t += stepMs) {
    cues.push({ startMs: t + 200, endMs: t + stepMs - 200, text: "RELEASE A CAPTIONS", words: [] });
  }
  return cues;
}
function imageTimeline(count, eachMs, prefix, offset = 0) {
  return Array.from({ length: count }, (_, k) => ({
    id: `${prefix}${k}`, fileName: `${prefix}${k}.png`, mediaType: "image",
    imagePath: `${TMP}/${prefix}${k}.png`,
    startMs: offset + k * eachMs, endMs: offset + k * eachMs + eachMs, durationMs: eachMs,
    track: 0, volume: 1, trimInMs: 0, speed: 1, sourceDurationMs: null,
    direction: k % 2 ? "out" : "in",
  }));
}
function videoTimeline(files, eachMs, offset = 0) {
  return files.map((f, k) => ({
    id: `v${k}`, fileName: f, mediaType: "video",
    videoPath: `${TMP}/${f}`, imagePath: `${TMP}/${f}`,
    startMs: offset + k * eachMs, endMs: offset + k * eachMs + eachMs, durationMs: eachMs,
    track: 0, volume: 1, trimInMs: 0, speed: 1, sourceDurationMs: eachMs,
  }));
}

function probeFps(p) {
  const r = spawnSync(FFPROBE, ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=avg_frame_rate", "-of", "csv=p=0", p], { encoding: "utf8" });
  const m = /^(\d+)\/(\d+)$/.exec(String(r.stdout || "").trim());
  return m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : parseFloat(r.stdout || "0");
}
function probeDuration(p) {
  const r = spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p], { encoding: "utf8" });
  return parseFloat(r.stdout || "0");
}
function probeFrames(p) {
  const r = spawnSync(FFPROBE, ["-v", "error", "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", p], { encoding: "utf8" });
  return parseInt(String(r.stdout || "").trim(), 10) || 0;
}
function probeDims(p) {
  const r = spawnSync(FFPROBE, ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "csv=p=0", p], { encoding: "utf8" });
  const cells = String(r.stdout || "").trim().split(",");
  return { w: parseInt(cells[0], 10) || 0, h: parseInt(cells[1], 10) || 0 };
}
/** Integrated loudness (LUFS) of an output's audio via ebur128 — the LAST
 * "I: x LUFS" line is the summary (the per-frame running lines come first). */
function probeLufs(p) {
  const r = spawnSync(FF, ["-hide_banner", "-nostats", "-i", p, "-map", "0:a",
    "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8", timeout: 60000 });
  const ms = [...String(r.stderr || "").matchAll(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g)];
  return ms.length ? parseFloat(ms[ms.length - 1][1]) : null;
}

async function runExport(handler, outPath, o = {}) {
  const fakeEvent = { sender: { isDestroyed: () => false, send: () => {} } };
  const segments = o.segments;
  const totalMs = segments.reduce((a, s) => Math.max(a, s.endMs ?? (s.startMs || 0) + s.durationMs), 0);
  spawnLog = [];
  graphScripts = [];
  const t0 = Date.now();
  const result = await handler(fakeEvent, {
    outputPath: outPath,
    fps: o.fps || 30,
    width: o.width, height: o.height,
    bitrateMbps: 8, quality: o.quality || "social", crf: 20, audioKbps: 192,
    kenBurns: { enabled: o.kb !== false, intensity: 50, direction: "in" },
    segments,
    audioPath: o.audioPath === null ? null : (o.audioPath || `${TMP}/music30.wav`),
    audio: Object.assign(
      { masterVolume: 1, fadeInMs: 300, fadeOutMs: 500, musicVolume: 0.8, musicStartMs: 0, musicLoop: false },
      o.audio || {}),
    captionSettings: o.captions === false ? { enabled: false } : captionSettings,
    subtitleCues: o.captions === false ? [] : (o.cues || fullCues(totalMs)),
    headlines: [],
    transition: null,
    watermark: null,
    overlays: [],
    sfx: [],
    ...(o.fastMode === false ? { fastMode: false } : {}),
    ...(o.slideshowFps24 === false ? { slideshowFps24: false } : {}),
  });
  return { ms: Date.now() - t0, result, spawnLog: spawnLog.slice(), graphs: graphScripts.slice() };
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? "PASS" : "FAIL"} — ${name}${detail != null ? ` (${detail})` : ""}`);
  cond ? pass++ : fail++;
}

// ══════════════════════════════════════════════════════════════════════
// P1 — buildVideoFilterChain satisfied-transform skips (pure unit)
// ══════════════════════════════════════════════════════════════════════
console.log("── P1 chain skips (unit) ──");
const G = require(path.join(ROOT, "electron", "export-graph.js"));
const LEGACY = "scale=640:360:force_original_aspect_ratio=increase,crop=640:360,fps=30,setsar=1,format=yuv420p";
const facts = (over) => Object.assign({ srcW: 640, srcH: 360, srcFps: 30, rFps: 30, sar: 1, pixFmt: "yuv420p", rotated: false, hwToken: false }, over);
check("no facts → byte-identical legacy chain",
  G.buildVideoFilterChain({ width: 640, height: 360, fps: 30, speed: 1 }) === LEGACY,
  G.buildVideoFilterChain({ width: 640, height: 360, fps: 30, speed: 1 }));
check("all satisfied → empty chain",
  G.buildVideoFilterChain({ width: 640, height: 360, fps: 30, speed: 1, srcFacts: facts() }) === "");
check("hw decode → format kept (nv12 handoff)",
  G.buildVideoFilterChain({ width: 640, height: 360, fps: 30, speed: 1, srcFacts: facts({ hwToken: true }) }) === "format=yuv420p");
check("VFR-at-average → fps kept",
  /(^|,)fps=30/.test(G.buildVideoFilterChain({ width: 640, height: 360, fps: 30, speed: 1, srcFacts: facts({ rFps: 10 }) })));
check("rate mismatch (29.97→30) → fps kept",
  /(^|,)fps=30/.test(G.buildVideoFilterChain({ width: 640, height: 360, fps: 30, speed: 1, srcFacts: facts({ srcFps: 29.97 }) })));
check("dims mismatch → scale+crop kept",
  /scale=640:360:force_original_aspect_ratio=increase,/.test(G.buildVideoFilterChain({ width: 640, height: 360, fps: 30, speed: 1, srcFacts: facts({ srcW: 1280, srcH: 720 }) })));
check("dims mismatch → fps/sar/format still skipped when satisfied",
  G.buildVideoFilterChain({ width: 640, height: 360, fps: 30, speed: 1, srcFacts: facts({ srcW: 1280, srcH: 720 }) }) ===
  "scale=640:360:force_original_aspect_ratio=increase,crop=640:360");
check("sar unset (0) → setsar kept",
  /setsar=1$/.test(G.buildVideoFilterChain({ width: 640, height: 360, fps: 30, speed: 1, srcFacts: facts({ sar: 0 }) }).replace("format=yuv420p", "")) || G.buildVideoFilterChain({ width: 640, height: 360, fps: 30, speed: 1, srcFacts: facts({ sar: 0 }) }).includes("setsar=1"));
check("yuvj420p → format kept",
  G.buildVideoFilterChain({ width: 640, height: 360, fps: 30, speed: 1, srcFacts: facts({ pixFmt: "yuvj420p" }) }) === "format=yuv420p");
check("speed ≠ 1 → setpts + fps kept, geometry skips stay",
  G.buildVideoFilterChain({ width: 640, height: 360, fps: 30, speed: 2, srcFacts: facts() }) === "setpts=PTS/2,fps=30");
check("rotated → scale+crop kept",
  G.buildVideoFilterChain({ width: 640, height: 360, fps: 30, speed: 1, srcFacts: facts({ srcW: 360, srcH: 640, rotated: true }) }).startsWith("scale=640:360"));

// ══════════════════════════════════════════════════════════════════════
// P2 — loudness static-gain helpers (pure unit)
// ══════════════════════════════════════════════════════════════════════
console.log("── P2 loudness gain helpers (unit) ──");
check("loudnessGainDb: -20 LUFS source → +4 dB",
  G.loudnessGainDb({ i: -20, lra: 5, tp: -3, thresh: -30 }) === 4);
check("loudnessGainDb: silent (-inf-ish) → null",
  G.loudnessGainDb({ i: -70, lra: 0, tp: -70, thresh: -70 }) === null);
check("loudnessGainDb: null-safe",
  G.loudnessGainDb(null) === null && G.loudnessGainDb(undefined) === null);
const est2 = G.estimateMixLoudnessDb({
  totalSec: 30,
  audio: { masterVolume: 1 },
  clipAudio: [{ measure: { i: -16, lra: 5, tp: -3, thresh: -30 }, volume: 1, durationMs: 30000 }],
  music: { i: -16, lra: 5, tp: -3, thresh: -30 },
});
check("estimateMixLoudnessDb: 2 full-span branches sum ≈ -13 LUFS",
  est2 && Math.abs(est2.i + 13) < 0.6, est2 && est2.i);
check("estimateMixLoudnessDb: 1 branch → null (already at target)",
  G.estimateMixLoudnessDb({ totalSec: 30, audio: { masterVolume: 1 }, clipAudio: [{ measure: { i: -16, lra: 5, tp: -3, thresh: -30 }, volume: 1, durationMs: 30000 }], music: null }) === null);
check("estimateMixLoudnorm string form unchanged",
  /^loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=-12\.9/.test(String(G.estimateMixLoudnorm({
    totalSec: 30, audio: { masterVolume: 1 },
    clipAudio: [{ measure: { i: -16, lra: 5, tp: -3, thresh: -30 }, volume: 1, durationMs: 30000 }],
    music: { i: -16, lra: 5, tp: -3, thresh: -30 },
  }))));

// ══════════════════════════════════════════════════════════════════════
// P3 — estimateRenderCost matrix (pure unit)
// ══════════════════════════════════════════════════════════════════════
console.log("── P3 render-cost score (unit) ──");
let { main } = loadMain();
const R = (o) => main.estimateRenderCost(o);
const base1080 = { width: 1920, height: 1080, fps: 30, durationSec: 240, dirtySec: 240 };
check("v1.14.4 anchor: 1080p30 240s full-dirty effectless → 14.93 VERY_HIGH",
  R(base1080).score === 14.93 && R(base1080).strategy === "VERY_HIGH", JSON.stringify(R(base1080)));
check("239s → 14.87 VERY_HIGH (no duration cliff)",
  R({ ...base1080, durationSec: 239, dirtySec: 239 }).strategy === "VERY_HIGH");
check("720p 240s → MEDIUM (no fast mode, no fast encoder)",
  R({ ...base1080, width: 1280, height: 720 }).strategy === "MEDIUM", JSON.stringify(R({ ...base1080, width: 1280, height: 720 })));
check("clean timeline (dirtySec 0) → LOW",
  R({ ...base1080, dirtySec: 0 }).strategy === "LOW");
check("effect-heavy 90s 1080p → VERY_HIGH (score-based, not duration)",
  R({ ...base1080, durationSec: 90, dirtySec: 90, captions: true, kenBurnsCount: 8, transitionCount: 7 }).strategy === "VERY_HIGH",
  JSON.stringify(R({ ...base1080, durationSec: 90, dirtySec: 90, captions: true, kenBurnsCount: 8, transitionCount: 7 })));
check("4K60 30s → VERY_HIGH",
  R({ width: 3840, height: 2160, fps: 60, durationSec: 30, dirtySec: 30 }).strategy === "VERY_HIGH");
check("1080p30 134s → HIGH (fast encoder band)",
  R({ ...base1080, durationSec: 134, dirtySec: 134 }).strategy === "HIGH");
check("half-dirty halves the score",
  Math.abs(R({ ...base1080, dirtySec: 120 }).score - 7.46) < 0.011, String(R({ ...base1080, dirtySec: 120 }).score));

// ══════════════════════════════════════════════════════════════════════
// P4 — encoderArgs fast profile (pure unit)
// ══════════════════════════════════════════════════════════════════════
console.log("── P4 encoder fast profile (unit) ──");
const enc = (name, prof, quality = "social", tier = "TIER_1_GPU") =>
  main.encoderArgs(name, 8, 1920, 1080, quality, 20, tier, prof).join(" ");
const nvBalanced = enc("h264_nvenc", "balanced");
check("NVENC balanced: p4 + qres multipass + hq tune + b_ref_mode",
  nvBalanced.includes("-preset p4") && nvBalanced.includes("-multipass qres") &&
  nvBalanced.includes("-tune hq") && nvBalanced.includes("-b_ref_mode middle"), nvBalanced);
const nvFast = enc("h264_nvenc", "fast");
check("NVENC fast: p1 + multipass disabled + lookahead 0 + spatial_aq 0, NO hq/b_ref_mode",
  nvFast.includes("-preset p1") && nvFast.includes("-multipass disabled") &&
  nvFast.includes("-rc-lookahead 0") && nvFast.includes("-spatial_aq 0") &&
  !nvFast.includes("-tune hq") && !nvFast.includes("-b_ref_mode"), nvFast);
check("NVENC cinema NEVER fast-profiled",
  enc("h264_nvenc", "fast", "cinema").includes("-preset p6") && enc("h264_nvenc", "fast", "cinema").includes("-multipass qres"));
check("x264 Tier-2 fast → ultrafast (+fastdecode)",
  enc("libx264", "fast", "social", "TIER_2_MODERN_CPU").includes("-preset ultrafast") &&
  enc("libx264", "fast", "social", "TIER_2_MODERN_CPU").includes("-tune fastdecode"));
check("x264 Tier-2 balanced → superfast",
  enc("libx264", "balanced", "social", "TIER_2_MODERN_CPU").includes("-preset superfast"));
check("x264 cinema fast → keeps faster (quality tier)",
  enc("libx264", "fast", "cinema", "TIER_2_MODERN_CPU").includes("-preset faster"));
check("QSV fast keeps veryfast",
  enc("h264_qsv", "fast").includes("-preset veryfast"));
check("AMF fast → speed usage",
  enc("h264_amf", "fast").includes("-quality speed") && enc("h264_amf", "balanced").includes("-quality balanced"));

// ══════════════════════════════════════════════════════════════════════
// P5 — capability matrix (real ffmpeg)
// ══════════════════════════════════════════════════════════════════════
console.log("── P5 capability matrix ──");
(async () => {
  const caps = await main.detectHwCapsAsync();
  check("hwaccels array non-empty on this build", Array.isArray(caps.hwaccels) && caps.hwaccels.length > 0, caps.hwaccels.join(","));
  check("gpuFilters is an array (Linux CPU build → likely empty)", Array.isArray(caps.gpuFilters), caps.gpuFilters.join(","));
  const caps2 = await main.detectHwCapsAsync();
  check("memoized (same object)", caps2 === caps);

  // ════════════════════════════════════════════════════════════════════
  // P6 — measureLoudnessAsync disk cache (fresh-session round trip)
  // ════════════════════════════════════════════════════════════════════
  console.log("── P6 loudness disk cache (unit) ──");
  const { main: mainB } = loadMain();
  spawnLog = [];
  const m1 = await mainB.measureLoudnessAsync(`${TMP}/music30.wav`);
  mainB.flushLoudnessDisk();
  const spawns1 = spawnLog.filter((l) => l.includes("print_format=json")).length;
  check("first measurement spawns the ebur128 pass", m1 && Number.isFinite(m1.i) && spawns1 === 1, `i=${m1 && m1.i}, spawns=${spawns1}`);
  const { main: mainC } = loadMain(); // FRESH session (in-memory cache gone)
  spawnLog = [];
  const m2 = await mainC.measureLoudnessAsync(`${TMP}/music30.wav`);
  const spawns2 = spawnLog.filter((l) => l.includes("print_format=json")).length;
  check("fresh session: cached, ZERO spawns, same numbers",
    spawns2 === 0 && m2 && Math.abs(m2.i - m1.i) < 0.01, `spawns=${spawns2}, i=${m2 && m2.i}`);
  check("loudness-cache-v1.json on disk",
    fs.existsSync(path.join(TMP, "userData", "loudness-cache-v1.json")));

  const { handler } = loadMain();

  // ════════════════════════════════════════════════════════════════════
  // P7 — SLIDESHOW 24 FPS MODE (E2E)
  // ════════════════════════════════════════════════════════════════════
  console.log("── P7 slideshow 24 fps (E2E) ──");
  const slide8 = imageTimeline(8, 3750, "img");
  const r7 = await runExport(handler, `${TMP}/out72.mp4`, {
    segments: slide8, width: 640, height: 360, fps: 30, captions: false, kb: true,
  });
  check("payload: slideshowFps 30→24, outputFps 24",
    r7.result.slideshowFps === true && r7.result.slideshowFpsFrom === 30 && r7.result.slideshowFpsTo === 24 && r7.result.outputFps === 24,
    JSON.stringify({ s: r7.result.slideshowFps, from: r7.result.slideshowFpsFrom, to: r7.result.slideshowFpsTo, out: r7.result.outputFps }));
  check("real output: 24 fps, 30.0 s, frame-exact (720)",
    Math.abs(probeFps(`${TMP}/out72.mp4`) - 24) < 0.1 && Math.abs(probeDuration(`${TMP}/out72.mp4`) - 30) < 0.15 && probeFrames(`${TMP}/out72.mp4`) === 720,
    `${probeFps(`${TMP}/out72.mp4`)}fps ${probeDuration(`${TMP}/out72.mp4`)}s ${probeFrames(`${TMP}/out72.mp4`)}f`);
  const r7b = await runExport(handler, `${TMP}/out72b.mp4`, {
    segments: slide8, width: 640, height: 360, fps: 30, captions: false, slideshowFps24: false,
  });
  check("off switch: 30 fps kept",
    r7b.result.slideshowFps === undefined && r7b.result.outputFps === 30 && Math.abs(probeFps(`${TMP}/out72b.mp4`) - 30) < 0.1);
  const mixed = [...videoTimeline(["cfr30.mp4"], 4000), ...imageTimeline(6, 3750, "img", 4000)];
  const r7c = await runExport(handler, `${TMP}/out72c.mp4`, {
    segments: mixed, width: 640, height: 360, fps: 30, captions: false,
  });
  check("mixed video+images: no downgrade",
    r7c.result.slideshowFps === undefined && r7c.result.outputFps === 30);
  const r7d = await runExport(handler, `${TMP}/out72d.mp4`, {
    segments: slide8, width: 640, height: 360, fps: 30, captions: false, quality: "cinema",
  });
  check("cinema: no downgrade",
    r7d.result.slideshowFps === undefined && r7d.result.outputFps === 30);
  const r7e = await runExport(handler, `${TMP}/out72e.mp4`, {
    segments: slide8, width: 640, height: 360, fps: 60, captions: false,
  });
  check("60 fps project keeps 60",
    r7e.result.slideshowFps === undefined && r7e.result.outputFps === 60 && Math.abs(probeFps(`${TMP}/out72e.mp4`) - 60) < 0.1);

  // ════════════════════════════════════════════════════════════════════
  // P8 — fps-skip FRAME EXACTNESS (E2E) + the graph script proves the skip
  // ════════════════════════════════════════════════════════════════════
  console.log("── P8 fps skip frame exactness (E2E) ──");
  const r8 = await runExport(handler, `${TMP}/out30.mp4`, {
    segments: videoTimeline(["cfr30.mp4"], 4000), width: 640, height: 360, fps: 30,
    captions: true, audioPath: null,
  });
  const g30 = r8.graphs.find((g) => g.includes("setpts=PTS-STARTPTS")) || "";
  check("graph: fps/setsar/scale SKIPPED (format stays — <20 s sources ride the conservative -hwaccel auto token)",
    /\[0:v\]format=yuv420p,setpts=PTS-STARTPTS\[s0\]/.test(g30) && !/fps=30/.test(g30) && !/setsar=1/.test(g30) && !/scale=640:360/.test(g30),
    (g30.split("\n").find((l) => l.includes("setpts")) || "").slice(0, 90));
  check("output frame-exact: 120 frames / 4.000 s",
    probeFrames(`${TMP}/out30.mp4`) === 120 && Math.abs(probeDuration(`${TMP}/out30.mp4`) - 4) < 0.05,
    `${probeFrames(`${TMP}/out30.mp4`)}f ${probeDuration(`${TMP}/out30.mp4`)}s`);
  const r8b = await runExport(handler, `${TMP}/out2997.mp4`, {
    segments: videoTimeline(["cfr2997.mp4"], 4000), width: 640, height: 360, fps: 30,
    captions: true, audioPath: null,
  });
  const g2997 = r8b.graphs.find((g) => g.includes("setpts=PTS-STARTPTS")) || "";
  check("29.97 source: fps=30 KEPT in the chain",
    /\[0:v\][^\n]*fps=30[^\n]*setpts=PTS-STARTPTS\[s0\]/.test(g2997),
    (g2997.split("\n").find((l) => l.includes("setpts")) || "").slice(0, 90));
  check("29.97 → 30 resample output: 120 frames / 4.000 s",
    probeFrames(`${TMP}/out2997.mp4`) === 120 && Math.abs(probeDuration(`${TMP}/out2997.mp4`) - 4) < 0.05,
    `${probeFrames(`${TMP}/out2997.mp4`)}f ${probeDuration(`${TMP}/out2997.mp4`)}s`);
  // P8c — the BARE chain (format included in the skip) via the REAL window
  // graph builder: hwaccelPerSeg [false] (a probe-gated CPU-decode verdict —
  // the production case where the full skip rides) + all-satisfied facts.
  const SPmod = require(path.join(ROOT, "electron", "export-singlepass.js"));
  const p8c = SPmod.buildSinglePassPlan({
    segments: videoTimeline(["cfr30.mp4"], 4000),
    fullSegments: videoTimeline(["cfr30.mp4"], 4000),
    window: { t0Ms: 0, durMs: 4000, segMeta: [{ origIdx: 0, S: 0, F: 120, k0: 0, k1: 120, ssSec: "0" }] },
    videoOnly: true,
    fps: 30, width: 640, height: 360, totalMs: 4000,
    kbEnabled: false, zoomMax: 1.1, globalDir: "in", transition: null,
    wm: null, assSuffix: null, overlaySpecs: [],
    hwaccelPerSeg: [false],
    srcFacts: [facts()],
  });
  check("P8c: windowed graph with a CPU-decode verdict → the BARE setpts-only chain",
    /\[0:v\]setpts=PTS-STARTPTS\[s0\]/.test(p8c.script) && !/fps=30/.test(p8c.script) && !/format=yuv420p/.test(p8c.script),
    (p8c.script.split("\n").find((l) => l.includes("setpts")) || "").slice(0, 80));

  // ════════════════════════════════════════════════════════════════════
  // P9 + P10 + P11 + P13 — profiler, loudness cache, fast audio, hwCaps
  // ════════════════════════════════════════════════════════════════════
  console.log("── P9/P10/P11/P13 profiler + audio paths (E2E) ──");
  // P11a: music-only + normalize ON (1 branch) → the SIMPLE-AUDIO fast path.
  const r11 = await runExport(handler, `${TMP}/outfast.mp4`, {
    segments: slide8, width: 640, height: 360, fps: 30, captions: false,
    audio: { normalize: true },
  });
  check("fast path payload: audioFastGain true + static-gain log",
    r11.result.audioFastGain === true, `audioFastGain=${r11.result.audioFastGain}`);
  const lufsFast = probeLufs(`${TMP}/outfast.mp4`);
  check("fast path output lands at −16 LUFS (±2)",
    lufsFast != null && Math.abs(lufsFast + 16) <= 2, `I=${lufsFast} LUFS`);
  // P11b: 5 branches (4 audio videos + music) → the ACCURATE path.
  const five = [...videoTimeline(["av0.mp4", "av1.mp4", "av2.mp4", "av3.mp4"], 3000), ...imageTimeline(1, 3000, "img", 12000)];
  const r11b = await runExport(handler, `${TMP}/outacc.mp4`, {
    segments: five, width: 640, height: 360, fps: 30, captions: false,
    audio: { normalize: true },
  });
  check("accurate path: audioFastGain undefined (5 branches)",
    r11b.result.audioFastGain === undefined, `audioFastGain=${r11b.result.audioFastGain}`);
  const lufsAcc = probeLufs(`${TMP}/outacc.mp4`);
  check("accurate path output also lands at −16 LUFS (±2)",
    lufsAcc != null && Math.abs(lufsAcc + 16) <= 2, `I=${lufsAcc} LUFS`);

  // P9: the profiler (reuse r11/r11b payloads).
  const prof = r11b.result.profile;
  check("profile payload present with totalMs + stages",
    !!(prof && prof.totalMs > 0 && prof.stages && Object.keys(prof.stages).length >= 3),
    prof && JSON.stringify(prof.stages));
  check("profile file written + parses (workers, class wall, frames)", (() => {
    try {
      if (!prof.file || !fs.existsSync(prof.file)) return false;
      const j = JSON.parse(fs.readFileSync(prof.file, "utf8"));
      return Array.isArray(j.workers) && j.workers.length > 0 &&
        typeof j.classWallMs === "object" && Number.isFinite(j.framesEncoded) && j.framesEncoded > 0;
    } catch (_) { return false; }
  })(), prof && prof.file);
  check("last.json exists next to the profile",
    fs.existsSync(path.join(TMP, "userData", "export-profiles", "last.json")));
  check("profile pool + loudness stats carried",
    !!(prof && prof.pool && prof.pool.width >= 1 && prof.loudnessCache), JSON.stringify(prof && prof.pool));

  // P13: hwCaps in the payload.
  check("hwCaps payload: hwaccels array matches the probe",
    !!(r11b.result.hwCaps && Array.isArray(r11b.result.hwCaps.hwaccels) && r11b.result.hwCaps.hwaccels.length > 0),
    JSON.stringify(r11b.result.hwCaps));

  // P10: cache across sessions — export once more from a FRESH session and
  // count ebur128 measurement spawns for the (unchanged) music source.
  const { handler: handlerD } = loadMain();
  const r10 = await runExport(handlerD, `${TMP}/outcache.mp4`, {
    segments: slide8, width: 640, height: 360, fps: 30, captions: false,
    audio: { normalize: true },
  });
  const measureSpawns = r10.spawnLog.filter((l) => l.includes("print_format=json")).length;
  check("fresh session: music measurement came from the DISK cache (0 spawns)",
    measureSpawns === 0 && r10.result.profile && r10.result.profile.loudnessCache.hits >= 1,
    `spawns=${measureSpawns}, hits=${r10.result.profile && r10.result.profile.loudnessCache && r10.result.profile.loudnessCache.hits}`);

  // ════════════════════════════════════════════════════════════════════
  // P12 — COST-BASED FAST MODE (E2E, fps-12 240 s 1080p storyboards)
  // ════════════════════════════════════════════════════════════════════
  console.log("── P12 cost-based fast mode (E2E) ──");
  const big8 = imageTimeline(8, 30000, "big");
  const g1 = await runExport(handler, `${TMP}/outbig1.mp4`, {
    segments: big8, width: 1920, height: 1080, fps: 12, captions: true, kb: true,
    audioPath: `${TMP}/music240.wav`,
  });
  check("G1: score ≥ 14 → fastMode applied → real 1280x720 output",
    g1.result.fastMode === true && g1.result.fastModeFrom === "1920x1080" && g1.result.fastModeTo === "1280x720" &&
    g1.result.costStrategy === "VERY_HIGH" && g1.result.renderCost.score >= 14,
    JSON.stringify({ fast: g1.result.fastMode, to: g1.result.fastModeTo, strat: g1.result.costStrategy, score: g1.result.renderCost && g1.result.renderCost.score }));
  const dims1 = probeDims(`${TMP}/outbig1.mp4`);
  check("G1: probed output dims + duration exact",
    dims1.w === 1280 && dims1.h === 720 && Math.abs(probeDuration(`${TMP}/outbig1.mp4`) - 240) < 0.5,
    `${dims1.w}x${dims1.h} ${probeDuration(`${TMP}/outbig1.mp4`)}s`);
  const g2 = await runExport(handler, `${TMP}/outbig2.mp4`, {
    segments: big8, width: 1920, height: 1080, fps: 12, captions: true, kb: true,
    audioPath: `${TMP}/music240.wav`, fastMode: false,
  });
  const dims2 = probeDims(`${TMP}/outbig2.mp4`);
  check("G2: off switch honored (1080p kept), strategy still reported",
    g2.result.fastMode === undefined && dims2.w === 1920 && dims2.h === 1080 && g2.result.costStrategy === "VERY_HIGH");
  const g3 = await runExport(handler, `${TMP}/outbig3.mp4`, {
    segments: big8, width: 1280, height: 720, fps: 12, captions: true, kb: true,
    audioPath: `${TMP}/music240.wav`,
  });
  const dims3 = probeDims(`${TMP}/outbig3.mp4`);
  check("G3: 720p request → no downscale, HIGH strategy + fast encoder profile",
    g3.result.fastMode === undefined && dims3.w === 1280 && dims3.h === 720 &&
    g3.result.costStrategy === "HIGH" && g3.result.encoderSpeedProfile === "fast",
    JSON.stringify({ strat: g3.result.costStrategy, profile: g3.result.encoderSpeedProfile, score: g3.result.renderCost && g3.result.renderCost.score }));
  check("G1 wall ≤ G2 wall (the speed lever works)",
    g1.ms <= g2.ms, `${(g1.ms / 1000).toFixed(1)}s vs ${(g2.ms / 1000).toFixed(1)}s`);

  console.log(`\n${pass}/${pass + fail} PASS${fail ? `, ${fail} FAIL` : ""}`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error("HARNESS ERROR:", err && err.stack || err);
  process.exit(1);
});
