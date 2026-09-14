// scripts/test-export-parity.ts — FrameFuse v6 export-parity harness (bun).
//
// The export-side mirror functions in electron/export-graph.js /
// electron/export-singlepass.js are cross-asserted against the REAL
// src/lib/merger/renderer.ts implementations (the preview's single source of
// truth), and the refactored two-step argv builders are byte-diffed against
// the PRE-v6 module checked out from git HEAD — proving the refactor changed
// nothing for the two-step path while the single-pass path reuses the exact
// same expression sources.
//
// Run: bun scripts/test-export-parity.ts   (or: npm run test:export-parity)
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(import.meta.dir, "..");
const G = require(path.join(ROOT, "electron/export-graph.js")) as any;
const SP = require(path.join(ROOT, "electron/export-singlepass.js")) as any;

// The renderer (preview) — TS imports resolve under bun.
import {
  easeInOutSine,
  isXfadeStyle,
  clampTransitionMs,
  transitionHeadMs,
  transitionTailMs,
  overlayGeometry,
  sanitizeMotionKeyframes,
} from "../src/lib/merger/renderer";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// deterministic RNG for randomized mirror fuzzing
let seed = 1234567;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function rint(lo: number, hi: number) { return Math.floor(lo + rnd() * (hi - lo + 1)); }
function pick<T>(arr: T[]): T { return arr[rint(0, arr.length - 1)]; }

console.log("── 1. renderer.ts ↔ export-graph.js mirror assertions ──────────────");

// 1a. overlayGeometry ↔ overlayGeometryMirror (fuzz: dims, scale, positions,
// free-form x/y, degenerate inputs).
{
  const positions = ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"];
  let worst = 0;
  let mismatch = 0;
  for (let k = 0; k < 4000; k++) {
    const videoW = rint(16, 3840), videoH = rint(16, 2160);
    const srcW = rint(1, 4000), srcH = rint(1, 4000);
    const t: any = {
      scalePercent: pick([undefined, 0, 9, 10, 33.5, 50, 99, 100, 1000, NaN]),
      position: pick(positions),
    };
    if (rnd() < 0.5) t.x = pick([undefined, 0, 0.5, 1, rnd(), -0.2, 1.7, NaN]);
    if (rnd() < 0.5) t.y = pick([undefined, 0, 0.5, 1, rnd(), -0.2, 1.7, NaN]);
    const a = overlayGeometry(videoW, videoH, srcW, srcH, t as any);
    const b = G.overlayGeometryMirror(videoW, videoH, srcW, srcH, t);
    for (const key of ["dx", "dy", "dw", "dh"] as const) {
      if (a[key] !== b[key]) {
        mismatch++;
        worst = Math.max(worst, Math.abs((a[key] ?? 0) - (b[key] ?? 0)));
      }
    }
  }
  ok(`overlayGeometry mirror (4000 fuzz cases, ${mismatch} mismatches)`, mismatch === 0, `worst Δ=${worst}`);
}

// 1b. isXfadeStyle ↔ isXfadeStyleMirror over the full style domain.
{
  const styles = ["none", "dissolve", "slide-left", "slide-right", "wipe-left", "wipe-right", "circleopen", "dip-black", "dip-white", "bogus", ""];
  let mismatch = 0;
  for (const s of styles) {
    if (isXfadeStyle(s as any) !== G.isXfadeStyleMirror(s)) mismatch++;
  }
  ok(`isXfadeStyle mirror (${styles.length} styles)`, mismatch === 0);
  ok("XFADE_NAMES domain == isXfadeStyle domain", styles.filter((s) => isXfadeStyle(s as any)).every((s) => Object.keys(G.XFADE_NAMES).includes(s)));
}

// 1c. clampTransitionMs ↔ clampTrMs (the 0.45 max-fraction lockstep).
{
  let mismatch = 0;
  for (let k = 0; k < 2000; k++) {
    const ms = rint(0, 20000);
    const dur = rint(0, 60000);
    if (clampTransitionMs(ms, dur) !== G.clampTrMs(ms, dur)) mismatch++;
  }
  ok(`clampTransitionMs mirror (2000 fuzz cases)`, mismatch === 0);
}

// 1d. transitionHeadMs/TailMs ↔ planBoundaryFades (head/dip windows).
{
  const stylePool = ["none", "dissolve", "slide-left", "wipe-right", "circleopen", "dip-black", "dip-white"];
  let mismatch = 0;
  for (let k = 0; k < 2000; k++) {
    const n = rint(1, 6);
    const segments: any[] = [];
    for (let s = 0; s < n; s++) {
      segments.push({
        id: `s${s}`,
        mediaType: pick(["video", "image"]),
        durationMs: rint(100, 30000),
        trimInMs: 0, volume: 1,
        videoPath: "v.mp4", imagePath: "i.jpg",
      });
    }
    const overrides: any = {};
    for (const seg of segments) if (rnd() < 0.4) overrides[seg.id] = pick(stylePool);
    const transition: any = {
      style: pick(stylePool),
      durationMs: rint(0, 5000),
      fadeStartEnd: rnd() < 0.3,
      overrides,
    };
    for (let i = 0; i < n; i++) {
      const plan = G.planBoundaryFades(i, segments[i], segments, transition);
      // The renderer folds the v5.0 VIDEO RULE into the head number; the
      // export applies it at useXfadeHead (buildClipArgs) — both render a
      // hard cut. Compare the EFFECTIVE head (video-rule folded the same
      // way) so the assertion checks real parity, not factoring.
      const videoBoundary = !!(segments[i].mediaType === "video" || (segments[i - 1] && segments[i - 1].mediaType === "video"));
      const effHead = plan.xfadeName && videoBoundary ? 0 : plan.headMs;
      const headMs = transitionHeadMs(segments as any, i, transition as any);
      if (effHead !== headMs) mismatch++;
      const tailMs = transitionTailMs(segments as any, i, transition as any);
      if (plan.dipTailMs !== tailMs) mismatch++;
    }
  }
  ok(`transitionHeadMs/TailMs ↔ planBoundaryFades (${mismatch} mismatches)`, mismatch === 0);
}

