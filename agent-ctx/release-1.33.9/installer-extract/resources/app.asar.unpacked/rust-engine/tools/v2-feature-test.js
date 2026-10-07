// v2 feature verification — transitions (dissolve + dips + bookends) and
// extra audio (voiceover/SFX tracks) through the NATIVE engine, plus a
// luma-profile check that the fades actually modulate the picture.
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
  : path.join(os.tmpdir(), "fftest-v2");
const OUT = path.join(MEDIA, "out_v2.mp4");
fs.mkdirSync(MEDIA, { recursive: true });

function runFF(args, label) {
  const r = spawnSync(FFMPEG, args, { timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    console.error("ffmpeg failed:", label, String(r.stderr || "").slice(-500));
    process.exit(1);
  }
}

// fixtures: 2 bright contrasting images + a 1kHz tone "voiceover" mp3 + music
const imgA = path.join(MEDIA, "a.png");
const imgB = path.join(MEDIA, "b.png");
const vo = path.join(MEDIA, "vo.mp3");
if (!fs.existsSync(imgA)) runFF(["-y", "-f", "lavfi", "-i", "color=c=red:size=640x360", "-frames:v", "1", imgA], "imgA");
if (!fs.existsSync(imgB)) runFF(["-y", "-f", "lavfi", "-i", "color=c=blue:size=640x360", "-frames:v", "1", imgB], "imgB");
if (!fs.existsSync(vo)) runFF(["-y", "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=24000", "-ac", "1", "-t", "2", "-c:a", "libmp3lame", "-b:a", "48k", vo], "vo");

const timeline = {
  version: 1,
  width: 640,
  height: 360,
  fps: 30,
  sampleRate: 48000,
  audioChannels: 2,
  bitrateMbps: 4,
  crf: 23,
  quality: "social",
  audioKbps: 128,
  backgroundColor: "#101010",
  totalMs: 6000,
  fonts: { sans: FONT },
  segments: [
    {
      id: "s1", mediaType: "image", path: imgA,
      startMs: 0, endMs: 3000, durationMs: 3000, trimInMs: 0, speed: 1, track: 0,
      volume: 1, hasAudio: false,
      kenBurns: { enabled: true, direction: "in", zoomMax: 1.15 },
      bookendStartMs: 500,
    },
    {
      id: "s2", mediaType: "image", path: imgB,
      startMs: 3000, endMs: 6000, durationMs: 3000, trimInMs: 0, speed: 1, track: 0,
      volume: 1, hasAudio: false,
      kenBurns: { enabled: true, direction: "in", zoomMax: 1.15 },
      // dissolve IN over s1's tail + dip out at the very end + bookend end
      transHeadMs: 600, transHeadStyle: "dissolve",
      transTailMs: 600, transTailStyle: "dip-black",
      bookendEndMs: 500,
    },
  ],
  music: null,
  extraAudio: [
    { path: vo, startMs: 2000, volume: 1.0 }, // "voiceover" at 2s
  ],
  texts: [],
  watermark: null,
};

const engine = require(path.join(ROOT, "rust-engine", "index.js"));
if (!engine.available()) {
  console.error("engine unavailable:", engine.loadError());
  process.exit(1);
}
const FFMPEG_DIR = process.env.FF_ENGINE_FFMPEG_DIR !== undefined
  ? process.env.FF_ENGINE_FFMPEG_DIR
  : IS_WIN
    ? path.join(ROOT, "resources", "ffmpeg", "win", "dll")
    : "";

engine
  .exportVideo(JSON.stringify(timeline), OUT, FFMPEG_DIR, (err, p) => { if (p && p.phase === "done") console.log("progress done"); })
  .then((res) => {
    console.log("result:", JSON.stringify({ success: res.success, engine: res.engineUsed, encoder: res.encoderName, frames: res.frames, audioMs: res.audioMs, wall: res.durationMs }));

    // luma profile: frame 5 (bookend, ~almost black), frame 45 (mid A),
    // frame 105 (dissolve B ramping), frame 178 (dip tail ~dark) — raw GRAY
    // decode (portable; no lavfi movie-filter path quirks on Windows).
    const gray = spawnSync(FFMPEG, [
      "-v", "error", "-i", OUT, "-f", "rawvideo", "-pix_fmt", "gray", "-",
    ], { timeout: 120000, maxBuffer: 256 * 1024 * 1024 });
    const W = 640, H = 360, FB = W * H;
    const nFrames = gray.stdout ? Math.floor(gray.stdout.length / FB) : 0;
    const y = [];
    for (let i = 0; i < nFrames; i++) {
      let sum = 0;
      for (let b = i * FB; b < (i + 1) * FB; b++) sum += gray.stdout[b];
      y.push(sum / FB);
    }
    const at = (i) => y[i];
    console.log("YAVG f5=" + at(5) + " f45=" + at(45) + " f92=" + at(92) + " f105=" + at(105) + " f178=" + at(178));
    const checks = [
      ["bookend fade-in (f5 dark)", at(5) < at(45) * 0.6],
      ["dissolve head engaged (f92 near A, not pure B)", at(92) > at(45) * 0.75],
      ["dip tail fades (f178 dark)", at(178) < at(150) * 0.7],
      ["full frame count", y.length >= 170 && y.length <= 190],
    ];
    // audio: the VO tone at 2s must be present (volume probe)
    const vol = spawnSync(FFMPEG, ["-i", OUT, "-af", "volumedetect", "-f", "null", "-"],
      { encoding: "utf8", timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
    const mv = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(String(vol.stderr || ""));
    const meanDb = mv ? parseFloat(mv[1]) : -Infinity;
    console.log("audio mean_volume:", meanDb, "dB");
    checks.push(["extra audio (voiceover tone) present in the mix", meanDb > -55]);

    let failed = 0;
    for (const [label, ok] of checks) {
      console.log((ok ? "  ok  " : "  FAIL ") + label);
      if (!ok) failed++;
    }
    if (failed) { console.error(failed + " check(s) FAILED"); process.exit(1); }
    console.log("V2 FEATURE TEST PASSED");
  })
  .catch((e) => { console.error("export failed:", e && e.message); process.exit(1); });
