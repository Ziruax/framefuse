// src/lib/merger/kinetic/render.ts — canvas painter + export geometry for
// the kinetic typography engine. One layout solver feeds BOTH the preview
// painter and the measured geometry that the ASS mirror consumes (canvas ↔
// export parity by construction — the stack-text pattern).
//
// Renderer-side module (uses ctx.measureText / document canvas). The ASS
// mirror (electron/kinetic-ass.js) receives the measured geometry verbatim.

import type {
  KineticCaptionSettings,
  KineticComposition,
  KineticGeoComposition,
  KineticGeoWord,
  KineticPresetSpec,
  KineticPlan,
  KineticWordTransform,
} from "./types";
import type { KineticCueInput } from "./engine";
import { getKineticPreset } from "./presets";
import { buildKineticPlan } from "./engine";
import { kineticWordTransforms } from "./motion";
import { getFontOption } from "../captionPresets";
// The same 2D-context type the canvas painter + preview already share.
import type { Ctx2D } from "../renderer";

// ── Layout solver ───────────────────────────────────────────────────────────

export interface KineticLayoutOpts {
  fontSizeScale: number;
  /** Primary text color override (captionSettings.customColor). */
  customColor: string | null;
  fontOverride?: string | null;
  accentOverride?: string | null;
}

export interface LaidWord {
  text: string;
  wordIdx: number;
  x: number;
  y: number;
  w: number;
  h: number;
  fontPx: number;
  weight: number;
  emphasis: boolean;
  role: "primary" | "secondary" | "supporting";
}

export interface LaidLine {
  role: "primary" | "secondary" | "supporting";
  align: "left" | "center" | "right";
  fontPx: number;
  y: number;
  h: number;
  words: LaidWord[];
}

export interface KineticLayout {
  lines: LaidLine[];
  blockLeft: number;
  blockTop: number;
  blockW: number;
  blockH: number;
  fontPx: number;
  lineHeight: number;
  blockRotateDeg: number;
}

type Measure = (text: string, weight: number, fontPx: number) => number;

function fontStackFor(preset: KineticPresetSpec, override?: string | null): string {
  const f = getFontOption(override || preset.fontId);
  return f.stack;
}

/**
 * Solve the composition geometry. `measure` abstracts ctx.measureText so the
 * same solver runs on the preview canvas and the measurement canvas.
 */
