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

// The model is DOWNLOADED at runtime from the HuggingFace Hub on first
// use, then cached in IndexedDB for all future runs. This avoids
// bundling the 149MB model in the .exe (which caused Windows extraction
// errors on files >100MB). The user needs an internet connection only
// for the FIRST transcription — after that, the model is cached and
// Whisper works offline.
//
// We use the ORIGINAL (non-quantized) Whisper-tiny for maximum
// transcription quality. Quantized versions would be ~40MB smaller but
// significantly degrade accuracy.
const REMOTE_MODEL_ID = "Xenova/whisper-tiny";

// Singleton pipeline + progress callback. The progress callback is
// stored at module scope so getPipeline can report download progress
// even though it's called from inside the lazy-load promise.
let activeProgressCb: ((p: WhisperProgress) => void) | null = null;

async function getPipeline(): Promise<any> {
  if (pipelinePromise) return pipelinePromise;

  pipelinePromise = (async () => {
    // Dynamic import — Next.js will code-split this chunk.
    const { pipeline, env } = await import("@xenova/transformers");

    // Allow remote model download from the Hugging Face Hub. The model
    // is cached in IndexedDB after the first run, so subsequent runs
    // work offline.
    env.allowRemoteModels = true;
    env.allowLocalModels = false;

    // Report download progress to the UI on the first run (when the
    // model needs to be downloaded from HuggingFace). After the first
    // run, the model is cached in IndexedDB and this callback isn't
    // called (load is near-instant).
    const progress_callback = (info: any) => {
      if (!activeProgressCb) return;
      if (info.status === "progress") {
        // info has: { file, loaded, total, progress, name }
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

    // automatic-speech-recognition with Whisper-tiny (original,
    // non-quantized for maximum quality).
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
  /** Source audio file — any format the browser can decode (mp3, wav, m4a, ogg, webm). */
  audioFile: File;
  /** Optional progress callback. */
  onProgress?: (p: WhisperProgress) => void;
  /** Optional abort signal. */
  signal?: AbortSignal;
  /**
   * Language code for transcription. Use "auto" for automatic language
   * detection (Whisper will detect the spoken language), or pass a
   * 2-letter ISO 639-1 code like "en", "es", "fr", "de", "it", "pt",
   * "nl", "ru", "ja", "ko", "zh", "ar", "hi", "tr", "pl", "vi", "th",
   * "id", "ms", "uk", "el", "he", "cs", "sv", "da", "fi", "no", "hu",
   * "ro", "sk", "sl", "hr", "bg", "sr", "lt", "lv", "et", "fa", "ur",
   * "sw", "ta", "te", "mr", "bn", "gu", "kn", "ml", "pa", "so", "yo",
   * "zu", "af", "ca", "cy", "eo", "eu", "gl", "ht", "is", "ka", "la",
   * "lb", "mg", "mk", "mn", "ne", "sn", "sq", "sr", "st", "tl", "tt",
   * "uz", "xh", "yi".
   * Default: "auto".
   */
  language?: string;
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

  // Wire the progress callback so the first-run download shows
  // per-file progress in the UI.
  activeProgressCb = onProgress ?? null;

  const pipe = await getPipeline();

  onProgress?.({ progress: 25, status: "Transcribing audio…" });
  if (signal?.aborted) throw new Error("Transcription cancelled");

  // Run ASR with chunking enabled + timestamp return.
  // Language: "auto" → Whisper auto-detects; any other 2-letter code
  // forces that language. Whisper-tiny supports 90+ languages.
  const lang = opts.language || "auto";
  const asrOptions: Record<string, unknown> = {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true,
    task: "transcribe",
  };
  if (lang !== "auto") {
    // Whisper expects full language names (e.g. "english", "spanish").
    // Transformers.js also accepts 2-letter codes like "en", "es".
    asrOptions.language = lang;
  }
  // For "auto" mode, we omit the `language` option and Whisper detects
  // it from the first 30 seconds of audio.

  const output: any = await pipe(pcm, asrOptions);

  if (signal?.aborted) throw new Error("Transcription cancelled");
  onProgress?.({ progress: 80, status: "Aligning word timestamps…" });

  // Whisper returns the detected language in output.language when
  // auto-detection is used. Capture it for the result.
  const detectedLang =
    lang === "auto" ? (output?.language ?? null) : lang;

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

  // Clear the progress callback so it doesn't leak into the next call.
  activeProgressCb = null;

  return {
    cues,
    language: detectedLang,
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
