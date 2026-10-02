// src/lib/merger/kinetic/classify.ts — narrative classification (§15) +
// intensity scoring 0-100 (§16). Deterministic keyword + punctuation +
// structure heuristics — no LLM, no randomness.
//
// Pure TS. Zero imports.

import type { NarrativeLabel } from "./types";

interface ClassificationWeights {
  conflict: number;
  revelation: number;
  emotional: number;
  suspense: number;
  negation: number;
  number: number;
  exclaim: number;
  question: number;
  ellipsis: number;
  shortImpact: number;
}

const CLIMAX_WORDS = new Set([
  "everything", "destroyed", "ruined", "over", "ended", "goodbye", "never",
  "worst", "best", "last", "final", "forever", "goodbye", "done", "gone",
]);

const SETUP_WORDS = new Set([
  "when", "one", "day", "once", "started", "beginning", "begin", "used",
  "always", "every", "morning", "grew", "born", "met", "first", "years",
]);

const TRANSITION_WORDS = new Set([
  "then", "next", "after", "later", "meanwhile", "soon", "eventually",
  "finally", "afterwards", "second", "another", "time", "week", "month",
]);

const REFLECTION_WORDS = new Set([
  "remember", "remembered", "think", "thought", "look", "looked", "back",
  "wish", "wished", "miss", "missed", "wonder", "wondered", "maybe",
  "perhaps", "memory", "memories", "photo", "picture", "old", "young",
]);

const REALIZATION_WORDS = new Set([
  "realized", "realised", "understood", "discovered", "learned", "found",
  "knew", "know", "truth", "obvious", "clear", "suddenly", "hit", "me",
]);

const ACCUSATION_WORDS = new Set([
  "you", "your", "blamed", "lied", "liar", "cheated", "stole", "left",
  "promised", "promise", "broke", "said", "told", "never", "always",
]);

/**
 * Classify one caption group (its text + word count) into a narrative label
 * and score its emotional intensity 0-100.
 *
 * Intensity bands (§16): 0-25 subtle · 26-50 moderate · 51-75 strong ·
 * 76-100 major kinetic event. Maximum intensity is RESERVED — the score
 * only exceeds 75 for genuine revelations/climaxes, so a video where every
 * caption screams can't happen.
 */
export function classifyComposition(
  text: string,
  wordCount: number,
  positionFrac: number, // 0..1 — where in the video this group sits
): { label: NarrativeLabel; intensity: number } {
  const lower = text.toLowerCase();
  const words = lower.replace(/[^\p{L}\p{N}'\s]/gu, " ").split(/\s+/).filter(Boolean);
  const has = (set: Set<string>) => words.some((w) => set.has(w));
  const countOf = (set: Set<string>) => words.filter((w) => set.has(w)).length;

  const w: ClassificationWeights = {
    conflict: countOf(new Set(["lied", "betrayed", "cheated", "stole", "fought", "screamed", "yelled", "argued", "blamed", "abandoned", "ignored", "hated", "attacked", "accused", "toxic", "liar", "enemy"])),
    revelation: countOf(new Set(["realized", "discovered", "truth", "secret", "revealed", "learned", "understood", "suddenly", "found", "never", "finally", "unbelievable", "shocking"])),
    emotional: countOf(new Set(["love", "hate", "cried", "tears", "heart", "broken", "alone", "hope", "dream", "miss", "wish", "regret", "forgive", "pain", "grief", "smile", "laughed", "soul", "empty", "lost", "peace", "afraid", "scared", "terrified"])),
    suspense: countOf(new Set(["until", "something", "someone", "strange", "quiet", "silence", "waiting", "watched", "noticed", "began", "secret", "hidden", "wondered", "knock", "message", "letter", "stranger"])),
    negation: countOf(new Set(["never", "not", "nothing", "nobody", "none", "cannot", "can't", "won't", "didn't", "wasn't", "isn't", "don't", "doesn't", "couldn't", "wouldn't", "without", "no"])),
    number: countOf(new Set(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "seventeen", "twenty", "hundred", "thousand", "million", "years", "year", "days", "hours", "minutes", "times"])),
    exclaim: (text.match(/!/g) || []).length,
    question: (text.match(/\?/g) || []).length,
    ellipsis: (text.match(/…|\.\.\./g) || []).length,
    shortImpact: wordCount <= 3 ? 1 : 0,
  };

  // Base: narration starts subtle.
  let intensity = 22;
  intensity += w.conflict * 11;
  intensity += w.revelation * 12;
  intensity += w.emotional * 7;
  intensity += w.suspense * 4;
  intensity += w.negation * 5;
  intensity += w.number * 3;
  intensity += w.exclaim * 12;
  intensity += w.question * 6;
  intensity += w.ellipsis * 4;
  intensity += w.shortImpact * 14;
  // Narrative position: late-video groups lean toward climax weight.
  if (positionFrac > 0.72) intensity += 6;
  if (positionFrac > 0.9) intensity += 5;
  intensity = Math.max(0, Math.min(100, Math.round(intensity)));

  // ── Label selection: strongest signal wins, with structural rules ──
  if (intensity >= 82 && (w.exclaim > 0 || w.revelation > 0 || w.conflict > 0)) {
    return { label: "CLIMAX", intensity };
  }
  if (w.exclaim > 0 && intensity >= 70) return { label: "SHOCK", intensity };
  if (w.revelation >= 2 || (w.revelation >= 1 && intensity >= 62)) {
    return { label: "REVELATION", intensity };
  }
  if (has(REALIZATION_WORDS) && intensity >= 45) {
    return { label: "REALIZATION", intensity };
  }
  if (w.conflict >= 2) {
    // Accusations address "you" / name the betrayal's subject.
    return { label: has(ACCUSATION_WORDS) ? "ACCUSATION" : "CONFLICT", intensity };
  }
  if (w.conflict === 1 && intensity >= 55) return { label: "CONFLICT", intensity };
  if (w.question > 0) return { label: "SUSPENSE", intensity };
  if (has(SETUP_WORDS) && positionFrac < 0.25 && intensity < 45) {
    return { label: "SETUP", intensity };
  }
  if (has(TRANSITION_WORDS) && intensity < 40) return { label: "TRANSITION", intensity };
  if ((w.emotional >= 2 || has(REFLECTION_WORDS)) && intensity < 55) {
    return { label: w.emotional >= 2 ? "EMOTIONAL" : "REFLECTION", intensity };
  }
  if (intensity < 35 && w.suspense >= 1) return { label: "SUSPENSE", intensity };
  return { label: "NORMAL_NARRATION", intensity };
}
