// src/lib/export/AudioMixer.ts — offline audio mixdown + AAC encode (WebCodecs)
// Renders ALL audio lanes onto one 48 kHz stereo timeline with
// OfflineAudioContext, then encodes the result through AudioEncoder in
// 1024-frame f32-planar AudioData chunks so a 19-minute timeline never has
// to exist as one giant AudioData (which would be ~438 MB of planar floats).
//
// v1.8.1 (Task 28-a) — FULL multi-lane mixdown (the WebCodecs engine's
// audio parity round). One AudioBufferSourceNode + GainNode per placement:
//   • music (with music-local fade-in / fade-out automation),
//   • every BASE-lane video clip's audio (trim offset + per-clip volume ×
//     master, speed≠1 clips time-compressed via playbackRate),
//   • every OVERLAY-lane (PIP) video clip's audio — a GPU-engine superset:
//     the FFmpeg graph maps overlay inputs video-only, so the GPU engine is
//     the FIRST engine to mix PIP audio,
//   • every SFX placement (pre-rendered WAV blob URLs from sfx.ts — the
//     exact bytes the FFmpeg path uploads as temp files).
// All branches sum into ONE master DynamicsCompressor limiter (the Web Audio
// twin of the FFmpeg amix normalize=0 → master volume → limiter chain) so a
// summed mix past 0 dBFS is brick-walled instead of hard-clipped by the AAC
// encode.
//
// Documented deviations from the FFmpeg audio bus (kept honest in code):
//   • normalize/loudnorm (2-pass measured) is not part of the offline graph;
//   • speed≠1 uses playbackRate (sync-correct, pitch-shifts) where FFmpeg's
//     atempo preserves pitch;
//   • looping audio wraps [trimIn, end) in buffer time where a looped
//     overlay VIDEO wraps [0, duration) — identical for un-trimmed clips.

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
 * - `durationSec` — how many SOURCE seconds this track plays (the timeline
 *   span it occupies is `durationSec / playbackRate`).
 * - `volume` — linear gain 0..2 (sums >1 are limited, not clipped).
 * - `loop` — loop the source to fill the rest of the timeline.
 * - `playbackRate` — source-time rate (clip speed). 1 = real time; 2× plays
 *   the source window in half the timeline span (atempo's sync twin).
 * - `optional` — true for VIDEO-CLIP audio branches: a fetch/decode failure
 *   (e.g. the MP4 has no audio track at all) skips that placement with a
 *   console warn instead of failing the export. Music/SFX stay required.
 * - `fadeInSec` — gain automation 0 → volume over this many seconds from
 *   `startSec` (music-local fade-in).
 * - `fadeOut` — absolute timeline window ramping volume → 0 (the music
 *   fade-out, which always ENDS at the video end — FFmpeg parity).
 */
export interface AudioTrackData {
  url: string;
  startSec: number;
  offsetSec: number;
  durationSec: number;
  volume: number;
  loop?: boolean;
  playbackRate?: number;
  optional?: boolean;
  fadeInSec?: number;
  fadeOut?: { startSec: number; endSec: number };
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

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
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
   * v1.8.2 `signal`: aborted between tracks / between encode chunks so a
   * restarted encode pass (hardware→software retry) doesn't leave a zombie
   * AAC encode burning CPU into a dead muxer.
   *
   * `loop` semantics: the source is scheduled with `loop = true` and NO
   * duration limit; playback begins at `offsetSec` and loops from there to
   * the end of the buffer, repeatedly. The OfflineAudioContext truncates
   * everything at `timelineSec` — a looping track simply fills the rest of
   * the timeline (this is the "background music pinned to the whole video"
   * case). Non-looping tracks play `durationSec` starting at `startSec`.
   */
  async renderAudio(
    timelineSec: number,
    tracks: AudioTrackData[],
    signal?: AbortSignal,
  ): Promise<AudioMixerResult> {
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

    // ── Master limiter (FFmpeg parity: amix normalize=0 → master volume →
    // limiter). Every branch sums into ONE DynamicsCompressor configured as
    // a brick wall (threshold −1 dBFS, ratio 20:1, no knee). Linear gains
    // are applied per-branch by GainNodes (mathematically identical to
    // FFmpeg's per-branch volume + post-mix master multiplication); the
    // limiter only acts on peaks the SUM pushes past −1 dBFS, which would
    // otherwise hard-clip inside the AAC encode. All branches share the one
    // node, so its ~6 ms lookahead delays everything equally — sync intact.
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.1;
    limiter.connect(context.destination);

    for (const track of tracks) {
      if (signal?.aborted) throw new AudioMixerError("audio render aborted");
      await this.scheduleTrack(context, limiter, track);
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
        if (signal?.aborted) {
          throw new AudioMixerError("audio render aborted");
        }
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

  /**
   * Fetch + decode one track and schedule it on the offline graph:
   * BufferSource → GainNode (volume, optional fade automation) → limiter.
   *
   * `optional` tracks (video-clip audio) swallow fetch/decode failures with
   * a console warn — an MP4/WebM with no audio track must skip, not fail,
   * the export (the FFmpeg path probe-gates the same case).
   */
  private async scheduleTrack(
    context: OfflineAudioContext,
    destination: AudioNode,
    track: AudioTrackData,
  ): Promise<void> {
    let bytes: ArrayBuffer;
    try {
      const res = await fetch(track.url);
      if (!res.ok) {
        throw new AudioMixerError(`fetch failed: ${res.status} ${res.statusText} for ${track.url}`);
      }
      bytes = await res.arrayBuffer();
    } catch (e) {
      if (e instanceof AudioMixerError) {
        if (track.optional) {
          console.warn(`[framefuse] GPU audio: skipping optional track (${e.message})`);
          return;
        }
        throw e;
      }
      if (track.optional) {
        console.warn(`[framefuse] GPU audio: skipping optional track — fetch failed: ${errMessage(e)}`);
        return;
      }
      throw new AudioMixerError(`fetch failed for audio track: ${errMessage(e)}`);
    }
    // decodeAudioData resamples to the context rate (48 kHz).
    let buffer: AudioBuffer;
    try {
      buffer = await context.decodeAudioData(bytes);
    } catch (e) {
      // A video container with NO audio track lands here — optional
      // (video-clip) branches skip; required ones (music/SFX) fail loudly.
      if (track.optional) {
        console.warn(
          `[framefuse] GPU audio: clip has no decodable audio track — skipping (${errMessage(e)})`,
        );
        return;
      }
      throw new AudioMixerError(`decodeAudioData failed for ${track.url}: ${errMessage(e)}`);
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    // Clip speed (base-lane videos): source time advances at `speed`× real
    // time, so the clip's SOURCE window lands inside its (shorter) timeline
    // window — sync-correct with the video arm. Pitch shifts where FFmpeg's
    // atempo preserves it (documented deviation; speed 1 is unaffected).
    const rate = Number.isFinite(track.playbackRate) && (track.playbackRate as number) > 0
      ? (track.playbackRate as number)
      : 1;
    if (rate !== 1) source.playbackRate.value = rate;

    const gain = context.createGain();
    // 0..2 per branch (the limiter guards the summed result past 0 dBFS).
    gain.gain.value = clamp(track.volume, 0, 2);
    source.connect(gain);
    gain.connect(destination);

    const startSec = Math.max(0, track.startSec);
    const offsetSec = Math.min(Math.max(0, track.offsetSec), Math.max(0, buffer.duration - 0.001));

    // Music-local fade automation (FFmpeg's afade twins). The fade-out
    // window is absolute and ends at the VIDEO end — the caller computes it
    // from the timeline length, exactly like the adelay-relative math in
    // buildAudioMixGraph.
    if (Number.isFinite(track.fadeInSec) && (track.fadeInSec as number) > 0) {
      const fi = track.fadeInSec as number;
      gain.gain.setValueAtTime(0, startSec);
      gain.gain.linearRampToValueAtTime(clamp(track.volume, 0, 2), startSec + fi);
    }
    if (
      track.fadeOut &&
      Number.isFinite(track.fadeOut.startSec) &&
      Number.isFinite(track.fadeOut.endSec) &&
      track.fadeOut.endSec > track.fadeOut.startSec
    ) {
      gain.gain.setValueAtTime(clamp(track.volume, 0, 2), Math.max(0, track.fadeOut.startSec));
      gain.gain.linearRampToValueAtTime(0, track.fadeOut.endSec);
    }

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