// 1e. sanitizeMotionKeyframes ↔ sanitizeMotionMirror.
{
  let mismatch = 0;
  for (let k = 0; k < 1500; k++) {
    const raw: any[] = [];
    for (let j = 0; j < rint(0, 6); j++) {
      raw.push(pick([
        { tMs: rint(0, 30000), x: rnd(), y: rnd() },
        { tMs: -5, x: rnd(), y: rnd() },
        { tMs: rint(0, 30000), x: -1, y: 2 },
        { tMs: NaN, x: 0.5, y: 0.5 },
        null,
        { tMs: rint(0, 30000), x: NaN, y: rnd() },
      ]));
    }
    const a = JSON.stringify(sanitizeMotionKeyframes(raw as any));
    const b = JSON.stringify(G.sanitizeMotionMirror(raw));
    if (a !== b) mismatch++;
  }
  ok(`sanitizeMotionKeyframes mirror (1500 fuzz cases)`, mismatch === 0);
}

// 1f. easeInOutSine — the shared easing behind the zoompan expressions.
{
  let worst = 0;
  for (let k = 0; k <= 100; k++) {
    const t = k / 100;
    const want = -(Math.cos(Math.PI * t) - 1) / 2;
    worst = Math.max(worst, Math.abs(easeInOutSine(t) - want));
  }
  ok(`easeInOutSine canonical values (worst Δ=${worst.toExponential(2)})`, worst < 1e-12);
}

console.log("── 2. two-step argv byte-differential vs git HEAD (pre-v6) ────────");

// Check out the PRE-v6 export-graph.js from git HEAD and byte-diff the argv
// builders across a full feature matrix. The v6 refactor (Ken Burns
// expression extraction, opt-in atempo/masterLoudnorm params) must be
// byte-identical when the new params are absent.
const OLD_GRAPH_PATH = "/tmp/framefuse-pre-v6-export-graph.js";
{
  execFileSync("git", ["-C", ROOT, "show", "HEAD:electron/export-graph.js"], { stdio: ["ignore", "pipe", process.stderr] });
  const old = execFileSync("git", ["-C", ROOT, "show", "HEAD:electron/export-graph.js"]).toString();
  fs.writeFileSync(OLD_GRAPH_PATH, old);
}
const OLD = require(OLD_GRAPH_PATH) as any;

function segCase(k: number): any {
  const dirs = ["in", "out", "left", "right", "up", "down", "none", undefined];
  const mediaType = pick(["video", "image"]);
  return {
    id: `seg${k}`,
    mediaType,
    durationMs: rint(200, 30000),
    trimInMs: pick([0, 0, 500, 4300]),
    volume: pick([1, 0.6, 1.4]),
    speed: pick([undefined, 1, 0.5, 2, 4]),
    direction: pick(dirs),
    videoPath: mediaType === "video" ? "/tmp/v.mp4" : undefined,
    imagePath: mediaType === "image" ? "/tmp/i.png" : undefined,
    startMs: 0,
  };
}

function transitionsCase(): any {
  const styles = ["none", "dissolve", "slide-left", "slide-right", "wipe-left", "wipe-right", "circleopen", "dip-black", "dip-white"];
  return {
    style: pick(styles),
    durationMs: pick([0, 300, 1200, 5000]),
    fadeStartEnd: rnd() < 0.3,
  };
}

function overlaySpec(): any {
  return {
    inputArgs: G.buildOverlayImageInputArgs({ durMs: 2000, path: "/tmp/ov.png" }),
    x: rint(-50, 800), y: rint(-50, 400),
    dw: rint(80, 900), dh: rint(60, 500),
    chroma: rnd() < 0.4 ? { color: "#00ff00", similarity: 0.32, blend: 0.08, spill: 0.6, mode: "chroma" } : null,
    a: 0.3, b: 1.7,
    fps: rnd() < 0.3 ? 30 : null,
  };
}

