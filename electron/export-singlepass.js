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
/** v7 Step 2: the captioned-time ceilings are GONE (Infinity). Long
 *  captioned projects now ride the CHUNKED single-pass: every chunk window
 *  runs its OWN subtitles= filter over a window-clamped ASS document, so the
 *  single-threaded libass rasterization parallelizes across the W workers
 *  (each burns ~1/W of the cue stream). The old 600 s W=1 / 3600 s chunked
 *  gates pushed exactly these projects onto the two-step pool, whose
 *  per-clip chunks ALSO burn libass single-threaded per process (poolN=1 on
 *  low-core boxes — no parallelism win there, plus temp files and a double
 *  concat). The segment/overlay/script-byte ceilings stay: they bound ONE
 *  process's graph size, which chunking already divides by W. */
const SINGLEPASS_CAPTIONED_MAX_SEC = Infinity;
/** v6.5 CHUNKED ceilings (W>1 parallel single-pass): every chunk runs its own
 *  graph (~1/W the segments/overlaps) and its own libass burn, so the W=1
 *  ceilings — which exist to bound ONE process's graph size and ONE
 *  single-threaded subtitle burn — can widen. */
const CHUNKED_MAX_SEGMENTS = 240;
const CHUNKED_MAX_OVERLAYS = 120;
const CHUNKED_CAPTIONED_MAX_SEC = Infinity;
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
  // v7 Step 2: the captioned-time gate is removed (ceiling = Infinity) —
  // captions burn per-chunk in W parallel libass processes now.
  if (segments.length > maxSeg) {
    return { ok: false, reason: `segments>${maxSeg}` };
  }
  if (Number(o && o.overlayCount) > maxOvl) {
    return { ok: false, reason: `overlays>${maxOvl}` };
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
 * targetSec?, segClean? }.
 *
 * Returns { chunks: [{ f0, f1, frames, t0Ms, durMs, first, last, clean }],
 * spans, totalFrames, hybrid } or null when chunking doesn't apply (W<2,
 * short timeline, or the forbidden zones leave no valid split).
 *
 * v7 Step 4 — HYBRID SMART RENDERING: when `o.segClean` (a boolean per
 * segment, from main.js's TURBO copy-eligibility) marks a MIX of clean
 * (stream-copyable, matching output spec) and dirty (needs the filter
 * graph) segments, the plan adds MANDATORY chunk boundaries at every
 * clean↔dirty run edge — no chunk ever straddles the two — and spends the
 * ideal split points ONLY inside dirty ranges. Chunks whose covered
 * segments are all clean carry `clean: true`; main.js renders those as
 * TURBO stream copies (-c:v copy, zero decode/filter/encode) and the dirty
 * ones as windowed single-pass graphs, then glues the pieces with the
 * concat demuxer (-c copy). A 19-minute timeline with 4 minutes of edits
 * re-encodes exactly those 4 minutes.
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

  // ── v7 Step 4: HYBRID clean/dirty run planning ──────────────────────────
  const segCleanIn =
    Array.isArray(o && o.segClean) && o.segClean.length === segments.length
      ? o.segClean.map(Boolean)
      : null;
  let hybridSegClean = null;
  let mandatoryEdges = [];
  if (segCleanIn && segCleanIn.some((v) => v) && segCleanIn.some((v) => !v)) {
    // Absorb clean runs too short to stand alone (< 2 chunk minimums) into
    // the neighboring dirty ranges — correctness is unchanged (those frames
    // re-encode through the graph), and the piece list stays chunk-shaped.
    const c = segCleanIn.slice();
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      let i = 0;
      while (i < c.length) {
        let j = i;
        while (j < c.length && c[j] === c[i]) j++;
        if (c[i] && j < c.length) {
          const frames = spans[j - 1].S + spans[j - 1].F - spans[i].S;
          if (frames < 2 * minFrames) {
            for (let k = i; k < j; k++) c[k] = false;
            changed = true;
          }
        }
        i = j;
      }
      if (!changed) break;
    }
    if (c.some((v) => v) && c.some((v) => !v)) {
      // Mandatory edges at run switches. Invariant: a fade window or xfade
      // head covering an edge would make one of the edge segments DIRTY
      // (fades/heads disqualify copy eligibility), so a legit clean↔dirty
      // edge is never inside a zone — but stay conservative: ANY forbidden
      // edge cancels the hybrid and falls back to the plain full-timeline
      // chunk plan (re-encode everything, the v6.5 behavior).
      const mand = [];
      for (let i = 1; i < c.length; i++) {
        if (c[i] !== c[i - 1]) mand.push(spans[i].S);
      }
      if (mand.length > 0 && mand.every((f) => !forbidden(f))) {
        hybridSegClean = c;
        mandatoryEdges = mand;
      }
    }
  }

  if (hybridSegClean) {
    // Dirty ranges as global frame spans [a, b).
    const ranges = [];
    {
      let i = 0;
      while (i < hybridSegClean.length) {
        if (hybridSegClean[i]) { i++; continue; }
        let j = i;
        while (j < hybridSegClean.length && !hybridSegClean[j]) j++;
        ranges.push({ a: spans[i].S, b: spans[j - 1].S + spans[j - 1].F });
        i = j;
      }
    }
    const dirtyFrames = ranges.reduce((s, r) => s + (r.b - r.a), 0);
    const dirtySec = dirtyFrames / fps;
    if (dirtyFrames > 0 && ranges.length > 0) {
      // Chunk count over the DIRTY time only — clean time costs ~nothing
      // (stream copies), so the workers all go to the re-encode windows.
      let n = Math.min(
        workerCount,
        Math.max(2, Math.ceil(dirtySec / Math.max(5, targetSec / 2))),
      );
      n = Math.max(1, Math.min(n, Math.floor(dirtyFrames / minFrames) || 1));
      // Ideal splits distributed proportionally over the dirty frames,
      // mapped back to global frame positions, nudged right — then left —
      // INSIDE their dirty range, out of forbidden zones, keeping every
      // chunk ≥ minFrames from the previous bound.
      const bounds = [];
      let prev = 0;
      for (let k = 1; k < n; k++) {
        const target = Math.round((dirtyFrames * k) / n);
        let acc = 0;
        let gf = -1;
        for (const r of ranges) {
          const len = r.b - r.a;
          if (acc + len > target) { gf = r.a + (target - acc); break; }
          acc += len;
        }
        if (gf < 0) gf = ranges[ranges.length - 1].b - 1;
        const splittable = (f) =>
          ranges.some(
            (r) => f >= r.a + minFrames && f <= r.b - minFrames,
          );
        let b = -1;
        for (let c2 = gf; c2 <= totalFrames - minFrames; c2++) {
          if (splittable(c2) && !forbidden(c2) && c2 - prev >= minFrames) { b = c2; break; }
        }
        if (b < 0) {
          for (let c2 = gf; c2 > prev + minFrames; c2--) {
            if (splittable(c2) && !forbidden(c2)) { b = c2; break; }
          }
        }
        if (b < 0) break;
        bounds.push(b);
        prev = b;
      }
      const allBounds = Array.from(
        new Set([...bounds, ...mandatoryEdges]),
      ).sort((x, y) => x - y);
      // A too-small last DIRTY chunk merges into the previous (clean chunks
      // of any size are fine — they are just copy pieces).
      while (
        allBounds.length > 0 &&
        totalFrames - allBounds[allBounds.length - 1] < minFrames
      ) {
        const popped = allBounds.pop();
        // Never merge across a mandatory edge by popping it — a trailing
        // clean run shorter than minFrames is a perfectly good copy piece.
        if (mandatoryEdges.includes(popped)) {
          allBounds.push(popped);
          break;
        }
      }
      const chunks = [];
      let f0 = 0;
      for (const b of [...allBounds, totalFrames]) {
        const frames = b - f0;
        if (frames <= 0) { f0 = b; continue; }
        let clean = true;
        for (let i = 0; i < segments.length; i++) {
          const sp = spans[i];
          if (!sp || sp.F <= 0) continue;
          if (
            Math.min(sp.S + sp.F, b) - Math.max(sp.S, f0) > 0 &&
            !hybridSegClean[i]
          ) {
            clean = false;
            break;
          }
        }
        chunks.push({
          f0,
          f1: b,
          frames,
          t0Ms: (f0 / fps) * 1000,
          durMs: (frames / fps) * 1000,
          first: f0 === 0,
          last: b === totalFrames,
          clean,
        });
        f0 = b;
      }
      if (chunks.length < 2) return null;
      // Integrity: exact coverage of the output frame grid.
      const covered = chunks.reduce((a, c) => a + c.frames, 0);
      if (covered !== totalFrames) return null;
      return {
        chunks,
        spans,
        totalFrames,
        fps,
        hybrid: true,
        segClean: hybridSegClean,
        dirtyFrames,
      };
    }
  }

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
  return { chunks, spans, totalFrames, fps, hybrid: false };
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

