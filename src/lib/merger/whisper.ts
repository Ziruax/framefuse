// src/lib/merger/whisper.ts — OpenAI Whisper-tiny ASR via Transformers.js
// Pure in-browser transcription (no server, no API key). Produces cues
// with per-word timestamps so the viral "word-by-word" caption mode
// can highlight the currently-spoken word karaoke-style, and so the
// kinetic typography animations can drive per-word "in" transitions.
//
// Model: Xenova/whisper-tiny (~75 MB, downloaded once and cached in
// IndexedDB by Transformers.js). Multilingual base model — auto-detects
// the spoken language.

import type { SubtitleCue, WordTimestamp } from "./subtitles";

// Lazy-load Transformers.js so the heavy model code only loads when
// the user actually clicks "Generate captions". This keeps the rest
// of the app (preview, export) lightweight.
let pipelinePromise: Promise<any> | null = null;

async function getPipeline(): Promise<any> {
  if (pipelinePromise) return pipelinePromise;

  pipelinePromise = (async () => {
    // Dynamic import — Next.js will code-split this chunk.
    const { pipeline, env } = await import("@xenova/transformers");

    // Allow remote model download from the Hugging Face Hub. The model
    // is cached in IndexedDB after the first run.
    env.allowRemoteModels = true;

    // automatic-speech-recognition with Whisper-tiny.
    const pipe = await pipeline(
      "automatic-speech-recognition",
      "Xenova/whisper-tiny",
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
  /** Source audio file — any format the browser can decode (mp3, wav, m4a, ogg, webm). */
  audioFile: File;
  /** Optional progress callback. */
  onProgress?: (p: WhisperProgress) => void;
  /** Optional abort signal. */
  signal?: AbortSignal;
}

export interface WhisperResult {
  /** Cues with word-level timestamps (sorted by startMs, re-indexed 1..N). */
  cues: SubtitleCue[];
  /** Detected language code (e.g. "en", "es") — null if unknown. */
  language: string | null;
  /** Total transcribed duration in ms. */
  durationMs: number;
}

/**
 * Decode an arbitrary audio File into a mono 16 kHz Float32Array PCM
 * suitable for Whisper. We use an OfflineAudioContext to render the
 * decoded audio to the target sample rate + channel layout.
 */
async function decodeAudioToMono16k(
  file: File,
): Promise<{ data: Float32Array; sampleRate: number }> {
  const arrayBuf = await file.arrayBuffer();
  const AudioCtx =
    (typeof window !== "undefined" && (window as any).AudioContext) ||
    (typeof window !== "undefined" && (window as any).webkitAudioContext);
  if (!AudioCtx) throw new Error("NO_AUDIO_CONTEXT");

  // Decode the compressed audio into an AudioBuffer at the browser's
  // default sample rate, then resample to 16 kHz mono via OfflineAudioContext.
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

/**
 * Transcribe the given audio file with Whisper-tiny and return cues
 * with per-word timestamps.
 *
 * Behaviour:
 *   - If the audio is silent or Whisper returns no chunks, returns
 *     an empty cue list (the UI will surface an error toast).
 *   - Long audio (>30s) is automatically split by Transformers.js's
 *     chunking; we pass `chunk_length_s: 30` and `stride_length_s: 5`
 *     for smooth segment boundaries.
 *   - Each chunk's text is tokenised into words and the chunk's
 *     [start, end] window is distributed evenly across those words
 *     to produce per-word timestamps.
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

  const pipe = await getPipeline();

  onProgress?.({ progress: 25, status: "Transcribing audio…" });
  if (signal?.aborted) throw new Error("Transcription cancelled");

  // Run ASR with chunking enabled + timestamp return.
  const output: any = await pipe(pcm, {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true,
    language: "english",
    task: "transcribe",
  });

  if (signal?.aborted) throw new Error("Transcription cancelled");
  onProgress?.({ progress: 80, status: "Aligning word timestamps…" });

  const cues: SubtitleCue[] = [];
  const chunks: Array<{
    text: string;
    timestamp: [number, number] | null;
  }> = output?.chunks ?? [];

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

    // Even-distribute the chunk window across words. Each word gets
    // `dur / N` ms. The first word starts exactly at the chunk's
    // startMs; the last word ends exactly at the chunk's endMs.
    const dur = endMs - startMs;
    const per = dur / tokens.length;
    const words: WordTimestamp[] = tokens.map((text, i) => ({
      text,
      startMs: startMs + Math.round(per * i),
      endMs: startMs + Math.round(per * (i + 1)),
    }));

    cues.push({
      id: cueId++,
      startMs,
      endMs,
      text,
      words,
    });
  }

  cues.sort((a, b) => a.startMs - b.startMs);
  cues.forEach((c, i) => (c.id = i + 1));

  onProgress?.({ progress: 100, status: "Done" });

  return {
    cues,
    language: null,
    durationMs: cues.length
      ? cues[cues.length - 1].endMs
      : Math.round((pcm.length / 16000) * 1000),
  };
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
