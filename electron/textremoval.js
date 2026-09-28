// electron/textremoval.js — burn-in text detection-REGION removal filters.
//
// v1.15 — the user directive: "detect the text on the video and add a blur
// effect, or use better technology like inpainting, to remove that text."
// DEFAULT OFF; purely opt-in.
//
// Regions are NORMALIZED (0..1) to the SOURCE video frame (the renderer's
// OCR detector runs on the first video source and stores normalized boxes,
// so the same region applies to every video segment regardless of output
// resolution). The filters are applied at the HEAD of each video segment's
// filter chain — BEFORE scale/crop — so the cover-fit crop carries the
// removed region along and the preview/export framing can never disagree.
//
// Modes:
//   inpaint — FFmpeg `delogo` per region (interpolation from the region
//             border — the "better technology" fill). Linear chain, works
//             in EVERY path (single-pass, smart/parallel, two-step -vf).
//   blur    — REAL region-limited blur: split → crop → boxblur → overlay
//             per region (labeled pads; the single-pass/complex paths).
//             Radius = min(w,h)/8 clamped to [2, 40].
//   cover   — `drawbox` solid black box (the classic hard cover).
//
// This module is PURE (zero requires beyond fs-free math) and unit-testable
// from node/bun directly, like export-graph/export-singlepass.

"use strict";

const MAX_REGIONS = 8;
const VALID_MODES = new Set(["inpaint", "blur", "cover"]);

/**
 * Validate + clamp a renderer payload into the canonical descriptor.
 * Returns null when disabled/empty/invalid (callers treat null as "off",
 * keeping every filter graph byte-identical for text-removal-free projects).
 */
function sanitizeTextRemoval(payload) {
  if (!payload || typeof payload !== "object") return null;
  const enabled = !!payload.enabled;
  const mode = VALID_MODES.has(payload.mode) ? payload.mode : "inpaint";
  const rawRegions = Array.isArray(payload.regions) ? payload.regions : [];
  const regions = [];
  for (const r of rawRegions) {
    if (!r || typeof r !== "object") continue;
    const x = Number(r.x), y = Number(r.y), w = Number(r.w), h = Number(r.h);
    if (![x, y, w, h].every((n) => Number.isFinite(n))) continue;
    const rx = Math.max(0, Math.min(1, x));
    const ry = Math.max(0, Math.min(1, y));
    const rw = Math.max(0, Math.min(1 - rx, w));
    const rh = Math.max(0, Math.min(1 - ry, h));
    if (rw < 0.004 || rh < 0.004) continue; // < ~0.4% of a dimension: noise
    regions.push({ x: rx, y: ry, w: rw, h: rh });
    if (regions.length >= MAX_REGIONS) break;
  }
  if (!enabled || regions.length === 0) return null;
  return { enabled: true, mode, regions };
}

/**
 * Convert normalized regions to pixel rects on a (srcW × srcH) frame,
 * clamped inside the frame with a 2px inset (delogo requires a border; the
 * blur overlay also behaves better fully inside).
 * @returns {Array<{x:number,y:number,w:number,h:number}>}
 */
function pixelRegions(regions, srcW, srcH) {
  const W = Math.floor(srcW) || 0;
  const H = Math.floor(srcH) || 0;
  if (W < 16 || H < 16) return [];
  const out = [];
  for (const r of regions) {
    let x = Math.round(r.x * W);
    let y = Math.round(r.y * H);
    let w = Math.round(r.w * W);
    let h = Math.round(r.h * H);
    if (w < 4 || h < 4) continue;
    // Clamp to the frame with the 2px inset.
    x = Math.max(2, Math.min(W - 6, x));
    y = Math.max(2, Math.min(H - 6, y));
    w = Math.min(w, W - 4 - x);
    h = Math.min(h, H - 4 - y);
    if (w < 4 || h < 4) continue;
    out.push({ x, y, w, h });
  }
  return out;
}

/**
 * LINEAR filter fragments (no labeled pads) for inpaint/cover — usable as a
 * `-vf` prefix AND inside filter_complex chains. Returns null for blur
 * (blur needs split/overlay pads — see textRemovalGraph) or when there is
 * nothing to apply.
 */
