// Build the kinetic IPC payload (compositions + measured geometry) using the
// REAL renderer engine + layout solver, with an Inter-like approximate text
// measure (no DOM in this harness). Dumps JSON for the ASS-emitter burn test.
import { buildKineticPlan, type KineticCueInput } from "../../src/lib/merger/kinetic/engine";
import { measureKineticPlanFor } from "../../src/lib/merger/kinetic/render";
import type { KineticCaptionSettings } from "../../src/lib/merger/kinetic/types";
// REAL font metrics extracted from the bundled TTFs (fontTools hmtx) — this
// mirrors what the DOM canvas ctx.measureText returns for the same fonts,
// so the geometry here == the geometry the real export measures.
import { writeFileSync, readFileSync } from "node:fs";
const FONT_TABLES: Record<string, { widths: Record<string, number> }> =
  JSON.parse(readFileSync("/tmp/repro/font-widths.json", "utf8"));

const FONT_FAMILY_OF: Record<string, string> = {
  inter: "Inter", roboto: "Roboto", montserrat: "Montserrat",
  bebas: "Bebas Neue", playfair: "Playfair Display",
};

function measureWithRealFont(text: string, weight: number, fontPx: number, stack: string): number {
  // resolve the family from the CSS stack (first bundled family wins)
  let family = "Inter";
  for (const [, fam] of Object.entries(FONT_FAMILY_OF)) {
    if (stack.includes(fam)) { family = fam; break; }
  }
  // nearest available weight file
  const available = Object.keys(FONT_TABLES)
    .filter((k) => k.startsWith(family.replace(" ", "")))
    .map((k) => Number(k.split("-")[1]))
    .filter((n) => Number.isFinite(n));
  const w = available.length
    ? available.reduce((a, b) => (Math.abs(b - weight) < Math.abs(a - weight) ? b : a))
    : 400;
  const key = `${family.replace(" ", "")}-${w}`;
  const table = FONT_TABLES[key]?.widths || FONT_TABLES["Inter-400"].widths;
  let em = 0;
  for (const ch of text) {
    if (ch in table) em += table[ch];
    else if (/[A-Z]/.test(ch)) em += 0.68;
    else if (/[a-z0-9]/.test(ch)) em += 0.54;
    else em += 0.4;
  }
  return em * fontPx;
}

// Realistic Groq-style cues: ~2.5 words/sec, emotional narration mix
function mkCue(startSec: number, words: [string, number][]): KineticCueInput {
  let t = startSec * 1000;
  const ws = words.map(([text, dur]) => {
    const w = { text, startMs: Math.round(t), endMs: Math.round(t + dur * 1000) };
    t += dur * 1000 + 60;
    return w;
  });
  const end = ws[ws.length - 1].endMs;
  return { startMs: ws[0].startMs, endMs: end, text: words.map((w) => w[0]).join(" "), words: ws };
}

const cues: KineticCueInput[] = [
  mkCue(0.5, [["She", 0.3], ["never", 0.34], ["believed", 0.5], ["the", 0.2], ["secret", 0.44], ["could", 0.28], ["stay", 0.32], ["hidden", 0.46], ["forever", 0.5]]),
  mkCue(6.2, [["That", 0.24], ["night", 0.3], ["everything", 0.5], ["changed", 0.4], ["when", 0.26], ["the", 0.2], ["phone", 0.34], ["finally", 0.36], ["rang", 0.3]]),
  mkCue(11.0, [["He", 0.26], ["realized", 0.42], ["the", 0.2], ["truth", 0.36], ["was", 0.24], ["always", 0.34], ["right", 0.28], ["there", 0.32], ["in", 0.2], ["front", 0.3], ["of", 0.2], ["him", 0.26]]),
  mkCue(16.5, [["Nobody", 0.4], ["understood", 0.5], ["why", 0.3], ["she", 0.26], ["left", 0.28], ["the", 0.2], ["house", 0.34], ["alone", 0.36], ["that", 0.24], ["cold", 0.28], ["morning", 0.4]]),
];

const scenarios: { name: string; settings: Partial<KineticCaptionSettings> }[] = [
  { name: "auto", settings: {} }, // default auto mode — the real default flow
  { name: "kinetic-sentence", settings: { mode: "single", presetId: "kinetic-sentence" } },
  { name: "punch-stack", settings: { mode: "single", presetId: "punch-stack" } },
  { name: "word-cascade", settings: { mode: "single", presetId: "word-cascade" } },
  { name: "rapid-stack", settings: { mode: "single", presetId: "rapid-stack" } },
  { name: "highlight-stack", settings: { mode: "single", presetId: "highlight-stack" } },
];

const base: KineticCaptionSettings = {
  enabled: true,
  mode: "auto",
  presetId: "editorial-stack",
  manualMix: [
    { presetId: "editorial-stack", weight: 20 },
    { presetId: "kinetic-sentence", weight: 20 },
    { presetId: "highlight-stack", weight: 20 },
    { presetId: "punch-stack", weight: 15 },
  ],
  variation: "high",
  intensity: "auto",
  density: "auto",
  motion: "dynamic",
  seed: 1337,
  fontOverride: null,
  accentOverride: null,
};

const out: Record<string, unknown> = {};
for (const sc of scenarios) {
  const settings: KineticCaptionSettings = { ...base, ...sc.settings } as KineticCaptionSettings;
  const plan = buildKineticPlan(cues, settings);
  const geometry = measureKineticPlanFor(
    plan,
    settings,
    { fontSizeScale: 1, customColor: null, fontOverride: null, accentOverride: null },
    1920,
    1080,
    (text, weight, fontPx, stack) => measureWithRealFont(text, weight, fontPx, stack),
  );
  const compositions = plan.compositions.map((comp) => ({
    presetId: comp.presetId,
    classification: comp.classification,
    intensity: comp.intensity,
    startMs: comp.startMs,
    endMs: comp.endMs,
    words: comp.words.map((w) => ({
      text: w.text, startMs: w.startMs, endMs: w.endMs,
      role: w.role, emphasis: w.emphasis, phraseIndex: w.phraseIndex,
    })),
    phrases: comp.phrases.map((p) => ({
      role: p.role, scale: p.scale, weight: p.weight, align: p.align, indentFrac: p.indentFrac,
    })),
  }));
  out[sc.name] = { settings, compositions, geometry };
  console.log(
    `${sc.name}: ${compositions.length} compositions, ${geometry?.length ?? 0} geo — presets:`,
    compositions.map((c) => `${c.presetId}[${c.startMs}-${c.endMs}]`).join(" "),
  );
  if (sc.name === "auto" && geometry) {
    for (const g of geometry) {
      for (const w of g.words.slice(0, 6)) {
        console.log(`  geo word "${w.text}" x=${w.x} y=${w.y} w=${w.w} h=${w.h} fontPx=${w.fontPx} emph=${w.emphasis} role=${w.role}`);
      }
    }
  }
}

writeFileSync("/tmp/repro/kinetic-payload.json", JSON.stringify(out, null, 2));
console.log("\nwrote /tmp/repro/kinetic-payload.json");
