// GPU-YUV color debug — one solid-color image through the engine; probe the
// output's YUV pixel values at the center. Expected (BT.601 limited):
//   red    → Y≈81,  U≈90,  V≈240
//   green  → Y≈145, U≈54,  V≈34
//   blue   → Y≈41,  U≈240, V≈110
//   white  → Y≈235, U≈128, V≈128
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const MEDIA = path.join(os.tmpdir(), "fftest-yuv");
fs.mkdirSync(MEDIA, { recursive: true });

const color = process.env.YUV_TEST_COLOR || "red";
// ffmpeg color names are the CSS half-brightness set: green=(0,128,0).
// Expected values = the BT.601 limited-range matrix the shader implements
// (verified: red/blue/white are exact; green derives from (0,128,0)).
const expect = {
  red: [81, 90, 240], green: [81, 90, 80], blue: [41, 240, 110], white: [235, 128, 128],
}[color];

const img = path.join(MEDIA, color + ".png");
const out = path.join(MEDIA, "out_" + color + ".mp4");
if (!fs.existsSync(img)) {
  const r = spawnSync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=" + color + ":size=320x180", "-frames:v", "1", img]);
  if (r.status !== 0) { console.error("fixture failed"); process.exit(1); }
}

const timeline = {
  version: 1, width: 320, height: 180, fps: 10, sampleRate: 48000, audioChannels: 2,
  bitrateMbps: 2, crf: 18, quality: "social", audioKbps: 96,
  backgroundColor: "#000000", totalMs: 500,
  fonts: { sans: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" },
  segments: [{
    id: "s", mediaType: "image", path: img, startMs: 0, endMs: 500, durationMs: 500,
    trimInMs: 0, speed: 1, track: 0, volume: 0, hasAudio: false, kenBurns: null,
  }],
  music: null, extraAudio: [], texts: [], watermark: null,
};

const engine = require(path.join(__dirname, "..", "index.js"));
engine.exportVideo(JSON.stringify(timeline), out, "", () => {}).then((res) => {
  // raw YUV readback: decode to rawvideo and read the center pixel
  const r = spawnSync("ffmpeg", ["-i", out, "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"], {
    maxBuffer: 64 * 1024 * 1024, timeout: 60000,
  });
  const yuv = r.stdout;
  const W = 320, H = 180;
  const yOff = (Math.floor(H / 2)) * W + Math.floor(W / 2);
  const cW = W / 2, cH = H / 2;
  const uOff = W * H + (Math.floor(cH / 2)) * cW + Math.floor(cW / 2);
  const vOff = W * H + cW * cH + (Math.floor(cH / 2)) * cW + Math.floor(cW / 2);
  const got = [yuv[yOff], yuv[uOff], yuv[vOff]];
  console.log("engine:", res.engineUsed, "encoder:", res.encoderName);
  console.log("center pixel  got  Y=%d U=%d V=%d", ...got);
  console.log("center pixel  want Y=%d U=%d V=%d", ...expect);
  const ok = got.every((g, i) => Math.abs(g - expect[i]) <= 10);
  console.log(ok ? "COLOR OK (±10)" : "COLOR WRONG");
  process.exit(ok ? 0 : 1);
}).catch((e) => { console.error("export failed:", e.message); process.exit(1); });
