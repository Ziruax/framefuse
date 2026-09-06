// src/lib/merger/native.ts — export orchestration
// Primary: native FFmpeg (Electron). Browser preview fallbacks:
//   1. WebCodecs + mp4-muxer (fast MP4)
//   2. MediaRecorder (real-time WebM)
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import type {
  ExportNativeOptions,
  ExportProgress,
  ExportResult,
  MediaSegment,
} from "./types";
import { drawFrame, resolveDimensions } from "./renderer";

/** True when running inside the FrameFuse Electron shell. */
export function isElectron(): boolean {
  return typeof window !== "undefined" && !!window.electronAPI;
}

function fetchBytes(url: string): Promise<ArrayBuffer> {
  return fetch(url).then((r) => r.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Native FFmpeg path (Electron)
// ---------------------------------------------------------------------------
async function exportViaFFmpeg(opts: ExportNativeOptions): Promise<ExportResult> {
  const api = window.electronAPI!;
  const { segments, imageUrls, audioTrack, settings, kenBurns, onProgress, signal } =
    opts;

  const dims = resolveDimensions(settings.aspect, settings.resolution);

  // 1. Persist images to temp files.
  const segPayload: { imagePath: string; direction: string; durationMs: number }[] =
    [];
  for (const seg of segments) {
    const url = imageUrls[seg.id] || seg.thumbnailUrl;
    const bytes = await fetchBytes(url);
    const imagePath = await api.saveTempImage({
      name: seg.fileName || `seg_${seg.id}.jpg`,
      bytes,
    });
    segPayload.push({
      imagePath,
      direction: seg.direction,
      durationMs: seg.durationMs,
    });
  }

  // 2. Persist audio if present.
  let audioPath: string | null = null;
  if (audioTrack) {
    const bytes = await fetchBytes(audioTrack.url);
    audioPath = await api.saveTempAudio({
      name: audioTrack.fileName,
      bytes,
    });
  }

  // 3. Choose output path.
  const outputPath = await api.chooseOutput();
  if (!outputPath) {
    await api.cleanupTemp();
    throw new Error("Export cancelled");
  }

  // 4. Subscribe to progress.
  const unsubscribe = api.onExportProgress((d: ExportProgress) => {
    onProgress?.(d);
  });

  const onAbort = () => {
    api.cancelExport();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const result = await api.exportNative({
      outputPath,
      fps: settings.fps,
      width: dims.w,
      height: dims.h,
      bitrateMbps: settings.bitrateMbps,
      kenBurns,
      segments: segPayload,
      audioPath,
    });
    return result;
  } finally {
    unsubscribe();
    if (signal) signal.removeEventListener("abort", onAbort);
    await api.cleanupTemp();
  }
}

// ---------------------------------------------------------------------------
// Browser fallback 1: WebCodecs + mp4-muxer (fast MP4)
// ---------------------------------------------------------------------------
async function exportViaWebCodecs(
  opts: ExportNativeOptions,
): Promise<ExportResult> {
  const { segments, imageUrls, settings, kenBurns, totalMs, onProgress, signal } =
    opts;

  const W = typeof window !== "undefined" ? (window as any) : null;
  const VideoEncoderCtor = W?.VideoEncoder;
  const VideoFrameCtor = W?.VideoFrame;
  if (!VideoEncoderCtor || !VideoFrameCtor) {
    throw new Error("NO_WEBCODECS");
  }

  // Cap browser export at 720p for performance.
  const dims = resolveDimensions(settings.aspect, "720p");
  const fps = settings.fps;
  const totalFrames = Math.max(1, Math.round((totalMs / 1000) * fps));

  const canvas = document.createElement("canvas");
  canvas.width = dims.w;
  canvas.height = dims.h;
  const ctx = canvas.getContext("2d", { alpha: false })!;

  // Preload all images.
  const imgCache = new Map<string, HTMLImageElement>();
  await Promise.all(
    segments.map(
      (seg) =>
        new Promise<void>((resolve) => {
          const url = imageUrls[seg.id] || seg.thumbnailUrl;
          const img = new Image();
          img.onload = () => {
            imgCache.set(seg.id, img);
            resolve();
          };
          img.onerror = () => resolve();
          img.src = url;
        }),
    ),
  );

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width: dims.w, height: dims.h },
    fastStart: "in-memory",
  });

  const bitrate = Math.round(settings.bitrateMbps * 1_000_000);
  // Pick an H.264 codec string appropriate for the resolution.
  const codec =
    dims.w * dims.h <= 1280 * 720 ? "avc1.42E01E" : "avc1.4D4028";

  let encodeError: any = null;
  const encoder = new VideoEncoderCtor({
    output: (chunk: any, meta: any) => muxer.addVideoChunk(chunk, meta),
    error: (e: any) => {
      encodeError = e;
    },
  });

  encoder.configure({
    codec,
    width: dims.w,
    height: dims.h,
    bitrate,
    framerate: fps,
    avc: { format: "avc" },
  });

  const frameDurationUs = Math.round(1_000_000 / fps);

  for (let i = 0; i < totalFrames; i++) {
    if (signal?.aborted) {
      try {
        encoder.close();
      } catch {
        /* noop */
      }
      throw new Error("Export cancelled");
    }
    if (encodeError) throw encodeError;

    const currentMs = (i / fps) * 1000;
    const seg = segments.find((s) => currentMs >= s.startMs && currentMs < s.endMs) ||
      segments[segments.length - 1];
    const img = seg ? imgCache.get(seg.id) : null;
    if (seg) drawFrame(ctx, img ?? null, seg, currentMs, dims.w, dims.h, kenBurns);

    const frame = new VideoFrameCtor(canvas, {
      timestamp: i * frameDurationUs,
      duration: frameDurationUs,
    });
    encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();

    // Backpressure: don't queue too many frames.
    if (encoder.encodeQueueSize > 8) {
      await new Promise((r) => setTimeout(r, 4));
    }

    onProgress?.({
      progress: ((i + 1) / totalFrames) * 100,
      fps: 0,
      timemark: undefined,
    });
  }

  await encoder.flush();
  if (encodeError) throw encodeError;
  muxer.finalize();
  encoder.close();

  const { buffer } = muxer.target as ArrayBufferTarget;
  const blob = new Blob([buffer], { type: "video/mp4" });

  // Trigger a browser download (no native save dialog).
  const downloadUrl = URL.createObjectURL(blob);
  triggerDownload(downloadUrl, `framefuse_${Date.now()}.mp4`);
  setTimeout(() => URL.revokeObjectURL(downloadUrl), 60000);

  return { path: "(browser download) framefuse.mp4", size: blob.size };
}

