// src/lib/export/SourceDecoder.ts — GPU source demux + decode (mp4box → VideoDecoder)
// One instance demuxes ONE MP4 (H.264/VP9) with mp4box and decodes it through
// the WebCodecs VideoDecoder, exposing a pull API:
//   getFrameForTimestamp(ms) → a CLONE the caller owns (close() it!).
// The decoder OWNS the internal frame queue and closes every frame exactly
// once — on eviction, on rewind, and in cleanup() — so VRAM stays bounded
// no matter how long the export runs.

import {
  createFile,
  type ISOFile,
  type Movie,
  type MP4BoxBuffer,
  type Sample,
  type Track,
  type VisualSampleEntry,
} from "mp4box";

/** Typed error thrown for every SourceDecoder failure (demux, config, decode). */
export class SourceDecoderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceDecoderError";
  }
}

/** A decoded frame held in the decoder-owned queue (closed exactly once). */
interface QueuedFrame {
  timestampUs: number;
  frame: VideoFrame;
}

/**
 * Structural view of mp4box's parsed `avcC` box. The concrete `avcCBox` class
 * is not part of mp4box's public type surface, but `VisualSampleEntry.avcC`
 * exposes these fields and the runtime object satisfies this shape.
 */
interface AvcCBoxView {
  AVCProfileIndication: number;
  profile_compatibility: number;
  AVCLevelIndication: number;
  lengthSizeMinusOne: number;
  SPS: Array<{ data: Uint8Array }>;
  PPS: Array<{ data: Uint8Array }>;
  ext?: Uint8Array;
}

/** Sample batches requested from mp4box per extraction `start()` pulse. */
const SAMPLES_PER_BATCH = 64;
/** Decode feeding pauses above this many pending decode() calls. */
const MAX_DECODE_QUEUE = 8;
/**
 * A wake with no progress for this many consecutive cycles = stalled decoder.
 * v1.8.2: tightened from 30s×10 (5 full minutes of a 0% export bar before the
 * error!) to 15s×4 — a healthy decoder emits frames/dequeue events constantly,
 * so 60s of TOTAL silence means the hardware decode session is wedged.
 */
const WAKE_TIMEOUT_MS = 15_000;
const MAX_STALLED_WAKES = 4;

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Build the AVCDecoderConfigurationRecord (ISO/IEC 14496-15 §5.3.3.1) from a
 * parsed avcC box. This is EXACTLY what the WebCodecs `description` field
 * expects for H.264-in-MP4: the avcC box CONTENT without its box header
 * (1-byte version, profile/compat/level, 0xFC|lengthSizeMinusOne, 0xE0|SPS
 * count, 2-byte-length-prefixed SPS/PPS arrays, trailing extension bytes).
 */
function buildAvcDecoderConfigRecord(avcC: AvcCBoxView): Uint8Array | null {
  const sps: Uint8Array[] = [];
  for (const n of avcC.SPS) if (n.data && n.data.byteLength > 0) sps.push(n.data);
  const pps: Uint8Array[] = [];
  for (const n of avcC.PPS) if (n.data && n.data.byteLength > 0) pps.push(n.data);
  if (sps.length === 0 || pps.length === 0) return null;
  const ext = avcC.ext && avcC.ext.byteLength > 0 ? avcC.ext : null;

  let size = 6; // version + profile + compat + level + lengthSize + SPS count
  for (const n of sps) size += 2 + n.byteLength;
  size += 1; // PPS count byte
  for (const n of pps) size += 2 + n.byteLength;
  if (ext) size += ext.byteLength;

  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out[0] = 1; // configurationVersion
  out[1] = avcC.AVCProfileIndication & 0xff;
  out[2] = avcC.profile_compatibility & 0xff;
  out[3] = avcC.AVCLevelIndication & 0xff;
  out[4] = 0xfc | (avcC.lengthSizeMinusOne & 3); // 6 reserved bits + lengthSizeMinusOne
  out[5] = 0xe0 | (sps.length & 0x1f); // 3 reserved bits + numOfSequenceParameterSets
  let o = 6;
  for (const n of sps) {
    dv.setUint16(o, n.byteLength, false);
    out.set(n, o + 2);
    o += 2 + n.byteLength;
  }
  out[o++] = pps.length & 0xff;
  for (const n of pps) {
    dv.setUint16(o, n.byteLength, false);
    out.set(n, o + 2);
    o += 2 + n.byteLength;
  }
  if (ext) {
    out.set(ext, o);
    o += ext.byteLength;
  }
  return o === size ? out : out.subarray(0, o);
}

