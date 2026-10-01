// electron/rust-engine-router.js — v1.16 RUST NATIVE ENGINE ROUTER
// (DIRECTIVE 5 of the runtime-FFI architecture).
//
// The Rust engine (rust-engine/, napi-rs cdylib) composites on wgpu and
// encodes through RUNTIME-DLOPENED FFmpeg shared libraries — no CLI child
// processes, no IPC pipes, no browser TDR surface. This module decides
// whether an export is RUST-ELIGIBLE, adapts the existing `export-native`
// payload into the Rust timeline JSON, runs the engine, and maps its
// progress + result back into the EXACT shapes the UI already renders.
//
// Safe Mode contract: ANY failure here (module missing, DLLs absent,
// version-family mismatch, mid-export crash) returns null and the caller
// silently routes to the battle-tested v1.14.5 FFmpeg-CLI pipeline. The
// Rust path must never make an export FAIL that would have succeeded.
//
// v2 eligibility (the engine grew up):
//   ✓ base-lane video/image segments: trim, speed, per-segment volume,
//     Ken Burns (images), cover-fit
//   ✓ overlay lanes: geometry (9-grid + free-form), opacity, chroma key,
//     loop
//   ✓ background music (volume/start/loop) + master fades
//   ✓ headline texts (position presets, fades, outline) via fontdue +
//     OS font paths
//   ✓ watermark image
//   ✓ v1.17 VOICEOVER + DUB + SFX placements → timeline.extraAudio (the
//     native audio bus mixes them with the dub duck applied Electron-side)
//   ✓ v2 TRANSITIONS: dissolve (image↔image), dip-black, dip-white +
//     fadeStartEnd bookends — the plan mirrors planBoundaryFades exactly
//   ✗ slide/wipe/circleopen transitions, burn-in text removal, ASS
//     captions/kinetic Stack Text, loudnorm, overlay motion keyframes → CLI

"use strict";

const path = require("path");
const fs = require("fs");

// ── engine load (DIRECTIVE 5: silent, probeable, never fatal) ─────────────
let rustEngine = null;
let rustEngineError = null;
try {
  rustEngine = require(path.join(__dirname, "..", "rust-engine"));
  if (rustEngine && typeof rustEngine.available === "function" && !rustEngine.available()) {
    rustEngineError = rustEngine.loadError ? rustEngine.loadError() : "binary unavailable";
    rustEngine = null;
  }
} catch (err) {
  rustEngine = null;
  rustEngineError = String((err && err.message) || err);
}

function rustEngineStatus() {
  if (rustEngine) {
    return {
      loaded: true,
      version: safeCall(() => rustEngine.engineVersion()),
      binary: rustEngine.binaryName,
      from: rustEngine.loadedFrom,
    };
  }
  return { loaded: false, error: rustEngineError };
}

