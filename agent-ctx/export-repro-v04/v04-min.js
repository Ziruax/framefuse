const path = require("path");
const engine = require("/home/z/my-project/rust-engine/framefuse-engine.linux-x64.node");
const timeline = {
  version: 1, width: 640, height: 360, fps: 30, sampleRate: 48000, audioChannels: 2,
  bitrateMbps: 0, crf: 23, quality: "social", audioKbps: 128, backgroundColor: "#000000",
  totalMs: 4174800, fadeInMs: 0, fadeOutMs: 0, normalizeAudio: false, audioTargetLufs: -16, fonts: {},
  segments: [{ id: "seg-loop", path: path.join(__dirname, "test10s.mp4"), mediaType: "video", startMs: 0, endMs: 4174800, durationMs: 4174800, trimInMs: 0, sourceDurationMs: 10000, speed: 1.0, track: 0, volume: 0.5, opacity: 1.0, hasAudio: true, loopSrc: true }],
  music: null, extraAudio: [{ path: path.join(__dirname, "vo69min.mp3"), startMs: 0, volume: 1.0, loopSrc: false }],
  texts: [], watermark: null, captions: null, kinetic: null,
};
const OUT = path.join(__dirname, "min-out.mp4");
require("fs").existsSync(OUT) && require("fs").unlinkSync(OUT);
engine.exportVideo(JSON.stringify(timeline), OUT, "", () => {})
  .then((r) => console.log("DONE", r.durationMs + "ms", r.frames, "frames"))
  .catch((e) => console.error("ERR", e.message));
