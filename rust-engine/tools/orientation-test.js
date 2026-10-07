// ORIENTATION regression test — v0.5.1.
//
// The v1.33.9 GPU compositor exported UPSIDE-DOWN video (composite.wgsl
// flipped the sample UV vertically: `1.0 - p.y` on top of a transform that
// already maps y=0 → screen top). Every CI color test used SPATIALLY
// UNIFORM frames (solid red/green/blue), so a vertical flip was invisible.
// This test is the lock: an image (and a decoded video) whose TOP half is
// RED and BOTTOM half is BLUE must export with red on top and blue on
// bottom — on BOTH compositor paths (GPU forced + CPU forced).
//
// Also locks caption placement: position:"bottom" text must appear in the
// BOTTOM rows of the output, not the top (the flip moved captions too).
//
// Each case runs in a CHILD process — FRAMEFUSE_FORCE_COMPOSITOR is
// process-global, so the cpu/gpu forces cannot share one process.
//
// Usage: node tools/orientation-test.js
// Exit 0 = all checks passed on every path that ran.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const IS_WIN = process.platform === "win32";
const FFMPEG = process.env.FF_TEST_FFMPEG || (IS_WIN ? path.join(ROOT, "resources", "ffmpeg", "win", "ffmpeg.exe") : "ffmpeg");
const FFMPEG_DIR = process.env.FF_ENGINE_FFMPEG_DIR !== undefined ? process.env.FF_ENGINE_FFMPEG_DIR : "";
const MEDIA = process.env.FF_TEST_MEDIA_DIR ? path.resolve(process.env.FF_TEST_MEDIA_DIR) : path.join(os.tmpdir(), "fftest-orient");
fs.mkdirSync(MEDIA, { recursive: true });

const W = 320, H = 180, FPS = 10, DUR_MS = 1000;
// BT.601 limited-range expectations (see yuv-color-test.js)
const RED = [81, 90, 240];
const BLUE = [41, 240, 110];