/**
 * Convert one length-prefixed (AVCC) sample to Annex B start-code format —
 * the documented fallback for runtimes that reject the avcC `description`.
 * `prependNalus` (in-band SPS/PPS) is emitted first so key frames carry the
 * parameter sets Annex B decoders require.
 */
function convertAvccSampleToAnnexB(
  sample: Uint8Array,
  nalLengthSize: number,
  prependNalus: readonly Uint8Array[] | null,
): Uint8Array {
  const nalus: Array<{ start: number; length: number }> = [];
  let pos = 0;
  while (pos + nalLengthSize <= sample.byteLength) {
    let len = 0;
    for (let i = 0; i < nalLengthSize; i++) len = len * 256 + sample[pos + i];
    pos += nalLengthSize;
    if (len <= 0 || pos + len > sample.byteLength) break; // corrupt trailing bytes — drop them
    nalus.push({ start: pos, length: len });
    pos += len;
  }
  let size = 0;
  if (prependNalus) for (const n of prependNalus) size += 4 + n.byteLength;
  for (const n of nalus) size += 4 + n.length;
  const out = new Uint8Array(size);
  let o = 0;
  const emit = (bytes: Uint8Array): void => {
    out[o] = 0;
    out[o + 1] = 0;
    out[o + 2] = 0;
    out[o + 3] = 1; // Annex B start code
    o += 4;
    out.set(bytes, o);
    o += bytes.byteLength;
  };
  if (prependNalus) for (const n of prependNalus) emit(n);
  for (const n of nalus) emit(sample.subarray(n.start, n.start + n.length));
  return o === size ? out : out.subarray(0, o);
}

/** Find the video sample entry (avcC/vpcC carrier) among all stsd boxes. */
function findVideoSampleEntry(file: ISOFile, videoCodec: string): VisualSampleEntry | null {
  const stsdBoxes = file.getBoxes("stsd", false);
  for (const stsd of stsdBoxes) {
    for (const entry of stsd.entries) {
      if (!entry.isVideo()) continue;
      if (entry.getCodec() === videoCodec) return entry as VisualSampleEntry;
    }
  }
  // Codec-string mismatch (rare description_index variants) — take any visual entry.
  for (const stsd of stsdBoxes) {
    const hit = stsd.entries.find((e) => e.isVideo());
    if (hit) return hit as VisualSampleEntry;
  }
  return null;
}

/**
 * SourceDecoder — GPU decode of one MP4 source for the export pipeline.
 *
 * OWNERSHIP CONTRACT (VRAM discipline):
 * - `getFrameForTimestamp()` returns a CLONE (`new VideoFrame(queued)`) that
 *   the CALLER owns. The caller MUST call `.close()` on it immediately after
 *   its last use (i.e. right after `drawImage`) — not doing so leaks GPU
 *   memory proportional to the export length.
 * - The decoder itself owns its internal queue and closes every frame
 *   exactly once: strictly-older-than-target frames are closed on eviction,
 *   all remaining frames are closed in `cleanup()` / on rewind. `cleanup()`
 *   is idempotent and safe from any error path.
 * - Calls are expected to be MONOTONIC in timestamp per instance (the export
 *   loop walks the timeline forward; slow-motion re-requests the same time,
 *   which is fine). A request that goes BACKWARD below the last served
 *   timestamp takes the documented slow path: full decoder teardown +
 *   re-init + decode-and-drop from the start (dropped frames are closed).
 *
 * RAM profile: the source ArrayBuffer is kept alive for the instance's
 * lifetime (needed for the rewind path); mp4box extraction is paced to one
 * 64-sample batch at a time via `stop()`/`start()` and consumed batches are
 * released with `releaseUsedSamples()`, so sample-data copies never
 * accumulate.
 */
