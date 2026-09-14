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
/** v6.5 CHUNKED ceilings (W>1 parallel single-pass): every chunk runs its own
 *  graph (~1/W the segments/overlaps) and its own libass burn, so the W=1
 *  ceilings — which exist to bound ONE process's graph size and ONE
 *  single-threaded subtitle burn — can widen. */
const CHUNKED_MAX_SEGMENTS = 240;
const CHUNKED_MAX_OVERLAYS = 120;
const CHUNKED_CAPTIONED_MAX_SEC = 3600;
/** Fallback threshold applied by main.js AFTER building (bytes of graph). */
const SINGLEPASS_MAX_SCRIPT_BYTES = 25000;
/** v6.5 chunk planner knobs. */
const CHUNK_TARGET_SEC = 45;
const CHUNK_MIN_TOTAL_SEC = 30;

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
  // v6.5: `chunked` (main.js will split the timeline across W parallel
  // processes) widens the ceilings — per-chunk graphs are ~1/W the size and
  // the libass burn parallelizes per chunk.
  const maxSeg = o && o.chunked ? CHUNKED_MAX_SEGMENTS : SINGLEPASS_MAX_SEGMENTS;
  const maxOvl = o && o.chunked ? CHUNKED_MAX_OVERLAYS : SINGLEPASS_MAX_OVERLAYS;
  const maxCap = o && o.chunked ? CHUNKED_CAPTIONED_MAX_SEC : SINGLEPASS_CAPTIONED_MAX_SEC;
  if (segments.length > maxSeg) {
    return { ok: false, reason: `segments>${maxSeg}` };
  }
  if (Number(o && o.overlayCount) > maxOvl) {
    return { ok: false, reason: `overlays>${maxOvl}` };
  }
  if (o && o.captionsBurned && Number(o && o.totalSec) > maxCap) {
    return { ok: false, reason: `captioned>${Math.round(maxCap)}s (chunked pool)` };
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

// ---------------------------------------------------------------------------
// v6.5 CHUNKED SINGLE-PASS (CPU-first parallel export)
//
// One ffmpeg process per timeline WINDOW: W chunks render in parallel through
// the pool (each its own full single-pass graph over [t0, t1) — decode +
// filters + x264 encode), the audio bus renders ONCE (audio-only process,
// full timeline — no per-chunk AAC boundary glitches, no windowed amix math),
// and a final concat+mux glues video (-c copy) + audio (-c copy).
//
// PARITY CONTRACT vs the W=1 single-pass:
//   - every chunk boundary lands on a GLOBAL OUTPUT FRAME index; per-segment
//     sub-windows derive from frame counts (µs seeks), NOT from timeline ms,
//     so the concatenated frames are the W=1 frames sliced at the boundary;
//   - boundaries NEVER fall inside a fade window or an xfade head zone —
//     ffmpeg's `fade` REJECTS negative `st` (verified empirically), so a fade
//     crossing a boundary could not be continued mid-ramp; forbidden zones
//     keep every fade entirely inside one chunk (pure shift, st ≥ 0);
//   - Ken Burns images cut mid-chunk continue the exact curve via the
//     zoompan `on` offset (kenBurnsZoompanExprs onOffset);
//   - overlays/ASS/fades are windowed in the OUTPUT-CLOCK position of the
//     chunk (t0 = f0/fps) — identical to how the W=1 graph evaluates them.
// ---------------------------------------------------------------------------

/** Parse a buildGlobalFades filter string into its window (the single
 *  formatter owns the syntax — parsing it back guarantees the planner's
 *  forbidden zones are the fades that actually ship). */
const GLOBAL_FADE_RE =
  /^fade=t=(in|out):st=([\d.]+):d=([\d.]+)(?::color=(\w+))?:enable='between\(t,([\d.]+),([\d.]+)\)'$/;

function parseGlobalFadeWindows(fadeStrings) {
  const out = [];
  for (const s of Array.isArray(fadeStrings) ? fadeStrings : []) {
    const m = GLOBAL_FADE_RE.exec(String(s || ""));
    if (!m) continue;
    out.push({
      type: m[1],
      stSec: Number(m[2]),
      dSec: Number(m[3]),
      color: m[4] || null,
      aSec: Number(m[5]),
      bSec: Number(m[6]),
    });
  }
  return out;
}

/** Emitted-frame count of each segment's chain in the FULL single-pass:
 *  video / static image: `ceil(dur×fps)` (fps-filter over [0, dur); empiri-
 *  cally verified with input `-t` + the exact chain shape); Ken Burns /
 *  xfade-headed images: `max(2, round(dur×fps))` (zoompan d= — exact). */
function segmentFrameSpans(o) {
  const segments = Array.isArray(o && o.segments) ? o.segments : [];
  const fps = Math.max(1, Number(o && o.fps) || 30);
  const kbEnabled = !!(o && o.kbEnabled);
  const globalDir = (o && o.globalDir) || "in";
  const transition = o && o.transition;
  const spans = [];
  let S = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const durMs = Math.max(0, Number(seg && seg.durationMs) || 0);
    const durSec = durMs / 1000;
    const isVideo = !!(seg && seg.mediaType === "video" && seg.videoPath);
    let F;
    if (isVideo) {
      F = Math.max(1, Math.ceil(durSec * fps - 1e-4));
    } else {
      const dir = kbEnabled ? (seg && seg.direction) || globalDir : "none";
      const plan = G.planBoundaryFades(i, seg, segments, transition);
      const useXfadeHead = !!(
        plan.xfadeName &&
        i > 0 &&
        plan.headMs > 0 &&
        !G.videoAtBoundaryMirror(segments, i)
      );
      if ((kbEnabled && dir !== "none") || useXfadeHead) {
        F = Math.max(2, Math.round(durSec * fps)); // zoompan d=
      } else {
        F = Math.max(1, Math.ceil(durSec * fps - 1e-4)); // looped input + fps
      }
    }
    spans.push({ S, F });
    S += F;
  }
  return { spans, totalFrames: S };
}

