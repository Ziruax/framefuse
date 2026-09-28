/**
 * v1.15 — burn-in text DETECTION (renderer, tesseract.js OCR).
 *
 * Samples K frames from a video source with an offscreen <video>, runs
 * tesseract.js (WASM + eng traineddata, fetched once from the CDN on first
 * use), collects confident word boxes, and clusters them across frames into
 * stable SOURCE-normalized regions for the text-removal settings.
 *
 * The clustering is deliberately conservative: a region ships only when its
 * words appear in ≥ `minFrameSupport` sampled frames — burned-in text
 * (watermarks, hard subs, usernames) sits still across the whole clip while
 * transient scene text usually does not.
 *
 * Node-safety: every browser API is resolved lazily inside functions.
 */

import type { TextRemovalRegion } from "./types";

export interface TextDetectProgress {
  progress: number; // 0..100
  status: string;
}

export interface TextDetectResult {
  regions: TextRemovalRegion[];
  framesSampled: number;
  durationMs: number;
  srcW: number;
  srcH: number;
}

interface OcrWordBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  text: string;
  confidence: number;
}

/** Word-level confidence floor (tesseract 0..100). */
const WORD_CONFIDENCE = 55;
/** A region must appear in at least this many sampled frames. */
const MIN_FRAME_SUPPORT = 2;
/** Max sampled frames (spread evenly across the source). */
const MAX_SAMPLES = 6;
/** OCR canvas runs at ≤ this width (speed; boxes scale back up).
 * v1.15 measured: 640 halves a 1280-wide source and pushes 64 px burned
 * text to the edge of tesseract's comfort zone — 960 keeps small text
 * legible while staying fast. */
const OCR_WIDTH = 960;
/** Boxes covering more than this fraction of the frame are scene noise
 * (tesseract loves to box whole busy halves) — never text. */