export class SourceDecoder {
  /** Pristine source bytes (kept for the rewind path; dropped on cleanup). */
  private sourceBuffer: ArrayBuffer | null;
  private mp4file: ISOFile | null = null;
  private decoder: VideoDecoder | null = null;

  private trackId = -1;
  private timescale = 1;
  private nbSamplesTotal = 0;
  private durationMs_ = 0;
  private width_ = 0;
  private height_ = 0;
  private codec_ = "";

  /** avcC description for the decoder config (AVC only). */
  private description: Uint8Array | null = null;
  /** Annex B fallback mode: convert samples + prepend in-band SPS/PPS. */
  private annexB = false;
  private nalLengthSize = 4;
  private annexBHeaderNalus: Uint8Array[] = [];

  private pendingSamples: Sample[] = [];
  private frameQueue: QueuedFrame[] = [];
  private extractedCount = 0;
  private samplesExhausted = false;
  private flushStarted = false;
  private decoderEof = false;
  private decoderFatal: unknown = null;
  private decodedCount = 0;
  private lastServedRequestUs: number | null = null;
  private wakeups: Array<() => void> = [];
  private cleanedUp = false;

  /** Source duration in ms (from the movie header, available after init). */
  get durationMs(): number {
    return this.durationMs_;
  }
  /** Coded width of the video track. */
  get width(): number {
    return this.width_;
  }
  /** Coded height of the video track. */
  get height(): number {
    return this.height_;
  }
  /** Codec string, e.g. "avc1.42E01E" or "vp09.00.10.08". */
  get codec(): string {
    return this.codec_;
  }
  /** Number of frames the decoder emitted (diagnostic / smoke tests). */
  get decodedFrameCount(): number {
    return this.decodedCount;
  }

  /** Use the static factories ({@link fromUrl} / {@link fromBuffer}). */
  private constructor(sourceBuffer: ArrayBuffer) {
    this.sourceBuffer = sourceBuffer;
  }

