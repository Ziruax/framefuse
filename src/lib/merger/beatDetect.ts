// src/lib/merger/beatDetect.ts — client-side beat/BPM detection + timeline planners
// v4.6 "Beat-Sync Editing": energy-flux onset envelope + adaptive peak picking.
// Fully offline (Web Audio decode + pure JS DSP) — no network, no wasm.
// Export parity note: snapping only produces DURATION OVERRIDES (buildTimeline
// already consumes them), so the FFmpeg zoompan d= changes automatically and
// the preview stays pixel-exact with the export — no pipeline change required.

export interface BeatInfo {
  /** Detected beat times in master-timeline ms (sorted ascending). */
  beatMs: number[];
  /** Estimated tempo in beats-per-minute (median inter-onset interval). */
  bpm: number | null;
  /** Audio duration in ms. */
  durationMs: number;
}

export interface MinimalSegment {
  id: string;
  durationMs: number;
}

/* ------------------------------------------------------------------ */
/* DSP core                                                            */
/* ------------------------------------------------------------------ */

const FRAME = 1024;
const HOP = 512;

/** Mono downmix of an AudioBuffer (average of all channels). */
function downmixMono(buf: AudioBuffer): Float32Array {
  const ch = buf.numberOfChannels;
  if (ch === 1) return buf.getChannelData(0).slice();
  const a = buf.getChannelData(0);
  const out = new Float32Array(a.length);
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < a.length; i++) out[i] += d[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= ch;
  return out;
}

/** Per-frame energy (sum of squares) over a mono signal. */
function frameEnergy(mono: Float32Array): Float32Array {
  const frames = Math.max(1, Math.floor((mono.length - FRAME) / HOP) + 1);
  const e = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    const base = f * HOP;
    for (let i = 0; i < FRAME; i++) {
      const v = mono[base + i] || 0;
      s += v * v;
    }
    e[f] = s;
  }
  return e;
}

/** Positive log-energy flux — the onset detection function. */
function onsetFlux(energy: Float32Array): Float32Array {
  const n = energy.length;
  const flux = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const a = Math.log(1 + energy[i] * 1e6);
    const b = Math.log(1 + energy[i - 1] * 1e6);
    const d = a - b;
    flux[i] = d > 0 ? d : 0;
  }
  // Light smoothing (3-tap moving average) to tame single-frame spikes.
  const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = flux[Math.max(0, i - 1)];
    const nx = flux[Math.min(n - 1, i + 1)];
    sm[i] = (p + 2 * flux[i] + nx) / 4;
  }
  return sm;
}

