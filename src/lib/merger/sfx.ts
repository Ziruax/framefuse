// src/lib/merger/sfx.ts — Procedural SFX synthesis: pure definitions + WAV
// encoder + 10 OfflineAudioContext recipes that render timeline sound effects
// to 16-bit WAV blobs for FFmpeg mixing.

/**
 * SFX engine (v4.10) — every effect is SYNTHESIZED at runtime; no audio assets
 * ship with the app. Effects render offline (OfflineAudioContext, 44.1 kHz
 * mono) and encode to RIFF/WAVE 16-bit PCM blobs the Electron export pipeline
 * can hand straight to FFmpeg (`-i sfx.wav`) for timeline mixing.
 *
 * Node / browser split (important for the test harness):
 *  - Node-safe at ALL times: SFX_LIBRARY, getSfxDef, makeSfxItem,
 *    sfxDurationMs, sfxItemAt, computeSfxPeaks, encodeWav (Blob is a global in
 *    Node ≥ 18 and Bun). No browser API is touched at module top level.
 *  - Browser-only, guarded INSIDE the function: renderSfxBuffer /
 *    renderSfxWav check `typeof OfflineAudioContext` and return null when Web
 *    Audio is unavailable (Node/Bun) or when synthesis throws.
 *
 * Determinism: all synthesis randomness comes from a module-local mulberry32
 * PRNG seeded from a stable FNV-1a hash of the effect id. Global Math.random
 * is never touched, so re-rendering the same effect is bit-stable.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Picker grouping for the SFX palette. */
export type SfxCategory = "transition" | "impact" | "ui" | "emphasis";

/** A synthesizable effect definition (static library entry). */
export interface SfxDef {
  /** Stable id, e.g. "whoosh" — referenced by SfxItem.sfxId. */
  id: string;
  /** Human label for the picker UI. */
  label: string;
  /** Icon character for compact tiles. */
  emoji: string;
  /** Palette grouping. */
  category: SfxCategory;
  /** Nominal duration in ms (render default when no override is given). */
  defaultDurMs: number;
  /** One-line UI hint shown under the label. */
  hint: string;
}

/** One placement of an effect on the master timeline. */
export interface SfxItem {
  /** Instance id — unique per placement (see makeSfxItem). */
  id: string;
  /** Which SfxDef this placement triggers. */
  sfxId: string;
  /** Position on the master timeline, ms. */
  startMs: number;
  /** Playback volume, 0..1. */
  volume: number;
}

/**
 * Minimal buffer shape accepted by encodeWav. A real DOM AudioBuffer satisfies
 * this structurally, and plain objects (tests / Node) can fake it.
 */
export interface WavSource {
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  getChannelData(ch: number): Float32Array;
}

/** Synth recipe: schedules nodes on an offline ctx. T = duration in seconds. */
type SynthFn = (ctx: OfflineAudioContext, T: number, rng: () => number) => void;

/** Render sample rate for every SFX (mono). */
export const SFX_SAMPLE_RATE = 44100;

// ---------------------------------------------------------------------------
// Library (10 effects)
// ---------------------------------------------------------------------------

export const SFX_LIBRARY: SfxDef[] = [
  { id: "whoosh", label: "Whoosh", emoji: "🌬️", category: "transition", defaultDurMs: 450,
    hint: "Airy sweep for cuts and slide transitions" },
  { id: "pop", label: "Pop", emoji: "🫧", category: "ui", defaultDurMs: 90,
    hint: "Soft bubble pop for pickers and toggles" },
  { id: "ding", label: "Ding", emoji: "🔔", category: "ui", defaultDurMs: 600,
    hint: "Bright bell for alerts and completions" },
  { id: "impact", label: "Impact", emoji: "💥", category: "impact", defaultDurMs: 350,
    hint: "Weighty thump for hits and hard cuts" },
  { id: "riser", label: "Riser", emoji: "📈", category: "transition", defaultDurMs: 900,
    hint: "Tension build into the next beat" },
  { id: "click", label: "Click", emoji: "👆", category: "ui", defaultDurMs: 40,
    hint: "Tiny UI tick for snaps and selections" },
  { id: "sparkle", label: "Sparkle", emoji: "✨", category: "emphasis", defaultDurMs: 700,
    hint: "Shimmering pings to highlight a moment" },
  { id: "boom", label: "Boom", emoji: "🌩️", category: "impact", defaultDurMs: 800,
    hint: "Deep cinematic drop for reveals" },
  { id: "swipe", label: "Swipe", emoji: "↔️", category: "transition", defaultDurMs: 280,
    hint: "Fast brush for rapid-fire cuts" },
  { id: "record-scratch", label: "Record Scratch", emoji: "💿", category: "emphasis", defaultDurMs: 500,
    hint: "Vinyl cut for comedic freeze-frames" },
];

