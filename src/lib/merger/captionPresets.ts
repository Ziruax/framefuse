// src/lib/merger/captionPresets.ts — caption design presets + font options
// 10 industry-standard caption styles for TikTok, YouTube, Netflix,
// Instagram, documentary, corporate, karaoke, news, minimal, and film.

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
    | "film";
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