/** Median of a numeric array. */
function median(vals: number[]): number {
  if (!vals.length) return 0;
  const s = [...vals].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Adaptive-threshold peak picking over the onset flux.
 * - local window median + mean, scaled — beats must clear both.
 * - must be the local maximum within ±2 frames.
 * - minimum inter-onset gap (max ~180 BPM → 333 ms).
 */
function pickPeaks(
  flux: Float32Array,
  hopMs: number,
): { frameIdx: number; strength: number }[] {
  const W = Math.max(3, Math.round(360 / hopMs)); // ~360 ms analysis window
  const MIN_GAP_FRAMES = Math.max(1, Math.round(333 / hopMs)); // ≤180 BPM
  const peaks: { frameIdx: number; strength: number }[] = [];
  let lastPeak = -Infinity;

  for (let i = 2; i < flux.length - 2; i++) {
    const v = flux[i];
    if (v <= 0) continue;

    // Local max check.
    let isMax = true;
    for (let k = Math.max(0, i - 2); k <= Math.min(flux.length - 1, i + 2); k++) {
      if (flux[k] > v) { isMax = false; break; }
    }
    if (!isMax) continue;

    // Adaptive threshold over the surrounding window.
    const lo = Math.max(0, i - W);
    const hi = Math.min(flux.length, i + W);
    const window: number[] = [];
    for (let k = lo; k < hi; k++) window.push(flux[k]);
    const med = median(window);
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    if (v < med * 2.1 + mean * 0.3 + 0.05) continue;

    // Minimum inter-onset interval.
    if (i - lastPeak < MIN_GAP_FRAMES) {
      // Keep the stronger of two close peaks.
      const prev = peaks[peaks.length - 1];
      if (prev && v > prev.strength) {
        peaks.pop();
      } else {
        continue;
      }
    }
    peaks.push({ frameIdx: i, strength: v });
    lastPeak = i;
  }
  return peaks;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Pure-PCM analysis entry (also used by the Node harness with synthetic
 * buffers): runs the onset pipeline over a mono signal.
 */
export function analyzePcm(mono: Float32Array, sampleRate: number): BeatInfo {
  const hopMs = (HOP / sampleRate) * 1000;
  const energy = frameEnergy(mono);
  const flux = onsetFlux(energy);
  const peaks = pickPeaks(flux, hopMs);
  const beatMs = peaks.map((p) => Math.round((p.frameIdx * HOP + FRAME / 2) / sampleRate * 1000));
  const durationMs = Math.round((mono.length / sampleRate) * 1000);

  let bpm: number | null = null;
  if (beatMs.length >= 4) {
    const ibis: number[] = [];
    for (let i = 1; i < beatMs.length; i++) {
      const d = beatMs[i] - beatMs[i - 1];
      if (d >= 250 && d <= 2000) ibis.push(d);
    }
    if (ibis.length >= 3) {
      const med = median(ibis);
      bpm = Math.round(60000 / med);
      // Fold into a musically-sane range (double/half-time correction).
      while (bpm > 190) bpm = Math.round(bpm / 2);
      while (bpm < 65) bpm = bpm * 2;
    }
  }
  return { beatMs, bpm, durationMs };
}

/**
 * Detect beats in an audio File.
 * Decodes via a temporary AudioContext, then runs the onset pipeline.
 * Returns beatMs (aligned to frame CENTERS) + BPM + duration.
 */
export async function detectBeats(file: File | Blob): Promise<BeatInfo> {
  const arrayBuf = await file.arrayBuffer();
  const Ctor =
    (typeof window !== "undefined" && (window as { AudioContext?: typeof AudioContext }).AudioContext) ||
    (typeof window !== "undefined" &&
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) ||
    undefined;
  if (!Ctor) throw new Error("Web Audio API unavailable");
  const ctx = new Ctor();
  try {
    const buf = await ctx.decodeAudioData(arrayBuf);
    const mono = downmixMono(buf);
    return analyzePcm(mono, buf.sampleRate);
  } finally {
    void ctx.close();
  }
}

/**
 * Plan a beat-snap: retime segment boundaries so cuts land exactly on beats.
 *
 * Two strategies:
 * 1. TEMPO-TRACKING WALK (enough beats): each segment spans whole beats
 *    (≈ totalBeats / segments, ≥ ceil(minMs / grid)) — follows tempo drift.
 * 2. GRID QUANTIZATION (fewer beats than segments): boundaries snap to the
 *    nearest multiple of the MEDIAN beat interval (grid extrapolated beyond
 *    the detected span so the total length is preserved).
 *
 * Returns the override map (segment id → duration in ms). Empty on
 * degenerate inputs (then callers keep current durations).
 */
export function planBeatSnap(
  segments: MinimalSegment[],
  beatMs: number[],
  minMs = 800,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!segments.length || beatMs.length < 2) return out;

  const n = segments.length;
  const ibis: number[] = [];
  for (let i = 1; i < beatMs.length; i++) {
    const d = beatMs[i] - beatMs[i - 1];
    if (d >= 250 && d <= 2000) ibis.push(d);
  }
  if (!ibis.length) return out;
  const G = median(ibis);
  const minUnits = Math.max(1, Math.ceil(minMs / G));

  if (beatMs.length - 1 >= n * minUnits) {
    // ---- Tempo-tracking walk over the real beat list ----
    // Entry condition guarantees every segment can span ≥ minUnits beats,
    // so the uniform walk below never starves; the LAST segment absorbs
    // the remainder.
    const beatsPerSeg = Math.max(minUnits, Math.round((beatMs.length - 1) / n));
    let cursor = 0;
    for (let i = 0; i < n; i++) {
      const endBeat =
        i === n - 1
          ? beatMs.length - 1
          : Math.min(cursor + beatsPerSeg, beatMs.length - 1);
      if (endBeat <= cursor) break; // safety: ran out of beats
      out[segments[i].id] = beatMs[endBeat] - beatMs[cursor];
      if (endBeat >= beatMs.length - 1) break;
      cursor = endBeat;
    }
    return out;
  }

  // ---- Grid quantization on the median interval ----
  const bounds: number[] = [0];
  for (const s of segments) bounds.push(bounds[bounds.length - 1] + s.durationMs);
  const gridUnits: number[] = [0];
  for (let i = 1; i <= n; i++) {
    let u = Math.round(bounds[i] / G);
    if (u <= gridUnits[i - 1]) u = gridUnits[i - 1] + 1; // strictly ≥ 1 grid unit
    gridUnits.push(u);
  }
  for (let i = 0; i < n; i++) {
    out[segments[i].id] = (gridUnits[i + 1] - gridUnits[i]) * G;
  }
  return out;
}

/** Proportional pacing: scale each segment duration to sum to `targetTotal`. */
function planProportional(
  segments: MinimalSegment[],
  currentTotal: number,
  targetTotal: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (segments.length < 1 || currentTotal <= 0 || targetTotal <= 0) return out;
  const scale = targetTotal / currentTotal;
  for (const s of segments) {
    const d = Math.round(s.durationMs * scale);
    if (d >= 500) out[s.id] = d;
  }
  return out;
}

/**
 * Plan "fit video to audio": scale every segment duration by
 * audioMs / totalMs (min 500 ms per segment) so the video ends exactly
 * with the audio. Returns the override map.
 */
export function planFitToAudio(
  segments: MinimalSegment[],
  audioMs: number,
): Record<string, number> {
  if (!segments.length || audioMs <= 0) return {};
  const total = segments.reduce((m, s) => m + s.durationMs, 0);
  if (total <= 0) return {};
  return planProportional(segments, total, audioMs);
}
