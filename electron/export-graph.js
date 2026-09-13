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
 * Parse `ffmpeg -i <file>` stderr → { hasAudio, width, height }.
 * width/height are the EFFECTIVE display dims (already swapped for ±90°/
 * ±270° displaymatrix rotation, matching what ffmpeg decodes+autorotates
 * to). width/height stay 0 when no video stream line is found.
 */
function videoProbeParser(stderr) {
  const out = { hasAudio: false, width: 0, height: 0 };
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
  }
  const rot = stderr.match(/displaymatrix:\s*rotation of\s*(-?[\d.]+)/);
  if (rot) {
    const r = Math.abs(parseFloat(rot[1])) % 360;
    if (Math.abs(r - 90) < 0.01 || Math.abs(r - 270) < 0.01) {
      const t = out.width; out.width = out.height; out.height = t;
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
  const ss = fmt3(Math.max(0, Number(o && o.trimInMs) || 0));
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
  };
}

/**
 * Input args for a VIDEO overlay trimmed to the overlap window. Both -ss and
 * -t are INPUT options (they must precede -i to bind to THIS input when
 * further inputs follow): `-ss <ss> -t <overlapDur> -i <path>`.
 */
function buildOverlayVideoInputArgs(o) {
  return ["-ss", fmt3(Math.max(0, Number(o && o.ssMs) || 0)), "-t", fmt3(Math.max(0, Number(o && o.durMs) || 0)), "-i", o && o.path];
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
 * chromakey + despill (settings defensively re-clamped here — main.js is
 * the trust boundary for IPC payloads), format=rgba for the overlay
 * filter's alpha compositing, and a PTS shift onto the CLIP-LOCAL clock:
 *   [i:v]scale=dw:dh[,chromakey=color:sim:blend,despill=type:mix],format=rgba,setpts=PTS+a/TB[ovlI]
 * The input options (-ss/-t / -loop 1 -t) read exactly the overlap window
 * with 0-based timestamps; setpts moves the frames to [a, b] so the overlay
 * filter's framesync and the enable='between(t,a,b)' window agree (without
 * it an overlay starting mid-clip composites at the wrong times and the
 * stream EOFs a seconds too early — real-ffmpeg verified).
 */