// ── child mode: run ONE export + pixel checks ──────────────────────────────
if (process.env.ORIENT_CASE) {
  const force = process.env.FRAMEFUSE_FORCE_COMPOSITOR;
  const kind = process.env.ORIENT_CASE; // image | image+cap | video
  const engine = require(path.join(__dirname, "..", "index.js"));
  const t0 = Date.now();

  const img = path.join(MEDIA, "orient.png");
  const vid = path.join(MEDIA, "orient.mp4");
  const FONT = IS_WIN
    ? "C:/Windows/Fonts/arialbd.ttf"
    : fs.existsSync("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")
      ? "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
      : path.join(ROOT, "public", "fonts", "Montserrat-700.ttf");

  const imgSeg = { id: "s1", mediaType: "image", path: img, startMs: 0, endMs: DUR_MS, durationMs: DUR_MS, trimInMs: 0, speed: 1, track: 0, volume: 0, opacity: 1, hasAudio: false, loopSrc: false };
  const vidSeg = { id: "s2", mediaType: "video", path: vid, startMs: 0, endMs: DUR_MS, durationMs: DUR_MS, trimInMs: 0, speed: 1, track: 0, volume: 1, opacity: 1, hasAudio: false, loopSrc: true };
  const seg = kind === "video" ? vidSeg : imgSeg;
  const captions = kind === "image+cap" ? {
    fontKey: "caption", fontSizePx: 34, textColor: "#FFFFFF", highlightColor: "#22C55E",
    borderColor: "#000000", borderWidthPx: 2, bgColor: null, bgAlpha: 1, bgPaddingPx: 8,
    shadow: false, shadowColor: "#000000", shadowPx: 4, textTransform: "none",
    letterSpacingPx: 1, alignment: "center", position: "bottom", positionY: 0,
    maxWidthFrac: 0.9, wordMode: "off", animation: "none",
    cues: [{ startMs: 0, endMs: DUR_MS, text: "ORIENT TEST CAPTION", words: [] }],
  } : null;

  const tl = Object.assign({
    version: 1, width: W, height: H, fps: FPS, sampleRate: 48000, audioChannels: 2,
    crf: 22, quality: "social", audioKbps: 96, backgroundColor: "#000000",
    totalMs: DUR_MS, fonts: { caption: FONT },
    segments: [seg], music: null, extraAudio: [], texts: [], watermark: null, kinetic: null,
  }, captions ? { captions } : {});

  const out = path.join(MEDIA, `orient-${kind.replace(/\+/g, "_")}-${force}.mp4`);
  engine.exportVideo(JSON.stringify(tl), out, FFMPEG_DIR, () => {}).then((res) => {
    if (!fs.existsSync(out)) { console.log(`RESULT FAIL ${kind}/${force} no output file`); process.exit(1); }
    // decode the FIRST frame to raw yuv420p
    const r = spawnSync(FFMPEG, ["-i", out, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"], { maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
    if (r.status !== 0) { console.log(`RESULT FAIL ${kind}/${force} rawvideo decode failed`); process.exit(1); }
    const yuv = r.stdout;
    const yuvAt = (x, y) => {
      const yOff = y * W + x;
      const cW = W / 2;
      const uOff = W * H + Math.floor(y / 2) * cW + Math.floor(x / 2);
      const vOff = W * H + cW * (H / 2) + Math.floor(y / 2) * cW + Math.floor(x / 2);
      return [yuv[yOff], yuv[uOff], yuv[vOff]];
    };
    // sample OFF-CENTER: a centered caption covers the bottom-center pixel,
    // so the blue check reads x=16 (outside a 0.9-width centered text block)
    const top = yuvAt(W / 2, 20);
    const bot = yuvAt(16, H - 20);
    const errs = [];
    if (!top.every((g, i) => Math.abs(g - RED[i]) <= 14)) errs.push(`top px got Y=${top[0]} U=${top[1]} V=${top[2]} want red ${RED} (FLIPPED?)`);
    if (!bot.every((g, i) => Math.abs(g - BLUE[i]) <= 14)) errs.push(`bottom px got Y=${bot[0]} U=${bot[1]} V=${bot[2]} want blue ${BLUE} (FLIPPED?)`);
    let capInfo = "";
    if (captions) {
      let topBright = 0, botBright = 0;
      for (let x = 8; x < W - 8; x += 4) {
        for (let y = 4; y < 22; y += 2) if (yuv[y * W + x] > 200) topBright++;
        for (let y = H - 22; y < H - 4; y += 2) if (yuv[y * W + x] > 200) botBright++;
      }
      capInfo = ` (text px: top=${topBright} bottom=${botBright})`;
      if (botBright === 0 || topBright > botBright) errs.push(`caption not at bottom: top=${topBright} bottom=${botBright}`);
    }
    const ok = errs.length === 0;
    console.log(`RESULT ${ok ? "PASS" : "FAIL"} ${kind}/${force} engine=${res.engineUsed} ${res.compositor_note || ""}${capInfo} ${Date.now() - t0}ms`);
    if (!ok) errs.forEach((e) => console.log("      " + e));
    process.exit(ok ? 0 : 1);
  }).catch((e) => {
    const msg = String(e && e.message || e);
    const skipped = /no wgpu adapter|SOFTWARE device/i.test(msg) && force === "gpu";
    console.log(`RESULT ${skipped ? "SKIP" : "FAIL"} ${kind}/${force} export: ${msg.slice(0, 160)}`);
    process.exit(skipped ? 0 : 1);
  });
  return;
}

// ── parent mode: build fixtures, spawn children ────────────────────────────
function sh(cmd, args) {
  const r = spawnSync(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || r.stdout || "").toString().slice(-400)}`);
}

const img = path.join(MEDIA, "orient.png");
if (!fs.existsSync(img)) {
  const half = path.join(MEDIA, "half");
  sh(FFMPEG, ["-y", "-f", "lavfi", "-i", "color=c=red:size=320x90", "-frames:v", "1", half + "-r.png"]);
  sh(FFMPEG, ["-y", "-f", "lavfi", "-i", "color=c=blue:size=320x90", "-frames:v", "1", half + "-b.png"]);
  sh(FFMPEG, ["-y", "-i", half + "-r.png", "-i", half + "-b.png", "-filter_complex", "vstack", img]);
}
const vid = path.join(MEDIA, "orient.mp4");
if (!fs.existsSync(vid)) {
  sh(FFMPEG, ["-y", "-f", "lavfi", "-i", "color=c=red:size=320x90:r=10", "-f", "lavfi", "-i", "color=c=blue:size=320x90:r=10", "-filter_complex", "vstack=inputs=2", "-t", "1", "-pix_fmt", "yuv420p", vid]);
}

(async () => {
  let allOk = true;
  for (const force of ["cpu", "gpu"]) {
    for (const kind of ["image", "image+cap", "video"]) {
      const env = Object.assign({}, process.env, {
        FRAMEFUSE_FORCE_COMPOSITOR: force,
        // allow llvmpipe/WARP on machines without a real GPU adapter so the
        // GPU-path checks still run everywhere (CI does the same)
        FRAMEFUSE_ENGINE_ALLOW_SOFTWARE_GPU: "1",
        ORIENT_CASE: kind,
      });
      const r = spawnSync(process.execPath, [__filename], { env, timeout: 180000 });
      const out = (r.stdout || "").toString().trim().split("\n").filter((l) => l.startsWith("RESULT"));
      const line = out[0] || `RESULT FAIL ${kind}/${force} child crashed: ${(r.stderr || "").toString().slice(-300)}`;
      console.log(line);
      if (r.status !== 0) allOk = false;
    }
  }
  console.log(allOk ? "ORIENTATION: ALL PASS" : "ORIENTATION: FAILURES");
  process.exit(allOk ? 0 : 1);
})();
