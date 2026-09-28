// src/lib/export/audio-tracks.ts — the audio-mix TRACK LIST builder +
// SFX pre-rendering, shared by the engine (main-thread fallback runs) and
// the worker CLIENT (the production path).
//
// v1.15.2 (worker migration, instruction #4 — "Audio Context Worker Check"):
// the W3C Web Audio spec exposes EVERY Web Audio interface as
// [Exposed=Window] (AudioContext, OfflineAudioContext, decodeAudioData —
// none in workers; verified live: a dedicated worker in Chromium throws
// "OfflineAudioContext is not defined"). So the audio arm RUNS ON THE MAIN
// THREAD: this module lets the worker CLIENT pre-render the SFX WAVs +
// build the track list there (Web Audio available), hand the pure track
// data to the worker in the run payload, and stream the mixed/encoded AAC
// chunks back into the worker's muxer (worker-protocol's audio-* messages).
// The mixdown itself (OfflineAudioContext.startRendering) and the AAC
// encode (AudioEncoder's own threads) are async — the video loop in the
// worker never waits on main-thread JS (async boundaries, per the directive).

import type { ExportNativeOptions, MediaSegment } from "@/lib/merger/types";
import { sfxDurationMs, renderSfxWav } from "@/lib/merger/sfx";
import type { AudioTrackData } from "./AudioMixer";

function clampNum(v: number | undefined, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return Math.max(lo, Math.min(hi, n));
}

/** The fetchable source URL of a VIDEO segment (page.tsx maps every item's
 * object URL under the segment id — videos included). Null when only the
 * original File exists (the decoder can still read it via arrayBuffer). */
export function videoSourceUrl(
  seg: MediaSegment,
  imageUrls: Record<string, string>,
): string | null {
  const url = imageUrls[seg.id];
  return typeof url === "string" && url.length > 0 ? url : null;
}

/**
 * Build the AudioMixer track list from the timeline model — EVERY audio
 * lane:
 *  (a) the music track — pinned at musicStartMs, looping when the user
 *      enabled musicLoop OR the track is shorter than the timeline; volume
 *      = master × music; music-local fade-in/fade-out automation (the
 *      fade-out always ENDS at the video end);
 *  (b) every BASE-lane video segment's audio at its timeline position with
 *      its trim offset and per-clip volume (scaled by master); speed≠1
 *      clips time-compress via playbackRate (sync-correct twin of atempo);
 *  (c) every OVERLAY-lane (PIP) video segment's audio — a GPU-engine
 *      SUPERSET: the FFmpeg graph maps overlay inputs video-only;
 *  (d) the pre-rendered SFX placements (synthesized WAV blob URLs, the
 *      exact bytes the FFmpeg path uploads as temp files).
 *
 * Video-clip branches are `optional`: an MP4 with no audio track skips with
 * a warn instead of failing the export (the FFmpeg path probe-gates the
 * same case). Documented deviations vs the FFmpeg audio bus: normalize/
 * loudnorm is not part of the offline graph; playbackRate pitch-shifts
 * where atempo preserves pitch.
 */
