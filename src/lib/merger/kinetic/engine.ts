// src/lib/merger/kinetic/engine.ts — the style-selection + composition engine
// (directive §3–§4 segmentation, §10–§13 modes, §17 style memory, §18 scoring,
// §36 determinism). Builds a complete KineticPlan from cue data + settings:
// which words group into compositions, which preset each composition uses,
// the phrase hierarchy, and every word's role.
//
// Pure TS. Imports only from ./types + ./presets + ./semantic + ./classify.

import type {
  KineticCaptionSettings,
  KineticComposition,
  KineticPlan,
  KineticPhrasePlan,
  KineticPresetSpec,
  KineticRole,
  KineticWordPlan,
} from "./types";
import { KINETIC_PRESETS, CLASSIFICATION_PRESETS, getKineticPreset } from "./presets";
import { groupPhrases, pickEmphasisWords } from "./semantic";
import { classifyComposition } from "./classify";

// ── Cue input shape (structural, no import cycle with subtitles.ts) ────────

export interface KineticCueInput {
  startMs: number;
  endMs: number;
  text: string;
  words?: { text: string; startMs: number; endMs: number }[];
}

// ── Deterministic RNG (§36) ────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Segmentation (§3, §4): merge cues into 5-12 word compositions ──────────

const DENSITY_TARGETS: Record<string, [number, number]> = {
  short: [3, 6],
  medium: [5, 9],
  long: [8, 14],
};

interface Segment {
  cueIndices: number[];
  startMs: number;
  endMs: number;
  words: { text: string; startMs: number; endMs: number }[];
  text: string;
}

function densityTargets(
  density: string,
  classification: string,
  intensity: number,
): [number, number] {
  if (density !== "auto") return DENSITY_TARGETS[density] ?? DENSITY_TARGETS.medium;
  // auto: drama stays SHORT (§3 — short captions reserved for impact),
  // normal narration gets the storytelling 5-12 band.
  if (intensity >= 65) return [3, 6];
  if (intensity >= 45) return [4, 8];
  return [5, 12];
}

