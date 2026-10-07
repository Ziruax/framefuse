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
//   ✓ v1.20 NATIVE CAPTIONS: burned-in cues with the full v4.1 vocabulary
//     (plain/word/word-only/stack modes, karaoke highlight, all 24
//     CaptionAnimations) via rust-engine/src/captions.rs (fontdue +
//     compositor text layers — animated word rect/alpha transforms)
//   ✓ v1.21 NATIVE KINETIC TYPOGRAPHY: the v1.18 kinetic-typography engine
//     (per-word choreography over renderer-measured geometry) via
//     rust-engine/src/kinetic.rs — an exact math port of kinetic/motion.ts
//   ✓ v0.3 (v1.33.7) BASE-LANE LOOP-TO-FILL: a track-0 video marked `loop`
//     wraps its decode position across the trimmed source span and loops
//     its own audio on the native bus (the CLI `-stream_loop` parity) —
//     engine v0.3, no gate.
//   ✓ v0.3 (v1.33.7) AUDIO-EXTENDED TIMELINES: payload totalMs beyond the
//     last visual end renders black-tail frames + a full-length audio bus
//     (the engine always honored totalMs — the gate was the only blocker).
//   ✓ v0.3 (v1.33.7) AUDIO-ONLY TIMELINES: zero visual segments with
//     music/voice/SFX render black video over the audio's full length.
//   ✓ v0.3 (v1.33.7) LOUDNORM: audio.normalize measures each measured-branch
//     source IN-PROCESS (EBU R128 K-weighted gated LUFS, ≤90 s window —
//     constant cost) and applies a static linear gain toward −16 LUFS + a
//     measured master gain (the CLI clip/legacy-music semantics).
//   ✓ v0.3 (v1.33.7) OVERLAY MOTION PATHS: ≥2 keyframes interpolate the
//     overlay center piecewise-linearly (hold-first/hold-last).
//   ✗ slide/wipe/circleopen transitions, burn-in text removal, v1.17
//     kinetic Stack Text, kinetic without geometry → CLI

"use strict";

const path = require("path");
const fs = require("fs");

// v1.21: the kinetic preset motion/visual specs (the Electron mirror of
// src/lib/merger/kinetic/presets.ts — emission-relevant subset, kept in sync
// by kinetic-ass.js). Needed to EMBED each composition's spec into the Rust
// kinetic timeline (Rust never looks presets up by id).
const { getKineticPresetSpec } = require("./kinetic-ass.js");

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
      diagnostics: safeCall(() => rustEngine.loadDiagnostics()),
      lastFailure: lastRustFailure,
    };
  }
  return {
    loaded: false,
    error: rustEngineError,
    diagnostics: safeCall(() => {
      try {
        const loader = require(path.join(__dirname, "..", "rust-engine"));
        return loader.loadDiagnostics ? loader.loadDiagnostics() : undefined;
      } catch {
        return undefined;
      }
    }),
    lastFailure: lastRustFailure,
  };
}

/** v1.22 TRANSPARENCY: the LAST reason a Rust export was bypassed — the
 * gate refusal, the timeline-build failure, or the RUNTIME exportVideo
 * error (previously runtime failures silently became "FFmpeg CLI" with no
 * explanation — the #1 "why is the engine not working" complaint).
 * Shape: { at: epochMs, stage: "gate"|"timeline"|"runtime", reason: string } */
let lastRustFailure = null;

function recordRustFailure(stage, reason) {
  lastRustFailure = {
    at: Date.now(),
    stage,
    reason: String(reason || "").slice(0, 500),
  };
  return null;
}

