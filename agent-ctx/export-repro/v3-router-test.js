// v3 ROUTER feature test — validates rustEligible's new gate logic +
// buildRustTimeline's new field mapping (loopSrc / motion / normalizeAudio /
// normalizeSrc / ExtraAudio.loopSrc / audio-only) WITHOUT the engine binary:
// the router module is loaded with a STUBBED engine so the gate decisions
// are testable on any machine (the real binary path is covered by
// v3-feature-test.js + the full-handler harness).
"use strict";
const path = require("path");
const Module = require("module");

// ── stub the engine loader BEFORE the router requires it ──────────────────
// (the router requires "<repo>/rust-engine" — a FOLDER that resolves to
// index.js via package.json main; match BOTH shapes.)
const STUB_VERSION = process.env.FF_ROUTER_TEST_ENGINE_VERSION || "0.3.0";
const ENGINE_DIR = path.resolve(__dirname, "..", "..", "rust-engine");
const ENGINE_ENTRY = path.join(ENGINE_DIR, "index.js");
const isEngine = (id) => {
  try {
    const r = path.resolve(id);
    return r === ENGINE_DIR || r === ENGINE_ENTRY;
  } catch {
    return false;
  }
};
const realRequire = Module.prototype.require;
Module.prototype.require = function patched(id) {
  if (isEngine(id)) {
    return {
      available: () => true,
      engineVersion: () => STUB_VERSION,
      exportVideo: async () => {
        throw new Error("stub engine never runs in the router test");
      },
      cancelExport: () => {},
    };
  }
  return realRequire.apply(this, arguments);
};
process.resourcesPath = undefined;
const RUST = realRequire.call(module, path.join(__dirname, "..", "..", "electron", "rust-engine-router.js"));

const checks = [];
function check(label, ok) {
  console.log((ok ? "  ok  " : "  FAIL ") + label);
  checks.push(ok);
}

// ── the user's exact scenario shape (10s loop video + 69-min voiceover) ────
const LOOP_VO = {
  width: 1280, height: 720, fps: 30, quality: "social",
  totalMs: 4174800,
  segments: [
    {
      id: "seg0", mediaType: "video", videoPath: "/tmp/loop.mp4",
      startMs: 0, endMs: 4174800, durationMs: 4174800, trimInMs: 0, speed: 1,
      volume: 1, sourceDurationMs: 10000, loop: true,
    },
  ],
  overlays: [],
  voiceovers: [{ wavPath: "/tmp/vo.mp3", startMs: 0, volume: 1 }],
  musicClips: [],
  sfx: [],
  audio: { normalize: false },
  captionSettings: { enabled: true },
  subtitleCues: [{ startMs: 0, endMs: 2000, text: "hello", words: [] }],
};

// 1. LOOP + AUDIO-EXTENDED is now RUST-ELIGIBLE (was: base-loop + audio-extends-video gates)
let gate = RUST.rustEligible(LOOP_VO);
check("loop + audio-extended scenario is Rust-eligible (was gated)", gate.ok);

// 2. ...and the timeline JSON carries loopSrc + the payload totalMs
let built = RUST.buildRustTimeline(LOOP_VO);
check("timeline builds", !built.error);
check("loopSrc maps to the base segment", built.timeline.segments[0].loopSrc === true);
check("audio-extended: timeline totalMs = payload totalMs", built.timeline.totalMs === 4174800);
check("voiceover rides extraAudio", built.timeline.extraAudio.length === 1 && built.timeline.extraAudio[0].path === "/tmp/vo.mp3");
check("normalizeAudio false by default", built.timeline.normalizeAudio === false);

// 3. NON-loop audio-extended (the false "disk full" scenario)
const NOLOOP_VO = {
  ...LOOP_VO,
  segments: [
    {
      id: "seg0", mediaType: "video", videoPath: "/tmp/loop.mp4",
      startMs: 0, endMs: 10000, durationMs: 10000, trimInMs: 0, speed: 1,
      volume: 1, sourceDurationMs: 10000, loop: false,
    },
  ],
};
gate = RUST.rustEligible(NOLOOP_VO);
check("non-loop audio-extended scenario is Rust-eligible", gate.ok);
built = RUST.buildRustTimeline(NOLOOP_VO);
check("non-loop segment keeps loopSrc false", built.timeline.segments[0].loopSrc === false);
check("non-loop timeline still runs to the audio's totalMs", built.timeline.totalMs === 4174800);

// 4. AUDIO-ONLY timeline
const AUDIO_ONLY = {
  ...LOOP_VO,
  segments: [],
  voiceovers: [{ wavPath: "/tmp/vo.mp3", startMs: 0, volume: 1 }],
};
gate = RUST.rustEligible(AUDIO_ONLY);
check("audio-only timeline is Rust-eligible", gate.ok);
built = RUST.buildRustTimeline(AUDIO_ONLY);
check("audio-only timeline builds (no 'no segments' refusal)", !built.error);
check("audio-only: zero segments in the Rust timeline", built.timeline.segments.length === 0);
check("audio-only: totalMs from the payload", built.timeline.totalMs === 4174800);

// 5. completely empty project still refuses
gate = RUST.rustEligible({ segments: [], voiceovers: [], sfx: [], musicClips: [] });
check("empty project still gated (empty-timeline)", !gate.ok && /empty-timeline/.test(gate.reason));
built = RUST.buildRustTimeline({ segments: [], voiceovers: [], sfx: [], musicClips: [] });
check("empty project timeline refuses", built.error === "no segments");

// 6. LOUDNORM is eligible + mapped
const NORM = { ...LOOP_VO, audio: { normalize: true } };
gate = RUST.rustEligible(NORM);
check("normalize ON is Rust-eligible (was gated)", gate.ok);
built = RUST.buildRustTimeline(NORM);
check("normalizeAudio maps to the timeline", built.timeline.normalizeAudio === true);
check("audioTargetLufs is -16", built.timeline.audioTargetLufs === -16);