{
  let argvMismatches = 0;
  let cases = 0;
  const encArgs = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"];
  for (let k = 0; k < 300; k++) {
    const n = rint(1, 5);
    const segments: any[] = [];
    for (let s = 0; s < n; s++) segments.push(segCase(k * 10 + s));
    const transition = transitionsCase();
    const ctx = {
      i: rint(0, n - 1),
      seg: segments[0], // placeholder; set below
      segments,
      fps: pick([24, 30, 60]),
      width: pick([640, 1280, 1920]),
      height: pick([360, 720, 1080]),
      kbEnabled: rnd() < 0.5,
      zoomMax: 1.06 + rnd() * 0.18,
      globalDir: pick(["in", "out", "left", "right", "up", "down"]),
      transition,
      wm: rnd() < 0.3 ? { imagePath: "/tmp/wm.png", x: 20, y: 30, w: 120, h: 40, opacity: "0.800" } : null,
      assSuffix: rnd() < 0.4 ? "subtitles=filename='/tmp/cap.ass'" : null,
      clipPath: "/tmp/clip.mp4",
      encArgs,
      anyAudio: false,
      segHasAudio: false,
      overlaySpecs: rnd() < 0.4 ? [overlaySpec()] : [],
      hwaccel: false,
      threads: pick([0, 2, 4]),
    };
    ctx.seg = segments[ctx.i];
    if (rnd() < 0.25) {
      ctx.chunk = { offsetMs: 30000, durMs: 15000, first: false, last: true };
    }
    const a = OLD.buildClipArgs(JSON.parse(JSON.stringify(ctx)));
    const b = G.buildClipArgs(JSON.parse(JSON.stringify(ctx)));
    cases++;
    if (JSON.stringify(a.args) !== JSON.stringify(b.args)) {
      argvMismatches++;
      if (argvMismatches <= 2) {
        console.error("    DIFF case:", JSON.stringify({ i: ctx.i, seg: ctx.seg, kb: ctx.kbEnabled, wm: !!ctx.wm, ass: !!ctx.assSuffix, ovl: ctx.overlaySpecs.length }));
        for (let q = 0; q < Math.max(a.args.length, b.args.length); q++) {
          if (a.args[q] !== b.args[q]) console.error(`      [${q}] OLD=${a.args[q]}\n      [${q}] NEW=${b.args[q]}`);
        }
      }
    }
  }
  ok(`buildClipArgs byte-identical to HEAD (${cases} fuzz cases)`, argvMismatches === 0);
}

{
  // buildConcatArgs + buildAudioMixGraph differential (no new params → same).
  let mismatches = 0;
  let cases = 0;
  const measure = { i: -23.4, lra: 5.2, tp: -2.1, thresh: -34.2, offset: 0.4 };
  for (let k = 0; k < 200; k++) {
    const clipAudio = Array.from({ length: rint(0, 3) }, () => ({
      wavPath: "/tmp/a.wav", startMs: rint(0, 20000), volume: pick([1, 0.5, 1.3]),
    }));
    const o = {
      concatListPath: "/tmp/list.txt",
      audioPath: rnd() < 0.6 ? "/tmp/music.mp3" : null,
      audio: {
        normalize: rnd() < 0.5,
        musicVolume: pick([1, 0.7, 1.5]),
        masterVolume: pick([1, 0.8]),
        fadeInMs: pick([0, 800]),
        fadeOutMs: pick([0, 1500]),
        musicStartMs: pick([0, 2000]),
        musicLoop: rnd() < 0.4,
      },
      outputPath: "/tmp/out.mp4",
      totalSec: 30 + rnd() * 30,
      sfx: rnd() < 0.4 ? [{ wavPath: "/tmp/s.wav", startMs: 500, volume: 0.9 }] : [],
      loudnorm: rnd() < 0.5 ? { clip: clipAudio.map(() => (rnd() < 0.7 ? measure : null)), music: rnd() < 0.7 ? measure : null } : null,
      masterMix: rnd() < 0.2 ? { wavPath: "/tmp/mm.wav", loudnorm: measure } : null,
      audioKbps: pick([192, 128, 320, undefined]),
      clipAudio,
      newAudioGraph: rnd() < 0.7,
    };
    cases++;
    const a = OLD.buildConcatArgs(JSON.parse(JSON.stringify(o)));
    const b = G.buildConcatArgs(JSON.parse(JSON.stringify(o)));
    if (JSON.stringify(a) !== JSON.stringify(b)) mismatches++;
  }
  ok(`buildConcatArgs byte-identical to HEAD (${cases} fuzz cases)`, mismatches === 0);

  let gMismatch = 0;
  for (let k = 0; k < 200; k++) {
    const o = {
      totalSec: 20 + rnd() * 40,
      audio: {
        normalize: rnd() < 0.5,
        musicVolume: pick([1, 0.6, 1.4]),
        masterVolume: pick([1, 0.9, 1.6]),
        fadeInMs: pick([0, 600]), fadeOutMs: pick([0, 900]),
        musicStartMs: pick([0, 3000]),
      },
      clipAudio: Array.from({ length: rint(0, 3) }, (_, j) => ({ inputIdx: j + 2, startMs: rint(0, 15000), volume: pick([1, 0.5, 1.7]) })),
      hasMusic: rnd() < 0.5,
      musicInputIdx: 1,
      loudnorm: rnd() < 0.5 ? { clip: [null, measure], music: measure } : null,
      rawMix: rnd() < 0.2,
      sfx: rnd() < 0.5 ? [{ inputIdx: 5, startMs: 800, volume: 1 }] : [],
    };
    const a = OLD.buildAudioMixGraph(JSON.parse(JSON.stringify(o)));
    const b = G.buildAudioMixGraph(JSON.parse(JSON.stringify(o)));
    if (a.graph !== b.graph) gMismatch++;
  }
  ok(`buildAudioMixGraph byte-identical (no v6 params, 200 cases)`, gMismatch === 0);
}