export function layoutKineticComposition(
  comp: KineticComposition,
  preset: KineticPresetSpec,
  opts: KineticLayoutOpts,
  cw: number,
  ch: number,
  measure: Measure,
): KineticLayout {
  const baseFontPx = Math.max(10, preset.baseSizeFrac * ch * (opts.fontSizeScale || 1));
  const marginX = preset.marginXFrac * cw;
  const usableW = Math.min(cw * preset.maxWidthFrac, cw - marginX * 2);

  const casing = preset.casing === "upper" ? (s: string) => s.toUpperCase() : (s: string) => s;
  const inlineEmphWeight =
    preset.hierarchy === "uniform" || preset.hierarchy === "center-band";

  const lines: LaidLine[] = [];
  let yCursor = 0;
  let blockW = 0;

  comp.phrases.forEach((phrase) => {
    const phraseFontPx = Math.max(9, baseFontPx * phrase.scale);
    const phraseWeight = phrase.weight;
    const lineH = Math.round(phraseFontPx * preset.lineHeightFrac);

    // Words of this phrase, each measured with its effective font
    // (inline emphasis words use emphasisWeight in uniform/band styles).
    const ws = phrase.words.map((w) => {
      const weight = inlineEmphWeight && w.emphasis ? preset.emphasisWeight : phraseWeight;
      const text = casing(w.text);
      const width = measure(text, weight, phraseFontPx);
      return { word: w, text, width, weight, wordIdx: comp.words.indexOf(w) };
    });
    const spaceW = measure(" ", phraseWeight, phraseFontPx);

    // Greedy wrap into visual lines.
    interface WrapEntry {
      item: (typeof ws)[number];
      x: number;
    }
    const wrapped: WrapEntry[][] = [];
    let cur: WrapEntry[] = [];
    let curW = 0;
    for (const item of ws) {
      const next = cur.length === 0 ? item.width : curW + spaceW + item.width;
      if (next > usableW && cur.length > 0) {
        wrapped.push(cur);
        cur = [{ item, x: 0 }];
        curW = item.width;
      } else {
        cur.push({ item, x: curW });
        curW = next;
      }
    }
    if (cur.length) wrapped.push(cur);
    if (wrapped.length === 0) return;

    wrapped.forEach((wrapLine) => {
      const lineWidth =
        wrapLine[wrapLine.length - 1].x + wrapLine[wrapLine.length - 1].item.width;
      blockW = Math.max(blockW, lineWidth);
      const laidLine: LaidLine = {
        role: phrase.role,
        align: phrase.align,
        fontPx: phraseFontPx,
        y: yCursor,
        h: lineH,
        words: wrapLine.map(({ item, x }) => ({
          text: item.text,
          wordIdx: item.wordIdx,
          x, // relative within the line — anchored below
          y: yCursor,
          w: item.width,
          h: lineH,
          fontPx: phraseFontPx,
          weight: item.weight,
          emphasis: item.word.emphasis,
          role: phrase.role,
        })),
      };
      lines.push(laidLine);
      yCursor += lineH;
    });
  });

  // ── Horizontal placement per hierarchy pattern ──
  const anchorXCenter = cw / 2;
  lines.forEach((line) => {
    const lineW = line.words.length
      ? line.words[line.words.length - 1].x + line.words[line.words.length - 1].w
      : 0;
    const phrase = comp.phrases.find((p) =>
      p.words.some((w) => comp.words.indexOf(w) === line.words[0]?.wordIdx),
    );
    const align = line.align || phrase?.align || "center";
    const indent = (phrase?.indentFrac ?? 0) * cw;

    let lineLeft: number;
    switch (align) {
      case "left":
        lineLeft = marginX + indent;
        break;
      case "right":
        lineLeft = cw - marginX - lineW - indent;
        break;
      default:
        lineLeft = anchorXCenter - lineW / 2 + indent;
    }
    line.words.forEach((lw) => {
      lw.x += lineLeft;
    });
  });

  // ── Vertical anchor (§24 safe areas) ──
  const blockH = yCursor;
  const marginY = preset.marginYFrac * ch;
  let blockTop: number;
  if (preset.anchorY === "top") blockTop = Math.max(ch * 0.06, marginY);
  else if (preset.anchorY === "bottom") blockTop = ch - blockH - Math.max(ch * 0.07, marginY);
  else blockTop = (ch - blockH) / 2;
  blockTop = Math.max(ch * 0.05, Math.min(ch * 0.95 - blockH, blockTop));

  const minX = Math.min(...lines.flatMap((l) => l.words.map((w) => w.x)), cw);
  const maxX = Math.max(
    ...lines.flatMap((l) => l.words.map((w) => w.x + w.w)),
    0,
  );

  return {
    lines,
    blockLeft: minX,
    blockTop,
    blockW: Math.max(1, maxX - minX),
    blockH,
    fontPx: baseFontPx,
    lineHeight: Math.round(baseFontPx * preset.lineHeightFrac),
    blockRotateDeg: preset.blockRotateDeg,
  };
}

// ── Paint ───────────────────────────────────────────────────────────────────

/**
 * Paint one kinetic composition at currentMs. The SAME measure source must
 * be used for layout (pass ctx.measureText-backed `measure`).
 */
export function drawKineticComposition(
  ctx: Ctx2D,
  comp: KineticComposition,
  preset: KineticPresetSpec,
  opts: KineticLayoutOpts & { motionLevel: string; currentMs: number },
  cw: number,
  ch: number,
  measure: Measure,
): void {
  const layout = layoutKineticComposition(comp, preset, opts, cw, ch, measure);
  if (layout.lines.length === 0) return;

  const transforms = kineticWordTransforms({
    composition: comp,
    preset,
    currentMs: opts.currentMs,
    motionLevel: opts.motionLevel,
    ch,
  });

  const baseColor = opts.customColor || "#FFFFFF";
  const accent = opts.accentOverride || preset.accentColor;
  const stack = fontStackFor(preset, opts.fontOverride);
  const scaleRef = ch / 1080;

  // Block rotation (diagonal stack) around the block center.
  if (layout.blockRotateDeg !== 0) {
    ctx.save();
    const cx = layout.blockLeft + layout.blockW / 2;
    const cy = layout.blockTop + layout.blockH / 2;
    ctx.translate(cx, cy);
    ctx.rotate((layout.blockRotateDeg * Math.PI) / 180);
    ctx.translate(-cx, -cy);
  }

  const shadow = preset.shadow;
  for (const line of layout.lines) {
    for (const lw of line.words) {
      const t: KineticWordTransform =
        transforms[lw.wordIdx] ?? { alpha: 1, scale: 1, offsetX: 0, offsetY: 0, rotate: 0, blur: 0, clipLeft: 1, colorOverride: null };
      if (t.alpha <= 0.01) continue;

      const color = lw.emphasis ? accent : baseColor;
      ctx.save();
      ctx.globalAlpha *= Math.max(0, Math.min(1, t.alpha));

      // transform around the word box center
      const wx = lw.x;
      const wy = layout.blockTop + lw.y;
      const cx = wx + lw.w / 2;
      const cy = wy + lw.h / 2;
      if (t.scale !== 1 || t.offsetX !== 0 || t.offsetY !== 0 || t.rotate !== 0) {
        ctx.translate(cx + t.offsetX * scaleRef, cy + t.offsetY * scaleRef);
        ctx.rotate((t.rotate * Math.PI) / 180);
        ctx.scale(t.scale, t.scale);
        ctx.translate(-cx, -cy);
      }
      if (t.blur > 0.4) {
        ctx.filter = `blur(${t.blur * scaleRef}px)`;
      }
      if (t.clipLeft < 0.999) {
        ctx.beginPath();
        ctx.rect(wx, wy - lw.h, lw.w * t.clipLeft, lw.h * 2.2);
        ctx.clip();
      }
      if (shadow) {
        ctx.shadowColor = "rgba(0,0,0,0.55)";
        ctx.shadowBlur = 7 * scaleRef;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
      }
      ctx.font = `${lw.weight} ${lw.fontPx}px ${stack}`;
      ctx.textBaseline = "top";
      ctx.fillStyle = t.colorOverride || color;
      ctx.fillText(lw.text, wx, wy);
      ctx.restore();
    }
  }

  if (layout.blockRotateDeg !== 0) {
    ctx.restore();
  }
  try {
    (ctx as unknown as { filter: string }).filter = "none";
  } catch {
    /* noop */
  }
}

