// src/lib/merger/whisper.ts — OpenAI Whisper-tiny ASR via Transformers.js
// Pure in-browser transcription (no server, no API key). Produces cues
// with REAL per-word timestamps using Whisper's cross-attention alignment
// (`return_timestamps: "word"`) so the viral "word-by-word" caption mode
// highlights the currently-spoken word exactly when it is spoken, and the
// kinetic typography animations drive per-word "in" transitions.
//
// Model: Xenova/whisper-tiny (~75 MB, downloaded once and cached in
// IndexedDB by Transformers.js). Multilingual base model — auto-detects
// the spoken language.

import type { SubtitleCue, WordTimestamp } from "./subtitles";

// Lazy-load Transformers.js so the heavy model code only loads when
// the user actually clicks "Generate captions".
let pipelinePromise: Promise<any> | null = null;

// The model is DOWNLOADED at runtime from the HuggingFace Hub on first
// use, then cached in IndexedDB for all future runs. The user needs an
// internet connection only for the FIRST transcription.
const REMOTE_MODEL_ID = "Xenova/whisper-tiny";

// Singleton pipeline + progress callback (module scope so getPipeline
// can report download progress).
let activeProgressCb: ((p: WhisperProgress) => void) | null = null;

async function getPipeline(): Promise<any> {
  if (pipelinePromise) return pipelinePromise;

  pipelinePromise = (async () => {
    const { pipeline, env } = await import("@xenova/transformers");

    env.allowRemoteModels = true;
    env.allowLocalModels = false;

    const progress_callback = (info: any) => {
      if (!activeProgressCb) return;
      if (info.status === "progress") {
        const pct = info.progress ?? 0;
        const file = info.file ?? "model";
        activeProgressCb({
          progress: Math.round(pct),
          status: `Downloading ${file}…`,
        });
      } else if (info.status === "done") {
        activeProgressCb({
          progress: 100,
          status: `Loaded ${info.file ?? "model"}`,
        });
      } else if (info.status === "initiate") {
        activeProgressCb({
          progress: 0,
          status: `Preparing ${info.file ?? "model"}…`,
        });
      }
    };

    const pipe = await pipeline(
      "automatic-speech-recognition",
      REMOTE_MODEL_ID,
      { progress_callback },
    );
    return pipe;
  })();

  return pipelinePromise;
}

export interface WhisperProgress {
  /** 0-100 progress for the entire transcription run. */
  progress: number;
  /** Current status message ("Loading model…", "Transcribing…"). */
  status: string;
}

export interface WhisperOptions {
  /** Source audio file — any format the browser can decode. */
  audioFile: File;
  /** Optional progress callback. */
  onProgress?: (p: WhisperProgress) => void;
  /** Optional abort signal. */
  signal?: AbortSignal;
  /**
   * Language code for transcription: "auto" (auto-detect), a 2-letter
   * ISO code ("en"), or a full name ("english"). Default "auto".
   */
  language?: string;
}

export interface WhisperResult {
  /** Cues with word-level timestamps (sorted, re-indexed 1..N). */
  cues: SubtitleCue[];
  /** Detected language code (e.g. "en") — null if unknown. */
  language: string | null;
  /** Total transcribed duration in ms. */
  durationMs: number;
  /** True when REAL word-level alignment was produced. */
  wordLevel: boolean;
}

/**
 * Decode an arbitrary audio File into mono 16 kHz Float32Array PCM
 * suitable for Whisper.
 */
async function decodeAudioToMono16k(
  file: File,
): Promise<{ data: Float32Array; sampleRate: number }> {
  const arrayBuf = await file.arrayBuffer();
  const AudioCtx =
    (typeof window !== "undefined" && (window as any).AudioContext) ||
    (typeof window !== "undefined" && (window as any).webkitAudioContext);
  if (!AudioCtx) throw new Error("NO_AUDIO_CONTEXT");

  const tmpCtx = new AudioCtx();
  const audioBuf = await tmpCtx.decodeAudioData(arrayBuf.slice(0));
  tmpCtx.close?.();

  const srcChannels = audioBuf.numberOfChannels;
  const srcRate = audioBuf.sampleRate;
  const srcLen = audioBuf.length;
  const targetRate = 16000;

  // Mix down to mono first.
  const mono = new Float32Array(srcLen);
  for (let ch = 0; ch < srcChannels; ch++) {
    const data = audioBuf.getChannelData(ch);
    for (let i = 0; i < srcLen; i++) mono[i] += data[i] / srcChannels;
  }

  // Resample to 16 kHz with an OfflineAudioContext.
  const offline = new OfflineAudioContext(
    1,
    Math.ceil(srcLen * (targetRate / srcRate)),
    targetRate,
  );
  const buffer = offline.createBuffer(1, srcLen, srcRate);
  buffer.copyToChannel(mono, 0);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start();

  const rendered = await offline.startRendering();
  return { data: rendered.getChannelData(0), sampleRate: targetRate };
}