// ---------------------------------------------------------------------------
// v9 TRUE SMART RENDERING — timeline segmentation planner.
//
// The monolithic "re-encode the whole timeline through one filter graph"
// routing is GONE. This planner slices [0, totalMs) into CLEAN time-ranges
// (untouched video — stream-copied at TURBO speed via buildStreamCopyArgs)
// and DIRTY time-ranges (anything that changes pixels), then KEYFRAME-SNAPS
// every dirty↔clean boundary onto the SOURCE keyframe grid so the concat
// demuxer never starts a copied piece mid-GOP (the grey-frame corruption).
// Only the dirty ranges pay the encode tax: a 19-minute timeline with 4
// minutes of text/PIP/transitions re-encodes exactly those 4 minutes plus
// ≤1 GOP per boundary.
//
// DIRTY detection (timeline-side, pure — main.js resolves the async
// source-side facts into `srcFacts`):
//   - a watermark anywhere → the whole timeline is dirty;
//   - captionsEnabled → every cue window [startMs, endMs] (word-level cues
//     live inside their cue's bounds);
//   - headlinesEnabled → every headline window;
//   - every overlay/PIP window [startMs, startMs + durationMs];
//   - per segment: NOT copy-capable (image / Ken Burns / speed ≠ 1 /
//     source format mismatch — a clean piece must be a stream copy of a
//     matching-spec h264 source), dip heads/tails + bookend fades (parsed
//     back from the EXACT buildGlobalFades strings the renderer ships, so
//     the planner's zones are the fades that actually run), xfade heads
//     (image↔image boundaries), and head trims that are NOT
//     keyframe-aligned (a copy cannot start mid-GOP).
//
// MERGING: ranges are sorted and merged when they overlap OR sit within
// `mergeGapMs` of each other (text at 1:00–1:10 + PIP at 1:05–1:15 → one
// dirty range 1:00–1:15); tiny gaps between dense cues never explode the
// piece count. Clean gaps shorter than `minCleanMs` absorb into the
// neighboring dirty range (a sub-second copy piece costs more in concat
// overhead than it saves).
//
// KEYFRAME SNAPPING (the Sandwich-copy lineage): a CLEAN piece must START
// on a source keyframe. The boundary maps through the segment frame law
//   slot s of segment i displays source frame  F0 + (s − S_i),
//   F0 = ceil(trimIn · g),  g = source fps
// — the SAME law windowSegmentsForChunk's sub-seek uses, so the dirty
// window's last frame and the clean copy's first frame are exactly the
// frames the W=1 render would display at those slots (no gap, no dup). A
// keyframe within ONE FRAME of the target aligns the copy (v1.4.1
// semantics — ≤1-frame accepted shift, exact timeline duration); anything
// further and the dirty range extends FORWARD to the next keyframe: the
// extra ≤1 GOP re-encodes and the clean piece starts exactly on the
// keyframe with ZERO content shift. Dirty STARTs expand BACKWARD to the
// previous keyframe (bounded by maxSnapMs) as conservative margin. When
// the keyframe scan is unavailable (no ffprobe / scan edge), boundaries
// degrade conservatively: dirty ranges extend to the segment end — a
// clean piece never starts at an unverified position.
//
// SUB-SPLITTING: large dirty ranges split into workerCount-sized windows
// on the global output frame grid (v6.5 lineage — the CPU-first
// parallelism), with every boundary kept OUT of the fade/xfade forbidden
// extents so each fade stays whole inside one piece (fade rejects
// negative st) and every xfade head renders with its segment start.
//
// o = { segments, overlays, transition, fps, totalMs, kbEnabled, globalDir,
//       wm, captionsEnabled, subtitleCues, headlinesEnabled, headlines,
//       srcFacts: [{ copyCapable, keyframes: [{s,ms}]|null,
//                    trimAligned: {ss,deltaMs}|null, srcFps }],
//       workerCount?, targetSec?, maxSnapMs?, minCleanMs?, mergeGapMs? }
// Returns { pieces, spans, totalFrames, fps, dirtyFrames, cleanFrames,
//           cleanMs, dirtyMs, allClean, allDirty, keyframeCuts, zones } or
// null when the plan is unusable (callers fall back to the two-step pool).
// ---------------------------------------------------------------------------
function planSmartSegments(o) {
  const segments = Array.isArray(o && o.segments) ? o.segments : [];
  if (segments.length === 0) return null;
  const fps = Math.max(1, Number(o && o.fps) || 30);
  const overlays = Array.isArray(o && o.overlays) ? o.overlays : [];
  const transition = o && o.transition;
  const kbEnabled = !!(o && o.kbEnabled);
  const globalDir = (o && o.globalDir) || "in";
  const wm = o && o.wm;
  const srcFacts = Array.isArray(o && o.srcFacts) ? o.srcFacts : [];
  const workerCount = Math.max(1, Number(o && o.workerCount) || 1);
  const targetSec = Math.max(10, Number(o && o.targetSec) || CHUNK_TARGET_SEC);
  const maxSnapMs = Number.isFinite(Number(o && o.maxSnapMs)) ? Number(o.maxSnapMs) : 3000;
  const minCleanMs = Number.isFinite(Number(o && o.minCleanMs)) ? Number(o.minCleanMs) : 750;
  const mergeGapMs = Number.isFinite(Number(o && o.mergeGapMs)) ? Number(o.mergeGapMs) : 400;
  const captionsEnabled = !!(o && o.captionsEnabled);
  const headlinesEnabled = !!(o && o.headlinesEnabled);
  const subtitleCues = Array.isArray(o && o.subtitleCues) ? o.subtitleCues : [];
  const headlines = Array.isArray(o && o.headlines) ? o.headlines : [];

  const totalMs =
    Number(o && o.totalMs) ||
    segments.reduce((a, s) => a + (Math.max(0, Number(s && s.durationMs) || 0)), 0);
  if (!(totalMs > 0)) return null;

  const { spans, totalFrames } = segmentFrameSpans(o);
  if (!(totalFrames > 0)) return null;

  const fact = (i) => {
    const f = srcFacts[i];
    return f || { copyCapable: false, keyframes: null, trimAligned: null, srcFps: 0 };
  };
  // Packed-clock ms of a global slot — the clock windowSegmentsForChunk,
  // buildOverlaySpecsForWindow and the chunk planner all live on.
  const msOfFrame = (f) => (f / fps) * 1000;

  // ── 1. DIRTY time ranges (timeline ms, half-open [s, e)) ───────────────
  const raw = [];
  const addRange = (s, e, why) => {
    s = Number(s);
    e = Number(e);
    if (!Number.isFinite(s) || !Number.isFinite(e) || !(e > s)) return;
    if (s < 0) s = 0;
    if (e > totalMs) e = totalMs;
    if (e <= s) return;
    raw.push({ s, e, why });
  };

  if (wm) addRange(0, totalMs, "watermark");

  // Burned text windows — captions burn per-cue, headlines per-headline.
  if (captionsEnabled) {
    for (const cue of subtitleCues) {
      if (!cue) continue;
      addRange(Number(cue.startMs), Number(cue.endMs), "captions");
    }
  }
  if (headlinesEnabled) {
    for (const h of headlines) {
      if (!h || !h.text) continue;
      addRange(Number(h.startMs), Number(h.endMs), "headlines");
    }
  }

  // Overlay / PIP windows (track ≥ 1 composite over the base lane).
  for (const ov of overlays) {
    if (!ov) continue;
    const s = Number(ov.startMs);
    const d = Number(ov.durationMs);
    if (!Number.isFinite(s) || !Number.isFinite(d) || d <= 0) continue;
    addRange(s, s + d, "overlay");
  }

  // Per-segment reasons. Everything that makes the segment's frames differ
  // from its source (or makes a copy impossible) marks its time dirty.
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) continue;
    const sp = spans[i];
    if (!sp || sp.F <= 0) continue;
    const segStartMs = msOfFrame(sp.S);
    const segEndMs = msOfFrame(sp.S + sp.F);
    const f = fact(i);
    const isVideo = !!(seg.mediaType === "video" && seg.videoPath);
    if (!isVideo || !f.copyCapable) {
      // Images (Ken Burns or static), speed changes, format-mismatched
      // sources: the graph must render every frame of this segment.
      addRange(segStartMs, segEndMs, isVideo ? "source-format" : "image");
      continue;
    }
    // Copy-capable video: the remaining hazards are the trim head (a copy
    // cannot cut mid-GOP) — fades/xfade heads are added globally below.
    const trimInMs = Math.max(0, Number(seg.trimInMs) || 0);
    if (trimInMs > 0 && !(f.trimAligned && f.trimAligned.ss)) {
      const kfs = Array.isArray(f.keyframes) ? f.keyframes : [];
      let k1 = null;
      for (const k of kfs) {
        if (k.ms >= trimInMs - 1) { k1 = k; break; }
      }
      if (!k1 || k1.ms - trimInMs >= segEndMs - segStartMs) {
        // No keyframe at/after the trim inside this segment (or the scan
        // is unavailable) — the whole segment re-encodes.
        addRange(segStartMs, segEndMs, "unalignable trim");
      } else {
        // Dirty head edge [segStart, slot of k1). Constructed in FRAME
        // space so the zone END is exactly k1's slot — the generic END
        // snap below then finds k1 within tolerance and records its exact
        // pts string for the clean piece's -ss.
        const g = f.srcFps > 0 ? f.srcFps : fps;
        const F0 = Math.ceil((trimInMs / 1000) * g - 1e-9);
        const kIdx1 = Math.round((k1.ms / 1000) * g);
        const b = Math.min(sp.S + sp.F, Math.max(sp.S + 1, sp.S + (kIdx1 - F0)));
        addRange(segStartMs, msOfFrame(b), "trim head");
      }
    }
  }

  // Fades: parse back the EXACT strings the renderer ships (buildGlobalFades
  // → windowGlobalFades) so the zones cover precisely the fades that run.
  // Their frame extents double as the sub-split FORBIDDEN zones.
  const forbidden = [];
  for (const w of parseGlobalFadeWindows(buildGlobalFades({ segments, transition, totalMs }))) {
    forbidden.push([Math.floor(w.aSec * fps), Math.ceil(w.bSec * fps)]);
    addRange(w.aSec * 1000, w.bSec * 1000, "fade");
  }
  // xfade heads (image↔image boundaries): the composite needs the headed
  // segment's START inside the window with its previous segment's chain.
  for (let i = 1; i < segments.length; i++) {
    const plan = G.planBoundaryFades(i, segments[i], segments, transition);
    if (plan.xfadeName && plan.headMs > 0 && !G.videoAtBoundaryMirror(segments, i)) {
      const headFrames = Math.ceil((plan.headMs / 1000) * fps) + 1;
      forbidden.push([spans[i].S, spans[i].S + headFrames]);
      addRange(msOfFrame(spans[i].S), msOfFrame(spans[i].S + headFrames), "xfade head");
    }
  }

  // ── 2. MERGE overlapping dirty ranges (with a small gap tolerance) ─────
  raw.sort((a, b) => a.s - b.s || a.e - b.e);
  const merged = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r.s <= last.e + mergeGapMs) {
      if (r.e > last.e) last.e = r.e;
      last.why.push(r.why);
    } else {
      merged.push({ s: r.s, e: r.e, why: [r.why] });
    }
  }

  // ── 3. Frame zones (expand outward to whole output frames), merged ─────
  const zones = [];
  for (const m of merged) {
    const a = Math.max(0, Math.floor((m.s / 1000) * fps));
    const b = Math.min(totalFrames, Math.ceil((m.e / 1000) * fps));
    if (b > a) zones.push({ a, b, why: m.why });
  }
  const mergeZones = () => {
    for (let i = 1; i < zones.length; ) {
      if (zones[i].a <= zones[i - 1].b) {
        zones[i - 1].b = Math.max(zones[i - 1].b, zones[i].b);
        zones[i - 1].why.push(...zones[i].why);
        zones.splice(i, 1);
      } else i++;
    }
  };
  mergeZones();

  // ── 4. KEYFRAME SNAPPING ───────────────────────────────────────────────
  const segIdxAtSlot = (f) => {
    for (let i = 0; i < segments.length; i++) {
      const sp = spans[i];
      if (sp && sp.F > 0 && f >= sp.S && f < sp.S + sp.F) return i;
    }
    return -1;
  };
  // The source-frame law (windowSegmentsForChunk's seek law, rate-matched):
  // slot s of segment i displays source frame F0 + (s − S_i).
  const segFrameLaw = (i) => {
    const f = fact(i);
    const g = f.srcFps > 0 ? f.srcFps : fps;
    const trimInMs = Math.max(0, Number(segments[i] && segments[i].trimInMs) || 0);
    const F0 = Math.ceil((trimInMs / 1000) * g - 1e-9);
    return { g, F0, S: spans[i].S, E: spans[i].S + spans[i].F };
  };
  // Final zone-END frame → the exact keyframe pts string a following clean
  // piece must pass to -ss (buildStreamCopyArgs round-trips it verbatim).
  const startSS = new Map();

  for (const z of zones) {
    // END: a clean piece starts at z.b → it MUST start on a source keyframe.
    if (z.b < totalFrames) {
      const i = segIdxAtSlot(z.b);
      if (i >= 0 && fact(i).copyCapable) {
        const { g, F0, S, E } = segFrameLaw(i);
        const kIdx = F0 + (z.b - S);
        const targetMs = (kIdx / g) * 1000;
        const tolMs = Math.min(50, Math.max(10, Math.round(1000 / Math.max(1, g))));
        const kfs = Array.isArray(fact(i).keyframes) ? fact(i).keyframes : [];
        let best = null;
        let bestD = Infinity;
        let next = null;
        for (const k of kfs) {
          const d = Math.abs(k.ms - targetMs);
          if (d < bestD) { bestD = d; best = k; }
          if (!next && k.ms > targetMs + tolMs) next = k;
        }
        if (best && bestD <= tolMs) {
          // Aligned within one frame (v1.4.1 semantics): the copy starts at
          // `best`, the ≤1-frame shift is the accepted tradeoff.
          startSS.set(z.b, best.s);
        } else if (next) {
          // Expand OUTWARD (forward) to the next keyframe's slot — the extra
          // ≤1 GOP re-encodes, the clean piece starts with ZERO content shift.
          const kNext = Math.round((next.ms / 1000) * g);
          const newB = S + (kNext - F0);
          if (newB > z.b && newB <= E) {
            z.b = newB;
            startSS.set(newB, next.s);
          } else if (newB > E) {
            // Keyframe past this segment — its remaining frames re-encode.
            z.b = E;
          }
        } else {
          // No keyframe ahead (scan edge / probe unavailable) — conservative.
          z.b = E;
        }
      }
    }
    // START: expand BACKWARD to the previous keyframe (bounded margin — the
    // dirty piece re-encodes, so its start needs no alignment; this only
    // buys open-GOP safety and costs ≤ maxSnapMs of extra encode).
    if (z.a > 0) {
      const i = segIdxAtSlot(z.a - 1);
      if (i >= 0 && fact(i).copyCapable) {
        const { g, F0, S } = segFrameLaw(i);
        const kIdx = F0 + (z.a - 1 - S);
        const targetMs = (kIdx / g) * 1000;
        const kfs = Array.isArray(fact(i).keyframes) ? fact(i).keyframes : [];
        let prev = null;
        for (const k of kfs) {
          if (k.ms <= targetMs && targetMs - k.ms <= maxSnapMs) prev = k;
        }
        if (prev) {
          const kPrev = Math.round((prev.ms / 1000) * g);
          if (kPrev >= F0) {
            const newA = S + (kPrev - F0);
            if (newA < z.a) z.a = newA;
          }
        }
      }
    }
  }
  mergeZones(); // expansion can overlap neighbors

  // ── 5. ABSORB clean gaps too short to be worth a copy piece ────────────
  const minCleanFrames = Math.max(1, Math.round((minCleanMs / 1000) * fps));
  if (zones.length > 0 && zones[0].a > 0 && zones[0].a < minCleanFrames) zones[0].a = 0;
  for (let i = 1; i < zones.length; i++) {
    const gap = zones[i].a - zones[i - 1].b;
    if (gap > 0 && gap < minCleanFrames) {
      // Extend the larger neighbor over the gap (fewer, bigger pieces).
      if (zones[i - 1].b - zones[i - 1].a >= zones[i].b - zones[i].a) zones[i - 1].b = zones[i].a;
      else zones[i].a = zones[i - 1].b;
    }
  }
  if (zones.length > 0) {
    const tail = totalFrames - zones[zones.length - 1].b;
    if (tail > 0 && tail < minCleanFrames) zones[zones.length - 1].b = totalFrames;
  }
  mergeZones();

  // ── 6. SUB-SPLIT large dirty ranges for pool parallelism (v6.5) ───────
  const minFrames = Math.max(8, Math.round(fps * 2));
  const forbiddenHit = (f) => forbidden.some((z) => f >= z[0] && f <= z[1]);
  let dirtyRanges = zones.map((z) => ({ a: z.a, b: z.b }));
  const dirtyFrames0 = dirtyRanges.reduce((s, r) => s + (r.b - r.a), 0);
  if (workerCount >= 2 && dirtyFrames0 >= minFrames * 2) {
    const dirtySec = dirtyFrames0 / fps;
    let n = Math.min(workerCount, Math.max(2, Math.ceil(dirtySec / Math.max(5, targetSec / 2))));
    n = Math.max(1, Math.min(n, Math.floor(dirtyFrames0 / minFrames) || 1));
    if (n >= 2) {
      // Ideal splits distributed proportionally over the DIRTY frames,
      // mapped back to global positions, nudged right — then left — out of
      // the forbidden extents, keeping every piece ≥ minFrames.
      const bounds = [];
      let prev = 0;
      for (let k = 1; k < n; k++) {
        const target = Math.round((dirtyFrames0 * k) / n);
        let acc = 0;
        let gf = -1;
        for (const r of dirtyRanges) {
          const len = r.b - r.a;
          if (acc + len > target) { gf = r.a + (target - acc); break; }
          acc += len;
        }
        if (gf < 0) gf = dirtyRanges[dirtyRanges.length - 1].b - 1;
        const splittable = (f) =>
          dirtyRanges.some((r) => f >= r.a + minFrames && f <= r.b - minFrames);
        let b = -1;
        for (let c = gf; c <= totalFrames - minFrames; c++) {
          if (splittable(c) && !forbiddenHit(c) && c - prev >= minFrames) { b = c; break; }
        }
        if (b < 0) {
          for (let c = gf; c > prev + minFrames; c--) {
            if (splittable(c) && !forbiddenHit(c)) { b = c; break; }
          }
        }
        if (b < 0) break;
        bounds.push(b);
        prev = b;
      }
      if (bounds.length > 0) {
        const out = [];
        for (const r of dirtyRanges) {
          let a = r.a;
          for (const b of bounds) {
            if (b > a && b < r.b) { out.push({ a, b }); a = b; }
          }
          out.push({ a, b: r.b });
        }
        dirtyRanges = out;
      }
    }
  }

  // ── 7. BUILD the piece list (must tile [0, totalFrames) exactly) ───────
  const pieces = [];
  let keyframeCuts = 0;
  const pushClean = (a, b) => {
    for (let i = 0; i < segments.length; i++) {
      const sp = spans[i];
      if (!sp || sp.F <= 0) continue;
      const f0 = Math.max(a, sp.S);
      const f1 = Math.min(b, sp.S + sp.F);
      if (f1 <= f0) continue;
      let ss = null;
      if (f0 > sp.S) {
        // Mid-segment start — the snapping pass recorded the keyframe.
        ss = startSS.get(f0) || null;
        if (!ss) return false; // unresolvable clean start → invalid plan
      } else {
        // Segment start: trimIn 0 copies from the file's first frame (an
        // IDR); a trimmed start uses the keyframe-aligned probe result.
        const trimInMs = Math.max(0, Number(segments[i].trimInMs) || 0);
        if (trimInMs > 0) {
          const ta = fact(i).trimAligned;
          if (!ta || !ta.ss) return false; // defensive: zones covered this
          ss = ta.ss;
        }
      }
      if (ss) keyframeCuts += 1;
      const durMs = msOfFrame(f1) - msOfFrame(f0);
      // v9 B-FRAME REORDER CORRECTION: the demuxer bounds input `-t` on
      // DTS, which lag PTS by the codec's reorder depth (has_b_frames) —
      // an uncorrected mid-file tail drags `b` EXTRA frames into the
      // chunk (duplicate content at the dirty seam + non-monotonic DTS in
      // the concat). Subtract b source-frames from -t so the copy stops
      // at the exact display frame; the following dirty piece renders
      // those frames through the graph instead. NOT applied when the
      // piece runs to the SOURCE's end (EOF clamps the read to exactly
      // the remaining frames — subtracting there would DROP the tail).
      const ff = fact(i);
      const g = ff.srcFps > 0 ? ff.srcFps : fps;
      const bF = Math.max(0, Math.min(16, Math.round(Number(ff.bFrames) || 0)));
      const trimInMs = Math.max(0, Number(segments[i].trimInMs) || 0);
      const tailSrcLeftMs =
        Number(ff.srcDurMs) > 0
          ? ff.srcDurMs - (trimInMs + ((f1 - sp.S) / g) * 1000)
          : Infinity;
      const srcContinues = tailSrcLeftMs > ((bF + 1) * 1000) / g + 50;
      const copyDurMs = srcContinues && bF > 0
        ? Math.max(1, durMs - (bF * 1000) / g)
        : durMs;
      pieces.push({
        kind: "clean",
        segIdx: i,
        f0,
        f1,
        frames: f1 - f0,
        t0Ms: msOfFrame(f0),
        durMs,
        copyDurMs,
        ss,
      });
    }
    return true;
  };
  let cursor = 0;
  for (const r of dirtyRanges) {
    if (r.a > cursor && !pushClean(cursor, r.a)) return null;
    pieces.push({
      kind: "dirty",
      f0: r.a,
      f1: r.b,
      frames: r.b - r.a,
      t0Ms: msOfFrame(r.a),
      durMs: msOfFrame(r.b) - msOfFrame(r.a),
    });
    cursor = r.b;
  }
  if (cursor < totalFrames && !pushClean(cursor, totalFrames)) return null;

  // Integrity: exact tiling of the output frame grid, in order.
  if (pieces.length === 0) return null;
  for (let p = 0; p < pieces.length; p++) {
    if (pieces[p].f0 !== (p === 0 ? 0 : pieces[p - 1].f1)) return null;
    if (pieces[p].f1 <= pieces[p].f0) return null;
  }
  const covered = pieces.reduce((a, p) => a + p.frames, 0);
  if (covered !== totalFrames) return null;

  const dirtyFrames = pieces
    .filter((p) => p.kind === "dirty")
    .reduce((s, p) => s + p.frames, 0);
  const cleanFrames = totalFrames - dirtyFrames;
  return {
    pieces,
    spans,
    totalFrames,
    fps,
    dirtyFrames,
    cleanFrames,
    cleanMs: msOfFrame(cleanFrames),
    dirtyMs: msOfFrame(dirtyFrames),
    allClean: zones.length === 0,
    allDirty: cleanFrames === 0,
    keyframeCuts,
    zones: zones.map((z) => ({ a: z.a, b: z.b, why: Array.from(new Set(z.why)) })),
  };
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
 * filterThreads, globalArgs? }.
 * v7 Step 1: `globalArgs` (encoder-level ffmpeg GLOBAL options, e.g. the
 * Intel QSV d3d11va→qsv device derivation) ride immediately after -y and
 * BEFORE every input — exactly where -init_hw_device must sit.
 */
