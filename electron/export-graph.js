// electron/export-graph.js — FrameFuse v5.0 pure FFmpeg graph/arg builders.
//
// Extracted from electron/main.js (v4.9 logic kept VERBATIM for byte-identical
// back-compat) + the new v5.0 video/overlay/chroma/SFX builders. This module
// is CommonJS with ZERO requires and zero side effects, so it can be required
// by electron/main.js AND imported directly by the bun verification harness
// (/home/z/harness/export-graph-harness.js) — main.js itself cannot be
// imported in bun because it requires("electron") at the top level.
//
// v5.0 sections:
//   - overlayGeometryMirror / isXfadeStyleMirror / videoAtBoundaryMirror:
//     EXACT plain-JS mirrors of renderer.ts (single source of truth) — the
//     harness cross-asserts equality against the TS implementations.
//   - videoHasAudioParser / videoProbeParser: parse `ffmpeg -i` stderr.
//   - buildVideoInputArgs / buildVideoFilterChain: base-lane VIDEO clips
//     (cover-fit scale+crop, NO zoompan — video motion is the content).
//   - buildOverlayVideoInputArgs / buildOverlayImageInputArgs /
//     buildOverlayChain / buildOverlayFilter / overlayWindow: per-clip
//     overlay compositing (geometry + chromakey + despill + enable window).
//   - buildAudioMixGraph: step-2 clip-audio + music + SFX amix graph.
//   - buildClipArgs: the FULL per-clip argv (v4.9 branches verbatim + v5).
//   - buildConcatArgs: step-2 concat/mux argv (v4.9 verbatim + v5 audio).
"use strict";

/**
 * v6 SINGLE-PASS: the zoompan z/x/y expression builder, EXTRACTED VERBATIM
 * from buildClipArgs so the two-step per-clip path and the single-pass
 * whole-timeline path render Ken Burns from the SAME expression source
 * (structural parity — the harness snapshot-diffs buildClipArgs argv).
 *   o = { segFrames, dir, zoomMax, kbEnabled }
 * dir arrives PRE-RESOLVED (enabled ? seg.direction || globalDir : "none").
 * Returns { zExpr, xExpr, yExpr } — zoompan-expression strings over `on`.
 */
function kenBurnsZoompanExprs(o) {
  const enabled = !!(o && o.kbEnabled);
  const dir = enabled ? (o && o.dir) || "none" : "none";
  const zoomMax = Number(o && o.zoomMax) || 1;
  const segFrames = Math.max(2, Number(o && o.segFrames) || 2);
  if (!enabled || dir === "none") {
    return { zExpr: "1.1", xExpr: "iw/2-(iw/zoom/2)", yExpr: "ih/2-(ih/zoom/2)" };
  }
  // v6.5 CHUNKED SINGLE-PASS: `onOffset` (integer > 0) shifts the zoompan
  // output-frame clock by K frames — a chunk that starts mid-animation
  // continues the exact full-segment curve (on' = on + K; the divisor stays
  // the FULL segment's frame count). Absent/0 → plain `on`, byte-identical
  // to every pre-v6.5 caller (the two-step and the W=1 single-pass).
  const onOffset = Number(o && o.onOffset) || 0;
  const onBase = onOffset > 0 ? `(on+${Math.round(onOffset)})` : "on";
  const tExpr = `${onBase}/${Math.max(1, segFrames - 1)}`;
  const easeExpr = `-((cos(PI*${tExpr})-1)/2)`; // easeInOutSine (same as canvas)
  const zBase = 1.1;
  const zMaxEff = (1.1 * zoomMax).toFixed(6);
  const spanEff = (1.1 * zoomMax - 1.1).toFixed(6);
  const maxX = "(iw-iw/zoom)";
  const maxY = "(ih-ih/zoom)";
  if (dir === "in") {
    return {
      zExpr: `${zBase.toFixed(6)}+(${easeExpr})*${spanEff}`,
      xExpr: "iw/2-(iw/zoom/2)", yExpr: "ih/2-(ih/zoom/2)",
    };
  }
  if (dir === "out") {
    return {
      zExpr: `${zMaxEff}-(${easeExpr})*${spanEff}`,
      xExpr: "iw/2-(iw/zoom/2)", yExpr: "ih/2-(ih/zoom/2)",
    };
  }
  // Pan modes: constant zoom, window slides center → edge.
  if (dir === "right") {
    return { zExpr: zMaxEff, xExpr: `${maxX}/2*(1+(${easeExpr}))`, yExpr: `${maxY}/2` };
  }
  if (dir === "left") {
    return { zExpr: zMaxEff, xExpr: `${maxX}/2*(1-(${easeExpr}))`, yExpr: `${maxY}/2` };
  }
  if (dir === "down") {
    return { zExpr: zMaxEff, xExpr: `${maxX}/2`, yExpr: `${maxY}/2*(1+(${easeExpr}))` };
  }
  if (dir === "up") {
    return { zExpr: zMaxEff, xExpr: `${maxX}/2`, yExpr: `${maxY}/2*(1-(${easeExpr}))` };
  }
  return { zExpr: zMaxEff, xExpr: `${maxX}/2`, yExpr: `${maxY}/2` };
}

/**
 * v6 SINGLE-PASS: Ken Burns zoompan chain for one IMAGE segment — the exact
 * per-clip chain from buildClipArgs (supersample → zoompan → sar/format),
 * reusable against a single-frame image input (-i img, NO -loop: zoompan
 * consumes exactly one frame and emits segFrames — verified byte-identical
 * to the two-step's `-loop 1 + -t` output, scripts/verify-kenburns-parity.js).
 */
function kenBurnsImageChain(o) {
  const { zExpr, xExpr, yExpr } = kenBurnsZoompanExprs(o);
  const width = Number(o && o.width) || 0;
  const height = Number(o && o.height) || 0;
  const fps = Number(o && o.fps) || 30;
  const segFrames = Math.max(2, Number(o && o.segFrames) || 2);
  // v6.5 CHUNKED SINGLE-PASS: `emitFrames` bounds how many frames THIS chain
  // emits (zoompan d=), while `segFrames` stays the FULL segment's frame
  // count (the expression divisor, above). Absent → d=segFrames, the exact
  // legacy chain (byte-identical, verify-kenburns-parity.js).
  const emitFrames =
    Number(o && o.emitFrames) > 0
      ? Math.max(1, Math.round(Number(o.emitFrames)))
      : segFrames;
  const scaleW = Math.round(width * 1.1);
  const scaleH = Math.round(height * 1.1);
  return [
    `scale=${scaleW}:${scaleH}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${scaleW}:${scaleH}`,
    `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=${emitFrames}:s=${width}x${height}:fps=${fps}`,
    `setsar=1`,
    `format=yuv420p`,
  ].join(",");
}

// ---------------------------------------------------------------------------
// v4.3/v4.9 transition tables + helpers (moved verbatim from main.js)
// ---------------------------------------------------------------------------

/** v4.3 transition style → xfade transition name (offset=0 head composite).
 *  v5.1: circleopen joins the xfade family (canvas painter = renderer.ts
 *  computeTransitionFx kind "circle" — growing center circle reveal). */
const XFADE_NAMES = {
  dissolve: "fade",
  "slide-left": "slideleft",
  "slide-right": "slideright",
  "wipe-left": "wipeleft",
  "wipe-right": "wiperight",
  circleopen: "circleopen",
};
/** v4.3 dip styles → fade filter color. */
const DIP_COLORS = { "dip-black": "black", "dip-white": "white" };
/** Max fraction of a segment's duration a transition may occupy (matches
 *  clampTransitionMs in renderer.ts — keep the two in lockstep). */
const TRANSITION_MAX_FRACTION = 0.45;

function clampTrMs(ms, segDurMs) {
  return ms > 0 && segDurMs > 200
    ? Math.min(ms, Math.floor(segDurMs * TRANSITION_MAX_FRACTION))
    : 0;
}

// ---------------------------------------------------------------------------
// v1.1 TURBO EXPORT — pure helpers for the stream-copy fast path
// ---------------------------------------------------------------------------

/**
 * v1.1: boundary/transition planning extracted VERBATIM from buildClipArgs
 * (same inputs → same outputs — the harness differentials prove the argv of
 * buildClipArgs is unchanged). Exported so the stream-copy eligibility
 * check (clipNeedsReEncode) can consult the SAME math the encoder path
 * uses: a clip is only copy-safe when this plan produces NO fades at all.
 * Returns { curStyle, nextStyle, xfadeName, dipColor, headMs, dipTailMs,
 * startFadeMs, endFadeMs, useXfadeHead } — see buildClipArgs for semantics.
 */
function planBoundaryFades(i, seg, segments, transition) {
  const trGlobal = transition && transition.style ? transition.style : "none";
  const trOverrides =
    transition && transition.overrides && typeof transition.overrides === "object"
      ? transition.overrides
      : null;
  const boundaryStyleAt = (s) =>
    s && trOverrides && Object.prototype.hasOwnProperty.call(trOverrides, s.id)
      ? trOverrides[s.id]
      : trGlobal;
  const trWanted =
    transition && Number(transition.durationMs) > 0
      ? Number(transition.durationMs)
      : 0;
  const fadeStartEnd = !!(transition && transition.fadeStartEnd);
  const curStyle = i > 0 ? boundaryStyleAt(seg) : "none";
  const nextStyle = !isLastSeg(i, segments) ? boundaryStyleAt(segments[i + 1]) : "none";
  const xfadeName = XFADE_NAMES[curStyle] || null;
  const dipColor = DIP_COLORS[curStyle] || null;
  const headMs =
    i > 0 && curStyle !== "none" ? clampTrMs(trWanted, seg.durationMs) : 0;
  const dipTailMs =
    DIP_COLORS[nextStyle] && !isLastSeg(i, segments) ? clampTrMs(trWanted, seg.durationMs) : 0;
  const startFadeMs =
    i === 0 && fadeStartEnd ? clampTrMs(trWanted, seg.durationMs) : 0;
  const endFadeMs =
    isLastSeg(i, segments) && fadeStartEnd ? clampTrMs(trWanted, seg.durationMs) : 0;
  return {
    curStyle, nextStyle, xfadeName, dipColor, headMs, dipTailMs, startFadeMs, endFadeMs,
    trWanted, fadeStartEnd,
  };
}

function isLastSeg(i, segments) {
  return i === segments.length - 1;
}

/**
 * v1.1 TURBO: does this clip REQUIRE a re-encode? Everything that makes a
 * clip visually different from its source forces the encode path. The
 * SOURCE-format half of the eligibility (codec h264 + output dims + fps +
 * pix_fmt + full-window) is checked in main.js against the async probe —
 * this pure half covers the timeline-side reasons:
 *   - not a base-lane video segment, or a playback speed change
 *   - a head trim that is NOT keyframe-aligned (stream copy cannot cut
 *     mid-GOP frame-accurately). v1.4.1: a trim whose requested cut point
 *     has a source keyframe within one frame (main.js's showinfo probe —
 *     see findKeyframeAlignedStart) can copy from that keyframe, so it
 *     passes `ctx.trimKeyAligned: true` and stays copy-eligible
 *   - ANY overlay intersecting the clip window
 *   - burned captions/headlines for this clip (assSuffix)
 *   - a watermark anywhere in the project
 *   - a REAL fade filter touching this clip: dip heads/tails and the
 *     fadeStartEnd bookends. An xfade-FAMILY style at a VIDEO boundary is
 *     a HARD CUT (the v5.0 video rule — both preview and export render it
 *     as a plain concatenation, no filter), so dissolve/slide/wipe
 *     transitions between video clips stay copy-eligible. Ken Burns is
 *     image-only (videos never get zoompan), so it is not consulted here.
 */
