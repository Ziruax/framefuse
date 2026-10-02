// electron/stack-text-ass.js — v1.17 STACK TEXT (kinetic typography) ASS emitter
//
// mirror of src/lib/merger/stackTextPresets.ts — keep in sync.
// main.js cannot import TypeScript, so the layout geometry, style timing and
// the per-style ASS construction recipes (STACK_STYLE_ASS_DOC /
// STACK_LAYOUT_ASS_DOC) are mirrored here as data + plain functions, exactly
// like the HEADLINE_PRESETS mirror in main.js. Every number traces back to
// the preset library — nothing is invented in this file.
//
// CONSUMED BY main.js buildHeadlineEvents(): items whose effective style is
// kinetic AND whose renderer-measured geometry (HeadlineExportGeometry from
// native.ts measureHeadlinesForExport — line/word layout at the export
// resolution) is present ride this emitter. Kinetic items WITHOUT geometry
// (old callers/tests) fall back to the legacy v4.2 emitter — never crash.
//
// Self-contained CommonJS (no Electron imports) so it is directly testable:
//   node -e "const A=require('./electron/stack-text-ass.js'); ..."
//
// Emission rules (per STACK_STYLE_ASS_DOC):
//   word-unit styles (word-pop, typewriter, karaoke-fill) → ONE Dialogue for
//     the whole block (measured lines joined with \N, per-word tags at
//     d = globalWordIndex × stagger) anchored by the Style's
//     Alignment+Margins; stagger-offset / middle-band need per-line \pos
//     geometry → one Dialogue PER LINE with a leading \k gap compensating
//     the elapsed global word timing (typewriter / karaoke-fill).
//   line-unit styles (blur-rise, line-slide, mask-wipe, scale-bounce,
//     spin-in) → ONE Dialogue PER LINE with \an5 + \move/\pos from the
//     measured geometry, d = lineIndex × stagger.
//   The 300 ms out tail is \fad(0,300) on every kinetic Dialogue (recipe).

"use strict";

// ── mirror of stackTextPresets.ts: LAYOUTS (geometry only) ─────────────────
const STACK_LAYOUT_SPECS = {
  "center-stack": {
    blockAlignmentX: "center", anchorY: "center", marginYFrac: 0.5,
    leftMarginFrac: 0, staggerOffsetXFrac: 0, rotate: "none", lineSpacingFrac: 1.22,
  },
  "top-banner": {
    blockAlignmentX: "center", anchorY: "top", marginYFrac: 0.083,
    leftMarginFrac: 0, staggerOffsetXFrac: 0, rotate: "none", lineSpacingFrac: 1.22,
  },
  "bottom-center": {
    blockAlignmentX: "center", anchorY: "bottom", marginYFrac: 0.22,
    leftMarginFrac: 0, staggerOffsetXFrac: 0, rotate: "none", lineSpacingFrac: 1.22,
  },
  "left-stack": {
    blockAlignmentX: "left", anchorY: "center", marginYFrac: 0.5,
    leftMarginFrac: 0.06, staggerOffsetXFrac: 0, rotate: "none", lineSpacingFrac: 1.22,
  },
  "stagger-offset": {
    blockAlignmentX: "center", anchorY: "center", marginYFrac: 0.5,
    leftMarginFrac: 0, staggerOffsetXFrac: 0.04, staggerAlternate: true,
    rotate: "none", lineSpacingFrac: 1.22,
  },
  "middle-band": {
    blockAlignmentX: "center", anchorY: "center", marginYFrac: 0.5,
    leftMarginFrac: 0, staggerOffsetXFrac: 0, rotate: "middle-band", lineSpacingFrac: 1.22,
  },
};

// ── mirror of stackTextPresets.ts: STYLES (timing + transform specs) ───────
const IDENTITY = { alpha: 1, scale: 1, offsetYFrac: 0, offsetXPerUnitFrac: 0, blurPx: 0, rotateDeg: 0 };

