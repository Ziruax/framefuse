// src/lib/merger/kinetic/motion.ts — motion choreography (§20, §21, §28).
// Maps a composition + time → per-word transforms. Motion follows MEANING:
// primary words get strong motion, secondary moderate, supporting subtle.
//
// All px offsets are 1080p-referenced (multiply by ch/1080 at render).
// Mirrored (math only) in electron/kinetic-ass.js — keep in sync.
//
// Imports only ./types.

import type {
  KineticComposition,
  KineticPresetSpec,
  KineticWordTransform,
} from "./types";
import { KINETIC_IDENTITY } from "./types";

// ── Motion energy multipliers (§33) ─────────────────────────────────────────

const MOTION_ENERGY: Record<string, number> = {
  subtle: 0.6,
  balanced: 1.0,
  dynamic: 1.25,
  extreme: 1.6,
};

// ── Easing ──────────────────────────────────────────────────────────────────

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function easeOutBack(t: number, overshoot: number): number {
  // overshoot in 0..0.35 → c1 param
  const c1 = 1.2 + overshoot * 2.2;
  const c3 = c1 + 1;
  const x = 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  return x;
}

function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

// ── Per-word entrance anchors ───────────────────────────────────────────────

/** Radial directions for burst/converge — deterministic per word index. */
function burstVector(idx: number): { dx: number; dy: number } {
  const pattern = [
    { dx: -1, dy: -0.55 },
    { dx: 1, dy: -0.5 },
    { dx: -1, dy: 0.6 },
    { dx: 1, dy: 0.55 },
    { dx: -0.55, dy: -1 },
    { dx: 0.6, dy: 1 },
  ];
  const v = pattern[idx % pattern.length];
  return v;
}

// ── Main transform solver ───────────────────────────────────────────────────

export interface KineticMotionInput {
  composition: KineticComposition;
  preset: KineticPresetSpec;
  currentMs: number;
  /** Motion energy setting. */
  motionLevel: string;
  /** Canvas height at render time — scales 1080p-referenced offsets. */
  ch: number;
}

/**
 * Solve every word's transform at currentMs. One pass, no allocations per
 * word beyond the result objects. Returns transforms INDEXED like
 * composition.words (the painter resolves each word's geometry separately).
 */