const MAX_REGION_AREA = 0.55;
/** Boxes within this fraction of frame size merge into one region. */
const MERGE_GAP_X = 0.03;
const MERGE_GAP_Y = 0.015;

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Await a video element event with a timeout (seek/metadata can hang). */
function waitForEvent(el: HTMLVideoElement, event: string, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${event}`));
    }, ms);
    const on = () => {
      cleanup();
      resolve();
    };
    const err = () => {
      cleanup();
      reject(new Error(`Video error while waiting for ${event}`));
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      el.removeEventListener(event, on);
      el.removeEventListener("error", err);
    };
    el.addEventListener(event, on, { once: true });
    el.addEventListener("error", err, { once: true });
  });
}

/** Seek + wait for the frame to land. */
async function seekTo(el: HTMLVideoElement, t: number): Promise<void> {
  el.currentTime = t;
  await waitForEvent(el, "seeked", 12000);
}

type Rect = { x: number; y: number; w: number; h: number };

function rectsOverlapOrNear(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w + MERGE_GAP_X &&
    b.x < a.x + a.w + MERGE_GAP_X &&
    a.y < b.y + b.h + MERGE_GAP_Y &&
    b.y < a.y + a.h + MERGE_GAP_Y
  );
}

function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

/** Iteratively merge overlapping/near rects until stable. */
function mergeRects(rects: Rect[]): Rect[] {
  let cur = [...rects];
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < cur.length; i++) {
      for (let j = i + 1; j < cur.length; j++) {
        if (rectsOverlapOrNear(cur[i], cur[j])) {
          cur[i] = unionRect(cur[i], cur[j]);
          cur.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return cur;
}

/**
 * Detect stable burn-in text regions on a video source.
 *
 * @param source  { url } — an object URL / data URL of a VIDEO file (the
 *                 detection runs on the raw source, not the preview canvas,
 *                 so regions land in source coordinates by construction).
 * @param opts    onProgress / signal.
 */
export async function detectTextRegions(
  source: { url: string; name?: string },
  opts?: {
    onProgress?: (p: TextDetectProgress) => void;
    signal?: AbortSignal;
  },
): Promise<TextDetectResult> {
  if (typeof document === "undefined") {
    throw new Error("Text detection needs a browser environment");
  }
  const report = (progress: number, status: string) =>
    opts?.onProgress?.({ progress, status });

  report(2, "Loading OCR engine…");
  // Dynamic import keeps the ~4 MB WASM out of the initial bundle; the
  // worker + language data download from the tesseract CDN on first use.
  const Tesseract = await import("tesseract.js");
  const worker = await Tesseract.createWorker("eng");
  let workerReady = true;

  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";
  video.src = source.url;
  video.style.display = "none";
  document.body.appendChild(video);

  const canvas = document.createElement("canvas");
  const cctx = canvas.getContext("2d", { willReadFrequently: true });

  try {
    if (opts?.signal?.aborted) throw new Error("Detection cancelled");
    report(8, "Reading video…");
    await waitForEvent(video, "loadedmetadata", 20000);
    const srcW = video.videoWidth;
    const srcH = video.videoHeight;
    const durationMs = Math.round((video.duration || 0) * 1000);
    if (!srcW || !srcH || !durationMs) {
      throw new Error("Could not read the video's dimensions or duration");
    }
    // Short clips sample fewer frames; long clips cap at MAX_SAMPLES.
    const K = Math.max(1, Math.min(MAX_SAMPLES, Math.floor(durationMs / 2000) || 1));

    // OCR canvas: aspect-preserving downscale to ≤ OCR_WIDTH.
    const scale = Math.min(1, OCR_WIDTH / srcW);
    canvas.width = Math.max(64, Math.round(srcW * scale));
    canvas.height = Math.max(64, Math.round(srcH * scale));

    // frameIdx → merged word rects (normalized 0..1).
    const perFrame: Array<{ rects: Rect[]; texts: string[] }> = [];
    for (let k = 0; k < K; k++) {
      if (opts?.signal?.aborted) throw new Error("Detection cancelled");
      const t = (durationMs / 1000) * ((k + 0.5) / K);
      report(
        10 + Math.round((k / K) * 80),
        `Scanning frame ${k + 1}/${K}…`,
      );
      try {
        await seekTo(video, t);
      } catch {
        continue; // a flaky seek skips the sample, not the detection
      }
      if (!cctx) break;
      cctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      let data;
      try {
        // tesseract.js v5+: words live NESTED in blocks[].paragraphs[].lines[].words[]
        // — data.words is empty unless blocks are requested (and even then
        // only the nested path carries them; verified against v7.0.0).
        const r = await worker.recognize(canvas, {}, { blocks: true, text: true });
        data = r?.data;
      } catch {
        continue; // OCR hiccup on one frame — skip it
      }
      const rawWords: Array<{
        text?: string;
        confidence?: number;
        bbox?: { x0: number; y0: number; x1: number; y1: number };
      }> = [];
      if (Array.isArray(data?.words) && data.words.length > 0) {
        rawWords.push(...data.words);
      } else if (Array.isArray(data?.blocks)) {
        for (const blk of data.blocks) {
          for (const para of (blk?.paragraphs ?? []) as Array<{
            lines?: Array<{ words?: unknown[] }>;
          }>) {
            for (const line of (para?.lines ?? []) as Array<{
              words?: Array<{
                text?: string;
                confidence?: number;
                bbox?: { x0: number; y0: number; x1: number; y1: number };
              }>;
            }>) {
              if (Array.isArray(line?.words)) rawWords.push(...line.words);
            }
          }
        }
      }
      const rects: Rect[] = [];
      const texts: string[] = [];
      for (const w of rawWords) {
        if (!w?.bbox || (w.confidence ?? 0) < WORD_CONFIDENCE) continue;
        const text = (w.text || "").trim();
        if (!text) continue;
        const rx = w.bbox.x0 / canvas.width;
        const ry = w.bbox.y0 / canvas.height;
        const rw = (w.bbox.x1 - w.bbox.x0) / canvas.width;
        const rh = (w.bbox.y1 - w.bbox.y0) / canvas.height;
        // Scene-noise guard: a box spanning more than MAX_REGION_AREA of the
        // frame is tesseract boxing a busy region, never burned-in text.
        if (rw * rh > MAX_REGION_AREA) continue;
        rects.push({ x: rx, y: ry, w: rw, h: rh });
        texts.push(text);
      }
      perFrame.push({ rects: mergeRects(rects), texts });
    }

    report(92, "Clustering detected text…");
    // Cross-frame support: a cluster counts a frame when one of its rects
    // overlaps ≥ 30% of the cluster's area.
    const clusters: Array<{ rect: Rect; frames: Set<number>; label: string }> = [];
    perFrame.forEach((frame, fi) => {
      for (const r of frame.rects) {
        if (r.w < 0.02 || r.h < 0.01) continue; // specks
        let hit = false;
        for (const c of clusters) {
          const overlapX = Math.max(
            0,
            Math.min(r.x + r.w, c.rect.x + c.rect.w) - Math.max(r.x, c.rect.x),
          );
          const overlapY = Math.max(
            0,
            Math.min(r.y + r.h, c.rect.y + c.rect.h) - Math.max(r.y, c.rect.y),
          );
          const inter = overlapX * overlapY;
          if (inter > 0.3 * Math.min(r.w * r.h, c.rect.w * c.rect.h)) {
            c.rect = unionRect(c.rect, r);
            c.frames.add(fi);
            hit = true;
            break;
          }
        }
        if (!hit) clusters.push({ rect: r, frames: new Set([fi]), label: "" });
      }
    });
    // Attach a label from the first frame whose words fall inside the rect.
    for (const c of clusters) {
      for (let fi = 0; fi < perFrame.length; fi++) {
        if (!c.frames.has(fi)) continue;
        const inside = perFrame[fi].rects
          .map((r, idx) => ({ r, t: perFrame[fi].texts[idx] }))
          .filter(
            ({ r }) =>
              r.x >= c.rect.x - 0.01 &&
              r.y >= c.rect.y - 0.01 &&
              r.x + r.w <= c.rect.x + c.rect.w + 0.01 &&
              r.y + r.h <= c.rect.y + c.rect.h + 0.01,
          )
          .map(({ t }) => t);
        if (inside.length) {
          c.label = inside.join(" ").slice(0, 40);
          break;
        }
      }
    }

    const regions: TextRemovalRegion[] = clusters
      .filter((c) => c.frames.size >= Math.min(MIN_FRAME_SUPPORT, K))
      .sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h)
      .slice(0, 8)
      .map((c) => ({
        id: uuid(),
        x: Math.max(0, Math.min(0.99, c.rect.x)),
        y: Math.max(0, Math.min(0.99, c.rect.y)),
        w: Math.max(0.01, Math.min(1 - c.rect.x, c.rect.w)),
        h: Math.max(0.01, Math.min(1 - c.rect.y, c.rect.h)),
        source: "ocr" as const,
        label: c.label || undefined,
      }));

    report(100, regions.length ? `Found ${regions.length} text region(s)` : "No stable text found");
    return { regions, framesSampled: K, durationMs, srcW, srcH };
  } finally {
    if (workerReady) {
      try {
        await worker.terminate();
      } catch {
        /* best effort */
      }
    }
    video.pause();
    video.removeAttribute("src");
    video.load();
    document.body.removeChild(video);
  }
}