/** The last bypass reason (null when the last Rust attempt succeeded). */
function rustFailureReason() {
  return lastRustFailure ? lastRustFailure.reason : null;
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

// v0.3 (v1.33.7): does the loaded engine know the NEW timeline fields
// (loopSrc / motion / normalizeAudio / normalizeSrc / ExtraAudio.loopSrc)?
// A hybrid install (new router + stale 0.2.0 binary) must NOT silently
// degrade — looping would freeze on the last frame, normalize would skip.
// Those scenarios route to the battle-tested CLI until the engine ships
// 0.3.0+ (serde default keeps old binaries LOADABLE for everything else).
const ENGINE_V03 = (() => {
  try {
    if (!rustEngine || typeof rustEngine.engineVersion !== "function") return false;
    const parts = String(rustEngine.engineVersion()).split(".").map(Number);
    const maj = parts[0] || 0;
    const min = parts[1] || 0;
    return maj > 0 || min >= 3;
  } catch {
    return false;
  }
})();

function rustEligible(opts) {
  if (!rustEngine) return { ok: false, reason: rustEngineError || "engine not loaded" };
  const reasons = [];

  // v2: voiceovers + SFX ride the NATIVE audio bus (extraAudio) — no gate.
  // v0.3 (v1.33.7): base-lane LOOP-TO-FILL, AUDIO-EXTENDED timelines,
  // AUDIO-ONLY timelines, loudnorm and overlay motion paths are ALL NATIVE
  // (engine v0.3) — the former gates are gone. The Rust path now covers
  // every export scenario except the four below.

  const segList = Array.isArray(opts.segments) ? opts.segments : [];
  const usableVisual = segList.some((s) => s && (s.videoPath || s.imagePath));
  if (!usableVisual) {
    // v0.3 AUDIO-ONLY: zero usable visual segments is fine when the project
    // carries audio — the engine renders black video over the audio's full
    // timeline. No audio at all → the CLI's honest "No segments" error.
    const hasAudio =
      (Array.isArray(opts.musicClips) && opts.musicClips.length > 0) ||
      (typeof opts.audioPath === "string" && opts.audioPath) ||
      (Array.isArray(opts.voiceovers) && opts.voiceovers.some((v) => v && typeof v.wavPath === "string" && v.wavPath)) ||
      (Array.isArray(opts.sfx) && opts.sfx.some((x) => x && typeof x.wavPath === "string" && x.wavPath));
    if (!hasAudio) reasons.push("empty-timeline");
  }

  // ── v0.3 scenario capabilities (engine-version guard) ───────────────
  // Each flag below marks a payload that NEEDS a 0.3.0+ engine; a stale
  // binary routes it to the CLI instead of silently degrading.
  let needsV03 = false;
  // base-lane loop-to-fill
  if (segList.some((s) => s && (Number(s.track) || 0) === 0 && s.mediaType === "video" && s.loop === true)) {
    needsV03 = true;
  }
  // audio-extended timeline (payload total beyond the visuals)
  if (segList.length > 0) {
    const segTotalMs = segList.reduce(
      (sum, s) => Math.max(sum, (s && (s.endMs ?? (s.startMs ?? 0) + (s.durationMs ?? 0))) || 0),
      0,
    );
    const payloadTotalMs = Number.isFinite(Number(opts.totalMs)) ? Math.max(0, Number(opts.totalMs)) : 0;
    if (payloadTotalMs > segTotalMs + 250) needsV03 = true;
  }
  // audio-only timeline
  if (!usableVisual) needsV03 = true;
  // loudnorm
  if (opts.audio && opts.audio.normalize) needsV03 = true;
  // overlay motion paths (≥2 keyframes)
  if (
    Array.isArray(opts.overlays) &&
    opts.overlays.some(
      (o) => o && o.overlay && Array.isArray(o.overlay.motion) && o.overlay.motion.length >= 2,
    )
  ) {
    needsV03 = true;
  }
  // music clips 2..N with loop (ExtraAudio.loopSrc)
  if (
    Array.isArray(opts.musicClips) &&
    opts.musicClips.slice(1).some((c) => c && c.loop)
  ) {
    needsV03 = true;
  }
  if (needsV03 && !ENGINE_V03) reasons.push("engine-pre-0.3");

  const tr = opts.textRemoval;
  if (tr && tr.mode && tr.mode !== "none" && Array.isArray(tr.regions) && tr.regions.length > 0) {
    reasons.push("text-removal");
  }

  // v1.20 NATIVE CAPTIONS: burned-in captions NO LONGER gate the Rust
  // engine — the native caption renderer (rust-engine/src/captions.rs)
  // paints the full v4.1 vocabulary (word modes + karaoke highlight + the
  // 24 kinetic animations) through fontdue + the compositor text path.
  // ONLY the v1.18 kinetic-TYPOGRAPHY engine still rides the CLI's ASS/
  // libass compositor (per-word override-tag choreography) — gated below.

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

  // v0.3: loudnorm is NATIVE (in-process EBU R128 measurement + static
  // linear gain toward −16 LUFS — engine v0.3). No gate.

  // v1.17 STACK TEXT: any headline with a stackStyle set rides the ASS/
  // libass CLI compositor (the kinetic recipes are libass tags — the Rust
  // engine's fontdue texts have no equivalent). This is the "export picks
  // the best technique by default" gate: kinetic Stack Text → CLI, plain
  // headlines keep the Rust fast path.
  const headlineList = Array.isArray(opts.headlines) ? opts.headlines : [];
  if (headlineList.some((h) => h && h.stackStyle)) reasons.push("stack-text");

  // v1.18 KINETIC CAPTIONS (typography engine): NATIVE since v1.21 —
  // rust-engine/src/kinetic.rs renders the per-word choreography (an exact
  // port of kinetic/motion.ts) over the renderer-measured geometry with the
  // SAME bundled TTFs. Only gated when the renderer could not measure
  // geometry (no document — practically never in Electron): the CLI's
  // libass emitter needs the geometry too, so the export degrades to the
  // legacy pipeline rather than silently dropping captions.
  const kineticOn =
    opts.captionSettings &&
    opts.captionSettings.kinetic &&
    opts.captionSettings.kinetic.enabled;
  if (kineticOn) {
    const geo = Array.isArray(opts.kineticGeometry) ? opts.kineticGeometry : [];
    if (geo.length === 0) reasons.push("kinetic-no-geometry");
  }

  // v0.3: overlay motion paths (≥2 keyframes) are NATIVE — the engine
  // interpolates the overlay center piecewise-linearly. No gate.
  const overlays = Array.isArray(opts.overlays) ? opts.overlays : [];

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

// ── v1.20 CAPTION FONTS: the export payload's captionSettings.fontName is
// the ASS/ffmpeg name (e.g. "Montserrat", "Impact") — the native renderer
// needs an OS FONT FILE. Same resolution philosophy as FONT_ASS_NAMES in
// kinetic-ass.js: web fonts that Windows never ships map to their closest
// system face (Montserrat → Arial Bold, Bebas → Impact, …).
const CAPTION_FONT_FILES = {
  // (the OS fallback table — v1.21 prefers the BUNDLED TTFs for the five
  // web families; these entries serve every other face + non-bundled runs)
  win32: {
    // [regular, bold] per family name.
    Arial: ["C:\\Windows\\Fonts\\arial.ttf", "C:\\Windows\\Fonts\\arialbd.ttf"],
    Montserrat: ["C:\\Windows\\Fonts\\arial.ttf", "C:\\Windows\\Fonts\\arialbd.ttf"],
    Inter: ["C:\\Windows\\Fonts\\arial.ttf", "C:\\Windows\\Fonts\\arialbd.ttf"],
    Roboto: ["C:\\Windows\\Fonts\\arial.ttf", "C:\\Windows\\Fonts\\arialbd.ttf"],
    "Segoe UI": ["C:\\Windows\\Fonts\\segoeui.ttf", "C:\\Windows\\Fonts\\segoeuib.ttf"],
    Tahoma: ["C:\\Windows\\Fonts\\tahoma.ttf", "C:\\Windows\\Fonts\\tahomabd.ttf"],
    Verdana: ["C:\\Windows\\Fonts\\verdana.ttf", "C:\\Windows\\Fonts\\verdanab.ttf"],
    "Trebuchet MS": ["C:\\Windows\\Fonts\\trebuc.ttf", "C:\\Windows\\Fonts\\trebucbd.ttf"],
    Impact: ["C:\\Windows\\Fonts\\impact.ttf", "C:\\Windows\\Fonts\\impact.ttf"],
    Bebas: ["C:\\Windows\\Fonts\\impact.ttf", "C:\\Windows\\Fonts\\impact.ttf"],
    "Arial Black": ["C:\\Windows\\Fonts\\ariblk.ttf", "C:\\Windows\\Fonts\\ariblk.ttf"],
    Georgia: ["C:\\Windows\\Fonts\\georgia.ttf", "C:\\Windows\\Fonts\\georgiab.ttf"],
    "Times New Roman": ["C:\\Windows\\Fonts\\times.ttf", "C:\\Windows\\Fonts\\timesbd.ttf"],
    "Courier New": ["C:\\Windows\\Fonts\\cour.ttf", "C:\\Windows\\Fonts\\courbd.ttf"],
    Consolas: ["C:\\Windows\\Fonts\\consola.ttf", "C:\\Windows\\Fonts\\consolab.ttf"],
    "Playfair Display": ["C:\\Windows\\Fonts\\georgia.ttf", "C:\\Windows\\Fonts\\georgiab.ttf"],
  },
  linux: {
    Arial: ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
    Montserrat: ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
    Inter: ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
    Roboto: ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
    "Segoe UI": ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
    Tahoma: ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
    Verdana: ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
    "Trebuchet MS": ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
    Impact: ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
    Bebas: ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
    "Arial Black": ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"],
    Georgia: ["/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"],
    "Times New Roman": ["/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"],
    "Courier New": ["/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"],
    Consolas: ["/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"],
    "Playfair Display": ["/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"],
  },
};

// ── v1.21 BUNDLED FONTS ─────────────────────────────────────────────────────
// The app ships the five caption/kinetic web families as static TTFs
// (public/fonts → extraResources "fonts" in the packaged app; the renderer
// loads the same files via @font-face, so preview-measure-export parity is
// byte-identical). Family name → { file prefix, available weights }.

const BUNDLED_FONT_FAMILIES = {
  Inter: { prefix: "Inter", weights: [400, 500, 600, 700, 800, 900] },
  Roboto: { prefix: "Roboto", weights: [400, 500, 700, 900] },
  Montserrat: { prefix: "Montserrat", weights: [400, 500, 600, 700, 800, 900] },
  "Bebas Neue": { prefix: "BebasNeue", weights: [400] },
  Bebas: { prefix: "BebasNeue", weights: [400] },
  "Playfair Display": { prefix: "PlayfairDisplay", weights: [400, 700, 900] },
};

let bundledFontsDirCache;
/** The bundled-fonts directory (packaged resources/fonts, dev public/fonts),
 *  or null when neither exists. */
function bundledFontsDir() {
  if (bundledFontsDirCache !== undefined) return bundledFontsDirCache;
  let dir = null;
  const candidates = [];
  try {
    if (process.versions && process.versions.electron) {
      const electron = require("electron");
      const app = electron && electron.app;
      if (app) {
        // packaged: resources/fonts (extraResources)
        candidates.push(path.join(process.resourcesPath || "", "fonts"));
        // dev: <repo>/public/fonts
        try {
          candidates.push(path.join(app.getAppPath(), "public", "fonts"));
        } catch {}
      }
    }
  } catch {}
  // plain node (tests / smoke harness): repo-relative
  candidates.push(path.join(__dirname, "..", "public", "fonts"));
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) {
        dir = c;
        break;
      }
    } catch {}
  }
  bundledFontsDirCache = dir;
  return dir;
}