/** Look up a definition by id (undefined for unknown ids). */
export function getSfxDef(sfxId: string): SfxDef | undefined {
  return SFX_LIBRARY.find((d) => d.id === sfxId);
}

// ---------------------------------------------------------------------------
// Pure timeline utilities (Node-safe)
// ---------------------------------------------------------------------------

/** Monotonic sequence for instance ids (unique even within the same ms). */
let sfxSeq = 0;

/**
 * Factory for timeline placements. Generates ids like
 * `sfx_${Date.now().toString(36)}_${seq.toString(36)}` — the monotonic seq
 * keeps ids unique even when many items are created inside one millisecond
 * (drag-drop bursts). An explicit `partial.id` (undo/history snapshots) is
 * respected. `volume` is clamped to 0..1; non-finite numbers fall back to
 * the defaults.
 */
export function makeSfxItem(partial: Partial<SfxItem> = {}): SfxItem {
  sfxSeq += 1;
  const startMs =
    typeof partial.startMs === "number" && Number.isFinite(partial.startMs)
      ? partial.startMs
      : 0;
  const rawVol =
    typeof partial.volume === "number" && Number.isFinite(partial.volume)
      ? partial.volume
      : 1;
  return {
    id: partial.id ?? `sfx_${Date.now().toString(36)}_${sfxSeq.toString(36)}`,
    sfxId: partial.sfxId ?? SFX_LIBRARY[0]?.id ?? "whoosh",
    startMs,
    volume: Math.min(1, Math.max(0, rawVol)),
  };
}

/**
 * Total ms an item occupies on the timeline. Pure: uses the referenced def's
 * defaultDurMs; items pointing at unknown defs occupy 0 ms.
 */
export function sfxDurationMs(item: SfxItem): number {
  return getSfxDef(item.sfxId)?.defaultDurMs ?? 0;
}

/**
 * Hit-test used by the timeline UI: does item [startMs, startMs + dur]
 * contain tMs? The interval is CLOSED (t = end still hits, matching the
 * `[a, b]` notation). First match in array order wins; items with unknown
 * defs occupy zero time and never match. Returns null when nothing covers t.
 */
export function sfxItemAt(items: SfxItem[], tMs: number): SfxItem | null {
  for (const item of items) {
    const dur = sfxDurationMs(item);
    if (dur <= 0) continue;
    if (tMs >= item.startMs && tMs <= item.startMs + dur) return item;
  }
  return null;
}

/**
 * Peak envelope (max |sample| per bucket) for the mini-waveform preview drawn
 * on SFX timeline clips. Pure, no normalization — a constant ±1 signal peaks
 * at exactly 1. `buckets` < 1 → empty result; empty input → all zeros;
 * buckets finer than the signal leave the surplus buckets at 0.
 */
export function computeSfxPeaks(data: Float32Array, buckets: number): Float32Array {
  const n = Math.max(0, Math.floor(buckets));
  const out = new Float32Array(n);
  const len = data.length;
  if (n === 0 || len === 0) return out;
  for (let b = 0; b < n; b++) {
    const start = Math.floor((b * len) / n);
    const end = Math.min(len, Math.floor(((b + 1) * len) / n));
    let peak = 0;
    for (let i = start; i < end; i++) {
      const a = Math.abs(data[i]);
      if (a > peak) peak = a;
    }
    out[b] = peak;
  }
  return out;
}