function clipNeedsReEncode(ctx) {
  const {
    i, seg, segments, transition,
    overlayCount, assSuffix, wm, trimKeyAligned,
  } = ctx;
  const isVideo = !!(seg && seg.mediaType === "video" && seg.videoPath);
  if (!isVideo) return true;
  if (resolveSegSpeed(seg) !== 1) return true;
  if ((Number(seg.trimInMs) || 0) > 0 && trimKeyAligned !== true) return true;
  if (Number(overlayCount) > 0) return true;
  if (assSuffix) return true;
  if (wm) return true;
  const plan = planBoundaryFades(i, seg, segments, transition);
  // A head FADE filter only exists for dip styles at this boundary
  // (postFades: `dipColor && headMs > 0`); xfade heads on video
  // boundaries never materialize (hard cut).
  const headFadeFilter = !!(plan.dipColor && plan.headMs > 0);
  if (headFadeFilter || plan.dipTailMs > 0 || plan.startFadeMs > 0 || plan.endFadeMs > 0) {
    return true;
  }
  return false;
}

/**
 * v6 PHASE 3 — SMART TURBO "sandwich" copy plan for a MID-GOP trim:
 * frame-accurate output where only the two EDGES re-encode and the whole
 * middle rides `-c copy` between keyframes:
 *   [trim ─── k1) = HEAD edge (re-encode, ≤ maxEdgeMs)
 *   [k1 ────── k2) = MIDDLE (stream copy from the k1 keyframe)
 *   [k2 ─── trim+dur] = TAIL edge (re-encode, ≤ maxEdgeMs)
 * The plan's keyframe window MUST cover [trim−2.5s, trim+dur+2.5s]
 * (probeKeyframesNear semantics). Unlike widening the keyframe tolerance
 * (which would shift content up to the tolerance vs the preview), the
 * sandwich keeps the frame-accurate boundaries the v1.4.1 copy path is
 * trusted for, and lifts the TURBO hit rate on trimmed clips from
 * "keyframe lands within one frame" (≈5%) to "GOPs straddle the trim"
 * (typical ≥60% for ≥4s clips at any GOP size).
 * o = { trimMs, durMs, keyframes: [{ s, ms }…], maxEdgeMs?=2000,
 *       minMiddleMs?=4000 }
 * Returns { head: {trimMs,durMs}|null, middle: { ss, durMs },
 *          tail: {trimMs,durMs}|null } | null (not sandwichable).
 */
function planSandwichCopy(o) {
  const trimMs = Math.max(0, Number(o && o.trimMs) || 0);
  const durMs = Math.max(0, Number(o && o.durMs) || 0);
  const kfs = (Array.isArray(o && o.keyframes) ? o.keyframes : [])
    .filter((k) => k && Number.isFinite(Number(k.ms)))
    .map((k) => ({ s: String(k.s), ms: Number(k.ms) }))
    .sort((a, b) => a.ms - b.ms);
  const maxEdgeMs = Number.isFinite(Number(o && o.maxEdgeMs)) ? Number(o.maxEdgeMs) : 2000;
  const minMiddleMs = Number.isFinite(Number(o && o.minMiddleMs)) ? Number(o.minMiddleMs) : 4000;
  if (durMs <= 0 || kfs.length === 0) return null;
  const endMs = trimMs + durMs;
  let k1 = null;
  for (const k of kfs) { if (k.ms >= trimMs - 1) { k1 = k; break; } }
  let k2 = null;
  for (const k of kfs) { if (k.ms <= endMs + 1) k2 = k; }
  if (!k1 || !k2) return null;
  if (k2.ms - k1.ms < minMiddleMs) return null;
  const headDur = Math.max(0, k1.ms - trimMs);
  const tailDur = Math.max(0, endMs - k2.ms);
  if (headDur > maxEdgeMs || tailDur > maxEdgeMs) return null;
  if (headDur <= 1 && tailDur <= 1) return null; // fully aligned → the legacy single copy owns it
  return {
    head: headDur > 1 ? { trimMs, durMs: Math.round(headDur) } : null,
    middle: { ss: k1.s, durMs: Math.round(k2.ms - k1.ms) },
    tail: tailDur > 1 ? { trimMs: Math.round(k2.ms), durMs: Math.round(tailDur) } : null,
  };
}

/**
 * v1.1 TURBO: step-1 argv for a STREAM-COPY clip — demux the source window
 * and remux the video packets UNTOUCHED (no decode, no filter graph, no
 * encode). Eligibility is decided upstream (clipNeedsReEncode + the probe
 * format checks in main.js); this builder only lays out the fast argv:
 *   [-ss <sec> -noaccurate_seek] -t <dur> -i <src> -c:v copy -an
 *   -avoid_negative_ts make_zero -y <out>
 * `-t` rides the INPUT side so demux stops early; `-an` keeps the clip
 * video-only (audio is mixed separately in step 2); make_zero normalizes
 * packet timestamps so the concat demuxer offsets cleanly.
 * v1.4.1 KEYFRAME-ALIGNED TRIMS: `o.ss` is the EXACT pts string (µs
 * precision, e.g. "2.033367") of a source keyframe that main.js's probe
 * found within one frame of the requested trimInMs. Two hard-won details
 * (verified against real ffmpeg 6.1.1):
 *   • `-noaccurate_seek` makes the demuxer START output at the seek-LANDING
 *     keyframe instead of discarding packets until the target — without it
 *     the copy would begin on a mid-GOP frame (undecodable leading frames).
 *   • the exact string matters: a target even 1 ms EARLY makes the backward
 *     seek land on the PREVIOUS keyframe and pull a whole extra GOP of
 *     content. Same-string round-trips land on the intended keyframe.
 * `-t <dur>` is measured on ORIGINAL timestamps from the seek target, so
 * the copied window is exactly [ss, ss + dur] — timeline length preserved.
 */
function buildStreamCopyArgs(o) {
  const durMs = Math.max(0, Number(o && o.durMs) || 0);
  const ss =
    o && typeof o.ss === "string" && /^\d+(?:\.\d+)?$/.test(o.ss) ? o.ss : null;
  const argv = [];
  if (ss) argv.push("-ss", ss, "-noaccurate_seek");
  argv.push(
    "-t", fmt3(durMs),
    "-i", o && o.path,
    "-c:v", "copy",
    "-an",
    "-avoid_negative_ts", "make_zero",
    "-y", o && o.clipPath,
  );
  return argv;
}

/**
 * Frozen zoompan expressions = the PREVIOUS segment's Ken Burns END state
 * (eased = 1). Used as input A of the xfade head composite so the preview's
 * "prev frame frozen at its end" and the export are pixel-identical.
 */
function frozenZoompanExpr(dir, zoomMax) {
  const zBase = 1.1;
  const zMaxEff = (1.1 * zoomMax).toFixed(6);
  const maxX = "(iw-iw/zoom)";
  const maxY = "(ih-ih/zoom)";
  const center = "iw/2-(iw/zoom/2)";
  const centerY = "ih/2-(ih/zoom/2)";
  switch (dir) {
    case "in":
      return { z: zMaxEff, x: center, y: centerY };
    case "right":
      return { z: zMaxEff, x: maxX, y: `${maxY}/2` };
    case "left":
      return { z: zMaxEff, x: "0", y: `${maxY}/2` };
    case "down":
      return { z: zMaxEff, x: `${maxX}/2`, y: maxY };
    case "up":
      return { z: zMaxEff, x: `${maxX}/2`, y: "0" };
    default: // "out", "none", disabled
      return { z: zBase.toFixed(6), x: center, y: centerY };
  }
}

// ---------------------------------------------------------------------------
// v5.0 mirrors of renderer.ts (plain JS — main process can't run TS)
// ---------------------------------------------------------------------------

/**
 * EXACT mirror of overlayGeometry() in src/lib/merger/renderer.ts:
 * dw = videoW·clamp(scalePercent,10,100)/100 (min 1), dh aspect-preserved
 * (round, min 1), margin = round(videoW·0.02), watermarkGeometry-identical
 * 9-grid col/row anchors. Degenerate dims (≤0 / non-finite / missing t) →
 * all zeros; non-finite scalePercent degrades to 100.
 *
 * v5.2: finite t.x + t.y (normalized 0..1 center, set by dragging the
 * overlay on the preview canvas) OVERRIDE the 9-grid anchor — at least 8%
 * of the overlay stays visible on every edge. Mirror-identical math.
 */
function overlayGeometryMirror(videoW, videoH, srcW, srcH, t) {
  if (
    !t ||
    !Number.isFinite(videoW) ||
    !Number.isFinite(videoH) ||
    !Number.isFinite(srcW) ||
    !Number.isFinite(srcH) ||
    videoW <= 0 ||
    videoH <= 0 ||
    srcW <= 0 ||
    srcH <= 0
  ) {
    return { dx: 0, dy: 0, dw: 0, dh: 0 };
  }
  const sp = Number.isFinite(t.scalePercent)
    ? Math.max(10, Math.min(100, t.scalePercent))
    : 100;
  const dw = Math.max(1, Math.round((videoW * sp) / 100));
  const dh = Math.max(1, Math.round((dw * srcH) / srcW)); // aspect preserved
  const m = Math.round(videoW * 0.02);

  const pos = t.position;
  // Horizontal anchor: left column / center column / right column.
  const col = typeof pos === "string" && pos.endsWith("left") ? 0 : typeof pos === "string" && pos.endsWith("right") ? 2 : 1;
  // Vertical anchor: top row / middle row / bottom row.
  const row = typeof pos === "string" && pos.startsWith("top") ? 0 : typeof pos === "string" && pos.startsWith("bottom") ? 2 : 1;

  // v5.2 free-form placement (dragged on the preview canvas).
  if (Number.isFinite(t.x) && Number.isFinite(t.y)) {
    const cx = Math.max(0, Math.min(1, t.x)) * videoW;
    const cy = Math.max(0, Math.min(1, t.y)) * videoH;
    const fx = Math.round(Math.max(-dw * 0.92, Math.min(videoW - dw * 0.08, cx - dw / 2)));
    const fy = Math.round(Math.max(-dh * 0.92, Math.min(videoH - dh * 0.08, cy - dh / 2)));
    return { dx: fx, dy: fy, dw, dh };
  }

  const dx =
    col === 0 ? m : col === 2 ? Math.round(videoW - dw - m) : Math.round((videoW - dw) / 2);
  const dy =
    row === 0 ? m : row === 2 ? Math.round(videoH - dh - m) : Math.round((videoH - dh) / 2);

  return { dx, dy, dw, dh };
}

/** EXACT mirror of isXfadeStyle() in renderer.ts — the styles FFmpeg
 *  composites via the `xfade` filter (dissolve / slide / wipe). */
function isXfadeStyleMirror(style) {
  return Object.prototype.hasOwnProperty.call(XFADE_NAMES, style);
}

// ---------------------------------------------------------------------------
// v5.6 MOTION PATHS — the export mirror of renderer.ts' keyframe math.
//
// The preview samples a piecewise-LINEAR curve (hold-first / hold-last) in
// NORMALIZED center coords and converts per frame through
// overlayGeometry()'s free-form branch (cx = x·W, dx = clamp(cx − dw/2,
// −dw·0.92, W − dw·0.08)). The export reproduces the same curve as an
// overlay filter x/y TIME EXPRESSION (evaluated per frame, `t` is the
// CLIP-LOCAL timestamp — the same clock `enable='between(t,a,b)'` uses):
//
//   dx(t) = clip( NORMX(t)·W − dw/2, −dw·0.92, W − dw·0.08 )
//   NORMX(t) = piecewise-linear of the keyframes' x values at
//              overlay-local time t + tOffsetSec  (tOffsetSec shifts the
//              clip-local clock onto the overlay's window-local clock —
//              (clipStart − ovStart)/1000, ≥ 0 when the overlay started
//              in an earlier base clip).
//
// Lerp happens in NORMALIZED space (identical to the preview) and the
// visibility clamp runs per frame AFTER the lerp — the exact same order
// overlayGeometry applies, so preview and export can never drift.
// ---------------------------------------------------------------------------

