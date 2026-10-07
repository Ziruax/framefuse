// FrameFuse Rust engine — Node smoke test (Linux sandbox, CPU path expected).
// Milestone: require → exportVideo → real MP4 verified with ffprobe.
const path = require("path");
const { execFileSync } = require("child_process");

const engine = require(path.join(__dirname, "..", "index.js"));
if (!engine.available()) {
  console.error("ENGINE NOT AVAILABLE:", engine.loadError());
  process.exit(1);
}
console.log("engine version:", engine.engineVersion());
console.log("ffmpeg family:", engine.probeFfmpegFamily(""));

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
  totalMs: 5000,
  fonts: { sans: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" },
  segments: [
    {
      id: "s1",
      mediaType: "video",
      path: "/tmp/fftest/src_video.mp4",
      startMs: 0,
      endMs: 3000,
      durationMs: 3000,
      trimInMs: 500,
      speed: 1.0,
      track: 0,
      volume: 0.9,
      sourceDurationMs: 4000,
      hasAudio: true,
      kenBurns: { enabled: false, direction: "in", zoomMax: 1.12 },
    },
    {
      id: "s2",
      mediaType: "image",
      path: "/tmp/fftest/src_image.png",
      startMs: 3000,
      endMs: 5000,
      durationMs: 2000,
      trimInMs: 0,
      speed: 1.0,
      track: 0,
      volume: 1.0,
      hasAudio: false,
      kenBurns: { enabled: true, direction: "in", zoomMax: 1.15 },
    },
  ],
  music: {
    path: "/tmp/fftest/music.m4a",
    volume: 0.35,
    startMs: 0,
    fadeMs: 400,
    loop: false,
  },
  texts: [
    {
      text: "FrameFuse Rust Engine",
      startMs: 200,
      endMs: 2800,
      font: "sans",
      size: 44,
      color: "#ffffff",
      outlineColor: "#000000",
      position: "top",
      x: 0.5,
      fadeMs: 250,
    },
    {
      text: "CPU fallback works!",
      startMs: 3200,
      endMs: 4900,
      font: "sans",
      size: 36,
      color: "#ffe066",
      outlineColor: "#202020",
      position: "bottom",
      x: 0.5,
      fadeMs: 250,
    },
  ],
  watermark: null,
};

let lastPhase = "";
const events = [];
const t0 = Date.now();
engine
  .exportVideo(JSON.stringify(timeline), "/tmp/fftest/out_rust.mp4", "", (err, p) => {
    if (err) {
      console.error("progress callback error:", err);
      return;
    }
    if (!p) return;
    if (p.phase !== lastPhase || p.percent - (events[events.length - 1]?.percent || 0) > 25) {
      lastPhase = p.phase;
      events.push({ phase: p.phase, percent: p.percent, fps: p.fps, rate: p.rate });
      console.log(
        `progress: phase=${p.phase} percent=${p.percent.toFixed(1)} fps=${p.fps.toFixed(1)} rate=${p.rate ?? "-"}x`
      );
    }
  })
  .then((res) => {
    console.log("=== RESULT ===");
    console.log(JSON.stringify(res, null, 2));
    // verify output with ffprobe
    const probe = execFileSync(
      "ffprobe",
      [
        "-v", "error",
        "-select_streams", "v:0",
        "-count_frames",
        "-show_entries", "stream=codec_name,width,height,r_frame_rate,nb_read_frames:format=duration,size",
        "-of", "json",
        "/tmp/fftest/out_rust.mp4",
      ],
      { encoding: "utf8" }
    );
    console.log("=== FFPROBE ===");
    console.log(probe);
    const audio = execFileSync(
      "ffprobe",
      [
        "-v", "error",
        "-select_streams", "a:0",
        "-show_entries", "stream=codec_name,sample_rate,channels:format=duration",
        "-of", "json",
        "/tmp/fftest/out_rust.mp4",
      ],
      { encoding: "utf8" }
    );
    console.log("=== AUDIO STREAM ===");
    console.log(audio);
    console.log("wall time:", ((Date.now() - t0) / 1000).toFixed(2) + "s");
  })
  .catch((err) => {
    console.error("EXPORT FAILED:", err && err.message ? err.message : err);
    process.exit(1);
  });
