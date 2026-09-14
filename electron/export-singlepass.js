// electron/export-singlepass.js — FrameFuse v6 SINGLE-PASS export graph builder.
//
// ONE ffmpeg process renders the WHOLE timeline: every base segment input is
// decoded once, composited through one filter graph (per-segment chains →
// concat filter → overlays → watermark → ONE libass captions burn → global
// fades), and encoded ONCE. The graph is written to a temp file and passed
// via `-filter_complex_script`, which removes the Windows CLI-length limit
// that originally forced the two-step (per-clip encode → concat demuxer)
// design: no N temp clip writes, no N encoder inits, no double aac pass, and
// clip audio mixes from the base inputs' OWN [i:a] streams (no PCM WAV
// extraction round trip).
//
// PARITY CONTRACT (preview == export, and single-pass == two-step):
//   - Ken Burns: zoompan expressions come from the SAME kenBurnsZoompanExprs
//     source buildClipArgs uses (byte-identical chains). The 1-frame image
//     input trick (`-i img`, no -loop) is verified byte-identical to the
//     two-step's `-loop 1 -t` output — scripts/verify-kenburns-parity.js.
//   - xfade heads: image↔image boundaries keep the v4.3 head composite
//     (frozen prev-end zoompan + xfade offset=0); video boundaries stay hard
//     cuts (videoAtBoundaryMirror), exactly like the two-step and preview.
//   - Overlays: overlayGeometryMirror + chroma/despill + motion-path
//     expressions reused VERBATIM with GLOBAL-timeline windows (a/b in
//     global seconds; tOffsetSec = −ovStart/1000 shifts the motion clock).
//   - Fades: dip/bookend fades are applied AFTER the captions burn (the
//     preview's applyGlobalFade order) as `fade=…:enable='between(t,a,b)'`
//     windows on the global stream — verified black only inside the window.
//   - Audio: the same buildAudioMixGraph (per-branch measured loudnorm →
//     volume → adelay → aformat → amix normalize=0 → master volume →
//     [estimated master loudnorm] → limiter → apad) with atempo riding the
//     branch head where the two-step's WAV extraction applied it.
//
// This module is PURE (requires only ./export-graph) so the bun verification
// harness can import it directly.
"use strict";

const G = require("./export-graph");

/** Single-pass eligibility ceilings (the plan's fallback envelope). */
const SINGLEPASS_MAX_SEGMENTS = 70;
const SINGLEPASS_MAX_OVERLAYS = 40;
/** Captioned projects longer than this keep the chunked two-step pool — the
 *  v1.4.2 fix for "one long video with subtitles exports for hours" relies on
 *  chunk parallelism for the single-threaded libass burn. */
const SINGLEPASS_CAPTIONED_MAX_SEC = 600;
/** Fallback threshold applied by main.js AFTER building (bytes of graph). */
const SINGLEPASS_MAX_SCRIPT_BYTES = 25000;

function fmt3(ms) {
  return (Math.max(0, Number(ms) || 0) / 1000).toFixed(3);
}

/**
 * Pure eligibility check. o = { segments, overlayCount, totalSec,
 * captionsBurned }. Returns { ok, reason } — reason is a short machine string
 * for the export log/telemetry.
 */
function singlePassEligible(o) {
  const segments = Array.isArray(o && o.segments) ? o.segments : [];
  if (segments.length === 0) return { ok: false, reason: "empty" };
  if (segments.length > SINGLEPASS_MAX_SEGMENTS) {
    return { ok: false, reason: `segments>${SINGLEPASS_MAX_SEGMENTS}` };
  }
  if (Number(o && o.overlayCount) > SINGLEPASS_MAX_OVERLAYS) {
    return { ok: false, reason: `overlays>${SINGLEPASS_MAX_OVERLAYS}` };
  }
  if (o && o.captionsBurned && Number(o && o.totalSec) > SINGLEPASS_CAPTIONED_MAX_SEC) {
    return { ok: false, reason: "captioned>600s (chunked pool)" };
  }
  return { ok: true, reason: null };
}

/**
 * Global-timeline fade chain (v6). The two-step applies dip/bookend fades
 * PER CLIP after its captions burn; the single-pass burns captions ONCE on
 * the concatenated stream, so the fades ride AFTER it (same visual order as
 * the canvas applyGlobalFade pass) as enable-gated global windows:
 *   dip head  @ boundary i → fade=t=in :st=segStart   :d=head  :color
 *   dip tail  @ boundary i → fade=t=out:st=segEnd−tail:d=tail  :color
 *   bookends (fadeStartEnd) → fade in at 0 / out at totalSec
 * Windows are half-open; adjacent windows share at most one frame instant.
 */
