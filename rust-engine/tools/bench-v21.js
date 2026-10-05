// FrameFuse Rust engine — v2.1 optimization benchmark (Linux sandbox).
// Runs the same kind of timeline as the smoke test but BIGGER (1280×720,
// 300 frames) so per-frame allocation/pooling effects are visible in
// compositorMs / decodeMs / durationMs. Two scenarios:
//   match  — 30fps source → 30fps output (no frame-hold reuse)
//   hold   — 20fps source → 30fps output (1/3 of output frames re-use the
//            previous decoded frame — exercises the held-frame cache)
// Each scenario runs TWICE (labels #1/#2); the row prints the compositor
// that ACTUALLY ran (this sandbox has no Vulkan ICD → rust-cpu; on a GPU
// box it reports rust-gpu).
// Usage: node tools/bench-v21.js [match|hold|both]   (default both)
"use strict";
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

const engine = require(path.join(__dirname, "..", "index.js"));
if (!engine.available()) {
  console.error("ENGINE NOT AVAILABLE:", engine.loadError());
  process.exit(1);
}

const MEDIA = "/tmp/ffbench";
fs.mkdirSync(MEDIA, { recursive: true });
const SRC_FPS = 30;
const RUNS = Number(process.env.BENCH_RUNS || 3);

function ensureFixture(name, args) {
  const p = path.join(MEDIA, name);
  if (!fs.existsSync(p)) {
    execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args, p], { stdio: "inherit" });
  }
  return p;
}

function fixtures(fps) {
  const video = ensureFixture(`src_${fps}.mp4`, [
    "-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=${fps}`,
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "10",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-c:a", "aac",
  ]);
  const image = ensureFixture("img.png", [
    "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=1", "-frames:v", "1",
  ]);
  const music = ensureFixture("music.m4a", [
    "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000", "-t", "11", "-c:a", "aac", "-b:a", "96k",
  ]);
  return { video, image, music };
}

function timeline(fx) {
  return {
    version: 1,
    width: 1280,
    height: 720,
    fps: 30,
    sampleRate: 48000,
    audioChannels: 2,
    bitrateMbps: 6,
    crf: 23,
    quality: "social",
    audioKbps: 128,
    backgroundColor: "#101010",
    totalMs: 10000,
    fonts: { sans: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" },
    segments: [
      {
        id: "s1", mediaType: "video", path: fx.video,
        startMs: 0, endMs: 7000, durationMs: 7000, trimInMs: 0, speed: 1.0,
        track: 0, volume: 0.9, sourceDurationMs: 10000, hasAudio: true,
        kenBurns: { enabled: false, direction: "in", zoomMax: 1.12 },
      },
      {
        id: "s2", mediaType: "image", path: fx.image,
        startMs: 7000, endMs: 10000, durationMs: 3000, trimInMs: 0, speed: 1.0,
        track: 0, volume: 0.0, sourceDurationMs: 3000, hasAudio: false,
        kenBurns: { enabled: true, direction: "in", zoomMax: 1.15 },
      },
    ],
    music: { path: fx.music, volume: 0.35, startMs: 0, fadeMs: 400, loop: false },
    texts: [
      {
        text: "FrameFuse 1280x720 benchmark", startMs: 200, endMs: 6800, font: "sans",
        size: 44, color: "#ffffff", outlineColor: "#000000", position: "top", x: 0.5, fadeMs: 250,
      },
    ],
    watermark: null,
  };
}

async function runScenario(name, fx, runIdx) {
  const out = path.join(MEDIA, `out_${name}_${runIdx}.mp4`);
  const tl = timeline(fx);
  const results = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = Date.now();
    const res = await engine.exportVideo(JSON.stringify(tl), out, "", () => {});
    results.push({ ...res, wall: Date.now() - t0 });
  }
  const med = (sel) => {
    const v = results.map(sel).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  const fmt = (sel) => String(med(sel)).padStart(7);
  console.log(
    `${name.padEnd(5)} #${runIdx}   wall${fmt((r) => r.wall)}ms  total${fmt((r) => r.durationMs)}ms` +
      `  comp${fmt((r) => r.compositorMs)}ms  enc${fmt((r) => r.encodeMs)}ms  dec${fmt((r) => r.decodeMs)}ms` +
      `  audio${fmt((r) => r.audioMs)}ms  engine=${results[0].engineUsed}`
  );
  // sanity: frame count must be exact
  const probe = JSON.parse(execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=nb_read_frames", "-of", "json", out,
  ], { encoding: "utf8" }));
  const frames = Number(probe.streams[0].nb_read_frames);
  if (frames !== 300) {
    console.error(`  FRAME COUNT MISMATCH: ${frames} != 300`);
    process.exitCode = 1;
  } else {
    console.log(`  frames ok (${frames})`);
  }
}

(async () => {
  const which = process.argv[2] || "both";
  const scenarios = which === "both" ? ["match", "hold"] : [which];
  for (const s of scenarios) {
    const fx = fixtures(s === "match" ? 30 : 20);
    await runScenario(s, fx, 1);
    await runScenario(s, fx, 2);
  }
})();