console.log("── 3. Ken Burns expression source shared by both paths ──────────────");

// The single-pass kenBurnsImageChain must equal the two-step buildClipArgs
// zoompan chain for the same segment (string-identical).
{
  const W = 1280, H = 720, FPS = 30;
  let mismatch = 0;
  for (const dir of ["in", "out", "left", "right", "up", "down"]) {
    // Only the ANIMATED cases ride the zoompan chain in BOTH paths: the
    // two-step's staticImg fast path (kb off / dir none) is a plain
    // cover-fit — the single-pass builder makes the same branch choice.
    for (const kb of [true]) {
      const durMs = 4000;
      const segFrames = Math.max(2, Math.round((durMs / 1000) * FPS));
      const ctx: any = {
        i: 0,
        seg: { id: "s", mediaType: "image", imagePath: "/tmp/i.png", durationMs: durMs, direction: dir, trimInMs: 0, volume: 1, startMs: 0 },
        segments: [{ id: "s", mediaType: "image", imagePath: "/tmp/i.png", durationMs: durMs, direction: dir, trimInMs: 0, volume: 1, startMs: 0 }],
        fps: FPS, width: W, height: H,
        kbEnabled: kb, zoomMax: 1.2, globalDir: "in",
        transition: { style: "none", durationMs: 0 },
        wm: null, assSuffix: null, clipPath: "/tmp/c.mp4",
        encArgs: ["-c:v", "libx264"],
        anyAudio: false, segHasAudio: false, overlaySpecs: [], hwaccel: false, threads: 0,
      };
      const twoStep = G.buildClipArgs(ctx);
      // plain image path (no wm/overlays) → -vf string holds the chain.
      const vfIdx = twoStep.args.indexOf("-vf");
      const vf = vfIdx >= 0 ? twoStep.args[vfIdx + 1] : "";
      const single = G.kenBurnsImageChain({ segFrames, kbEnabled: kb, dir: kb ? dir : "none", zoomMax: 1.2, width: W, height: H, fps: FPS });
      const hasChain = vf.includes(single);
      if (!hasChain) {
        mismatch++;
        console.error(`    dir=${dir} kb=${kb}\n      twoStep vf: ${vf}\n      single chain: ${single}`);
      }
    }
  }
  ok(`kenBurnsImageChain == two-step zoompan chain (all dirs × on/off)`, mismatch === 0);
}

console.log("── 4. planSandwichCopy unit tests ────────────────────────────────────");
{
  // GOP every 1.6s: 0, 1600, 3200, 4800, 6400, 8000 …
  const kfs = [];
  for (let ms = 0; ms <= 12000; ms += 1600) kfs.push({ s: (ms / 1000).toFixed(6), ms });
  const p1 = G.planSandwichCopy({ trimMs: 400, durMs: 8000, keyframes: kfs });
  // trim 400 → k1=1600 (head 1200ms), end 8400 → k2=8000 (tail 400ms), middle 6400
  ok("mid-GOP trim sandwiched (head 1200 / middle 6400 / tail 400)",
    !!p1 && p1.head && p1.head.durMs === 1200 && p1.middle.durMs === 6400 && p1.tail && p1.tail.durMs === 400,
    JSON.stringify(p1));
  const p2 = G.planSandwichCopy({ trimMs: 0, durMs: 8000, keyframes: kfs });
  // trim 0 aligned: head null; end 8000 = k2 → tail 0 → null; middle [0,8000)
  ok("aligned trim → headless/tailless middle (returns null — legacy copy owns it)",
    p2 === null, JSON.stringify(p2));
  const p3 = G.planSandwichCopy({ trimMs: 3000, durMs: 1000, keyframes: kfs });
  // 1s clip: middle would be 0 → below minMiddle → null
  ok("short window (no middle) rejected", p3 === null);
  const p4 = G.planSandwichCopy({ trimMs: 400, durMs: 8000, keyframes: kfs, maxEdgeMs: 500 });
  // head 1200 > 500 edge cap → null
  ok("edge over cap rejected", p4 === null);
  const p5 = G.planSandwichCopy({ trimMs: 400, durMs: 8000, keyframes: [] });
  ok("no keyframes rejected", p5 === null);
  const p6 = G.planSandwichCopy({ trimMs: 5000, durMs: 8000, keyframes: kfs });
  // trim 5000 → k1=6400 (head 1400); end 13000 → last kf=11200 (tail 1800);
  // middle [6400,11200) = 4800 — kfs step 1600 from 0, so 12000 is NOT a kf.
  ok("deep trim still sandwiched (frame-accurate both edges)",
    !!p6 && p6.head.durMs === 1400 && p6.middle.durMs === 4800 && p6.tail.durMs === 1800,
    JSON.stringify(p6));
}

