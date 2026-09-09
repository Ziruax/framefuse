// src/lib/merger/captionPresets.ts — caption design presets + font options
//
// v4.1: every VIRAL preset now BEHAVES like its name — selecting it applies
// the matching wordMode (karaoke highlight / single-word / stack), the
// signature kinetic animation, the preferred font and colors. No more
// "static styles with viral names": Karaoke fills word-by-word, Hormozi
// slams single words, Reveal typewrites, Drift drifts, Stack stacks.
//
// Preset selection applies: presetId + wordMode + animation (unless the
// user pinned one) + fontId. The old per-preset `ffmpegStyle` string was
// removed (dead code) — the exporter builds ASS styles from the SAME
// properties the canvas preview uses, so preview and export can't drift.

import type { CaptionAnimation } from "./types";

export type CaptionWordMode = "off" | "word" | "word-only" | "stack";

export interface CaptionPreset {
  id: string;
  name: string;
  description: string;
  // Visual properties (relative to video height where applicable)
  fontSize: number; // fraction of video height (0.04 = 4%)
  fontFamily: string; // CSS stack for canvas preview / UI swatches
  fontWeight: number; // 400, 600, 700, 800, 900
  fontStyle: "normal" | "italic";
  textColor: string; // hex #RRGGBB
  bgColor: string | null; // hex #RRGGBB or null for no background
  bgAlpha: number; // 0-1 background opacity (applied to bgColor)
  bgPadding: number; // px padding around text (relative to 1080p height)
  bgRadius: number; // border radius px (relative to 1080p height)
  borderColor: string | null; // hex outline color or null
  borderWidth: number; // px (relative to 1080p height)
  shadow: boolean;
  shadowColor: string;
  shadowBlur: number; // px
  textTransform: "none" | "uppercase" | "lowercase";
  letterSpacing: number; // px
  position: "top" | "center" | "bottom";
  positionY: number; // px offset from position edge (positive = inward)
  maxWidth: number; // fraction of video width (0.8 = 80%)
  alignment: "left" | "center" | "right";
  /**
   * Optional accent color used to highlight the *currently spoken*
   * word in word-by-word ("word" mode). If null, word-mode simply
   * scales/bolds the active word.
   */
  highlightColor?: string | null;
  /**
   * Signature kinetic animation for this preset. Applied when the user
   * selects the preset (unless they pinned a manual animation).
   */
  animation?: CaptionAnimation;
  /**
   * Word rendering mode this preset is designed for. Applied on
   * selection so the preset behaves like its name.
   */
  wordMode?: CaptionWordMode;
  /**
   * Preferred font id (FONT_OPTIONS id). Applied on selection.
   */
  fontId?: string;
  // Tag for UI grouping.
  category:
    | "viral"
    | "kinetic"
    | "social"
    | "youtube"
    | "streaming"
    | "documentary"
    | "corporate"
    | "news"
    | "film";
}

// ---------------------------------------------------------------------------
// Category metadata for the grouped preset picker UI.
// ---------------------------------------------------------------------------

export const PRESET_CATEGORIES: {
  id: CaptionPreset["category"];
  label: string;
  hint: string;
}[] = [
  { id: "viral", label: "Viral & Word-by-Word", hint: "Signature presets that behave like their names — word-level timing, karaoke fills, single-word slams, stacks." },
  { id: "kinetic", label: "Kinetic Typography", hint: "Motion-first caption designs for maximum retention." },
  { id: "social", label: "Social", hint: "TikTok / Instagram / general social standards." },
  { id: "youtube", label: "YouTube", hint: "Clean, platform-native subtitle looks." },
  { id: "streaming", label: "Streaming", hint: "Netflix / broadcast-grade subtitles." },
  { id: "documentary", label: "Documentary", hint: "Refined, editorial, lower-third styles." },
  { id: "corporate", label: "Corporate", hint: "Professional presentation captions." },
  { id: "news", label: "News", hint: "Lower-third broadcast bars." },
  { id: "film", label: "Film", hint: "Cinematic, vintage title cards." },
];

// ---------------------------------------------------------------------------
// The presets.
// ---------------------------------------------------------------------------