/**
 * Plan the parallel timeline chunks. o = { segments, transition, kbEnabled,
 * globalDir, fps, totalMs, fades (buildGlobalFades strings), workerCount,
 * targetSec? }.
 *
 * Returns { chunks: [{ f0, f1, frames, t0Ms, durMs, first, last }],
 * spans, totalFrames } or null when chunking doesn't apply (W<2, short
 * timeline, or the forbidden zones leave no valid split).
 */
function planTimelineChunks(o) {
  const segments = Array.isArray(o && o.segments) ? o.segments : [];
  if (segments.length === 0) return null;
  const fps = Math.max(1, Number(o && o.fps) || 30);
  const workerCount = Math.max(1, Number(o && o.workerCount) || 1);
  const targetSec = Math.max(10, Number(o && o.targetSec) || CHUNK_TARGET_SEC);
  const totalMs =
    Number(o && o.totalMs) ||
    segments.reduce((a, s) => a + (Math.max(0, Number(s && s.durationMs) || 0)), 0);
  const totalSec = totalMs / 1000;
  if (workerCount < 2 || totalSec < CHUNK_MIN_TOTAL_SEC) return null;

  const { spans, totalFrames } = segmentFrameSpans(o);
  const minFrames = Math.max(8, Math.round(fps * 2));
  if (totalFrames < minFrames * 2) return null;

  // Forbidden zones (inclusive FRAME indices a boundary may not occupy):
  //  - every global fade window (a boundary inside [a, b] would cut a ramp
  //    the chunk-local graph cannot continue — fade rejects negative st);
  //  - every xfade head (the head composite needs the PREVIOUS segment's
  //    input in the same process, and cannot be split mid-blend).
  const zones = [];
  for (const w of parseGlobalFadeWindows(o && o.fades)) {
    zones.push([Math.floor(w.aSec * fps), Math.ceil(w.bSec * fps)]);
  }
  for (let i = 1; i < segments.length; i++) {
    const plan = G.planBoundaryFades(i, segments[i], segments, o && o.transition);
    const useXfadeHead = !!(
      plan.xfadeName &&
      plan.headMs > 0 &&
      !G.videoAtBoundaryMirror(segments, i)
    );
    if (useXfadeHead) {
      const headFrames = Math.ceil((plan.headMs / 1000) * fps) + 1;
      zones.push([spans[i].S, spans[i].S + headFrames]);
    }
  }
  const forbidden = (f) => zones.some((z) => f >= z[0] && f <= z[1]);

  // Chunk count: enough windows to keep every worker busy — half-target
  // granularity (90 s on 4 workers → 4×22.5 s, not 2×45 s), capped at the
  // pool width (long timelines get workerCount-sized windows).
  let n = Math.min(
    workerCount,
    Math.max(2, Math.ceil(totalSec / Math.max(5, targetSec / 2))),
  );
  if (n < 2) return null;

  // Ideal (even) boundaries nudged right — then left — out of zones, keeping
  // every chunk ≥ minFrames; a boundary with no room is dropped (fewer
  // chunks, still parallel).
  const bounds = [];
  let prev = 0;
  for (let k = 1; k < n; k++) {
    const ideal = Math.round((k * totalFrames) / n);
    let b = -1;
    for (let c = ideal; c <= totalFrames - minFrames; c++) {
      if (!forbidden(c) && c - prev >= minFrames) { b = c; break; }
    }
    if (b < 0) {
      for (let c = ideal; c > prev + minFrames; c--) {
        if (!forbidden(c)) { b = c; break; }
      }
    }
    if (b < 0) break;
    bounds.push(b);
    prev = b;
  }
  // A too-small LAST chunk merges into the previous.
  while (bounds.length > 0 && totalFrames - bounds[bounds.length - 1] < minFrames) {
    bounds.pop();
  }
  if (bounds.length === 0) return null;

  const chunks = [];
  let f0 = 0;
  for (const b of [...bounds, totalFrames]) {
    const frames = b - f0;
    if (frames <= 0) { f0 = b; continue; }
    chunks.push({
      f0,
      f1: b,
      frames,
      t0Ms: (f0 / fps) * 1000,
      durMs: (frames / fps) * 1000,
      first: f0 === 0,
      last: b === totalFrames,
    });
    f0 = b;
  }
  if (chunks.length < 2) return null;
  // Integrity: exact coverage of the output frame grid.
  const covered = chunks.reduce((a, c) => a + c.frames, 0);
  if (covered !== totalFrames) return null;
  return { chunks, spans, totalFrames, fps };
}