/** Family + weight → a bundled TTF path (weight snapped to the closest
 *  available), or null when the family is not bundled. */
function resolveBundledFont(family, weight) {
  const dir = bundledFontsDir();
  if (!dir) return null;
  const name = String(family || "").trim();
  const spec = BUNDLED_FONT_FAMILIES[name];
  if (!spec) return null;
  const w = Number(weight) || 400;
  let best = spec.weights[0];
  let bestDist = Infinity;
  for (const cand of spec.weights) {
    const d = Math.abs(cand - w);
    if (d < bestDist) {
      bestDist = d;
      best = cand;
    }
  }
  const file = path.join(dir, `${spec.prefix}-${best}.ttf`);
  try {
    return fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

/** captionSettings.fontName (ASS name) → an existing OS font file path. */
function pickCaptionFont(fontName, fontWeight) {
  // v1.21: BUNDLED FONTS FIRST. The app ships the exact TTFs the preview
  // canvas measured with (public/fonts → resources/fonts) — "Montserrat"
  // now renders as ACTUAL Montserrat instead of the old Arial-Bold
  // stand-in (the "font selection does not match the preview" bug).
  const bundled = resolveBundledFont(String(fontName || ""), fontWeight);
  if (bundled) return bundled;
  const table = CAPTION_FONT_FILES[process.platform] || CAPTION_FONT_FILES.linux;
  const pair = table[fontName] || table.Arial;
  const wantBold = Number(fontWeight) >= 600;
  const candidates = wantBold ? [pair[1], pair[0]] : [pair[0], pair[1]];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return pickFont("sans");
}

/**
 * v1.20: export-native payload's captionSettings + subtitleCues → the
 * Rust `timeline.captions` block. Every px value is pre-scaled to the
 * OUTPUT canvas (the engine works in output px, hScale = height/1080).
 * Returns null when captions are off / no cues.
 */
function buildRustCaptions(opts, width, height) {
  const cs = opts.captionSettings;
  const cues = Array.isArray(opts.subtitleCues) ? opts.subtitleCues : [];
  if (!cs || !cs.enabled || cues.length === 0) return null;
  // The kinetic-typography engine never reaches here (rustEligible gates
  // it to the CLI compositor), but guard anyway — belt and braces.
  if (cs.kinetic && cs.kinetic.enabled) return null;

  const h = Math.max(16, height);
  const hScale = h / 1080;
  // v1.33.7 NaN GUARD: `fontSize` is the preset's height fraction (the
  // renderer always sends it), but a hand-crafted/legacy payload without
  // it made Number(undefined) → NaN → JSON "null" → a Rust timeline PARSE
  // ERROR and a silent CLI fallback (the safe-mode contract forbids that:
  // an omitted caption size must degrade to a sane default, not NaN).
  // v1.33.9: the SAME guard now covers EVERY numeric leaf here — the old
  // `x != null ? x : d` pattern let a NaN (null ≠ null, NaN ≠ null) flow
  // into Math.max/Math.round → NaN → JSON null (the engine's lenient
  // parse now repairs it, but the payload should never carry it).
  const numOr = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const rawFontPx = numOr(cs.fontSize, 0.05) * h * (numOr(cs.fontSizeScale, 1) || 1);
  const fontPx = Math.max(
    8,
    Math.round(Number.isFinite(rawFontPx) && rawFontPx > 0 ? rawFontPx : 0.05 * h),
  );

  return {
    fontKey: "caption",
    fontSizePx: fontPx,
    textColor: String(cs.textColor || "#FFFFFF"),
    highlightColor: cs.highlightColor ? String(cs.highlightColor) : null,
    borderColor: String(cs.borderColor || "#000000"),
    borderWidthPx: Math.max(0, Math.round(Number(cs.borderWidth) || 0) * hScale),
    bgColor: cs.bgColor ? String(cs.bgColor) : null,
    bgAlpha: Math.max(0, Math.min(1, numOr(cs.bgAlpha, 1))),
    bgPaddingPx: Math.max(0, Math.round(numOr(cs.bgPadding, 12) * hScale)),
    shadow: !!(cs.shadow),
    shadowColor: String(cs.shadowColor || "#000000"),
    shadowPx: Math.max(1, Math.round((numOr(cs.shadowBlur, 3) || 3) * hScale)),
    textTransform: String(cs.textTransform || "none"),
    letterSpacingPx: Math.max(0, Math.round(Number(cs.letterSpacing) || 0) * hScale),
    alignment: String(cs.alignment || "center"),
    position: String(cs.customPosition || cs.position || "bottom"),
    positionY: Math.max(0, Math.round(numOr(cs.positionY, 50) * hScale)),
    maxWidthFrac: Math.max(0.1, Math.min(1, numOr(cs.maxWidth, 0.84))),
    wordMode: String(cs.wordMode || "off"),
    animation: String(cs.animation || "none"),
    cues: cues
      .filter((c) => c && Number(c.endMs) > Number(c.startMs))
      .map((c) => ({
        startMs: Number(c.startMs) || 0,
        endMs: Number(c.endMs) || 0,
        text: String(c.text || ""),
        words: Array.isArray(c.words) && c.words.length > 0
          ? c.words.map((w) => ({
              text: String(w.text || ""),
              startMs: Number(w.startMs) || 0,
              endMs: Number(w.endMs) || 0,
            }))
          : [],
      })),
  };
}

// ── v1.21 NATIVE KINETIC TYPOGRAPHY ──────────────────────────────────────────

/** FONT_OPTIONS id → family display name (the captionPresets.ts mirror). */
const KINETIC_FAMILY_NAMES = {
  inter: "Inter",
  roboto: "Roboto",
  montserrat: "Montserrat",
  segoe: "Segoe UI",
  impact: "Impact",
  "arial-black": "Arial Black",
  bebas: "Bebas Neue",
  playfair: "Playfair Display",
  georgia: "Georgia",
  arial: "Arial",
  trebuchet: "Trebuchet MS",
  tahoma: "Tahoma",
  times: "Times New Roman",
  courier: "Courier New",
  verdana: "Verdana",
};

/** Resolve a kinetic word's font file (bundled TTF first, OS fallback) and
 *  register it in the timeline fonts map. Returns the font KEY. */
function kineticFontKey(family, weight, fontsMap) {
  let file = resolveBundledFont(family, weight);
  if (!file) file = pickCaptionFont(family, weight);
  const key = "kinf:" + file;
  if (!(key in fontsMap)) fontsMap[key] = file;
  return key;
}

/**
 * v1.21: the export-native payload's kinetic plan (renderer-measured)
 * → the Rust `timeline.kinetic` block. Joins kineticCompositions (the
 * semantic plan — §36: Rust never re-derives it) with kineticGeometry
 * (matched by cueStartMs, exactly like the CLI emitter), embeds each
 * composition's preset motion spec, and resolves per-word font files
 * (family + effective weight → bundled TTF / OS face). Returns null when
 * kinetic is off or nothing matched (caller keeps the plain captions).
 */
function buildRustKinetic(opts, fontsMap) {
  const cs = opts.captionSettings;
  const kinetic = cs && cs.kinetic;
  if (!cs || !cs.enabled || !kinetic || !kinetic.enabled) return null;
  const comps = Array.isArray(opts.kineticCompositions) ? opts.kineticCompositions : [];
  const geoList = Array.isArray(opts.kineticGeometry) ? opts.kineticGeometry : [];
  if (comps.length === 0 || geoList.length === 0) return null;

  const baseColor = String(cs.customColor || "#FFFFFF");
  const motionLevel = String(kinetic.motion || "dynamic");
  const fontOverride = kinetic.fontOverride || null;
  const accentOverride = kinetic.accentOverride || null;

  const out = [];
  for (const comp of comps) {
    if (!comp || !(Number(comp.endMs) > Number(comp.startMs))) continue;
    const g = geoList.find(
      (x) => x && Number(x.cueStartMs) === Number(comp.startMs),
    );
    if (!g || !Array.isArray(g.words) || g.words.length === 0) continue;
    const spec = getKineticPresetSpec(comp.presetId);
    if (!spec) continue;

    // The family the renderer measured with (fontOverride wins).
    const family =
      KINETIC_FAMILY_NAMES[fontOverride || spec.fontId] ||
      KINETIC_FAMILY_NAMES[fontOverride] ||
      "Inter";
    const compAccent = String(accentOverride || spec.accentColor || "#FACC15");

    const words = g.words
      .filter((w) => w && w.text)
      .map((w) => {
        const weight = Math.max(
          100,
          Math.min(900, Math.round(Number(w.weight) || 400)),
        );
        return {
          text: String(w.text),
          startMs: Number(w.startMs) || 0,
          endMs: Number(w.endMs) || 0,
          x: Number(w.x) || 0,
          y: Number(w.y) || 0,
          w: Number(w.w) || 0,
          h: Number(w.h) || 0,
          fontPx: Number(w.fontPx) || 40,
          weight,
          emphasis: !!w.emphasis,
          role: String(w.role || "supporting"),
          phraseIndex: Math.max(0, Math.round(Number(w.phraseIndex) || 0)),
          fontKey: kineticFontKey(family, weight, fontsMap),
        };
      });
    if (words.length === 0) continue;

    const phrases = (Array.isArray(comp.phrases) ? comp.phrases : []).map((p) => ({
      role: String((p && p.role) || "supporting"),
      align: String((p && p.align) || "center"),
    }));

    out.push({
      startMs: Number(comp.startMs) || 0,
      endMs: Number(comp.endMs) || 0,
      preset: {
        entrance: String(spec.entrance || "fade-rise"),
        entranceMs: Number(spec.entranceMs) || 300,
        staggerMs: Number(spec.staggerMs) || 110,
        overshoot: Number(spec.overshoot) || 0,
        emphasisMotion: String(spec.emphasisMotion || "hold"),
        hold: String(spec.hold || "none"),
        exit: String(spec.exit || "fade"),
        exitMs: Number(spec.exitMs) || 300,
        shadow: spec.shadow !== false,
        supportAlpha: Number(spec.supportAlpha) || 0.78,
      },
      accentColor: compAccent,
      words,
      phrases,
    });
  }
  if (out.length === 0) return null;
  return {
    baseColor,
    accentColor: String(accentOverride || "#FACC15"),
    motionLevel,
    comps: out,
  };
}
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
  // v0.3 (v1.33.7) AUDIO-EXTENDED / AUDIO-ONLY: max(segments end, payload
  // totalMs) — the renderer's authoritative total (audio-driven timelines)
  // ALWAYS wins; past the last visual segment the engine composites the
  // background + captions across the full length (the CLI black-tail
  // parity) and the native audio bus mixes to the same end.
  const segTotalMs = segments.reduce(
    (sum, s) =>
      Math.max(sum, s.endMs ?? (s.startMs ?? 0) + (s.durationMs ?? 0)),
    0,
  );
  const payloadTotalMs = Number.isFinite(Number(opts.totalMs)) ? Math.max(0, Number(opts.totalMs)) : 0;
  const totalMs = Math.max(segTotalMs, payloadTotalMs);
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
      // v0.3 (v1.33.7) BASE-LANE LOOP-TO-FILL: the renderer already
      // extended this segment's window to the fill end; the engine now
      // wraps the decode position across the trimmed source span and loops
      // the clip's own audio (the CLI `-stream_loop` parity).
      loopSrc: isVideo && s.loop === true,
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
    // v0.3 (v1.33.7) OVERLAY MOTION PATH: ≥2 keyframes ride natively —
    // the engine interpolates the overlay center piecewise-linearly
    // (hold-first / hold-last), exactly like the renderer/CLI curves.
    const motionRaw =
      o.overlay && Array.isArray(o.overlay.motion) ? o.overlay.motion : [];
    const motion = motionRaw
      .filter((k) => k && Number.isFinite(k.x) && Number.isFinite(k.y))
      .map((k) => ({
        tMs: Math.max(0, Number(k.tMs) || 0),
        x: Math.max(0, Math.min(1, Number(k.x))),
        y: Math.max(0, Math.min(1, Number(k.y))),
      }))
      .sort((a, b) => a.tMs - b.tMs);
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
      volume: zvPlain(o.volume),
      sourceWidth: null,
      sourceHeight: null,
      kenBurns: null,
      geometry: geo,
      chroma: o.chroma
        ? {
            color: String(o.chroma.color || "#00b140"),
            // v1.33.9: `Number(x) ?? d` let a NaN through (?? catches only
            // null/undefined, NOT NaN) → Math.min(1, NaN) = NaN → JSON
            // null. Finite-or-default semantics match the Rust
            // lenient-parse table.
            similarity: Math.max(0, Math.min(1, (typeof o.chroma.similarity === "number" && Number.isFinite(o.chroma.similarity) ? o.chroma.similarity : 0.31))),
            smoothness: Math.max(0, Math.min(1, (typeof o.chroma.smoothness === "number" && Number.isFinite(o.chroma.smoothness) ? o.chroma.smoothness : 0.08))),
          }
        : null,
      opacity: 1,
      overlayLoop: !!o.overlayLoop,
      loopSrc: false,
      motion: motion.length >= 2 ? motion : [],
      hasAudio: isVideo,
    });
  }

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
  // v1.25 MULTI-MUSIC: prefer the `musicClips` stack (N placements). The
  // native engine's music channel takes clip 0 (full support incl. loop);
  // v0.3: the remaining clips ride the extraAudio bus WITH loop support
  // (ExtraAudio.loopSrc — the "no loop in the native engine" limitation is
  // gone). Legacy payloads (audioPath + audio.music*) unchanged — the
  // legacy branch is the ONLY normalizeSrc music track (CLI parity: the CLI
  // measures the legacy single-music input, music-clip placements are
  // user-volume branches).
  const audio = opts.audio || {};
  const musicClipList = Array.isArray(opts.musicClips)
    ? opts.musicClips.filter((c) => c && typeof c.path === "string" && c.path)
    : [];
  let music = null;
  if (musicClipList.length > 0) {
    const first = musicClipList[0];
    music = {
      path: String(first.path),
      volume: Math.max(0, Math.min(2, Number(first.volume) || 1)),
      startMs: Math.max(0, Number(first.startMs) || 0),
      loopTrack: !!first.loop,
      normalizeSrc: false,
    };
    if (musicClipList.length > 1) {
      console.log(
        `[RustEngine] ${musicClipList.length} music clips: clip 1 rides the music channel, ${musicClipList.length - 1} join the extra-audio bus (both with loop support)`,
      );
    }
  } else if (opts.audioPath) {
    music = {
      path: String(opts.audioPath),
      volume: Math.max(0, Math.min(2, Number(audio.musicVolume) || 1)),
      startMs: Math.max(0, Number(audio.musicStartMs) || 0),
      loopTrack: !!audio.musicLoop,
      normalizeSrc: true,
    };
  }

  // ── v2 EXTRA AUDIO: voiceovers (narration MP3 / dub WAVs) + SFX
  // placements → the native audio bus. MP3s arrive 24 kHz mono — the
  // engine's swresample stage upmixes to the 48 kHz stereo bus.
  const extraAudio = [];
  // v1.25: music clips 2..N ride the extra-audio bus; v0.3: WITH loop
  // (ExtraAudio.loopSrc — music-clip loop placements loop natively now).
  for (let mi = 1; mi < musicClipList.length; mi += 1) {
    const mc = musicClipList[mi];
    extraAudio.push({
      path: String(mc.path),
      startMs: Math.max(0, Number(mc.startMs) || 0),
      volume: Math.max(0, Math.min(2, Number(mc.volume) || 1)),
      loopSrc: !!mc.loop,
    });
  }
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

  // ── v0.3 (v1.33.7) AUDIO-ONLY: zero visual segments is legal when the
  // project carries audio (music/voice-over/SFX) — the engine composites
  // the background across the audio's full timeline. A completely empty
  // project (no visuals AND no audio) still refuses (the CLI's "No
  // segments" error stays the honest verdict).
  const hasAnyAudioSource =
    musicClipList.length > 0 ||
    (typeof opts.audioPath === "string" && opts.audioPath) ||
    voList.length > 0 ||
    sfxList.length > 0;
  if (rustSegments.length === 0 && !hasAnyAudioSource) {
    return { error: "no segments" };
  }
  if (rustSegments.length === 0) {
    console.log(
      `[RustEngine] audio-only timeline: 0 visual segment(s) — the engine renders the background over the audio's full ${
        (totalMs / 1000).toFixed(1)
      }s timeline`,
    );
  }

  // ── v1.20 CAPTIONS: the native caption block + its font file ──
  // ── v1.21 KINETIC: when kinetic typography is ON it REPLACES the plain
  // captions (the preview painter dispatches the same way) — the kinetic
  // timeline registers its per-word font files into fontsMap as it builds.
  const captions = buildRustCaptions(opts, width, height);
  const fontsMap = { sans: pickFont("sans"), mono: pickFont("mono") };
  if (captions) {
    fontsMap.caption = pickCaptionFont(
      opts.captionSettings && opts.captionSettings.fontName,
      opts.captionSettings && opts.captionSettings.fontWeight,
    );
  }
  const kinetic = buildRustKinetic(opts, fontsMap);

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
    // v0.3 (v1.33.7) LOUDNORM: in-process EBU R128 K-weighted gated
    // measurement + static linear gains toward −16 LUFS (engine v0.3) —
    // the CLI clip/legacy-music semantics, no ffmpeg child.
    normalizeAudio: !!(audio.normalize),
    audioTargetLufs: -16,
    fonts: fontsMap,
    segments: rustSegments,
    music,
    extraAudio,
    texts,
    watermark,
    // v1.20 NATIVE CAPTIONS (null when off — the engine no-ops).
    // v1.21: kinetic typography REPLACES the plain captions when present.
    captions: kinetic ? null : captions,
    kinetic,
  };
  // v1.33.9 NaN SWEEP (the "Timeline parse error: invalid type: null,
  // expected f64" root-cause belt-and-braces): `JSON.stringify` silently
  // serializes NaN/Infinity as null, and the Rust schema's numeric fields
  // are non-Option — ONE leaked NaN anywhere (a renderer bug, a restored
  // project, a hand-crafted payload) used to fail the whole engine parse
  // and route the export to the SLOW CLI fallback. The engine 0.4.2
  // lenient-parse now repairs these too, but the payload must never carry
  // them in the first place. Same key/default table as
  // rust-engine/src/timeline.rs NUMERIC_DEFAULTS.
  sanitizeTimelineNumbers(timeline);
  return { timeline, slideshowFpsApplied, fps };
}