export const CAPTION_PRESETS: CaptionPreset[] = [
  // ─── VIRAL — presets that BEHAVE like their names (word-level timing) ───
  {
    id: "viral-hormozi",
    name: "Hormozi",
    description: "Single word slams in — huge white, green highlight punch.",
    fontSize: 0.085, fontFamily: 'Montserrat, "Segoe UI", Arial, sans-serif',
    fontWeight: 900, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, bgPadding: 16, bgRadius: 10,
    borderColor: "#000000", borderWidth: 4, shadow: true,
    shadowColor: "#000000", shadowBlur: 10, textTransform: "uppercase",
    letterSpacing: 2, position: "center", positionY: 0, maxWidth: 0.84,
    alignment: "center", category: "viral", highlightColor: "#22C55E",
    animation: "slam", wordMode: "word-only", fontId: "montserrat",
  },
  {
    id: "viral-karaoke",
    name: "Karaoke",
    description: "Word-by-word yellow fill — classic karaoke sing-along.",
    fontSize: 0.05, fontFamily: 'Montserrat, "Segoe UI", Arial, sans-serif',
    fontWeight: 800, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, bgPadding: 8, bgRadius: 0,
    borderColor: "#000000", borderWidth: 3, shadow: true,
    shadowColor: "#000000", shadowBlur: 3, textTransform: "uppercase",
    letterSpacing: 1, position: "bottom", positionY: 60, maxWidth: 0.84,
    alignment: "center", category: "viral", highlightColor: "#FFD700",
    animation: "pop-in", wordMode: "word", fontId: "montserrat",
  },
  {
    id: "viral-bounce",
    name: "Bounce",
    description: "Words spring-drop in from above — high-energy hook.",
    fontSize: 0.06, fontFamily: 'Montserrat, "Segoe UI", Arial, sans-serif',
    fontWeight: 900, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, bgPadding: 8, bgRadius: 0,
    borderColor: "#000000", borderWidth: 3, shadow: true,
    shadowColor: "#000000", shadowBlur: 4, textTransform: "uppercase",
    letterSpacing: 1, position: "top", positionY: 50, maxWidth: 0.82,
    alignment: "center", category: "viral", highlightColor: "#FDE047",
    animation: "bounce-in", wordMode: "word", fontId: "montserrat",
  },
  {
    id: "viral-reveal",
    name: "Reveal",
    description: "Typewriter reveal — suspenseful one character at a time.",
    fontSize: 0.048, fontFamily: '"Courier New", monospace',
    fontWeight: 700, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: "#000000", bgAlpha: 0.85, bgPadding: 12, bgRadius: 0,
    borderColor: null, borderWidth: 0, shadow: false,
    shadowColor: "#000000", shadowBlur: 0, textTransform: "none",
    letterSpacing: 1, position: "bottom", positionY: 50, maxWidth: 0.82,
    alignment: "center", category: "viral", highlightColor: "#FDE047",
    animation: "typewriter", wordMode: "word", fontId: "courier",
  },
  {
    id: "viral-drift",
    name: "Drift",
    description: "Words drift upward softly — cinematic narration feel.",
    fontSize: 0.048, fontFamily: '"Playfair Display", Georgia, serif',
    fontWeight: 400, fontStyle: "italic",
    textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, bgPadding: 8, bgRadius: 0,
    borderColor: "#000000", borderWidth: 2, shadow: true,
    shadowColor: "#000000", shadowBlur: 6, textTransform: "none",
    letterSpacing: 1, position: "bottom", positionY: 55, maxWidth: 0.84,
    alignment: "center", category: "viral", highlightColor: "#FBBF24",
    animation: "drift", wordMode: "word", fontId: "playfair",
  },
  {
    id: "viral-boxed",
    name: "Boxed",
    description: "Words pop inside a violet box — unmissable mid-frame.",
    fontSize: 0.055, fontFamily: 'Montserrat, "Segoe UI", Arial, sans-serif',
    fontWeight: 800, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: "#7C3AED", bgAlpha: 1, bgPadding: 14, bgRadius: 8,
    borderColor: null, borderWidth: 0, shadow: true,
    shadowColor: "#000000", shadowBlur: 4, textTransform: "uppercase",
    letterSpacing: 1, position: "bottom", positionY: 50, maxWidth: 0.82,
    alignment: "center", category: "viral", highlightColor: "#FDE047",
    animation: "pop-in", wordMode: "word", fontId: "montserrat",
  },
  {
    id: "viral-clean",
    name: "Clean",
    description: "Minimal green accent — the active word pulses cleanly.",
    fontSize: 0.05, fontFamily: 'Inter, "Segoe UI", Arial, sans-serif',
    fontWeight: 700, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, bgPadding: 8, bgRadius: 0,
    borderColor: "#000000", borderWidth: 2, shadow: true,
    shadowColor: "#000000", shadowBlur: 4, textTransform: "none",
    letterSpacing: 0, position: "bottom", positionY: 60, maxWidth: 0.84,
    alignment: "center", category: "viral", highlightColor: "#4ADE80",
    animation: "scale-pulse", wordMode: "word", fontId: "inter",
  },
  {
    id: "viral-underline",
    name: "Underline",
    description: "Active word pops in a yellow highlight box — spotlight energy.",
    fontSize: 0.05, fontFamily: 'Inter, "Segoe UI", Arial, sans-serif',
    fontWeight: 700, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, bgPadding: 8, bgRadius: 4,
    borderColor: "#000000", borderWidth: 1, shadow: true,
    shadowColor: "#000000", shadowBlur: 3, textTransform: "none",
    letterSpacing: 0, position: "bottom", positionY: 60, maxWidth: 0.84,
    alignment: "center", category: "viral", highlightColor: "#FDE047",
    animation: "spotlight", wordMode: "word", fontId: "inter",
  },
  {
    id: "viral-dim",
    name: "Dim",
    description: "Heavy-shadow words fade through — moody storytelling.",
    fontSize: 0.05, fontFamily: 'Inter, "Segoe UI", Arial, sans-serif',
    fontWeight: 600, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, bgPadding: 8, bgRadius: 0,
    borderColor: "#000000", borderWidth: 3, shadow: true,
    shadowColor: "#000000", shadowBlur: 8, textTransform: "none",
    letterSpacing: 0, position: "bottom", positionY: 60, maxWidth: 0.84,
    alignment: "center", category: "viral", highlightColor: "#FFFFFF",
    animation: "fade-through", wordMode: "word", fontId: "inter",
  },
  {
    id: "viral-spotlight",
    name: "Spotlight",
    description: "One word at a time on a yellow box — total attention lock.",
    fontSize: 0.07, fontFamily: 'Montserrat, "Segoe UI", Arial, sans-serif',
    fontWeight: 900, fontStyle: "normal",
    textColor: "#111827", bgColor: "#FDE047", bgAlpha: 1, bgPadding: 18, bgRadius: 10,
    borderColor: null, borderWidth: 0, shadow: true,
    shadowColor: "#000000", shadowBlur: 8, textTransform: "uppercase",
    letterSpacing: 1, position: "center", positionY: 0, maxWidth: 0.84,
    alignment: "center", category: "viral", highlightColor: "#111827",
    animation: "spotlight", wordMode: "word-only", fontId: "montserrat",
  },
  {
    id: "viral-accent",
    name: "Accent",
    description: "Editorial italics — gold active word, elegant serif.",
    fontSize: 0.045, fontFamily: '"Playfair Display", Georgia, serif',
    fontWeight: 500, fontStyle: "italic",
    textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, bgPadding: 8, bgRadius: 0,
    borderColor: "#000000", borderWidth: 1, shadow: true,
    shadowColor: "#000000", shadowBlur: 3, textTransform: "none",
    letterSpacing: 0, position: "bottom", positionY: 60, maxWidth: 0.84,
    alignment: "center", category: "viral", highlightColor: "#FBBF24",
    animation: "fade-through", wordMode: "word", fontId: "playfair",
  },
  {
    id: "viral-stack",
    name: "Word Stack",
    description: "Words stack into a growing tower — quote-builder style.",
    fontSize: 0.052, fontFamily: 'Montserrat, "Segoe UI", Arial, sans-serif',
    fontWeight: 800, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, bgPadding: 10, bgRadius: 0,
    borderColor: "#000000", borderWidth: 3, shadow: true,
    shadowColor: "#000000", shadowBlur: 6, textTransform: "uppercase",
    letterSpacing: 1, position: "center", positionY: 0, maxWidth: 0.84,
    alignment: "center", category: "viral", highlightColor: "#22D3EE",
    animation: "pop-in", wordMode: "stack", fontId: "montserrat",
  },

  // ─── KINETIC TYPOGRAPHY — motion-first designs (v4.1 pack) ────────────
  {
    id: "kinetic-slam",
    name: "MrBeast Slam",
    description: "Giant yellow text slams 2.4× → 1 with punch shake. Maximum hook.",
    fontSize: 0.09, fontFamily: 'Impact, "Arial Black", sans-serif',
    fontWeight: 900, fontStyle: "normal",
    textColor: "#FFD700", bgColor: null, bgAlpha: 1, bgPadding: 10, bgRadius: 0,
    borderColor: "#000000", borderWidth: 5, shadow: true,
    shadowColor: "#000000", shadowBlur: 10, textTransform: "uppercase",
    letterSpacing: 2, position: "top", positionY: 90, maxWidth: 0.86,
    alignment: "center", category: "kinetic", highlightColor: "#FFFFFF",
    animation: "slam", wordMode: "word-only", fontId: "impact",
  },
  {
    id: "kinetic-glitch",
    name: "Glitch Vibe",
    description: "RGB-split flicker — cyberpunk / tech niche energy.",
    fontSize: 0.058, fontFamily: 'Inter, "Segoe UI", Arial, sans-serif',
    fontWeight: 800, fontStyle: "normal",
    textColor: "#67E8F9", bgColor: null, bgAlpha: 1, bgPadding: 10, bgRadius: 0,
    borderColor: "#0F172A", borderWidth: 3, shadow: true,
    shadowColor: "#0891B2", shadowBlur: 8, textTransform: "uppercase",
    letterSpacing: 1, position: "center", positionY: 0, maxWidth: 0.84,
    alignment: "center", category: "kinetic", highlightColor: "#F0ABFC",
    animation: "glitch", wordMode: "word", fontId: "inter",
  },
  {
    id: "kinetic-confetti",
    name: "Confetti Pop",
    description: "Electric per-word color palette — confetti of attention.",
    fontSize: 0.06, fontFamily: 'Montserrat, "Segoe UI", Arial, sans-serif',
    fontWeight: 900, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, bgPadding: 10, bgRadius: 0,
    borderColor: "#000000", borderWidth: 4, shadow: true,
    shadowColor: "#000000", shadowBlur: 6, textTransform: "uppercase",
    letterSpacing: 1, position: "center", positionY: 0, maxWidth: 0.84,
    alignment: "center", category: "kinetic",
    animation: "color-cycle", wordMode: "word", fontId: "montserrat",
  },
  {
    id: "kinetic-spin",
    name: "Spin Cycle",
    description: "Words spin -14° into place — playful momentum.",
    fontSize: 0.058, fontFamily: 'Montserrat, "Segoe UI", Arial, sans-serif',
    fontWeight: 800, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, bgPadding: 8, bgRadius: 0,
    borderColor: "#000000", borderWidth: 3, shadow: true,
    shadowColor: "#000000", shadowBlur: 5, textTransform: "uppercase",
    letterSpacing: 1, position: "center", positionY: 0, maxWidth: 0.84,
    alignment: "center", category: "kinetic", highlightColor: "#FB923C",
    animation: "spin-in", wordMode: "word", fontId: "montserrat",
  },
  {
    id: "kinetic-flip",
    name: "Flip Cards",
    description: "Words flip in like cards — flipbook retention pattern.",
    fontSize: 0.062, fontFamily: 'Inter, "Segoe UI", Arial, sans-serif',
    fontWeight: 800, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: "#111827", bgAlpha: 0.9, bgPadding: 14, bgRadius: 8,
    borderColor: "#F472B6", borderWidth: 2, shadow: true,
    shadowColor: "#000000", shadowBlur: 6, textTransform: "uppercase",
    letterSpacing: 1, position: "center", positionY: 0, maxWidth: 0.84,
    alignment: "center", category: "kinetic", highlightColor: "#F472B6",
    animation: "flip-in", wordMode: "word-only", fontId: "inter",
  },
  {
    id: "kinetic-elastic",
    name: "Elastic Pop",
    description: "Juicy elastic scale — satisfying spring physics per word.",
    fontSize: 0.06, fontFamily: 'Montserrat, "Segoe UI", Arial, sans-serif',
    fontWeight: 800, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, bgPadding: 8, bgRadius: 0,
    borderColor: "#000000", borderWidth: 3, shadow: true,
    shadowColor: "#000000", shadowBlur: 5, textTransform: "uppercase",
    letterSpacing: 1, position: "center", positionY: 0, maxWidth: 0.84,
    alignment: "center", category: "kinetic", highlightColor: "#A3E635",
    animation: "elastic", wordMode: "word", fontId: "montserrat",
  },
  {
    id: "kinetic-swing",
    name: "Swing Words",
    description: "Pendulum ±8° rocking — hypnotic rhythm for narration.",
    fontSize: 0.055, fontFamily: '"Playfair Display", Georgia, serif',
    fontWeight: 600, fontStyle: "italic",
    textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, bgPadding: 8, bgRadius: 0,
    borderColor: "#000000", borderWidth: 2, shadow: true,
    shadowColor: "#000000", shadowBlur: 4, textTransform: "none",
    letterSpacing: 0, position: "bottom", positionY: 80, maxWidth: 0.86,
    alignment: "center", category: "kinetic", highlightColor: "#FBBF24",
    animation: "swing", wordMode: "word", fontId: "playfair",
  },
  {
    id: "kinetic-squash",
    name: "Squash Bounce",
    description: "Squash & stretch — cartoon physics, playful niche.",
    fontSize: 0.06, fontFamily: 'Montserrat, "Segoe UI", Arial, sans-serif',
    fontWeight: 900, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: "#EF4444", bgAlpha: 0.95, bgPadding: 12, bgRadius: 6,
    borderColor: null, borderWidth: 0, shadow: true,
    shadowColor: "#000000", shadowBlur: 6, textTransform: "uppercase",
    letterSpacing: 1, position: "center", positionY: 0, maxWidth: 0.84,
    alignment: "center", category: "kinetic", highlightColor: "#FDE047",
    animation: "squash", wordMode: "word", fontId: "montserrat",
  },
  {
    id: "kinetic-zoom",
    name: "Rapid Zoom",
    description: "Fast-cut zoom 1.6 → 1 — machine-gun pacing for reels.",
    fontSize: 0.075, fontFamily: 'Montserrat, "Segoe UI", Arial, sans-serif',
    fontWeight: 900, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, bgPadding: 8, bgRadius: 0,
    borderColor: "#000000", borderWidth: 4, shadow: true,
    shadowColor: "#000000", shadowBlur: 8, textTransform: "uppercase",
    letterSpacing: 2, position: "center", positionY: 0, maxWidth: 0.84,
    alignment: "center", category: "kinetic", highlightColor: "#FDE047",
    animation: "zoom-words", wordMode: "word-only", fontId: "montserrat",
  },
  {
    id: "kinetic-stack",
    name: "Stack Builder",
    description: "Slam-stacked words build a bold centered tower.",
    fontSize: 0.056, fontFamily: 'Montserrat, "Segoe UI", Arial, sans-serif',
    fontWeight: 900, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, bgPadding: 8, bgRadius: 0,
    borderColor: "#000000", borderWidth: 4, shadow: true,
    shadowColor: "#000000", shadowBlur: 8, textTransform: "uppercase",
    letterSpacing: 1, position: "center", positionY: 0, maxWidth: 0.84,
    alignment: "center", category: "kinetic", highlightColor: "#FFD700",
    animation: "slam", wordMode: "stack", fontId: "montserrat",
  },
  {
    id: "kinetic-pop",
    name: "Pop Reveal",
    description: "Bold white on black box — words pop with bounce.",
    fontSize: 0.06, fontFamily: 'Montserrat, "Segoe UI", Arial, sans-serif',
    fontWeight: 900, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: "#000000", bgAlpha: 0.9, bgPadding: 18, bgRadius: 12,
    borderColor: null, borderWidth: 0, shadow: true,
    shadowColor: "#000000", shadowBlur: 12, textTransform: "uppercase",
    letterSpacing: 1, position: "center", positionY: 0, maxWidth: 0.84,
    alignment: "center", category: "kinetic", highlightColor: "#FDE047",
    animation: "pop-in", wordMode: "word", fontId: "montserrat",
  },
  {
    id: "kinetic-slide",
    name: "Slide Story",
    description: "Words slide up from below — clean narrative reveal.",
    fontSize: 0.055, fontFamily: 'Inter, "Segoe UI", Arial, sans-serif',
    fontWeight: 700, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, bgPadding: 10, bgRadius: 0,
    borderColor: "#000000", borderWidth: 3, shadow: true,
    shadowColor: "#000000", shadowBlur: 5, textTransform: "none",
    letterSpacing: 0, position: "bottom", positionY: 80, maxWidth: 0.86,
    alignment: "center", category: "kinetic", highlightColor: "#FDE047",
    animation: "slide-up", wordMode: "word", fontId: "inter",
  },
  {
    id: "kinetic-type",
    name: "Typewriter",
    description: "Characters reveal one-by-one — suspenseful / documentary.",
    fontSize: 0.052, fontFamily: '"Courier New", monospace',
    fontWeight: 700, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: "#000000", bgAlpha: 0.85, bgPadding: 12, bgRadius: 0,
    borderColor: null, borderWidth: 0, shadow: false,
    shadowColor: "#000000", shadowBlur: 0, textTransform: "none",
    letterSpacing: 1, position: "center", positionY: 0, maxWidth: 0.86,
    alignment: "center", category: "kinetic", highlightColor: "#FDE047",
    animation: "typewriter", wordMode: "word", fontId: "courier",
  },
  {
    id: "kinetic-wave",
    name: "Wave Drift",
    description: "Words gently wave up/down — calm, rhythmic narration.",
    fontSize: 0.055, fontFamily: 'Inter, "Segoe UI", Arial, sans-serif',
    fontWeight: 700, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, bgPadding: 8, bgRadius: 0,
    borderColor: "#000000", borderWidth: 2, shadow: true,
    shadowColor: "#000000", shadowBlur: 4, textTransform: "none",
    letterSpacing: 0, position: "center", positionY: 0, maxWidth: 0.84,
    alignment: "center", category: "kinetic", highlightColor: "#22D3EE",
    animation: "wave", wordMode: "word", fontId: "inter",
  },
  {
    id: "kinetic-shake",
    name: "Impact Shake",
    description: "Strong horizontal shake on each word — punchy, high-energy.",
    fontSize: 0.07, fontFamily: 'Montserrat, "Segoe UI", Arial, sans-serif',
    fontWeight: 900, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: "#000000", bgAlpha: 1, bgPadding: 14, bgRadius: 4,
    borderColor: "#FDE047", borderWidth: 2, shadow: true,
    shadowColor: "#000000", shadowBlur: 8, textTransform: "uppercase",
    letterSpacing: 2, position: "center", positionY: 0, maxWidth: 0.84,
    alignment: "center", category: "kinetic", highlightColor: "#FDE047",
    animation: "shake", wordMode: "word", fontId: "montserrat",
  },
  {
    id: "kinetic-jitter",
    name: "Energy Jitter",
    description: "Small random shake — energetic, attention-sustaining.",
    fontSize: 0.06, fontFamily: 'Montserrat, "Segoe UI", Arial, sans-serif',
    fontWeight: 800, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: "#EF4444", bgAlpha: 0.95, bgPadding: 12, bgRadius: 6,
    borderColor: null, borderWidth: 0, shadow: true,
    shadowColor: "#000000", shadowBlur: 6, textTransform: "uppercase",
    letterSpacing: 1, position: "center", positionY: 0, maxWidth: 0.84,
    alignment: "center", category: "kinetic", highlightColor: "#FDE047",
    animation: "jitter", wordMode: "word", fontId: "montserrat",
  },

  // ─── WORD MODE LEGACY (kept for saved projects / backwards compat) ────
  {
    id: "word-karaoke",
    name: "Karaoke Pop",
    description: "Word-by-word karaoke — dim text, electric-yellow active word.",
    fontSize: 0.06, fontFamily: 'Montserrat, "Segoe UI", Arial, sans-serif',
    fontWeight: 800, fontStyle: "normal",
    textColor: "#9CA3AF", bgColor: null, bgAlpha: 1, bgPadding: 10, bgRadius: 0,
    borderColor: "#000000", borderWidth: 3, shadow: true,
    shadowColor: "#000000", shadowBlur: 4, textTransform: "uppercase",
    letterSpacing: 1, position: "center", positionY: 0, maxWidth: 0.84,
    alignment: "center", category: "viral", highlightColor: "#FDE047",
    animation: "pop-in", wordMode: "word", fontId: "montserrat",
  },
  {
    id: "word-hormozi",
    name: "Word Pop",
    description: "Single active word, bold white, cyan highlight.",
    fontSize: 0.085, fontFamily: 'Montserrat, "Segoe UI", Arial, sans-serif',
    fontWeight: 900, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: "#000000", bgAlpha: 0.85, bgPadding: 16, bgRadius: 10,
    borderColor: null, borderWidth: 0, shadow: true,
    shadowColor: "#000000", shadowBlur: 8, textTransform: "uppercase",
    letterSpacing: 2, position: "center", positionY: 0, maxWidth: 0.84,
    alignment: "center", category: "viral", highlightColor: "#22D3EE",
    animation: "bounce-in", wordMode: "word-only", fontId: "montserrat",
  },
  {
    id: "word-neon",
    name: "Neon Pulse",
    description: "Cyan text, magenta active word — synthwave karaoke.",
    fontSize: 0.06, fontFamily: 'Inter, "Segoe UI", Arial, sans-serif',
    fontWeight: 700, fontStyle: "normal",
    textColor: "#67E8F9", bgColor: null, bgAlpha: 1, bgPadding: 10, bgRadius: 0,
    borderColor: "#0F172A", borderWidth: 3, shadow: true,
    shadowColor: "#0891B2", shadowBlur: 8, textTransform: "uppercase",
    letterSpacing: 1, position: "center", positionY: 0, maxWidth: 0.84,
    alignment: "center", category: "viral", highlightColor: "#F0ABFC",
    animation: "scale-pulse", wordMode: "word", fontId: "inter",
  },
  {
    id: "word-cinema",
    name: "Cinema Word",
    description: "Italic serif, gold active word — refined editorial karaoke.",
    fontSize: 0.055, fontFamily: '"Playfair Display", Georgia, serif',
    fontWeight: 500, fontStyle: "italic",
    textColor: "#D4D4D8", bgColor: null, bgAlpha: 1, bgPadding: 8, bgRadius: 0,
    borderColor: "#000000", borderWidth: 2, shadow: true,
    shadowColor: "#000000", shadowBlur: 6, textTransform: "none",
    letterSpacing: 0, position: "bottom", positionY: 70, maxWidth: 0.86,
    alignment: "center", category: "viral", highlightColor: "#FBBF24",
    animation: "fade-through", wordMode: "word", fontId: "playfair",
  },

  // ─── SOCIAL ───────────────────────────────────────────────────────────
  {
    id: "tiktok-bold",
    name: "TikTok Bold",
    description: "White text, rounded black box, bold, uppercase. Bottom center.",
    fontSize: 0.055,
    fontFamily: 'Montserrat, "Segoe UI", Arial, sans-serif',
    fontWeight: 800,
    fontStyle: "normal",
    textColor: "#FFFFFF",
    bgColor: "#000000",
    bgAlpha: 1,
    bgPadding: 14,
    bgRadius: 10,
    borderColor: null,
    borderWidth: 0,
    shadow: false,
    shadowColor: "#000000",
    shadowBlur: 0,
    textTransform: "uppercase",
    letterSpacing: 1,
    position: "bottom",
    positionY: 60,
    maxWidth: 0.82,
    alignment: "center",
    category: "social",
    animation: "none",
    wordMode: "off",
    fontId: "montserrat",
  },
  {
    id: "instagram-reel",
    name: "Instagram Reel",
    description: "White bold text on violet box. Centered.",
    fontSize: 0.05,
    fontFamily: 'Montserrat, "Segoe UI", Arial, sans-serif',
    fontWeight: 800,
    fontStyle: "normal",
    textColor: "#FFFFFF",
    bgColor: "#8B2BB8",
    bgAlpha: 1,
    bgPadding: 12,
    bgRadius: 12,
    borderColor: null,
    borderWidth: 0,
    shadow: false,
    shadowColor: "#000000",
    shadowBlur: 0,
    textTransform: "uppercase",
    letterSpacing: 1,
    position: "center",
    positionY: 0,
    maxWidth: 0.8,
    alignment: "center",
    category: "social",
    animation: "none",
    wordMode: "off",
    fontId: "montserrat",
  },
  {
    id: "karaoke-style",
    name: "Karaoke Classic",
    description: "Bold yellow text with thick black outline. Bottom center.",
    fontSize: 0.05,
    fontFamily: 'Montserrat, "Segoe UI", Arial, sans-serif',
    fontWeight: 800,
    fontStyle: "normal",
    textColor: "#FFD700",
    bgColor: null,
    bgAlpha: 1,
    bgPadding: 8,
    bgRadius: 0,
    borderColor: "#000000",
    borderWidth: 2,
    shadow: true,
    shadowColor: "#000000",
    shadowBlur: 3,
    textTransform: "uppercase",
    letterSpacing: 1,
    position: "bottom",
    positionY: 60,
    maxWidth: 0.84,
    alignment: "center",
    category: "social",
    animation: "none",
    wordMode: "off",
    fontId: "montserrat",
  },
  {
    id: "minimal-glow",
    name: "Minimal Glow",
    description: "White text with soft white glow, no background. Centered.",
    fontSize: 0.045,
    fontFamily: 'Inter, "Segoe UI", Arial, sans-serif',
    fontWeight: 400,
    fontStyle: "normal",
    textColor: "#FFFFFF",
    bgColor: null,
    bgAlpha: 1,
    bgPadding: 8,
    bgRadius: 0,
    borderColor: null,
    borderWidth: 0,
    shadow: true,
    shadowColor: "#FFFFFF",
    shadowBlur: 4,
    textTransform: "none",
    letterSpacing: 2,
    position: "center",
    positionY: 0,
    maxWidth: 0.8,
    alignment: "center",
    category: "social",
    animation: "none",
    wordMode: "off",
    fontId: "inter",
  },

  // ─── YOUTUBE / STREAMING / DOC / CORPORATE / NEWS / FILM ─────────────
  {
    id: "youtube-clean",
    name: "YouTube Clean",
    description: "White text with soft drop shadow, no background. Bottom center.",
    fontSize: 0.045,
    fontFamily: 'Roboto, "Segoe UI", Arial, sans-serif',
    fontWeight: 600,
    fontStyle: "normal",
    textColor: "#FFFFFF",
    bgColor: null,
    bgAlpha: 1,
    bgPadding: 8,
    bgRadius: 4,
    borderColor: "#000000",
    borderWidth: 2,
    shadow: true,
    shadowColor: "#000000",
    shadowBlur: 4,
    textTransform: "none",
    letterSpacing: 0,
    position: "bottom",
    positionY: 70,
    maxWidth: 0.84,
    alignment: "center",
    category: "youtube",
    animation: "none",
    wordMode: "off",
    fontId: "roboto",
  },
  {
    id: "netflix-style",
    name: "Netflix Style",
    description: "White text on semi-transparent black, no radius. Bottom center.",
    fontSize: 0.04,
    fontFamily: 'Inter, "Segoe UI", Arial, sans-serif',
    fontWeight: 500,
    fontStyle: "normal",
    textColor: "#FFFFFF",
    bgColor: "#000000",
    bgAlpha: 0.75,
    bgPadding: 10,
    bgRadius: 0,
    borderColor: null,
    borderWidth: 0,
    shadow: false,
    shadowColor: "#000000",
    shadowBlur: 0,
    textTransform: "none",
    letterSpacing: 0,
    position: "bottom",
    positionY: 48,
    maxWidth: 0.86,
    alignment: "center",
    category: "streaming",
    animation: "none",
    wordMode: "off",
    fontId: "inter",
  },
  {
    id: "documentary-lower",
    name: "Documentary Lower",
    description: "White text with thin black outline. Bottom center, refined.",
    fontSize: 0.04,
    fontFamily: '"Playfair Display", Georgia, serif',
    fontWeight: 500,
    fontStyle: "normal",
    textColor: "#FFFFFF",
    bgColor: null,
    bgAlpha: 1,
    bgPadding: 6,
    bgRadius: 0,
    borderColor: "#000000",
    borderWidth: 1,
    shadow: true,
    shadowColor: "#000000",
    shadowBlur: 2,
    textTransform: "none",
    letterSpacing: 0,
    position: "bottom",
    positionY: 64,
    maxWidth: 0.86,
    alignment: "center",
    category: "documentary",
    animation: "none",
    wordMode: "off",
    fontId: "playfair",
  },
  {
    id: "corporate-clean",
    name: "Corporate Clean",
    description: "Dark gray text on white rounded box. Professional, bottom.",
    fontSize: 0.04,
    fontFamily: 'Inter, "Segoe UI", Arial, sans-serif',
    fontWeight: 600,
    fontStyle: "normal",
    textColor: "#333333",
    bgColor: "#FFFFFF",
    bgAlpha: 1,
    bgPadding: 12,
    bgRadius: 8,
    borderColor: null,
    borderWidth: 0,
    shadow: false,
    shadowColor: "#000000",
    shadowBlur: 0,
    textTransform: "none",
    letterSpacing: 0,
    position: "bottom",
    positionY: 56,
    maxWidth: 0.84,
    alignment: "center",
    category: "corporate",
    animation: "none",
    wordMode: "off",
    fontId: "inter",
  },
  {
    id: "news-lower-third",
    name: "News Lower Third",
    description: "White text on solid black bar, left aligned. Bottom.",
    fontSize: 0.04,
    fontFamily: 'Inter, "Segoe UI", Arial, sans-serif',
    fontWeight: 700,
    fontStyle: "normal",
    textColor: "#FFFFFF",
    bgColor: "#000000",
    bgAlpha: 1,
    bgPadding: 14,
    bgRadius: 0,
    borderColor: null,
    borderWidth: 0,
    shadow: false,
    shadowColor: "#000000",
    shadowBlur: 0,
    textTransform: "uppercase",
    letterSpacing: 1,
    position: "bottom",
    positionY: 40,
    maxWidth: 0.7,
    alignment: "left",
    category: "news",
    animation: "none",
    wordMode: "off",
    fontId: "inter",
  },
  {
    id: "classic-film",
    name: "Classic Film",
    description: "Italic white text on solid black box. Bottom center, vintage.",
    fontSize: 0.04,
    fontFamily: '"Playfair Display", Georgia, serif',
    fontWeight: 400,
    fontStyle: "italic",
    textColor: "#FFFFFF",
    bgColor: "#000000",
    bgAlpha: 1,
    bgPadding: 12,
    bgRadius: 0,
    borderColor: null,
    borderWidth: 0,
    shadow: false,
    shadowColor: "#000000",
    shadowBlur: 0,
    textTransform: "none",
    letterSpacing: 0,
    position: "bottom",
    positionY: 48,
    maxWidth: 0.86,
    alignment: "center",
    category: "film",
    animation: "none",
    wordMode: "off",
    fontId: "playfair",
  },
];