// ---------------------------------------------------------------------------
// WAV encoder (pure — Blob is a Node ≥18 / Bun global)
// ---------------------------------------------------------------------------

/** Clamp to [-1, 1]; NaN/±Infinity collapse to 0 so the writer never garbage. */
function clampSample(s: number): number {
  if (!Number.isFinite(s)) return 0;
  return s < -1 ? -1 : s > 1 ? 1 : s;
}

/** Write 4 ASCII bytes (chunk ids) into a DataView. */
function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/**
 * Standard RIFF/WAVE writer: 44-byte header + interleaved 16-bit PCM frames.
 *
 *  [0..3]  "RIFF"   [4..7]   36 + dataLen (LE u32)
 *  [8..11] "WAVE"   [12..15] "fmt "       [16..19] 16 (LE u32)
 *  [20]    fmt=1 (PCM)  [22] channels  [24] sampleRate (LE u32)
 *  [28]    byteRate = sampleRate * blockAlign   [32] blockAlign = ch*2
 *  [34]    bits = 16  [36..39] "data"  [40..43] dataLen (LE u32)
 *
 * Sample mapping is symmetric: round(clamp(s) * 32767), so amplitude 2.0
 * clamps to +32767 and -2.0 to -32767. Decode with v / 32767 for a round
 * trip accurate to ±1 LSB.
 */
export function encodeWav(buffer: WavSource): Blob {
  const numCh = Math.max(1, Math.floor(buffer.numberOfChannels) || 1);
  const numFrames = Math.max(0, Math.floor(buffer.length) || 0);
  const sampleRate = Math.max(1, Math.round(buffer.sampleRate) || 1);
  const blockAlign = numCh * 2; // 16-bit samples
  const dataLen = numFrames * blockAlign;
  const out = new ArrayBuffer(44 + dataLen);
  const view = new DataView(out);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLen, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // format 1 = linear PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, "data");
  view.setUint32(40, dataLen, true);
  const chans: Float32Array[] = [];
  for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numCh; c++) {
      const ch = chans[c];
      const s = i < ch.length ? ch[i] : 0;
      view.setInt16(off, Math.round(clampSample(s) * 32767), true);
      off += 2;
    }
  }
  return new Blob([out], { type: "audio/wav" });
}

// ---------------------------------------------------------------------------
// Synthesis internals (browser-only — reachable only via renderSfxBuffer)
// ---------------------------------------------------------------------------

/** mulberry32 — tiny seeded PRNG. Module-local: Math.random is never touched. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit string hash → stable per-effect PRNG seed. */
function hashSeed(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** dB → linear amplitude. */
function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** White-noise AudioBufferSourceNode of `durSec`, filled from `rng`. */
function noiseSource(
  ctx: OfflineAudioContext,
  durSec: number,
  rng: () => number,
): AudioBufferSourceNode {
  const len = Math.max(1, Math.round(durSec * ctx.sampleRate));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = rng() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  return src;
}

/** In-place clip guard: rescale channels only if a peak exceeds `ceiling`. */
function guardPeaks(buf: AudioBuffer, ceiling = 0.98): void {
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
  }
  if (peak > ceiling && peak > 0) {
    const k = ceiling / peak;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= k;
    }
  }
}

/** whoosh: white noise → bandpass sweeping 300→2400 Hz, 15 ms attack + decay. */
function synthWhoosh(ctx: OfflineAudioContext, T: number, rng: () => number): void {
  const src = noiseSource(ctx, T, rng);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 1.4;
  bp.frequency.setValueAtTime(300, 0);
  bp.frequency.exponentialRampToValueAtTime(2400, Math.max(0.02, T * 0.9));
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, 0);
  g.gain.linearRampToValueAtTime(0.9, 0.015); // 15 ms attack
  g.gain.exponentialRampToValueAtTime(0.0001, T); // decay to silence
  src.connect(bp); bp.connect(g); g.connect(ctx.destination);
  src.start(0); src.stop(T);
}