/**
 * Window the base segments to a chunk. Sub-window geometry derives from the
 * GLOBAL FRAME grid (k0/k1 clamped to each segment's span) — not timeline
 * ms — so the concatenated chunk frames are exactly the W=1 frames.
 *
 * VIDEO: the sub-seek snaps to the SOURCE-frame grid at the frame W=1's
 * slot (k0 − S) DISPLAYS — the last source frame ≤ the slot's time bound
 * (the fps filter's "last ≤" semantics). For rate-matched sources
 * (srcFps == fps) this is bit-exact at ANY trim alignment (the grid shift
 * quantizes to whole output frames); for rate-mismatched sources the
 * sub-grid sits ε (< one source frame) earlier than W=1's — a documented
 * ±1-source-frame jitter at the ε-straddling slots (sub-perceptual, no
 * count/duration drift). `srcFpsPerSeg` (probed source rates) selects the
 * grid; absent/unknown → the project fps (matched-rate behavior).
 * IMAGE: trimIn stays 0 (zoompan offset handles mid-animation cuts).
 * Returns [{ seg (windowed copy), origIdx, S, F, k0, k1, ssSec|null }].
 */
function windowSegmentsForChunk(segments, spans, f0, f1, fps, srcFpsPerSeg) {
  const out = [];
  for (let i = 0; i < segments.length; i++) {
    const span = spans && spans[i];
    if (!span || span.F <= 0) continue;
    const k0 = Math.max(f0, span.S);
    const k1 = Math.min(f1, span.S + span.F);
    if (k1 <= k0) continue;
    const seg = segments[i];
    const isVideo = !!(seg && seg.mediaType === "video" && seg.videoPath);
    const durMs = ((k1 - k0) / fps) * 1000;
    const copy = { ...seg };
    let ssSec = null;
    if (isVideo) {
      const speed = G.resolveSegSpeed(seg);
      if (k0 === span.S) {
        // The sub-window starts at the segment's OWN start (chunk 0, or a
        // boundary exactly at a segment start): keep the EXACT W=1 seek —
        // same phase, same trimIn, byte-identical head.
        copy.durationMs = durMs;
        // ssSec stays null → buildVideoInputArgs formats fmt3(trimInMs),
        // exactly like the W=1 plan.
      } else {
        // Mid-segment cut. W=1's slot j0 = (k0 − S) displays source frame
        //   F(j0) = F0 + floor(j0 · g · speed / fps),
        // where F0 = ceil(trimIn × g) is the first frame the input seek
        // decodes (the first frame with pts ≥ trimIn) — measured empirically
        // at speed 1 (trims 233/437 ms @30 fps → F0 7/14, slot 15 → 22/29)
        // and at speed 1.5 (trim 966 ms → F0 29, slot 15 → 51).
        // Seeking EXACTLY to F(j0)/g makes the sub-window's slot 0 display
        // it. speed = 1 + rate-matched ⇒ every subsequent slot advances the
        // same whole frame ⇒ BIT-EXACT. speed ≠ 1 or rate mismatch ⇒ the
        // sub-window's fractional phase resets at the seek (W=1 accumulates
        // it from the segment start), leaving a ±1-SOURCE-FRAME jitter at
        // the carry slots — bounded, sub-perceptual (≤ one source frame ≈
        // 22–40 ms), and DRIFT-FREE (verified: frame counts, boundary frame,
        // and audio stay bit-exact). Documented in docs/EXPORT_PERF.md.
        const g =
          Array.isArray(srcFpsPerSeg) && Number(srcFpsPerSeg[i]) > 0
            ? Number(srcFpsPerSeg[i])
            : fps;
        const trimInMs = Math.max(0, Number(seg.trimInMs) || 0);
        const F0 = Math.ceil((trimInMs / 1000) * g - 1e-9);
        const j0 = k0 - span.S;
        const kFrame = F0 + Math.floor((j0 * g * speed) / fps);
        const seekSec = kFrame / g;
        copy.trimInMs = seekSec * 1000;
        copy.durationMs = durMs;
        // µs formatting truncates ≤1 µs EARLY — the target frame is still the
        // first decoded frame (truncation can never skip past it).
        ssSec = seekSec.toFixed(6);
      }
    } else {
      copy.durationMs = durMs;
    }
    out.push({ seg: copy, origIdx: i, S: span.S, F: span.F, k0, k1, ssSec });
  }
  return out;
}