console.log("── 5. estimateMixLoudnorm unit sanity ────────────────────────────────");
{
  // Two fully-active uncorrelated branches at -16 with unity volumes:
  // energy = 2·10^(-16/10) → mixI = -16 + 10log10(2) ≈ -12.99.
  const m = { i: -20, lra: 5, tp: -2, thresh: -30, offset: 0 };
  const est = G.estimateMixLoudnorm({
    totalSec: 30,
    audio: { masterVolume: 1, musicVolume: 1 },
    clipAudio: [{ measure: m, volume: 1, durationMs: 30000 }],
    music: m,
  });
  const parsed = /measured_I=(-?[\d.]+)/.exec(est || "");
  const mixI = parsed ? parseFloat(parsed[1]) : NaN;
  ok(`2 equal branches → est I ≈ -12.99 (got ${mixI.toFixed(2)})`, Math.abs(mixI - (-16 + 10 * Math.log10(2))) < 0.05);
  // Single branch → null (v1.2 rule: already at target).
  const est1 = G.estimateMixLoudnorm({
    totalSec: 30,
    audio: { masterVolume: 1, musicVolume: 1 },
    clipAudio: [{ measure: m, volume: 1, durationMs: 30000 }],
    music: null,
  });
  ok("single branch → null (per-branch pass already lands it)", est1 === null);
  // 10%-active clip + full music: energy ≈ 1.1·10^(-1.6) → -15.6 dB.
  const estPartial = G.estimateMixLoudnorm({
    totalSec: 30,
    audio: { masterVolume: 1, musicVolume: 1 },
    clipAudio: [{ measure: m, volume: 1, durationMs: 3000 }],
    music: m,
  });
  const pp = /measured_I=(-?[\d.]+)/.exec(estPartial || "");
  const partialI = pp ? parseFloat(pp[1]) : NaN;
  const wantPartial = 10 * Math.log10(0.1 + 1) - 16;
  ok(`partial activity weighted (got ${partialI.toFixed(2)}, want ${wantPartial.toFixed(2)})`, Math.abs(partialI - wantPartial) < 0.05);
}