// ── Plan cache (preview + GPU export call every frame — reference-keyed) ───

/**
 * v1.21 FONT PRELOAD: canvas `ctx.font` usage does NOT trigger @font-face
 * downloads — only DOM text does. The kinetic faces (Inter/Montserrat/
 * Bebas/…) are canvas-only, so without an explicit document.fonts.load()
 * the painter and the EXPORT measurement silently measure with fallback
 * system fonts (the "designs don't look like the pasted reference" bug).
 * Called on app mount and before export measurement.
 */
const KINETIC_FONT_FAMILIES = [
  "Inter",
  "Roboto",
  "Montserrat",
  "Bebas Neue",
  "Playfair Display",
];
let kineticFontsLoadStarted = false;
export async function ensureKineticFontsLoaded(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts?.load) return;
  kineticFontsLoadStarted = true;
  try {
    await Promise.all(
      KINETIC_FONT_FAMILIES.flatMap((f) =>
        [400, 500, 600, 700, 800, 900].map((w) =>
          document.fonts.load(`${w} 32px "${f}"`).catch(() => undefined),
        ),
      ),
    );
  } catch {
    /* offline / blocked — the stacks fall back as before */
  }
}

/** True once ensureKineticFontsLoaded() has been kicked off (debug aid). */
export function kineticFontsLoadPending(): boolean {
  return !kineticFontsLoadStarted;
}

let planCache: {
  cues: KineticCueInput[] | undefined;
  settings: KineticCaptionSettings | undefined;
  plan: KineticPlan;
} | null = null;

export function getKineticPlanCached(
  cues: KineticCueInput[] | undefined,
  settings: KineticCaptionSettings | undefined,
): KineticPlan | null {
  if (!settings?.enabled || !cues || cues.length === 0) return null;
  if (planCache && planCache.cues === cues && planCache.settings === settings) {
    return planCache.plan;
  }
  const plan = buildKineticPlan(cues, settings);
  planCache = { cues, settings, plan };
  return plan;
}

// ── Export geometry measurement ─────────────────────────────────────────────

let measureCanvas: HTMLCanvasElement | null = null;

function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  if (!measureCanvas) {
    measureCanvas = document.createElement("canvas");
    measureCanvas.width = 64;
    measureCanvas.height = 64;
  }
  return measureCanvas.getContext("2d");
}

/**
 * Full-precision measurement: the measure callback receives the preset's own
 * font stack so every word is measured with the exact render font. Returns
 * null when document is unavailable (main-process legacy fallback).
 */