/** EXACT mirror of sanitizeMotionKeyframes() in renderer.ts: coerce an
 *  arbitrary IPC payload into a clean sorted keyframe list. */
function sanitizeMotionMirror(motion) {
  if (!Array.isArray(motion)) return [];
  const out = [];
  for (const raw of motion) {
    if (!raw || typeof raw !== "object") continue;
    const tMs = Number(raw.tMs);
    const x = Number(raw.x);
    const y = Number(raw.y);
    if (!Number.isFinite(tMs) || tMs < 0) continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({
      tMs: Math.round(tMs),
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
    });
  }
  out.sort((a, b) => a.tMs - b.tMs);
  const deduped = [];
  for (const kf of out) {
    if (deduped.length > 0 && deduped[deduped.length - 1].tMs === kf.tMs) {
      deduped[deduped.length - 1] = kf;
    } else {
      deduped.push(kf);
    }
  }
  return deduped;
}

/**
 * Build the piecewise-linear NORMALIZED expression for one coordinate
 * axis of a motion path. `kfs` must be pre-sanitized (sorted, ≥ 2), `axis`
 * is "x" or "y". Returns an ffmpeg expression string in the variable T
 * (overlay-local seconds). No quoting here — buildMotionOverlayExpr owns
 * the final wrap.
 */
function motionNormExpr(kfs, axis, T) {
  const n = kfs.length;
  const v = (kf) => Number(kf[axis]).toFixed(6);
  const tk = (kf) => (kf.tMs / 1000).toFixed(6);
  // Segment i covers [t_i, t_i+1): lerp between kfs i and i+1.
  const seg = (i) =>
    `${v(kfs[i])}+(${v(kfs[i + 1])}-${v(kfs[i])})*(${T}-${tk(kfs[i])})/(${tk(kfs[i + 1])}-${tk(kfs[i])})`;
  // Nested from the tail: E = seg(n-2); E = if(lt(T,t_{i+1}), seg(i), E).
  let E = seg(n - 2);
  for (let i = n - 3; i >= 0; i--) {
    E = `if(lt(${T},${tk(kfs[i + 1])}),${seg(i)},${E})`;
  }
  // Hold-first / hold-last wrap.
  return `if(lt(${T},${tk(kfs[0])}),${v(kfs[0])},if(gte(${T},${tk(kfs[n - 1])}),${v(kfs[n - 1])},${E}))`;
}

/**
 * v5.6: overlay filter x/y EXPRESSIONS for an animated motion path.
 *   o = { videoW, videoH, dw, dh, tOffsetSec, motion }   (motion ≥ 2 kfs)
 * Returns { xExpr, yExpr } (unquoted — the caller wraps in '…'). The dw/dh
 * MUST come from overlayGeometryMirror (scale-derived, aspect-preserved)
 * so the pixel clamp math matches the preview exactly.
 */
function buildMotionOverlayExpr(o) {
  const kfs = sanitizeMotionMirror(o && o.motion);
  const videoW = Number(o && o.videoW) || 0;
  const videoH = Number(o && o.videoH) || 0;
  const dw = Number(o && o.dw) || 0;
  const dh = Number(o && o.dh) || 0;
  if (kfs.length < 2 || videoW <= 0 || videoH <= 0 || dw <= 0 || dh <= 0) {
    return null;
  }
  const off = Number(o && o.tOffsetSec) || 0;
  const T = `(t${off >= 0 ? "+" : ""}${off.toFixed(6)})`;
  const nx = motionNormExpr(kfs, "x", T);
  const ny = motionNormExpr(kfs, "y", T);
  // overlayGeometry free-form mirror: dx = clamp(x·W − dw/2, −dw·0.92,
  // W − dw·0.08). ffmpeg clip(x, min, max) — same semantics. The outer
  // floor(…+0.5) mirrors the preview's Math.round: without it the filter
  // TRUNCATES the interpolated float (e.g. 45.99999 → 45) and drifts 1px
  // from the canvas on mid-lerp frames.
  const xExpr = `floor(clip(${nx}*${videoW}-${(dw / 2).toFixed(3)},${(-dw * 0.92).toFixed(3)},${(videoW - dw * 0.08).toFixed(3)})+0.5)`;
  const yExpr = `floor(clip(${ny}*${videoH}-${(dh / 2).toFixed(3)},${(-dh * 0.92).toFixed(3)},${(videoH - dh * 0.08).toFixed(3)})+0.5)`;
  return { xExpr, yExpr };
}

/** EXACT mirror of videoAtBoundary() in renderer.ts: does the boundary
 *  entering `segIdx` touch a VIDEO segment on either side? (Segments
 *  without mediaType — hand-built / legacy — are treated as images.) */
function videoAtBoundaryMirror(segments, segIdx) {
  return (
    (segments && segments[segIdx] && segments[segIdx].mediaType === "video") ||
    (segments && segments[segIdx - 1] && segments[segIdx - 1].mediaType === "video")
  ) ? true : false;
}

// ---------------------------------------------------------------------------
// ffmpeg -i stderr parsers (probe cache lives in main.js)
// ---------------------------------------------------------------------------

/** True when the probe stderr lists any "Stream #…: Audio:" stream. */
function videoHasAudioParser(stderr) {
  if (typeof stderr !== "string") return false;
  return /Stream\s+#\d+:\d+[^:]*:\s*Audio:/.test(stderr);
}

/**
 * Parse `ffmpeg -i <file>` stderr → { hasAudio, width, height, durationMs }.
 * width/height are the EFFECTIVE display dims (already swapped for ±90°/
 * ±270° displaymatrix rotation, matching what ffmpeg decodes+autorotates
 * to). width/height stay 0 when no video stream line is found.
 * v5.2: durationMs parsed from the container "Duration: HH:MM:SS.ms" line —
 * drives the -ss modulo for looped overlay inputs.
 * v1.1 TURBO: codec / pixFmt / fps / rotated parsed from the same video
 * stream line — the stream-copy eligibility gate needs them (h264 +
 * yuv420p + matching fps; rotated sources must re-encode because copy
 * keeps the rotation display matrix while re-encoded clips don't).
 *   "Stream #0:0…: Video: h264 (High) (avc1 / 0x31637661), yuv420p,
 *    1920x1080 [SAR 1:1 DAR 16:9], 2132 kb/s, 30 fps, 30 tbr, 15360 tbn"
 * fps prefers the explicit "N fps" field, else "N tbr" (VFR sources
 * report an average tbr — close enough for the ±0.06 gate).
 */
