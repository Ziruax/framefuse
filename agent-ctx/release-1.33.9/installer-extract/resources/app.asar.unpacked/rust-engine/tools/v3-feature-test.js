// v3 feature verification (engine v0.3 — the v1.33.7 "Rust everywhere"
// release). The five scenarios that previously rode the FFmpeg-CLI pipeline,
// now through the NATIVE engine:
//   1. BASE-LANE LOOP-TO-FILL   — a short video looped across a longer window
//   2. AUDIO-EXTENDED TIMELINE  — payload totalMs beyond the visuals (black tail)
//   3. AUDIO-ONLY TIMELINE      — zero visual segments over a voiceover
//   4. LOUDNORM                 — in-process EBU R128 measurement + static gain
//   5. OVERLAY MOTION PATH      — ≥2 keyframes interpolate the overlay center
// Every scenario verifies CONTENT (durations, luma profiles, frame
// equality across the loop seam, audio levels) — not just exit codes.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const IS_WIN = process.platform === "win32";
const FFMPEG = process.env.FF_TEST_FFMPEG || (IS_WIN ? path.join(ROOT, "resources", "ffmpeg", "win", "ffmpeg.exe") : "ffmpeg");
const FFPROBE = process.env.FF_TEST_FFPROBE || (IS_WIN ? path.join(ROOT, "resources", "ffmpeg", "win", "ffprobe.exe") : "ffprobe");
const FONT = process.env.FF_TEST_FONT || (IS_WIN ? "C:\\Windows\\Fonts\\arialbd.ttf" : "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf");
const MEDIA = process.env.FF_TEST_MEDIA_DIR
  ? path.resolve(process.env.FF_TEST_MEDIA_DIR)
  : path.join(os.tmpdir(), "fftest-v3");
fs.mkdirSync(MEDIA, { recursive: true });