/**
 * v6.5: extend a chunk-windowed overlay's input `-t` window ~120 ms past the
 * chunk end — but ONLY when the overlay's enable window was CLIPPED at the
 * chunk end (it continues into the next chunk). Two observed framesync
 * behaviors, both reproduced empirically:
 *   - CONTINUING overlay, unpadded input: the input EOFs one base-frame
 *     before the chunk's last frame and eof_action=pass drops the overlay
 *     from it (the full-timeline render has input past that point and
 *     composites normally) → PAD, so the last base frame composites.
 *   - Overlay ENDING inside the chunk (b < durSec): the full render's input
 *     ALSO ends a base-frame early (its `-t` stops at the true window end)
 *     and drops the overlay from the final enabled frame — the chunk must
 *     reproduce that EOF, so NO padding.
 * The enable window is never touched — the extra input frames are not
 * composited (they only keep the stream alive past the last base frame).
 */
function padOverlayInputWindows(specs, durMs, padMs = 120) {
  const durSec = Math.max(0, Number(durMs) || 0) / 1000;
  for (const ov of Array.isArray(specs) ? specs : []) {
    if (!ov) continue;
    // Only windows clipped at the chunk end (the overlay continues past it).
    // v6.5: `clippedEnd` comes from overlayWindow (the authoritative flag);
    // the b≈durSec heuristic stays as the fallback for spec builders that
    // predate the flag.
    const clipped =
      ov.clippedEnd === true ||
      (ov.clippedEnd == null &&
        Number(ov.b) > 0 &&
        Math.abs(Number(ov.b) - durSec) <= 0.001);
    if (!clipped) continue;
    const args = ov.inputArgs;
    if (!Array.isArray(args)) continue;
    const iIdx = args.indexOf("-i");
    if (iIdx <= 0) continue;
    // The LAST "-t" before "-i" bounds this input's read window.
    for (let k = iIdx - 1; k >= 0; k--) {
      if (args[k] === "-t") {
        const durSec2 = Number(args[k + 1]);
        if (Number.isFinite(durSec2) && durSec2 > 0) {
          args[k + 1] = (durSec2 + Math.max(0, Number(padMs) || 0) / 1000).toFixed(3);
        }
        break;
      }
    }
  }
  return specs;
}