/** pop: 880→220 Hz sine drop over 60 ms + tiny noise click transient. */
function synthPop(ctx: OfflineAudioContext, T: number, rng: () => number): void {
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(880, 0);
  osc.frequency.exponentialRampToValueAtTime(220, 0.06);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.8, 0);
  g.gain.exponentialRampToValueAtTime(0.0001, Math.min(0.09, T));
  osc.connect(g); g.connect(ctx.destination);
  osc.start(0); osc.stop(T);
  // Click transient: 5 ms of highpassed noise.
  const click = noiseSource(ctx, 0.02, rng);
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 3000;
  const cg = ctx.createGain();
  cg.gain.setValueAtTime(0.3, 0);
  cg.gain.exponentialRampToValueAtTime(0.0001, 0.005);
  click.connect(hp); hp.connect(cg); cg.connect(ctx.destination);
  click.start(0); click.stop(0.02);
}

/** ding: E6 fundamental + octave partial at -12 dB + detuned shimmer copy. */
function synthDing(ctx: OfflineAudioContext, T: number): void {
  // [freqHz, gain, decaySec, detuneCents]
  const partials: Array<[number, number, number, number]> = [
    [1318.51, 0.5, 0.6, 0], // E6 fundamental
    [2637.02, 0.5 * dbToGain(-12), 0.42, 0], // octave harmonic (-12 dB)
    [1318.51, 0.16, 0.5, 4], // +4 cents → slow shimmer beating
  ];
  for (const [freq, gain, decay, detune] of partials) {
    const end = Math.min(decay, T);
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    osc.detune.value = detune;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, 0);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(g); g.connect(ctx.destination);
    osc.start(0); osc.stop(end + 0.01);
  }
}

/** impact: 80→40 Hz sine thump + short noise burst lowpassed at 400 Hz. */
function synthImpact(ctx: OfflineAudioContext, T: number, rng: () => number): void {
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(80, 0);
  osc.frequency.exponentialRampToValueAtTime(40, 0.12);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.95, 0);
  g.gain.exponentialRampToValueAtTime(0.0001, T);
  osc.connect(g); g.connect(ctx.destination);
  osc.start(0); osc.stop(T);
  // Noise burst through a 400 Hz lowpass.
  const n = noiseSource(ctx, Math.min(0.1, T), rng);
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 400;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.5, 0);
  ng.gain.exponentialRampToValueAtTime(0.0001, Math.min(0.09, T));
  n.connect(lp); lp.connect(ng); ng.connect(ctx.destination);
  n.start(0); n.stop(Math.min(0.1, T));
}

/** riser: sawtooth sweep 200→900 Hz + noise highpass sweep 500→4000, swell. */
function synthRiser(ctx: OfflineAudioContext, T: number, rng: () => number): void {
  const master = ctx.createGain();
  master.connect(ctx.destination);
  const swellEnd = Math.min(T, Math.max(0.01, T * 0.92));
  const saw = ctx.createOscillator();
  saw.type = "sawtooth";
  saw.frequency.setValueAtTime(200, 0);
  saw.frequency.exponentialRampToValueAtTime(900, T);
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 3000; // tame the raw saw buzz
  const sg = ctx.createGain();
  sg.gain.setValueAtTime(0.0001, 0);
  sg.gain.linearRampToValueAtTime(0.35, swellEnd); // volume swell
  sg.gain.linearRampToValueAtTime(0.02, T); // 8% release, no hard click
  saw.connect(lp); lp.connect(sg); sg.connect(master);
  saw.start(0); saw.stop(T);
  const n = noiseSource(ctx, T, rng);
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.setValueAtTime(500, 0);
  hp.frequency.exponentialRampToValueAtTime(4000, T);
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.0001, 0);
  ng.gain.linearRampToValueAtTime(0.18, swellEnd);
  ng.gain.linearRampToValueAtTime(0.01, T);
  n.connect(hp); hp.connect(ng); ng.connect(master);
  n.start(0); n.stop(T);
}

