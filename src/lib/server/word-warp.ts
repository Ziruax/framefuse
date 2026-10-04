/**
 * SERVER-ONLY word-to-word dub timing (v1.27).
 *
 * Aligns a synthesized utterance to the ORIGINAL speaker's word timings:
 *
 *   1. Anchors — every synthesized word start is mapped (proportional index)
 *      to an original word start; a final anchor pins the utterance end.
 *   2. Guardrails — the anchor map is smoothed + local speaking-rate changes
 *      are clamped so the dub never sounds unnatural (max ±~25% local, ±~35%
 *      global; outside that the caller falls back to a natural Edge-TTS
 *      rate re-synthesis instead of warping).
 *   3. Warp — the PCM is time-scaled per anchor interval with WSOLA
 *      (waveform-similarity overlap-add: pitch-preserving, artifact-light),
 *      so dubbed word N lands when the original word N was spoken.
 *
 * Audio plumbing: Edge-TTS MP3 (24 kHz mono 48 kbps) → ffmpeg → s16le PCM →
 * warp → in-memory WAV (no temp files).
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const requireCjs = createRequire(path.join(process.cwd(), "index.cjs"));

let ffmpegPathCache: string | null = null;
function ffmpegPath(): string {
  if (ffmpegPathCache) return ffmpegPathCache;
  const p = requireCjs("ffmpeg-static") as string;
  if (!p) throw new Error("ffmpeg binary is not available on the server");
  ffmpegPathCache = p;
  return p;
}

export const DUB_PCM_RATE = 24000; // Edge-TTS native rate

// ---------------------------------------------------------------------------
// ffmpeg decode (MP3 bytes → s16le PCM)
// ---------------------------------------------------------------------------

/** Decode any audio bytes to mono s16le PCM at DUB_PCM_RATE. */
export function decodeToPcm(audio: Buffer): Promise<Int16Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-f", "s16le",
      "-acodec", "pcm_s16le",
      "-ac", "1",
      "-ar", String(DUB_PCM_RATE),
      "pipe:1",
    ]);
    const out: Buffer[] = [];
    let errTail = "";
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => {
      errTail = (errTail + c.toString()).slice(-400);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(errTail.trim() || `ffmpeg decode failed (${code})`));
        return;
      }
      const buf = Buffer.concat(out);
      const pcm = new Int16Array(buf.length >> 1);
      for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(i * 2);
      resolve(pcm);
    });
    child.stdin.on("error", () => {
      /* ffmpeg exits early on bad input — close handles the rejection */
    });
    child.stdin.end(audio);
  });
}

/** Wrap PCM in a minimal 16-bit mono WAV (in-memory). */
export function encodeWav(pcm: Int16Array, sampleRate = DUB_PCM_RATE): Buffer {
  const dataBytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // format = PCM
  buf.writeUInt16LE(1, 22); // channels
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  return buf;
}

// ---------------------------------------------------------------------------
// Word alignment — anchor building + guardrails
// ---------------------------------------------------------------------------

export interface WarpWord {
  startMs: number;
  endMs: number;
}

/** Naturalness guardrails — beyond these the caller re-synthesizes with an
 *  Edge-TTS rate instead of warping (a real speaking-rate change always
 *  beats a big stretch). */
const MAX_GLOBAL_FACTOR = 1.45; // stretch beyond +45% sounds wrong
const MIN_GLOBAL_FACTOR = 0.72; // compress beyond -28% sounds wrong
const MAX_LOCAL_RATE = 1.28; // per-word speaking-rate change
const MIN_LOCAL_RATE = 0.78;
/** Pauses are (mostly) silence — they absorb timing differences for free.
 *  Edge-TTS gaps are true silence, so stretching a 12 ms TTS gap into a 300 ms
 *  original-speaker pause is just silence insertion (WSOLA handles it). */
const MIN_GAP_RATE = 0.25;
const MAX_GAP_RATE = 20;
/** Drift under this (ms) is already "matched" — skip the warp entirely. */
const SKIP_DRIFT_MS = 45;

export interface Anchor {
  fromMs: number;
  toMs: number;
  /** The interval STARTING at this anchor: "speech" (inside a word — WSOLA)
   *  or "gap" (lead-in / inter-word / trailing — silence pad/truncate). */
  kind: "speech" | "gap";
}

export interface WordWarpReport {
  anchors: number;
  synthWords: number;
  targetWords: number;
  globalFactor: number;
  maxDriftMs: number;
  minLocalRate: number;
  maxLocalRate: number;
  skippedReason?: string;
}

