// src/lib/merger/captionPresets.ts — caption design presets + font options
// 10 industry-standard caption styles + 4 word-mode presets + 10 kinetic
// typography presets (storytelling / retention niche).

export interface CaptionPreset {
  id: string;
  name: string;
  description: string;
  // Visual properties (relative to video height where applicable)
  fontSize: number; // fraction of video height (0.04 = 4%)
  fontFamily: string; // CSS stack for canvas preview
  fontWeight: number; // 400, 600, 700, 900
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
  // Pre-built FFmpeg force_style string (ASS format).
  // Generated from the properties above; canvas preview tries to match.
  ffmpegStyle: string;
  // Tag for UI grouping (optional).
  category:
    | "social"
    | "youtube"
    | "streaming"
    | "documentary"
    | "corporate"
    | "news"
    | "film"
    | "kinetic";
  /**
   * Optional accent color used to highlight the *currently spoken*
   * word in word-by-word ("word" mode). If null, word-mode simply
   * scales/bolds the active word. Used by both the canvas preview
   * and the Electron ASS exporter.
   */
  highlightColor?: string | null;
  /**
   * Optional default kinetic typography animation. The user can override
   * this in the Settings panel. If absent, the preset uses "none" unless
   * the user manually picks an animation.
   */
  animation?: import("./types").CaptionAnimation;
}

// ---------------------------------------------------------------------------
// Color helpers — convert #RRGGBB to ASS &HAABBGGRR.
// ASS alpha: 00 = opaque, FF = transparent (inverted from CSS).
// ---------------------------------------------------------------------------