function safeCall(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

// ── eligibility ────────────────────────────────────────────────────────────

/**
 * v0.1 feature gate. `opts` is the raw `export-native` payload.
 */
// Transition styles the NATIVE engine composites. slide/wipe/circleopen
// (xfade geometry styles) + kinetic ASS captions stay on the CLI pipeline.
const NATIVE_TRANSITION_STYLES = new Set(["none", "dissolve", "dip-black", "dip-white"]);
const DIP_COLOR_STYLES = new Set(["dip-black", "dip-white"]);
/** EXACT mirror of export-graph's XFADE_NAMES keys (the xfade family). */
const XFADE_FAMILY_STYLES = new Set([
  "dissolve", "slide-left", "slide-right", "wipe-left", "wipe-right", "circleopen",
]);

function rustEligible(opts) {
  if (!rustEngine) return { ok: false, reason: rustEngineError || "engine not loaded" };
  const reasons = [];

  // v2: voiceovers + SFX ride the NATIVE audio bus (extraAudio) — no gate.

  const tr = opts.textRemoval;
  if (tr && tr.mode && tr.mode !== "none" && Array.isArray(tr.regions) && tr.regions.length > 0) {
    reasons.push("text-removal");
  }

  const captionsOn =
    opts.captionSettings && opts.captionSettings.enabled &&
    Array.isArray(opts.subtitleCues) && opts.subtitleCues.length > 0;
  if (captionsOn) reasons.push("captions");

  // v2 TRANSITIONS: dissolve/dips are native; the geometric xfade styles
  // (slide/wipe/circleopen) ride the CLI's xfade filter. Per-boundary
  // overrides count — ANY non-native style at ANY boundary → CLI.
  const trans = opts.transition;
  if (trans && typeof trans.style === "string") {
    const overrides =
      trans.overrides && typeof trans.overrides === "object" ? trans.overrides : null;
    const styles = new Set([trans.style]);
    if (overrides) {
      for (const k of Object.keys(overrides)) {
        const v = overrides[k];
        if (typeof v === "string") styles.add(v);
      }
    }
    for (const s of styles) {
      if (s !== "none" && !NATIVE_TRANSITION_STYLES.has(s)) {
        reasons.push("transition:" + s);
      }
    }
  }

  const audio = opts.audio;
  if (audio && audio.normalize) reasons.push("loudnorm");

  // v1.17 STACK TEXT: any headline with a stackStyle set rides the ASS/
  // libass CLI compositor (the kinetic recipes are libass tags — the Rust
  // engine's fontdue texts have no equivalent). This is the "export picks
  // the best technique by default" gate: kinetic Stack Text → CLI, plain
  // headlines keep the Rust fast path.
  const headlineList = Array.isArray(opts.headlines) ? opts.headlines : [];
  if (headlineList.some((h) => h && h.stackStyle)) reasons.push("stack-text");

  // overlay motion keyframes (≥2 = an actual path; 1 = pinned, fine)
  const overlays = Array.isArray(opts.overlays) ? opts.overlays : [];
  for (const o of overlays) {
    const motion = o && o.overlay && Array.isArray(o.overlay.motion) ? o.overlay.motion : null;
    if (motion && motion.length >= 2) {
      reasons.push("overlay-motion");
      break;
    }
  }

  if (reasons.length > 0) return { ok: false, reason: reasons.join(",") };
  return { ok: true };
}

// ── v2 transition planning (EXACT mirror of export-graph.planBoundaryFades)
// ──────────────────────────────────────────────────────────────────────────
const TRANSITION_MAX_FRACTION = 0.45;

function clampTrMs(ms, segDurMs) {
  return ms > 0 && segDurMs > 200
    ? Math.min(ms, Math.floor(segDurMs * TRANSITION_MAX_FRACTION))
    : 0;
}

/**
 * Per-segment native transition plan: head (dissolve/dip-in), tail
 * (dip-out, NEXT boundary's color), bookends (fadeStartEnd). The Rust
 * timeline consumes exactly these fields.
 */
function planNativeTransitions(segments, transition) {
  const trGlobal = transition && transition.style ? transition.style : "none";
  const overrides =
    transition && transition.overrides && typeof transition.overrides === "object"
      ? transition.overrides
      : null;
  const styleAt = (seg) =>
    seg && overrides && Object.prototype.hasOwnProperty.call(overrides, seg.id)
      ? overrides[seg.id]
      : trGlobal;
  const trWanted = transition && Number(transition.durationMs) > 0 ? Number(transition.durationMs) : 0;
  const fadeStartEnd = !!(transition && transition.fadeStartEnd);
  const isVideo = (s) => !!(s && s.mediaType === "video");

  const plans = segments.map((seg, i) => {
    const curStyle = i > 0 ? styleAt(seg) : "none";
    const nextStyle = i < segments.length - 1 ? styleAt(segments[i + 1]) : "none";
    const last = i === segments.length - 1;

    let headMs = i > 0 && curStyle !== "none" ? clampTrMs(trWanted, seg.durationMs) : 0;
    // v5.0 VIDEO RULE mirror: an xfade-family head is a HARD CUT when
    // either side of the boundary is a VIDEO segment (dips unaffected).
    if (
      headMs > 0 &&
      XFADE_FAMILY_STYLES.has(curStyle) &&
      (isVideo(seg) || isVideo(segments[i - 1]))
    ) {
      headMs = 0;
    }
    const dipTailMs =
      DIP_COLOR_STYLES.has(nextStyle) && !last ? clampTrMs(trWanted, seg.durationMs) : 0;
    return {
      headMs,
      headStyle: headMs > 0 ? curStyle : "none",
      tailMs: dipTailMs,
      tailStyle: dipTailMs > 0 ? nextStyle : "none",
      bookendStartMs: i === 0 && fadeStartEnd ? clampTrMs(trWanted, seg.durationMs) : 0,
      bookendEndMs: last && fadeStartEnd ? clampTrMs(trWanted, seg.durationMs) : 0,
    };
  });
  return plans;
}

// ── timeline adaptation (export-native payload → Rust timeline JSON) ──────

const FONTS = {
  win32: { sans: "C:\\Windows\\Fonts\\arialbd.ttf", mono: "C:\\Windows\\Fonts\\consola.ttf" },
  linux: {
    sans: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    mono: "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
  },
  darwin: { sans: "/System/Library/Fonts/Supplemental/Arial Bold.ttf", mono: "/System/Library/Fonts/Menlo.ttc" },
};

function pickFont(family) {
  const table = FONTS[process.platform] || FONTS.linux;
  const f = table[family || "sans"] || table.sans;
  try {
    return fs.existsSync(f) ? f : table.sans;
  } catch {
    return table.sans;
  }
}

/** 9-grid + free-form overlay geometry → normalized center rect (the exact
 * math of export-graph.overlayGeometryMirror, expressed in 0..1). */
function overlayGeometryNorm(videoW, videoH, overlay) {
  if (!overlay) return { x: 0.5, y: 0.5, w: 0.3, h: 0 };
  const sp = Number.isFinite(overlay.scalePercent)
    ? Math.max(10, Math.min(100, overlay.scalePercent))
    : 100;
  const w = Math.max(0.01, sp / 100); // fraction of canvas WIDTH
  // height from aspect is derived engine-side (h: 0) — we don't know srcW/H here
  if (Number.isFinite(overlay.x) && Number.isFinite(overlay.y)) {
    return {
      x: Math.max(0, Math.min(1, overlay.x)),
      y: Math.max(0, Math.min(1, overlay.y)),
      w,
      h: 0,
    };
  }
  const pos = String(overlay.position || "center");
  const col = pos.endsWith("left") ? 0 : pos.endsWith("right") ? 2 : 1;
  const row = pos.startsWith("top") ? 0 : pos.startsWith("bottom") ? 2 : 1;
  const m = 0.02; // 2% margin, mirrors the CLI geometry
  // dw in normalized-width units; dh unknown until source aspect → h: 0.
  // Anchor the CENTER on the grid cell with the same 2% margins.
  const hApprox = w * (videoH / videoW); // square-pixel placeholder for anchoring
  const cx =
    col === 0 ? m + w / 2 : col === 2 ? 1 - m - w / 2 : 0.5;
  const cy = row === 0 ? m + hApprox / 2 : row === 2 ? 1 - m - hApprox / 2 : 0.5;
  return { x: cx, y: cy, w, h: 0 };
}

function kenBurnsFor(globalKenBurns, direction) {
  const enabled = !!(globalKenBurns && globalKenBurns.enabled);
  if (!enabled) return null;
  const intensity = Math.max(0, Math.min(100, Number(globalKenBurns.intensity) || 0));
  const zoomMax = 1.06 + (intensity / 100) * 0.18;
  return {
    enabled: true,
    direction: direction === "out" ? "out" : "in",
    zoomMax,
  };
}

/**
 * v1.17 Stack Text: the effective layout (stackLayout ?? legacyMap(position))
 * collapses onto the Rust text-position vocabulary: top-banner → "top",
 * bottom-center → "bottom", everything else → "center". Kinetic items never
 * reach this path (rustEligible's "stack-text" gate) — this maps the
 * layout of SIMPLE-style headline items.
 */
function headlinePositionFromLayout(h) {
  const layout = (h && h.stackLayout) ||
    (h && h.position === "top"
      ? "top-banner"
      : h && h.position === "bottom"
        ? "bottom-center"
        : "center-stack");
  if (layout === "top-banner") return "top";
  if (layout === "bottom-center") return "bottom";
  return "center";
}

/**
 * Build the Rust timeline JSON. Returns { timeline } or { error }.
 */
function buildRustTimeline(opts) {
  const width = Math.max(16, Math.round(Number(opts.width) || 1280));
  const height = Math.max(16, Math.round(Number(opts.height) || 720));
  let fps = Number(opts.fps) || 30;

  const segments = Array.isArray(opts.segments) ? opts.segments : [];
  const overlays = Array.isArray(opts.overlays) ? opts.overlays : [];

  // v1.14.5 SLIDESHOW 24 FPS MODE — same rule as the CLI pipeline (pure
  // image timeline renders at the film rate; never silent: result carries it)
  const allImages = segments.every((s) => s && s.mediaType !== "video") && segments.length > 0;
  let slideshowFpsApplied = null;
  const totalMs = segments.reduce(
    (sum, s) =>
      Math.max(sum, s.endMs ?? (s.startMs ?? 0) + (s.durationMs ?? 0)),
    0,
  );
  if (
    allImages &&
    opts.slideshowFps24 !== false &&
    fps > 24 && fps < 60 &&
    opts.quality !== "cinema" &&
    totalMs >= 12000
  ) {
    slideshowFpsApplied = { from: fps, to: 24 };
    fps = 24;
  }

  const masterVolume = Math.max(0, Math.min(2, Number(opts.audio && opts.audio.masterVolume) || 1));
  let zvScale = masterVolume;

  // v1.17 DUB DUCK (EXACT mirror of the CLI branch in main.js): when a
  // voiceover/dub track exists, the ORIGINAL clip audio (base-lane video
  // segments only) scales by dubOriginalVolume. Music/SFX/VO are NOT
  // ducked. Applied HERE so the native bus and the CLI amix agree.
  const voList = (Array.isArray(opts.voiceovers) ? opts.voiceovers : []).filter(
    (v) => v && typeof v.wavPath === "string" && v.wavPath,
  );
  const sfxList = (Array.isArray(opts.sfx) ? opts.sfx : []).filter(
    (s) => s && typeof s.wavPath === "string" && s.wavPath,
  );
  let duckApplied = 0;
  if (voList.length > 0 && Number.isFinite(Number(opts.dubOriginalVolume))) {
    duckApplied = Math.max(0, Math.min(1, Number(opts.dubOriginalVolume)));
    if (duckApplied < 1) {
      zvScale = masterVolume * duckApplied;
    }
  }
  // Per-segment volume: VIDEO segments get the ducked scale (the duck is a
  // property of the ORIGINAL clip audio, not music/images); everything
  // else keeps the master scale.
  const zvVideo = (v) => Math.max(0, Math.min(2, Number(v) || 0)) * zvScale;
  const zvPlain = (v) => Math.max(0, Math.min(2, Number(v) || 0)) * masterVolume;

  // v2 TRANSITION PLAN (mirrors planBoundaryFades; only native styles can
  // reach here — rustEligible gated the geometric xfade styles to the CLI).
  const trPlans = planNativeTransitions(segments, opts.transition);

  // ── base lane + overlay lanes → Rust segments ──
  const rustSegments = [];
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (!s) continue;
    const isVideo = s.mediaType === "video";
    const p = isVideo ? s.videoPath : s.imagePath;
    if (typeof p !== "string" || !p) return { error: "segment missing source path" };
    const plan = trPlans[i] || {};
    rustSegments.push({
      id: String(s.id || `seg${rustSegments.length}`),
      mediaType: isVideo ? "video" : "image",
      path: p,
      startMs: Number(s.startMs) || 0,
      endMs: Number(s.endMs) || (Number(s.startMs) || 0) + (Number(s.durationMs) || 0),
      durationMs: Number(s.durationMs) || 0,
      trimInMs: Math.max(0, Number(s.trimInMs) || 0),
      sourceDurationMs: Number.isFinite(s.sourceDurationMs) ? s.sourceDurationMs : null,
      speed: Math.max(0.25, Math.min(4, Number(s.speed) || 1)),
      track: 0,
      volume: isVideo ? zvVideo(s.volume) : zvPlain(s.volume),
      sourceWidth: Number.isFinite(s.sourceWidth) ? s.sourceWidth : null,
      sourceHeight: Number.isFinite(s.sourceHeight) ? s.sourceHeight : null,
      kenBurns: kenBurnsFor(opts.kenBurns, s.direction),
      geometry: null,
      chroma: null,
      opacity: 1,
      overlayLoop: false,
      hasAudio: isVideo,
      // v2 native transition plan
      transHeadMs: Number(plan.headMs) || 0,
      transHeadStyle: String(plan.headStyle || "none"),
      transTailMs: Number(plan.tailMs) || 0,
      transTailStyle: String(plan.tailStyle || "none"),
      bookendStartMs: Number(plan.bookendStartMs) || 0,
      bookendEndMs: Number(plan.bookendEndMs) || 0,
    });
  }
  for (const o of overlays) {
    if (!o) continue;
    const isVideo = o.mediaType === "video";
    const p = isVideo ? o.videoPath : o.imagePath;
    if (typeof p !== "string" || !p) return { error: "overlay missing source path" };
    const geo = overlayGeometryNorm(width, height, o.overlay);
    rustSegments.push({
      id: String(o.id || `ovl${rustSegments.length}`),
      mediaType: isVideo ? "video" : "image",
      path: p,
      startMs: Number(o.startMs) || 0,
      endMs: Number(o.endMs) || (Number(o.startMs) || 0) + (Number(o.durationMs) || 0),
      durationMs: Number(o.durationMs) || 0,
      trimInMs: Math.max(0, Number(o.trimInMs) || 0),
      sourceDurationMs: Number.isFinite(o.sourceDurationMs) ? o.sourceDurationMs : null,
      speed: 1,
      track: Math.max(1, Number(o.track) || 1),
      volume: zv(o.volume),
      sourceWidth: null,
      sourceHeight: null,
      kenBurns: null,
      geometry: geo,
      chroma: o.chroma
        ? {
            color: String(o.chroma.color || "#00b140"),
            similarity: Math.max(0, Math.min(1, Number(o.chroma.similarity) ?? 0.31)),
            smoothness: Math.max(0, Math.min(1, Number(o.chroma.smoothness) ?? 0.08)),
          }
        : null,
      opacity: 1,
      overlayLoop: !!o.overlayLoop,
      hasAudio: isVideo,
    });
  }
  if (rustSegments.length === 0) return { error: "no segments" };

  // ── headlines → Rust texts ──
  const texts = (Array.isArray(opts.headlines) ? opts.headlines : [])
    .filter((h) => h && h.text && h.endMs > h.startMs)
    .map((h) => ({
      text: String(h.text),
      startMs: Number(h.startMs) || 0,
      endMs: Number(h.endMs) || 0,
      font: "sans",
      size: 72 * (Number(h.sizeScale) || 1), // 1080p reference px
      color: "#ffffff",
      outlineColor: "#101010",
      // v1.17: position from the effective Stack Text layout (stackLayout ??
      // legacyMap(position)); kinetic stackStyle items are gated to the CLI
      // before this ever runs.
      position: headlinePositionFromLayout(h),
      x: 0.5,
      fadeMs: 250,
    }));

  // ── music + master fades ──
  const audio = opts.audio || {};
  const music = opts.audioPath
    ? {
        path: String(opts.audioPath),
        volume: Math.max(0, Math.min(2, Number(audio.musicVolume) || 1)),
        startMs: Math.max(0, Number(audio.musicStartMs) || 0),
        loopTrack: !!audio.musicLoop,
      }
    : null;

  // ── v2 EXTRA AUDIO: voiceovers (narration MP3 / dub WAVs) + SFX
  // placements → the native audio bus. MP3s arrive 24 kHz mono — the
  // engine's swresample stage upmixes to the 48 kHz stereo bus.
  const extraAudio = [];
  for (const v of voList) {
    extraAudio.push({
      path: String(v.wavPath),
      startMs: Math.max(0, Number(v.startMs) || 0),
      volume: Math.max(0, Math.min(2, Number(v.volume) || 1)),
    });
  }
  for (const s of sfxList) {
    extraAudio.push({
      path: String(s.wavPath),
      startMs: Math.max(0, Number(s.startMs) || 0),
      volume: Math.max(0, Math.min(2, Number(s.volume) || 1)),
    });
  }
  if (voList.length > 0 && duckApplied < 1) {
    console.log(
      `[RustEngine] native audio bus: ${voList.length} VO + ${sfxList.length} SFX track(s)` +
        ` · original audio ducked to ${(duckApplied * 100).toFixed(0)}%`,
    );
  }

  // ── watermark (pixel coords, as the CLI chain consumes) ──
  const wm = opts.watermark;
  const watermark =
    wm && wm.imagePath && Number(wm.w) > 0
      ? {
          path: String(wm.imagePath),
          x: Math.round(Number(wm.x) || 0),
          y: Math.round(Number(wm.y) || 0),
          w: Math.round(Number(wm.w)),
          h: Math.round(Number(wm.h) || wm.w),
          opacity: Math.max(0.05, Math.min(1, Number(wm.opacity) || 1)),
        }
      : null;

  const timeline = {
    version: 1,
    width,
    height,
    fps,
    sampleRate: 48000,
    audioChannels: 2,
    bitrateMbps: Number(opts.bitrateMbps) || 0,
    crf: Number.isFinite(Number(opts.crf)) ? Number(opts.crf) : 21,
    quality: opts.quality || "social",
    audioKbps: Number(opts.audioKbps) || 192,
    backgroundColor: "#000000",
    totalMs: Math.max(1, totalMs),
    fadeInMs: Math.max(0, Number(audio.fadeInMs) || 0),
    fadeOutMs: Math.max(0, Number(audio.fadeOutMs) || 0),
    fonts: { sans: pickFont("sans"), mono: pickFont("mono") },
    segments: rustSegments,
    music,
    extraAudio,
    texts,
    watermark,
  };
  return { timeline, slideshowFpsApplied, fps };
}