// The numeric-leaf defaults (camelCase JSON names — mirrors Rust
// timeline.rs NUMERIC_DEFAULTS). Applied ONLY to existing keys whose value
// is not a finite number; never invents fields.
const TIMELINE_NUMERIC_DEFAULTS = {
  fps: 30, bitrateMbps: 0, totalMs: 0, fadeInMs: 0, fadeOutMs: 0,
  startMs: 0, endMs: 0, durationMs: 0, trimInMs: 0, speed: 1, volume: 1,
  opacity: 1, transHeadMs: 0, transTailMs: 0, bookendStartMs: 0, bookendEndMs: 0,
  zoomMax: 1.06, x: 0.5, y: 0.5, w: 0.3, h: 0, similarity: 0.31, smoothness: 0.08,
  size: 72, fadeMs: 250, fontSizePx: 48, borderWidthPx: 0, bgAlpha: 1,
  bgPaddingPx: 12, shadowPx: 3, letterSpacingPx: 0, positionY: 50, maxWidthFrac: 0.84,
  entranceMs: 300, staggerMs: 110, overshoot: 0, exitMs: 300, supportAlpha: 0.78,
  fontPx: 40, tMs: 0,
};

/** Replace non-finite numbers on the known numeric keys with their defaults
 *  (in place). Never throws; strings/bools on those keys pass through (the
 *  engine's lenient parse coerces numeric strings; wrong-typed payloads are
 *  a different failure class surfaced by serde). */
