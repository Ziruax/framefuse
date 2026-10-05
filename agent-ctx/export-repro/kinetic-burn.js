#!/usr/bin/env node
// Burn the kinetic ASS (via the REAL electron/kinetic-ass.js emitter) with
// real ffmpeg + the bundled fonts, at chosen timestamps → PNGs for inspection.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const KineticASS = require("/home/z/my-project/electron/kinetic-ass.js");

const DIR = "/tmp/repro";
const payload = JSON.parse(fs.readFileSync(path.join(DIR, "kinetic-payload.json"), "utf8"));
const W = 1920, H = 1080;

function buildAssDoc(scenario) {
  const { settings, compositions, geometry } = payload[scenario];
  const win = { winStart: 0, winEnd: Infinity, clampDur: Infinity };
  const kinetic = KineticASS.emitKineticCompositions({
    compositions,
    geometry,
    settings,
    textColor: "#FFFFFF",
    width: W,
    height: H,
    ...win,
  });
  const lines = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 1",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...kinetic.styleLines,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...kinetic.eventLines,
  ];
  return { ass: lines.join("\n"), count: kinetic.count, styles: kinetic.styleLines.length };
}

const scenarios = ["auto", "kinetic-sentence", "punch-stack", "word-cascade", "rapid-stack", "highlight-stack"];
const frames = [];
for (const sc of scenarios) {
  const { ass, count, styles } = buildAssDoc(sc);
  const assPath = path.join(DIR, `kinetic-${sc}.ass`);
  fs.writeFileSync(assPath, ass, "utf8");
  console.log(`${sc}: ${count} Dialogue events, ${styles} styles → ${assPath}`);
  // burn frames: first composition mid-entrance + settled
  const comp0 = payload[sc].compositions[0];
  const presets = payload[sc].compositions.map((c) => c.presetId);
  for (const [tag, tMs] of [
    ["enter", comp0.startMs + 350],
    ["settled", comp0.startMs + 1500],
  ]) {
    const out = path.join(DIR, `frame-${sc}-${tag}.png`);
    try {
      execFileSync("/usr/bin/ffmpeg", [
        "-hide_banner", "-loglevel", "error",
        "-ss", (tMs / 1000).toFixed(3),
        "-f", "lavfi", "-i", `color=c=0x1a1a2e:s=${W}x${H}:r=5`,
        "-vf", `ass=${assPath}:fontsdir=/home/z/my-project/public/fonts`,
        "-frames:v", "1", "-y", out,
      ], { stdio: ["ignore", "pipe", "pipe"] });
      frames.push({ scenario: sc, tag, tMs, out, presets: presets.join(",") });
      console.log(`  frame ${tag} @${tMs}ms → ${out}`);
    } catch (e) {
      console.error(`  FRAME FAILED ${sc} ${tag}: ${e.stderr || e.message}`);
    }
  }
}
fs.writeFileSync(path.join(DIR, "frames.json"), JSON.stringify(frames, null, 2));
console.log("\nframes.json written:", frames.length, "frames");