function buildSinglePassArgs(o) {
  const plan = o.plan;
  const args = ["-y"];
  if (Array.isArray(o.globalArgs) && o.globalArgs.length > 0) {
    args.push(...o.globalArgs);
  }
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
  // v9 SMART RENDER — the concat contract: a re-encoded piece that will be
  // concatenated (-c copy) against stream-copied pieces from a source whose
  // mp4 video track runs on timescale T must WRITE the same T, so the
  // demuxer's offset math is exact (the source's ffprobe time_base
  // denominator, probed by main.js). Absent → ffmpeg's default (callers
  // without clean neighbours keep their legacy argv byte-identical).
  const ts = Number(o.videoTimescale);
  if (Number.isFinite(ts) && ts > 0) {
    args.push("-video_track_timescale", String(Math.round(ts)));
  }
  const threads = Number(o.threads);
  if (Number.isFinite(threads) && threads > 0) {
    args.push("-threads", String(Math.round(threads)));
  }
  // v9 SMART RENDER: hard frame cap — a dirty window must emit EXACTLY its
  // slot count. The input -t rides ms-rounded seconds (fmt3) whose rounding
  // can over-grab one source frame; the graph then emits N+1 frames and
  // every subsequent concat piece shifts a slot late. -frames:v bounds the
  // MUXER — B-frame reordering and filter over-production cannot leak past
  // it. (The v6.5 chunked path never hit this because its sibling pieces
  // rounded identically; smart pieces butt against EXACT stream copies.)
  const frameCap = Number(o.frameCap);
  if (Number.isFinite(frameCap) && frameCap > 0) {
    args.push("-frames:v", String(Math.round(frameCap)));
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
  planSmartSegments,
  windowSegmentsForChunk,
  windowGlobalFades,
  padOverlayInputWindows,
  buildSinglePassPlan,
  buildSinglePassArgs,
  buildAudioOnlyArgs,
};