// 7. legacy music path gets normalizeSrc; musicClips don't
built = RUST.buildRustTimeline({
  ...LOOP_VO, segments: [
    { id: "s", mediaType: "video", videoPath: "/v.mp4", startMs: 0, endMs: 5000, durationMs: 5000, sourceDurationMs: 5000 },
  ],
  audioPath: "/tmp/music.mp3", audio: { normalize: true, musicLoop: true },
});
check("legacy music: normalizeSrc true + loopTrack", built.timeline.music.normalizeSrc === true && built.timeline.music.loopTrack === true);
built = RUST.buildRustTimeline({
  ...LOOP_VO, segments: [
    { id: "s", mediaType: "video", videoPath: "/v.mp4", startMs: 0, endMs: 5000, durationMs: 5000, sourceDurationMs: 5000 },
  ],
  musicClips: [
    { path: "/m1.mp3", startMs: 0, volume: 1, loop: true },
    { path: "/m2.mp3", startMs: 1000, volume: 0.5, loop: true },
  ],
});
check("musicClips: clip 1 on the music channel (no normalizeSrc)", built.timeline.music.normalizeSrc === false && built.timeline.music.loopTrack === true);
check("musicClips: clips 2..N ride extraAudio WITH loopSrc", built.timeline.extraAudio.some((e) => e.path === "/m2.mp3" && e.loopSrc === true));

// 8. OVERLAY MOTION keyframes map
built = RUST.buildRustTimeline({
  ...LOOP_VO,
  segments: [
    { id: "s", mediaType: "video", videoPath: "/v.mp4", startMs: 0, endMs: 5000, durationMs: 5000, sourceDurationMs: 5000 },
  ],
  overlays: [
    {
      id: "o1", mediaType: "image", imagePath: "/ov.png",
      startMs: 0, endMs: 5000, durationMs: 5000, overlayLoop: false,
      overlay: {
        position: "center", scalePercent: 40, x: 0.5, y: 0.5,
        motion: [
          { tMs: 0, x: 0.1, y: 0.1 },
          { tMs: 2500, x: 0.5, y: 0.5 },
          { tMs: 5000, x: 0.9, y: 0.9 },
        ],
      },
    },
  ],
});
const ovl = built.timeline.segments.find((s) => s.id === "o1");
check("overlay motion keyframes map (sorted, clamped)", ovl && ovl.motion.length === 3 && ovl.motion[0].x === 0.1 && ovl.motion[2].x === 0.9);
gate = RUST.rustEligible({
  ...LOOP_VO,
  segments: [{ id: "s", mediaType: "video", videoPath: "/v.mp4", startMs: 0, endMs: 5000, durationMs: 5000 }],
  overlays: [
    { id: "o1", mediaType: "image", imagePath: "/ov.png", startMs: 0, endMs: 5000, durationMs: 5000, overlay: { motion: [{ tMs: 0, x: 0, y: 0 }, { tMs: 1, x: 1, y: 1 }] } },
  ],
});
check("overlay motion scenario is Rust-eligible (was gated)", gate.ok);

// 9. the still-gated features
const GATED = {
  textRemoval: { mode: "inpaint", regions: [{ x: 0, y: 0, w: 1, h: 0.2 }] },
  transition: { style: "circleopen", durationMs: 400 },
  headlines: [{ text: "hi", startMs: 0, endMs: 1000, stackStyle: "banner" }],
};
gate = RUST.rustEligible({
  ...LOOP_VO,
  segments: [{ id: "s", mediaType: "video", videoPath: "/v.mp4", startMs: 0, endMs: 5000, durationMs: 5000 }],
  ...GATED,
});
check(
  "text-removal / geometric transition / stack-text still gate to the CLI",
  !gate.ok && /text-removal/.test(gate.reason) && /transition:circleopen/.test(gate.reason) && /stack-text/.test(gate.reason),
);

// 10. STALE ENGINE (0.2.0): the v0.3 scenarios route to the CLI (engine-pre-0.3)
// (re-require the router with the stub version flipped — module cache bust)
delete require.cache[path.join(__dirname, "..", "..", "electron", "rust-engine-router.js")];
Module.prototype.require = function patched2(id) {
  if (isEngine(id)) {
    return {
      available: () => true,
      engineVersion: () => "0.2.0",
      exportVideo: async () => { throw new Error("stub"); },
      cancelExport: () => {},
    };
  }
  return realRequire.apply(this, arguments);
};
const RUST_OLD = realRequire.call(module, path.join(__dirname, "..", "..", "electron", "rust-engine-router.js"));
gate = RUST_OLD.rustEligible(LOOP_VO);
check("stale 0.2.0 engine: loop scenario routes to the CLI (engine-pre-0.3)", !gate.ok && /engine-pre-0\.3/.test(gate.reason));
gate = RUST_OLD.rustEligible({ ...LOOP_VO, segments: [{ id: "s", mediaType: "video", videoPath: "/v.mp4", startMs: 0, endMs: 4174800, durationMs: 4174800 }] });
check("stale 0.2.0 engine: plain video stays Rust-eligible", gate.ok);
gate = RUST_OLD.rustEligible({ ...LOOP_VO, audio: { normalize: true } });
check("stale 0.2.0 engine: normalize routes to the CLI", !gate.ok && /engine-pre-0\.3/.test(gate.reason));

const failed = checks.filter((c) => !c).length;
if (failed) {
  console.error(failed + " check(s) FAILED");
  process.exit(1);
}
console.log("V3 ROUTER TEST PASSED (" + checks.length + " checks)");