export interface WordWarpOutput {
  pcm: Int16Array;
  durationMs: number;
  applied: boolean;
  report: WordWarpReport;
}

/**
 * Word-START-exact anchor building.
 *
 * Every interval between anchors is either SPEECH (inside a synthesized word)
 * or GAP (between words / lead-in / trailing). The two get different
 * naturalness budgets:
 *
 *   • SPEECH rate is clamped tightly (0.78×…1.28×) — a real speaker-rate
 *     change, never a chipmunk/drag;
 *   • GAP rate is clamped loosely (0.25×…5×) — pauses compress/stretch for
 *     free (they're silence), so word STARTS land on the original word
 *     starts exactly whenever the gaps can absorb the difference.
 *
 * Anchors are emitted at each word's START and END:
 *   (synth_j.start → target_j.start)   ← the word-to-word contract
 *   (synth_j.end   → target_j.end)     ← as close as the speech clamp allows
 */
export function buildAnchors(
  synthWords: WarpWord[],
  targetWords: WarpWord[],
  synthDurMs: number,
  targetDurMs: number,
): { anchors: Anchor[]; report: Omit<WordWarpReport, "globalFactor"> } {
  const N = Math.max(1, synthWords.length);
  const M = Math.max(1, targetWords.length);
  /** Proportional index mapping synth word j → target word k. */
  const propK = (j: number): number => Math.round((j * (M - 1)) / Math.max(1, N - 1));

  const anchors: Anchor[] = [{ fromMs: 0, toMs: 0, kind: "gap" }];
  let curFrom = 0;
  let curTo = 0;

  const pushAnchor = (from: number, to: number, kind: "speech" | "gap"): void => {
    const f = Math.max(curFrom + 1, from);
    const t = Math.max(curTo + 2, to);
    anchors.push({ fromMs: f, toMs: t, kind });
    curFrom = f;
    curTo = t;
  };

  for (let j = 0; j < N; j++) {
    const wsF = Math.max(0, synthWords[j].startMs);
    const weF = Math.max(wsF + 1, synthWords[j].endMs);
    const t = targetWords[propK(j)];
    const wsT = Math.max(0, t.startMs);
    const weT = Math.max(wsT + 1, t.endMs);

    // ---- GAP interval [curFrom → wsF]: the word START lands on wsT. ----
    const gapSpan = Math.max(0, wsF - curFrom);
    const gapLo = curTo + MIN_GAP_RATE * gapSpan + 2;
    const gapHi = curTo + MAX_GAP_RATE * gapSpan;
    const wordStartTo = Math.round(Math.min(gapHi, Math.max(gapLo, wsT)));
    pushAnchor(wsF, wordStartTo, "speech");

    // ---- SPEECH interval [wsF → weF]: the word END lands on weT. ----
    const speechSpan = weF - wsF;
    const spLo = wordStartTo + MIN_LOCAL_RATE * speechSpan + 2;
    const spHi = wordStartTo + MAX_LOCAL_RATE * speechSpan;
    const wordEndTo = Math.round(Math.min(spHi, Math.max(spLo, weT)));
    pushAnchor(weF, wordEndTo, "gap");
  }

  // ---- TRAILING interval [curFrom → synthDurMs] → the utterance end. ----
  const trailing = Math.max(0, synthDurMs - curFrom);
  const endTo = Math.max(
    curTo + 2,
    Math.round(Math.min(curTo + MAX_GAP_RATE * trailing, Math.max(targetDurMs, curTo + 2))),
  );
  anchors.push({ fromMs: Math.max(curFrom + 1, synthDurMs), toMs: endTo, kind: "gap" });

  // Rates + drift diagnostics.
  let minRate = Infinity;
  let maxRate = 0;
  for (let i = 0; i < anchors.length - 1; i++) {
    const fromSpan = anchors[i + 1].fromMs - anchors[i].fromMs;
    const toSpan = anchors[i + 1].toMs - anchors[i].toMs;
    if (fromSpan > 0) {
      const rate = toSpan / fromSpan;
      minRate = Math.min(minRate, rate);
      maxRate = Math.max(maxRate, rate);
    }
  }
  let maxDrift = 0;
  for (let j = 0; j < N; j++) {
    const k = propK(j);
    const mappedStart = mapTime(anchors, synthWords[j].startMs);
    const targetStart = targetWords[k].startMs;
    maxDrift = Math.max(maxDrift, Math.abs(mappedStart - targetStart));
  }

  return {
    anchors,
    report: {
      anchors: anchors.length,
      synthWords: N,
      targetWords: M,
      maxDriftMs: Math.round(maxDrift),
      minLocalRate: Number.isFinite(minRate) ? round3(minRate) : 1,
      maxLocalRate: round3(maxRate) || 1,
    },
  };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Piecewise-linear map synth-time → target-time (anchors sorted by from). */
export function mapTime(anchors: Anchor[], fromMs: number): number {
  if (anchors.length === 0) return fromMs;
  if (fromMs <= anchors[0].fromMs) {
    return anchors[0].toMs + (fromMs - anchors[0].fromMs);
  }
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    if (fromMs <= b.fromMs) {
      const t = (fromMs - a.fromMs) / Math.max(1, b.fromMs - a.fromMs);
      return a.toMs + t * (b.toMs - a.toMs);
    }
  }
  const last = anchors[anchors.length - 1];
  return last.toMs + (fromMs - last.fromMs);
}