function sanitizeTimelineNumbers(node) {
  if (Array.isArray(node)) {
    for (const item of node) sanitizeTimelineNumbers(item);
    return;
  }
  if (node && typeof node === "object") {
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (key in TIMELINE_NUMERIC_DEFAULTS) {
        if (typeof v === "number" && !Number.isFinite(v)) {
          node[key] = TIMELINE_NUMERIC_DEFAULTS[key];
          continue;
        }
      }
      if (v && typeof v === "object") sanitizeTimelineNumbers(v);
    }
  }
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
    recordRustFailure("gate", `unsupported feature: ${gate.reason}`);
    return null;
  }
  // v1.20.1 SAFE-MODE HARDENING: buildRustTimeline runs INSIDE the guard —
  // ANY bug in the timeline mapping (a ReferenceError like the v1.20 `zv`
  // typo that crashed the whole `export-native` IPC call with "zv is not
  // defined") must degrade to the FFmpeg-CLI pipeline, never fail an export
  // that would otherwise succeed.
  let built;
  try {
    built = buildRustTimeline(opts);
  } catch (err) {
    console.log(
      `[RustEngine] timeline build failed (${(err && err.message) || err}) — Safe Mode: CLI pipeline`,
    );
    recordRustFailure("timeline", `timeline build failed: ${(err && err.message) || err}`);
    return null;
  }
  if (built.error) {
    console.log(`[RustEngine] timeline build refused: ${built.error}`);
    recordRustFailure("timeline", `timeline build refused: ${built.error}`);
    return null;
  }
  if (built.timeline.captions) {
    console.log(
      `[RustEngine] native captions ON — ${built.timeline.captions.cues.length} cue(s)` +
        `, mode=${built.timeline.captions.wordMode}` +
        `, anim=${built.timeline.captions.animation}` +
        `, font=${built.timeline.fonts.caption}`,
    );
  }
  if (built.timeline.kinetic) {
    const kinFonts = new Set(built.timeline.kinetic.comps.flatMap((c) => c.words.map((w) => w.fontKey)));
    console.log(
      `[RustEngine] native KINETIC typography ON — ${built.timeline.kinetic.comps.length} composition(s)` +
        `, motion=${built.timeline.kinetic.motionLevel}` +
        `, ${kinFonts.size} font face(s)`,
    );
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
        // v1.33.8: etaMs is a NUMBER (0 = "estimating…", only the done event
        // carries a meaningful 0). The old truthiness check dropped the done
        // event's 0 → "estimating…" at completion.
        event.sender.send("export-progress", {
          progress: Math.max(0, Math.min(100, p.percent)),
          fps: p.fps || 0,
          eta: Number.isFinite(p.etaMs) ? Math.round(p.etaMs / 100) / 10 : undefined,
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
    // v1.22: a SUCCESSFUL Rust run clears the bypass trace — the badge and
    // the diagnostics card must report the CURRENT truth, not history.
    lastRustFailure = null;
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
      // v1.33.9: which packet-dedup fast path ran — the completion report
      // carries it so a slow export is diagnosable at a glance (dedup
      // vetoed by captions/ken-burns/overlays = honest per-frame work).
      rustDedup: res.dedup || undefined,
    };
  } catch (err) {
    // v1.33.9: a USER CANCEL is not a failure — the old code caught
    // "cancelled" like any runtime error, returned null, and the
    // export-native handler fell into the CLI pipeline, silently
    // RESTARTING the whole encode from scratch (the first Cancel click
    // just switched the badge to "FFmpeg CLI"). The sentinel re-throws so
    // the handler aborts the export the user asked to abort.
    if (err && err.message === "cancelled") {
      console.log("[RustEngine] export cancelled by user — aborting (NO CLI fallback)");
      throw err;
    }
    console.error(
      `[RustEngine] export failed after ${Date.now() - startedAt}ms — falling back to FFmpeg CLI:`,
      (err && err.message) || err,
    );
    // v1.22: RUNTIME failures (DLL family mismatch, wgpu adapter error,
    // encode failure…) now LEAVE A TRACE — the Header badge + the Engine
    // diagnostics card show this reason instead of a silent "FFmpeg CLI".
    recordRustFailure("runtime", `engine run failed: ${(err && err.message) || err}`);
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

/**
 * v1.20: WHY the CLI pipeline was chosen for this export (null when the
 * Rust engine is eligible or not loaded at all). The main process threads
 * this into the export-progress payload so the UI can show the routing
 * reason instead of a silent "FFmpeg CLI" badge.
 * v1.22: ALSO consults the runtime failure trace — a gate pass that then
 * failed INSIDE the engine (DLLs, wgpu) is reported with the real reason.
 */
function rustGateReason(opts) {
  if (!rustEngine) return null;
  const gate = rustEligible(opts);
  if (gate.ok) {
    // The gate passed but the engine may still have failed at RUNTIME on
    // the last attempt — that reason outranks "eligible" for the badge.
    return lastRustFailure ? lastRustFailure.reason : null;
  }
  return gate.reason;
}

// ── v1.22 SELF-TEST (the "why is it ALWAYS falling back" answer) ───────────
// A REAL end-to-end mini export through the ACTUAL engine in the ACTUAL
// runtime (same load path, same DLL dir resolution, same wgpu adapter) —
// 36 frames of a generated solid-color image + a text layer, 640×360.
// Returns the whole story: load status, engine used, encoder, adapter, wall
// time, or the exact error. Writes a tiny PNG via zlib (zero deps) so the
// test never depends on repo sample files that don't ship in the package.

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of Buffer.concat([typeBuf, data])) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** Write a solid-color PNG (w×h, [r,g,b]) — dependency-free. */
function writeSolidPng(filePath, w, h, rgb) {
  const zlib = require("zlib");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      raw[o++] = rgb[0]; raw[o++] = rgb[1]; raw[o++] = rgb[2];
    }
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  fs.writeFileSync(filePath, png);
  return filePath;
}