function segmentCues(
  cues: KineticCueInput[],
  density: string,
  intensities: { label: string; intensity: number }[],
): Segment[] {
  const segments: Segment[] = [];
  let cur: Segment | null = null;
  const totalMs = cues.length ? cues[cues.length - 1].endMs : 0;

  cues.forEach((cue, i) => {
    const words = cue.words && cue.words.length > 0 ? cue.words : null;
    if (!words) {
      // Cues without word timestamps become standalone compositions that the
      // renderer falls back to legacy rendering for (handled downstream).
      if (cur) {
        segments.push(cur);
        cur = null;
      }
      segments.push({ cueIndices: [i], startMs: cue.startMs, endMs: cue.endMs, words: [], text: cue.text });
      return;
    }

    const info = intensities[i] ?? { label: "NORMAL_NARRATION", intensity: 30 };
    const [minW, maxW] = densityTargets(density, info.label, info.intensity);
    const posFrac = totalMs > 0 ? cue.startMs / totalMs : 0;
    const groupInfo = classifyComposition(cue.text, words.length, posFrac);
    const [, segMax] = densityTargets(density, groupInfo.label, groupInfo.intensity);

    if (cur) {
      const gap = cue.startMs - cur.endMs;
      const nextWordCount = cur.words.length + words.length;
      const nextCharCount = cur.text.length + cue.text.length + 1;
      const wouldOverrun =
        nextWordCount > Math.min(maxW, segMax) || nextCharCount > 72;
      const bigGap = gap > 900;
      const dramaBreak = groupInfo.intensity >= 70 && cur.words.length >= minW;
      if (wouldOverrun || bigGap || dramaBreak) {
        segments.push(cur);
        cur = null;
      }
    }
    if (!cur) {
      cur = { cueIndices: [i], startMs: cue.startMs, endMs: cue.endMs, words: [], text: "" };
    }
    cur.cueIndices.push(i);
    cur.words.push(...words);
    cur.text = cur.text ? `${cur.text} ${cue.text}` : cue.text;
    cur.endMs = cue.endMs;
    // A cue ending with terminal punctuation can close the composition early
    // when it already clears the minimum word target.
    if (/[.!?…]["')]?\s*$/.test(cue.text) && cur.words.length >= minW) {
      segments.push(cur);
      cur = null;
    }
  });
  if (cur) segments.push(cur);
  return segments.filter((s) => s.words.length > 0 || s.cueIndices.length > 0);
}

// ── Style selection (§17, §18) ─────────────────────────────────────────────

interface StyleMemory {
  recentPresets: string[];
  recentFamilies: string[];
  recentEntrances: string[];
  recentLayouts: string[];
}

const VARIATION_PENALTY: Record<string, { preset: number; family: number; entrance: number; layout: number }> = {
  low: { preset: 3.0, family: 2.0, entrance: 1.5, layout: 1.0 },
  medium: { preset: 2.0, family: 1.2, entrance: 1.0, layout: 0.6 },
  high: { preset: 1.4, family: 0.8, entrance: 0.6, layout: 0.3 },
  extreme: { preset: 1.0, family: 0.5, entrance: 0.4, layout: 0.2 },
};

function pushRecent(list: string[], value: string, cap: number): void {
  list.unshift(value);
  if (list.length > cap) list.length = cap;
}

/**
 * §18: score every candidate preset and pick the highest — semantic fit +
 * length compatibility + intensity band + visual continuity + user weights −
 * repetition penalties (style memory). Deterministic given the seed.
 */
function selectPreset(
  candidates: KineticPresetSpec[],
  label: string,
  intensity: number,
  wordCount: number,
  settings: KineticCaptionSettings,
  memory: StyleMemory,
  rand: () => number,
): KineticPresetSpec {
  const penalties = VARIATION_PENALTY[settings.variation] ?? VARIATION_PENALTY.high;
  const bias = CLASSIFICATION_PRESETS[label] ?? [];
  const lastPreset = memory.recentPresets[0];
  const lastFamily = memory.recentFamilies[0];

  let best: KineticPresetSpec | null = null;
  let bestScore = -Infinity;

  for (const p of candidates) {
    let score = p.autoWeight * 2;

    // semanticMatch (§15 mapping)
    const biasIdx = bias.indexOf(p.id);
    score += biasIdx >= 0 ? (biasIdx === 0 ? 5 : biasIdx === 1 ? 3.5 : 2.5) : 0;
    if (p.classificationBias.includes(label as never)) score += 1.5;

    // captionLengthCompatibility (§3)
    const [lo, hi] = p.preferredWords;
    if (wordCount >= lo && wordCount <= hi) score += 3;
    else if (wordCount < lo && wordCount >= lo - 2) score += 1;
    else if (wordCount > hi && wordCount <= hi + 3) score += 1;
    else score -= 1.5;

    // emotionalIntensityMatch (§16)
    const [ilo, ihi] = p.intensityRange;
    if (intensity >= ilo && intensity <= ihi) score += 3;
    else {
      const dist = intensity < ilo ? ilo - intensity : intensity - ihi;
      score -= Math.min(4, dist * 0.12);
    }

    // visualContinuity (§31/§32): same family as previous = smoother
    if (lastFamily && p.family === lastFamily) score += 1.2;

    // userPreference (§12 manual weights)
    if (settings.mode === "manual") {
      const mw = settings.manualMix.find((m) => m.presetId === p.id);
      score += mw ? (mw.weight / 100) * 6 : 0;
    }

    // full-screen discipline (§17): never repeat back-to-back
    if (p.fullScreen && lastPreset) {
      const lastSpec = getKineticPreset(lastPreset);
      if (lastSpec.fullScreen) score -= 8;
    }

    // repetition penalties (§17)
    const recentIdx = memory.recentPresets.indexOf(p.id);
    if (recentIdx === 0) score -= 6 * penalties.preset;
    else if (recentIdx === 1) score -= 3 * penalties.preset;
    else if (recentIdx >= 2) score -= 1.5 * penalties.preset;

    if (memory.recentFamilies.slice(0, 3).includes(p.family)) {
      score -= penalties.family * (p.family === memory.recentFamilies[0] ? 1.5 : 1);
    }
    if (memory.recentEntrances.slice(0, 3).includes(p.entrance)) {
      score -= penalties.entrance;
    }
    if (memory.recentLayouts.slice(0, 3).includes(p.hierarchy)) {
      score -= penalties.layout;
    }

    // deterministic tie-breaking
    score += rand() * 0.3;

    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best ?? getKineticPreset("editorial-stack");
}

// ── Hierarchy assignment (§5) ──────────────────────────────────────────────

function assignHierarchy(
  phrases: { words: KineticWordPlan[]; emphasisIndex: number }[],
  preset: KineticPresetSpec,
): KineticPhrasePlan[] {
  const count = phrases.length;
  // Which phrase is PRIMARY per the preset's hierarchy pattern.
  let primaryIdx = -1;
  switch (preset.hierarchy) {
    case "first-primary":
      primaryIdx = 0;
      break;
    case "last-primary":
      primaryIdx = count - 1;
      break;
    case "emphasis-primary": {
      let best = -1;
      phrases.forEach((ph, i) => {
        const hasEmph = ph.words.some((w) => w.emphasis);
        if (hasEmph && best < 0) best = i;
      });
      primaryIdx = best >= 0 ? best : Math.floor((count - 1) / 2);
      break;
    }
    case "impact": {
      // The phrase carrying the strongest emphasis word becomes the huge one.
      let bestScore = -1;
      phrases.forEach((ph, i) => {
        const emph = ph.words.some((w) => w.emphasis);
        const s = (emph ? 10 : 0) + ph.emphasisIndex;
        if (s > bestScore) {
          bestScore = s;
          primaryIdx = i;
        }
      });
      break;
    }
    default:
      primaryIdx = -1; // uniform/split/diagonal/depth/progressive handle per-index below
  }

  return phrases.map((ph, i) => {
    let role: KineticRole = "supporting";
    let scale = preset.supportScale;
    let weight = preset.baseWeight;
    let align: "left" | "center" | "right" = "center";
    let indentFrac = 0;

    switch (preset.hierarchy) {
      case "uniform":
      case "center-band": {
        role = "secondary";
        scale = 1;
        weight = preset.baseWeight;
        // emphasis words get inline emphasisWeight (render stage)
        if (ph.words.some((w) => w.emphasis)) role = "primary";
        align = "center";
        break;
      }
      case "progressive": {
        // each phrase LARGER than the previous (§7.5 build)
        const t = count > 1 ? i / (count - 1) : 1;
        scale = preset.supportScale + (preset.emphasisScale - preset.supportScale) * t;
        weight = Math.round(preset.baseWeight + (preset.emphasisWeight - preset.baseWeight) * t);
        role = i === count - 1 ? "primary" : "supporting";
        align = "center";
        break;
      }
      case "depth": {
        // back → front: ascending scale
        const t = count > 1 ? i / (count - 1) : 1;
        scale = preset.supportScale + (preset.emphasisScale - preset.supportScale) * t;
        weight = preset.baseWeight;
        role = i === count - 1 ? "primary" : "supporting";
        align = "center";
        break;
      }
      case "diagonal": {
        role = i === count - 1 ? "primary" : "secondary";
        scale = preset.supportScale + (preset.emphasisScale - preset.supportScale) * (i / Math.max(1, count - 1));
        indentFrac = 0.05 * i;
        align = "left";
        break;
      }
      case "split-sides": {
        // alternate sides: even = left group, odd = right group
        role = "secondary";
        scale = preset.supportScale;
        align = i % 2 === 0 ? "left" : "right";
        indentFrac = i % 2 === 0 ? 0.0 : 0.0;
        if (i === Math.floor((count - 1) / 2)) role = "primary";
        break;
      }
      case "opposing": {
        role = "secondary";
        scale = preset.supportScale;
        align = i === 0 ? "left" : i === count - 1 ? "right" : "center";
        if (i === 0 || i === count - 1) {
          scale = preset.emphasisScale * 0.92;
          role = "primary";
        }
        break;
      }
      default: {
        // first-primary / last-primary / emphasis-primary / impact
        if (i === primaryIdx) {
          role = "primary";
          scale = preset.emphasisScale;
          weight = preset.emphasisWeight;
          align = "center";
        } else {
          role = "secondary";
          scale = preset.supportScale;
          weight = preset.baseWeight;
          align = preset.hierarchy === "impact" ? "center" : "center";
        }
      }
    }

    return {
      index: i,
      words: ph.words,
      role,
      scale,
      weight,
      align,
      indentFrac,
    };
  });
}

// ── Plan builder ───────────────────────────────────────────────────────────

function candidatePool(settings: KineticCaptionSettings): KineticPresetSpec[] {
  switch (settings.mode) {
    case "single":
      return [getKineticPreset(settings.presetId)];
    case "manual": {
      const picked = settings.manualMix
        .filter((m) => m.weight > 0 && KINETIC_PRESETS.some((p) => p.id === m.presetId))
        .map((m) => getKineticPreset(m.presetId));
      return picked.length ? picked : [getKineticPreset("editorial-stack")];
    }
    default: // auto / all — the entire library, scoring decides (§13)
      return KINETIC_PRESETS;
  }
}

/**
 * Build the full kinetic plan for a cue list. Deterministic (§36): same cues
 * + settings + seed → identical output. Re-run freely.
 */
export function buildKineticPlan(
  cues: KineticCueInput[],
  settings: KineticCaptionSettings,
): KineticPlan {
  if (!settings.enabled || cues.length === 0) {
    return { compositions: [], compositionAt: () => null };
  }

  const totalMs = cues[cues.length - 1].endMs;
  const intensities = cues.map((c) => {
    const wc = c.words?.length ?? c.text.split(/\s+/).filter(Boolean).length;
    return classifyComposition(c.text, wc, totalMs > 0 ? c.startMs / totalMs : 0);
  });

  const segments = segmentCues(cues, settings.density, intensities);
  const pool = candidatePool(settings);
  const rand = mulberry32(settings.seed);
  const memory: StyleMemory = {
    recentPresets: [],
    recentFamilies: [],
    recentEntrances: [],
    recentLayouts: [],
  };
  const compositions: KineticComposition[] = [];

  for (const seg of segments) {
    if (seg.words.length === 0) continue; // no word timing → legacy path

    const posFrac = totalMs > 0 ? seg.startMs / totalMs : 0;
    const group = classifyComposition(seg.text, seg.words.length, posFrac);
    let label = group.label;
    let intensity = group.intensity;

    // User intensity preference (§33): low clamps, high boosts.
    if (settings.intensity === "low") intensity = Math.min(intensity, 40);
    else if (settings.intensity === "medium") intensity = Math.min(intensity, 62);
    else if (settings.intensity === "high") intensity = Math.max(intensity, 55);

    // Style lock (§35): cue-level lock wins over the engine.
    const lockPresetId = settings.locks?.[seg.cueIndices[0]];
    let preset: KineticPresetSpec;
    if (lockPresetId && settings.mode !== "single" && KINETIC_PRESETS.some((p) => p.id === lockPresetId)) {
      preset = getKineticPreset(lockPresetId);
    } else if (settings.mode === "single") {
      preset = getKineticPreset(settings.presetId);
    } else {
      preset = selectPreset(pool, label, intensity, seg.words.length, settings, memory, rand);
    }

    // Update style memory (§17).
    pushRecent(memory.recentPresets, preset.id, 4);
    pushRecent(memory.recentFamilies, preset.family, 4);
    pushRecent(memory.recentEntrances, preset.entrance, 3);
    pushRecent(memory.recentLayouts, preset.hierarchy, 3);

    // Word-level plans with semantic roles.
    const emphasisSet = new Set(pickEmphasisWords(seg.words.map((w) => w.text)));
    const wordPlans: KineticWordPlan[] = seg.words.map((w, i) => ({
      text: w.text,
      startMs: w.startMs,
      endMs: w.endMs,
      role: emphasisSet.has(i) ? "primary" : "supporting",
      emphasis: emphasisSet.has(i),
      phraseIndex: -1,
    }));

    // Semantic phrase grouping (§22) + phraseIndex assignment in one pass.
    const groups = groupPhrases(seg.words.map((w) => w.text));
    const phraseIdxOf = new Array<number>(wordPlans.length).fill(0);
    groups.forEach((g, pi) => {
      g.wordIndices.forEach((wi) => {
        phraseIdxOf[wi] = pi;
      });
    });
    wordPlans.forEach((w, i) => {
      w.phraseIndex = phraseIdxOf[i];
    });
    const phrases = groups.map((g) => ({
      words: g.wordIndices.map((wi) => wordPlans[wi]),
      emphasisIndex: g.emphasisIndex,
    }));

    const phrasePlans = assignHierarchy(phrases, preset);

    // Word timing sanity: never ≤0ms spans.
    for (const w of wordPlans) {
      if (w.endMs <= w.startMs) w.endMs = w.startMs + 120;
    }

    compositions.push({
      cueIndex: seg.cueIndices[0],
      startMs: seg.startMs,
      endMs: Math.max(seg.endMs, seg.startMs + 400),
      presetId: preset.id,
      classification: label,
      intensity,
      words: wordPlans,
      phrases: phrasePlans,
    });
  }

  return {
    compositions,
    compositionAt(ms: number): KineticComposition | null {
      for (const c of compositions) {
        if (ms >= c.startMs && ms < c.endMs) return c;
      }
      return null;
    },
  };
}