// ---------------------------------------------------------------------------
// WSOLA time-stretch (pitch-preserving)
// ---------------------------------------------------------------------------

const FRAME = 1024; // ~43 ms @ 24 kHz
const HOP = FRAME >> 1; // 50% input overlap
const SEARCH = 320; // ±13 ms similarity search
const SEARCH_STEP = 8;

/** One WSOLA interval stretch. `factor` = outLen/inLen (0.5…2). */
function wsolaStretch(input: Float32Array, factor: number): Float32Array {
  const f = Math.min(2, Math.max(0.5, factor));
  const Hs = Math.max(1, Math.round(HOP * f));
  if (input.length < FRAME * 2 || Math.abs(f - 1) < 0.04) {
    // Too short to stretch — linear resample (safe for < 60 ms of speech).
    return linearResample(input, f);
  }
  const frames = Math.max(1, Math.floor((input.length - FRAME) / HOP) + 1);
  const outLen = (frames - 1) * Hs + FRAME;
  const out = new Float32Array(outLen);
  out.set(input.subarray(0, FRAME)); // frame 0 verbatim
  let written = FRAME;

  for (let i = 1; i < frames; i++) {
    const nominal = i * HOP;
    const overlap = written - i * Hs; // existing output region to blend into
    const outStart = i * Hs;
    if (overlap <= 0) {
      // No overlap (factor ≥ 2 clamped) — straight copy.
      copyInto(out, input, outStart, nominal, FRAME);
      written = outStart + FRAME;
      continue;
    }
    const ov = Math.min(overlap, HOP);
    const lo = Math.max(0, nominal - SEARCH);
    const hi = Math.min(input.length - FRAME, nominal + SEARCH);
    // Similarity search: maximize normalized cross-correlation of the first
    // `ov` samples against the already-written output region.
    let best = nominal;
    let bestScore = -Infinity;
    for (let off = lo; off <= hi; off += SEARCH_STEP) {
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let k = 0; k < ov; k += 2) {
        const a = input[off + k];
        const b = out[outStart + k];
        dot += a * b;
        na += a * a;
        nb += b * b;
      }
      const score = na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : -1;
      if (score > bestScore) {
        bestScore = score;
        best = off;
      }
    }
    // Crossfade `ov` samples then copy the rest of the frame.
    for (let k = 0; k < ov; k++) {
      const w = k / ov;
      out[outStart + k] = input[best + k] * w + out[outStart + k] * (1 - w);
    }
    for (let k = ov; k < FRAME; k++) {
      out[outStart + k] = input[best + k];
    }
    written = outStart + FRAME;
  }
  return out.subarray(0, Math.min(outLen, written));
}

function copyInto(
  out: Float32Array,
  input: Float32Array,
  outStart: number,
  inStart: number,
  count: number,
): void {
  for (let k = 0; k < count; k++) {
    const oi = outStart + k;
    const ii = inStart + k;
    out[oi >= out.length ? out.length - 1 : oi] = ii < input.length ? input[ii] : 0;
  }
}