/** Look up a preset by id; falls back to viral-hormozi. */
export function getCaptionPreset(id: string): CaptionPreset {
  return (
    CAPTION_PRESETS.find((p) => p.id === id) ??
    CAPTION_PRESETS.find((p) => p.id === "viral-hormozi") ??
    CAPTION_PRESETS[0]
  );
}

/** Presets grouped by category (for the grouped picker UI). */
export function presetsByCategory(): {
  category: CaptionPreset["category"];
  label: string;
  hint: string;
  presets: CaptionPreset[];
}[] {
  return PRESET_CATEGORIES.map((c) => ({
    category: c.id,
    label: c.label,
    hint: c.hint,
    presets: CAPTION_PRESETS.filter((p) => p.category === c.id),
  })).filter((g) => g.presets.length > 0);
}

// ---------------------------------------------------------------------------
// Font system — Windows-first stacks so the canvas preview and the libass
// burn-in resolve to the SAME family on the user's machine. The first
// family in each stack that exists wins on both sides (web-font names
// like Montserrat gracefully degrade to the system font libass uses).
// ---------------------------------------------------------------------------

export interface FontOption {
  id: string;
  name: string;
  stack: string; // CSS font stack for canvas
  ffmpegName: string; // Name libass should use (installed on Windows)
}