/**
 * Shift the global fades into a chunk window [t0Sec, t0Sec+durSec]. The
 * planner's forbidden zones guarantee every fade is FULLY inside one chunk —
 * this is a pure shift (st' = st − t0 ≥ 0), never a mid-ramp continuation.
 * Fades outside the window are dropped.
 */
function windowGlobalFades(fadeStrings, t0Sec, durSec) {
  const out = [];
  for (const w of parseGlobalFadeWindows(fadeStrings)) {
    if (w.bSec <= t0Sec + 1e-9 || w.aSec >= t0Sec + durSec - 1e-9) continue;
    const st = Math.max(0, w.stSec - t0Sec);
    const a = Math.max(0, w.aSec - t0Sec);
    const b = Math.min(durSec, w.bSec - t0Sec);
    const parts = [`fade=t=${w.type}:st=${st.toFixed(3)}:d=${w.dSec.toFixed(3)}`];
    if (w.color) parts.push(`color=${w.color}`);
    parts.push(`enable='between(t,${a.toFixed(3)},${b.toFixed(3)})'`);
    out.push(parts.join(":"));
  }
  return out;
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
 *
 * v6.5 modes (all default to the exact legacy behavior when absent):
 *   - `window: { t0Ms, durMs, segMeta }` + windowed `segments` (from
 *     windowSegmentsForChunk) + `fullSegments`: renders ONE chunk. segMeta[i] =
 *     { origIdx, S, F, k0, k1, ssSec } — boundary plans come from the
 *     ORIGINAL segments (a windowed duration must never re-clamp a
 *     transition), Ken Burns chains use the FULL frame divisor + `on` offset,
 *     video seeks carry µs ssSec, and `o.fades` (the full-timeline fade
 *     strings) are shifted into the chunk window.
 *   - `videoOnly`: chunk render — the audio bus (and its inputs) are omitted.
 *   - `audioOnly`: standalone full-timeline audio render — ONLY the audio bus
 *     (clip-audio sources re-declared as this process's inputs), no video
 *     graph. `segments` must be the FULL segment array (branches' inputIdx
 *     reference it).
 */
function buildSinglePassPlan(o) {
  const {
    segments, fps, width, height, totalMs,
    kbEnabled, zoomMax, globalDir,
    transition, wm, assSuffix, overlaySpecs,
    audio, audioPath, sfx, clipAudio, loudnorm, masterLoudnorm,
    hwaccelPerSeg,
    window: win,
    fullSegments,
    videoOnly,
    audioOnly,
    fades: fadesIn,
  } = o;

  const N = segments.length;
  const inputs = [];
  const graph = [];
  const warnings = [];
  // Windowed renders bound every global clock to the CHUNK; the audio-only
  // render keeps the full-timeline clocks.
  const totalSec = (win ? Number(win.durMs) : totalMs) / 1000;
  const meta = win && Array.isArray(win.segMeta) ? win.segMeta : null;
  const planSegs =
    Array.isArray(fullSegments) && fullSegments.length ? fullSegments : segments;

  // ── AUDIO-ONLY: the full-timeline audio bus as its own process ─────────
  if (audioOnly) {
    const clipAudioList = Array.isArray(clipAudio) ? clipAudio : [];
    const sfxList = Array.isArray(sfx) ? sfx : [];
    if (!(clipAudioList.length > 0 || audioPath || sfxList.length > 0)) {
      return {
        inputs: [], script: "", hasAudioOut: false, videoOutLabel: null,
        warnings, scriptBytes: 0,
      };
    }
    // Branch sources re-declared as THIS process's inputs, with the same
    // seek/window argv the W=1 plan gives the base video inputs.
    let idx = 0;
    const branchInputs = [];
    const branchRefs = [];
    for (const c of clipAudioList) {
      const seg = segments[c.inputIdx] || {};
      const speed = G.resolveSegSpeed(seg);
      const durMs = Math.max(0, Number(seg.durationMs) || 0);
      const sourceWinMs = speed !== 1 ? durMs * speed : durMs;
      branchInputs.push(
        "-thread_queue_size", "512",
        ...G.buildVideoInputArgs({
          trimInMs: Number(seg.trimInMs) || 0,
          path: seg.videoPath,
          durMs: sourceWinMs,
        }),
      );
      branchRefs.push({ inputIdx: idx, startMs: c.startMs, volume: c.volume, atempo: c.atempo });
      idx += 1;
    }
    inputs.push(...branchInputs);
    const loopMusic = !!(audioPath && audio && audio.musicLoop);
    if (audioPath) {
      inputs.push("-thread_queue_size", "512");
      if (loopMusic) inputs.push("-stream_loop", "-1");
      inputs.push("-i", audioPath);
    }
    const musicInputIdx = idx;
    if (audioPath) idx += 1;
    const sfxRefs = [];
    sfxList.forEach((s) => {
      inputs.push("-thread_queue_size", "512", "-i", s.wavPath);
      sfxRefs.push({ inputIdx: idx, startMs: s.startMs, volume: s.volume });
      idx += 1;
    });
    const { graph: audioGraph } = G.buildAudioMixGraph({
      totalSec: totalMs / 1000,
      audio,
      clipAudio: branchRefs,
      hasMusic: !!audioPath,
      musicInputIdx,
      loudnorm,
      masterLoudnorm,
      sfx: sfxRefs,
    });
    return {
      inputs,
      script: audioGraph,
      hasAudioOut: true,
      videoOutLabel: null,
      warnings,
      scriptBytes: Buffer.byteLength(audioGraph, "utf8"),
    };
  }

  // ── Per-boundary transition planning (shared math with buildClipArgs) ──
  // v6.5 windowed: boundary plans are properties of the ORIGINAL boundaries
  // (clampTrMs reads the FULL segment durations) — indexed by origIdx.
  const headPlan = segments.map((seg, i) => {
    const oi = meta ? meta[i].origIdx : i;
    const plan = G.planBoundaryFades(oi, planSegs[oi], planSegs, transition);
    const useXfadeHead = !!(
      plan.xfadeName &&
      (meta ? oi : i) > 0 &&
      i > 0 &&
      plan.headMs > 0 &&
      !G.videoAtBoundaryMirror(planSegs, oi) &&
      // Windowed: the head renders in the chunk that CONTAINS the segment's
      // start (the planner's forbidden zones keep boundaries out of heads).
      !(meta && meta[i].k0 !== meta[i].S)
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
    // v6.5 windowed: the zoompan expression divisor uses the FULL segment
    // frame count while d= emits this window's frames (on+K continues the
    // exact curve). Non-windowed → both are segFrames, byte-identical.
    const segFrames = meta
      ? Math.max(2, Number(meta[i].F) || 2)
      : Math.max(2, Math.round((durMs / 1000) * fps));
    const emitFrames = meta
      ? Math.max(1, Math.round(Number(meta[i].k1) - Number(meta[i].k0)) || 1)
      : segFrames;
    const onOffset = meta
      ? Math.max(0, Number(meta[i].k0) - Number(meta[i].S)) || 0
      : 0;

    if (isVideo) {
      const speed = G.resolveSegSpeed(seg);
      const sourceWinMs = speed !== 1 ? durMs * speed : durMs;
      inputs.push("-thread_queue_size", "512");
      inputs.push(...G.buildVideoInputArgs({
        trimInMs: Number(seg.trimInMs) || 0,
        // v6.5 windowed: µs-precision seek (frame-grid derived — fmt3's ms
        // truncation can straddle a 60 fps frame edge).
        ssSec: meta && meta[i].ssSec != null ? meta[i].ssSec : undefined,
        path: seg.videoPath,
        hwaccel: hwaccelPerSeg
          ? !!hwaccelPerSeg[meta ? meta[i].origIdx : i]
          : false,
        // v6: the shared graph has no per-stream output -t, so the input is
        // bounded here (same seek/window semantics as the two-step's
        // buildVideoInputArgs + output -t pair, verified by the harness).
        durMs: sourceWinMs,
      }));
      // v6.5 PHASE NORMALIZER: `setpts=PTS-STARTPTS` pins the chain's output
      // to pts 0. Without it, an input seek whose phase lands in the first
      // half of a source frame interval (frac(trimIn×fps) ∈ (0, 0.5)) makes
      // the fps filter emit its first frame at pts ≈ 1/fps — the concat
      // filter then fills the leading sub-frame gap with a DUPLICATE (+1
      // frame per affected segment; empirically isolated: concat n=1 with
      // -ss 0.437 @30fps → 127 frames vs 126). The normalizer makes the
      // emitted count EXACTLY ceil(dur×fps) — matching the two-step per-clip
      // path and the chunk frame model. Aligned trims are a no-op (STARTPTS
      // subtracts 0).
      graph.push(
        `${base}${G.buildVideoFilterChain({ width, height, fps, speed })},setpts=PTS-STARTPTS[s${i}]`,
      );
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
      const zpCommon = `d=${emitFrames}:s=${width}x${height}:fps=${fps}`;
      graph.push(
        `[sp${i - 1}b]${pre},zoompan=z='${frz.z}':x='${frz.x}':y='${frz.y}':${zpCommon},` +
          `setsar=1,format=yuv420p[fz${i}]`,
      );
      graph.push(
        `${base}${G.kenBurnsImageChain({ segFrames, emitFrames, onOffset, kbEnabled, dir, zoomMax, width, height, fps })}[sr${i}]`,
      );
      graph.push(`[fz${i}][sr${i}]xfade=transition=${xfadeName}:duration=${F}:offset=0[s${i}]`);
      segLabels.push(`[s${i}]`);
      continue;
    }

    if (kbChain) {
      graph.push(
        `${base}${G.kenBurnsImageChain({ segFrames, emitFrames, onOffset, kbEnabled, dir, zoomMax, width, height, fps })}[s${i}]`,
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
  // v6.5 windowed: fades arrive as the FULL-timeline strings and shift into
  // the chunk window (planner zones guarantee whole-fade containment).
  const fades = win
    ? windowGlobalFades(Array.isArray(fadesIn) ? fadesIn : [], Number(win.t0Ms) / 1000, totalSec)
    : buildGlobalFades({ segments, transition, totalMs });
  if (fades.length > 0) {
    graph.push(`${acc}${fades.join(",")}[vout]`);
    acc = "[vout]";
  }
  const videoOutLabel = acc;

  // ── Audio bus (same graph, same builder as the two-step step 2) ─────────
  // v6.5 videoOnly (chunk render): the audio bus renders ONCE, separately —
  // no per-chunk AAC boundary glitches, no windowed amix math.
  const sfxList = Array.isArray(sfx) ? sfx : [];
  const clipAudioList = Array.isArray(clipAudio) ? clipAudio : [];
  const hasAudioOut = !videoOnly &&
    (clipAudioList.length > 0 || !!audioPath || sfxList.length > 0);
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

/**
 * v6.5 Final ffmpeg argv for the STANDALONE audio render (the chunked
 * single-pass's ONE audio pass). o = { plan (audioOnly, from
 * buildSinglePassPlan), scriptPath, abr, totalSec, outputPath }.
 *
 * The W=1 render bounds the (possibly -stream_loop infinite) music input
 * with `-shortest` against the video stream; this process has NO video, so
 * the output is bounded explicitly with `-t totalSec` (apad already pads up
 * to whole_dur — -t only ever TRUNCATES the loop tail).
 */
function buildAudioOnlyArgs(o) {
  const plan = o.plan;
  const args = ["-y"];
  args.push(...plan.inputs);
  args.push("-filter_complex_script", o.scriptPath);
  args.push("-map", "[aout]");
  args.push("-c:a", "aac", "-b:a", o.abr || "192k", "-ar", "48000");
  args.push("-t", (Math.max(0, Number(o.totalSec) || 0)).toFixed(3));
  args.push("-movflags", "+faststart", o.outputPath);
  return args;
}

module.exports = {
  SINGLEPASS_MAX_SEGMENTS,
  SINGLEPASS_MAX_OVERLAYS,
  SINGLEPASS_CAPTIONED_MAX_SEC,
  SINGLEPASS_MAX_SCRIPT_BYTES,
  CHUNK_TARGET_SEC,
  CHUNK_MIN_TOTAL_SEC,
  CHUNKED_MAX_SEGMENTS,
  CHUNKED_MAX_OVERLAYS,
  CHUNKED_CAPTIONED_MAX_SEC,
  singlePassEligible,
  buildGlobalFades,
  parseGlobalFadeWindows,
  segmentFrameSpans,
  planTimelineChunks,
  windowSegmentsForChunk,
  windowGlobalFades,
  padOverlayInputWindows,
  buildSinglePassPlan,
  buildSinglePassArgs,
  buildAudioOnlyArgs,
};