// ---------------------------------------------------------------------------
// Word-level cue grouping — turns Whisper's per-word chunks into display
// cues that keep EXACT per-word timings.
// ---------------------------------------------------------------------------

const MAX_WORDS_PER_CUE = 7;
const MAX_CUE_MS = 3500;
const WORD_GAP_BREAK_MS = 700;

interface RawWord {
  text: string;
  startMs: number;
  endMs: number;
}

/** Group raw aligned words into cues (sentence-ish windows). */
function groupWordsIntoCues(words: RawWord[]): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let current: RawWord[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const startMs = current[0].startMs;
    const endMs = current[current.length - 1].endMs;
    const text = current.map((w) => w.text).join(" ");
    cues.push({
      id: cues.length + 1,
      startMs,
      endMs: Math.max(endMs, startMs + 200),
      text,
      words: current.map((w) => ({
        text: w.text,
        startMs: w.startMs,
        endMs: w.endMs,
      })),
    });
    current = [];
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = current[current.length - 1];

    if (prev) {
      const gap = w.startMs - prev.endMs;
      const cueLen = w.endMs - current[0].startMs;
      const endsSentence = /[.!?…。！？]$/.test(prev.text);
      if (
        current.length >= MAX_WORDS_PER_CUE ||
        cueLen >= MAX_CUE_MS ||
        gap > WORD_GAP_BREAK_MS ||
        endsSentence
      ) {
        flush();
      }
    }
    current.push(w);
  }
  flush();

  cues.sort((a, b) => a.startMs - b.startMs);
  cues.forEach((c, i) => (c.id = i + 1));
  return cues;
}

/**
 * Transcribe the given audio file with Whisper-tiny and return cues
 * with per-word timestamps.
 *
 * v4.1: uses `return_timestamps: "word"` — Whisper's DTW cross-attention
 * alignment — so every word carries its REAL spoken time. Words are then
 * grouped into short display cues (max ~7 words / sentence punctuation /
 * natural pauses) while preserving exact per-word timing.
 *
 * Fallback: if word-level alignment is unavailable (very old
 * transformers.js or an alignment failure), we fall back to chunk-level
 * timestamps with even word distribution (v4 behavior).
 */