/** click: 1 kHz damped sine, 25 ms decay — the UI tick. */
function synthClick(ctx: OfflineAudioContext, T: number): void {
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = 1000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.6, 0);
  g.gain.exponentialRampToValueAtTime(0.0001, Math.min(0.025, T));
  osc.connect(g); g.connect(ctx.destination);
  osc.start(0); osc.stop(T);
}

/** sparkle: 5 staggered sine pings (1567/2093/2637 Hz), 120 ms decay each. */
function synthSparkle(ctx: OfflineAudioContext, T: number, rng: () => number): void {
  const freqs = [1567.98, 2093.0, 2637.02]; // G6 / C7 / E7
  for (let i = 0; i < 5; i++) {
    const offset = rng() * 0.32 + i * 0.02; // staggered within first ~350 ms
    if (offset >= T) continue;
    const decay = Math.min(0.12, T - offset);
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freqs[i % freqs.length];
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.32 + rng() * 0.13, offset);
    g.gain.exponentialRampToValueAtTime(0.0001, offset + decay);
    osc.connect(g); g.connect(ctx.destination);
    osc.start(offset); osc.stop(Math.min(T, offset + 0.13));
  }
}

/**
 * boom: 55 Hz sine body + 27.5 Hz sub emphasis, exponential decay (nominally a
 * 1.5 s tail, squeezed into the 0.8 s render), all through a 140 Hz lowpass.
 */
function synthBoom(ctx: OfflineAudioContext, T: number): void {
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 140;
  const master = ctx.createGain();
  master.gain.value = 0.8;
  lp.connect(master); master.connect(ctx.destination);
  const body = ctx.createOscillator();
  body.type = "sine";
  body.frequency.value = 55;
  const bg = ctx.createGain();
  bg.gain.setValueAtTime(1.0, 0);
  bg.gain.exponentialRampToValueAtTime(0.02, T);
  body.connect(bg); bg.connect(lp);
  body.start(0); body.stop(T);
  const sub = ctx.createOscillator();
  sub.type = "sine";
  sub.frequency.value = 27.5;
  const sg = ctx.createGain();
  sg.gain.setValueAtTime(0.4, 0);
  sg.gain.exponentialRampToValueAtTime(0.008, T);
  sub.connect(sg); sg.connect(lp);
  sub.start(0); sub.stop(T);
}

/** swipe: noise → 800 Hz highpass → bandpass whose center wobbles at 6 Hz. */
function synthSwipe(ctx: OfflineAudioContext, T: number, rng: () => number): void {
  const n = noiseSource(ctx, T, rng);
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 800;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 3;
  bp.frequency.value = 1800;
  // LFO wobbles the bandpass center ±700 Hz at 6 Hz.
  const lfo = ctx.createOscillator();
  lfo.type = "sine";
  lfo.frequency.value = 6;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 700;
  lfo.connect(lfoGain);
  lfoGain.connect(bp.frequency);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, 0);
  g.gain.linearRampToValueAtTime(0.8, 0.015); // quick fade in
  g.gain.setValueAtTime(0.8, Math.max(0.02, T - 0.08));
  g.gain.linearRampToValueAtTime(0.0001, T); // quick fade out
  n.connect(hp); hp.connect(bp); bp.connect(g); g.connect(ctx.destination);
  n.start(0); n.stop(T);
  lfo.start(0); lfo.stop(T);
}

/**
 * record-scratch: 440 Hz saw wobbled ±300 Hz at 9 Hz, gain starts at 0.3 and
 * is chopped by a 12 Hz square LFO, plus 3 seeded bandpassed noise bursts.
 */
