// v1.33.9 PARSE-ERROR REPRO: the user's exact scenario —
//   "10 min audio + 1 image as loop to match audio" →
//   engine run failed: Timeline parse error: invalid type: null, expected f64
//   at line 1 column 1350
//
// Mirrors native.ts's payload construction (base-lane image + music clip),
// runs the REAL router buildRustTimeline, prints the JSON around column 1350,
// and runs the REAL engine to catch the parse error.

"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");

const RUST = require("../../electron/rust-engine-router.js");

// ── mimic the renderer's export payload (native.ts shapes) ────────────────
const AUDIO_MS = 600000; // 10 minutes
const work = fs.mkdtempSync(path.join(os.tmpdir(), "v139-"));
const imgPath = path.join(work, "still.png");
// reuse the repo's sample image bytes (any real image works)
fs.copyFileSync(path.join(__dirname, "..", "..", "public", "samples", "001__Beat_1_0s_In_the_MASTER_ENVIRONMENT_NARVARTE_HOUSE_DINING_ROOM_PROTAG.jpg"), imgPath);
const audioPath = path.join(__dirname, "vo20min.mp3"); // real 20-min VO (close enough; engine reads it)

const baseImageSeg = {
  // native.ts base-lane image payload (line ~499)
  id: "img-1",
  imagePath: imgPath,
  direction: "in",
  durationMs: AUDIO_MS, // loop-extended window (buildTimeline stretched it)
  startMs: 0,
  endMs: AUDIO_MS,
  mediaType: "image",
  track: 0,
  volume: 1,
  trimInMs: 0,
  sourceDurationMs: null,
  chroma: null,
  overlay: null,
};

const opts = {
  // native.ts top-level payload
  outputPath: path.join(work, "out.mp4"),
  fps: 30,
  width: 1920,
  height: 1080,
  bitrateMbps: 0,
  quality: "social",
  crf: 20,
  fastMode: true,
  slideshowFps24: true,
  audioKbps: 192,
  totalMs: AUDIO_MS, // displayTotalMs (the audio-driven fill end)
  kenBurns: { enabled: false, intensity: 30, direction: "in", directionPool: [] },
  segments: [baseImageSeg],
  audioPath, // legacy single-music path branch
  musicClips: undefined,
  audio: {
    masterVolume: 1,
    musicVolume: 0.8,
    musicStartMs: 0,
    musicLoop: false,
    fadeInMs: 0,
    fadeOutMs: 0,
    normalize: false,
  },
  captionSettings: undefined,
  subtitleCues: undefined,
  headlines: undefined,
  headlineGeometry: null,
  transition: { style: "none", durationMs: 700, fadeStartEnd: false, overrides: undefined },
  watermark: null,
  overlays: undefined,
  sfx: undefined,
  voiceovers: undefined,
  dubOriginalVolume: undefined,
  textRemoval: undefined,
};

const built = RUST.buildRustTimeline(opts);
if (built.error) {
  console.log("BUILD REFUSED:", built.error);
  process.exit(1);
}
const json = JSON.stringify(built.timeline);
console.log("timeline JSON length:", json.length);

// ── column inspection ──────────────────────────────────────────────────────
function showCol(col) {
  const from = Math.max(0, col - 160);
  const to = Math.min(json.length, col + 80);
  console.log(`\n--- around column ${col} ---`);
  console.log(json.slice(from, to));
  console.log(" ".repeat(col - from) + "^ (col " + col + ")");
  // parse the position into a field path
  const upto = json.slice(0, col);
  const m = upto.match(/"([A-Za-z0-9_]+)":$/);
  if (m) console.log(">>> FIELD AT COLUMN:", m[1]);
}
showCol(1350);

// ── run the REAL engine (this is where the user's error fires) ─────────────
(async () => {
  try {
    const res = await require("../../rust-engine").exportVideo(json, opts.outputPath, "", (e, p) => {});
    console.log("\nENGINE OK:", JSON.stringify({ frames: res.frames, engineUsed: res.engineUsed, dedup: res.dedup, wallMs: res.durationMs }));
  } catch (err) {
    console.log("\nENGINE FAILED:", err.message);
    // serde errors carry their column — extract and show
    const m = String(err.message).match(/line (\d+) column (\d+)/);
    if (m) showCol(Number(m[2]));
  }
})();