// ---------------------------------------------------------------------------
// Browser fallback 2: MediaRecorder (real-time WebM)
// ---------------------------------------------------------------------------
async function exportViaMediaRecorder(
  opts: ExportNativeOptions,
): Promise<ExportResult> {
  const { segments, imageUrls, settings, kenBurns, totalMs, onProgress, signal } =
    opts;

  const dims = resolveDimensions(settings.aspect, "720p");
  const fps = settings.fps;

  const canvas = document.createElement("canvas");
  canvas.width = dims.w;
  canvas.height = dims.h;
  const ctx = canvas.getContext("2d", { alpha: false })!;

  const imgCache = new Map<string, HTMLImageElement>();
  await Promise.all(
    segments.map(
      (seg) =>
        new Promise<void>((resolve) => {
          const url = imageUrls[seg.id] || seg.thumbnailUrl;
          const img = new Image();
          img.onload = () => {
            imgCache.set(seg.id, img);
            resolve();
          };
          img.onerror = () => resolve();
          img.src = url;
        }),
    ),
  );

  const stream = (canvas as any).captureStream(fps) as MediaStream;
  const mimeType = pickMime();
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: settings.bitrateMbps * 1_000_000,
  });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const done = new Promise<ExportResult>((resolve) => {
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      triggerDownload(url, `framefuse_${Date.now()}.${mimeType.includes("mp4") ? "mp4" : "webm"}`);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      resolve({ path: "(browser download)", size: blob.size });
    };
  });

  recorder.start();
  const start = performance.now();
  const totalFrames = Math.max(1, Math.round((totalMs / 1000) * fps));

  await new Promise<void>((resolve) => {
    const tick = () => {
      const elapsed = performance.now() - start;
      const currentMs = Math.min(elapsed, totalMs);
      const seg =
        segments.find((s) => currentMs >= s.startMs && currentMs < s.endMs) ||
        segments[segments.length - 1];
      const img = seg ? imgCache.get(seg.id) : null;
      if (seg) drawFrame(ctx, img ?? null, seg, currentMs, dims.w, dims.h, kenBurns);

      onProgress?.({
        progress: Math.min(100, (currentMs / totalMs) * 100),
        fps,
      });

      if (signal?.aborted || currentMs >= totalMs) {
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  recorder.stop();
  void totalFrames;
  return done;
}

function pickMime(): string {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) {
      return c;
    }
  }
  return "video/webm";
}

function triggerDownload(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/**
 * Export the timeline to video.
 * - Inside Electron: native FFmpeg (MP4).
 * - In a browser: WebCodecs MP4 (fast), falling back to MediaRecorder WebM.
 */
export async function exportNative(opts: ExportNativeOptions): Promise<ExportResult> {
  if (isElectron()) {
    return exportViaFFmpeg(opts);
  }
  try {
    return await exportViaWebCodecs(opts);
  } catch (err: any) {
    if (err?.message === "Export cancelled") throw err;
    if (err?.message === "NO_WEBCODECS") {
      return exportViaMediaRecorder(opts);
    }
    // WebCodecs encoding failure → fall back to MediaRecorder.
    try {
      return await exportViaMediaRecorder(opts);
    } catch (err2: any) {
      throw new Error(
        `Export failed: ${err2?.message || err2}. WebCodecs error: ${err?.message || err}`,
      );
    }
  }
}

/** Convenience: find the active segment for a time (re-exported helper). */
export function activeSegmentAt(
  segments: MediaSegment[],
  tMs: number,
): MediaSegment | null {
  return (
    segments.find((s) => tMs >= s.startMs && tMs < s.endMs) ||
    (segments.length && tMs >= segments[segments.length - 1].endMs
      ? segments[segments.length - 1]
      : null)
  );
}