const STACK_STYLE_SPECS = {
  "word-pop": {
    unit: "word", staggerMs: 90, durationMs: 240, ease: "easeOutBack",
    alphaRampFrac: 0.5, overshootPct: 110,
    from: { alpha: 0, scale: 0.4, offsetYFrac: 0, offsetXPerUnitFrac: 0, blurPx: 0, rotateDeg: 0 },
    to: { ...IDENTITY },
  },
  typewriter: {
    unit: "word", staggerMs: 160, durationMs: 1, ease: "linear",
    leadInMs: 160, wipeReveal: true,
    from: { ...IDENTITY, alpha: 0 }, to: { ...IDENTITY },
  },
  "blur-rise": {
    unit: "line", staggerMs: 140, durationMs: 320, ease: "easeOutCubic",
    from: { alpha: 0, scale: 1, offsetYFrac: 0.045, offsetXPerUnitFrac: 0, blurPx: 10, rotateDeg: 0 },
    to: { ...IDENTITY },
  },
  "line-slide": {
    unit: "line", staggerMs: 150, durationMs: 300, ease: "easeOutCubic",
    alternatingX: true,
    from: { alpha: 0, scale: 1, offsetYFrac: 0, offsetXPerUnitFrac: 0.18, blurPx: 0, rotateDeg: 0 },
    to: { ...IDENTITY },
  },
  "mask-wipe": {
    unit: "line", staggerMs: 200, durationMs: 340, ease: "linear", wipeReveal: true,
    from: { ...IDENTITY }, to: { ...IDENTITY },
  },
  "scale-bounce": {
    unit: "line", staggerMs: 120, durationMs: 300, ease: "easeOutBack",
    alphaRampFrac: 0.5,
    from: { alpha: 0, scale: 1.7, offsetYFrac: 0, offsetXPerUnitFrac: 0, blurPx: 0, rotateDeg: 2 },
    to: { ...IDENTITY },
  },
  "karaoke-fill": {
    unit: "word", staggerMs: 0, durationMs: 120, ease: "linear",
    fillSweep: true, minFillMs: 300,
    from: { ...IDENTITY, alpha: 0 }, to: { ...IDENTITY },
  },
  "spin-in": {
    unit: "line", staggerMs: 130, durationMs: 320, ease: "easeOutCubic",
    from: { alpha: 0, scale: 0.7, offsetYFrac: 0, offsetXPerUnitFrac: 0, blurPx: 0, rotateDeg: -8 },
    to: { ...IDENTITY },
  },
};

// easeOutBack overshoot facts (mirror of stackTextPresets.ts internals).
const EASE_OUT_BACK_OVERSHOOT = 1.1;
const EASE_OUT_BACK_PEAK_FRAC = 0.58;

/** Universal block fade-out tail (ms) — baked into every \fad(0,300). */
const STACK_FADE_OUT_MS = 300;

/** mirror of native.ts KARAOKE_ACCENT_FALLBACK — keep in sync. */
const KARAOKE_ACCENT_FALLBACK = "#FACC15";

const STACK_TEXT_DEFAULTS = { layout: "center-stack", style: "word-pop" };

function getStackLayoutSpec(id) {
  return STACK_LAYOUT_SPECS[id] || STACK_LAYOUT_SPECS["center-stack"];
}

function getStackStyleSpec(id) {
  return STACK_STYLE_SPECS[id] || STACK_STYLE_SPECS["word-pop"];
}

function isKineticStyle(s) {
  return Object.prototype.hasOwnProperty.call(STACK_STYLE_SPECS, String(s));
}

/** Legacy item.position → StackLayout derivation (stackLayout absent). */
function legacyLayoutFor(position) {
  if (position === "top") return "top-banner";
  if (position === "bottom") return "bottom-center";
  return "center-stack";
}

/** Effective layout id for an item (stackLayout ?? legacyMap(position)). */
function effectiveStackLayoutId(item) {
  return (item && item.stackLayout) || legacyLayoutFor(item && item.position);
}