function buildGlobalFades(o) {
  const segments = o.segments;
  const transition = o.transition;
  const totalSec = Number(o.totalMs) / 1000;
  const fades = [];
  let cumulativeMs = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segStartMs = typeof seg.startMs === "number" ? seg.startMs : cumulativeMs;
    const durMs = Number(seg.durationMs) || 0;
    const segEndMs = segStartMs + durMs;
    const plan = G.planBoundaryFades(i, seg, segments, transition);
    if (plan.dipColor && plan.headMs > 0) {
      const s = segStartMs / 1000;
      const d = plan.headMs / 1000;
      fades.push(
        `fade=t=in:st=${s.toFixed(3)}:d=${d.toFixed(3)}:color=${plan.dipColor}` +
          `:enable='between(t,${s.toFixed(3)},${(s + d).toFixed(3)})'`,
      );
    }
    if (plan.dipTailMs > 0) {
      const d = plan.dipTailMs / 1000;
      const s = (segEndMs - plan.dipTailMs) / 1000;
      const tailColor = G.DIP_COLORS[plan.nextStyle] || "black";
      fades.push(
        `fade=t=out:st=${s.toFixed(3)}:d=${d.toFixed(3)}:color=${tailColor}` +
          `:enable='between(t,${s.toFixed(3)},${(segEndMs / 1000).toFixed(3)})'`,
      );
    }
    if (plan.startFadeMs > 0) {
      const d = plan.startFadeMs / 1000;
      fades.push(`fade=t=in:st=0:d=${d.toFixed(3)}:enable='between(t,0,${d.toFixed(3)})'`);
    }
    if (plan.endFadeMs > 0) {
      const d = plan.endFadeMs / 1000;
      const s = Math.max(0, totalSec - d);
      fades.push(`fade=t=out:st=${s.toFixed(3)}:d=${d.toFixed(3)}:enable='between(t,${s.toFixed(3)},${totalSec.toFixed(3)})'`);
    }
    cumulativeMs += durMs;
  }
  return fades;
}

/**
 * Build the complete single-pass plan: input argv (in strict index order) +
 * the full filter_complex script text. PURE — no fs, no side effects.
 *
 * o = {
 *   segments,        // base-lane payload segments (videoPath/imagePath…)
 *   fps, width, height, totalMs,
 *   kbEnabled, zoomMax, globalDir,   // resolved Ken Burns config
 *   transition,      // raw { style, durationMs, fadeStartEnd, overrides }
 *   wm,              // normalized watermark | null
 *   assSuffix,       // "subtitles=filename='…'" for the WHOLE timeline | null
 *   overlaySpecs,    // GLOBAL-window specs [{ inputArgs, x, y, xExpr, yExpr,
 *                    //   dw, dh, chroma, a, b, fps }] (built by main.js via
 *                    //   buildOverlaySpecsForWindow(0, totalMs))
 *   audio,           // AudioSettings
 *   audioPath,       // music absolute path | null
 *   sfx,             // [{ wavPath, startMs, volume }]
 *   clipAudio,       // [{ inputIdx (= base segment index), startMs, volume,
 *                    //    atempo: ["atempo=…"], durationMs }]
 *   loudnorm,        // { clip: [measure|null…], music: measure|null } | null
 *   masterLoudnorm,  // estimated measured-loudnorm filter string | null
 *   hwaccelPerSeg,   // [bool] probe-gated per-source hw decode
 * }
 *
 * Returns { inputs, script, hasAudioOut, videoOutLabel, warnings }.
 */