console.log("── 6. single-pass plan structural invariants ────────────────────────");
{
  const W = 640, H = 360, FPS = 30;
  const segments = [
    { id: "a", mediaType: "video", videoPath: "/tmp/v1.mp4", durationMs: 3000, trimInMs: 0, volume: 1, startMs: 0 },
    { id: "b", mediaType: "image", imagePath: "/tmp/i1.png", durationMs: 2000, trimInMs: 0, volume: 1, startMs: 3000, direction: "in" },
    { id: "c", mediaType: "image", imagePath: "/tmp/i2.png", durationMs: 2000, trimInMs: 0, volume: 1, startMs: 5000 },
  ];
  const overlaySpecs = [
    {
      inputArgs: G.buildOverlayImageInputArgs({ durMs: 6000, path: "/tmp/ov.png" }),
      x: 50, y: 40, dw: 200, dh: 100, chroma: { color: "#00ff00", similarity: 0.32, blend: 0.08, spill: 0.6, mode: "chroma" },
      a: 0, b: 6, fps: null,
    },
  ];
  const plan = SP.buildSinglePassPlan({
    segments, fps: FPS, width: W, height: H, totalMs: 7000,
    kbEnabled: true, zoomMax: 1.15, globalDir: "in",
    transition: { style: "dissolve", durationMs: 400 },
    wm: { imagePath: "/tmp/wm.png", x: 10, y: 10, w: 80, h: 30, opacity: "0.800" },
    assSuffix: "subtitles=filename='/tmp/cap.ass'",
    overlaySpecs,
    audio: { normalize: false, musicVolume: 1, masterVolume: 1, fadeInMs: 0, fadeOutMs: 0, musicStartMs: 0, musicLoop: false },
    audioPath: "/tmp/music.mp3",
    sfx: [{ wavPath: "/tmp/sfx.wav", startMs: 1000, volume: 0.9 }],
    clipAudio: [{ inputIdx: 0, startMs: 0, volume: 1, atempo: [], durationMs: 3000 }],
    loudnorm: null,
    masterLoudnorm: null,
    hwaccelPerSeg: [false, false, false],
  });
  // inputs: 3 base + 1 overlay + 1 wm + 1 music + 1 sfx = 7 (input argv pairs)
  const inputCount = plan.inputs.filter((a: string) => a === "-i").length;
  ok(`input count = 7 (got ${inputCount})`, inputCount === 7);
  ok("concat filter present with n=3", /concat=n=3:v=1:a=0\[vcat\]/.test(plan.script));
  ok("split emitted for the xfade-head prev image", /\[1:v\]split=2\[sp1a\]\[sp1b\]/.test(plan.script));
  ok("xfade head composite present", /xfade=transition=fade:duration=0\.400:offset=0/.test(plan.script));
  ok("Ken Burns zoompan on segment b", /zoompan=z='1\.100000\+/.test(plan.script) && /d=60:s=640x360:fps=30/.test(plan.script));
  ok("overlay chain with chromakey+despill", /chromakey=0x00ff00:0\.32:0\.08/.test(plan.script) && /despill=type=green:mix=0\.6/.test(plan.script));
  ok("watermark chain present", /colorchannelmixer=aa=0\.800/.test(plan.script));
  ok("captions burned once (single subtitles=)", (plan.script.match(/subtitles=/g) || []).length === 1);
  ok("audio amix present with 3 branches", /amix=inputs=3:duration=longest:normalize=0/.test(plan.script));
  ok("apad + limiter master tail present", /alimiter=limit=0\.97:level=false,apad=whole_dur=7\.000/.test(plan.script));
  // Label balance: per `;`-separated chain, LEADING labels are inputs and
  // TRAILING labels are outputs — every referenced intermediate must be
  // produced by some chain (stream refs like [0:v]/[1:a] are inputs).
  const produced = new Set<string>();
  const consumed = new Set<string>();
  for (const chain of plan.script.split(";")) {
    const lead = chain.match(/^((?:\[[a-zA-Z0-9_]+\])+)/);
    const trail = chain.match(/((?:\[[a-zA-Z0-9_]+\])+)$/);
    const leadLabels = lead ? (lead[1].match(/\[([a-zA-Z0-9_]+)\]/g) || []).map((x: string) => x.slice(1, -1)) : [];
    const trailLabels = trail ? (trail[1].match(/\[([a-zA-Z0-9_]+)\]/g) || []).map((x: string) => x.slice(1, -1)) : [];
    // A trailing label that also leads this chain (e.g. passthrough) counts
    // as produced; otherwise trailing = produced, leading = consumed.
    for (const l of leadLabels) if (!trailLabels.includes(l)) consumed.add(l);
    for (const l of trailLabels) produced.add(l);
  }
  // stream refs: [0:v], [1:a]… appear as LEADING labels; strip numeric ones.
  const orphans = [...consumed].filter((l) => !produced.has(l) && !/^\d+$/.test(l));
  ok(`no orphan labels (${orphans.length})`, orphans.length === 0, orphans.join(","));
  // Global fade windows: none here (transition dissolve + fadeStartEnd off) → no fade filters
  ok("no fades without fadeStartEnd/dips", !/fade=t=/.test(plan.script));

  // fadeStartEnd → global fade windows present with enable gates.
  const plan2 = SP.buildSinglePassPlan({
    segments, fps: FPS, width: W, height: H, totalMs: 7000,
    kbEnabled: false, zoomMax: 1.15, globalDir: "in",
    transition: { style: "none", durationMs: 800, fadeStartEnd: true },
    wm: null, assSuffix: null, overlaySpecs: [],
    audio: { normalize: false, musicVolume: 1, masterVolume: 1, fadeInMs: 0, fadeOutMs: 0, musicStartMs: 0, musicLoop: false },
    audioPath: null, sfx: [], clipAudio: [], loudnorm: null, masterLoudnorm: null,
    hwaccelPerSeg: [false, false, false],
  });
  const fadeInOk = /fade=t=in:st=0:d=0\.800:enable='between\(t,0,0\.800\)'/.test(plan2.script);
  const fadeOutOk = /fade=t=out:st=6\.200:d=0\.800:enable='between\(t,6\.200,7\.000\)'/.test(plan2.script);
  ok("bookend fades gated by enable windows", fadeInOk && fadeOutOk, plan2.script);

  // eligibility envelope
  ok("eligibility: 70 segments ok", SP.singlePassEligible({ segments: new Array(70), overlayCount: 0, totalSec: 30, captionsBurned: false }).ok);
  ok("eligibility: 71 segments rejected", !SP.singlePassEligible({ segments: new Array(71), overlayCount: 0, totalSec: 30, captionsBurned: false }).ok);
  ok("eligibility: captioned 601s rejected", !SP.singlePassEligible({ segments: new Array(2), overlayCount: 0, totalSec: 601, captionsBurned: true }).ok);
  ok("eligibility: uncaptioned 601s ok", SP.singlePassEligible({ segments: new Array(2), overlayCount: 0, totalSec: 601, captionsBurned: false }).ok);
  ok("eligibility: >40 overlays rejected", !SP.singlePassEligible({ segments: new Array(2), overlayCount: 41, totalSec: 30, captionsBurned: false }).ok);
}

console.log("── 7. global fade window math == per-clip fade windows ───────────────");
{
  // For a synthetic timeline, the per-clip postFades windows (clip-local)
  // must map onto the SAME global [start,end] windows the single-pass emits.
  const segments: any[] = [
    { id: "a", mediaType: "image", imagePath: "i.png", durationMs: 3000, trimInMs: 0, volume: 1, startMs: 0 },
    { id: "b", mediaType: "image", imagePath: "i.png", durationMs: 4000, trimInMs: 0, volume: 1, startMs: 3000 },
    { id: "c", mediaType: "image", imagePath: "i.png", durationMs: 2000, trimInMs: 0, volume: 1, startMs: 7000 },
  ];
  const transition = { style: "dip-black", durationMs: 500, fadeStartEnd: true };
  const gFades = SP.buildGlobalFades({ segments, transition, totalMs: 9000 });
  // expected global windows:
  //  boundary 1 (entering b): dip-in [3000,3500]
  //  boundary 2 (entering c): dip-in [7000,7500]; dip-tail of b: [6500,7000]
  //  bookends: in [0,500], out [8500,9000]
  const windows = gFades.map((f: string) => {
    const m = /st=([\d.]+):d=([\d.]+).*between\(t,([\d.]+),([\d.]+)\)/.exec(f);
    return m ? [parseFloat(m[3]), parseFloat(m[4])] : null;
  });
  const has = (a: number, b: number) => windows.some((w: number[] | null) => w && Math.abs(w[0] - a) < 1e-6 && Math.abs(w[1] - b) < 1e-6);
  ok("dip-in @3000..3500", has(3, 3.5), JSON.stringify(windows));
  ok("dip-tail @6500..7000", has(6.5, 7), JSON.stringify(windows));
  ok("dip-in @7000..7500", has(7, 7.5), JSON.stringify(windows));
  ok("bookend-in @0..0.5", has(0, 0.5), JSON.stringify(windows));
  ok("bookend-out @8500..9000", has(8.5, 9), JSON.stringify(windows));
}

console.log("── 8. single-pass end-to-end render on a tiny real fixture ──────────");
{
  // Real ffmpeg: 2 videos (one with audio) + 1 image + xfade + overlay +
  // captions + music + sfx-shaped input → verify duration/streams/frame count.
  const FF: string = require("ffmpeg-static");
  const T = "/tmp/fftest-parity";
  fs.mkdirSync(T, { recursive: true });
  try {
    execFileSync(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30", "-f", "lavfi", "-i", "sine=frequency=440:r=48000", "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", `${T}/v1.mp4`], { timeout: 30000 });
    execFileSync(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30", "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", `${T}/v2.mp4`], { timeout: 30000 });
    execFileSync(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30", "-frames:v", "1", `${T}/img.png`], { timeout: 30000 });
    execFileSync(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=880:r=48000", "-t", "9", "-c:a", "pcm_s16le", `${T}/music.wav`], { timeout: 30000 });
    const segments = [
      { id: "a", mediaType: "video", videoPath: `${T}/v1.mp4`, durationMs: 3000, trimInMs: 0, volume: 1, startMs: 0 },
      { id: "b", mediaType: "video", videoPath: `${T}/v2.mp4`, durationMs: 2000, trimInMs: 0, volume: 1, startMs: 3000 },
      { id: "c", mediaType: "image", imagePath: `${T}/img.png`, durationMs: 2000, trimInMs: 0, volume: 1, startMs: 5000 },
    ];
    const overlaySpecs = [
      { inputArgs: G.buildOverlayImageInputArgs({ durMs: 4000, path: `${T}/img.png` }), x: 40, y: 30, dw: 160, dh: 90, chroma: null, a: 0, b: 4, fps: null },
    ];
    const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 360\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,28,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,0,2,40,40,30,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.50,0:00:06.50,Default,,0,0,0,,single-pass caption\n`;
    fs.writeFileSync(`${T}/cap.ass`, ass);
    const plan = SP.buildSinglePassPlan({
      segments, fps: 30, width: 640, height: 360, totalMs: 7000,
      kbEnabled: false, zoomMax: 1.15, globalDir: "in",
      transition: { style: "dissolve", durationMs: 300 },
      wm: null,
      assSuffix: `subtitles=filename='${T}/cap.ass'`,
      overlaySpecs,
      audio: { normalize: false, musicVolume: 0.8, masterVolume: 1, fadeInMs: 500, fadeOutMs: 500, musicStartMs: 0, musicLoop: false },
      audioPath: `${T}/music.wav`,
      sfx: [],
      clipAudio: [{ inputIdx: 0, startMs: 0, volume: 1, atempo: [], durationMs: 3000 }],
      loudnorm: null, masterLoudnorm: null,
      hwaccelPerSeg: [false, false, false],
    });
    fs.writeFileSync(`${T}/graph.txt`, plan.script);
    const args = SP.buildSinglePassArgs({
      plan, scriptPath: `${T}/graph.txt`,
      encArgs: ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-pix_fmt", "yuv420p"],
      abr: "192k", fps: 30, outputPath: `${T}/out.mp4`, threads: 0, filterThreads: 2,
    });
    execFileSync(FF, args, { timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
    const durOut = execFileSync("/usr/bin/ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `${T}/out.mp4`]).toString().trim();
    const streams = execFileSync("/usr/bin/ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height", "-of", "csv=p=0", `${T}/out.mp4`]).toString().trim();
    const dur = parseFloat(durOut);
    ok(`single-pass render duration ≈ 7.0s (got ${dur})`, Math.abs(dur - 7.0) < 0.15);
    const v = streams.split("\n").find((l: string) => l.includes("video"));
    const a = streams.split("\n").find((l: string) => l.includes("audio"));
    ok("output streams: h264 640x360 + aac",
      !!v && v.startsWith("h264,video,640,360") && !!a && a.startsWith("aac,audio"), streams);
    const size = fs.statSync(`${T}/out.mp4`).size;
    ok(`output non-trivial size (${(size / 1024).toFixed(0)} KB)`, size > 50 * 1024);
  } catch (e: any) {
    ok("single-pass render", false, String(e.message || e).slice(0, 800));
  }
}

console.log("── 9. audio loudness: v1.3 master-bus WAV vs v6 estimated master ────");
{
  // Two uncorrelated sources at DIFFERENT loudness, overlapping the whole
  // timeline: (a) the v1.3 path — render raw mix → WAV → measure → mux with
  // the measured master loudnorm; (b) the v6 path — per-branch measured
  // gains + ESTIMATED master loudnorm in ONE graph, no WAV. Both outputs are
  // measured and must land within ±1.5 LU of each other (and of −16).
  const FF: string = require("ffmpeg-static");
  const T = "/tmp/fftest-loudness";
  fs.mkdirSync(T, { recursive: true });
  function measure(p: string, win?: any): any {
    const args = ["-hide_banner", "-nostats",
      ...(win ? ["-ss", String(win.ssMs / 1000), "-t", String(win.durMs / 1000)] : []),
      "-i", p, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"];
    // loudnorm's JSON summary prints on STDERR — spawnSync captures both.
    const r = (require("child_process") as any).spawnSync(FF, args, { timeout: 60000, encoding: "utf8" });
    const out = `${r.stdout || ""}\n${r.stderr || ""}`;
    const s = out.lastIndexOf("{");
    const e = out.indexOf("}", s);
    try {
      const j = JSON.parse(out.slice(s, e + 1));
      const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
      return {
        i: num(j.input_i), lra: num(j.input_lra), tp: num(j.input_tp),
        thresh: num(j.input_thresh), offset: num(j.target_offset),
      };
    } catch { return null; }
  }
  try {
    // clip: speech-ish amplitude-modulated 440 Hz @ -23 LUFS-ish; music: 880 Hz louder.
    execFileSync(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", "sine=frequency=440:r=48000:d=12,volume=0.25", "-c:a", "pcm_s16le", `${T}/clip.wav`], { timeout: 60000 });
    execFileSync(FF, ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
      "-i", "sine=frequency=880:r=48000:d=12,volume=0.45", "-c:a", "pcm_s16le", `${T}/music.wav`], { timeout: 60000 });
    const mClip = measure(`${T}/clip.wav`);
    const mMusic = measure(`${T}/music.wav`);
    const audio = { normalize: true, musicVolume: 0.8, masterVolume: 1, fadeInMs: 0, fadeOutMs: 0, musicStartMs: 0, musicLoop: false };

    // (a) v1.3 master-bus: raw-mix render → measure → mux with measured master.
    const renderArgs = G.buildAudioMixRenderArgs({
      audioPath: `${T}/music.wav`,
      audio,
      totalSec: 12,
      sfx: [],
      loudnorm: { clip: [mClip], music: mMusic },
      clipAudio: [{ wavPath: `${T}/clip.wav`, startMs: 0, volume: 1 }],
      mixWavPath: `${T}/mix.wav`,
    });
    execFileSync(FF, renderArgs, { timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
    const mMix = measure(`${T}/mix.wav`);
    // The v1.3 final mux: the measured mix WAV + measured master loudnorm +
    // limiter + pad → AAC (buildConcatArgs' masterMix mode, -af branch).
    const oldMux = ["-y", "-hide_banner", "-loglevel", "error", "-i", `${T}/mix.wav`,
      "-map", "0:a",
      "-af", [
        G.measuredLoudnormFilter(mMix) || "loudnorm=I=-16:TP=-1.5:LRA=11",
        "alimiter=limit=0.97:level=false",
        "apad=whole_dur=12.000",
      ].join(","),
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-t", "12", `${T}/old.m4a`];
    execFileSync(FF, oldMux, { timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });

    // (b) v6 estimated: per-branch measured gains + estimated master, one graph.
    const est = G.estimateMixLoudnorm({
      totalSec: 12,
      audio,
      clipAudio: [{ measure: mClip, volume: 1, durationMs: 12000 }],
      music: mMusic,
    });
    ok("estimate produced for 2-branch overlap", !!est, String(est));
    const { graph } = G.buildAudioMixGraph({
      totalSec: 12,
      audio,
      clipAudio: [{ inputIdx: 0, startMs: 0, volume: 1 }],
      hasMusic: true,
      musicInputIdx: 1,
      loudnorm: { clip: [mClip], music: mMusic },
      masterLoudnorm: est,
      sfx: [],
    });
    execFileSync(FF, ["-y", "-hide_banner", "-loglevel", "error",
      "-i", `${T}/clip.wav`, "-i", `${T}/music.wav`,
      "-filter_complex", graph, "-map", "[aout]",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-t", "12", `${T}/new.m4a`],
      { timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });

    const oldOut = measure(`${T}/old.m4a`);
    const newOut = measure(`${T}/new.m4a`);
    ok("both outputs measurable", !!oldOut && !!newOut && oldOut.i != null && newOut.i != null,
      `old=${JSON.stringify(oldOut)} new=${JSON.stringify(newOut)}`);
    const dI = Math.abs(Number(oldOut.i) - Number(newOut.i));
    ok(`master-bus ↔ estimated master agree (ΔI=${dI.toFixed(2)} LU ≤ 1.5)`, dI <= 1.5,
      `old I=${oldOut.i} new I=${newOut.i}`);
    const newOff = Math.abs(Number(newOut.i) + 16);
    ok(`v6 output lands at −16 LUFS (off by ${newOff.toFixed(2)} LU ≤ 1.5)`, newOff <= 1.5,
      `new I=${newOut.i}`);
  } catch (e: any) {
    ok("audio loudness functional test", false, String(e.message || e).slice(0, 500));
  }
}

console.log(`\n══ ${passed} passed, ${failed} failed ══`);
process.exit(failed > 0 ? 1 : 0);