/** mirror of stackLayoutLineOffsetX() — the diagonal cascade. */
function stackLayoutLineOffsetX(layoutSpec, lineIndex, canvasW) {
  const frac = layoutSpec.staggerOffsetXFrac;
  if (!frac || lineIndex <= 0) return 0;
  const sign = layoutSpec.staggerAlternate ? (lineIndex % 2 === 0 ? -1 : 1) : 1;
  return sign * lineIndex * frac * canvasW;
}

/** mirror of middleBandActiveLine() — which line owns currentMs. */
function middleBandActiveLine(startMs, endMs, currentMs, lineCount) {
  if (lineCount <= 0) return -1;
  if (currentMs < startMs || currentMs >= endMs) return -1;
  const durMs = endMs - startMs;
  if (durMs <= 0) return 0;
  const slice = durMs / lineCount;
  if (slice <= 0) return 0;
  const idx = Math.floor((currentMs - startMs) / slice);
  return Math.min(lineCount - 1, Math.max(0, idx));
}

/**
 * mirror of stackAssWordTimingCs() — per-word \k / \kf centisecond values.
 * typewriter: uniform round(staggerMs/10); karaoke-fill: ∝ word length over
 * the passed sweep window (300 ms floor, dropped when it can't fit).
 */
function stackAssWordTimingCs(style, text, staggerMs) {
  const words = String(text || "").trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];
  if (style === "typewriter") {
    const cs = Math.max(0, Math.round(staggerMs / 10));
    return words.map(() => cs);
  }
  if (style === "karaoke-fill") {
    const minFillMs = STACK_STYLE_SPECS["karaoke-fill"].minFillMs || 0;
    const windowMs = Math.max(0, staggerMs);
    const weights = words.map((w) => Math.max(1, w.length));
    const total = weights.reduce((a, b) => a + b, 0);
    const shares = weights.map((w) => (windowMs * w) / total);
    let durs = shares.map((s) => Math.max(minFillMs, s));
    const sum = durs.reduce((a, b) => a + b, 0);
    if (sum > windowMs) durs = shares; // floor doesn't fit: stay proportional
    return durs.map((d) => Math.max(1, Math.round(d / 10)));
  }
  return [];
}

/** Escape user text for ASS (backslash → ∕, braces stripped). */
function escapeAssWord(s) {
  return String(s || "").replace(/\\/g, "\u2216").replace(/[{}]/g, "");
}

