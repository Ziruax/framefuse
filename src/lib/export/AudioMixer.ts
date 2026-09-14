// src/lib/export/AudioMixer.ts — offline audio mixdown + AAC encode (WebCodecs)
// Renders all audio tracks onto one 48 kHz stereo timeline with
// OfflineAudioContext, then encodes the result through AudioEncoder in
// 1024-frame f32-planar AudioData chunks so a 19-minute timeline never has
// to exist as one giant AudioData (which would be ~438 MB of planar floats).

/** Typed error for every AudioMixer failure (fetch/decode/encode). */
export class AudioMixerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioMixerError";
  }
}

/**
 * One audio placement on the export timeline.
 * - `url` — fetchable source (http(s)/blob/file URL).
 * - `startSec` — when the track starts on the export timeline.
 * - `offsetSec` — where inside the SOURCE playback begins.
 * - `durationSec` — how much of the timeline this track plays.
 * - `volume` — linear gain 0..1.
 * - `loop` — loop the source to fill `durationSec` (see renderAudio note).
 */
export interface AudioTrackData {
  url: string;
  startSec: number;
  offsetSec: number;
  durationSec: number;
  volume: number;
  loop?: boolean;
}

/** Result metadata for a completed mixdown. */
export interface AudioMixerResult {
  durationSec: number;
  sampleRate: number;
  numberOfChannels: number;
}

/** Fixed mixdown format: 48 kHz stereo AAC at 128 kbps. */
const SAMPLE_RATE = 48_000;
const NUMBER_OF_CHANNELS = 2;
const AAC_BITRATE = 128_000;
/** AudioData chunk size (frames) — the RAM-chunking unit for encoding. */
const AUDIO_CHUNK_FRAMES = 1024;
/** Encoder backpressure: yield when this many AudioDatas are pending. */
const MAX_ENCODE_QUEUE = 100;

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * True when this runtime can encode stereo 48 kHz AAC (mp4a.40.2). Callers
 * use this to decide whether to attach audio to a GPU export at all.
 */
export async function isAudioEncoderSupported(): Promise<boolean> {
  if (typeof AudioEncoder === "undefined") return false;
  try {
    const support = await AudioEncoder.isConfigSupported({
      codec: "mp4a.40.2",
      sampleRate: SAMPLE_RATE,
      numberOfChannels: NUMBER_OF_CHANNELS,
      bitrate: AAC_BITRATE,
    });
    return support.supported === true;
  } catch {
    return false;
  }
}

/**
 * AudioMixer — renders the audio timeline offline and streams AAC chunks out
 * through the constructor callback (→ the MP4 muxer). One instance per
 * export; `renderAudio` is single-use.
 */
export class AudioMixer {
  /**
   * @param onEncodedChunk Called for every EncodedAudioChunk the encoder
   *   emits. The metadata parameter is `| undefined` because the WebCodecs
   *   `EncodedAudioChunkOutputCallback` contract passes metadata as optional
   *   (it is only guaranteed on the first chunk); the MP4 muxer accepts both.
   */
  constructor(
    private readonly onEncodedChunk: (
      chunk: EncodedAudioChunk,
      meta: EncodedAudioChunkMetadata | undefined,
    ) => void,
  ) {}