function buildOverlayChain(o) {
  const chroma = o && o.chroma ? o.chroma : null;
  const parts = [`scale=${o.dw}:${o.dh}`];
  if (chroma) {
    const sim = clampNum(chroma.similarity, 0.01, 0.5, 0.32);
    const blend = clampNum(chroma.blend, 0, 1, 0.08);
    const spill = clampNum(chroma.spill, 0, 1, 0.6);
    parts.push(`chromakey=${hexToFfmpegColor(chroma.color)}:${String(sim)}:${String(blend)}`);
    parts.push(`despill=type=${chromaDespillType(chroma.color)}:mix=${String(spill)}`);
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
 */
function buildOverlayFilter(o) {
  const a = Number(o.a).toFixed(3);
  const b = Number(o.b).toFixed(3);
  return `${o.accLabel}[ovl${o.inputIdx}]overlay=${o.x}:${o.y}:enable='between(t,${a},${b})':eof_action=pass:shortest=0${o.outLabel}`;
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

  if (o && o.hasClipAudio) {
    branches.push({ label: "[ca]", chain: `[0:a]${AFORMAT}[ca]` });
  }
  if (o && o.hasMusic) {
    const m = [];
    if (audio.normalize) m.push("loudnorm=I=-16:TP=-1.5:LRA=11");
    if (audio.fadeInMs > 0) {
      m.push(`afade=t=in:st=0:d=${(audio.fadeInMs / 1000).toFixed(3)}`);
    }
    if (audio.fadeOutMs > 0) {
      const start = Math.max(0, totalSec - audio.fadeOutMs / 1000);
      m.push(`afade=t=out:st=${start.toFixed(3)}:d=${(audio.fadeOutMs / 1000).toFixed(3)}`);
    }
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
  } else {
    parts.push(
      `${branches.map((b) => b.label).join("")}amix=inputs=${branches.length}:duration=longest:normalize=0[mix]`,
    );
    last = "[mix]";
  }
  parts.push(`${last}apad=whole_dur=${totalSec.toFixed(3)}[aout]`);
  return { graph: parts.join(";"), outLabel: "[aout]" };
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
  } = ctx;

  const overlays = Array.isArray(overlaySpecs) ? overlaySpecs : [];
  const isVideo = !!(seg && seg.mediaType === "video" && seg.videoPath);
  const vol = normalizeVolume(seg && seg.volume);

  // ── v4.3 transition planning (mirrors renderer.ts formulas exactly;
  //    v4.5 per-boundary overrides — the style at the boundary ENTERING
  //    segments[i] is transition.overrides[segments[i].id] ?? global).
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

  const segDurSec = seg.durationMs / 1000;
  const segFrames = Math.max(2, Math.round(segDurSec * fps));
  const enabled = kbEnabled;
  const dir = enabled ? seg.direction || globalDir : "none";
  const isLast = i === segments.length - 1;

  const curStyle = i > 0 ? boundaryStyleAt(seg) : "none";
  const nextStyle = !isLast ? boundaryStyleAt(segments[i + 1]) : "none";
  const xfadeName = XFADE_NAMES[curStyle] || null;
  const dipColor = DIP_COLORS[curStyle] || null;
  const headMs =
    i > 0 && curStyle !== "none" ? clampTrMs(trWanted, seg.durationMs) : 0;
  const dipTailMs =
    DIP_COLORS[nextStyle] && !isLast ? clampTrMs(trWanted, seg.durationMs) : 0;
  const startFadeMs =
    i === 0 && fadeStartEnd ? clampTrMs(trWanted, seg.durationMs) : 0;
  const endFadeMs =
    isLast && fadeStartEnd ? clampTrMs(trWanted, seg.durationMs) : 0;

  // ── Build zoompan expressions — EXACT canvas parity (images only; video
  //    clips never get Ken Burns — their own motion is the content).
  let zExpr, xExpr, yExpr;
  if (!enabled || dir === "none") {
    zExpr = "1.1"; xExpr = "iw/2-(iw/zoom/2)"; yExpr = "ih/2-(ih/zoom/2)";
  } else {
    const tExpr = `on/${Math.max(1, segFrames - 1)}`;
    const easeExpr = `-((cos(PI*${tExpr})-1)/2)`; // easeInOutSine (same as canvas)
    const zBase = 1.1;
    const zMaxEff = (1.1 * zoomMax).toFixed(6);
    const spanEff = (1.1 * zoomMax - 1.1).toFixed(6);
    const maxX = "(iw-iw/zoom)";
    const maxY = "(ih-ih/zoom)";
    if (dir === "in") {
      zExpr = `${zBase.toFixed(6)}+(${easeExpr})*${spanEff}`;
      xExpr = "iw/2-(iw/zoom/2)"; yExpr = "ih/2-(ih/zoom/2)";
    } else if (dir === "out") {
      zExpr = `${zMaxEff}-(${easeExpr})*${spanEff}`;
      xExpr = "iw/2-(iw/zoom/2)"; yExpr = "ih/2-(ih/zoom/2)";
    } else {
      // Pan modes: constant zoom, window slides center → edge.
      zExpr = zMaxEff;
      if (dir === "right") { xExpr = `${maxX}/2*(1+(${easeExpr}))`; yExpr = `${maxY}/2`; }
      else if (dir === "left") { xExpr = `${maxX}/2*(1-(${easeExpr}))`; yExpr = `${maxY}/2`; }
      else if (dir === "down") { xExpr = `${maxX}/2`; yExpr = `${maxY}/2*(1+(${easeExpr}))`; }
      else if (dir === "up") { xExpr = `${maxX}/2`; yExpr = `${maxY}/2*(1-(${easeExpr}))`; }
      else { xExpr = `${maxX}/2`; yExpr = `${maxY}/2`; }
    }
  }

  const scaleW = Math.round(width * 1.1);
  const scaleH = Math.round(height * 1.1);

  // Post-subtitle fades (applied AFTER captions like a real video — matches
  // the canvas applyGlobalFade pass): dips + start/end fades. v4.5: the TAIL
  // dip color comes from the NEXT boundary's style.
  const postFades = [];
  if (dipColor && headMs > 0) {
    postFades.push(`fade=t=in:st=0:d=${(headMs / 1000).toFixed(3)}:color=${dipColor}`);
  }
  if (dipTailMs > 0) {
    const tailColor = DIP_COLORS[nextStyle] || "black";
    postFades.push(
      `fade=t=out:st=${(segDurSec - dipTailMs / 1000).toFixed(3)}:d=${(dipTailMs / 1000).toFixed(3)}:color=${tailColor}`,
    );
  }
  if (startFadeMs > 0) {
    postFades.push(`fade=t=in:st=0:d=${(startFadeMs / 1000).toFixed(3)}`);
  }
  if (endFadeMs > 0) {
    postFades.push(
      `fade=t=out:st=${(segDurSec - endFadeMs / 1000).toFixed(3)}:d=${(endFadeMs / 1000).toFixed(3)}`,
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
    "-threads", "0",
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
      state.graph += `;${buildOverlayChain({ inputIdx: oi, dw: ov.dw, dh: ov.dh, chroma: ov.chroma, a: ov.a })}`;
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
    const sourceWinMs = speed !== 1 ? Math.max(0, Number(seg.durationMs) || 0) * speed : 0;
    const inputs = [
      ...buildVideoInputArgs({
        trimInMs: seg.trimInMs,
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
        g += `;${buildOverlayChain({ inputIdx: oi, dw: ov.dw, dh: ov.dh, chroma: ov.chroma, a: ov.a })}`;
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
          ...inputs,
          "-t", segDurSec.toFixed(3),
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
      ...inputs,
      "-t", segDurSec.toFixed(3),
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
    const state = applyOverlays({
      graph:
        `[0:v]scale=${scaleW}:${scaleH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${scaleW}:${scaleH},` +
        `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=${segFrames}:s=${width}x${height}:fps=${fps},setsar=1,format=yuv420p[base]`,
      label: "[base]",
      inputIdx: 1,
      inputs: ["-loop", "1", "-i", seg.imagePath],
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
  const vfParts = [
    `scale=${scaleW}:${scaleH}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${scaleW}:${scaleH}`,
    `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=${segFrames}:s=${width}x${height}:fps=${fps}`,
    `setsar=1`,
    `format=yuv420p`,
  ];
  if (assSuffix) vfParts.push(assSuffix);
  vfParts.push(...postFades);
  if (anyAudio) {
    return {
      args: [
        "-loop", "1", "-i", seg.imagePath,
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
      "-loop", "1",
      "-i", seg.imagePath,
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
 * sfx items: [{ wavPath, startMs, volume }] (already uploaded WAVs).
 */
function buildConcatArgs(o) {
  const sfxList = Array.isArray(o.sfx) ? o.sfx.filter((s) => s && typeof s.wavPath === "string" && s.wavPath) : [];
  const hasMusic = !!o.audioPath;
  const args = ["-f", "concat", "-safe", "0", "-i", o.concatListPath];
  if (hasMusic) args.push("-i", o.audioPath);
  sfxList.forEach((s) => args.push("-i", s.wavPath));
  // ALWAYS -c copy for video (captions already burned in step 1)
  args.push("-c:v", "copy");

  if (o.newAudioGraph) {
    if (hasMusic || sfxList.length > 0) {
      const sfxBase = hasMusic ? 2 : 1; // 0 = concat demuxer, 1 = music (when present)
      const { graph } = buildAudioMixGraph({
        totalSec: o.totalSec,
        audio: o.audio,
        hasClipAudio: true,
        hasMusic,
        musicInputIdx: 1,
        sfx: sfxList.map((s, k) => ({ inputIdx: sfxBase + k, startMs: s.startMs, volume: s.volume })),
      });
      args.push(
        "-filter_complex", graph,
        "-map", "0:v", "-map", "[aout]",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-shortest",
      );
    } else {
      // Only clip audio (video-with-audio sources, no music, no SFX).
      args.push(
        "-map", "0:v", "-map", "0:a",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-shortest",
      );
    }
  } else if (hasMusic) {
    // Audio chain: [normalize] → [fade in] → [fade out] → [pad to video
    // length]. apad=whole_dur pads with silence exactly to the video
    // duration so a short track no longer TRUNCATES the video (v4.9).
    const af = [];
    if (o.audio && o.audio.normalize) af.push("loudnorm=I=-16:TP=-1.5:LRA=11");
    if (o.audio && o.audio.fadeInMs > 0) {
      af.push(`afade=t=in:st=0:d=${(o.audio.fadeInMs / 1000).toFixed(3)}`);
    }
    if (o.audio && o.audio.fadeOutMs > 0) {
      const start = Math.max(0, o.totalSec - o.audio.fadeOutMs / 1000);
      af.push(`afade=t=out:st=${start.toFixed(3)}:d=${(o.audio.fadeOutMs / 1000).toFixed(3)}`);
    }
    af.push(`apad=whole_dur=${o.totalSec.toFixed(3)}`);
    args.push("-af", af.join(","));
    args.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-shortest");
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
  // v5 renderer.ts mirrors
  overlayGeometryMirror,
  isXfadeStyleMirror,
  videoAtBoundaryMirror,
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
  AFORMAT,
  // full argv builders
  buildClipArgs,
  buildConcatArgs,
};