export function kineticWordTransforms(input: KineticMotionInput): KineticWordTransform[] {
  const { composition: comp, preset, currentMs, motionLevel, ch } = input;
  const energy = (MOTION_ENERGY[motionLevel] ?? 1) * (ch / 1080);
  const out: KineticWordTransform[] = [];
  const scaleRef = ch / 1080;

  const entranceMs = Math.max(60, preset.entranceMs * (motionLevel === "subtle" ? 1.2 : 1));
  const stagger = preset.staggerMs;
  const exitMs = preset.exitMs;

  // v1.33.2 ENTRANCE/EXIT CROSSFIRE FIX: a word entering while the
  // composition's exit fade was already running multiplied a rising alpha
  // by a falling one — the last words of every tight composition peaked at
  // ~30% opacity ("words not properly visible"). Two-part fix:
  //   (a) each word's entrance COMPRESSES so it completes before the exit
  //       window opens (min 60ms — a fast pop beats an invisible fade);
  //   (b) the exit window DEFERS until the last entrance completed (words
  //       keep full opacity to the end when there is no room to fade).
  const nominalExitStart = comp.endMs - exitMs;
  const enterWindows = comp.words.map((word, idx) => {
    const phraseIdx = word.phraseIndex;
    const delay = (phraseIdx * stagger) + (preset.entrance === "typewriter" ? idx * stagger : 0);
    const enterStart = Math.max(comp.startMs, word.startMs - 60) + delay;
    const room = Math.max(80, nominalExitStart - enterStart - 40);
    const effMs = Math.max(60, Math.min(entranceMs, room));
    return { enterStart, enterMs: effMs, enterEnd: enterStart + effMs };
  });
  const lastEnterEnd = enterWindows.reduce((m, w) => Math.max(m, w.enterEnd), -Infinity);
  const exitStart = Math.max(nominalExitStart, lastEnterEnd + 60);
  const noExitFade = exitStart >= comp.endMs - 40;

  comp.words.forEach((word, idx) => {
    const phrase = comp.phrases[word.phraseIndex];
    const role = phrase?.role ?? word.role;

    // Entrance window (§22 stagger + v1.33.2 compressed duration).
    const { enterStart, enterEnd } = enterWindows[idx];
    const et = clamp01((currentMs - enterStart) / (enterEnd - enterStart));

    // Exit window (whole composition; deferred past the last entrance).
    const xt = noExitFade ? 0 : clamp01((currentMs - exitStart) / exitMs);

    // Emphasis event window: the word's own spoken moment (§21).
    const emphT = clamp01((currentMs - word.startMs) / Math.max(160, word.endMs - word.startMs));

    let t: KineticWordTransform = { ...KINETIC_IDENTITY };

    // Role-based motion budget (§28): primary strong, secondary moderate,
    // supporting subtle.
    const roleEnergy =
      role === "primary" ? 1 : role === "secondary" ? 0.6 : 0.35;

    // ── Entrance choreography per preset ──
    if (et < 1) {
      const e = easeOutCubic(et);
      const eB = easeOutBack(et, preset.overshoot);
      switch (preset.entrance) {
        case "fade-rise": {
          t.alpha = e;
          t.offsetY = (1 - e) * 36 * energy * roleEnergy;
          break;
        }
        case "word-pop": {
          t.alpha = Math.min(1, et * 2.5);
          t.scale = 0.4 + 0.6 * eB;
          break;
        }
        case "scale-slam": {
          t.alpha = Math.min(1, et * 3);
          t.scale = 2.4 - 1.4 * eB;
          if (et < 0.4 && word.emphasis) t.offsetX = Math.sin(et * 40) * 5 * energy;
          break;
        }
        case "slide-x": {
          t.alpha = e;
          const dir = phrase?.align === "right" ? 1 : phrase?.align === "left" ? -1 : idx % 2 === 0 ? -1 : 1;
          t.offsetX = (1 - e) * 56 * energy * dir;
          break;
        }
        case "slide-y": {
          t.alpha = e;
          t.offsetY = (1 - e) * 42 * energy * (idx % 2 === 0 ? -1 : 1);
          break;
        }
        case "clip-wipe": {
          t.alpha = Math.min(1, et * 1.6);
          t.clipLeft = e;
          break;
        }
        case "blur-focus": {
          t.alpha = e;
          t.blur = (1 - e) * 10 * energy;
          t.scale = 1.12 - 0.12 * e;
          break;
        }
        case "burst": {
          {
            const v = burstVector(idx);
            t.alpha = e;
            t.offsetX = (1 - e) * v.dx * 64 * energy * roleEnergy;
            t.offsetY = (1 - e) * v.dy * 46 * energy * roleEnergy;
            t.scale = 0.86 + 0.14 * e;
          }
          break;
        }
        case "converge": {
          {
            // words fly IN from outside toward their anchor
            const v = burstVector(idx);
            t.alpha = e;
            t.offsetX = (1 - e) * v.dx * 90 * energy;
            t.offsetY = (1 - e) * v.dy * 60 * energy;
            t.scale = 0.9 + 0.1 * eB;
          }
          break;
        }
        case "push": {
          {
            // current phrase rises in; older phrases are handled by the hold/
            // exit phase (the renderer dims phrases whose words all ended).
            t.alpha = e;
            t.offsetY = (1 - e) * 30 * energy;
          }
          break;
        }
        case "flash": {
          t.alpha = et < 0.25 ? et / 0.25 : 1;
          t.scale = word.emphasis ? 1.9 - 0.9 * eB : 1.4 - 0.4 * e;
          break;
        }
        case "typewriter": {
          t.alpha = et > 0 ? 1 : 0;
          break;
        }
      }
    }

    // ── Emphasis event (§21): motion follows meaning ──
    if (word.emphasis && emphT < 1) {
      switch (preset.emphasisMotion) {
        case "scale-punch": {
          const punch = easeOutBack(clamp01(emphT), preset.overshoot);
          t.scale *= 0.7 + 0.3 * punch + 0.18 * (1 - emphT);
          break;
        }
        case "pulse": {
          const pulse = 1 + 0.07 * Math.sin(emphT * Math.PI * 2) * (1 - emphT);
          t.scale *= pulse;
          break;
        }
        case "shake": {
          if (emphT < 0.5) {
            t.offsetX += Math.sin(emphT * 36) * 6 * energy * (1 - emphT * 2);
          }
          t.scale *= 1 + 0.12 * (1 - emphT);
          break;
        }
        case "hold":
        default:
          t.scale *= 1 + 0.06 * (1 - emphT);
          break;
      }
    }

    // ── Hold behavior (§20): subtle motion while the word is being held ──
    const spoken = currentMs >= word.startMs && currentMs < word.endMs;
    if (preset.hold === "drift" && currentMs > word.endMs) {
      const held = clamp01((currentMs - word.endMs) / Math.max(1, comp.endMs - word.endMs));
      t.offsetY -= held * 4 * scaleRef;
    }
    if (spoken) {
      if (preset.hold === "active-word") t.scale *= 1.06;
      if (preset.hold === "active-accent") t.colorOverride = null; // accent handled by painter
    }

    // ── Push-out: phrases whose words have ALL been spoken drift up + dim ──
    if (preset.entrance === "push" || preset.exit === "push-out") {
      const phraseWords = phrase?.words ?? [];
      const allSpoken = phraseWords.length > 0 && currentMs > (phraseWords[phraseWords.length - 1].endMs + 60);
      if (allSpoken) {
        const since = clamp01(
          (currentMs - phraseWords[phraseWords.length - 1].endMs) / 600,
        );
        t.alpha *= 1 - 0.45 * since;
        t.offsetY -= since * 26 * scaleRef;
      }
    }

    // ── Exit choreography ──
    if (xt > 0) {
      const ex = easeInOutSine(xt);
      switch (preset.exit) {
        case "fade":
        default:
          t.alpha *= 1 - ex;
          break;
        case "slide-down":
          t.alpha *= 1 - ex;
          t.offsetY += ex * 24 * scaleRef;
          break;
        case "scale-out":
          t.alpha *= 1 - ex;
          t.scale *= 1 - 0.25 * ex;
          break;
        case "collapse": {
          t.alpha *= 1 - ex;
          t.scale *= 1 - 0.55 * ex;
          t.offsetY -= ex * 10 * scaleRef;
          break;
        }
        case "push-out": {
          t.alpha *= 1 - ex;
          t.offsetY -= ex * 46 * scaleRef;
          break;
        }
      }
    }

    // Supporting words render muted (§27 color tiers) — EXCEPT emphasis
    // words (v1.33.2): the accent-colored highlight must stay fully legible
    // even when its phrase is a supporting tier (the dimmed accent was the
    // "colour highlight not showing properly" report).
    if (role === "supporting" && !word.emphasis) t.alpha *= 0.82;

    out.push(t);
  });

  return out;
}

/** Active-word accent: the painter uses this to pick the accent color. */
export function isWordSpoken(word: { startMs: number; endMs: number }, currentMs: number): boolean {
  return currentMs >= word.startMs && currentMs < word.endMs;
}