/** mirror of main.js hexToAssColor — &HAA BB GG RR (alpha 1 = opaque). */
function hexToAssColor(hex, alpha) {
  const a = alpha == null ? 1 : alpha;
  const h = (hex || "#FFFFFF").replace(/^#/, "");
  const assAlpha = Math.round((1 - a) * 255).toString(16).padStart(2, "0").toUpperCase();
  return `&H${assAlpha}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

// ── per-style tag builders (mirror of stackAssTagsForUnit, geometry-aware) ──

/** word-pop per-word block (mirror of the "word-pop" case). */
function wordPopTags(spec, delayMs) {
  const d = Math.max(0, Math.round(delayMs));
  const dur = Math.max(1, Math.round(spec.durationMs));
  const alphaDur = Math.max(1, Math.round(dur * (spec.alphaRampFrac != null ? spec.alphaRampFrac : 1)));
  const fromPct = Math.max(1, Math.round(spec.from.scale * 100));
  const toPct = Math.max(1, Math.round(spec.to.scale * 100));
  const overPct = Math.max(1, Math.round(spec.overshootPct != null ? spec.overshootPct : toPct));
  return (
    `{\\alpha&HFF&\\fscx${fromPct}\\fscy${fromPct}` +
    `\\t(${d},${d + alphaDur},\\alpha&H00&)` +
    `\\t(${d},${d + dur},\\fscx${overPct}\\fscy${overPct})` +
    `\\t(${d + alphaDur},${d + dur},\\fscx${toPct}\\fscy${toPct})}`
  );
}

/** typewriter line prefix (transparent Secondary + out tail). */
function typewriterPrefix() {
  return `{\\2a&HFF&\\fad(0,${STACK_FADE_OUT_MS})}`;
}

/** karaoke-fill line prefix (120 ms entrance fade + \k sweep gap). */
function karaokePrefix(spec, delayMs) {
  const d = Math.max(0, Math.round(delayMs));
  const dur = Math.max(1, Math.round(spec.durationMs));
  const leadKf = Math.max(1, Math.round(dur / 10));
  return (
    `{\\alpha&HFF&\\t(${d},${d + dur},\\alpha&H00&)\\fad(0,${STACK_FADE_OUT_MS})}` +
    `{\\k${leadKf}}`
  );
}

/** blur-rise per-line block with ABSOLUTE \move geometry (\an5 anchored). */
function blurRiseTags(spec, delayMs, ax, ay, height) {
  const d = Math.max(0, Math.round(delayMs));
  const dur = Math.max(1, Math.round(spec.durationMs));
  const hScale = height / 1080;
  const blurFrom = Math.max(0, Math.round(spec.from.blurPx * hScale));
  const blurTo = Math.max(0, Math.round(spec.to.blurPx * hScale));
  const dy = Math.round(spec.from.offsetYFrac * height);
  return (
    `{\\an5\\blur${blurFrom}\\alpha&HFF&` +
    `\\move(${Math.round(ax)},${Math.round(ay + dy)},${Math.round(ax)},${Math.round(ay)},${d},${d + dur})` +
    `\\t(${d},${d + dur},\\alpha&H00&\\blur${blurTo})\\fad(0,${STACK_FADE_OUT_MS})}`
  );
}

/** line-slide per-line block (alternating ±0.18W \move). */
function lineSlideTags(spec, delayMs, ax, ay, width, lineIndex) {
  const d = Math.max(0, Math.round(delayMs));
  const dur = Math.max(1, Math.round(spec.durationMs));
  const sign = spec.alternatingX ? (lineIndex % 2 === 0 ? -1 : 1) : 1;
  const sx = Math.round(spec.from.offsetXPerUnitFrac * sign * width);
  return (
    `{\\an5\\alpha&HFF&` +
    `\\move(${Math.round(ax + sx)},${Math.round(ay)},${Math.round(ax)},${Math.round(ay)},${d},${d + dur})` +
    `\\t(${d},${d + dur},\\alpha&H00&)\\fad(0,${STACK_FADE_OUT_MS})}`
  );
}

/** mask-wipe per-line block (animated \clip sweep over the measured rect). */
function maskWipeTags(spec, delayMs, x1, y1, y2, x2) {
  const d = Math.max(0, Math.round(delayMs));
  const dur = Math.max(1, Math.round(spec.durationMs));
  return (
    `{\\an5\\clip(${x1},${y1},${x1},${y2})` +
    `\\t(${d},${d + dur},\\clip(${x1},${y1},${x2},${y2}))` +
    `\\fad(0,${STACK_FADE_OUT_MS})}`
  );
}

/** scale-bounce per-line block (two-phase easeOutBack approximation). */
function scaleBounceTags(spec, delayMs, ax, ay) {
  const d = Math.max(0, Math.round(delayMs));
  const dur = Math.max(1, Math.round(spec.durationMs));
  const alphaDur = Math.max(1, Math.round(dur * (spec.alphaRampFrac != null ? spec.alphaRampFrac : 1)));
  const fromPct = Math.max(1, Math.round(spec.from.scale * 100));
  const toPct = Math.max(1, Math.round(spec.to.scale * 100));
  const midPct = Math.max(
    1,
    Math.round((spec.from.scale + (spec.to.scale - spec.from.scale) * EASE_OUT_BACK_OVERSHOOT) * 100),
  );
  const peakAt = Math.max(1, Math.round(dur * EASE_OUT_BACK_PEAK_FRAC));
  const fromRot = Math.round(spec.from.rotateDeg);
  const toRot = Math.round(spec.to.rotateDeg);
  return (
    `{\\an5\\pos(${Math.round(ax)},${Math.round(ay)})` +
    `\\alpha&HFF&\\fscx${fromPct}\\fscy${fromPct}\\frz${fromRot}` +
    `\\t(${d},${d + alphaDur},\\alpha&H00&)` +
    `\\t(${d},${d + dur},\\frz${toRot})` +
    `\\t(${d},${d + peakAt},\\fscx${midPct}\\fscy${midPct})` +
    `\\t(${d + peakAt},${d + dur},\\fscx${toPct}\\fscy${toPct})` +
    `\\fad(0,${STACK_FADE_OUT_MS})}`
  );
}

/** spin-in per-line block (single linear \t carrying alpha + scale + rot). */
function spinInTags(spec, delayMs, ax, ay) {
  const d = Math.max(0, Math.round(delayMs));
  const dur = Math.max(1, Math.round(spec.durationMs));
  const fromPct = Math.max(1, Math.round(spec.from.scale * 100));
  const toPct = Math.max(1, Math.round(spec.to.scale * 100));
  const fromRot = Math.round(spec.from.rotateDeg);
  const toRot = Math.round(spec.to.rotateDeg);
  return (
    `{\\an5\\pos(${Math.round(ax)},${Math.round(ay)})` +
    `\\alpha&HFF&\\fscx${fromPct}\\fscy${fromPct}\\frz${fromRot}` +
    `\\t(${d},${d + dur},\\alpha&H00&\\fscx${toPct}\\fscy${toPct}\\frz${toRot})` +
    `\\fad(0,${STACK_FADE_OUT_MS})}`
  );
}

// ── the emitter ─────────────────────────────────────────────────────────────

/**
 * Build the Style + Dialogue lines for ONE kinetic headline item.
 *
 * @param item      the export-native headline payload item (stackStyle set)
 * @param geo       matching HeadlineExportGeometry (renderer-measured)
 * @param preset    the resolved headline visual preset (main.js mirror)
 * @param width     PlayResX (export width)
 * @param height    PlayResY (export height)
 * @param winStart  clip window start (master-timeline ms; 0 when unwindowed)
 * @param winEnd    clip window end (ms; Infinity when unwindowed)
 * @param clampDur  clip window duration (ms; Infinity when unwindowed)
 * @param styleName unique per-item ASS Style name (e.g. "HeadlineK2")
 * @returns { styleLines: string[], eventLines: string[], count: number } or
 *          null when the item is outside the window / unmeasurable.
 */
function emitStackHeadlineItem(item, geo, preset, width, height, winStart, winEnd, clampDur, styleName) {
  if (!item || !item.text || !geo || !Array.isArray(geo.lines) || geo.lines.length === 0) return null;
  if (item.endMs <= winStart || item.startMs >= winEnd) return null;
  const relStart = Math.max(0, item.startMs - winStart);
  const relEnd = Math.min(clampDur, item.endMs - winStart);
  if (relEnd <= relStart) return null;

  const styleId = isKineticStyle(geo.style) ? geo.style : "word-pop";
  const spec = getStackStyleSpec(styleId);
  const layoutSpec = getStackLayoutSpec(geo.layout || effectiveStackLayoutId(item));
  const wordUnit = spec.unit === "word";
  const middleBand = layoutSpec.rotate === "middle-band";

  const lines = geo.lines;
  const n = lines.length;
  const fontPx = Math.round(Number(geo.fontPx) || 40);
  const lineHeight = Math.round(Number(geo.lineHeight) || fontPx * 1.22);
  const hScale = height / 1080;

  // ── Style line (mirrors the legacy Headline style construction) ──
  const bold = preset.fontWeight >= 600 ? -1 : 0;
  const italic = preset.italic ? -1 : 0;
  const borderStyle = preset.bgColor ? 3 : 1;
  const outline = preset.bgColor
    ? Math.max(0, Math.round((preset.bgPadding != null ? preset.bgPadding : 10) * hScale))
    : Math.max(0, Math.round((preset.borderWidth || 0) * hScale));
  const shadowVal = preset.shadow ? Math.max(1, Math.round((preset.shadowBlur || 3) / 2 * hScale)) : 0;
  const outlineColour = preset.bgColor
    ? hexToAssColor(preset.bgColor, preset.bgAlpha != null ? preset.bgAlpha : 1)
    : hexToAssColor(preset.borderColor || preset.textColor);
  const backColour = preset.bgColor
    ? (preset.shadow
        ? hexToAssColor(preset.accentColor || preset.shadowColor || "#000000", 0.55)
        : hexToAssColor(preset.bgColor, preset.bgAlpha != null ? preset.bgAlpha : 1))
    : hexToAssColor(preset.accentColor || preset.shadowColor || "#000000", 0.55);
  const spacing = Math.round((preset.letterSpacing || 0) * hScale * 10) / 10;

  // Alignment + margins from the LAYOUT. These anchor the word-unit
  // single-Dialogue blocks (STACK_LAYOUT_ASS_DOC "Style path"):
  //   center-stack → 5, top-banner → 8 (+MarginV), bottom-center → 2
  //   (+MarginV), left-stack → 4 (+MarginL). Per-line Dialogue emissions
  //   override with inline \an5\pos geometry.
  let alignment = 5;
  let marginV = 0;
  if (layoutSpec.anchorY === "top") {
    alignment = 8;
    marginV = Math.round(layoutSpec.marginYFrac * height);
  } else if (layoutSpec.anchorY === "bottom") {
    alignment = 2;
    marginV = Math.round(layoutSpec.marginYFrac * height);
  }
  let marginLR = Math.round((width * (1 - preset.maxWidth)) / 2);
  if (layoutSpec.blockAlignmentX === "left") {
    alignment = layoutSpec.anchorY === "top" ? 1 : layoutSpec.anchorY === "bottom" ? 7 : 4;
    marginLR = Math.max(marginLR, Math.round(layoutSpec.leftMarginFrac * width));
  }

  // karaoke-fill: Primary = accent (the \kf sweep), Secondary = base text.
  const karaoke = styleId === "karaoke-fill";
  const accent = preset.accentColor || KARAOKE_ACCENT_FALLBACK;
  const primary = karaoke ? hexToAssColor(accent) : hexToAssColor(preset.textColor);
  const secondary = hexToAssColor(preset.textColor);

  const styleLine =
    `Style: ${styleName},${preset.ffmpegName},${fontPx},` +
    `${primary},${secondary},${outlineColour},${backColour},${bold},${italic},0,0,100,100,` +
    `${spacing},0,${borderStyle},${outline},${shadowVal},${alignment},${marginLR},${marginLR},${marginV},1`;

  const styleLines = [styleLine];
  const eventLines = [];
  const dlg = (start, end, text) =>
    `Dialogue: 1,${assFmtTime(start)},${assFmtTime(end)},${styleName},,0,0,0,,${text}`;

  // Per-line measured anchor: middle-center of the line box (\an5).
  const anchorOf = (line) => ({
    x: Math.round(line.x + line.width / 2),
    y: Math.round(line.y + lineHeight / 2),
  });

  // One styled word chunk (word-unit styles).
  const wordChunk = (sid, sp, w, delayMs, csVal) => {
    if (sid === "word-pop") return wordPopTags(sp, delayMs) + escapeAssWord(w);
    if (sid === "typewriter") return `{\\k${csVal}}` + escapeAssWord(w);
    return `{\\kf${csVal}}` + escapeAssWord(w); // karaoke-fill
  };

  const globalWordText = lines
    .map((l) => (l.words || []).map((w) => w.text).join(" "))
    .join(" ");

  if (middleBand) {
    // ONE line on screen at a time: line i's Dialogue spans its slice
    // (canvas middleBandActiveLine twin); the entrance re-triggers per
    // slice, so units are LOCAL to the line (d = local index × stagger).
    const sliceAbs = (item.endMs - item.startMs) / n;
    for (let i = 0; i < n; i++) {
      const absStart = item.startMs + i * sliceAbs;
      const absEnd = item.startMs + (i + 1) * sliceAbs;
      const s = Math.max(relStart, Math.max(0, absStart - winStart));
      const e = Math.min(relEnd, Math.min(clampDur, absEnd - winStart));
      if (e <= s) continue;
      const line = lines[i];
      const a = anchorOf(line);
      if (wordUnit) {
        const words = (line.words || []).map((w) => w.text);
        const sliceWinMs = e - s;
        const cs =
          styleId === "typewriter"
            ? stackAssWordTimingCs("typewriter", words.join(" "), spec.staggerMs)
            : stackAssWordTimingCs("karaoke-fill", words.join(" "), Math.max(0, sliceWinMs - spec.durationMs));
        let body;
        if (styleId === "word-pop") {
          // Out-tail prefix once + per-word tags at local delays.
          body =
            `{\\an5\\pos(${a.x},${a.y})\\fad(0,${STACK_FADE_OUT_MS})}` +
            words.map((w, j) => wordChunk("word-pop", spec, w, j * spec.staggerMs)).join(" ");
        } else if (styleId === "typewriter") {
          body =
            `{\\an5\\pos(${a.x},${a.y})` + typewriterPrefix().slice(1) +
            words.map((w, j) => wordChunk("typewriter", spec, w, 0, cs[j] || 16)).join(" ");
        } else {
          body =
            `{\\an5\\pos(${a.x},${a.y})` + karaokePrefix(spec, 0).slice(1) +
            words.map((w, j) => wordChunk("karaoke-fill", spec, w, 0, cs[j] || 1)).join(" ");
        }
        eventLines.push(dlg(s, e, body));
      } else {
        // Line-unit: the slice's line is unit 0 (d = 0).
        eventLines.push(dlg(s, e, lineTags(styleId, spec, 0, line, i, a)));
      }
    }
  } else if (wordUnit && !layoutSpec.staggerOffsetXFrac) {
    // ONE Dialogue for the whole block, anchored by the Style's
    // Alignment+Margins; measured lines joined with \N (line-break parity —
    // libass never re-wraps inside the preset margins).
    const sweep = Math.max(0, relEnd - relStart - spec.durationMs);
    const cs =
      styleId === "typewriter"
        ? stackAssWordTimingCs("typewriter", globalWordText, spec.staggerMs)
        : stackAssWordTimingCs("karaoke-fill", globalWordText, sweep);
    const prefix =
      styleId === "word-pop"
        ? `{\\fad(0,${STACK_FADE_OUT_MS})}`
        : styleId === "typewriter"
          ? typewriterPrefix()
          : karaokePrefix(spec, 0);
    let g = 0;
    const lineTexts = lines.map((line) => {
      const chunks = (line.words || []).map((w) => {
        const d = styleId === "word-pop" ? g * spec.staggerMs : 0;
        const chunk = wordChunk(styleId, spec, w.text, d, cs[g] || 1);
        g++;
        return chunk;
      });
      return chunks.join(" ");
    });
    eventLines.push(dlg(relStart, relEnd, prefix + lineTexts.join("\\N")));
  } else if (wordUnit) {
    // stagger-offset: the cascade needs per-line \pos → one Dialogue PER
    // LINE. word-pop keeps its global \t delays; typewriter / karaoke-fill
    // get a leading \k gap equal to the PREVIOUS words' elapsed time so the
    // global word timing is preserved inside each line's own \k clock.
    const sweep = Math.max(0, relEnd - relStart - spec.durationMs);
    const needCs = styleId === "typewriter" || styleId === "karaoke-fill";
    const cs = needCs
      ? styleId === "typewriter"
        ? stackAssWordTimingCs("typewriter", globalWordText, spec.staggerMs)
        : stackAssWordTimingCs("karaoke-fill", globalWordText, sweep)
      : [];
    let g = 0;
    for (const line of lines) {
      const a = anchorOf(line);
      const posTag = `{\\an5\\pos(${a.x},${a.y})}`;
      const first = g;
      let gapCs = 0;
      for (let k = 0; k < first; k++) gapCs += cs[k] || 0;
      let lead;
      if (styleId === "word-pop") {
        lead = posTag.slice(0, -1) + `\\fad(0,${STACK_FADE_OUT_MS})}`;
      } else if (styleId === "typewriter") {
        lead = posTag.slice(0, -1) + typewriterPrefix().slice(1);
      } else {
        lead = posTag.slice(0, -1) + karaokePrefix(spec, 0).slice(1);
      }
      if (needCs && gapCs > 0) lead += `{\\k${gapCs}}`;
      const chunks = (line.words || []).map((w) => {
        const d = styleId === "word-pop" ? g * spec.staggerMs : 0;
        const chunk = wordChunk(styleId, spec, w.text, d, cs[g] || 1);
        g++;
        return chunk;
      });
      eventLines.push(dlg(relStart, relEnd, lead + chunks.join(" ")));
    }
  } else {
    // Line-unit styles: ONE Dialogue PER LINE (each spans the item window,
    // d = i × stagger, geometry from the measured line box).
    for (let i = 0; i < n; i++) {
      eventLines.push(dlg(relStart, relEnd, lineTags(styleId, spec, i * spec.staggerMs, lines[i], i, anchorOf(lines[i]))));
    }
  }

  if (process.env.FF_DEBUG_STACK === "1") {
    console.log(`[stack-text-ass] ${styleId}/${geo.layout} → ${eventLines.length} Dialogue(s)`);
    for (const ev of eventLines) console.log("  " + ev);
  }

  return { styleLines, eventLines, count: eventLines.length };

  /** Per-line tag block for line-unit styles (recipe mirrors). */
  function lineTags(sid, sp, delayMs, line, lineIndex, a) {
    switch (sid) {
      case "blur-rise":
        return blurRiseTags(sp, delayMs, a.x, a.y, height);
      case "line-slide":
        return lineSlideTags(sp, delayMs, a.x, a.y, width, lineIndex);
      case "mask-wipe": {
        const x1 = Math.round(line.x);
        const y1 = Math.round(line.y);
        return maskWipeTags(sp, delayMs, x1, y1, Math.round(line.y + lineHeight), Math.round(line.x + line.width));
      }
      case "scale-bounce":
        return scaleBounceTags(sp, delayMs, a.x, a.y);
      case "spin-in":
      default:
        return spinInTags(sp, delayMs, a.x, a.y);
    }
  }
}

/** assFmtTime mirror (main.js owns the canonical one; H:MM:SS.cc). */
function assFmtTime(ms) {
  const sec = Math.max(0, ms) / 1000;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.round((sec - Math.floor(sec)) * 100);
  const cc = cs === 100 ? 99 : cs;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cc).padStart(2, "0")}`;
}

module.exports = {
  // mirror data (mirror of src/lib/merger/stackTextPresets.ts — keep in sync)
  STACK_LAYOUT_SPECS,
  STACK_STYLE_SPECS,
  STACK_FADE_OUT_MS,
  STACK_TEXT_DEFAULTS,
  KARAOKE_ACCENT_FALLBACK,
  // mirror helpers
  getStackLayoutSpec,
  getStackStyleSpec,
  isKineticStyle,
  legacyLayoutFor,
  effectiveStackLayoutId,
  stackLayoutLineOffsetX,
  middleBandActiveLine,
  stackAssWordTimingCs,
  // tag builders (recipe mirrors — exposed for the node test harness)
  wordPopTags,
  typewriterPrefix,
  karaokePrefix,
  blurRiseTags,
  lineSlideTags,
  maskWipeTags,
  scaleBounceTags,
  spinInTags,
  hexToAssColor,
  escapeAssWord,
  assFmtTime,
  // the emitter
  emitStackHeadlineItem,
};