function buildSinglePassPlan(o) {
  const {
    segments, fps, width, height, totalMs,
    kbEnabled, zoomMax, globalDir,
    transition, wm, assSuffix, overlaySpecs,
    audio, audioPath, sfx, clipAudio, loudnorm, masterLoudnorm,
    hwaccelPerSeg,
  } = o;

  const N = segments.length;
  const inputs = [];
  const graph = [];
  const warnings = [];
  const totalSec = totalMs / 1000;

  // ── Per-boundary transition planning (shared math with buildClipArgs) ──
  const headPlan = segments.map((seg, i) => {
    const plan = G.planBoundaryFades(i, seg, segments, transition);
    const useXfadeHead = !!(
      plan.xfadeName &&
      i > 0 &&
      plan.headMs > 0 &&
      !G.videoAtBoundaryMirror(segments, i)
    );
    return { plan, useXfadeHead };
  });
  // Input i feeds a second consumer (segment i+1's frozen xfade head) → split.
  const splitNeeded = new Array(N).fill(false);
  for (let i = 1; i < N; i++) {
    if (headPlan[i].useXfadeHead) splitNeeded[i - 1] = true;
  }
  for (let i = 0; i < N; i++) {
    if (splitNeeded[i]) graph.push(`[${i}:v]split=2[sp${i}a][sp${i}b]`);
  }

  // ── Base segment inputs + chains ────────────────────────────────────────
  const segLabels = [];
  for (let i = 0; i < N; i++) {
    const seg = segments[i];
    const base = splitNeeded[i] ? `[sp${i}a]` : `[${i}:v]`;
    const isVideo = !!(seg && seg.mediaType === "video" && seg.videoPath);
    const durMs = Math.max(0, Number(seg.durationMs) || 0);
    const segFrames = Math.max(2, Math.round((durMs / 1000) * fps));

    if (isVideo) {
      const speed = G.resolveSegSpeed(seg);
      const sourceWinMs = speed !== 1 ? durMs * speed : durMs;
      inputs.push("-thread_queue_size", "512");
      inputs.push(...G.buildVideoInputArgs({
        trimInMs: Number(seg.trimInMs) || 0,
        path: seg.videoPath,
        hwaccel: hwaccelPerSeg ? !!hwaccelPerSeg[i] : false,
        // v6: the shared graph has no per-stream output -t, so the input is
        // bounded here (same seek/window semantics as the two-step's
        // buildVideoInputArgs + output -t pair, verified by the harness).
        durMs: sourceWinMs,
      }));
      graph.push(`${base}${G.buildVideoFilterChain({ width, height, fps, speed })}[s${i}]`);
      segLabels.push(`[s${i}]`);
      continue;
    }

    // IMAGE segment.
    const dir = kbEnabled ? seg.direction || globalDir : "none";
    const kbChain = kbEnabled && dir !== "none";
    if (headPlan[i].useXfadeHead || kbChain) {
      // zoompan path: single-frame input (no -loop) — zoompan consumes the
      // ONE frame and emits exactly segFrames (byte-identical to the
      // two-step's `-loop 1` + output `-t`, see verify-kenburns-parity.js).
      inputs.push("-thread_queue_size", "512", "-i", seg.imagePath);
    } else {
      // Static cover-fit: bounded looped input = exactly durMs of frames.
      inputs.push(
        "-thread_queue_size", "512",
        "-loop", "1", "-framerate", String(fps), "-t", fmt3(durMs),
        "-i", seg.imagePath,
      );
    }

    if (headPlan[i].useXfadeHead) {
      // v4.3 xfade HEAD composite — image↔image boundaries only (video
      // boundaries are hard cuts via videoAtBoundaryMirror). Input A = the
      // PREVIOUS segment's image frozen at its Ken Burns END state; input B
      // = this segment's animated chain; xfade offset=0 blends the head and
      // the output length is exactly B's duration.
      const F = (headPlan[i].plan.headMs / 1000).toFixed(3);
      const xfadeName = headPlan[i].plan.xfadeName;
      const prevSeg = segments[i - 1];
      const prevDir = kbEnabled ? prevSeg.direction || globalDir : "none";
      const frz = G.frozenZoompanExpr(prevDir, zoomMax);
      const scaleW = Math.round(width * 1.1);
      const scaleH = Math.round(height * 1.1);
      const pre =
        `scale=${scaleW}:${scaleH}:force_original_aspect_ratio=increase:flags=lanczos,` +
        `crop=${scaleW}:${scaleH}`;
      const zpCommon = `d=${segFrames}:s=${width}x${height}:fps=${fps}`;
      graph.push(
        `[sp${i - 1}b]${pre},zoompan=z='${frz.z}':x='${frz.x}':y='${frz.y}':${zpCommon},` +
          `setsar=1,format=yuv420p[fz${i}]`,
      );
      graph.push(
        `${base}${G.kenBurnsImageChain({ segFrames, kbEnabled, dir, zoomMax, width, height, fps })}[sr${i}]`,
      );
      graph.push(`[fz${i}][sr${i}]xfade=transition=${xfadeName}:duration=${F}:offset=0[s${i}]`);
      segLabels.push(`[s${i}]`);
      continue;
    }

    if (kbChain) {
      graph.push(
        `${base}${G.kenBurnsImageChain({ segFrames, kbEnabled, dir, zoomMax, width, height, fps })}[s${i}]`,
      );
    } else {
      graph.push(
        `${base}scale=${width}:${height}:force_original_aspect_ratio=increase,` +
          `crop=${width}:${height},fps=${fps},setsar=1,format=yuv420p[s${i}]`,
      );
    }
    segLabels.push(`[s${i}]`);
  }

  // ── Concat (single segment: pass the label straight through) ────────────
  let acc;
  if (N === 1) {
    acc = segLabels[0];
  } else {
    graph.push(`${segLabels.join("")}concat=n=${N}:v=1:a=0[vcat]`);
    acc = "[vcat]";
  }

  // ── Overlays (GLOBAL windows) → watermark → captions → fades ────────────
  let idx = N;
  const specs = Array.isArray(overlaySpecs) ? overlaySpecs : [];
  for (const ov of specs) {
    inputs.push("-thread_queue_size", "512", ...ov.inputArgs);
    graph.push(G.buildOverlayChain({
      inputIdx: idx, dw: ov.dw, dh: ov.dh, chroma: ov.chroma, a: ov.a, fps: ov.fps,
    }));
    const out = `[o${idx}]`;
    graph.push(G.buildOverlayFilter({
      accLabel: acc, inputIdx: idx, x: ov.x, y: ov.y,
      xExpr: ov.xExpr, yExpr: ov.yExpr, a: ov.a, b: ov.b, outLabel: out,
    }));
    acc = out;
    idx += 1;
  }
  if (wm) {
    inputs.push("-thread_queue_size", "512", "-i", wm.imagePath);
    graph.push(
      `[${idx}:v]scale=${wm.w}:${wm.h}:flags=bilinear,setsar=1,format=rgba,` +
        `colorchannelmixer=aa=${wm.opacity}[wmx]`,
    );
    graph.push(`${acc}[wmx]overlay=${wm.x}:${wm.y}:eof_action=repeat[vw]`);
    acc = "[vw]";
    idx += 1;
  }
  if (assSuffix) {
    graph.push(`${acc}${assSuffix}[vsub]`);
    acc = "[vsub]";
  }
  const fades = buildGlobalFades({ segments, transition, totalMs });
  if (fades.length > 0) {
    graph.push(`${acc}${fades.join(",")}[vout]`);
    acc = "[vout]";
  }
  const videoOutLabel = acc;

  // ── Audio bus (same graph, same builder as the two-step step 2) ─────────
  const sfxList = Array.isArray(sfx) ? sfx : [];
  const clipAudioList = Array.isArray(clipAudio) ? clipAudio : [];
  const hasAudioOut = clipAudioList.length > 0 || !!audioPath || sfxList.length > 0;
  if (hasAudioOut) {
    const loopMusic = !!(audioPath && audio && audio.musicLoop);
    if (audioPath) {
      inputs.push("-thread_queue_size", "512");
      if (loopMusic) inputs.push("-stream_loop", "-1");
      inputs.push("-i", audioPath);
    }
    const musicInputIdx = idx;
    if (audioPath) idx += 1;
    sfxList.forEach((s) => {
      inputs.push("-thread_queue_size", "512", "-i", s.wavPath);
      s.inputIdx = idx;
      idx += 1;
    });
    const { graph: audioGraph } = G.buildAudioMixGraph({
      totalSec,
      audio,
      clipAudio: clipAudioList.map((c) => ({
        inputIdx: c.inputIdx,
        startMs: c.startMs,
        volume: c.volume,
        atempo: c.atempo,
      })),
      hasMusic: !!audioPath,
      musicInputIdx,
      loudnorm,
      masterLoudnorm,
      sfx: sfxList.map((s) => ({ inputIdx: s.inputIdx, startMs: s.startMs, volume: s.volume })),
    });
    graph.push(audioGraph);
  }

  return {
    inputs,
    script: graph.join(";"),
    hasAudioOut,
    videoOutLabel,
    warnings,
    scriptBytes: Buffer.byteLength(graph.join(";"), "utf8"),
  };
}

