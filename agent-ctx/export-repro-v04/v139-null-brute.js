// Brute-force: null out every numeric leaf in a valid timeline JSON and find
// which paths produce serde "invalid type: null, expected f64".
"use strict";
const path = require("path");
const RUST = require("../../rust-engine");

const AUDIO_MS = 600000;
const base = {
  version: 1,
  width: 1920,
  height: 1080,
  fps: 30,
  sampleRate: 48000,
  audioChannels: 2,
  bitrateMbps: 0,
  crf: 21,
  quality: "social",
  audioKbps: 192,
  backgroundColor: "#000000",
  totalMs: AUDIO_MS,
  fadeInMs: 0,
  fadeOutMs: 0,
  normalizeAudio: false,
  audioTargetLufs: -16,
  fonts: { sans: "X", mono: "Y" },
  segments: [
    {
      id: "s1", mediaType: "image", path: "/tmp/x.png",
      startMs: 0, endMs: AUDIO_MS, durationMs: AUDIO_MS, trimInMs: 0,
      sourceDurationMs: null, speed: 1, track: 0, volume: 1,
      sourceWidth: null, sourceHeight: null,
      kenBurns: { enabled: true, direction: "in", zoomMax: 1.06 },
      geometry: { x: 0.5, y: 0.5, w: 0.3, h: 0.2 },
      chroma: { color: "#00b140", similarity: 0.31, smoothness: 0.08 },
      opacity: 1, overlayLoop: false, loopSrc: false,
      motion: [{ tMs: 0, x: 0.5, y: 0.5 }],
      hasAudio: false,
      transHeadMs: 0, transHeadStyle: "none",
      transTailMs: 0, transTailStyle: "none",
      bookendStartMs: 0, bookendEndMs: 0,
    },
  ],
  music: { path: "/tmp/a.mp3", volume: 1, startMs: 0, loopTrack: false, normalizeSrc: false },
  extraAudio: [{ path: "/tmp/b.mp3", startMs: 0, volume: 1, loopSrc: false }],
  texts: [{ text: "hi", startMs: 0, endMs: 1000, font: "sans", size: 72, color: "#fff", outlineColor: "#000", position: "center", x: 0.5, fadeMs: 250 }],
  watermark: { path: "/tmp/w.png", x: 10, y: 10, w: 100, h: 100, opacity: 0.8 },
  captions: {
    fontKey: "caption", fontSizePx: 40, textColor: "#fff", highlightColor: "#facc15",
    borderColor: "#000", borderWidthPx: 4, bgColor: null, bgAlpha: 1, bgPaddingPx: 12,
    shadow: true, shadowColor: "#000", shadowPx: 3, textTransform: "none",
    letterSpacingPx: 0, alignment: "center", position: "bottom", positionY: 50,
    maxWidthFrac: 0.84, wordMode: "off", animation: "none",
    cues: [{ startMs: 0, endMs: 1000, text: "x", words: [{ text: "x", startMs: 0, endMs: 1000 }] }],
  },
  kinetic: null,
};

// walk every numeric leaf and null it
const trials = [];
function walk(node, trail) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, trail + "[" + i + "]"));
    return;
  }
  if (node && typeof node === "object") {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === "number") trials.push({ trail: trail + "." + k, node, key: k });
      else walk(v, trail + "." + k);
    }
  }
}
walk(base, "");

(async () => {
  const vulnerable = [];
  for (const t of trials) {
    const saved = t.node[t.key];
    t.node[t.key] = null;
    try {
      await RUST.exportVideo(JSON.stringify(base), "/tmp/never.mp4", "", () => {});
      // if it somehow succeeded we'd stop; treat as no-error
    } catch (err) {
      const msg = String(err.message || err);
      if (msg.includes("expected f64")) vulnerable.push(t.trail);
    }
    t.node[t.key] = saved;
  }
  console.log("FIELDS WHERE null → 'expected f64' PARSE ERROR:");
  vulnerable.forEach((v) => console.log("  ", v));
  // also: how long is the full JSON? (to sanity-check column math)
  console.log("full JSON length:", JSON.stringify(base).length);
})();
