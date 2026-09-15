// src/lib/merger/waveform.ts — audio waveform peaks for the timeline strip
// v4.7 "Timeline Intelligence": peak-amplitude buckets decoded once per audio
// track, rendered as a mirrored bar strip on the timeline ruler.
// Pure core (computeWaveformPeaks) is Node-testable; decodeAudioPeaks wraps
// it with a temporary AudioContext (same pattern as beatDetect).

export interface WaveformData {
  /** Unique per decode — the render cache key (same-length peaks from a
   * different track must never reuse a stale bitmap). */
  id: string;
  /** Peak absolute amplitude (0..1) per bucket, evenly spaced. */
  peaks: number[];
  /** Audio duration in ms. */
  durationMs: number;
}

/** Number of buckets — enough detail at typical timeline widths, cheap to draw. */
export const WAVEFORM_BUCKETS = 720;

/**
 * Pure peak extraction: max(|sample|) per bucket over a mono signal.
 * Amplitudes are perceptually shaped (sqrt) so quiet passages stay visible
 * next to loud drops — linear peaks would flatten most of the strip.
 */
export function computeWaveformPeaks(
  mono: Float32Array,
  buckets = WAVEFORM_BUCKETS,
): number[] {
  if (mono.length === 0) return new Array<number>(Math.max(1, buckets)).fill(0);
  const n = Math.max(1, Math.min(buckets, mono.length));
  const out = new Array<number>(n).fill(0);
  const per = mono.length / n; // samples per bucket (may be fractional)
  for (let b = 0; b < n; b++) {
    const start = Math.floor(b * per);
    const end = Math.min(mono.length, Math.floor((b + 1) * per));
    let peak = 0;
    for (let i = start; i < end; i++) {
      const v = Math.abs(mono[i]);
      if (v > peak) peak = v;
    }
    // Perceptual shaping: sqrt lifts quiet detail without clipping loud peaks.
    out[b] = Math.sqrt(peak);
  }
  return out;
}

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

/** Unique decode ids (module counter + random suffix — restart-safe). */
let _waveIdCounter = 0;

/**
 * Decode an audio File → waveform peaks + duration.
 * Throws on undecodable input (caller keeps the previous waveform).
 */
export async function decodeAudioPeaks(
  file: File | Blob,
  buckets = WAVEFORM_BUCKETS,
): Promise<WaveformData> {
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
    _waveIdCounter += 1;
    return {
      id: `wave_${Date.now().toString(36)}_${_waveIdCounter}`,
      peaks: computeWaveformPeaks(mono, buckets),
      durationMs: Math.round((buf.length / buf.sampleRate) * 1000),
    };
  } finally {
    void ctx.close();
  }
}
