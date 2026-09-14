#!/usr/bin/env node
/**
 * v1.4.1 verification harness — keyframe-aligned stream-copy trims +
 * per-overlay fps normalization. Exercises the REAL export-graph.js
 * helpers against real ffmpeg runs (not mocks):
 *   1. clipNeedsReEncode: trimKeyAligned gate (pure)
 *   2. buildStreamCopyArgs: argv shape + byte-identical legacy path
 *   3. Real copy cut at an aligned keyframe (duration + first frame key)
 *   4. Real copy cut from a NON-aligned trim stays on the encode path
 *   5. Probe argv + regex parse (findKeyframeAlignedStart replica)
 *   6. buildOverlayChain: fps normalization chain + real composite run
 * Run: node scripts/verify-kf-trims.js
 */
const path = require("path");
const { spawnSync } = require("child_process");
const G = require(path.join(__dirname, "..", "electron", "export-graph.js"));

const FF = require(path.join(__dirname, "..", "node_modules", "ffmpeg-static"));
const TMP = "/tmp/kfv";
let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};

/** spawnSync: ALWAYS returns {stdout, stderr} merged (showinfo logs on
 * stderr; execFileSync would swallow it on success). Mirrors main.js's
 * ffmpegCapture (both streams → `out`). */
function runErr(args) {
  const r = spawnSync(FF, args, { encoding: "utf8" });
  return (r.stdout || "") + (r.stderr || "");
}
function run(args) {
  const r = spawnSync(FF, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(" ")} → ${r.status}: ${(r.stderr || "").slice(-400)}`);
  return (r.stdout || "") + (r.stderr || "");
}
function probeDur(p) { const o = runErr(["-hide_banner", "-i", p]); const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(o); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : -1; }
function keyframePts(p) { const o = runErr(["-hide_banner", "-skip_frame", "nokey", "-i", p, "-vf", "showinfo", "-f", "null", "-"]); return [...o.matchAll(/pts_time:(\d+(?:\.\d+)?)/g)].map((m) => parseFloat(m[1])); }

// ── fixture: 30fps 6s 320x180 h264 yuv420p, forced keyframes at 0/2/4 ──
const SRC = `${TMP}/src.mp4`;
run(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=6:size=320x180:rate=30",
  "-c:v", "libx264", "-preset", "ultrafast", "-g", "60", "-keyint_min", "60", "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-y", SRC]);

console.log("1) clipNeedsReEncode — trimKeyAligned gate");
const baseSeg = { mediaType: "video", videoPath: SRC, trimInMs: 2000, durationMs: 3000, speed: 1 };
const ctxBase = { i: 0, seg: baseSeg, segments: [baseSeg], transition: { style: "none", durationMs: 0 }, overlayCount: 0, assSuffix: null, wm: null };
ok("trim 2000ms without alignment → re-encode (legacy behavior)", G.clipNeedsReEncode(ctxBase) === true);
ok("trim 2000ms WITH alignment → copy-eligible", G.clipNeedsReEncode({ ...ctxBase, trimKeyAligned: true }) === false);
ok("trim 0 unchanged → copy-eligible", G.clipNeedsReEncode({ ...ctxBase, seg: { ...baseSeg, trimInMs: 0 } }) === false);
ok("aligned trim + overlay → still re-encode", G.clipNeedsReEncode({ ...ctxBase, trimKeyAligned: true, overlayCount: 1 }) === true);
ok("aligned trim + speed → still re-encode", G.clipNeedsReEncode({ ...ctxBase, trimKeyAligned: true, seg: { ...baseSeg, speed: 2 } }) === true);

console.log("2) buildStreamCopyArgs — argv shape + legacy byte-parity");
const legacy = G.buildStreamCopyArgs({ path: SRC, durMs: 3000, clipPath: `${TMP}/c0.mp4` });
ok("no ss → legacy argv exactly", JSON.stringify(legacy) === JSON.stringify(["-t", "3.000", "-i", SRC, "-c:v", "copy", "-an", "-avoid_negative_ts", "make_zero", "-y", `${TMP}/c0.mp4`]), JSON.stringify(legacy));
const withSs = G.buildStreamCopyArgs({ path: SRC, durMs: 3000, clipPath: `${TMP}/c1.mp4`, ss: "2" });
ok("ss prepends -ss <str> -noaccurate_seek before -i", withSs[0] === "-ss" && withSs[1] === "2" && withSs[2] === "-noaccurate_seek" && withSs[3] === "-t", JSON.stringify(withSs));
ok("ss garbage string ignored → legacy argv", G.buildStreamCopyArgs({ path: SRC, durMs: 3000, clipPath: "x", ss: "2;rm -rf" }).indexOf("-noaccurate_seek") === -1);
ok("ss number ignored (string required)", G.buildStreamCopyArgs({ path: SRC, durMs: 3000, clipPath: "x", ss: 2 }).indexOf("-ss") === -1);

console.log("3) real copy cut at aligned keyframe (ss=\"2\", dur 3000ms)");
const CUT = `${TMP}/cut_aligned.mp4`;
run(withSs.slice(0, -1).concat(["-y", CUT]));
const d = probeDur(CUT);
const kf = keyframePts(CUT);
ok("duration exactly 3.00s", Math.abs(d - 3.0) < 0.02, `dur=${d}`);
ok("first packet is a keyframe at pts 0 (standalone-decodable head)", kf.length > 0 && kf[0] === 0, JSON.stringify(kf));
ok("next keyframe lands at 2.0 (GOP cadence preserved)", kf.includes(2), JSON.stringify(kf));

console.log("4) probe replica — findKeyframeAlignedStart argv + parse (main.js logic)");
function parseKeyframeSecs(out) {
  const kfs = []; const re = /pts_time:(\d+(?:\.\d+)?)/g; const text = String(out || ""); let m;
  while ((m = re.exec(text))) { const v = parseFloat(m[1]); if (Number.isFinite(v)) kfs.push({ s: m[1], ms: v * 1000 }); }
  return kfs;
}
function probeWindow(trimMs) {
  const ss = Math.max(0, (trimMs - 2500) / 1000).toFixed(3);
  const r = runErr(["-hide_banner", "-nostats", "-copyts", "-ss", ss, "-noaccurate_seek", "-t", "5",
    "-skip_frame", "nokey", "-i", SRC, "-map", "0:v:0", "-vf", "showinfo", "-f", "null", "-"]);
  const kfs = parseKeyframeSecs(r);
  let best = null, bestD = Infinity;
  for (const k of kfs) { const dd = Math.abs(k.ms - trimMs); if (dd < bestD) { bestD = dd; best = k; } }
  const tolMs = Math.min(50, Math.max(10, Math.round(1000 / 30)));
  return best && bestD <= tolMs ? { ss: best.s, deltaMs: Math.round(best.ms - trimMs) } : null;
}
const a1 = probeWindow(2000);
ok("trim 2000ms → aligned at keyframe \"2\"", !!a1 && a1.ss === "2" && a1.deltaMs === 0, JSON.stringify(a1));
const a2 = probeWindow(2500);
ok("trim 2500ms → NOT aligned (nearest kf 500ms away)", a2 === null, JSON.stringify(a2));
const a3 = probeWindow(2030);
ok("trim 2030ms → aligned (delta 30ms = 1 frame)", !!a3 && a3.ss === "2" && Math.abs(a3.deltaMs) <= 30, JSON.stringify(a3));
const a4 = probeWindow(1975);
ok("trim 1975ms → aligned from BELOW (delta −25ms)", !!a4 && a4.ss === "2" && a4.deltaMs === 25, JSON.stringify(a4));
const a5 = probeWindow(60);
ok("trim 60ms → NOT aligned (kf0 is 60ms off, tol 33ms)", a5 === null, JSON.stringify(a5));

console.log("5) copy cut from a sub-frame-off trim (ss=\"2\", dur from trim 2030 → dur 2970)");
const CUT2 = `${TMP}/cut_2030.mp4`;
run(G.buildStreamCopyArgs({ path: SRC, durMs: 2970, clipPath: CUT2, ss: "2" }));
const d2 = probeDur(CUT2);
ok("duration 2.97s ± one packet-granularity frame", d2 >= 2.94 && d2 <= 3.01, `dur=${d2}`);

console.log("6) buildOverlayChain — fps normalization");
const noFps = G.buildOverlayChain({ inputIdx: 1, dw: 160, dh: 90, a: 0.5 });
ok("no fps → legacy chain (no fps= filter)", !/fps=/.test(noFps), noFps);
const withFps = G.buildOverlayChain({ inputIdx: 1, dw: 160, dh: 90, a: 0.5, fps: 30 });
ok("fps first, before scale", /^\[1:v\]fps=30,scale=160:90/.test(withFps), withFps);
ok("setpts still last", /setpts=PTS\+0\.500\/TB\[ovl1\]$/.test(withFps), withFps);
// real composite: 30fps base + 60fps overlay normalized to 30
const OV60 = `${TMP}/ov60.mp4`;
run(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x180:rate=60", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", OV60]);
const COMP = `${TMP}/comp.mp4`;
const chain = G.buildOverlayChain({ inputIdx: 1, dw: 160, dh: 90, a: 0, fps: 30 });
// buildOverlayFilter already embeds accLabel — do NOT prefix it again.
const ovf = G.buildOverlayFilter({ accLabel: "[base]", inputIdx: 1, x: 10, y: 10, a: 0, b: 3, outLabel: "[vout]" });
const graph = `[0:v]scale=320:180,setsar=1,format=yuv420p[base];${chain};${ovf}`;
run(["-hide_banner", "-loglevel", "error", "-i", SRC, "-t", "3", "-i", OV60,
  "-filter_complex", graph, "-map", "[vout]", "-r", "30", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", COMP]);
const compO = runErr(["-hide_banner", "-i", COMP]);
ok("60fps overlay + fps=30 chain composite runs clean", /Stream #0:0.*30 fps/.test(compO), (compO.match(/Stream #0:0[^\n]*/) || [""])[0]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