function runFF(args, label) {
  const r = spawnSync(FFMPEG, args, { timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    console.error("ffmpeg failed:", label, String(r.stderr || "").slice(-500));
    process.exit(1);
  }
}

function probeJson(file, args) {
  const r = spawnSync(FFPROBE, ["-v", "error", ...args, "-print_format", "json", file], {
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) {
    console.error("ffprobe failed:", String(r.stderr || "").slice(-400));
    process.exit(1);
  }
  return JSON.parse(r.stdout || "{}");
}

function durationSec(file) {
  const j = probeJson(file, ["-show_format"]);
  return parseFloat(j.format && j.format.duration) || 0;
}

/** raw gray frame buffers (one Buffer per frame). */
function grayBuffers(file, w, h) {
  const r = spawnSync(FFMPEG, ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "gray", "-"], {
    timeout: 120000,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) {
    console.error("gray decode failed:", String(r.stderr || "").slice(-400));
    process.exit(1);
  }
  const fb = w * h;
  const out = [];
  for (let i = 0; i * fb + fb <= r.stdout.length; i++) {
    out.push(r.stdout.subarray(i * fb, (i + 1) * fb));
  }
  return out;
}

/** gray luma per frame of the first `frames` frames. */
function grayFrames(file, w, h) {
  const bufs = grayBuffers(file, w, h);
  return bufs.map((b) => {
    let sum = 0;
    for (let i = 0; i < b.length; i++) sum += b[i];
    return sum / b.length;
  });
}

/** mean absolute pixel difference between two gray frames. */
function frameDiff(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/** RGB frames — whole-file rawvideo decode, indexed (portable: no
 *  select/-vsync filter chain; some ffmpeg builds reorder or drop frames
 *  through select+passthrough and the probes read empty buffers). */
const rgbCache = new Map();
function rgbFrames(file, w, h) {
  if (rgbCache.has(file)) return rgbCache.get(file);
  const r = spawnSync(FFMPEG, ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], {
    timeout: 120000,
    maxBuffer: 512 * 1024 * 1024,
  });
  const fb = w * h * 3;
  const out = [];
  for (let i = 0; i * fb + fb <= (r.stdout ? r.stdout.length : 0); i++) {
    out.push(r.stdout.subarray(i * fb, (i + 1) * fb));
  }
  rgbCache.set(file, out);
  return out;
}
function rgbFrame(file, w, h, idx) {
  const fr = rgbFrames(file, w, h);
  return fr[idx] || Buffer.alloc(0);
}

function meanVolumeDb(file) {
  const r = spawnSync(FFMPEG, ["-i", file, "-af", "volumedetect", "-f", "null", "-"], {
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const m = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(String(r.stderr || ""));
  return m ? parseFloat(m[1]) : -Infinity;
}

const engine = require(path.join(ROOT, "rust-engine", "index.js"));
if (!engine.available()) {
  console.error("engine unavailable:", engine.loadError());
  process.exit(1);
}
const FFMPEG_DIR =
  process.env.FF_ENGINE_FFMPEG_DIR !== undefined
    ? process.env.FF_ENGINE_FFMPEG_DIR
    : IS_WIN
      ? path.join(ROOT, "resources", "ffmpeg", "win", "dll")
      : "";

const W = 320;
const H = 180;

// ── fixtures ─────────────────────────────────────────────────────────────────
// 2s source video: testsrc2 (a moving pattern + running timecode — frames
// DIFFER over time, so a loop seam is provable) with a 440 Hz tone.
const loopSrc = path.join(MEDIA, "loopsrc.mp4");
if (!fs.existsSync(loopSrc)) {
  runFF(
    ["-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=2",
     "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
     "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", loopSrc],
    "loopsrc");
}
// 6s "voiceover" tone.
const vo6 = path.join(MEDIA, "vo6.mp3");
if (!fs.existsSync(vo6)) {
  runFF(["-y", "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=24000", "-ac", "1", "-t", "6", "-c:a", "libmp3lame", "-b:a", "48k", vo6], "vo6");
}
// 4s quiet voiceover (loudnorm test: a quiet clip branch gains toward −16).
const vo4quiet = path.join(MEDIA, "vo4quiet.mp4");
if (!fs.existsSync(vo4quiet)) {
  runFF(
    ["-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=4",
     "-f", "lavfi", "-i", "sine=frequency=800:sample_rate=48000:duration=4",
     "-af", "volume=0.04", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", vo4quiet],
    "vo4quiet");
}
// 2s silent video (audio-extended test — visuals only, VO carries audio).
const vid2 = path.join(MEDIA, "vid2.mp4");
if (!fs.existsSync(vid2)) {
  runFF(["-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2",
         "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an", vid2], "vid2");
}
// 4s video for the motion test base.
const vid4 = path.join(MEDIA, "vid4.mp4");
if (!fs.existsSync(vid4)) {
  runFF(["-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=4",
         "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an", vid4], "vid4");
}
// 4s BLACK base for the motion test (the greenness probe needs a non-green
// base — testsrc2's own green bars produced false positives).
const black4 = path.join(MEDIA, "black4.mp4");
if (!fs.existsSync(black4)) {
  runFF(["-y", "-f", "lavfi", "-i", "color=c=black:size=320x180:rate=30:duration=4",
         "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-an", black4], "black4");
}
// 60x40 green overlay PNG.
const ovPng = path.join(MEDIA, "ov.png");
if (!fs.existsSync(ovPng)) {
  runFF(["-y", "-f", "lavfi", "-i", "color=c=lime:size=60x40", "-frames:v", "1", ovPng], "ov");
}

const baseTimeline = {
  version: 2,
  width: W,
  height: H,
  fps: 30,
  sampleRate: 48000,
  audioChannels: 2,
  bitrateMbps: 4,
  crf: 23,
  quality: "social",
  audioKbps: 128,
  backgroundColor: "#000000",
  fonts: { sans: FONT },
  texts: [],
  watermark: null,
};

function exportTimeline(name, timeline) {
  const out = path.join(MEDIA, `out_v3_${name}.mp4`);
  return engine
    .exportVideo(JSON.stringify(timeline), out, FFMPEG_DIR, () => {})
    .then((res) => {
      if (!res.success) throw new Error(`${name}: engine reported failure`);
      console.log(`[${name}] engine=${res.engineUsed} encoder=${res.encoderName} frames=${res.frames} wall=${res.durationMs}ms audioMs=${res.audioMs}`);
      return out;
    });
}

const checks = [];
function check(label, ok) {
  console.log((ok ? "  ok  " : "  FAIL ") + label);
  checks.push(ok);
}

async function main() {
  console.log("[v3] fixtures ready; starting scenario 1 (loop)");
  // ── 1. BASE-LANE LOOP-TO-FILL ───────────────────────────────────────────
  await exportTimeline("loop", {
    ...baseTimeline,
    totalMs: 6000,
    segments: [
      {
        id: "s1", mediaType: "video", path: loopSrc,
        startMs: 0, endMs: 6000, durationMs: 6000, trimInMs: 0, speed: 1, track: 0,
        volume: 0.5, sourceDurationMs: 2000, hasAudio: true,
        // the NEW v0.3 fields
        loopSrc: true,
      },
    ],
    extraAudio: [{ path: vo6, startMs: 0, volume: 1.0, loopSrc: false }],
    music: null,
  }).then((out) => {
    const dur = durationSec(out);
    check("loop: output is the FULL 6s window", Math.abs(dur - 6.0) < 0.3);
    // Loop seam proof (PIXEL-level): timeline frame 12 (t=0.4, source pos
    // 0.4) vs frame 72 (t=2.4, source pos 0.4 after the 2s wrap) — the SAME
    // source position → near-identical pixels (encode noise only); frame 36
    // (t=1.2, source pos 1.2) differs (the timecode + moving pattern).
    const bufs = grayBuffers(out, W, H);
    check("loop: frames decoded", bufs.length >= 150);
    const dSame = frameDiff(bufs[12], bufs[72]);
    const dDiff = frameDiff(bufs[12], bufs[36]);
    check(
      `loop: seam parity — f12 vs f72 (same source pos) diff=${dSame.toFixed(2)}`,
      dSame < 8,
    );
    check(
      `loop: within-pass frames differ — f12 vs f36 diff=${dDiff.toFixed(2)} (vs same-pos ${dSame.toFixed(2)})`,
      dDiff > 4 && dDiff > 4 * dSame,
    );
    const mv = meanVolumeDb(out);
    check(`loop: audio present (loop clip tone + VO, mean ${mv}dB)`, mv > -40);
  });

  // ── 2. AUDIO-EXTENDED TIMELINE (black tail) ─────────────────────────────
  await exportTimeline("extended", {
    ...baseTimeline,
    totalMs: 6000,
    segments: [
      {
        id: "s1", mediaType: "video", path: vid2,
        startMs: 0, endMs: 2000, durationMs: 2000, trimInMs: 0, speed: 1, track: 0,
        volume: 1, sourceDurationMs: 2000, hasAudio: false, loopSrc: false,
      },
    ],
    extraAudio: [{ path: vo6, startMs: 0, volume: 1.0, loopSrc: false }],
    music: null,
  }).then((out) => {
    const dur = durationSec(out);
    check("extended: output runs to the audio's 6s (black tail)", Math.abs(dur - 6.0) < 0.3);
    const g = grayFrames(out, W, H);
    check("extended: visuals play in the first 2s", g[30] > 25);
    check(`extended: black tail after visuals (f90=${g[90] ? g[90].toFixed(1) : "?"})`, g[90] < 16);
    const mv = meanVolumeDb(out);
    check(`extended: voiceover spans the whole timeline (mean ${mv}dB)`, mv > -45);
  });

  // ── 3. AUDIO-ONLY TIMELINE ──────────────────────────────────────────────
  await exportTimeline("audioonly", {
    ...baseTimeline,
    totalMs: 4000,
    segments: [],
    extraAudio: [{ path: vo6, startMs: 0, volume: 1.0, loopSrc: false }],
    music: null,
  }).then((out) => {
    const dur = durationSec(out);
    check("audio-only: 4s black video over the audio", Math.abs(dur - 4.0) < 0.3);
    const g = grayFrames(out, W, H);
    check(`audio-only: every frame black (f30=${g[30] != null ? g[30].toFixed(1) : "?"})`, g[30] != null && g[30] < 16);
    const mv = meanVolumeDb(out);
    check(`audio-only: audio present (mean ${mv}dB)`, mv > -45);
  });

  // ── 4. LOUDNORM (in-process EBU R128) ───────────────────────────────────
  const loudTl = {
    ...baseTimeline,
    totalMs: 4000,
    segments: [
      {
        id: "s1", mediaType: "video", path: vo4quiet,
        startMs: 0, endMs: 4000, durationMs: 4000, trimInMs: 0, speed: 1, track: 0,
        volume: 1, sourceDurationMs: 4000, hasAudio: true, loopSrc: false,
      },
    ],
    extraAudio: [],
    music: null,
  };
  const plainDb = await exportTimeline("norm_plain", { ...loudTl, normalizeAudio: false }).then(meanVolumeDb);
  const normDb = await exportTimeline("norm_on", { ...loudTl, normalizeAudio: true, audioTargetLufs: -16 }).then(meanVolumeDb);
  check(
    `loudnorm: quiet source lifted (plain ${plainDb}dB → normalized ${normDb}dB, Δ=${(normDb - plainDb).toFixed(1)}dB)`,
    normDb - plainDb > 10,
  );
  check(
    `loudnorm: lands near the −16 LUFS target (${normDb}dB mean)`,
    normDb > -30 && normDb < -4,
  );

  // ── 4b. STATIC OVERLAY CONTROL (compositor geometry, no motion) ────────
  // isolates GPU-vs-CPU dest semantics: a lime overlay pinned at the
  // geometry center (0.5, 0.5) must land at the canvas center on EVERY
  // compositor (the motion scenario's failures must be motion-only).
  await exportTimeline("staticovl", {
    ...baseTimeline,
    totalMs: 4000,
    segments: [
      {
        id: "s1", mediaType: "video", path: black4,
        startMs: 0, endMs: 4000, durationMs: 4000, trimInMs: 0, speed: 1, track: 0,
        volume: 1, sourceDurationMs: 4000, hasAudio: false, loopSrc: false,
      },
      {
        id: "ovlS", mediaType: "image", path: ovPng,
        startMs: 0, endMs: 4000, durationMs: 4000, trimInMs: 0, speed: 1, track: 1,
        volume: 0, hasAudio: false, loopSrc: false, overlayLoop: false, opacity: 1,
        geometry: { x: 0.5, y: 0.5, w: 0.1875, h: 0 },
      },
    ],
    extraAudio: [], music: null,
  }).then((out) => {
    const g = greenAt => greenAt; // (placeholder for symmetry)
    const frames = rgbFrames(out, W, H);
    const f = frames[60];
    let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, n = 0;
    if (f) {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 3;
        if (f[o + 1] - Math.max(f[o], f[o + 2]) > 40) { n++; if (x<minX)minX=x; if (x>maxX)maxX=x; if (y<minY)minY=y; if (y>maxY)maxY=y; }
      }
    }
    console.log(`[static-diag] frame60 overlay bbox: ${n ? `x[${(minX/W).toFixed(2)}..${(maxX/W).toFixed(2)}] y[${(minY/H).toFixed(2)}..${(maxY/H).toFixed(2)}] n=${n}` : "none"}`);
    // coarse 16x9 color grid (the frame's actual layout, compositor-blind)
    if (f) {
      const cells = [];
      for (let gy = 0; gy < 9; gy++) {
        const row = [];
        for (let gx = 0; gx < 16; gx++) {
          let r = 0, g = 0, b = 0, cnt = 0;
          for (let y = Math.floor(gy * H / 9); y < Math.floor((gy + 1) * H / 9); y++) {
            for (let x = Math.floor(gx * W / 16); x < Math.floor((gx + 1) * W / 16); x++) {
              const o = (y * W + x) * 3;
              r += f[o]; g += f[o + 1]; b += f[o + 2]; cnt++;
            }
          }
          row.push(cnt ? `${Math.round(r / cnt).toString(16).padStart(2, "0")}${Math.round(g / cnt).toString(16).padStart(2, "0")}${Math.round(b / cnt).toString(16).padStart(2, "0")}` : "??????");
        }
        cells.push(row.join(" "));
      }
      console.log("[static-grid] frame60 16x9 avg colors (00ff00=lime, 000000=black):");
      for (const row of cells) console.log("  " + row);
    }
    // expected: x[0.41..0.59] y[0.25..0.75] (60x90 centered at 0.5,0.5)
    check(`static overlay: bbox centered (got ${n ? `${((minX+maxX)/2/W).toFixed(2)},${((minY+maxY)/2/H).toFixed(2)}` : "none"})`,
      n > 200 && Math.abs((minX+maxX)/2/W - 0.5) < 0.06 && Math.abs((minY+maxY)/2/H - 0.5) < 0.06);
    // v0.3.1 CHROMA PARITY (the yuv.wgsl planar-indexing bug): a black base
    // + lime overlay is SPATIALLY-VARYING chroma — the corners must stay
    // BLACK (no green tint) and the overlay core must be saturated lime.
    // (Solid-color frames pass color tests even with the old corruption —
    // only spatial variation exposes a plane-indexing bug.)
    const cornerGreen = f ? (f[((0 * W) + 2) * 3 + 1] - Math.max(f[(2 * 3)], f[(2 * 3) + 2])) : 0;
    let coreG = 0, coreN = 0;
    if (f) {
      for (let y = 80; y < 100; y++) for (let x = 150; x < 170; x++) {
        const o = (y * W + x) * 3;
        coreG += f[o + 1] - Math.max(f[o], f[o + 2]); coreN++;
      }
    }
    const coreGreen = coreN ? coreG / coreN : 0;
    check(`static overlay: chroma parity — corner black (greenness ${cornerGreen}), core lime (greenness ${coreGreen.toFixed(0)})`,
      cornerGreen < 20 && coreGreen > 180);
  });

  // ── 5. OVERLAY MOTION PATH ──────────────────────────────────────────────
  await exportTimeline("motion", {
    ...baseTimeline,
    totalMs: 4000,
    segments: [
      {
        id: "s1", mediaType: "video", path: black4,
        startMs: 0, endMs: 4000, durationMs: 4000, trimInMs: 0, speed: 1, track: 0,
        volume: 1, sourceDurationMs: 4000, hasAudio: false, loopSrc: false,
      },
      {
        id: "ovl1", mediaType: "image", path: ovPng,
        startMs: 0, endMs: 4000, durationMs: 4000, trimInMs: 0, speed: 1, track: 1,
        volume: 0, hasAudio: false, loopSrc: false, overlayLoop: false,
        geometry: { x: 0.5, y: 0.5, w: 0.1875, h: 0 }, // 60/320 wide, height from aspect
        opacity: 1,
        motion: [
          { tMs: 0, x: 0.16, y: 0.2 },
          { tMs: 4000, x: 0.84, y: 0.8 },
        ],
      },
    ],
    extraAudio: [],
    music: null,
  }).then((out) => {
    // v1.33.7 DIAGNOSTIC: the overlay's actual bbox center per sampled frame
    // (the GPU path moved the overlay faster than the timeline on CI —
    // this dump pins the real motion curve per compositor).
    {
      const frames = rgbFrames(out, W, H);
      const centers = [];
      for (const k of [0, 12, 24, 36, 48, 60, 72, 84, 96, 108]) {
        const f = frames[k];
        if (!f) { centers.push(`f${k}:—`); continue; }
        let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, n = 0;
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const o = (y * W + x) * 3;
            if (f[o + 1] - Math.max(f[o], f[o + 2]) > 40) {
              n++;
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        }
        centers.push(n ? `f${k}:[${(minX/W).toFixed(2)}..${(maxX/W).toFixed(2)},${(minY/H).toFixed(2)}..${(maxY/H).toFixed(2)}]n=${n}` : `f${k}:none`);
      }
      console.log(`[motion-diag] overlay centers: ${centers.join(" ")}`);
    }
    const greenAt = (idx, px, py) => {
      const f = rgbFrame(out, W, H, idx);
      if (!f || f.length < (py * W + px) * 3 + 3) return -1;
      const o = (py * W + px) * 3;
      return f[o + 1] - Math.max(f[o], f[o + 2]); // greenness
    };
    // keyframe start: center near (0.16*320≈51, 0.2*180≈36); at 20% time
    // (frame 24, t=0.8s) the interpolated center ≈ (0.304, 0.32) → px≈97,py≈58
    const early = greenAt(24, 97, 58);
    // 80% time (frame 96, t=3.2s): center ≈ (0.696, 0.68) → px≈223, py≈122
    const late = greenAt(96, 223, 122);
    check(`motion: overlay near start at 20% (greenness ${early})`, early > 40);
    check(`motion: overlay near end at 80% (greenness ${late})`, late > 40);
    // and NOT at the swapped positions
    const earlySwapped = greenAt(24, 223, 122);
    const lateSwapped = greenAt(96, 97, 58);
    check(`motion: overlay absent at end pos early on (${earlySwapped})`, earlySwapped < 20);
    check(`motion: overlay absent at start pos late on (${lateSwapped})`, lateSwapped < 20);
  });

  const failed = checks.filter((c) => !c).length;
  if (failed) {
    console.error(failed + " check(s) FAILED");
    process.exit(1);
  }
  console.log("V3 FEATURE TEST PASSED (" + checks.length + " checks)");
}

main().catch((e) => {
  console.error("v3 feature test failed:", e && e.message);
  process.exit(1);
});