export function buildAudioTracks(
  opts: Pick<
    ExportNativeOptions,
    "segments" | "imageUrls" | "audioTrack" | "audio" | "totalMs"
  >,
  sfxTracks: AudioTrackData[],
): AudioTrackData[] {
  const tracks: AudioTrackData[] = [...sfxTracks];
  const totalSec = opts.totalMs / 1000;
  const masterVolume = clampNum(opts.audio?.masterVolume, 0, 2, 1);

  if (opts.audioTrack) {
    const startSec = Math.max(0, clampNum(opts.audio?.musicStartMs, 0, Infinity, 0) / 1000);
    const trackShorter =
      opts.audioTrack.durationMs != null && opts.audioTrack.durationMs < opts.totalMs;
    const musicVolume = masterVolume * clampNum(opts.audio?.musicVolume, 0, 2, 1);
    const fadeInMs = Math.max(0, clampNum(opts.audio?.fadeInMs, 0, Infinity, 0));
    const fadeOutMs = Math.max(0, clampNum(opts.audio?.fadeOutMs, 0, Infinity, 0));
    tracks.push({
      url: opts.audioTrack.url,
      startSec,
      offsetSec: 0,
      durationSec: Math.max(0.01, totalSec - startSec),
      volume: musicVolume,
      loop: opts.audio?.musicLoop === true || trackShorter,
      // Music-local fades — the fade-out window is absolute and ends at the
      // VIDEO end (the adelay-relative math in buildAudioMixGraph's twin).
      ...(fadeInMs > 0 ? { fadeInSec: fadeInMs / 1000 } : {}),
      ...(fadeOutMs > 0
        ? { fadeOut: { startSec: Math.max(0, totalSec - fadeOutMs / 1000), endSec: totalSec } }
        : {}),
    });
  }

  for (const seg of opts.segments) {
    if (seg.mediaType !== "video") continue;
    if (seg.volume <= 0) continue;
    const url = videoSourceUrl(seg, opts.imageUrls);
    if (!url) continue; // File-only sources are decodable but not fetchable
    if ((seg.track ?? 0) >= 1) {
      // (c) PIP/overlay clip audio — speed-1 by design (the export overlay
      // graph is speed-1), looped when the overlay loops.
      tracks.push({
        url,
        startSec: seg.startMs / 1000,
        offsetSec: (seg.trimInMs || 0) / 1000,
        durationSec: seg.durationMs / 1000,
        volume: masterVolume * seg.volume,
        loop: seg.overlayLoop === true,
        optional: true, // no audio track in the container → skip, not fail
      });
      continue;
    }
    // (b) base-lane clip audio — the source window consumed is
    // durationMs × speed buffer-seconds, played back at `speed` so it lands
    // inside the (shorter) timeline window.
    const speed = seg.speed || 1;
    tracks.push({
      url,
      startSec: seg.startMs / 1000,
      offsetSec: (seg.trimInMs || 0) / 1000,
      durationSec: (seg.durationMs / 1000) * speed,
      volume: masterVolume * seg.volume,
      playbackRate: speed,
      optional: true,
    });
  }
  return tracks;
}

/**
 * Pre-render every SFX placement to a WAV blob URL — native.ts IPC parity:
 * one render per unique (sfxId, durMs), cached; failures skip the placement
 * with a console warn instead of failing the export. The caller owns the
 * blob URLs and revokes them when the export finishes.
 *
 * v1.15.2: MUST run on the MAIN thread (renderSfxWav needs
 * OfflineAudioContext — Window-only per spec); the worker client calls this
 * before shipping the run payload.
 */
export async function renderSfxTracks(
  opts: Pick<ExportNativeOptions, "sfx" | "audio">,
  masterVolume: number,
  blobUrls: string[],
): Promise<AudioTrackData[]> {
  const tracks: AudioTrackData[] = [];
  if (!opts.sfx || opts.sfx.length === 0) return tracks;
  const wavCache = new Map<string, { url: string; durationSec: number } | null>();
  for (const item of opts.sfx) {
    if (!item || !item.id || !item.sfxId) continue;
    const itemDurMs = sfxDurationMs(item);
    const cacheKey = `${item.sfxId}:${itemDurMs}`;
    if (!wavCache.has(cacheKey)) {
      let entry: { url: string; durationSec: number } | null = null;
      try {
        const rendered = await renderSfxWav(item.sfxId, itemDurMs);
        if (rendered) {
          const url = URL.createObjectURL(rendered.blob);
          blobUrls.push(url);
          entry = { url, durationSec: rendered.durationMs / 1000 };
        } else {
          console.warn(
            `[framefuse] SFX "${item.sfxId}" could not be rendered (Web Audio unavailable?) — skipping placement ${item.id}`,
          );
        }
      } catch (e) {
        console.warn(`[framefuse] SFX "${item.sfxId}" render failed — skipping placement ${item.id}`, e);
      }
      wavCache.set(cacheKey, entry);
    }
    const cached = wavCache.get(cacheKey);
    if (cached) {
      tracks.push({
        url: cached.url,
        startSec: Math.max(0, item.startMs) / 1000,
        offsetSec: 0,
        durationSec: cached.durationSec,
        // FFmpeg parity: the SFX branch rides clamp(volume, 0, 1) with the
        // master volume applied at the mix bus (linearly identical).
        volume: masterVolume * clampNum(item.volume, 0, 1, 1),
      });
    }
  }
  return tracks;
}

/** The prebuilt audio arm the worker client computes on the main thread. */
export interface PrebuiltAudio {
  tracks: AudioTrackData[];
  /** Main-thread-created SFX WAV blob URLs — owned + revoked by the CLIENT
   * (the worker's mixer fetches them fine: same agent cluster). */
  sfxBlobUrls: string[];
}