  /**
   * Mixdown + encode. Runs concurrently-safe with the video loop: rendering
   * is awaited internally (`startRendering`), and encode chunks flow out via
   * the callback while the caller keeps driving video frames.
   *
   * `loop` semantics: the source is scheduled with `loop = true` and NO
   * duration limit; playback begins at `offsetSec` and loops from there to
   * the end of the buffer, repeatedly. The OfflineAudioContext truncates
   * everything at `timelineSec` — a looping track simply fills the rest of
   * the timeline (this is the "background music pinned to the whole video"
   * case). Non-looping tracks play `durationSec` starting at `startSec`.
   */
  async renderAudio(timelineSec: number, tracks: AudioTrackData[]): Promise<AudioMixerResult> {
    if (timelineSec <= 0) throw new AudioMixerError("audio timeline length must be positive");
    if (tracks.length === 0) {
      throw new AudioMixerError("no audio tracks to render — construct the mixer only for non-empty track lists");
    }
    if (typeof OfflineAudioContext === "undefined") {
      throw new AudioMixerError("OfflineAudioContext is unavailable in this runtime");
    }
    if (typeof AudioEncoder === "undefined") {
      throw new AudioMixerError("WebCodecs AudioEncoder is unavailable in this runtime");
    }

    const length = Math.max(1, Math.ceil(timelineSec * SAMPLE_RATE));
    const context = new OfflineAudioContext({
      numberOfChannels: NUMBER_OF_CHANNELS,
      length,
      sampleRate: SAMPLE_RATE,
    });

    for (const track of tracks) {
      await this.scheduleTrack(context, track);
    }

    let rendered: AudioBuffer;
    try {
      rendered = await context.startRendering();
    } catch (e) {
      throw new AudioMixerError(`offline audio render failed: ${errMessage(e)}`);
    }

    // Encode the rendered buffer as chunked planar f32 AudioData → AAC.
    const supported = await isAudioEncoderSupported();
    if (!supported) {
      throw new AudioMixerError(
        "AAC (mp4a.40.2) encoding is not supported by this runtime — skip audio or pick another codec",
      );
    }

    let encodeFatal: unknown = null;
    const encoder = new AudioEncoder({
      output: (chunk: EncodedAudioChunk, meta: EncodedAudioChunkMetadata | undefined): void => {
        this.onEncodedChunk(chunk, meta);
      },
      error: (e: DOMException): void => {
        encodeFatal = e;
      },
    });
    encoder.configure({
      codec: "mp4a.40.2",
      sampleRate: SAMPLE_RATE,
      numberOfChannels: NUMBER_OF_CHANNELS,
      bitrate: AAC_BITRATE,
    });

    try {
      // Planar channel data; a mono render still maps to 2 channels (the
      // context is stereo, but be defensive for numberOfChannels < 2).
      const left = rendered.getChannelData(0);
      const right = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : left;
      const totalFrames = rendered.length;

      for (let offset = 0; offset < totalFrames; offset += AUDIO_CHUNK_FRAMES) {
        if (encodeFatal) break;
        if (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
          // Soft backpressure: yield a tick so the encoder drains before we
          // queue more 21 ms chunks (hard bounded — encode is much faster
          // than real time, this only smooths the 54k-chunk 19-min case).
          await delay(5);
        }
        const frames = Math.min(AUDIO_CHUNK_FRAMES, totalFrames - offset);
        // f32-planar: one plane per channel, planes concatenated.
        const data = new Float32Array(frames * NUMBER_OF_CHANNELS);
        data.set(left.subarray(offset, offset + frames), 0);
        data.set(right.subarray(offset, offset + frames), frames);
        const audioData = new AudioData({
          format: "f32-planar",
          sampleRate: SAMPLE_RATE,
          numberOfFrames: frames,
          numberOfChannels: NUMBER_OF_CHANNELS,
          timestamp: Math.round((offset / SAMPLE_RATE) * 1e6),
          data,
        });
        try {
          encoder.encode(audioData);
        } catch (e) {
          encodeFatal = e;
        } finally {
          // Free the chunk's buffer immediately on every path (encode()
          // hands the data to the encoder; close() is idempotent).
          audioData.close();
        }
        if (encodeFatal) break;
      }
      if (encodeFatal) {
        throw new AudioMixerError(`audio encode failed: ${errMessage(encodeFatal)}`);
      }
      try {
        await encoder.flush();
      } catch (e) {
        throw new AudioMixerError(`audio encode flush failed: ${errMessage(e)}`);
      }
      if (encodeFatal) {
        throw new AudioMixerError(`audio encode failed: ${errMessage(encodeFatal)}`);
      }
    } finally {
      // Single ownership: exactly one close() on every path (success,
      // encode error, flush rejection). close() resets the encoder and
      // releases its resources; it is valid in any state.
      encoder.close();
    }

    return {
      durationSec: rendered.duration,
      sampleRate: SAMPLE_RATE,
      numberOfChannels: NUMBER_OF_CHANNELS,
    };
  }

  /** Fetch + decode one track and schedule it on the offline graph. */
  private async scheduleTrack(context: OfflineAudioContext, track: AudioTrackData): Promise<void> {
    let bytes: ArrayBuffer;
    try {
      const res = await fetch(track.url);
      if (!res.ok) {
        throw new AudioMixerError(`fetch failed: ${res.status} ${res.statusText} for ${track.url}`);
      }
      bytes = await res.arrayBuffer();
    } catch (e) {
      if (e instanceof AudioMixerError) throw e;
      throw new AudioMixerError(`fetch failed for audio track: ${errMessage(e)}`);
    }
    // decodeAudioData resamples to the context rate (48 kHz).
    let buffer: AudioBuffer;
    try {
      buffer = await context.decodeAudioData(bytes);
    } catch (e) {
      throw new AudioMixerError(`decodeAudioData failed for ${track.url}: ${errMessage(e)}`);
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    const gain = context.createGain();
    gain.gain.value = Math.min(1, Math.max(0, track.volume));
    source.connect(gain);
    gain.connect(context.destination);

    const startSec = Math.max(0, track.startSec);
    const offsetSec = Math.min(Math.max(0, track.offsetSec), Math.max(0, buffer.duration - 0.001));
    if (track.loop) {
      source.loop = true;
      source.loopStart = offsetSec;
      // loopEnd 0 = "until the end of the buffer" (the spec default).
      // No duration limit: the context itself truncates at timelineSec.
      source.start(startSec, offsetSec);
    } else {
      const durationSec = Math.max(0, Math.min(track.durationSec, buffer.duration - offsetSec));
      source.start(startSec, offsetSec, durationSec);
    }
  }
}