/**
 * Final ffmpeg argv for the single-pass export. o = { plan (from
 * buildSinglePassPlan), scriptPath, encArgs, abr, fps, outputPath, threads,
 * filterThreads }.
 */
function buildSinglePassArgs(o) {
  const plan = o.plan;
  const args = ["-y"];
  const filterThreads = Number(o.filterThreads);
  if (Number.isFinite(filterThreads) && filterThreads > 0) {
    args.push("-filter_threads", String(Math.round(filterThreads)));
  }
  args.push(...plan.inputs);
  args.push("-filter_complex_script", o.scriptPath);
  args.push("-map", plan.videoOutLabel);
  if (plan.hasAudioOut) {
    args.push("-map", "[aout]");
  }
  args.push(...o.encArgs);
  args.push("-r", String(o.fps));
  if (plan.hasAudioOut) {
    args.push("-c:a", "aac", "-b:a", o.abr || "192k", "-ar", "48000", "-shortest");
  }
  const threads = Number(o.threads);
  if (Number.isFinite(threads) && threads > 0) {
    args.push("-threads", String(Math.round(threads)));
  }
  args.push("-movflags", "+faststart", o.outputPath);
  return args;
}

module.exports = {
  SINGLEPASS_MAX_SEGMENTS,
  SINGLEPASS_MAX_OVERLAYS,
  SINGLEPASS_CAPTIONED_MAX_SEC,
  SINGLEPASS_MAX_SCRIPT_BYTES,
  singlePassEligible,
  buildGlobalFades,
  buildSinglePassPlan,
  buildSinglePassArgs,
};