function hexToAssRgb(hex: string): string {
  const h = hex.replace(/^#/, "");
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  // ASS order is BBGGRR
  return `&H00${b}${g}${r}`.toUpperCase();
}

function hexToAssAlpha(hex: string, alpha01: number): string {
  // alpha01: 1 = fully opaque, 0 = fully transparent
  const h = hex.replace(/^#/, "");
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  const assAlpha = Math.round((1 - alpha01) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
  return `&H${assAlpha}${b}${g}${r}`.toUpperCase();
}

// Alignment constants for ASS (numpad layout, 1-9).
// 1=bottom-left, 2=bottom-center, 3=bottom-right
// 4=middle-left, 5=middle-center, 6=middle-right
// 7=top-left,    8=top-center,    9=top-right
function assAlignmentFor(
  position: "top" | "center" | "bottom",
  alignment: "left" | "center" | "right",
): number {
  const row =
    position === "top" ? 7 : position === "center" ? 4 : 1;
  const col =
    alignment === "left" ? 0 : alignment === "right" ? 2 : 1;
  return row + col;
}

interface BuildStyleInput {
  fontName: string;
  fontSize: number;
  textColor: string;
  bgColor: string | null;
  bgAlpha: number;
  borderColor: string | null;
  borderWidth: number;
  shadow: boolean;
  shadowColor: string;
  shadowBlur: number;
  bold: boolean;
  italic: boolean;
  position: "top" | "center" | "bottom";
  alignment: "left" | "center" | "right";
  positionY: number;
}

function buildFfmpegStyle(input: BuildStyleInput): string {
  const parts: string[] = [];
  parts.push(`FontName=${input.fontName}`);
  parts.push(`FontSize=${input.fontSize}`);
  parts.push(`PrimaryColour=${hexToAssRgb(input.textColor)}`);
  parts.push(`OutlineColour=${hexToAssRgb(input.borderColor || "#000000")}`);
  if (input.bgColor) {
    parts.push(`BackColour=${hexToAssAlpha(input.bgColor, input.bgAlpha)}`);
  }
  parts.push(`Bold=${input.bold ? -1 : 0}`);
  parts.push(`Italic=${input.italic ? -1 : 0}`);
  // BorderStyle: 1 = outline + drop shadow, 3 = opaque box background
  parts.push(`BorderStyle=${input.bgColor ? 3 : 1}`);
  parts.push(`Outline=${input.borderWidth}`);
  parts.push(`Shadow=${input.shadow ? Math.max(1, input.shadowBlur) : 0}`);
  parts.push(`Alignment=${assAlignmentFor(input.position, input.alignment)}`);
  parts.push(`MarginL=20`);
  parts.push(`MarginR=20`);
  parts.push(`MarginV=${input.positionY}`);
  return parts.join(",");
}

// ---------------------------------------------------------------------------
// The 10 industry-standard caption presets.
// ---------------------------------------------------------------------------

export const CAPTION_PRESETS: CaptionPreset[] = [
  {
    id: "tiktok-bold",
    name: "TikTok Bold",
    description: "White text, rounded black box, bold, uppercase. Bottom center.",
    fontSize: 0.055,
    fontFamily: 'Montserrat, "Segoe UI", sans-serif',
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
    ffmpegStyle: buildFfmpegStyle({
      fontName: "Arial",
      fontSize: 28,
      textColor: "#FFFFFF",
      bgColor: "#000000",
      bgAlpha: 1,
      borderColor: "#000000",
      borderWidth: 0,
      shadow: false,
      shadowColor: "#000000",
      shadowBlur: 0,
      bold: true,
      italic: false,
      position: "bottom",
      alignment: "center",
      positionY: 60,
    }),
  },
  {
    id: "youtube-clean",
    name: "YouTube Clean",
    description: "White text with soft drop shadow, no background. Bottom center.",
    fontSize: 0.045,
    fontFamily: 'Roboto, "Segoe UI", sans-serif',
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
    ffmpegStyle: buildFfmpegStyle({
      fontName: "Arial",
      fontSize: 22,
      textColor: "#FFFFFF",
      bgColor: null,
      bgAlpha: 1,
      borderColor: "#000000",
      borderWidth: 2,
      shadow: true,
      shadowColor: "#000000",
      shadowBlur: 3,
      bold: true,
      italic: false,
      position: "bottom",
      alignment: "center",
      positionY: 70,
    }),
  },
  {
    id: "netflix-style",
    name: "Netflix Style",
    description: "White text on semi-transparent black, no radius. Bottom center.",
    fontSize: 0.04,
    fontFamily: 'Inter, "Segoe UI", sans-serif',
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
    ffmpegStyle: buildFfmpegStyle({
      fontName: "Arial",
      fontSize: 20,
      textColor: "#FFFFFF",
      bgColor: "#000000",
      bgAlpha: 0.75,
      borderColor: "#000000",
      borderWidth: 0,
      shadow: false,
      shadowColor: "#000000",
      shadowBlur: 0,
      bold: false,
      italic: false,
      position: "bottom",
      alignment: "center",
      positionY: 48,
    }),
  },
  {
    id: "instagram-reel",
    name: "Instagram Reel",
    description: "White bold text on violet-pink gradient box. Centered.",
    fontSize: 0.05,
    fontFamily: 'Montserrat, "Segoe UI", sans-serif',
    fontWeight: 800,
    fontStyle: "normal",
    textColor: "#FFFFFF",
    bgColor: "#8B2BB8", // single dominant color (gradient simulated by canvas)
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
    ffmpegStyle: buildFfmpegStyle({
      fontName: "Arial",
      fontSize: 26,
      textColor: "#FFFFFF",
      bgColor: "#8B2BB8",
      bgAlpha: 1,
      borderColor: "#000000",
      borderWidth: 0,
      shadow: false,
      shadowColor: "#000000",
      shadowBlur: 0,
      bold: true,
      italic: false,
      position: "center",
      alignment: "center",
      positionY: 0,
    }),
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
    ffmpegStyle: buildFfmpegStyle({
      fontName: "Times New Roman",
      fontSize: 20,
      textColor: "#FFFFFF",
      bgColor: null,
      bgAlpha: 1,
      borderColor: "#000000",
      borderWidth: 1,
      shadow: true,
      shadowColor: "#000000",
      shadowBlur: 1,
      bold: false,
      italic: false,
      position: "bottom",
      alignment: "center",
      positionY: 64,
    }),
  },
  {
    id: "corporate-clean",
    name: "Corporate Clean",
    description: "Dark gray text on white rounded box. Professional, bottom.",
    fontSize: 0.04,
    fontFamily: 'Inter, "Segoe UI", sans-serif',
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
    ffmpegStyle: buildFfmpegStyle({
      fontName: "Arial",
      fontSize: 20,
      textColor: "#333333",
      bgColor: "#FFFFFF",
      bgAlpha: 1,
      borderColor: "#000000",
      borderWidth: 0,
      shadow: false,
      shadowColor: "#000000",
      shadowBlur: 0,
      bold: true,
      italic: false,
      position: "bottom",
      alignment: "center",
      positionY: 56,
    }),
  },
  {
    id: "karaoke-style",
    name: "Karaoke Style",
    description: "Bold yellow text with thick black outline. Bottom center.",
    fontSize: 0.05,
    fontFamily: 'Montserrat, "Segoe UI", sans-serif',
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
    ffmpegStyle: buildFfmpegStyle({
      fontName: "Arial",
      fontSize: 26,
      textColor: "#FFD700",
      bgColor: null,
      bgAlpha: 1,
      borderColor: "#000000",
      borderWidth: 2,
      shadow: true,
      shadowColor: "#000000",
      shadowBlur: 2,
      bold: true,
      italic: false,
      position: "bottom",
      alignment: "center",
      positionY: 60,
    }),
  },
  {
    id: "news-lower-third",
    name: "News Lower Third",
    description: "White text on solid black bar, left aligned. Bottom.",
    fontSize: 0.04,
    fontFamily: 'Inter, "Segoe UI", sans-serif',
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
    ffmpegStyle: buildFfmpegStyle({
      fontName: "Arial",
      fontSize: 20,
      textColor: "#FFFFFF",
      bgColor: "#000000",
      bgAlpha: 1,
      borderColor: "#000000",
      borderWidth: 0,
      shadow: false,
      shadowColor: "#000000",
      shadowBlur: 0,
      bold: true,
      italic: false,
      position: "bottom",
      alignment: "left",
      positionY: 40,
    }),
  },
  {
    id: "minimal-glow",
    name: "Minimal Glow",
    description: "White text with soft white glow, no background. Centered.",
    fontSize: 0.045,
    fontFamily: 'Inter, "Segoe UI", sans-serif',
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
    ffmpegStyle: buildFfmpegStyle({
      fontName: "Arial",
      fontSize: 22,
      textColor: "#FFFFFF",
      bgColor: null,
      bgAlpha: 1,
      borderColor: "#FFFFFF",
      borderWidth: 0,
      shadow: true,
      shadowColor: "#FFFFFF",
      shadowBlur: 4,
      bold: false,
      italic: false,
      position: "center",
      alignment: "center",
      positionY: 0,
    }),
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
    ffmpegStyle: buildFfmpegStyle({
      fontName: "Times New Roman",
      fontSize: 20,
      textColor: "#FFFFFF",
      bgColor: "#000000",
      bgAlpha: 1,
      borderColor: "#000000",
      borderWidth: 0,
      shadow: false,
      shadowColor: "#000000",
      shadowBlur: 0,
      bold: false,
      italic: true,
      position: "bottom",
      alignment: "center",
      positionY: 48,
    }),
  },
  // ─── VIRAL PRESETS (static styles, no word animation) ─────────────────
  {
    id: "viral-karaoke",
    name: "Karaoke",
    description: "Bold yellow text with thick black outline, karaoke energy.",
    fontSize: 0.05, fontFamily: 'Montserrat, "Segoe UI", sans-serif',
    fontWeight: 800, fontStyle: "normal",
    textColor: "#FFD700", bgColor: null, bgAlpha: 1, bgPadding: 8, bgRadius: 0,
    borderColor: "#000000", borderWidth: 3, shadow: true,
    shadowColor: "#000000", shadowBlur: 3, textTransform: "uppercase",
    letterSpacing: 1, position: "bottom", positionY: 60, maxWidth: 0.84,
    alignment: "center", category: "social",
    ffmpegStyle: buildFfmpegStyle({ fontName: "Arial", fontSize: 26, textColor: "#FFD700", bgColor: null, bgAlpha: 1, borderColor: "#000000", borderWidth: 3, shadow: true, shadowColor: "#000000", shadowBlur: 2, bold: true, italic: false, position: "bottom", alignment: "center", positionY: 60 }),
  },
  {
    id: "viral-hormozi",
    name: "Hormozi",
    description: "Single bold centered word feel, huge white text, no background.",
    fontSize: 0.075, fontFamily: 'Montserrat, "Segoe UI", sans-serif',
    fontWeight: 900, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, bgPadding: 8, bgRadius: 0,
    borderColor: "#000000", borderWidth: 2, shadow: true,
    shadowColor: "#000000", shadowBlur: 6, textTransform: "uppercase",
    letterSpacing: 2, position: "center", positionY: 0, maxWidth: 0.9,
    alignment: "center", category: "social",
    ffmpegStyle: buildFfmpegStyle({ fontName: "Arial", fontSize: 38, textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, borderColor: "#000000", borderWidth: 2, shadow: true, shadowColor: "#000000", shadowBlur: 4, bold: true, italic: false, position: "center", alignment: "center", positionY: 0 }),
  },
  {
    id: "viral-boxed",
    name: "Boxed",
    description: "White text on solid violet box, bold and unmissable.",
    fontSize: 0.055, fontFamily: 'Montserrat, "Segoe UI", sans-serif',
    fontWeight: 800, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: "#7C3AED", bgAlpha: 1, bgPadding: 14, bgRadius: 8,
    borderColor: null, borderWidth: 0, shadow: true,
    shadowColor: "#000000", shadowBlur: 4, textTransform: "uppercase",
    letterSpacing: 1, position: "bottom", positionY: 50, maxWidth: 0.82,
    alignment: "center", category: "social",
    ffmpegStyle: buildFfmpegStyle({ fontName: "Arial", fontSize: 28, textColor: "#FFFFFF", bgColor: "#7C3AED", bgAlpha: 1, borderColor: "#000000", borderWidth: 0, shadow: true, shadowColor: "#000000", shadowBlur: 3, bold: true, italic: false, position: "bottom", alignment: "center", positionY: 50 }),
  },
  {
    id: "viral-clean",
    name: "Clean",
    description: "Bright green accent text on dark shadow, subtle and viral.",
    fontSize: 0.05, fontFamily: 'Inter, "Segoe UI", sans-serif',
    fontWeight: 700, fontStyle: "normal",
    textColor: "#00FF88", bgColor: null, bgAlpha: 1, bgPadding: 8, bgRadius: 0,
    borderColor: "#000000", borderWidth: 2, shadow: true,
    shadowColor: "#000000", shadowBlur: 4, textTransform: "none",
    letterSpacing: 0, position: "bottom", positionY: 60, maxWidth: 0.84,
    alignment: "center", category: "social",
    ffmpegStyle: buildFfmpegStyle({ fontName: "Arial", fontSize: 26, textColor: "#00FF88", bgColor: null, bgAlpha: 1, borderColor: "#000000", borderWidth: 2, shadow: true, shadowColor: "#000000", shadowBlur: 3, bold: true, italic: false, position: "bottom", alignment: "center", positionY: 60 }),
  },
  {
    id: "viral-underline",
    name: "Underline",
    description: "White text with green underline bar accent.",
    fontSize: 0.05, fontFamily: 'Inter, "Segoe UI", sans-serif',
    fontWeight: 700, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, bgPadding: 8, bgRadius: 0,
    borderColor: "#000000", borderWidth: 1, shadow: true,
    shadowColor: "#000000", shadowBlur: 3, textTransform: "none",
    letterSpacing: 0, position: "bottom", positionY: 60, maxWidth: 0.84,
    alignment: "center", category: "social",
    ffmpegStyle: buildFfmpegStyle({ fontName: "Arial", fontSize: 26, textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, borderColor: "#000000", borderWidth: 1, shadow: true, shadowColor: "#000000", shadowBlur: 2, bold: true, italic: false, position: "bottom", alignment: "center", positionY: 60 }),
  },
  {
    id: "viral-dim",
    name: "Dim",
    description: "White text with heavy dark shadow, dramatic dim look.",
    fontSize: 0.05, fontFamily: 'Inter, "Segoe UI", sans-serif',
    fontWeight: 600, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, bgPadding: 8, bgRadius: 0,
    borderColor: "#000000", borderWidth: 3, shadow: true,
    shadowColor: "#000000", shadowBlur: 8, textTransform: "none",
    letterSpacing: 0, position: "bottom", positionY: 60, maxWidth: 0.84,
    alignment: "center", category: "social",
    ffmpegStyle: buildFfmpegStyle({ fontName: "Arial", fontSize: 26, textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, borderColor: "#000000", borderWidth: 3, shadow: true, shadowColor: "#000000", shadowBlur: 6, bold: true, italic: false, position: "bottom", alignment: "center", positionY: 60 }),
  },
  {
    id: "viral-reveal",
    name: "Reveal",
    description: "Typewriter feel — white text on black box, monospace.",
    fontSize: 0.045, fontFamily: '"Courier New", monospace',
    fontWeight: 700, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: "#000000", bgAlpha: 0.85, bgPadding: 10, bgRadius: 0,
    borderColor: null, borderWidth: 0, shadow: false,
    shadowColor: "#000000", shadowBlur: 0, textTransform: "none",
    letterSpacing: 1, position: "bottom", positionY: 50, maxWidth: 0.82,
    alignment: "center", category: "social",
    ffmpegStyle: buildFfmpegStyle({ fontName: "Courier New", fontSize: 24, textColor: "#FFFFFF", bgColor: "#000000", bgAlpha: 0.85, borderColor: "#000000", borderWidth: 0, shadow: false, shadowColor: "#000000", shadowBlur: 0, bold: true, italic: false, position: "bottom", alignment: "center", positionY: 50 }),
  },
  {
    id: "viral-bounce",
    name: "Bounce",
    description: "High energy — bold white text, thick outline, top position.",
    fontSize: 0.055, fontFamily: 'Montserrat, "Segoe UI", sans-serif',
    fontWeight: 900, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, bgPadding: 8, bgRadius: 0,
    borderColor: "#000000", borderWidth: 4, shadow: true,
    shadowColor: "#000000", shadowBlur: 4, textTransform: "uppercase",
    letterSpacing: 1, position: "top", positionY: 50, maxWidth: 0.82,
    alignment: "center", category: "social",
    ffmpegStyle: buildFfmpegStyle({ fontName: "Arial", fontSize: 28, textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, borderColor: "#000000", borderWidth: 4, shadow: true, shadowColor: "#000000", shadowBlur: 3, bold: true, italic: false, position: "top", alignment: "center", positionY: 50 }),
  },
  {
    id: "viral-drift",
    name: "Drift",
    description: "Cinematic smooth — light italic white, gentle shadow, center.",
    fontSize: 0.048, fontFamily: '"Playfair Display", Georgia, serif',
    fontWeight: 400, fontStyle: "italic",
    textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, bgPadding: 8, bgRadius: 0,
    borderColor: "#000000", borderWidth: 2, shadow: true,
    shadowColor: "#000000", shadowBlur: 6, textTransform: "none",
    letterSpacing: 1, position: "bottom", positionY: 55, maxWidth: 0.84,
    alignment: "center", category: "film",
    ffmpegStyle: buildFfmpegStyle({ fontName: "Times New Roman", fontSize: 24, textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, borderColor: "#000000", borderWidth: 2, shadow: true, shadowColor: "#000000", shadowBlur: 4, bold: false, italic: true, position: "bottom", alignment: "center", positionY: 55 }),
  },
  {
    id: "viral-accent",
    name: "Accent",
    description: "Editorial — sentence case, italic key words, elegant serif.",
    fontSize: 0.045, fontFamily: '"Playfair Display", Georgia, serif',
    fontWeight: 500, fontStyle: "italic",
    textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, bgPadding: 8, bgRadius: 0,
    borderColor: "#000000", borderWidth: 1, shadow: true,
    shadowColor: "#000000", shadowBlur: 3, textTransform: "none",
    letterSpacing: 0, position: "bottom", positionY: 60, maxWidth: 0.84,
    alignment: "center", category: "documentary",
    ffmpegStyle: buildFfmpegStyle({ fontName: "Times New Roman", fontSize: 22, textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, borderColor: "#000000", borderWidth: 1, shadow: true, shadowColor: "#000000", shadowBlur: 2, bold: false, italic: true, position: "bottom", alignment: "center", positionY: 60 }),
  },
  {
    id: "viral-spotlight",
    name: "Spotlight",
    description: "Gold accent text with dark outline, premium spotlight feel.",
    fontSize: 0.05, fontFamily: 'Montserrat, "Segoe UI", sans-serif',
    fontWeight: 700, fontStyle: "normal",
    textColor: "#FFD700", bgColor: null, bgAlpha: 1, bgPadding: 8, bgRadius: 0,
    borderColor: "#000000", borderWidth: 2, shadow: true,
    shadowColor: "#000000", shadowBlur: 6, textTransform: "uppercase",
    letterSpacing: 1, position: "bottom", positionY: 55, maxWidth: 0.84,
    alignment: "center", category: "social",
    ffmpegStyle: buildFfmpegStyle({ fontName: "Arial", fontSize: 26, textColor: "#FFD700", bgColor: null, bgAlpha: 1, borderColor: "#000000", borderWidth: 2, shadow: true, shadowColor: "#000000", shadowBlur: 4, bold: true, italic: false, position: "bottom", alignment: "center", positionY: 55 }),
  },
  // ─── WORD-BY-WORD PRESETS (whisper-powered viral karaoke) ──────────
  // Pair these with CaptionSettings.wordMode = "word" or "word-only".
  {
    id: "word-karaoke",
    name: "Karaoke Pop",
    description: "Word-by-word karaoke — dim text, electric-yellow active word.",
    fontSize: 0.06, fontFamily: 'Montserrat, "Segoe UI", sans-serif',
    fontWeight: 800, fontStyle: "normal",
    textColor: "#9CA3AF", bgColor: null, bgAlpha: 1, bgPadding: 10, bgRadius: 0,
    borderColor: "#000000", borderWidth: 3, shadow: true,
    shadowColor: "#000000", shadowBlur: 4, textTransform: "uppercase",
    letterSpacing: 1, position: "center", positionY: 0, maxWidth: 0.88,
    alignment: "center", category: "social", highlightColor: "#FDE047",
    animation: "pop-in",
    ffmpegStyle: buildFfmpegStyle({ fontName: "Arial", fontSize: 30, textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, borderColor: "#000000", borderWidth: 3, shadow: true, shadowColor: "#000000", shadowBlur: 3, bold: true, italic: false, position: "center", alignment: "center", positionY: 0 }),
  },
  {
    id: "word-hormozi",
    name: "Word Pop",
    description: "Single active word, bold white, green highlight — Hormozi style.",
    fontSize: 0.085, fontFamily: 'Montserrat, "Segoe UI", sans-serif',
    fontWeight: 900, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: "#000000", bgAlpha: 0.85, bgPadding: 16, bgRadius: 10,
    borderColor: null, borderWidth: 0, shadow: true,
    shadowColor: "#000000", shadowBlur: 8, textTransform: "uppercase",
    letterSpacing: 2, position: "center", positionY: 0, maxWidth: 0.92,
    alignment: "center", category: "social", highlightColor: "#22D3EE",
    animation: "bounce-in",
    ffmpegStyle: buildFfmpegStyle({ fontName: "Arial", fontSize: 42, textColor: "#FFFFFF", bgColor: "#000000", bgAlpha: 0.85, borderColor: "#000000", borderWidth: 0, shadow: true, shadowColor: "#000000", shadowBlur: 6, bold: true, italic: false, position: "center", alignment: "center", positionY: 0 }),
  },
  {
    id: "word-neon",
    name: "Neon Pulse",
    description: "Cyan text, magenta active word — synthwave karaoke.",
    fontSize: 0.06, fontFamily: 'Inter, "Segoe UI", sans-serif',
    fontWeight: 700, fontStyle: "normal",
    textColor: "#67E8F9", bgColor: null, bgAlpha: 1, bgPadding: 10, bgRadius: 0,
    borderColor: "#0F172A", borderWidth: 3, shadow: true,
    shadowColor: "#0891B2", shadowBlur: 8, textTransform: "uppercase",
    letterSpacing: 1, position: "center", positionY: 0, maxWidth: 0.88,
    alignment: "center", category: "social", highlightColor: "#F0ABFC",
    animation: "scale-pulse",
    ffmpegStyle: buildFfmpegStyle({ fontName: "Arial", fontSize: 30, textColor: "#67E8F9", bgColor: null, bgAlpha: 1, borderColor: "#0F172A", borderWidth: 3, shadow: true, shadowColor: "#0891B2", shadowBlur: 6, bold: true, italic: false, position: "center", alignment: "center", positionY: 0 }),
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
    alignment: "center", category: "film", highlightColor: "#FBBF24",
    animation: "fade-through",
    ffmpegStyle: buildFfmpegStyle({ fontName: "Times New Roman", fontSize: 28, textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, borderColor: "#000000", borderWidth: 2, shadow: true, shadowColor: "#000000", shadowBlur: 4, bold: false, italic: true, position: "bottom", alignment: "center", positionY: 70 }),
  },

  // ─── KINETIC TYPOGRAPHY PRESETS (storytelling / retention niche) ───
  // 10 motion-first caption styles. Each one pairs a hand-picked font
  // + color combo with a kinetic typography animation tuned for short-
  // form storytelling. Designed to re-engage the viewer's eye on every
  // word without being distracting — proven retention bumpers.
  {
    id: "kinetic-pop",
    name: "Pop Reveal",
    description: "Bold white on black box — words pop in with bounce. Retention hook.",
    fontSize: 0.06, fontFamily: 'Montserrat, "Segoe UI", sans-serif',
    fontWeight: 900, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: "#000000", bgAlpha: 0.9, bgPadding: 18, bgRadius: 12,
    borderColor: null, borderWidth: 0, shadow: true,
    shadowColor: "#000000", shadowBlur: 12, textTransform: "uppercase",
    letterSpacing: 1, position: "center", positionY: 0, maxWidth: 0.9,
    alignment: "center", category: "kinetic", highlightColor: "#FDE047",
    animation: "pop-in",
    ffmpegStyle: buildFfmpegStyle({ fontName: "Arial", fontSize: 32, textColor: "#FFFFFF", bgColor: "#000000", bgAlpha: 0.9, borderColor: "#000000", borderWidth: 0, shadow: true, shadowColor: "#000000", shadowBlur: 8, bold: true, italic: false, position: "center", alignment: "center", positionY: 0 }),
  },
  {
    id: "kinetic-slide",
    name: "Slide Story",
    description: "Words slide up from below with fade — clean narrative reveal.",
    fontSize: 0.055, fontFamily: 'Inter, "Segoe UI", sans-serif',
    fontWeight: 700, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, bgPadding: 10, bgRadius: 0,
    borderColor: "#000000", borderWidth: 3, shadow: true,
    shadowColor: "#000000", shadowBlur: 5, textTransform: "none",
    letterSpacing: 0, position: "bottom", positionY: 80, maxWidth: 0.86,
    alignment: "center", category: "kinetic", highlightColor: "#FDE047",
    animation: "slide-up",
    ffmpegStyle: buildFfmpegStyle({ fontName: "Arial", fontSize: 28, textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, borderColor: "#000000", borderWidth: 3, shadow: true, shadowColor: "#000000", shadowBlur: 4, bold: true, italic: false, position: "bottom", alignment: "center", positionY: 80 }),
  },
  {
    id: "kinetic-bounce",
    name: "Bounce Drop",
    description: "Words bounce in from above with spring — playful attention grab.",
    fontSize: 0.07, fontFamily: 'Montserrat, "Segoe UI", sans-serif',
    fontWeight: 800, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: "#7C3AED", bgAlpha: 1, bgPadding: 14, bgRadius: 8,
    borderColor: null, borderWidth: 0, shadow: true,
    shadowColor: "#000000", shadowBlur: 8, textTransform: "uppercase",
    letterSpacing: 2, position: "center", positionY: 0, maxWidth: 0.9,
    alignment: "center", category: "kinetic", highlightColor: "#FDE047",
    animation: "bounce-in",
    ffmpegStyle: buildFfmpegStyle({ fontName: "Arial", fontSize: 36, textColor: "#FFFFFF", bgColor: "#7C3AED", bgAlpha: 1, borderColor: "#000000", borderWidth: 0, shadow: true, shadowColor: "#000000", shadowBlur: 6, bold: true, italic: false, position: "center", alignment: "center", positionY: 0 }),
  },
  {
    id: "kinetic-pulse",
    name: "Pulse Beat",
    description: "Active word pulses 1.18× — rhythmic emphasis for stories.",
    fontSize: 0.058, fontFamily: 'Inter, "Segoe UI", sans-serif',
    fontWeight: 800, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, bgPadding: 8, bgRadius: 0,
    borderColor: "#000000", borderWidth: 2, shadow: true,
    shadowColor: "#000000", shadowBlur: 4, textTransform: "uppercase",
    letterSpacing: 1, position: "center", positionY: 0, maxWidth: 0.88,
    alignment: "center", category: "kinetic", highlightColor: "#F97316",
    animation: "scale-pulse",
    ffmpegStyle: buildFfmpegStyle({ fontName: "Arial", fontSize: 30, textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, borderColor: "#000000", borderWidth: 2, shadow: true, shadowColor: "#000000", shadowBlur: 3, bold: true, italic: false, position: "center", alignment: "center", positionY: 0 }),
  },
  {
    id: "kinetic-fade",
    name: "Soft Fade",
    description: "Words fade through smoothly — cinematic narration mode.",
    fontSize: 0.05, fontFamily: '"Playfair Display", Georgia, serif',
    fontWeight: 500, fontStyle: "italic",
    textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, bgPadding: 8, bgRadius: 0,
    borderColor: "#000000", borderWidth: 2, shadow: true,
    shadowColor: "#000000", shadowBlur: 8, textTransform: "none",
    letterSpacing: 0, position: "bottom", positionY: 70, maxWidth: 0.86,
    alignment: "center", category: "kinetic", highlightColor: "#FBBF24",
    animation: "fade-through",
    ffmpegStyle: buildFfmpegStyle({ fontName: "Times New Roman", fontSize: 26, textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, borderColor: "#000000", borderWidth: 2, shadow: true, shadowColor: "#000000", shadowBlur: 6, bold: false, italic: true, position: "bottom", alignment: "center", positionY: 70 }),
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
    animation: "typewriter",
    ffmpegStyle: buildFfmpegStyle({ fontName: "Courier New", fontSize: 26, textColor: "#FFFFFF", bgColor: "#000000", bgAlpha: 0.85, borderColor: "#000000", borderWidth: 0, shadow: false, shadowColor: "#000000", shadowBlur: 0, bold: true, italic: false, position: "center", alignment: "center", positionY: 0 }),
  },
  {
    id: "kinetic-reveal",
    name: "Masked Reveal",
    description: "Words reveal from behind a mask — mysterious storytelling.",
    fontSize: 0.058, fontFamily: 'Montserrat, "Segoe UI", sans-serif',
    fontWeight: 800, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, bgPadding: 8, bgRadius: 0,
    borderColor: "#000000", borderWidth: 3, shadow: true,
    shadowColor: "#000000", shadowBlur: 6, textTransform: "uppercase",
    letterSpacing: 1, position: "center", positionY: 0, maxWidth: 0.88,
    alignment: "center", category: "kinetic", highlightColor: "#FDE047",
    animation: "reveal",
    ffmpegStyle: buildFfmpegStyle({ fontName: "Arial", fontSize: 30, textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, borderColor: "#000000", borderWidth: 3, shadow: true, shadowColor: "#000000", shadowBlur: 4, bold: true, italic: false, position: "center", alignment: "center", positionY: 0 }),
  },
  {
    id: "kinetic-wave",
    name: "Wave Drift",
    description: "Words gently wave up/down — calm, rhythmic narration.",
    fontSize: 0.055, fontFamily: 'Inter, "Segoe UI", sans-serif',
    fontWeight: 700, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, bgPadding: 8, bgRadius: 0,
    borderColor: "#000000", borderWidth: 2, shadow: true,
    shadowColor: "#000000", shadowBlur: 4, textTransform: "none",
    letterSpacing: 0, position: "center", positionY: 0, maxWidth: 0.88,
    alignment: "center", category: "kinetic", highlightColor: "#22D3EE",
    animation: "wave",
    ffmpegStyle: buildFfmpegStyle({ fontName: "Arial", fontSize: 28, textColor: "#FFFFFF", bgColor: null, bgAlpha: 1, borderColor: "#000000", borderWidth: 2, shadow: true, shadowColor: "#000000", shadowBlur: 3, bold: true, italic: false, position: "center", alignment: "center", positionY: 0 }),
  },
  {
    id: "kinetic-jitter",
    name: "Energy Jitter",
    description: "Small random shake — energetic, attention-sustaining.",
    fontSize: 0.06, fontFamily: 'Montserrat, "Segoe UI", sans-serif',
    fontWeight: 800, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: "#EF4444", bgAlpha: 0.95, bgPadding: 12, bgRadius: 6,
    borderColor: null, borderWidth: 0, shadow: true,
    shadowColor: "#000000", shadowBlur: 6, textTransform: "uppercase",
    letterSpacing: 1, position: "center", positionY: 0, maxWidth: 0.88,
    alignment: "center", category: "kinetic", highlightColor: "#FDE047",
    animation: "jitter",
    ffmpegStyle: buildFfmpegStyle({ fontName: "Arial", fontSize: 32, textColor: "#FFFFFF", bgColor: "#EF4444", bgAlpha: 0.95, borderColor: "#000000", borderWidth: 0, shadow: true, shadowColor: "#000000", shadowBlur: 4, bold: true, italic: false, position: "center", alignment: "center", positionY: 0 }),
  },
  {
    id: "kinetic-shake",
    name: "Impact Shake",
    description: "Strong horizontal shake on each word — punchy, high-energy.",
    fontSize: 0.07, fontFamily: 'Montserrat, "Segoe UI", sans-serif',
    fontWeight: 900, fontStyle: "normal",
    textColor: "#FFFFFF", bgColor: "#000000", bgAlpha: 1, bgPadding: 14, bgRadius: 4,
    borderColor: "#FDE047", borderWidth: 2, shadow: true,
    shadowColor: "#000000", shadowBlur: 8, textTransform: "uppercase",
    letterSpacing: 2, position: "center", positionY: 0, maxWidth: 0.9,
    alignment: "center", category: "kinetic", highlightColor: "#FDE047",
    animation: "shake",
    ffmpegStyle: buildFfmpegStyle({ fontName: "Arial", fontSize: 36, textColor: "#FFFFFF", bgColor: "#000000", bgAlpha: 1, borderColor: "#FDE047", borderWidth: 2, shadow: true, shadowColor: "#000000", shadowBlur: 6, bold: true, italic: false, position: "center", alignment: "center", positionY: 0 }),
  },
];

/** Look up a preset by id; falls back to the first preset. */
export function getCaptionPreset(id: string): CaptionPreset {
  return CAPTION_PRESETS.find((p) => p.id === id) ?? CAPTION_PRESETS[0];
}

// ---------------------------------------------------------------------------
// Font system — system font stacks (no network downloads needed).
// `ffmpegName` is the FFmpeg/ASS-side font; we prefer universally available
// system fonts so the burned-in export matches the preview.
// ---------------------------------------------------------------------------

export interface FontOption {
  id: string;
  name: string;
  stack: string; // CSS font stack for canvas
  ffmpegName: string; // Name FFmpeg's libass should use
}

export const FONT_OPTIONS: FontOption[] = [
  {
    id: "inter",
    name: "Inter",
    stack: 'Inter, "Segoe UI", sans-serif',
    ffmpegName: "Arial",
  },
  {
    id: "roboto",
    name: "Roboto",
    stack: 'Roboto, "Segoe UI", sans-serif',
    ffmpegName: "Arial",
  },
  {
    id: "montserrat",
    name: "Montserrat",
    stack: 'Montserrat, "Segoe UI", sans-serif',
    ffmpegName: "Arial Bold",
  },
  {
    id: "playfair",
    name: "Playfair Display",
    stack: '"Playfair Display", Georgia, serif',
    ffmpegName: "Times New Roman",
  },
  {
    id: "bebas",
    name: "Bebas Neue",
    stack: '"Bebas Neue", Impact, sans-serif',
    ffmpegName: "Impact",
  },
  {
    id: "arial",
    name: "Arial",
    stack: "Arial, sans-serif",
    ffmpegName: "Arial",
  },
  {
    id: "times",
    name: "Times New Roman",
    stack: '"Times New Roman", serif',
    ffmpegName: "Times New Roman",
  },
  {
    id: "courier",
    name: "Courier New",
    stack: '"Courier New", monospace',
    ffmpegName: "Courier New",
  },
  {
    id: "georgia",
    name: "Georgia",
    stack: "Georgia, serif",
    ffmpegName: "Georgia",
  },
  {
    id: "verdana",
    name: "Verdana",
    stack: "Verdana, sans-serif",
    ffmpegName: "Verdana",
  },
];

export function getFontOption(id: string): FontOption {
  return FONT_OPTIONS.find((f) => f.id === id) ?? FONT_OPTIONS[0];
}