function synthRecordScratch(ctx: OfflineAudioContext, T: number, rng: () => number): void {
  // Master bus with a 30 ms tail fade so the scratch doesn't click at the end.
  const master = ctx.createGain();
  master.gain.setValueAtTime(1, 0);
  master.gain.setValueAtTime(1, Math.max(0, T - 0.03));
  master.gain.linearRampToValueAtTime(0.0001, T);
  master.connect(ctx.destination);
  // Wobbled saw voice.
  const saw = ctx.createOscillator();
  saw.type = "sawtooth";
  saw.frequency.value = 440;
  const wobble = ctx.createOscillator();
  wobble.type = "sine";
  wobble.frequency.value = 9;
  const wobbleGain = ctx.createGain();
  wobbleGain.gain.value = 300; // ±300 Hz
  wobble.connect(wobbleGain);
  wobbleGain.connect(saw.frequency);
  // Choppy amplitude: base 0.3, ±0.22 from a 12 Hz square LFO.
  const chop = ctx.createGain();
  chop.gain.value = 0.3;
  const chopLfo = ctx.createOscillator();
  chopLfo.type = "square";
  chopLfo.frequency.value = 12;
  const chopDepth = ctx.createGain();
  chopDepth.gain.value = 0.22;
  chopLfo.connect(chopDepth);
  chopDepth.connect(chop.gain);
  saw.connect(chop); chop.connect(master);
  saw.start(0); saw.stop(T);
  wobble.start(0); wobble.stop(T);
  chopLfo.start(0); chopLfo.stop(T);
  // Seeded noise bursts for the vinyl crackle.
  for (let i = 0; i < 3; i++) {
    const offset = 0.02 + rng() * Math.max(0.01, T - 0.1);
    if (offset + 0.05 > T) continue;
    const n = noiseSource(ctx, 0.05, rng);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2800;
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.25, offset);
    g.gain.exponentialRampToValueAtTime(0.0001, offset + 0.045);
    n.connect(bp); bp.connect(g); g.connect(master);
    n.start(offset); n.stop(offset + 0.05);
  }
}

/** id → synth recipe (keys mirror SFX_LIBRARY ids). */
const SYNTHS: Record<string, SynthFn> = {
  whoosh: synthWhoosh,
  pop: synthPop,
  ding: synthDing,
  impact: synthImpact,
  riser: synthRiser,
  click: synthClick,
  sparkle: synthSparkle,
  boom: synthBoom,
  swipe: synthSwipe,
  "record-scratch": synthRecordScratch,
};

// ---------------------------------------------------------------------------
// Render pipeline (browser-only; browser APIs touched INSIDE these functions)
// ---------------------------------------------------------------------------

/**
 * Render one effect to a mono 44.1 kHz AudioBuffer. Returns null on unknown
 * ids, when Web Audio is unavailable (Node/Bun harnesses), or on synthesis
 * failure. `durationMs` defaults to the def's defaultDurMs and is clamped to
 * [20, 10000]. Renders are deterministic per (sfxId, durationMs).
 */
export async function renderSfxBuffer(
  sfxId: string,
  durationMs?: number,
): Promise<AudioBuffer | null> {
  const def = getSfxDef(sfxId);
  const synth = SYNTHS[sfxId];
  if (!def || !synth) return null;
  let durMs =
    typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0
      ? durationMs
      : def.defaultDurMs;
  durMs = Math.min(10000, Math.max(20, durMs));
  if (typeof OfflineAudioContext === "undefined") return null; // no Web Audio
  try {
    const frames = Math.max(1, Math.ceil((durMs / 1000) * SFX_SAMPLE_RATE));
    const ctx = new OfflineAudioContext(1, frames, SFX_SAMPLE_RATE);
    synth(ctx, frames / SFX_SAMPLE_RATE, mulberry32(hashSeed(sfxId)));
    const buf = await ctx.startRendering();
    guardPeaks(buf);
    return buf;
  } catch {
    return null; // synthesis failure (bad param automation, OOM, …)
  }
}

/**
 * Full pipeline: render + encode. `durationMs` in the result is the ACTUAL
 * rendered length (buffer frames ÷ sample rate), not the requested value.
 * Returns null when renderSfxBuffer does (unknown id / no Web Audio / error).
 */
export async function renderSfxWav(
  sfxId: string,
  durationMs?: number,
): Promise<{ blob: Blob; durationMs: number } | null> {
  const buf = await renderSfxBuffer(sfxId, durationMs);
  if (!buf) return null;
  return {
    blob: encodeWav(buf),
    durationMs: (buf.length / buf.sampleRate) * 1000,
  };
}