function videoProbeParser(stderr) {
  const out = {
    hasAudio: false, width: 0, height: 0, durationMs: 0,
    codec: "", pixFmt: "", fps: 0, rotated: false,
  };
  if (typeof stderr !== "string") return out;
  out.hasAudio = videoHasAudioParser(stderr);
  const lines = stderr.split(/\r?\n/);
  let vline = null;
  for (const ln of lines) {
    if (/Stream\s+#\d+:\d+[^:]*:\s*Video:/.test(ln)) { vline = ln; break; }
  }
  if (vline) {
    const m = vline.match(/(\d{2,5})x(\d{2,5})/);
    if (m) { out.width = +m[1]; out.height = +m[2]; }
    const c = vline.match(/Video:\s*([a-z0-9_-]+)/i);
    if (c) out.codec = c[1].toLowerCase();
    const pf = vline.match(/,\s*(yuv[a-z0-9]+|nv12|nv21|rgb[a-z0-9]*|gray[a-z0-9]*)\b/i);
    if (pf) out.pixFmt = pf[1].toLowerCase();
    const f = vline.match(/([\d.]+)\s*fps/) || vline.match(/([\d.]+)\s*tbr/);
    if (f) out.fps = parseFloat(f[1]) || 0;
  }
  const dur = stderr.match(/Duration:\s*(\d+):(\d{2}):(\d{2}\.\d{2})/);
  if (dur) {
    out.durationMs = Math.round((+dur[1] * 3600 + +dur[2] * 60 + +dur[3]) * 1000);
  }
  const rot = stderr.match(/displaymatrix:\s*rotation of\s*(-?[\d.]+)/);
  if (rot) {
    const r = Math.abs(parseFloat(rot[1])) % 360;
    if (Math.abs(r - 90) < 0.01 || Math.abs(r - 270) < 0.01) {
      const t = out.width; out.width = out.height; out.height = t;
      out.rotated = true;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// v5.0 shared number/color helpers
// ---------------------------------------------------------------------------

/** ms → "s.fff" seconds string (the v4.9 -t formatting convention). */
function fmt3(ms) {
  return (ms / 1000).toFixed(3);
}

/** Resolve a playback volume (0..2, 1 = unity; non-finite → 1). */
function normalizeVolume(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(2, n));
}

function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

// ---------------------------------------------------------------------------
// v1.2 2-PASS MEASURED LOUDNORM
// ---------------------------------------------------------------------------

/**
 * Build the MEASURED (2nd-pass) loudnorm filter string from a pass-1
 * measurement { i, lra, tp, thresh, offset } (see main.js
 * measureLoudnessAsync — the ffmpeg loudnorm JSON summary). This is the
 * canonical ffmpeg 2-pass recipe: measured_* + offset + linear=true apply
 * a STATIC gain instead of the single-pass dynamic mode, which pumps and
 * breathes on variable material and defeats per-source consistency.
 * Returns null when the measurement is unusable (caller falls back to
 * single-pass loudnorm).
 */
function measuredLoudnormFilter(m) {
  if (!m) return null;
  const i = Number(m.i);
  const lra = Number(m.lra);
  const tp = Number(m.tp);
  const th = Number(m.thresh);
  if (!Number.isFinite(i) || !Number.isFinite(lra) || !Number.isFinite(tp) || !Number.isFinite(th)) {
    return null;
  }
  // Silent inputs measure as -inf/-70dB-ish — a static gain from those
  // numbers would be meaningless; let the caller fall back.
  if (i <= -70 || i >= 0) return null;
  const off = Number(m.offset);
  const offStr = Number.isFinite(off) && off !== 0 ? `:offset=${off}` : "";
  return (
    `loudnorm=I=-16:TP=-1.5:LRA=11` +
    `:measured_I=${i}:measured_LRA=${lra}:measured_TP=${tp}:measured_thresh=${th}` +
    `${offStr}:linear=true`
  );
}

/** Parse "#rgb" / "#rrggbb" / "0x…"-less hex → 0–255 channels, else null. */
function hexToRgbParts(hex) {
  const s = String(hex == null ? "" : hex).trim();
  let m = /^#?([0-9a-fA-F]{6})$/.exec(s);
  if (m) {
    return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16) };
  }
  m = /^#?([0-9a-fA-F]{3})$/.exec(s);
  if (m) {
    return {
      r: parseInt(m[1][0] + m[1][0], 16),
      g: parseInt(m[1][1] + m[1][1], 16),
      b: parseInt(m[1][2] + m[1][2], 16),
    };
  }
  return null;
}

/** ChromaKeySettings.color hex → ffmpeg color literal "0xrrggbb". */
function hexToFfmpegColor(hex) {
  const c = hexToRgbParts(hex);
  if (!c) return "0x00e000"; // default studio green
  const two = (v) => Math.round(v).toString(16).padStart(2, "0");
  return `0x${two(c.r)}${two(c.g)}${two(c.b)}`;
}

/**
 * despill type approximation from the KEY COLOR hue: a green-dominant key
 * (g > r AND g > b) → "green", everything else → "blue". FFmpeg's despill
 * only knows green/blue screens, so magenta/cyan keys fall to the closer
 * family — documented approximation shared with the WebGL preview.
 */
function chromaDespillType(color) {
  const c = hexToRgbParts(color);
  if (!c) return "green";
  return c.g > c.r && c.g > c.b ? "green" : "blue";
}

// ---------------------------------------------------------------------------
// v5.0 base-lane VIDEO clip input + filter chain
// ---------------------------------------------------------------------------

/**
 * Input args for a base-lane video segment: `[-hwaccel auto]? -ss <trimIn/1000>
 * [-t <sourceWindow/1000>]? -i <path>`.
 * (The clip-duration `-t` is an OUTPUT option appended by buildClipArgs —
 * identical semantics to the v4.9 `-loop 1 -i img … -t dur` layout.)
 * v5.1: `o.hwaccel` prepends `-hwaccel auto` — hardware DECODE (d3d11va on
 * Windows) with silent software fallback. Frames still cross to system
 * memory for the CPU filter graph, so argv validity never changes; the flag
 * is absent by default, keeping every pre-v5.1 call byte-identical.
 * v5.1: `o.durMs` (SOURCE window, ms) adds the input `-t` so a sped-up clip
 * demuxes exactly the window setpts will retime. Absent (speed 1) → no `-t`,
 * byte-identical to the pre-v5.1 argv.
 */
function buildVideoInputArgs(o) {
  // v1.4.2: `ssSec` (µs-precision preformatted seconds) lets the chunked
  // encode path pass EXACT frame-aligned seek points — fmt3()'s ms
  // truncation can straddle a frame edge at 60 fps (16.7 ms/frame).
  // Legacy callers (no ssSec) keep the byte-identical fmt3 output.
  const ss =
    o && o.ssSec != null
      ? o.ssSec
      : fmt3(Math.max(0, Number(o && o.trimInMs) || 0));
  const hw = o && o.hwaccel ? ["-hwaccel", "auto"] : [];
  const durMs = Number(o && o.durMs);
  const t =
    o && Number.isFinite(durMs) && durMs > 0
      ? ["-t", fmt3(durMs)]
      : [];
  return [...hw, "-ss", ss, ...t, "-i", o && o.path];
}

/** v5.1: format a speed factor for ffmpeg expressions (≤6 decimals). */
function fmtSpeed(v) {
  return String(Number(v.toFixed(6)));
}

/**
 * v5.1: atempo filter chain for a playback speed. atempo accepts 0.5–2.0
 * only — speeds outside that window chain two stages whose factors
 * multiply to the requested speed (4× = atempo=2,atempo=2; 0.25× =
 * atempo=0.5,atempo=0.5). speed 1 (or invalid) → EMPTY array so the audio
 * chain is untouched and byte-identical for every pre-v5.1 clip.
 */
function atempoFilters(speed) {
  const n = Number(speed);
  if (!Number.isFinite(n) || n <= 0 || n === 1) return [];
  if (n >= 0.5 && n <= 2) return [`atempo=${fmtSpeed(n)}`];
  if (n > 2) {
    const b = n / 2;
    return b === 1 ? ["atempo=2"] : ["atempo=2", `atempo=${fmtSpeed(b)}`];
  }
  const b = n / 0.5;
  return b === 1 ? ["atempo=0.5"] : ["atempo=0.5", `atempo=${fmtSpeed(b)}`];
}

/**
 * v5.1: resolve a segment playback speed (0.25..4; anything missing,
 * non-finite or exactly 1 → 1 = "no speed feature" — the guard value that
 * keeps argv byte-identical for all v4.9/v5.0 projects).
 */
function resolveSegSpeed(seg) {
  const n = Number(seg && seg.speed);
  if (!Number.isFinite(n) || n <= 0 || n === 1) return 1;
  return Math.max(0.25, Math.min(4, n));
}

/**
 * v1.4.2 CHUNKED PARALLEL ENCODE — frame-aligned chunk plan for a long
 * re-encode clip. A single 19-minute clip today = ONE ffmpeg process whose
 * filter graph (libass subtitles, scale, overlay) is single-threaded → the
 * classic ~3 fps pathology = multi-hour exports even on many-core machines.
 * Splitting the clip into frame-aligned chunks lets the EXISTING parallel
 * pool encode them concurrently (concat stays `-c copy` — uniform output
 * spec), turning the one-long-clip case into the many-clips case.
 *
 * Rules:
 *  - a clip shorter than ONE target chunk isn't split (nothing to gain);
 *  - chunk count n = max(2, ceil(dur/target)), capped at maxChunks — so
 *    every chunk is ≥ target/2 (seek/GOP re-decode overhead stays < ~5%);
 *  - chunk boundaries land EXACTLY on output frames: total frames are
 *    split into nearly-equal INTEGER frame counts, so the concatenated
 *    frame count equals the single-process frame count (no dup/drop);
 *  - each chunk's offset/duration derive from frame counts / fps with FULL
 *    float precision (µs-formatted at the argv layer — see ssSec).
 * Returns null when chunking doesn't apply; otherwise an array of
 *   { firstFrame, frames, offsetMs, durMs, first, last }.
 */
function planChunkFrames(durationMs, fps, targetSec, maxChunks) {
  const durMs = Number(durationMs) || 0;
  const rate = Number(fps) || 0;
  const tgt = Number(targetSec) || 60;
  if (durMs <= 0 || rate <= 0) return null;
  const durSec = durMs / 1000;
  if (durSec < tgt) return null; // shorter than one target chunk — don't split
  const cap = Math.max(2, Math.max(2, Number(maxChunks) || 2));
  let n = Math.min(cap, Math.max(2, Math.ceil(durSec / tgt)));
  if (n < 2) return null;
  const totalFrames = Math.max(2, Math.round(durSec * rate));
  if (totalFrames < n * 8) return null; // frames too coarse to split
  const base = Math.floor(totalFrames / n);
  const rem = totalFrames % n;
  const chunks = [];
  let f0 = 0;
  for (let k = 0; k < n; k++) {
    const frames = base + (k < rem ? 1 : 0);
    if (frames <= 0) continue;
    chunks.push({
      firstFrame: f0,
      frames,
      offsetMs: (f0 / rate) * 1000,
      durMs: (frames / rate) * 1000,
      first: k === 0,
      last: k === n - 1,
    });
    f0 += frames;
  }
  if (chunks.length < 2) return null;
  // Integrity: the plan must cover the clip exactly (frame-sum parity).
  const covered = chunks.reduce((a, c) => a + c.frames, 0);
  if (covered !== totalFrames) return null;
  return chunks;
}

/**
 * Cover-fit chain for base-lane VIDEO segments — the drawVideoFrame() twin
 * (object-fit: cover, zoom locked to 1, NO Ken Burns):
 *   scale=W:H:force_original_aspect_ratio=increase,crop=W:H[,setpts],fps,setsar,format
 * v5.1: `o.speed` (≠1) inserts `setpts=PTS/speed` AFTER the cover-fit chain
 * and BEFORE fps — PTS divided by speed retimes the decoded frames onto
 * the clip's timeline clock. speed 1 → no setpts, chain unchanged.
 */
function buildVideoFilterChain(o) {
  const speed = resolveSegSpeed({ speed: o && o.speed });
  const pts =
    speed !== 1 ? [`setpts=PTS/${fmtSpeed(speed)}`] : [];
  return [
    `scale=${o.width}:${o.height}:force_original_aspect_ratio=increase`,
    `crop=${o.width}:${o.height}`,
    ...pts,
    `fps=${o.fps}`,
    `setsar=1`,
    `format=yuv420p`,
  ].join(",");
}

// ---------------------------------------------------------------------------
// v5.0 overlay compositing (per base clip)
// ---------------------------------------------------------------------------

/**
 * Intersection of overlay [startMs, endMs) with the clip window
 * [clipStartMs, clipStartMs + clipDurMs). Returns null when there is no
 * overlap (half-open intervals — touching edges never overlap).
 *   overlapMs: how much of the overlay is visible inside this clip
 *   a / b:     clip-local seconds of the visible window (enable= between)
 *   ssMs:      SOURCE seek point = trimIn + max(0, clipStart − ovStart)
 *              (the overlay's playback position at the clip start)
 *   clippedEnd: v6.5 — true when the overlay's OWN end lies past the clip
 *              window (it continues into the next clip/chunk). Consumers
 *              that pad overlay INPUT windows past a chunk end need exactly
 *              this case (framesync eof_action=pass would otherwise drop the
 *              overlay from the chunk's last frame); overlays that END
 *              inside the window must NOT be padded (the full render's own
 *              EOF behavior is the reference).
 */
function overlayWindow(ov, clipStartMs, clipDurMs) {
  if (!ov || !Number.isFinite(clipStartMs) || !Number.isFinite(clipDurMs)) return null;
  const ovStart = Number(ov.startMs);
  const ovDur = Number(ov.durationMs);
  if (!Number.isFinite(ovStart) || !Number.isFinite(ovDur) || ovDur <= 0) return null;
  const ovEnd = ovStart + ovDur;
  const clipEnd = clipStartMs + clipDurMs;
  const s = Math.max(ovStart, clipStartMs);
  const e = Math.min(ovEnd, clipEnd);
  if (e <= s) return null;
  return {
    overlapMs: e - s,
    a: (s - clipStartMs) / 1000,
    b: (e - clipStartMs) / 1000,
    ssMs: (Number(ov.trimInMs) || 0) + Math.max(0, clipStartMs - ovStart),
    clippedEnd: ovEnd > clipEnd + 1e-9,
  };
}

/**
 * Input args for a VIDEO overlay trimmed to the overlap window. Both -ss and
 * -t are INPUT options (they must precede -i to bind to THIS input when
 * further inputs follow): `-ss <ss> -t <overlapDur> -i <path>`.
 *
 * v5.2: `loop` (overlayLoop) prepends -stream_loop -1 so a source SHORTER
 * than the window repeats to fill it (green-screen clip spanning the whole
 * video). -ss is taken modulo the source duration when it is known, so a
 * long-running window still lands inside the first iteration.
 */
function buildOverlayVideoInputArgs(o) {
  const args = [];
  if (o && o.loop) args.push("-stream_loop", "-1");
  let ss = Math.max(0, Number(o && o.ssMs) || 0);
  if (o && o.loop && Number(o.srcDurMs) > 0) {
    ss = ss % Number(o.srcDurMs);
  }
  args.push("-ss", fmt3(ss), "-t", fmt3(Math.max(0, Number(o && o.durMs) || 0)), "-i", o && o.path);
  return args;
}

/**
 * Input args for an IMAGE overlay: `-loop 1 -t <overlapDur> -i <path>`
 * (input-option -t so the looped image stream terminates at the window end;
 * brief's "overlapDur/1004" is treated as a typo for /1000 — dividing by
 * 1004 would make the stream SHORTER than the enable window).
 */
function buildOverlayImageInputArgs(o) {
  return ["-loop", "1", "-t", fmt3(Math.max(0, Number(o && o.durMs) || 0)), "-i", o && o.path];
}

/**
 * Per-overlay filter chain: scale to the overlayGeometry rect, optional
 * chromakey/lumakey + despill (settings defensively re-clamped here — main.js is
 * the trust boundary for IPC payloads), format=rgba for the overlay
 * filter's alpha compositing, and a PTS shift onto the CLIP-LOCAL clock:
 *   [i:v]scale=dw:dh[,chromakey=color:sim:blend,despill=type:mix],format=rgba,setpts=PTS+a/TB[ovlI]
 * v1: mode "luma" (white/black screens) builds ffmpeg `lumakey=threshold:
 * tolerance:softness` instead — threshold = BT.601 luma of the key color.
 * A chroma key on a neutral color removes EVERY gray pixel (u=v=0 for all
 * grays), which made the overlay's content invisible; the luma key keeps
 * dark content on a white screen and vice versa. Despill is green-screen
 * only — skipped in luma mode (parity with the preview shader).
 * The input options (-ss/-t / -loop 1 -t) read exactly the overlap window
 * with 0-based timestamps; setpts moves the frames to [a, b] so the overlay
 * filter's framesync and the enable='between(t,a,b)' window agree (without
 * it an overlay starting mid-clip composites at the wrong times and the
 * stream EOFs a seconds too early — real-ffmpeg verified).
 */
function hexLuma(hex) {
  // BT.601 luma of a #rrggbb color, 0..1 (ffmpeg lumakey threshold).
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return 1;
  const v = m[1];
  const r = parseInt(v.slice(0, 2), 16) / 255;
  const g = parseInt(v.slice(2, 4), 16) / 255;
  const b = parseInt(v.slice(4, 6), 16) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function buildOverlayChain(o) {
  const chroma = o && o.chroma ? o.chroma : null;
  const parts = [];
  // v1.4.1: per-overlay FPS normalization — main.js only sets o.fps for a
  // VIDEO overlay whose probed rate EXCEEDS the project rate (e.g. 60 fps
  // PiP over a 30 fps timeline). Un-normalized, the surplus frames force
  // every downstream stage (scale → chromakey → despill → format → the
  // overlay composite itself → encode) to run at the overlay's rate ≈ 2×
  // the work. `fps` FIRST in the chain drops them before anything else
  // runs; near/slower overlays are left untouched (dup frames would only
  // ADD downstream work, and framesync already syncs by timestamp).
  if (o && o.fps) parts.push(`fps=${o.fps}`);
  parts.push(`scale=${o.dw}:${o.dh}`);
  if (chroma) {
    const sim = clampNum(chroma.similarity, 0.01, 0.5, 0.32);
    const blend = clampNum(chroma.blend, 0, 1, 0.08);
    const spill = clampNum(chroma.spill, 0, 1, 0.6);
    if (chroma.mode === "luma") {
      parts.push(`lumakey=${hexLuma(chroma.color).toFixed(3)}:${String(sim)}:${String(blend)}`);
    } else {
      parts.push(`chromakey=${hexToFfmpegColor(chroma.color)}:${String(sim)}:${String(blend)}`);
      parts.push(`despill=type=${chromaDespillType(chroma.color)}:mix=${String(spill)}`);
    }
  }
  parts.push("format=rgba");
  const aSec = Number(o && o.a) || 0;
  parts.push(`setpts=PTS+${aSec.toFixed(3)}/TB`);
  return `[${o.inputIdx}:v]${parts.join(",")}[ovl${o.inputIdx}]`;
}

/**
 * The overlay compositing filter onto the accumulating video label:
 *   [acc][ovlI]overlay=x:y:enable='between(t,a,b)':eof_action=pass:shortest=0[out]
 * a/b are CLIP-LOCAL seconds (the overlay window relative to the clip).
 * accLabel/outLabel arrive as FULL bracketed labels ("[base]", "[o1]").
 * v5.6: when the overlay has a MOTION PATH the static x/y numbers are
 * replaced by the piecewise-linear time expressions from
 * buildMotionOverlayExpr (single-quoted — the filtergraph parser protects
 * the commas/colons inside, same mechanism as enable='between(t,a,b)').
 */
function buildOverlayFilter(o) {
  const a = Number(o.a).toFixed(3);
  const b = Number(o.b).toFixed(3);
  let x = String(o.x);
  let y = String(o.y);
  if (o.xExpr && o.yExpr) {
    x = `'${o.xExpr}'`;
    y = `'${o.yExpr}'`;
  }
  return `${o.accLabel}[ovl${o.inputIdx}]overlay=x=${x}:y=${y}:enable='between(t,${a},${b})':eof_action=pass:shortest=0${o.outLabel}`;
}

// ---------------------------------------------------------------------------
// v5.0 step-2 audio mix graph (clip audio + music + SFX)
// ---------------------------------------------------------------------------

/** The aformat guard every amix input gets (uniform 48 kHz stereo). */
const AFORMAT = "aformat=sample_rates=48000:channel_layouts=stereo";

/**
 * Step-2 audio graph when v5 clip audio participates (video-with-audio
 * sources and/or SFX exist):
 *   [0:a]aformat[ca]; [music] loudnorm?/afade?/afade? aformat [ma];
 *   [k:a]volume=V,adelay=ms|ms,aformat[sK];
 *   [ca][ma][sK…]amix=inputs=N:duration=longest:normalize=0[mix];
 *   [mix]apad=whole_dur=<totalSec>[aout]
 * Music keeps the v4.9 post-processing settings (loudnorm / fades) on its
 * own branch; apad pads the mix to the full video length so -shortest can
 * never truncate the video. With a single branch the amix stage is skipped.
 */
function buildAudioMixGraph(o) {
  const totalSec = Number(o && o.totalSec) || 0;
  const audio = (o && o.audio) || {};
  const branches = [];

  // v5.2: clip audio now arrives as PRE-EXTRACTED WAV inputs (48 kHz stereo
  // PCM, speed already applied by the extraction command) — one branch per
  // clip, volume + absolute-timeline adelay. This replaces the v5.0/5.1
  // scheme (per-clip AAC encodes + a concat-demuxer [0:a] branch) which
  // double-encoded audio and padded image clips with synthesized silence.
  // v1.2: with normalize ON each clip branch opens with the MEASURED 2-pass
  // loudnorm (static linear gain → every source lands at −16 LUFS before
  // the user's volume rides on top). Measurement must see the RAW wav —
  // loudnorm runs BEFORE volume/adelay.
  const loudnorm = (o && o.loudnorm) || null;
  const clipAudio = Array.isArray(o && o.clipAudio) ? o.clipAudio : [];
  clipAudio.forEach((c, k) => {
    const vol = clampNum(c && c.volume, 0, 2, 1);
    const d = Math.max(0, Math.round(Number(c && c.startMs) || 0));
    const label = `[ca${k}]`;
    const parts = [];
    // v6 SINGLE-PASS: clip-audio branches can reference the BASE VIDEO inputs'
    // own [i:a] streams — playback speed retiming (atempo) then rides the
    // branch head exactly where the two-step's WAV extraction applied it.
    // Absent (the two-step path) → argv byte-identical to v5.2.
    const tempo = Array.isArray(c && c.atempo) ? c.atempo.filter(Boolean) : [];
    if (tempo.length > 0) parts.push(tempo.join(","));
    if (audio.normalize) {
      const ln = measuredLoudnormFilter(loudnorm && Array.isArray(loudnorm.clip) ? loudnorm.clip[k] : null);
      if (ln) parts.push(ln);
    }
    if (vol !== 1) parts.push(`volume=${String(vol)}`);
    if (d > 0) parts.push(`adelay=${d}|${d}`);
    parts.push(AFORMAT);
    branches.push({ label, chain: `[${c.inputIdx}:a]${parts.join(",")}${label}` });
  });

  if (o && o.hasMusic) {
    // v5.2 music placement: [volume] → [loudnorm] → [fades (music-local)]
    // → [adelay=startMs] → aformat. adelay comes LAST so loudnorm/fades
    // measure the music itself, not the leading silence; the fade-out end
    // aligns with the VIDEO end (stream-local st = totalSec - start - dur).
    // v1.2 2-PASS: the order is now [loudnorm(measured)] → [volume] → … —
    // the MEASURED gain must act on the same signal that was measured (the
    // raw file). This also fixes a v5.2 quirk: volume-before-DYNAMIC-loudnorm
    // let the normalizer undo the user's volume knob; normalize-first means
    // the knob scales the NORMALIZED track (the DAW-standard order).
    const m = [];
    if (audio.normalize) {
      m.push(measuredLoudnormFilter(loudnorm && loudnorm.music) || "loudnorm=I=-16:TP=-1.5:LRA=11");
    }
    const musicVol = clampNum(audio.musicVolume, 0, 2, 1);
    if (musicVol !== 1) m.push(`volume=${String(musicVol)}`);
    const startMs = Math.max(0, Math.round(Number(audio.musicStartMs) || 0));
    if (audio.fadeInMs > 0) {
      m.push(`afade=t=in:st=0:d=${(audio.fadeInMs / 1000).toFixed(3)}`);
    }
    if (audio.fadeOutMs > 0) {
      // Stream-local (music) time: audible span is [start, totalSec] on the
      // video timeline; the fade must END at the video end.
      const start = Math.max(0, totalSec - startMs / 1000 - audio.fadeOutMs / 1000);
      m.push(`afade=t=out:st=${start.toFixed(3)}:d=${(audio.fadeOutMs / 1000).toFixed(3)}`);
    }
    if (startMs > 0) m.push(`adelay=${startMs}|${startMs}`);
    m.push(AFORMAT);
    const musicIdx = Number.isFinite(o.musicInputIdx) ? o.musicInputIdx : 1;
    branches.push({ label: "[ma]", chain: `[${musicIdx}:a]${m.join(",")}[ma]` });
  }
  const sfx = Array.isArray(o && o.sfx) ? o.sfx : [];
  sfx.forEach((s, k) => {
    const vol = clampNum(s && s.volume, 0, 1, 1);
    const d = Math.max(0, Math.round(Number(s && s.startMs) || 0));
    const label = `[s${k}]`;
    branches.push({
      label,
      chain: `[${s.inputIdx}:a]volume=${String(vol)},adelay=${d}|${d},${AFORMAT}${label}`,
    });
  });

  const parts = branches.map((b) => b.chain);
  let last;
  if (branches.length <= 1) {
    last = branches.length === 1 ? branches[0].label : "[ca]";
    if (branches.length === 0) {
      // Degenerate: no inputs at all — emit the (unused) passthrough.
      parts.push(`[0:a]${AFORMAT}[ca]`);
      last = "[ca]";
    }
    // v5.2: even a single branch can exceed 0 dBFS after a volume boost —
    // the master limiter below guards it.
  } else {
    parts.push(
      `${branches.map((b) => b.label).join("")}amix=inputs=${branches.length}:duration=longest:normalize=0[mix]`,
    );
    last = "[mix]";
  }
  // v1.3 MASTER VOLUME: one gain on the summed mix (after every per-source
  // volume, before the limiter). rawMix mode (the master-bus loudnorm
  // pre-render) stops here — the limiter + pad move to the final mux -af.
  const masterVol = clampNum(audio.masterVolume, 0, 2, 1);
  const masterChain = masterVol !== 1 ? `volume=${String(masterVol)},` : "";
  if (o && o.rawMix) {
    parts.push(`${last}${masterChain}aformat=sample_rates=48000:channel_layouts=stereo[aout]`);
    return { graph: parts.join(";"), outLabel: "[aout]" };
  }
  // v5.2 master bus: amix with normalize=0 lets branches SUM above 0 dBFS
  // (music + clip + SFX) — a limiter right before the pad keeps int16 output
  // from hard-clipping (the standard master-chain practice in Shotcut et al).
  // v6: an ESTIMATED master loudnorm (energy-sum of the per-branch measured
  // levels — see estimateMixLoudnorm) rides between master volume and the
  // limiter, replacing the v1.3 render-mix-to-WAV-remeasure round trip.
  const masterLn = (o && o.masterLoudnorm) || null;
  parts.push(
    `${last}${masterChain}${masterLn ? `${masterLn},` : ""}` +
      `alimiter=limit=0.97:level=false,apad=whole_dur=${totalSec.toFixed(3)}[aout]`,
  );
  return { graph: parts.join(";"), outLabel: "[aout]" };
}

/**
 * v6 AUDIO BUS: estimate the summed mix's loudnorm measurement WITHOUT
 * rendering it — the loudness of a sum of uncorrelated sources is the
 * energy sum of their loudnesses (10·log10(Σ 10^(I_k/10))). Each branch's
 * effective level = its measured I (already landed at −16 by the per-branch
 * measured gain) + the branch volume in dB; the master volume scales the
 * whole sum. Branches are weighted by their ACTIVE fraction of the timeline
 * (integrated loudness is a time-average). TP is estimated conservatively
 * (hottest branch + 3 dB sum headroom) so linear-mode gain never under-
 * protects peaks. Returns a measured-loudnorm filter string (linear=true,
 * static gain) or null when no branch has a usable measurement (the graph
 * then keeps the v1.2 per-branch-only shape).
 */
function estimateMixLoudnorm(o) {
  const totalSec = Number(o && o.totalSec) || 0;
  if (totalSec <= 0) return null;
  const audio = (o && o.audio) || {};
  const masterVol = clampNum(audio.masterVolume, 0, 2, 1);
  if (masterVol <= 0.001) return null; // silent master — nothing to normalize
  let energy = 0;
  let anyMeasured = false;
  let maxTp = -99;
  let maxLra = 0;
  let measuredBranches = 0;
  const addBranch = (m, vol, activeSec) => {
    const v = clampNum(vol, 0, 2, 1);
    const frac = Math.max(0, Math.min(1, activeSec / totalSec));
    if (frac <= 0 || v <= 0.001) return;
    if (m && Number.isFinite(m.i) && m.i > -70 && Number.isFinite(m.lra)
        && Number.isFinite(m.tp) && Number.isFinite(m.thresh)) {
      anyMeasured = true;
      measuredBranches += 1;
      // Post per-branch-gain level: the v1.2 measured gain lands the SOURCE
      // at −16; the volume knob rides on top.
      const levelDb = -16 + 20 * Math.log10(Math.max(0.001, v));
      energy += frac * Math.pow(10, levelDb / 10);
      if (Number.isFinite(m.tp)) maxTp = Math.max(maxTp, m.tp + 20 * Math.log10(Math.max(0.001, v)));
      if (Number.isFinite(m.lra)) maxLra = Math.max(maxLra, m.lra);
    } else {
      // Unmeasured branch keeps its natural level — assume at-target
      // contribution so it is not ignored in the energy sum.
      energy += frac * Math.pow(10, (-16 + 20 * Math.log10(Math.max(0.001, v))) / 10);
    }
  };
  const clipAudio = Array.isArray(o && o.clipAudio) ? o.clipAudio : [];
  clipAudio.forEach((c) => {
    addBranch(c && c.measure, c && c.volume, (Number(c && c.durationMs) || 0) / 1000);
  });
  if (o && o.music) addBranch(o.music, audio.musicVolume, totalSec);
  // The SFX are deliberately NOT normalized (synthesized at designed
  // levels) — excluded from the estimate, exactly as the v1.2/v1.3 buses.
  if (!anyMeasured || measuredBranches < 2) return null; // single branch is already at −16
  const mixI = 10 * Math.log10(Math.max(1e-12, energy)) + 20 * Math.log10(Math.max(0.001, masterVol));
  if (!Number.isFinite(mixI) || mixI <= -70 || mixI >= 0) return null;
  const estTp = (maxTp > -99 ? maxTp : -1.5) + 3;
  const estLra = maxLra > 0 ? maxLra : 11;
  return (
    `loudnorm=I=-16:TP=-1.5:LRA=11` +
    `:measured_I=${mixI.toFixed(2)}:measured_LRA=${Math.min(20, estLra).toFixed(2)}` +
    `:measured_TP=${Math.min(-0.5, estTp).toFixed(2)}:measured_thresh=-70:linear=true`
  );
}

/**
 * v1.3 MASTER-BUS RENDER: argv that renders the mixed audio (per-source
 * normalize + volumes + adelay + amix + master volume) to a temp WAV — the
 * first half of the master-bus loudnorm path. main.js then MEASURES this
 * WAV and muxes it with the measured master gain (see buildConcatArgs'
 * masterMix mode). Inputs: music (with loop flags) + clip WAVs + SFX WAVs,
 * in that order — indexes are assigned here, 0-based.
 * totalSec (the ACTUAL concat length) is passed through to the graph for the
 * music fade-out alignment AND used as the output -t cap — the looped music
 * input is infinite (amix duration=longest + no video stream here), so the
 * render MUST be bounded or it would never terminate.
 */
function buildAudioMixRenderArgs(o) {
  const audio = (o && o.audio) || {};
  const totalSec = Number(o && o.totalSec) || 0;
  const clipAudio = Array.isArray(o && o.clipAudio)
    ? o.clipAudio.filter((c) => c && typeof c.wavPath === "string" && c.wavPath)
    : [];
  const sfxList = Array.isArray(o && o.sfx) ? o.sfx.filter((s) => s && typeof s.wavPath === "string" && s.wavPath) : [];
  const hasMusic = !!o.audioPath;
  const loopMusic = hasMusic && !!(audio.musicLoop);
  const args = [];
  let idx = 0;
  if (hasMusic) {
    if (loopMusic) args.push("-stream_loop", "-1");
    args.push("-i", o.audioPath);
    idx = 1;
  }
  const musicIdx = hasMusic ? 0 : -1;
  const clipBase = idx;
  clipAudio.forEach((c) => { args.push("-i", c.wavPath); idx += 1; });
  const sfxBase = idx;
  sfxList.forEach((s) => { args.push("-i", s.wavPath); idx += 1; });

  const { graph } = buildAudioMixGraph({
    totalSec,
    audio,
    clipAudio: clipAudio.map((c, k) => ({
      inputIdx: clipBase + k,
      startMs: c.startMs,
      volume: c.volume,
    })),
    hasMusic,
    musicInputIdx: musicIdx,
    loudnorm: o.loudnorm,
    rawMix: true,
    sfx: sfxList.map((s, k) => ({ inputIdx: sfxBase + k, startMs: s.startMs, volume: s.volume })),
  });
  args.push(
    "-filter_complex", graph,
    "-map", "[aout]",
    "-c:a", "pcm_s16le", "-ar", "48000",
    "-t", totalSec.toFixed(3),
    "-y", o.mixWavPath,
  );
  return args;
}

// ---------------------------------------------------------------------------
// buildClipArgs — the FULL per-clip argv (v4.9 verbatim + v5 extensions)
// ---------------------------------------------------------------------------

/**
 * Build the complete ffmpeg argv for one step-1 clip. The v4.9 branches
 * (xfade head / watermark graph / plain -vf) reproduce the pre-v5 main.js
 * output BYTE-IDENTICALLY whenever the v5 ctx fields are at their defaults
 * (anyAudio=false, overlaySpecs=[], no mediaType "video") — the harness
 * snapshots literal argv strings and a differential test replays the git
 * HEAD main.js for the same opts.
 *
 * ctx = {
 *   i, seg, segments,           // seg: v4.9/v5 payload segment
 *   fps, width, height,
 *   kbEnabled, zoomMax, globalDir,   // resolved Ken Burns config
 *   transition,                 // raw { style, durationMs, fadeStartEnd, overrides } | null
 *   wm,                         // normalized watermark {imagePath,x,y,w,h,opacity} | null
 *   assSuffix,                  // "subtitles=filename='…'" | null (built by main.js)
 *   clipPath, encArgs,          // encoderArgs(...) result
 *   // v5 (all optional):
 *   anyAudio,                   // project needs an audio track on EVERY clip
 *   segHasAudio,                // this clip's video source carries audio
 *   overlaySpecs,               // [{ inputArgs, x, y, dw, dh, chroma, a, b }] for this clip
 *   hwaccel,                    // v5.1: base video inputs get -hwaccel auto
 * }
 */
function buildClipArgs(ctx) {
  const {
    i, seg, segments, fps, width, height,
    kbEnabled, zoomMax, globalDir,
    transition, wm, assSuffix, clipPath, encArgs,
    anyAudio, segHasAudio, overlaySpecs, hwaccel,
    // v7 Step 1: encoder-level ffmpeg GLOBAL options (Intel QSV's
    // d3d11va→qsv device derivation) — prepended BEFORE every input arg so
    // `-init_hw_device` sits at the argv head. Absent → byte-identical argv.
    globalArgs,
    // v5.2: per-process encoder thread budget (0 = auto/legacy). The main
    // process divides the cores across the parallel pool so concurrent
    // encoders never oversubscribe the CPU.
    threads,
    // v1.4.2 CHUNKED PARALLEL ENCODE: { offsetMs, durMs, first, last } for
    // ONE chunk of a long re-encode video clip (video branch ONLY — image
    // clips keep whole-clip zoompan frame indexing). null/undefined = the
    // legacy whole-clip behavior, byte-identical argv.
    chunk,
  } = ctx;
  const globals = Array.isArray(globalArgs) && globalArgs.length > 0 ? globalArgs : [];

  const overlays = Array.isArray(overlaySpecs) ? overlaySpecs : [];
  const isVideo = !!(seg && seg.mediaType === "video" && seg.videoPath);
  const vol = normalizeVolume(seg && seg.volume);
  // v1.4.2: chunk context — only honored for VIDEO clips (defensive guard:
  // a chunk on an image/xfade clip is ignored, keeping those argv shapes
  // legacy-exact).
  const ch = chunk && isVideo ? chunk : null;
  const effDurSec = ch ? ch.durMs / 1000 : seg.durationMs / 1000;
  const fadeAtStart = !ch || ch.first;
  const fadeAtEnd = !ch || ch.last;

  // ── v4.3 transition planning (mirrors renderer.ts formulas exactly;
  //    v4.5 per-boundary overrides — the style at the boundary ENTERING
  //    segments[i] is transition.overrides[segments[i].id] ?? global).
  //    v1.1: extracted into planBoundaryFades (verbatim math — see harness).
  const plan = planBoundaryFades(i, seg, segments, transition);
  const curStyle = plan.curStyle;
  const nextStyle = plan.nextStyle;
  const xfadeName = plan.xfadeName;
  const dipColor = plan.dipColor;
  const headMs = plan.headMs;
  const dipTailMs = plan.dipTailMs;
  const startFadeMs = plan.startFadeMs;
  const endFadeMs = plan.endFadeMs;
  const fadeStartEnd = plan.fadeStartEnd;

  // ── Build zoompan expressions — EXACT canvas parity (images only; video
  //    clips never get Ken Burns — their own motion is the content).
  //    v6: the expression math lives in kenBurnsZoompanExprs (shared with the
  //    single-pass builder) — outputs are byte-identical to the inline v4.9
  //    code (harness snapshot-diff).
  const segDurSec = seg.durationMs / 1000;
  const segFrames = Math.max(2, Math.round(segDurSec * fps));
  const enabled = kbEnabled;
  const dir = enabled ? seg.direction || globalDir : "none";
  const isLast = i === segments.length - 1;

  const { zExpr, xExpr, yExpr } = kenBurnsZoompanExprs({
    segFrames, kbEnabled: enabled, dir, zoomMax,
  });

  const scaleW = Math.round(width * 1.1);
  const scaleH = Math.round(height * 1.1);

  // Post-subtitle fades (applied AFTER captions like a real video — matches
  // the canvas applyGlobalFade pass): dips + start/end fades. v4.5: the TAIL
  // dip color comes from the NEXT boundary's style.
  // v1.4.2 CHUNKING: head/start fades exist only on the FIRST chunk and
  // tail fades only on the LAST chunk (a mid-chunk fade would flash); tail
  // fade `st` is chunk-local (ends at the last chunk's end = clip end).
  // No chunk → all four, exactly as before (byte-identical argv).
  const postFades = [];
  if (dipColor && headMs > 0 && fadeAtStart) {
    postFades.push(`fade=t=in:st=0:d=${(headMs / 1000).toFixed(3)}:color=${dipColor}`);
  }
  if (dipTailMs > 0 && fadeAtEnd) {
    const tailColor = DIP_COLORS[nextStyle] || "black";
    postFades.push(
      `fade=t=out:st=${(effDurSec - dipTailMs / 1000).toFixed(3)}:d=${(dipTailMs / 1000).toFixed(3)}:color=${tailColor}`,
    );
  }
  if (startFadeMs > 0 && fadeAtStart) {
    postFades.push(`fade=t=in:st=0:d=${(startFadeMs / 1000).toFixed(3)}`);
  }
  if (endFadeMs > 0 && fadeAtEnd) {
    postFades.push(
      `fade=t=out:st=${(effDurSec - endFadeMs / 1000).toFixed(3)}:d=${(endFadeMs / 1000).toFixed(3)}`,
    );
  }

  // v5 audio codec tail (only when the project needs a track on every clip).
  // -shortest only when a FINITE video stream is paired with generated
  // silence (anullsrc) — a video shorter than its window must never leave
  // audio running past the frames (concat drift).
  const needShortest = !!(anyAudio && isVideo && !segHasAudio);
  const encodeTail = [
    ...encArgs,
    "-r", String(fps),
    ...(anyAudio ? ["-c:a", "aac", "-b:a", "192k", "-ar", "48000"] : []),
    ...(needShortest ? ["-shortest"] : []),
    "-threads", String(Number.isFinite(threads) && threads > 0 ? Math.round(threads) : 0),
    "-y",
    clipPath,
  ];

  // v4.4 watermark helpers (verbatim).
  const wmChain = (inputIdx) =>
    `[${inputIdx}:v]scale=${wm.w}:${wm.h}:flags=bilinear,setsar=1,format=rgba,colorchannelmixer=aa=${wm.opacity}[wmx]`;
  const wmOverlay = (baseLabel, outLabel) =>
    `${baseLabel}[wmx]overlay=${wm.x}:${wm.y}:eof_action=repeat${outLabel}`;

  // v4.4: post-graph chain = [watermark overlay →] subtitles → fades.
  const post = [assSuffix, ...postFades].filter(Boolean).join(",");

  // v5.0 VIDEO RULE mirror: an xfade-family head is a hard cut when EITHER
  // side of the boundary is a VIDEO segment (renderer.transitionHeadMs
  // returns 0 for exactly these — dips are unaffected).
  const useXfadeHead = !!(xfadeName && i > 0 && headMs > 0 && !videoAtBoundaryMirror(segments, i));

  // Shared v5 overlay-graph stitcher: appends the overlay chains + compositing
  // filters onto (graph, label) and pushes their input args.
  function applyOverlays(state) {
    for (const ov of overlays) {
      const oi = state.inputIdx;
      state.graph += `;${buildOverlayChain({ inputIdx: oi, dw: ov.dw, dh: ov.dh, chroma: ov.chroma, a: ov.a, fps: ov.fps })}`;
      const out = `[o${oi}]`;
      state.graph += `;${buildOverlayFilter({ accLabel: state.label, inputIdx: oi, x: ov.x, y: ov.y, a: ov.a, b: ov.b, outLabel: out })}`;
      state.label = out;
      state.inputIdx += 1;
      state.inputs.push(...ov.inputArgs);
    }
    return state;
  }

  if (useXfadeHead) {
    // ── v4.3 xfade HEAD composite (dissolve / slide / wipe) — v4.9 verbatim
    //    core; video boundaries can never reach here (hard cut above).
    const F = (headMs / 1000).toFixed(3);
    const prevSeg = segments[i - 1];
    const prevDir = enabled ? prevSeg.direction || globalDir : "none";
    const frz = frozenZoompanExpr(prevDir, zoomMax);
    const pre = `scale=${scaleW}:${scaleH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${scaleW}:${scaleH}`;
    const zpCommon = `d=${segFrames}:s=${width}x${height}:fps=${fps}`;
    const aChain =
      `[1:v]${pre},zoompan=z='${frz.z}':x='${frz.x}':y='${frz.y}':${zpCommon},setsar=1,format=yuv420p[a]`;
    const bChain =
      `[0:v]${pre},zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':${zpCommon},setsar=1,format=yuv420p[b]`;
    const state = applyOverlays({
      graph: `${aChain};${bChain};[a][b]xfade=transition=${xfadeName}:duration=${F}:offset=0[vx]`,
      label: "[vx]",
      inputIdx: 2,
      inputs: ["-loop", "1", "-i", seg.imagePath, "-loop", "1", "-i", prevSeg.imagePath],
    });
    // Watermark (next input index) under the captions.
    if (wm) {
      state.graph += `;${wmChain(state.inputIdx)};${wmOverlay(state.label, "[vw]")}`;
      state.label = "[vw]";
      state.inputs.push("-i", wm.imagePath);
      state.inputIdx += 1;
    }
    if (post) state.graph += `;${state.label}${post}[vout]`;
    const outLabel = post ? "[vout]" : state.label;
    const audioMaps = [];
    if (anyAudio) {
      // images only in this branch → generated silence track
      state.inputs.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
      audioMaps.push("-map", `${state.inputIdx}:a`);
      state.inputIdx += 1;
    }
    return {
      args: [
        ...globals,
        ...state.inputs,
        "-t", segDurSec.toFixed(3),
        "-filter_complex", state.graph,
        "-map", outLabel,
        ...audioMaps,
        ...encodeTail,
      ],
      graph: state.graph,
    };
  }

  if (isVideo) {
    // ── v5 VIDEO clip: cover-fit chain (no zoompan) + overlays + audio ──
    // Inputs: [0] = trimmed video source, [1..K] = overlays, then the
    // generated-silence input (when the clip has no audio of its own),
    // then the watermark image — indices assigned in push order.
    //
    // v1.4.2 CHUNKED: a chunk seeks to trimIn + offsetMs×speed (chunk
    // offsets are TIMELINE ms; the source window is timeline × speed) and
    // encodes only the chunk's duration; the µs-precision ssSec keeps the
    // boundary EXACTLY on the frame grid (see planChunkFrames).
    //
    // v5.1 SPEED: base-lane video clips with speed ≠ 1 —
    //   • input gains `-t <sourceWindow>` (durationMs·speed = the source
    //     window setpts will retime onto durationMs),
    //   • filter chain gains `setpts=PTS/speed` after the cover-fit chain,
    //   • own-audio path gains the atempo chain (0.5–2 per stage, chained
    //     when speed sits outside that window),
    //   • output `-t` stays the TIMELINE duration (seg.durationMs already
    //     resolves window/speed in timeline.ts).
    // speed 1/undefined → every one of these is a no-op (byte-identical argv
    // with pre-v5.1 builds — the harness differentials prove it).
    const speed = resolveSegSpeed(seg);
    const effDurMs = ch ? ch.durMs : Math.max(0, Number(seg.durationMs) || 0);
    const sourceWinMs = speed !== 1 ? effDurMs * speed : 0;
    const ssMs = (Number(seg.trimInMs) || 0) + (ch ? ch.offsetMs * speed : 0);
    const inputs = [
      ...buildVideoInputArgs({
        trimInMs: ssMs,
        ssSec: ch ? (ssMs / 1000).toFixed(6) : undefined,
        path: seg.videoPath,
        hwaccel,
        durMs: speed !== 1 ? sourceWinMs : undefined,
      }),
    ];
    let inputIdx = 1;
    for (const ov of overlays) {
      inputs.push(...ov.inputArgs);
      inputIdx += 1;
    }
    const videoChain = buildVideoFilterChain({ width, height, fps, speed });
    const tempo = atempoFilters(speed);
    const audioMaps = [];
    let audioGraph = null;
    if (anyAudio) {
      if (segHasAudio) {
        // the clip's OWN audio: per-segment volume [+ atempo] + uniform format
        audioGraph = `[0:a]${["volume=" + String(vol), ...tempo, AFORMAT].join(",")}[aclip]`;
        audioMaps.push("-map", "[aclip]");
      } else {
        inputs.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
        audioMaps.push("-map", `${inputIdx}:a`);
        inputIdx += 1;
      }
    }
    if (overlays.length > 0 || wm) {
      // Complex graph path: base chain → overlays → watermark → post.
      let g = `[0:v]${videoChain}[base]`;
      let label = "[base]";
      let oi = 1;
      for (const ov of overlays) {
        g += `;${buildOverlayChain({ inputIdx: oi, dw: ov.dw, dh: ov.dh, chroma: ov.chroma, a: ov.a, fps: ov.fps })}`;
        const out = `[o${oi}]`;
        g += `;${buildOverlayFilter({ accLabel: label, inputIdx: oi, x: ov.x, y: ov.y, a: ov.a, b: ov.b, outLabel: out })}`;
        label = out;
        oi += 1;
      }
      if (wm) {
        g += `;${wmChain(inputIdx)};${wmOverlay(label, "[vw]")}`;
        label = "[vw]";
        inputs.push("-i", wm.imagePath);
        inputIdx += 1;
      }
      if (post) g += `;${label}${post}[vout]`;
      const outLabel = post ? "[vout]" : label;
      if (audioGraph) g += `;${audioGraph}`;
      return {
        args: [
          ...globals,
          ...inputs,
          "-t", effDurSec.toFixed(3),
          "-filter_complex", g,
          "-map", outLabel,
          ...audioMaps,
          ...encodeTail,
        ],
        graph: g,
      };
    }
    // Plain video path — mirrors the v4.9 single-input -vf layout.
    const vfParts = [videoChain];
    if (assSuffix) vfParts.push(assSuffix);
    vfParts.push(...postFades);
    const args = [
      ...globals,
      ...inputs,
      "-t", effDurSec.toFixed(3),
      "-vf", vfParts.join(","),
    ];
    if (anyAudio) {
      if (segHasAudio) {
        args.push("-map", "0:v", "-map", "0:a", "-af", ["volume=" + String(vol), ...tempo, AFORMAT].join(","));
      } else {
        args.push("-map", "0:v", "-map", "1:a");
      }
    }
    return { args: [...args, ...encodeTail], graph: null };
  }

  if (wm || overlays.length > 0) {
    // ── v4.4 single-input + watermark → filter_complex — v4.9 verbatim
    //    core, extended with v5 overlays between base and watermark ──
    //
    // v5.2 SPEED: static frames (Ken Burns off) skip the 1.1× lanczos
    // supersample + per-frame zoompan entirely — a plain bilinear-ish
    // cover-fit at the OUTPUT resolution is byte-equivalent visually and
    // an order of magnitude faster (zoompan is single-threaded and was the
    // dominant cost for slideshows).
    const staticImg = !enabled || dir === "none";
    const baseChain = staticImg
      ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${fps},setsar=1,format=yuv420p`
      : `scale=${scaleW}:${scaleH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${scaleW}:${scaleH},` +
        `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=${segFrames}:s=${width}x${height}:fps=${fps},setsar=1,format=yuv420p`;
    const baseInputs = staticImg
      ? ["-loop", "1", "-framerate", String(fps), "-i", seg.imagePath]
      : ["-loop", "1", "-i", seg.imagePath];
    const state = applyOverlays({
      graph: `[0:v]${baseChain}[base]`,
      label: "[base]",
      inputIdx: 1,
      inputs: baseInputs,
    });
    if (wm) {
      state.graph += `;${wmChain(state.inputIdx)};${wmOverlay(state.label, "[vw]")}`;
      state.label = "[vw]";
      state.inputs.push("-i", wm.imagePath);
      state.inputIdx += 1;
    }
    if (post) state.graph += `;${state.label}${post}[vout]`;
    const audioMaps = [];
    if (anyAudio) {
      state.inputs.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
      audioMaps.push("-map", `${state.inputIdx}:a`);
      state.inputIdx += 1;
    }
    return {
      args: [
        ...state.inputs,
        "-t", segDurSec.toFixed(3),
        "-filter_complex", state.graph,
        "-map", post ? "[vout]" : state.label,
        ...audioMaps,
        ...encodeTail,
      ],
      graph: state.graph,
    };
  }

  // ── Plain single-input path (no watermark) — v4.9 verbatim ──
  // v5.2 SPEED: static frames (Ken Burns off — the new default) skip the
  // supersample + zoompan pipeline for a plain cover-fit scale/crop.
  const staticImg = !enabled || dir === "none";
  const vfParts = staticImg
    ? [
        `scale=${width}:${height}:force_original_aspect_ratio=increase`,
        `crop=${width}:${height}`,
        `fps=${fps}`,
        `setsar=1`,
        `format=yuv420p`,
      ]
    : [
        `scale=${scaleW}:${scaleH}:force_original_aspect_ratio=increase:flags=lanczos`,
        `crop=${scaleW}:${scaleH}`,
        `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=${segFrames}:s=${width}x${height}:fps=${fps}`,
        `setsar=1`,
        `format=yuv420p`,
      ];
  const imgInputOpts = staticImg
    ? ["-loop", "1", "-framerate", String(fps), "-i", seg.imagePath]
    : ["-loop", "1", "-i", seg.imagePath];
  if (assSuffix) vfParts.push(assSuffix);
  vfParts.push(...postFades);
  if (anyAudio) {
    return {
      args: [
        ...imgInputOpts,
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
        "-t", segDurSec.toFixed(3),
        "-vf", vfParts.join(","),
        "-map", "0:v", "-map", "1:a",
        ...encodeTail,
      ],
      graph: null,
    };
  }
  return {
    args: [
      ...imgInputOpts,
      "-t", segDurSec.toFixed(3),
      "-vf", vfParts.join(","),
      ...encodeTail,
    ],
    graph: null,
  };
}

// ---------------------------------------------------------------------------
// buildConcatArgs — step-2 concat/mux argv (v4.9 verbatim + v5 audio)
// ---------------------------------------------------------------------------

/**
 * Step-2 argv. v4.9 modes are BYTE-IDENTICAL to the pre-v5 main.js:
 *   - no audio at all   → concat -c copy only
 *   - music only        → -af loudnorm/fades/apad + aac 48k + -shortest
 * v5 mode (newAudioGraph — video-with-audio and/or SFX present):
 *   - clip audio + music + SFX → amix graph, -map 0:v -map [aout]
 *   - clip audio only           → -map 0:v -map 0:a re-encode
 * v1.3 masterMix mode (normalize ON with ≥2 branches): the mix was
 * pre-rendered to a WAV and MEASURED — mux that single input with the
 * measured master loudnorm instead of re-running the whole graph.
 * sfx items: [{ wavPath, startMs, volume }] (already uploaded WAVs).
 */
function buildConcatArgs(o) {
  const sfxList = Array.isArray(o.sfx) ? o.sfx.filter((s) => s && typeof s.wavPath === "string" && s.wavPath) : [];
  const clipAudio = Array.isArray(o.clipAudio)
    ? o.clipAudio.filter((c) => c && typeof c.wavPath === "string" && c.wavPath)
    : [];
  const hasMusic = !!o.audioPath;
  // v1.2: export audio bitrate ladder (invalid/omitted → 192 = v1.1).
  const abr = [96, 128, 192, 256, 320].includes(Number(o.audioKbps))
    ? `${Number(o.audioKbps)}k`
    : "192k";
  // v1.3 MASTER-BUS path: the pre-rendered + measured mix replaces every
  // audio input and the whole graph — one WAV in, measured master loudnorm
  // + limiter + pad out. (Nothing before this point added audio inputs yet.)
  if (o.masterMix && o.masterMix.wavPath) {
    const mm = o.masterMix;
    const af = [];
    const ln = measuredLoudnormFilter(mm.loudnorm || null);
    if (ln) af.push(ln);
    af.push("alimiter=limit=0.97:level=false");
    af.push(`apad=whole_dur=${Number(o.totalSec || 0).toFixed(3)}`);
    return [
      "-f", "concat", "-safe", "0", "-i", o.concatListPath,
      "-i", mm.wavPath,
      "-c:v", "copy",
      "-map", "0:v", "-map", "1:a",
      "-af", af.join(","),
      "-c:a", "aac", "-b:a", abr, "-ar", "48000",
      "-shortest",
      "-movflags", "+faststart", "-y", o.outputPath,
    ];
  }
  // v5.2: loop-to-fill — -stream_loop -1 makes the music input infinite;
  // -shortest (video stream) + apad=whole_dur cap the output at the video
  // length, so the track repeats until the video ends.
  const loopMusic = hasMusic && !!(o.audio && o.audio.musicLoop);
  const args = ["-f", "concat", "-safe", "0", "-i", o.concatListPath];
  // Input layout: 0 = concat video (audio-less clips), 1 = music (when
  // present), then the pre-extracted clip-audio WAVs, then the SFX WAVs.
  if (hasMusic) {
    if (loopMusic) args.push("-stream_loop", "-1");
    args.push("-i", o.audioPath);
  }
  const musicIdx = 1;
  const clipBase = hasMusic ? 2 : 1;
  clipAudio.forEach((c) => args.push("-i", c.wavPath));
  const sfxBase = clipBase + clipAudio.length;
  sfxList.forEach((s) => args.push("-i", s.wavPath));
  // ALWAYS -c copy for video (captions already burned in step 1)
  args.push("-c:v", "copy");

  if (o.newAudioGraph) {
    if (hasMusic || clipAudio.length > 0 || sfxList.length > 0) {
      const { graph } = buildAudioMixGraph({
        totalSec: o.totalSec,
        audio: o.audio,
        clipAudio: clipAudio.map((c, k) => ({
          inputIdx: clipBase + k,
          startMs: c.startMs,
          volume: c.volume,
        })),
        hasMusic,
        musicInputIdx: musicIdx,
        loudnorm: o.loudnorm,
        sfx: sfxList.map((s, k) => ({ inputIdx: sfxBase + k, startMs: s.startMs, volume: s.volume })),
      });
      args.push(
        "-filter_complex", graph,
        "-map", "0:v", "-map", "[aout]",
        "-c:a", "aac", "-b:a", abr, "-ar", "48000",
        "-shortest",
      );
    } else {
      // Only clip audio (video-with-audio sources, no music, no SFX).
      args.push(
        "-map", "0:v", "-map", "0:a",
        "-c:a", "aac", "-b:a", abr, "-ar", "48000",
        "-shortest",
      );
    }
  } else if (hasMusic) {
    // Audio chain (v5.2): [volume] → [normalize] → [fade in] → [fade out]
    // → [adelay=startMs] → [pad to video length]. Fades run in MUSIC-local
    // time (before adelay) so loudnorm/fades never measure leading silence;
    // the fade-out END aligns with the video end. apad=whole_dur pads the
    // delayed stream exactly to the video duration so a short track no
    // longer TRUNCATES the video (v4.9 behavior preserved at startMs=0).
    // v1.2 2-PASS: normalize now leads with the MEASURED static gain (the
    // volume knob rides on the normalized track, DAW-standard order).
    const af = [];
    if (o.audio && o.audio.normalize) {
      af.push(
        measuredLoudnormFilter(o.loudnorm && o.loudnorm.music) ||
          "loudnorm=I=-16:TP=-1.5:LRA=11",
      );
    }
    const musicVol = clampNum(o.audio && o.audio.musicVolume, 0, 2, 1);
    if (musicVol !== 1) af.push(`volume=${String(musicVol)}`);
    const startMs = Math.max(0, Math.round(Number(o.audio && o.audio.musicStartMs) || 0));
    if (o.audio && o.audio.fadeInMs > 0) {
      af.push(`afade=t=in:st=0:d=${(o.audio.fadeInMs / 1000).toFixed(3)}`);
    }
    if (o.audio && o.audio.fadeOutMs > 0) {
      const start = Math.max(0, o.totalSec - startMs / 1000 - o.audio.fadeOutMs / 1000);
      af.push(`afade=t=out:st=${start.toFixed(3)}:d=${(o.audio.fadeOutMs / 1000).toFixed(3)}`);
    }
    if (startMs > 0) af.push(`adelay=${startMs}|${startMs}`);
    // v1.3: master volume scales the (delayed) music output too.
    const masterVol = clampNum(o.audio && o.audio.masterVolume, 0, 2, 1);
    if (masterVol !== 1) af.push(`volume=${String(masterVol)}`);
    af.push(`apad=whole_dur=${o.totalSec.toFixed(3)}`);
    // v5.2: guard boosted music against hard clipping.
    af.push("alimiter=limit=0.97:level=false");
    args.push("-af", af.join(","));
    args.push("-c:a", "aac", "-b:a", abr, "-ar", "48000", "-shortest");
  }

  args.push("-movflags", "+faststart", "-y", o.outputPath);
  return args;
}

module.exports = {
  // v4.3/v4.9 transition tables + helpers (moved verbatim from main.js)
  XFADE_NAMES,
  DIP_COLORS,
  TRANSITION_MAX_FRACTION,
  clampTrMs,
  frozenZoompanExpr,
  // v6 single-pass Ken Burns chain (shared expression source)
  kenBurnsZoompanExprs,
  kenBurnsImageChain,
  // v5 renderer.ts mirrors
  overlayGeometryMirror,
  isXfadeStyleMirror,
  videoAtBoundaryMirror,
  // v5.6 motion-path mirrors
  sanitizeMotionMirror,
  buildMotionOverlayExpr,
  // stderr parsers
  videoHasAudioParser,
  videoProbeParser,
  // shared helpers
  fmt3,
  normalizeVolume,
  hexToFfmpegColor,
  hexToRgbParts,
  chromaDespillType,
  // v5.1 speed helpers
  fmtSpeed,
  atempoFilters,
  resolveSegSpeed,
  // v1.1 TURBO export helpers
  planBoundaryFades,
  clipNeedsReEncode,
  buildStreamCopyArgs,
  // v6 smart-turbo sandwich copy
  planSandwichCopy,
  // v1.4.2 chunked parallel encode
  planChunkFrames,
  // base video clip builders
  buildVideoInputArgs,
  buildVideoFilterChain,
  // overlay builders
  overlayWindow,
  buildOverlayVideoInputArgs,
  buildOverlayImageInputArgs,
  buildOverlayChain,
  buildOverlayFilter,
  // step-2 audio graph
  buildAudioMixGraph,
  buildAudioMixRenderArgs,
  measuredLoudnormFilter,
  estimateMixLoudnorm,
  AFORMAT,
  // full argv builders
  buildClipArgs,
  buildConcatArgs,
};