export async function transcribeWithWhisper(
  opts: WhisperOptions,
): Promise<WhisperResult> {
  const { audioFile, onProgress, signal } = opts;

  onProgress?.({ progress: 2, status: "Decoding audio…" });
  if (signal?.aborted) throw new Error("Transcription cancelled");

  let pcm: Float32Array;
  try {
    const decoded = await decodeAudioToMono16k(audioFile);
    pcm = decoded.data;
  } catch (err) {
    throw new Error(
      `Could not decode audio: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (pcm.length === 0) throw new Error("Audio file is empty or silent");

  onProgress?.({ progress: 10, status: "Loading Whisper-tiny model…" });
  if (signal?.aborted) throw new Error("Transcription cancelled");

  activeProgressCb = onProgress ?? null;

  try {
    const pipe = await getPipeline();

    onProgress?.({ progress: 25, status: "Transcribing audio…" });
    if (signal?.aborted) throw new Error("Transcription cancelled");

    const lang = opts.language || "auto";
    const baseOptions: Record<string, unknown> = {
      chunk_length_s: 30,
      stride_length_s: 5,
      task: "transcribe",
      // Disables conditioning on previous text — prevents the classic
      // Whisper repetition loop on long/degraded audio.
      condition_on_previous_text: false,
    };
    if (lang !== "auto") baseOptions.language = lang;

    // ── Pass 1: REAL word-level alignment ──
    let output: any = null;
    let wordLevel = false;
    try {
      output = await pipe(pcm, {
        ...baseOptions,
        return_timestamps: "word",
      });
      wordLevel = true;
    } catch {
      // Word alignment unsupported → chunk-level fallback below.
      wordLevel = false;
    }

    if (signal?.aborted) throw new Error("Transcription cancelled");

    if (!wordLevel) {
      onProgress?.({
        progress: 40,
        status: "Word alignment unavailable — falling back…",
      });
      output = await pipe(pcm, {
        ...baseOptions,
        return_timestamps: true,
      });
    }

    onProgress?.({ progress: 80, status: "Aligning word timestamps…" });

    const detectedLang =
      lang === "auto" ? (output?.language ?? null) : lang;

    // ── Parse output into cues ──
    const chunks: Array<{
      text: string;
      timestamp: [number | null, number | null];
    }> = output?.chunks ?? [];

    let cues: SubtitleCue[] = [];

    if (wordLevel && chunks.length > 0) {
      // Word mode: each chunk is (usually) one word with exact timing.
      const rawWords: RawWord[] = [];
      let lastEnd = 0;
      for (const chunk of chunks) {
        const text = (chunk.text || "").trim();
        if (!text) continue;
        const [s, e] = chunk.timestamp;
        const startMs =
          s != null ? Math.round(s * 1000) : lastEnd;
        let endMs =
          e != null ? Math.round(e * 1000) : startMs + Math.max(200, text.length * 90);
        if (endMs <= startMs) endMs = startMs + 200;
        lastEnd = endMs;
        // A chunk may contain multiple tokens for CJK / compact scripts.
        const tokens = text.split(/\s+/).filter(Boolean);
        if (tokens.length <= 1) {
          rawWords.push({ text, startMs, endMs });
        } else {
          // Distribute the chunk window across its tokens.
          const dur = endMs - startMs;
          const per = dur / tokens.length;
          tokens.forEach((t, i) => {
            rawWords.push({
              text: t,
              startMs: startMs + Math.round(per * i),
              endMs: startMs + Math.round(per * (i + 1)),
            });
          });
        }
      }
      cues = groupWordsIntoCues(rawWords);
    } else {
      // Fallback: chunk-level timestamps + even word distribution (v4).
      let cueId = 1;
      for (const chunk of chunks) {
        if (!chunk.timestamp) continue;
        const [startSec, endSec] = chunk.timestamp;
        if (startSec == null || endSec == null) continue;
        if (endSec <= startSec) continue;

        const startMs = Math.round(startSec * 1000);
        const endMs = Math.round(endSec * 1000);
        const text = (chunk.text || "").trim();
        if (!text) continue;

        const tokens = text.split(/\s+/).filter(Boolean);
        if (tokens.length === 0) continue;

        const dur = endMs - startMs;
        const per = dur / tokens.length;
        const words: WordTimestamp[] = tokens.map((text, i) => ({
          text,
          startMs: startMs + Math.round(per * i),
          endMs: startMs + Math.round(per * (i + 1)),
        }));

        cues.push({ id: cueId++, startMs, endMs, text, words });
      }
      cues.sort((a, b) => a.startMs - b.startMs);
      cues.forEach((c, i) => (c.id = i + 1));
    }

    onProgress?.({ progress: 100, status: "Done" });

    return {
      cues,
      language: detectedLang,
      durationMs: cues.length
        ? cues[cues.length - 1].endMs
        : Math.round((pcm.length / 16000) * 1000),
      wordLevel,
    };
  } finally {
    // Always clear the progress callback — success OR error.
    activeProgressCb = null;
  }
}

/**
 * Pre-load the Whisper-tiny model. Call this on app idle to avoid the
 * model-download latency on the first "Generate" click.
 */
export async function preloadWhisper(
  onProgress?: (p: WhisperProgress) => void,
): Promise<void> {
  onProgress?.({ progress: 0, status: "Loading Whisper-tiny model…" });
  await getPipeline();
  onProgress?.({ progress: 100, status: "Ready" });
}

/** True if Whisper transcription is available in this environment. */
export function isWhisperAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    !!(window as any).AudioContext &&
    typeof OfflineAudioContext !== "undefined"
  );
}