  /**
   * Create a decoder from a fetchable URL. The whole file is fetched up front
   * (one request) and kept for the instance lifetime.
   */
  static async fromUrl(url: string): Promise<SourceDecoder> {
    let bytes: ArrayBuffer;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new SourceDecoderError(`fetch failed: ${res.status} ${res.statusText} for ${url}`);
      }
      bytes = await res.arrayBuffer();
    } catch (e) {
      if (e instanceof SourceDecoderError) throw e;
      throw new SourceDecoderError(`fetch failed for ${url}: ${errMessage(e)}`);
    }
    return SourceDecoder.fromBuffer(bytes);
  }

  /**
   * Create a decoder from in-memory MP4 bytes. The buffer is taken as-is
   * (no copy) and stays referenced until {@link cleanup}.
   */
  static async fromBuffer(buffer: ArrayBuffer): Promise<SourceDecoder> {
    if (!buffer || buffer.byteLength === 0) {
      throw new SourceDecoderError("source buffer is empty");
    }
    const dec = new SourceDecoder(buffer);
    await dec.init();
    return dec;
  }

  // ── init ────────────────────────────────────────────────────────────────

  private async init(): Promise<void> {
    if (!this.sourceBuffer) throw new SourceDecoderError("source buffer missing");
    await this.initFromBuffer(this.sourceBuffer);
  }

  /**
   * Full (re-)initialization: fresh mp4box instance + decoder. Used by init
   * and by the rewind path (which passes a pristine copy of the source).
   */
  private async initFromBuffer(buffer: ArrayBuffer): Promise<void> {
    if (typeof VideoDecoder === "undefined") {
      throw new SourceDecoderError("WebCodecs VideoDecoder is unavailable in this runtime");
    }
    // keepMdatData=true is REQUIRED for sample extraction: with the default
    // (discardMdatData) mp4box marks mdat bytes as consumable and never
    // produces sample data.
    const file = createFile(true);
    this.mp4file = file;

    let movie: Movie | null = null;
    file.onReady = (info: Movie): void => {
      movie = info;
    };
    file.onSamples = (id: number, _user: unknown, samples: Sample[]): void => {
      this.handleSamples(id, samples);
    };

    // Classic mp4box contract: the appended ArrayBuffer must carry fileStart.
    const mp4buf = buffer as MP4BoxBuffer;
    mp4buf.fileStart = 0;
    try {
      file.appendBuffer(mp4buf);
      file.flush();
    } catch (e) {
      throw new SourceDecoderError(`mp4box failed to parse source: ${errMessage(e)}`);
    }
    // Re-read through a cast — TS's flow analysis can't see the synchronous
    // callback assignment inside appendBuffer (it narrows `movie` to null).
    const movieInfo = movie as Movie | null;
    if (!movieInfo) {
      throw new SourceDecoderError("not a valid MP4 (no moov box parsed)");
    }
    const track: Track | undefined =
      movieInfo.videoTracks[0] ?? movieInfo.tracks.find((t) => t.type === "video");
    if (!track) {
      throw new SourceDecoderError("source MP4 has no video track (audio-only?)");
    }
    this.trackId = track.id;
    this.timescale = track.timescale > 0 ? track.timescale : 1;
    this.nbSamplesTotal = track.nb_samples;
    this.durationMs_ = (track.duration / this.timescale) * 1000;
    this.width_ = track.video?.width ?? Math.round(track.track_width);
    this.height_ = track.video?.height ?? Math.round(track.track_height);
    this.codec_ = track.codec;
    if (!this.codec_ || this.width_ <= 0 || this.height_ <= 0) {
      throw new SourceDecoderError(`unsupported video track (codec "${this.codec_}", ${this.width_}x${this.height_})`);
    }

    // Codec config: AVC uses the manually-built AVCDecoderConfigurationRecord;
    // VP9/AV1 bitstreams are self-describing (profile rides in the codec string).
    const entry = findVideoSampleEntry(file, this.codec_);
    const avcC = entry?.avcC;
    if (avcC && avcC.SPS && avcC.SPS.length > 0 && avcC.PPS && avcC.PPS.length > 0) {
      this.description = buildAvcDecoderConfigRecord(avcC as AvcCBoxView);
      this.nalLengthSize = (avcC.lengthSizeMinusOne & 3) + 1;
      const headerNalus: Uint8Array[] = [];
      for (const n of avcC.SPS) if (n.data && n.data.byteLength > 0) headerNalus.push(n.data);
      for (const n of avcC.PPS) if (n.data && n.data.byteLength > 0) headerNalus.push(n.data);
      this.annexBHeaderNalus = headerNalus;
    }

    // Configure the VideoDecoder, with the documented Annex B fallback for
    // runtimes that reject the avcC description (rare; mostly MSE-less builds).
    const config: VideoDecoderConfig = {
      codec: this.codec_,
      codedWidth: this.width_,
      codedHeight: this.height_,
    };
    if (this.description) config.description = this.description;
    let supported = false;
    try {
      const support = await VideoDecoder.isConfigSupported(config);
      supported = support.supported === true;
    } catch {
      supported = false;
    }
    if (!supported && this.description) {
      delete config.description;
      this.annexB = true;
      try {
        const support = await VideoDecoder.isConfigSupported(config);
        supported = support.supported === true;
      } catch {
        supported = false;
      }
    }
    if (!supported) {
      throw new SourceDecoderError(
        `VideoDecoder does not support codec ${this.codec_} (${this.width_}x${this.height_})`,
      );
    }

    const decoder = new VideoDecoder({
      output: (frame: VideoFrame): void => this.handleDecodedFrame(frame),
      error: (e: DOMException): void => {
        this.decoderFatal = e;
        this.wake();
      },
    });
    // "dequeue" (decodeQueueSize dropped) paces the feeding loop.
    decoder.addEventListener("dequeue", () => this.wake());
    decoder.configure(config);
    this.decoder = decoder;
    this.decoderFatal = null;
    this.decoderEof = false;
    this.flushStarted = false;
    this.extractedCount = 0;
    this.samplesExhausted = false;
    this.pendingSamples = [];

    // Begin paced extraction: start() delivers ONE 64-sample batch
    // synchronously; handleSamples() calls stop() to halt the sweep.
    file.setExtractionOptions(this.trackId, null, { nbSamples: SAMPLES_PER_BATCH });
    file.start();
  }

  // ── mp4box / decoder event plumbing ─────────────────────────────────────

  private handleSamples(id: number, samples: Sample[]): void {
    if (id !== this.trackId || this.cleanedUp) return;
    for (const s of samples) this.pendingSamples.push(s);
    this.extractedCount += samples.length;
    if (this.nbSamplesTotal > 0 && this.extractedCount >= this.nbSamplesTotal) {
      this.samplesExhausted = true;
    }
    // Pause mp4box's synchronous extraction sweep — the feed loop re-arms it
    // with start() when it needs the next batch. Without this, one start()
    // would extract EVERY sample (and its data copy) into RAM at once.
    this.mp4file?.stop();
  }

  private handleDecodedFrame(frame: VideoFrame): void {
    if (this.cleanedUp) {
      // Nobody will ever consume this frame — close it immediately.
      frame.close();
      return;
    }
    this.decodedCount++;
    // Insert sorted by timestamp (defensive: WebCodecs already emits in
    // presentation order, but B-frame pipelines make this cheap insurance).
    const entry: QueuedFrame = { timestampUs: frame.timestamp, frame };
    let i = this.frameQueue.length;
    while (i > 0 && this.frameQueue[i - 1].timestampUs > entry.timestampUs) i--;
    this.frameQueue.splice(i, 0, entry);
    this.wake();
  }

  /** Resolve every waiter (new frame / dequeue / eof / fatal error). */
  private wake(): void {
    const waiters = this.wakeups;
    this.wakeups = [];
    for (const w of waiters) w();
  }

  /**
   * Wait for a decoder event. Resolves true when woken by an event, false on
   * timeout. Never rejects — callers re-check state after resolving.
   */
  private waitForWake(timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (v: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const i = this.wakeups.indexOf(wake);
        if (i >= 0) this.wakeups.splice(i, 1);
        resolve(v);
      };
      const wake = (): void => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.wakeups.push(wake);
    });
  }

  // ── feeding ─────────────────────────────────────────────────────────────

  /**
   * Feed the decoder while it has capacity, pulling new mp4box batches as
   * needed. Synchronous; called from the pull loop which awaits wakeups.
   */
  private pump(): void {
    const decoder = this.decoder;
    if (!decoder || this.cleanedUp) return;
    for (;;) {
      if (this.decoderFatal) return;
      if (decoder.decodeQueueSize > MAX_DECODE_QUEUE) return; // paced by "dequeue"
      if (this.pendingSamples.length === 0) {
        if (!this.pullNextBatch()) {
          this.beginFlush();
          return;
        }
        continue;
      }
      const sample = this.pendingSamples.shift();
      if (!sample) continue;
      if (sample.data && sample.data.byteLength > 0) {
        const chunk = this.makeChunk(sample);
        try {
          decoder.decode(chunk);
        } catch (e) {
          this.decoderFatal = e;
          this.wake();
          return;
        }
      }
      // Release the sample's data copy back to mp4box (RAM safety: without
      // this the parsed sample bytes stay referenced for the file's lifetime).
      // sample.number is 0-based; +1 releases through that index inclusive.
      this.mp4file?.releaseUsedSamples(this.trackId, sample.number + 1);
    }
  }

  /** Pull the next 64-sample extraction batch; false when exhausted. */
  private pullNextBatch(): boolean {
    if (!this.mp4file || this.samplesExhausted || this.cleanedUp) return false;
    const before = this.extractedCount;
    this.mp4file.start();
    if (this.extractedCount === before) {
      // start() delivered nothing — treat as exhausted (defensive: avoids a
      // spin when the track has no more extractable samples).
      this.samplesExhausted = true;
      return false;
    }
    return true;
  }

  private beginFlush(): void {
    if (this.flushStarted || !this.decoder || this.cleanedUp || !this.samplesExhausted) return;
    this.flushStarted = true;
    this.decoder
      .flush()
      .then(() => {
        this.decoderEof = true;
        this.wake();
      })
      .catch((e: unknown) => {
        this.decoderFatal = e;
        this.wake();
      });
  }

  private makeChunk(sample: Sample): EncodedVideoChunk {
    const data = sample.data as Uint8Array;
    const timestamp = Math.round((sample.cts / this.timescale) * 1e6);
    const duration = Math.round((sample.duration / this.timescale) * 1e6);
    if (!this.annexB) {
      return new EncodedVideoChunk({
        type: sample.is_sync ? "key" : "delta",
        timestamp,
        duration,
        data,
      });
    }
    // Annex B fallback: strip 4-byte NAL length prefixes → start codes, and
    // prepend in-band SPS/PPS on key frames (parameter sets live in the
    // description in AVCC form, so they must be re-injected here).
    const converted = convertAvccSampleToAnnexB(
      data,
      this.nalLengthSize,
      sample.is_sync ? this.annexBHeaderNalus : null,
    );
    return new EncodedVideoChunk({
      type: sample.is_sync ? "key" : "delta",
      timestamp,
      duration,
      data: converted,
    });
  }

  // ── pull API ────────────────────────────────────────────────────────────

  /**
   * Resolve the source frame for `timestampMs` (largest decoded frame
   * timestamp ≤ the request, clamped to the first frame before it) as a CLONE
   * the CALLER owns — close() it immediately after drawing.
   *
   * Drives decoding forward until the queue covers the requested time, evicts
   * (and closes) queue frames strictly older than the frame that will be
   * served — the served frame itself is RETAINED so slow-motion output can
   * re-request the same source frame without a re-decode.
   */
  async getFrameForTimestamp(timestampMs: number): Promise<VideoFrame> {
    if (this.cleanedUp) throw new SourceDecoderError("SourceDecoder was cleaned up");
    if (!this.decoder) throw new SourceDecoderError("SourceDecoder is not initialized");
    if (this.decoderFatal) {
      throw new SourceDecoderError(`source decoder failed: ${errMessage(this.decoderFatal)}`);
    }
    const targetUs = Math.round(timestampMs * 1000);
    if (this.lastServedRequestUs !== null && targetUs < this.lastServedRequestUs) {
      await this.rewindTo(targetUs);
    }

    let stalledWakes = 0;
    for (;;) {
      if (this.decoderFatal) {
        throw new SourceDecoderError(`source decoder failed: ${errMessage(this.decoderFatal)}`);
      }
      this.pump();

      // Serving frame = largest queue timestamp ≤ target (queue is sorted).
      let serveIdx = -1;
      for (let i = 0; i < this.frameQueue.length; i++) {
        if (this.frameQueue[i].timestampUs <= targetUs) serveIdx = i;
        else break;
      }
      // Evict + CLOSE every frame strictly older than the serving candidate.
      // (Future frames ≤ target can only make the candidate NEWER, so older
      // candidates can never serve again under monotonic requests.)
      if (serveIdx > 0) {
        for (let i = 0; i < serveIdx; i++) this.frameQueue[i].frame.close();
        this.frameQueue.splice(0, serveIdx);
        serveIdx = 0;
      }

      const covered =
        (serveIdx >= 0 && (serveIdx + 1 < this.frameQueue.length || this.decoderEof)) ||
        (serveIdx < 0 && this.decoderEof && this.frameQueue.length > 0);
      if (covered) {
        const queued = this.frameQueue[serveIdx >= 0 ? serveIdx : 0];
        let clone: VideoFrame;
        try {
          clone = new VideoFrame(queued.frame); // clone → caller-owned
        } catch (e) {
          throw new SourceDecoderError(`failed to clone decoded frame: ${errMessage(e)}`);
        }
        this.lastServedRequestUs = targetUs;
        return clone;
      }
      if (this.decoderEof && this.frameQueue.length === 0) {
        throw new SourceDecoderError(
          `source has no decodable frame for ${timestampMs.toFixed(1)} ms (decoded ${this.decodedCount} frames)`,
        );
      }

      const woke = await this.waitForWake(WAKE_TIMEOUT_MS);
      stalledWakes = woke ? 0 : stalledWakes + 1;
      if (stalledWakes >= MAX_STALLED_WAKES) {
        throw new SourceDecoderError(
          `source decoder stalled (no output for ${MAX_STALLED_WAKES * WAKE_TIMEOUT_MS} ms)`,
        );
      }
    }
  }

  /**
   * BACKWARD-SEEK slow path (documented): a request below the last served
   * timestamp can't be answered — evicted frames are gone. Tear the decoder
   * and mp4box instance down (closing every owned frame), re-init from a
   * pristine copy of the source bytes, and let the normal pull loop
   * decode-and-drop until it covers the target (dropped frames are closed by
   * the eviction step). Correct but O(target) — callers should keep requests
   * monotonic.
   */
  private async rewindTo(targetUs: number): Promise<void> {
    // Close every owned frame exactly once.
    for (const q of this.frameQueue) q.frame.close();
    this.frameQueue = [];
    this.pendingSamples = [];
    if (this.decoder) {
      this.decoder.close();
      this.decoder = null;
    }
    if (this.mp4file) {
      this.mp4file.stop();
      this.mp4file.releaseUsedSamples(this.trackId, this.nbSamplesTotal);
      this.mp4file = null;
    }
    this.decoderFatal = null;
    this.decoderEof = false;
    this.flushStarted = false;
    this.extractedCount = 0;
    this.samplesExhausted = false;
    this.wake();

    if (!this.sourceBuffer) throw new SourceDecoderError("source buffer missing on rewind");
    // slice(0) = pristine copy: the live buffer carries mp4box bookkeeping
    // (fileStart / usedBytes expandos) from the previous run.
    await this.initFromBuffer(this.sourceBuffer.slice(0));
    this.lastServedRequestUs = targetUs;
  }

  // ── teardown ────────────────────────────────────────────────────────────

  /**
   * Close everything this instance owns: all queued frames (exactly once),
   * the VideoDecoder, and the mp4box instance (stop extraction + release the
   * remaining sample data). Idempotent and safe from any error path. After
   * cleanup the instance cannot be reused.
   */
  cleanup(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;

    for (const q of this.frameQueue) q.frame.close();
    this.frameQueue = [];

    this.pendingSamples = [];

    if (this.decoder) {
      this.decoder.close(); // releases any in-flight decode work + GPU resources
      this.decoder = null;
    }
    if (this.mp4file) {
      this.mp4file.stop();
      if (this.trackId >= 0 && this.nbSamplesTotal > 0) {
        // Release whatever sample data is still held (unfed batches).
        this.mp4file.releaseUsedSamples(this.trackId, this.nbSamplesTotal);
      }
      this.mp4file = null; // ISOFile has no close(): dropping it drops all sample data
    }
    this.sourceBuffer = null; // rewind is impossible after cleanup — release the bytes
    this.wake();
  }
}
