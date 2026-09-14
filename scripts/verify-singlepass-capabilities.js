// scripts/verify-singlepass-capabilities.js
// Capability + parity tests for the v6 single-pass export design.
//  1. scale eval=frame + per-frame crop → zoompan Ken Burns geometry parity
//  2. -filter_complex_script file support
//  3. xfade offset=0 head composite + concat filter in one graph
//  4. bounded looped image inputs (-loop 1 -framerate -t) inside one graph
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const FF = require("ffmpeg-static");

const T = "/tmp/fftest";
fs.mkdirSync(T, { recursive: true });

function run(args, label) {
  try {
    execFileSync(FF, args, { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch (e) {
    console.error(`✗ ${label}: ${String(e.stderr).slice(-600)}`);
    return false;
  }
}

// ── fixture: one 1280x720 test frame ──────────────────────────────────────
if (!run(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30", "-frames:v", "1", `${T}/src.png`], "fixture")) process.exit(1);

const W = 1280, H = 720, FPS = 30, FRAMES = 60;
const SW = Math.round(W * 1.1), SH = Math.round(H * 1.1);
const zoomMax = 1.06 + (50 / 100) * 0.18; // intensity 50
const zBase = 1.1, zMaxEff = (1.1 * zoomMax).toFixed(6), spanEff = (1.1 * zoomMax - 1.1).toFixed(6);

// zoompan (CURRENT export math): on-based
const tOn = `on/${FRAMES - 1}`;
const easeOn = `-((cos(PI*${tOn})-1)/2)`;
const zOn = `${zBase.toFixed(6)}+(${easeOn})*${spanEff}`;
const xCenterOn = "iw/2-(iw/zoom/2)";
const yCenterOn = "ih/2-(ih/zoom/2)";

// scale+crop replacement: t-based (t = on/fps), crop coords per derived mapping
//   x' = W·(z−1)/2  (center), max x' = W·(z−1)  — derived from zoompan coord math
const tT = `(t*${FPS})/${FRAMES - 1}`;
const easeT = `-((cos(PI*${tT})-1)/2)`;
const zT = `${zBase.toFixed(6)}+(${easeT})*${spanEff}`;
const xC = `${W}*((${zT})-1)/2`;
const yC = `${H}*((${zT})-1)/2`;

const zpGraph = `[0:v]scale=${SW}:${SH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${SW}:${SH},zoompan=z='${zOn}':x='${xCenterOn}':y='${yCenterOn}':d=${FRAMES}:s=${W}x${H}:fps=${FPS},setsar=1,format=yuv420p[v]`;
const scGraph = `[0:v]scale=${SW}:${SH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${SW}:${SH},scale=w='${W}*(${zT})':h='${H}*(${zT})':eval=frame:flags=bicubic,crop=${W}:${H}:x='${xC}':y='${yC}',setsar=1,format=yuv420p[v]`;

console.log("── 1. zoompan vs scale+crop Ken Burns parity ──");
run(["-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-framerate", String(FPS), "-t", String(FRAMES / FPS), "-i", `${T}/src.png`, "-filter_complex", zpGraph, "-map", "[v]", "-frames:v", String(FRAMES), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", `${T}/kb_zoompan.mp4`], "zoompan render");
run(["-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-framerate", String(FPS), "-t", String(FRAMES / FPS), "-i", `${T}/src.png`, "-filter_complex", scGraph, "-map", "[v]", "-frames:v", String(FRAMES), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", `${T}/kb_scalecrop.mp4`], "scalecrop render");

// decode both to raw and diff
execFileSync(FF, ["-y", "-hide_banner", "-loglevel", "error", "-i", `${T}/kb_zoompan.mp4`, "-f", "rawvideo", "-pix_fmt", "gray", `${T}/a.raw`]);
execFileSync(FF, ["-y", "-hide_banner", "-loglevel", "error", "-i", `${T}/kb_scalecrop.mp4`, "-f", "rawvideo", "-pix_fmt", "gray", `${T}/b.raw`]);
const a = fs.readFileSync(`${T}/a.raw`), b = fs.readFileSync(`${T}/b.raw`);
let maxD = 0, sumD = 0, nDiff = 0;
const n = Math.min(a.length, b.length);
for (let i = 0; i < n; i++) { const d = Math.abs(a[i] - b[i]); if (d > 0) nDiff++; sumD += d; if (d > maxD) maxD = d; }
console.log(`   frames=${FRAMES} bytes=${n} maxDiff=${maxD} meanDiff=${(sumD / n).toFixed(4)} diffPix=${(100 * nDiff / n).toFixed(2)}%`);

console.log("── 2. filter_complex_script from file ──");
fs.writeFileSync(`${T}/graph.txt`, zpGraph.replace("[0:v]", "[0:v]"));
console.log(run(["-y", "-hide_banner", "-loglevel", "error", "-loop", "1", "-framerate", String(FPS), "-t", "1", "-i", `${T}/src.png`, "-filter_complex_script", `${T}/graph.txt`, "-map", "[v]", "-frames:v", "30", "-c:v", "libx264", "-preset", "ultrafast", `${T}/script.mp4`], "script") ? "   ok" : "   FAIL");

console.log("── 3. xfade head + concat filter in ONE graph (bounded inputs) ──");
// seg0: image A 1.0s static; seg1: image B 1.0s with xfade head 0.3s blending frozen A
const F = 0.3;
const g3 = [
  `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1,format=yuv420p[s0]`,
  // frozen end-state of A (static supersample zoom at z=1.1 → identity, static crop center)
  `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1,format=yuv420p[frz]`,
  `[1:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},setsar=1,format=yuv420p[s1raw]`,
  `[frz][s1raw]xfade=transition=fade:duration=${F}:offset=0[s1]`,
  `[s0][s1]concat=n=2:v=1:a=0[vcat]`,
].join(";");
console.log(run(["-y", "-hide_banner", "-loglevel", "error",
  "-loop", "1", "-framerate", String(FPS), "-t", "1.0", "-i", `${T}/src.png`,
  "-loop", "1", "-framerate", String(FPS), "-t", "1.0", "-i", `${T}/src.png`,
  "-filter_complex", g3, "-map", "[vcat]", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", `${T}/xfconcat.mp4`], "xfade+concat") ? "   ok" : "   FAIL");
// verify duration = 2.0s
try {
  const out = execFileSync(FF, ["-i", `${T}/xfconcat.mp4`, "-f", "null", "-"], { stdio: ["ignore", "pipe", "pipe"] }).toString();
} catch (e) { /* ffmpeg -i exits 1 with the banner on stderr — parse it */ }
const probe = require("child_process").spawnSync("/usr/bin/ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", `${T}/xfconcat.mp4`]).stdout.toString().trim();
console.log(`   concat duration = ${probe}s (expect ~2.0)`);

console.log("── 4. audio in the same graph (amix from video inputs + adelay + limiter) ──");
const g4 = `[0:a]volume=1,aformat=sample_rates=48000:channel_layouts=stereo,adelay=500|500[ca];[1:a]aformat=sample_rates=48000:channel_layouts=stereo[ma];[ca][ma]amix=inputs=2:duration=longest:normalize=0[mix];[mix]alimiter=limit=0.97:level=false,apad=whole_dur=4.000[aout]`;
console.log(run(["-y", "-hide_banner", "-loglevel", "error",
  "-f", "lavfi", "-i", "sine=frequency=440:r=48000:d=2",
  "-f", "lavfi", "-i", "sine=frequency=880:r=48000:d=3",
  "-filter_complex", g4,
  "-map", "[aout]", "-t", "4", "-c:a", "aac", "-b:a", "192k", `${T}/mix.m4a`], "amix") ? "   ok" : "   FAIL");

console.log("── 5. subtitles filter with full-timeline ASS on concatenated stream ──");
const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,54,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,0,2,40,40,50,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.50,0:00:01.50,Default,,0,0,0,,Hello single-pass\n`;
fs.writeFileSync(`${T}/cap.ass`, ass);
// captions ride as a SEPARATE chain after the concat label (`;[vcat]subtitles…`)
const g5 = g3 + `;[vcat]subtitles=filename='${T}/cap.ass'[vsub]`;
console.log(run(["-y", "-hide_banner", "-loglevel", "error",
  "-loop", "1", "-framerate", String(FPS), "-t", "1.0", "-i", `${T}/src.png`,
  "-loop", "1", "-framerate", String(FPS), "-t", "1.0", "-i", `${T}/src.png`,
  "-filter_complex", g5, "-map", "[vsub]", "-c:v", "libx264", "-preset", "ultrafast", `${T}/subs.mp4`], "subtitles on concat") ? "   ok" : "   FAIL");
console.log("done");