export const FONT_OPTIONS: FontOption[] = [
  {
    id: "inter",
    name: "Inter",
    stack: 'Inter, "Segoe UI", Arial, sans-serif',
    ffmpegName: "Segoe UI",
  },
  {
    id: "roboto",
    name: "Roboto",
    stack: 'Roboto, "Segoe UI", Arial, sans-serif',
    ffmpegName: "Segoe UI",
  },
  {
    id: "montserrat",
    name: "Montserrat",
    stack: 'Montserrat, "Segoe UI", Arial, sans-serif',
    ffmpegName: "Segoe UI",
  },
  {
    id: "segoe",
    name: "Segoe UI",
    stack: '"Segoe UI", system-ui, sans-serif',
    ffmpegName: "Segoe UI",
  },
  {
    id: "impact",
    name: "Impact",
    stack: 'Impact, "Arial Black", sans-serif',
    ffmpegName: "Impact",
  },
  {
    id: "arial-black",
    name: "Arial Black",
    stack: '"Arial Black", "Segoe UI", sans-serif',
    ffmpegName: "Arial Black",
  },
  {
    id: "bebas",
    name: "Bebas Neue",
    stack: '"Bebas Neue", Impact, "Arial Black", sans-serif',
    ffmpegName: "Impact",
  },
  {
    id: "playfair",
    name: "Playfair Display",
    stack: '"Playfair Display", Georgia, serif',
    ffmpegName: "Georgia",
  },
  {
    id: "georgia",
    name: "Georgia",
    stack: "Georgia, serif",
    ffmpegName: "Georgia",
  },
  {
    id: "arial",
    name: "Arial",
    stack: "Arial, sans-serif",
    ffmpegName: "Arial",
  },
  {
    id: "trebuchet",
    name: "Trebuchet MS",
    stack: '"Trebuchet MS", "Segoe UI", sans-serif',
    ffmpegName: "Trebuchet MS",
  },
  {
    id: "tahoma",
    name: "Tahoma",
    stack: 'Tahoma, "Segoe UI", sans-serif',
    ffmpegName: "Tahoma",
  },
  {
    id: "times",
    name: "Times New Roman",
    stack: '"Times New Roman", Times, serif',
    ffmpegName: "Times New Roman",
  },
  {
    id: "courier",
    name: "Courier New",
    stack: '"Courier New", monospace',
    ffmpegName: "Courier New",
  },
  {
    id: "verdana",
    name: "Verdana",
    stack: 'Verdana, "Segoe UI", sans-serif',
    ffmpegName: "Verdana",
  },
];

export function getFontOption(id: string): FontOption {
  return FONT_OPTIONS.find((f) => f.id === id) ?? FONT_OPTIONS[0];
}