// ── the runner (DIRECTIVE 5) ───────────────────────────────────────────────

/** FFmpeg shared-library dir for the Rust engine's runtime dlopen. */
function ffmpegDllDir(ffmpegPath) {
  try {
    const base = path.dirname(ffmpegPath);
    if (process.platform === "win32") {
      // packaged layout: resources/ffmpeg/win/{ffmpeg.exe, dll/}
      const dllDir = path.join(base, "dll");
      if (fs.existsSync(dllDir)) return dllDir;
      return base;
    }
    // dev/linux/mac: system loader path (empty string)
    return "";
  } catch {
    return "";
  }
}

/**
 * Attempt the Rust-engine export. Returns the CLI-shaped result on success,
 * or null when the caller must fall back to the FFmpeg-CLI pipeline.
 */
async function runRustExport(opts, event, { ffmpegPath, cpuCount, sendCliProgress }) {
  const gate = rustEligible(opts);
  if (!gate.ok) {
    if (rustEngine) {
      console.log(`[RustEngine] CLI path chosen (v0.1 unsupported: ${gate.reason})`);
    }
    return null;
  }
  const built = buildRustTimeline(opts);
  if (built.error) {
    console.log(`[RustEngine] timeline build refused: ${built.error}`);
    return null;
  }

  const dllDir = ffmpegDllDir(ffmpegPath);
  const startedAt = Date.now();
  const phasesSeen = new Set();
  try {
    const res = await rustEngine.exportVideo(
      JSON.stringify(built.timeline),
      opts.outputPath,
      dllDir,
      (err, p) => {
        if (err || !p || !event.sender || event.sender.isDestroyed()) return;
        phasesSeen.add(p.phase);
        // → the EXACT export-progress payload shape the renderer renders
        event.sender.send("export-progress", {
          progress: Math.max(0, Math.min(100, p.percent)),
          fps: p.fps || 0,
          eta: p.etaMs ? Math.round(p.etaMs / 100) / 10 : undefined,
          timemark: p.timemarkSec != null ? assFmtTime(p.timemarkSec) : undefined,
          elapsed: p.elapsedSec,
          total: p.totalSec,
          phase: p.phase,
          rate: p.rate,
          // v1.18: WHICH engine is running — the Header badge renders it.
          engine: "rust",
        });
      },
    );

    // success → CLI-shaped result + the Rust telemetry story
    const size = (() => {
      try { return fs.statSync(opts.outputPath).size; } catch { return 0; }
    })();
    const gpu = res.engineUsed === "rust-gpu";
    return {
      path: opts.outputPath,
      size,
      // the label the completion toast + LastExport tooltip render
      encoder: `H.264 · ${res.encoderName} · Rust ${gpu ? "GPU" : "CPU"} engine`,
      method: `Rust ${gpu ? "GPU" : "CPU"} engine`,
      engine: "rust-native",
      elapsedSec: Math.round((res.durationMs / 1000) * 10) / 10,
      framesEncoded: res.frames,
      gpuFrameRenderMs: Math.round((res.compositorMs / Math.max(1, res.frames)) * 10) / 10,
      copiedClips: 0,
      encodedClips: 1,
      keyframeCuts: 0,
      chunkedClips: 0,
      totalChunks: 0,
      hwDecodeClips: 0,
      poolWorkers: 1,
      cpus: cpuCount,
      enginePreset: opts.quality || "social",
      singlePass: true,
      mode: "rust-native",
      outputFps: built.fps,
      outputWidth: built.timeline.width,
      outputHeight: built.timeline.height,
      slideshowFps: built.slideshowFpsApplied ? true : undefined,
      slideshowFpsFrom: built.slideshowFpsApplied ? built.slideshowFpsApplied.from : undefined,
      slideshowFpsTo: built.slideshowFpsApplied ? built.slideshowFpsApplied.to : undefined,
      // ── Rust telemetry (DIRECTIVE 6 rule 4: the truth about the engine) ──
      engineUsed: res.engineUsed,
      encoderName: res.encoderName,
      hardwareEncoder: /^(h264_nvenc|h264_qsv|h264_amf|h264_mf)/.test(String(res.encoderName)),
      adapter: res.adapter,
      rustCompositorMs: res.compositorMs,
      rustEncodeMs: res.encodeMs,
      rustDecodeMs: res.decodeMs,
      rustAudioMs: res.audioMs,
      totalWallMs: res.durationMs,
      ffmpegFamily: res.ffmpegFamily,
    };
  } catch (err) {
    console.error(
      `[RustEngine] export failed after ${Date.now() - startedAt}ms — falling back to FFmpeg CLI:`,
      (err && err.message) || err,
    );
    return null;
  }
}

// assFmtTime mirror (main.js owns the canonical one; duplicated here so the
// router is a self-contained module — H:MM:SS.cc, the v1.14.1 fix shape).
function assFmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.round((sec - Math.floor(sec)) * 100);
  const cc = cs === 100 ? 99 : cs;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cc).padStart(2, "0")}`;
}

function requestRustCancel() {
  try {
    if (rustEngine && typeof rustEngine.cancelExport === "function") rustEngine.cancelExport();
  } catch {}
}

module.exports = {
  rustEngine,
  rustEngineStatus,
  rustEligible,
  buildRustTimeline,
  runRustExport,
  requestRustCancel,
};