function textRemovalLinearFilters(o) {
  const rects = pixelRegions(o.regions, o.srcW, o.srcH);
  if (rects.length === 0) return null;
  if (o.mode === "inpaint") {
    return rects.map((r) => `delogo=x=${r.x}:y=${r.y}:w=${r.w}:h=${r.h}`).join(",");
  }
  if (o.mode === "cover") {
    return rects
      .map((r) => `drawbox=x=${r.x}:y=${r.y}:w=${r.w}:h=${r.h}:color=black:t=fill`)
      .join(",");
  }
  return null; // blur → complex graph only
}

/**
 * Build a complete filter_complex fragment mapping inLabel → outLabel that
 * applies text removal FIRST, then continues with `nextChain` (the segment's
 * normal chain, already comma-joined WITHOUT trailing/leading commas).
 *
 * inpaint/cover: one statement — `[in]delogo=..,delogo=..,<nextChain>[out]`.
 * blur: per region — `[cur]split=2[bgN][fgN];[fgN]crop=w:h:x:y,boxblur=…[fgNb];`
 *       `[bgN][fgNb]overlay=x:y[ovN]; … [ovLast]<nextChain>[out]`.
 *
 * `nextChain` may be empty ("" — e.g. an all-satisfied transform chain);
 * the fragment then terminates right after the removal filters.
 *
 * @returns {string|null} null = nothing to apply (caller uses its original
 *          graph line, byte-identical to text-removal-free builds).
 */
function textRemovalGraph(o) {
  const mode = o && VALID_MODES.has(o.mode) ? o.mode : "inpaint";
  const rects = pixelRegions(o.regions, o.srcW, o.srcH);
  if (rects.length === 0) return null;
  const inLabel = o.inLabel;
  const outLabel = o.outLabel;
  const next = typeof o.nextChain === "string" ? o.nextChain.trim() : "";
  const sep = next ? "," : "";
  const uid = o.uid || "tr";

  if (mode === "inpaint" || mode === "cover") {
    const filters = rects.map((r) =>
      mode === "inpaint"
        ? `delogo=x=${r.x}:y=${r.y}:w=${r.w}:h=${r.h}`
        : `drawbox=x=${r.x}:y=${r.y}:w=${r.w}:h=${r.h}:color=black:t=fill`,
    ).join(",");
    return `${inLabel}${filters}${sep}${next}${outLabel}`;
  }

  // BLUR — sequential region-limited blur via split/crop/boxblur/overlay.
  // Each region's overlay writes to an intermediate pad; the LAST one either
  // terminates at outLabel directly (empty nextChain) or chains into it.
  const parts = [];
  let cur = inLabel;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const isLast = i === rects.length - 1;
    // boxblur radius must be ≤ min(w,h)/2 of the CROPPED region.
    const radius = Math.max(2, Math.min(40, Math.floor(Math.min(r.w, r.h) / 8)));
    const out = isLast && !next ? outLabel : `[${uid}ov${i}]`;
    parts.push(
      `${cur}split=2[${uid}bg${i}][${uid}fg${i}]`,
      `[${uid}fg${i}]crop=${r.w}:${r.h}:${r.x}:${r.y},` +
        `boxblur=luma_radius=${radius}:luma_power=2:` +
        `chroma_radius=${radius}:chroma_power=2[${uid}fg${i}b]`,
      `[${uid}bg${i}][${uid}fg${i}b]overlay=x=${r.x}:y=${r.y}${out}`,
    );
    cur = out;
  }
  if (!next) return parts.join(";");
  // NOTE: no comma between a pad label and the first filter that consumes it
  // (`[ov0]format=…` is valid; `[ov0],format=…` is a parse error — the comma
  // only separates FILTERS within one chain, never labels from filters).
  return `${parts.join(";")};${cur}${next}${outLabel}`;
}

/** mode needs the labeled filter_complex (blur) vs works as -vf (others). */
function textRemovalNeedsComplex(mode) {
  return mode === "blur";
}

module.exports = {
  MAX_REGIONS,
  sanitizeTextRemoval,
  pixelRegions,
  textRemovalLinearFilters,
  textRemovalGraph,
  textRemovalNeedsComplex,
};