function linearResample(input: Float32Array, factor: number): Float32Array {
  const outLen = Math.max(1, Math.round(input.length * factor));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i / factor;
    const i0 = Math.floor(pos);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const t = pos - i0;
    out[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return out;
}

/** Copy a (silent) interval, padding with zeros or truncating to `want`. */
function padOrTrim(input: Float32Array, want: number): Float32Array {
  const out = new Float32Array(want);
  const n = Math.min(want, input.length);
  out.set(input.subarray(0, n));
  return out;
}

/** Crossfade-join two PCM stretches (5 ms). */
function joinPcm(a: Float32Array, b: Float32Array): Float32Array {
  const fade = Math.min(Math.floor(DUB_PCM_RATE * 0.005), a.length, b.length);
  const out = new Float32Array(a.length + b.length - fade);
  out.set(a.subarray(0, a.length - fade), 0);
  for (let k = 0; k < fade; k++) {
    const w = k / fade;
    out[a.length - fade + k] =
      a[a.length - fade + k] * (1 - w) + b[k] * w;
  }
  out.set(b.subarray(fade), a.length);
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Warp one synthesized utterance so its words land on the original speaker's
 * word times. `synthWords`/`targetWords` are relative to the utterance start
 * (ms). Falls back (applied=false, original pcm returned) whenever the
 * required change would hurt naturalness.
 */
export function warpWordsToTimeline(
  pcm: Int16Array,
  synthWords: WarpWord[],
  targetWords: WarpWord[],
): WordWarpOutput {
  const synthDurMs = (pcm.length / DUB_PCM_RATE) * 1000;
  const targetDurMs =
    targetWords.length > 0
      ? Math.max(...targetWords.map((w) => w.endMs))
      : synthDurMs;

  // The bail check uses the SPEECH end (the last word), not the raw audio
  // length — Edge-TTS appends trailing silence that must not look like a
  // timing mismatch.
  const speechEndMs =
    synthWords.length > 0
      ? Math.max(...synthWords.map((w) => w.endMs))
      : synthDurMs;
  const globalFactor = speechEndMs > 0 ? targetDurMs / speechEndMs : 1;
  const baseReport = {
    synthWords: synthWords.length,
    targetWords: targetWords.length,
    globalFactor: round3(globalFactor),
  };

  const bail = (reason: string, appliedPcm?: Int16Array): WordWarpOutput => ({
    pcm: appliedPcm ?? pcm,
    durationMs: synthDurMs,
    applied: false,
    report: {
      ...baseReport,
      anchors: 0,
      maxDriftMs: 0,
      minLocalRate: 1,
      maxLocalRate: 1,
      skippedReason: reason,
    },
  });

  if (synthWords.length < 2 || targetWords.length < 2) {
    return bail("not enough word timings");
  }
  if (globalFactor > MAX_GLOBAL_FACTOR || globalFactor < MIN_GLOBAL_FACTOR) {
    // Too far — the caller should re-synthesize with an Edge-TTS rate instead.
    return bail("timing too far from natural — rate re-synthesis recommended");
  }

  const { anchors, report } = buildAnchors(synthWords, targetWords, synthDurMs, targetDurMs);
  if (report.maxDriftMs < SKIP_DRIFT_MS) {
    return bail("already word-aligned (drift < 45 ms)");
  }

  // Piecewise warp per anchor interval: SPEECH → WSOLA (pitch-preserving);
  // GAP → copy + silence pad/truncate (Edge-TTS gaps are true silence, so
  // this inserts the original speaker's pauses exactly).
  const input = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) input[i] = pcm[i] / 32768;
  let out: Float32Array | null = null;
  const msToSample = DUB_PCM_RATE / 1000;
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    const fromStart = Math.floor(a.fromMs * msToSample);
    const fromEnd = Math.min(input.length, Math.max(fromStart + 1, Math.floor(b.fromMs * msToSample)));
    const span = fromEnd - fromStart;
    if (span <= 0) continue;
    const interval = input.subarray(fromStart, fromEnd);
    const wantMs = b.toMs - a.toMs;
    const wantSamples = Math.max(1, Math.round(wantMs * msToSample));
    let stretched: Float32Array;
    if (a.kind === "gap") {
      stretched = padOrTrim(interval, wantSamples);
    } else {
      const factor = wantSamples / span;
      if (!Number.isFinite(factor) || factor <= 0) continue;
      stretched = wsolaStretch(interval, factor);
    }
    out = out === null ? stretched : joinPcm(out, stretched);
  }
  if (out === null || out.length === 0) {
    return bail("warp produced no audio");
  }

  // Trailing samples after the last anchor (usually silence) get linear
  // treatment: keep them short — the last anchor already pins the end.
  const outPcm = new Int16Array(out.length);
  for (let i = 0; i < out.length; i++) {
    const v = Math.max(-1, Math.min(1, out[i]));
    outPcm[i] = Math.round(v * 32767);
  }
  const durationMs = (outPcm.length / DUB_PCM_RATE) * 1000;

  return {
    pcm: outPcm,
    durationMs: Math.round(durationMs),
    applied: true,
    report: { ...baseReport, ...report },
  };
}