async function runRustSelfTest(ffmpegPath, outDir) {
  const status = rustEngineStatus();
  if (!rustEngine) {
    return {
      ok: false,
      stage: "load",
      error: status.error || "engine not loaded",
      status,
    };
  }
  let outPath;
  let imgPath;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    outPath = path.join(outDir, `engine-selftest-${Date.now()}.mp4`);
    imgPath = writeSolidPng(path.join(outDir, `engine-selftest-${Date.now()}.png`), 320, 180, [32, 35, 43]);
  } catch (err) {
    return { ok: false, stage: "temp", error: String(err.message || err), status };
  }
  // A real font file for the text layer: the bundled Inter (packaged
  // resources/fonts or dev public/fonts), OS fallback resolved by the
  // engine's own font search when empty.
  let fontFile = "";
  try {
    const fontsDir = bundledFontsDir();
    if (fontsDir) {
      const cand = path.join(fontsDir, "Inter-700.ttf");
      if (fs.existsSync(cand)) fontFile = cand;
    }
  } catch (_) { /* engine falls back to the OS font search */ }
  const timeline = {
    version: 2,
    width: 640,
    height: 360,
    fps: 12,
    backgroundColor: "#0c0a09",
    totalMs: 3000,
    fadeInMs: 0,
    fadeOutMs: 0,
    fonts: { sans: fontFile },
    segments: [
      {
        id: "selftest",
        mediaType: "image",
        path: imgPath,
        startMs: 0,
        endMs: 3000,
        durationMs: 3000,
        trimInMs: 0,
        speed: 1,
        track: 0,
        volume: 1,
      },
    ],
    texts: [
      {
        text: "FrameFuse engine test",
        startMs: 0,
        endMs: 3000,
        font: "sans",
        size: 44,
        color: "#fbbf24",
        outlineColor: "#000000",
        position: "center",
        x: 0.5,
        fadeMs: 0,
      },
    ],
    extraAudio: [],
  };
  const dllDir = ffmpegDllDir(ffmpegPath);
  const startedAt = Date.now();
  try {
    const res = await rustEngine.exportVideo(
      JSON.stringify(timeline),
      outPath,
      dllDir,
      () => {}, // no progress relay for a 36-frame test
    );
    let size = 0;
    try { size = fs.statSync(outPath).size; } catch (_) { /* best effort */ }
    const cleanup = () => {
      try { fs.unlinkSync(outPath); } catch (_) {}
      try { fs.unlinkSync(imgPath); } catch (_) {}
    };
    cleanup();
    return {
      ok: true,
      engineUsed: res.engineUsed,
      encoderName: res.encoderName,
      adapter: res.adapter,
      ffmpegFamily: res.ffmpegFamily,
      frames: res.frames,
      wallMs: Date.now() - startedAt,
      outputBytes: size,
      dllDir,
      status,
    };
  } catch (err) {
    try { fs.unlinkSync(outPath); } catch (_) { /* best effort */ }
    try { fs.unlinkSync(imgPath); } catch (_) { /* best effort */ }
    recordRustFailure("runtime", `self-test failed: ${(err && err.message) || err}`);
    return {
      ok: false,
      stage: "run",
      error: String((err && err.message) || err),
      dllDir,
      status: rustEngineStatus(),
    };
  }
}

module.exports = {
  rustEngine,
  rustEngineStatus,
  rustEligible,
  buildRustTimeline,
  runRustExport,
  requestRustCancel,
  rustGateReason,
  rustFailureReason,
  runRustSelfTest,
};
