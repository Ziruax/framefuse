"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const ENGINE = require("../../rust-engine");

const work = fs.mkdtempSync(path.join(os.tmpdir(), "v139rep-"));
const imgPath = path.join(work, "still.jpg");
fs.copyFileSync(path.join(__dirname, "..", "..", "public", "samples", "001__Beat_1_0s_In_the_MASTER_ENVIRONMENT_NARVARTE_HOUSE_DINING_ROOM_PROTAG.jpg"), imgPath);

const tl = {
  version: 1, width: 640, height: 360, fps: 12,
  sampleRate: 48000, audioChannels: 2, bitrateMbps: 0, crf: 23,
  quality: "social", audioKbps: 128, backgroundColor: "#000000",
  totalMs: 4000, fadeInMs: 0, fadeOutMs: 0, normalizeAudio: false,
  fonts: { sans: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" },
  segments: [{
    id: "s1", mediaType: "image", path: imgPath,
    startMs: 0, endMs: 4000, durationMs: 4000, trimInMs: 0,
    sourceDurationMs: null, speed: 1, track: 0, volume: 1,
    kenBurns: null, geometry: null, chroma: null,
    opacity: 1, overlayLoop: false, loopSrc: false, hasAudio: false,
    transHeadMs: 0, transHeadStyle: "none", transTailMs: 0, transTailStyle: "none",
    bookendStartMs: 0, bookendEndMs: 0,
  }],
  music: null, extraAudio: [],
  texts: [{ text: "repair test", startMs: 0, endMs: 3000, font: "sans", size: 44, color: "#fff", outlineColor: "#000", position: "center", x: 0.5, fadeMs: 0 }],
  watermark: null,
  captions: {
    fontKey: "sans", fontSizePx: 30, textColor: "#fff", highlightColor: null,
    borderColor: "#000", borderWidthPx: 3, bgColor: null,
    bgAlpha: null,        // ← THE USER'S BUG SHAPE (null on f64)
    bgPaddingPx: null,    // ←
    positionY: null,      // ←
    shadow: true, shadowColor: "#000", shadowPx: 4, textTransform: "none",
    letterSpacingPx: 0, alignment: "center", position: "bottom",
    maxWidthFrac: 0.84, wordMode: "off", animation: "none",
    cues: [{ startMs: 200, endMs: 3500, text: "burned caption", words: [] }],
  },
  kinetic: null,
};

(async () => {
  try {
    const res = await ENGINE.exportVideo(JSON.stringify(tl), path.join(work, "out.mp4"), "", () => {});
    const size = fs.statSync(path.join(work, "out.mp4")).size;
    console.log("REPAIRED EXPORT OK — frames:", res.frames, "size:", size, "dedup:", res.dedup || "none");
  } catch (err) {
    console.log("REPAIRED EXPORT FAILED:", err.message);
  }
})();