export function measureKineticPlanFor(
  plan: KineticPlan,
  settings: KineticCaptionSettings,
  opts: KineticLayoutOpts,
  cw: number,
  ch: number,
  measure: (text: string, weight: number, fontPx: number, stack: string) => number,
): KineticGeoComposition[] | null {
  const out: KineticGeoComposition[] = [];
  for (const comp of plan.compositions) {
    const preset = getKineticPreset(comp.presetId);
    const stack = fontStackFor(preset, settings.fontOverride);
    const layout = layoutKineticComposition(
      comp,
      preset,
      opts,
      cw,
      ch,
      (text, weight, fontPx) => measure(text, weight, fontPx, stack),
    );
    const geoWords: KineticGeoWord[] = [];
    layout.lines.forEach((line) => {
      line.words.forEach((lw) => {
        // v1.21: carry the word's plan row (timing/semantics/weight) so the
        // native Rust renderer is self-contained — it joins geometry +
        // motion WITHOUT re-deriving the semantic plan (§36 parity).
        const planWord = comp.words[lw.wordIdx];
        geoWords.push({
          text: lw.text,
          x: Math.round(lw.x * 10) / 10,
          y: Math.round((layout.blockTop + lw.y) * 10) / 10,
          w: Math.round(lw.w * 10) / 10,
          h: Math.round(lw.h * 10) / 10,
          fontPx: Math.round(lw.fontPx),
          wordIdx: lw.wordIdx,
          weight: lw.weight,
          emphasis: lw.emphasis,
          role: lw.role,
          phraseIndex: planWord ? planWord.phraseIndex : 0,
          startMs: planWord ? planWord.startMs : comp.startMs,
          endMs: planWord ? planWord.endMs : comp.endMs,
        });
      });
    });
    if (geoWords.length === 0) continue;
    out.push({
      cueStartMs: comp.startMs,
      presetId: comp.presetId,
      fontPx: Math.round(layout.fontPx),
      lineHeight: layout.lineHeight,
      blockLeft: Math.round(layout.blockLeft),
      blockTop: Math.round(layout.blockTop),
      blockW: Math.round(layout.blockW),
      blockH: Math.round(layout.blockH),
      blockRotateDeg: layout.blockRotateDeg,
      lines: layout.lines.map((l) => ({
        role: l.role,
        fontPx: Math.round(l.fontPx),
        y: Math.round(l.y),
        h: l.h,
        align: l.align,
      })),
      // v1.21: per-phrase role/align for the native motion solver.
      phrases: comp.phrases.map((p) => ({
        role: p.role,
        align: p.align,
      })),
      words: geoWords,
    });
  }
  return out;
}

/** Convenience: measure with the DOM canvas (preview fonts). */
export function measureKineticPlanDom(
  plan: KineticPlan,
  settings: KineticCaptionSettings,
  opts: KineticLayoutOpts,
  cw: number,
  ch: number,
): KineticGeoComposition[] | null {
  const ctx = getMeasureCtx();
  if (!ctx) return null;
  return measureKineticPlanFor(plan, settings, opts, cw, ch, (text, weight, fontPx, stack) => {
    ctx.font = `${weight} ${fontPx}px ${stack}`;
    return ctx.measureText(text).width;
  });
}

// ── drawCaption dispatch target ─────────────────────────────────────────────

export interface KineticCapCtx {
  kinetic?: KineticCaptionSettings;
  kineticCues?: KineticCueInput[];
  fontSizeScale?: number;
  customColor?: string | null;
  words?: { text: string; startMs: number; endMs: number }[];
  currentMs?: number;
  cueStartMs?: number;
  cueEndMs?: number;
}

/**
 * Entry point wired from native.ts drawCaption: resolves the (cached) plan,
 * finds the composition at currentMs and paints it. Falls back silently
 * (returns false) when there is no composition at this time.
 */
export function drawKineticCaption(
  ctx: Ctx2D,
  capCtx: KineticCapCtx,
  cw: number,
  ch: number,
): boolean {
  const kinetic = capCtx.kinetic;
  if (!kinetic?.enabled) return false;
  const plan = getKineticPlanCached(capCtx.kineticCues, kinetic);
  if (!plan || plan.compositions.length === 0) return false;
  const currentMs = capCtx.currentMs ?? capCtx.cueStartMs ?? 0;
  const comp = plan.compositionAt(currentMs);
  if (!comp) return false;
  const preset = getKineticPreset(comp.presetId);

  const stack = fontStackFor(preset, kinetic.fontOverride);
  const measure: Measure = (text, weight, fontPx) => {
    ctx.font = `${weight} ${fontPx}px ${stack}`;
    return ctx.measureText(text).width;
  };

  drawKineticComposition(
    ctx,
    comp,
    preset,
    {
      fontSizeScale: capCtx.fontSizeScale || 1,
      customColor: capCtx.customColor || null,
      fontOverride: kinetic.fontOverride,
      accentOverride: kinetic.accentOverride,
      motionLevel: kinetic.motion,
      currentMs,
    },
    cw,
    ch,
    measure,
  );
  return true;
}
