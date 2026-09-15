// src/lib/merger/headlinePresets.ts — viral headline/title overlay presets (v4.2)
//
// Headlines are hook titles that sit INDEPENDENT of captions: big text at the
// top (or center) of the frame that grabs attention in the first seconds.
// Each preset is a full visual spec consumed by:
//   - native.ts drawHeadline()   → canvas preview
//   - electron/main.js            → ASS burn-in (Style + Dialogue lines)
//
// Design rules (mirrors captionPresets):
//   - All px values are 1080p-referenced (scaled by canvas height / 1080).
//   - Font stacks degrade to a Windows-installed family; `ffmpegName` is the
//     name libass uses (guaranteed on a stock Windows install).

export interface HeadlinePreset {
  id: string;
  name: string;
  description: string;
  /** CSS font stack for the canvas preview. */
  fontFamily: string;
  /** Font family name for libass (installed on Windows). */
  ffmpegName: string;
  /** Font size as a fraction of video height. */
  fontSize: number;
  fontWeight: number;
  fontStyle: "normal" | "italic";
  textColor: string;
  /** Accent color — used for the glow (shadow) or the sticker border. */
  accentColor: string | null;
  bgColor: string | null;
  bgAlpha: number;
  bgPadding: number;
  bgRadius: number;
  borderColor: string | null;
  borderWidth: number;
  shadow: boolean;
  shadowColor: string;
  shadowBlur: number;
  textTransform: "none" | "uppercase";
  letterSpacing: number;
  /** Default margin from the anchored edge (px @1080p). */
  positionY: number;
  /** Max width fraction of the frame before wrapping. */
  maxWidth: number;
}

export const HEADLINE_PRESETS: HeadlinePreset[] = [
  {
    id: "impact",
    name: "Bold Impact",
    description: "Massive uppercase white with a fat black outline — the classic hook.",
    fontFamily: 'Impact, "Arial Black", sans-serif',
    ffmpegName: "Impact",
    fontSize: 0.085,
    fontWeight: 900,
    fontStyle: "normal",
    textColor: "#FFFFFF",
    accentColor: null,
    bgColor: null,
    bgAlpha: 1,
    bgPadding: 18,
    bgRadius: 12,
    borderColor: "#000000",
    borderWidth: 6,
    shadow: true,
    shadowColor: "#000000",
    shadowBlur: 12,
    textTransform: "uppercase",
    letterSpacing: 2,
    positionY: 90,
    maxWidth: 0.86,
  },
  {
    id: "neon",
    name: "Neon Hook",
    description: "Electric cyan text with a hot magenta glow — night-city energy.",
    fontFamily: 'Montserrat, "Segoe UI", Arial, sans-serif',
    ffmpegName: "Segoe UI",
    fontSize: 0.062,
    fontWeight: 800,
    fontStyle: "normal",
    textColor: "#67E8F9",
    accentColor: "#E879F9",
    bgColor: null,
    bgAlpha: 1,
    bgPadding: 16,
    bgRadius: 12,
    borderColor: "#0E7490",
    borderWidth: 2,
    shadow: true,
    shadowColor: "#D946EF",
    shadowBlur: 22,
    textTransform: "uppercase",
    letterSpacing: 4,
    positionY: 100,
    maxWidth: 0.84,
  },
  {
    id: "sticker",
    name: "Sticker",
    description: "White text on an amber rounded sticker with a dark rim.",
    fontFamily: 'Montserrat, "Segoe UI", Arial, sans-serif',
    ffmpegName: "Segoe UI",
    fontSize: 0.056,
    fontWeight: 900,
    fontStyle: "normal",
    textColor: "#1C1917",
    accentColor: "#F59E0B",
    bgColor: "#FBBF24",
    bgAlpha: 1,
    bgPadding: 26,
    bgRadius: 28,
    borderColor: "#78350F",
    borderWidth: 3,
    shadow: true,
    shadowColor: "#000000",
    shadowBlur: 10,
    textTransform: "uppercase",
    letterSpacing: 1,
    positionY: 96,
    maxWidth: 0.8,
  },
  {
    id: "serif",
    name: "Elegant Serif",
    description: "Refined italic Georgia with a soft shadow — storytelling intros.",
    fontFamily: "Georgia, serif",
    ffmpegName: "Georgia",
    fontSize: 0.055,
    fontWeight: 400,
    fontStyle: "italic",
    textColor: "#F5F5F4",
    accentColor: null,
    bgColor: null,
    bgAlpha: 1,
    bgPadding: 14,
    bgRadius: 8,
    borderColor: null,
    borderWidth: 0,
    shadow: true,
    shadowColor: "#000000",
    shadowBlur: 8,
    textTransform: "none",
    letterSpacing: 1,
    positionY: 110,
    maxWidth: 0.82,
  },
  {
    id: "banner",
    name: "Clean Banner",
    description: "Dark translucent bar + bold white — minimal, always readable.",
    fontFamily: 'Inter, "Segoe UI", Arial, sans-serif',
    ffmpegName: "Segoe UI",
    fontSize: 0.05,
    fontWeight: 700,
    fontStyle: "normal",
    textColor: "#FFFFFF",
    accentColor: "#34D399",
    bgColor: "#0F0F12",
    bgAlpha: 0.72,
    bgPadding: 22,
    bgRadius: 14,
    borderColor: null,
    borderWidth: 0,
    shadow: true,
    shadowColor: "#000000",
    shadowBlur: 8,
    textTransform: "none",
    letterSpacing: 2,
    positionY: 100,
    maxWidth: 0.86,
  },
];

export function getHeadlinePreset(id: string): HeadlinePreset {
  return HEADLINE_PRESETS.find((p) => p.id === id) ?? HEADLINE_PRESETS[0];
}
