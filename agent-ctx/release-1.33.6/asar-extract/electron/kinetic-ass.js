// electron/kinetic-ass.js — plain-JS ASS mirror of the kinetic typography
// caption engine (mirror of src/lib/merger/kinetic/{presets,motion}.ts —
// keep in sync). Consumes renderer-measured geometry (canvas↔ASS parity).
//
// The renderer (src/lib/merger/kinetic/*) plans per-composition caption
// designs — semantic phrase grouping, hierarchy, motion choreography — and
// measures each composition's geometry (absolute word x/y/w/h/fontPx) at
// the export resolution (render.ts measureKineticPlanFor). This module
// converts those payloads (native.ts ipcKineticCompositions +
// ipcKineticGeometry + cs.kinetic) into libass Dialogue events with
// per-word inline override tags — exactly like the v1.17 stack-text
// emitter (electron/stack-text-ass.js): same structure, same conventions,
// nothing invented here (every number traces back to presets.ts/motion.ts).
//
// Emission model (verified libass semantics — trust these):
//   - ONE ASS Style per composition (KineticC<idx>): Fontname = the resolved
//     preset font (FONT_ASS_NAMES mirrors the renderer's FONT_OPTIONS
//     ffmpegName table), Fontsize = the measured base fontPx, Alignment 5
//     (all positioning is absolute inline \pos/\move anyway).
//   - PER-WORD MODE (ANY entrance with positional motion — x OR y: slide-x,
//     burst, converge, typewriter, fade-rise, slide-y, push): ONE Dialogue
//     PER WORD with \an5\move(from → measured word center, 0, entranceMs)
//     (typewriter: static \pos, the Dialogue start time IS the reveal).
//     v1.27.2 parity: fade-rise/slide-y/push previously degraded to
//     alpha-only INLINE lines (y-motion "not representable" inline) — but
//     per-word \move DOES express it, so they now ride the per-word path
//     with the exact motion.ts e=0 offsets (36/42/30 · energy · role).
//   - INLINE MODE (scale/blur/clip entrances without positional motion:
//     word-pop, scale-slam, clip-wipe, blur-focus, flash): ONE Dialogue per
//     LINE, \an5\pos(lineCenter) anchoring, each word in its own {...}
//     block carrying \fs (phrase scale) + \b (phrase weight) + \1c (accent
//     for emphasis words) + \alpha (supporting muted tier, §27) + the
//     entrance \t choreography. \t/\move times are MILLISECONDS RELATIVE
//     TO THE DIALOGUE START. Per-word \fscx changes shift later words in the
//     line (libass layout) — inherent, accepted (the v1.17 emitter had the
//     same class of asymmetry).
//   - Exit: \fad(0, exitMs) on every Dialogue (motion.ts exit window) —
//     only when the composition actually ENDS inside the window (a
//     window-clipped composition continues in the next chunk; fading at
//     every window tail would pulse at segment/chunk boundaries).
//   - Words whose entrance already completed before the window opens emit
//     their SETTLED state (mid-composition chunk continuity).
//   - \frz<blockRotateDeg> in every word block (diagonal presets).
//
// DELIBERATE ASS-approximation deviations from motion.ts (documented):
//   - easeOutBack/easeOutCubic easing curves → linear \t/\move/\fad
//     interpolation (word-pop overshoot via the two-phase 115%→100% recipe;
//     scale-slam slam in ≤120ms).
//   - push-out phrase dim drops the upward drift (static \pos) → dim only.
//   - hold "active-word"/"active-accent" (per-frame state) → skipped; the
//     emphasis accent color is static on emphasis words instead (matches
//     the painter, which colors emphasis words permanently).
//   - exit slide-down/scale-out/collapse/push-out variants → \fad (fade).
//
// v1.27.2 PREVIEW-PARITY fixes (the painter in kinetic/render.ts is the
// source of truth — these bring the emitter BACK in line with it):
//   - Style Outline → 0 and Spacing → 0: the painter draws NO stroke and
//     measures with NO letter-spacing (trackingFrac is a dead preset field
//     in the painter); the old 2px stroke + tracking made burned words
//     visibly heavier/wider than the preview AND shifted libass line
//     layout away from the measured geometry.
//   - Supporting-tier settled alpha → 0.82 hardcoded (motion.ts's actual
//     multiplier; preset.supportAlpha was never read by the painter).
//   - push-out dimming fires for push entrance OR push-out exit (motion.ts's
//     `entrance === "push" || exit === "push-out"` condition).
//   - Per-word \b now thresholds the word's EFFECTIVE measured weight
//     (geo word weight — inline emphasis bumps included), not the phrase
//     weight.
//
// Self-contained CommonJS (ZERO Electron imports) so it is directly
// testable: node -e "const K=require('./electron/kinetic-ass.js'); ..."
//
// FF_DEBUG_KINETIC=1 logs every emitted Dialogue (FF_DEBUG_STACK pattern).

"use strict";

// ── mirror of presets.ts — EMISSION-RELEVANT subset of all 24 presets ──────
// Values copied EXACTLY from src/lib/merger/kinetic/presets.ts (shared base
// B: staggerMs 110, overshoot 0.12, exit fade, exitMs 300, shadow true,
// supportAlpha 0.78, blockRotateDeg 0) — keep in sync. Only the fields the
// emitter reads are mirrored; the full spec (typography/layout/segmentation
// metadata) stays renderer-side.
const KINETIC_PRESET_SPECS = [
  // ════════ FAMILY A — CINEMATIC (restrained, editorial) ════════
  { id: "editorial-stack", fontId: "inter", casing: "none", baseWeight: 500, emphasisWeight: 800,
    trackingFrac: 0.01, lineHeightFrac: 1.3, entrance: "fade-rise", entranceMs: 340, staggerMs: 110,
    overshoot: 0.12, emphasisMotion: "hold", hold: "drift", exit: "fade", exitMs: 300,
    accentColor: "#FBBF24", shadow: true, supportAlpha: 0.78, blockRotateDeg: 0 },
  { id: "cinematic-stack", fontId: "bebas", casing: "upper", baseWeight: 400, emphasisWeight: 400,
    trackingFrac: 0.04, lineHeightFrac: 1.14, entrance: "blur-focus", entranceMs: 420, staggerMs: 110,
    overshoot: 0.12, emphasisMotion: "hold", hold: "drift", exit: "fade", exitMs: 300,
    accentColor: "#FCD34D", shadow: true, supportAlpha: 0.78, blockRotateDeg: 0 },
  { id: "perspective-stack", fontId: "montserrat", casing: "none", baseWeight: 600, emphasisWeight: 800,
    trackingFrac: 0.0, lineHeightFrac: 1.26, entrance: "slide-y", entranceMs: 380, staggerMs: 150,
    overshoot: 0.12, emphasisMotion: "scale-punch", hold: "none", exit: "fade", exitMs: 300,
    accentColor: "#67E8F9", shadow: true, supportAlpha: 0.78, blockRotateDeg: 0 },
  { id: "whisper-type", fontId: "playfair", casing: "none", baseWeight: 400, emphasisWeight: 500,
    trackingFrac: 0.06, lineHeightFrac: 1.42, entrance: "fade-rise", entranceMs: 480, staggerMs: 90,
    overshoot: 0.12, emphasisMotion: "hold", hold: "drift", exit: "fade", exitMs: 300,
    accentColor: "#FDE68A", shadow: true, supportAlpha: 0.66, blockRotateDeg: 0 },
  { id: "progressive-stack", fontId: "montserrat", casing: "none", baseWeight: 600, emphasisWeight: 800,
    trackingFrac: 0.0, lineHeightFrac: 1.28, entrance: "word-pop", entranceMs: 260, staggerMs: 140,
    overshoot: 0.12, emphasisMotion: "scale-punch", hold: "active-word", exit: "fade", exitMs: 300,
    accentColor: "#A5B4FC", shadow: true, supportAlpha: 0.78, blockRotateDeg: 0 },
  // ════════ FAMILY B — DRAMATIC (impact moments) ════════
  { id: "punch-stack", fontId: "montserrat", casing: "upper", baseWeight: 700, emphasisWeight: 900,
    trackingFrac: 0.0, lineHeightFrac: 1.2, entrance: "scale-slam", entranceMs: 220, staggerMs: 130,
    overshoot: 0.22, emphasisMotion: "shake", hold: "active-accent", exit: "fade", exitMs: 300,
    accentColor: "#F87171", shadow: true, supportAlpha: 0.78, blockRotateDeg: 0 },
  { id: "impact-word", fontId: "arial-black", casing: "upper", baseWeight: 400, emphasisWeight: 900,
    trackingFrac: -0.01, lineHeightFrac: 1.18, entrance: "scale-slam", entranceMs: 200, staggerMs: 110,
    overshoot: 0.25, emphasisMotion: "scale-punch", hold: "pulse", exit: "fade", exitMs: 300,
    accentColor: "#FACC15", shadow: true, supportAlpha: 0.78, blockRotateDeg: 0 },
  { id: "highlight-stack", fontId: "inter", casing: "none", baseWeight: 600, emphasisWeight: 900,
    trackingFrac: 0.0, lineHeightFrac: 1.3, entrance: "fade-rise", entranceMs: 300, staggerMs: 110,
    overshoot: 0.12, emphasisMotion: "scale-punch", hold: "active-accent", exit: "fade", exitMs: 300,
    accentColor: "#FACC15", shadow: true, supportAlpha: 0.78, blockRotateDeg: 0 },
  { id: "fullscreen-type", fontId: "bebas", casing: "upper", baseWeight: 400, emphasisWeight: 400,
    trackingFrac: 0.03, lineHeightFrac: 1.08, entrance: "flash", entranceMs: 140, staggerMs: 70,
    overshoot: 0.12, emphasisMotion: "scale-punch", hold: "pulse", exit: "fade", exitMs: 300,
    accentColor: "#FACC15", shadow: true, supportAlpha: 0.78, blockRotateDeg: 0 },
  { id: "build-collapse", fontId: "montserrat", casing: "none", baseWeight: 700, emphasisWeight: 900,
    trackingFrac: 0.0, lineHeightFrac: 1.22, entrance: "word-pop", entranceMs: 240, staggerMs: 150,
    overshoot: 0.12, emphasisMotion: "scale-punch", hold: "pulse", exit: "collapse", exitMs: 380,
    accentColor: "#FB923C", shadow: true, supportAlpha: 0.78, blockRotateDeg: 0 },
  // ════════ FAMILY C — CONFLICT (spatial opposition) ════════
  { id: "split-stack", fontId: "montserrat", casing: "none", baseWeight: 700, emphasisWeight: 800,
    trackingFrac: 0.0, lineHeightFrac: 1.26, entrance: "slide-x", entranceMs: 340, staggerMs: 160,
    overshoot: 0.12, emphasisMotion: "hold", hold: "active-word", exit: "fade", exitMs: 300,
    accentColor: "#F87171", shadow: true, supportAlpha: 0.78, blockRotateDeg: 0 },
  { id: "type-collision", fontId: "arial-black", casing: "upper", baseWeight: 400, emphasisWeight: 900,
    trackingFrac: 0.0, lineHeightFrac: 1.18, entrance: "converge", entranceMs: 300, staggerMs: 60,
    overshoot: 0.18, emphasisMotion: "shake", hold: "none", exit: "fade", exitMs: 300,
    accentColor: "#F87171", shadow: true, supportAlpha: 0.78, blockRotateDeg: 0 },
  { id: "push-stack", fontId: "inter", casing: "none", baseWeight: 600, emphasisWeight: 800,
    trackingFrac: 0.0, lineHeightFrac: 1.28, entrance: "push", entranceMs: 280, staggerMs: 0,
    overshoot: 0.12, emphasisMotion: "scale-punch", hold: "active-word", exit: "push-out", exitMs: 320,
    accentColor: "#67E8F9", shadow: true, supportAlpha: 0.78, blockRotateDeg: 0 },
  { id: "opposing-stack", fontId: "montserrat", casing: "none", baseWeight: 600, emphasisWeight: 800,
    trackingFrac: 0.0, lineHeightFrac: 1.3, entrance: "slide-y", entranceMs: 360, staggerMs: 170,
    overshoot: 0.12, emphasisMotion: "hold", hold: "active-word", exit: "fade", exitMs: 300,
    accentColor: "#A5B4FC", shadow: true, supportAlpha: 0.78, blockRotateDeg: 0 },
  { id: "diagonal-stack", fontId: "bebas", casing: "upper", baseWeight: 400, emphasisWeight: 400,
    trackingFrac: 0.03, lineHeightFrac: 1.12, entrance: "slide-x", entranceMs: 300, staggerMs: 130,
    overshoot: 0.12, emphasisMotion: "hold", hold: "drift", exit: "fade", exitMs: 300,
    accentColor: "#FCD34D", shadow: true, supportAlpha: 0.78, blockRotateDeg: -3 },
  // ════════ FAMILY D — CONVERSATIONAL (readable flow) ════════
  { id: "kinetic-sentence", fontId: "inter", casing: "none", baseWeight: 600, emphasisWeight: 800,
    trackingFrac: 0.0, lineHeightFrac: 1.32, entrance: "fade-rise", entranceMs: 280, staggerMs: 120,
    overshoot: 0.12, emphasisMotion: "scale-punch", hold: "active-accent", exit: "fade", exitMs: 300,
    accentColor: "#4ADE80", shadow: true, supportAlpha: 0.78, blockRotateDeg: 0 },
  { id: "word-cascade", fontId: "montserrat", casing: "none", baseWeight: 600, emphasisWeight: 800,
    trackingFrac: 0.0, lineHeightFrac: 1.3, entrance: "burst", entranceMs: 240, staggerMs: 90,
    overshoot: 0.12, emphasisMotion: "scale-punch", hold: "active-word", exit: "fade", exitMs: 300,
    accentColor: "#FDE047", shadow: true, supportAlpha: 0.78, blockRotateDeg: 0 },
  { id: "mixed-weight", fontId: "inter", casing: "none", baseWeight: 400, emphasisWeight: 900,
    trackingFrac: 0.0, lineHeightFrac: 1.3, entrance: "fade-rise", entranceMs: 260, staggerMs: 70,
    overshoot: 0.12, emphasisMotion: "hold", hold: "active-word", exit: "fade", exitMs: 300,
    accentColor: "#FBBF24", shadow: true, supportAlpha: 0.78, blockRotateDeg: 0 },
  { id: "sliding-sentence", fontId: "segoe", casing: "none", baseWeight: 600, emphasisWeight: 800,
    trackingFrac: 0.0, lineHeightFrac: 1.32, entrance: "slide-x", entranceMs: 320, staggerMs: 140,
    overshoot: 0.12, emphasisMotion: "scale-punch", hold: "drift", exit: "fade", exitMs: 300,
    accentColor: "#FBBF24", shadow: true, supportAlpha: 0.78, blockRotateDeg: 0 },
  { id: "phrase-reveal", fontId: "roboto", casing: "none", baseWeight: 600, emphasisWeight: 800,
    trackingFrac: 0.0, lineHeightFrac: 1.3, entrance: "clip-wipe", entranceMs: 360, staggerMs: 150,
    overshoot: 0.12, emphasisMotion: "hold", hold: "active-accent", exit: "fade", exitMs: 300,
    accentColor: "#34D399", shadow: true, supportAlpha: 0.78, blockRotateDeg: 0 },
  // ════════ FAMILY E — HIGH INTENSITY (sparingly) ════════
  { id: "word-burst", fontId: "montserrat", casing: "upper", baseWeight: 800, emphasisWeight: 900,
    trackingFrac: 0.0, lineHeightFrac: 1.2, entrance: "burst", entranceMs: 200, staggerMs: 70,
    overshoot: 0.2, emphasisMotion: "shake", hold: "active-accent", exit: "fade", exitMs: 300,
    accentColor: "#F0ABFC", shadow: true, supportAlpha: 0.78, blockRotateDeg: 0 },
  { id: "collision", fontId: "arial-black", casing: "upper", baseWeight: 400, emphasisWeight: 900,
    trackingFrac: 0.0, lineHeightFrac: 1.16, entrance: "converge", entranceMs: 260, staggerMs: 80,
    overshoot: 0.16, emphasisMotion: "scale-punch", hold: "none", exit: "fade", exitMs: 300,
    accentColor: "#FACC15", shadow: true, supportAlpha: 0.78, blockRotateDeg: 0 },
  { id: "rapid-stack", fontId: "bebas", casing: "upper", baseWeight: 400, emphasisWeight: 400,
    trackingFrac: 0.02, lineHeightFrac: 1.1, entrance: "typewriter", entranceMs: 90, staggerMs: 60,
    overshoot: 0.12, emphasisMotion: "scale-punch", hold: "active-accent", exit: "scale-out", exitMs: 180,
    accentColor: "#22D3EE", shadow: true, supportAlpha: 0.78, blockRotateDeg: 0 },
  { id: "fullscreen-impact", fontId: "impact", casing: "upper", baseWeight: 400, emphasisWeight: 400,
    trackingFrac: 0.0, lineHeightFrac: 1.0, entrance: "flash", entranceMs: 110, staggerMs: 55,
    overshoot: 0.3, emphasisMotion: "shake", hold: "pulse", exit: "scale-out", exitMs: 220,
    accentColor: "#FACC15", shadow: true, supportAlpha: 0.78, blockRotateDeg: 0 },
];

const PRESET_BY_ID = new Map(KINETIC_PRESET_SPECS.map((p) => [p.id, p]));

/** Fallback: editorial-stack (mirrors getKineticPreset in presets.ts). */
function getKineticPresetSpec(id) {
  return PRESET_BY_ID.get(String(id)) || PRESET_BY_ID.get("editorial-stack");
}

// ── mirror of captionPresets.ts FONT_OPTIONS (id → ffmpegName) ──────────────
// v1.21: the five web families ship as BUNDLED TTFs (fontsdir is passed to
// the subtitles filter) — libass resolves the REAL names now; the old
// "Segoe UI/Impact/Georgia" stand-ins produced the wrong typographic
// identity (the reference designs are Bebas-condensed / Montserrat-geometric).
const FONT_ASS_NAMES = {
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

function resolveKineticFontName(fontId) {
  return FONT_ASS_NAMES[fontId] || FONT_ASS_NAMES.inter;
}

// ── mirror of motion.ts (math only — keep in sync) ──────────────────────────

const MOTION_ENERGY = { subtle: 0.6, balanced: 1.0, dynamic: 1.25, extreme: 1.6 };

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function easeOutBack(t, overshoot) {
  // overshoot in 0..0.35 → c1 param
  const c1 = 1.2 + overshoot * 2.2;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

/** Radial directions for burst/converge — deterministic per word index. */
function burstVector(idx) {
  const pattern = [
    { dx: -1, dy: -0.55 },
    { dx: 1, dy: -0.5 },
    { dx: -1, dy: 0.6 },
    { dx: 1, dy: 0.55 },
    { dx: -0.55, dy: -1 },
    { dx: 0.6, dy: 1 },
  ];
  return pattern[(idx | 0) % pattern.length];
}

/** Role-based motion budget (§28): primary strong, secondary moderate. */
function roleEnergyOf(role) {
  return role === "primary" ? 1 : role === "secondary" ? 0.6 : 0.35;
}

function clampNum(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// ── ASS helpers (copied from stack-text-ass.js / main.js) ───────────────────

function hexByte(n) {
  const c = Math.max(0, Math.min(255, Math.round(Number(n) || 0)));
  return c.toString(16).padStart(2, "0").toUpperCase();
}

/** mirror of main.js hexToAssColor — &HAA BB GG RR (alpha 1 = opaque). */
function hexToAssColor(hex, alpha) {
  const a = alpha == null ? 1 : alpha;
  const h = (hex || "#FFFFFF").replace(/^#/, "");
  const assAlpha = hexByte(Math.round((1 - a) * 255));
  return `&H${assAlpha}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

/** mirror of main.js hexToAssBgr — &HBBGGRR (inline \1c form). */
function hexToAssBgr(hex) {
  const h = (hex || "#FFFFFF").replace(/^#/, "");
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

/** Escape user text for ASS (backslash → ∕, braces stripped, \n → \N). */
function escapeAssText(s) {
  if (!s) return "";
  return String(s)
    .replace(/\\/g, "\u2216")
    .replace(/[{}]/g, "")
    .replace(/\n/g, "\\N");
}

/** H:MM:SS.CS (centiseconds, 2 digits — the 100→99 guard included). */
function assFmtTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const cs = Math.round((s - Math.floor(s)) * 100);
  const cc = cs === 100 ? 99 : cs;
  return `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(cc).padStart(2, "0")}`;
}

// ── the emitter ─────────────────────────────────────────────────────────────

/**
 * Emit ONE composition's Dialogues (per-word override tags). Internal —
 * called by emitKineticCompositions for every in-window + geometry-matched
 * composition. Returns { styleLine, events } or null when nothing emits.
 */
function emitKineticComposition(comp, geo, ctx) {
  const preset = ctx.preset;
  const planWords = Array.isArray(comp.words) ? comp.words : [];
  const phrases = Array.isArray(comp.phrases) ? comp.phrases : [];

  const relStart = Math.max(0, comp.startMs - ctx.winStart);
  const relEnd = Math.min(ctx.clampDur, comp.endMs - ctx.winStart);
  if (relEnd <= relStart) return null;

  // motion.ts mirrors: entrance window scaling (subtle stretches 1.2×) and
  // the motion-energy offset multiplier (ch/1080 inside ctx.energy).
  const entranceMs = Math.max(
    60,
    Math.round(preset.entranceMs * (ctx.motionLevel === "subtle" ? 1.2 : 1)),
  );
  const stagger = preset.staggerMs || 0;
  const exitMs = preset.exitMs || 0;
  // NOTE: preset.supportAlpha is deliberately NOT read — motion.ts hardcodes
  // the supporting-tier multiplier at 0.82 and the painter follows it (the
  // preset field is dead data); see settledAlpha below.
  const accent = ctx.settings.accentOverride || preset.accentColor;

  // ── per-word plan resolution (roles/timings come from the renderer plan;
  // the geometry word's wordIdx indexes the composition's flat word list) ──
  const wordInfo = (gw) => {
    const pw = planWords[gw.wordIdx | 0] || null;
    const phraseIdx = pw && typeof pw.phraseIndex === "number" ? pw.phraseIndex : 0;
    const phrase = phrases[phraseIdx] || null;
    return {
      pw,
      phrase,
      phraseIdx,
      role: (phrase && phrase.role) || (pw && pw.role) || "primary",
      emphasis: !!(pw && pw.emphasis),
      wordStartAbs: pw && typeof pw.startMs === "number" ? pw.startMs : comp.startMs,
    };
  };

  // Entrance window (mirror of motion.ts §22): stagger is PER PHRASE (the
  // semantic unit); typewriter additionally staggers by flat word index.
  const enterStartAbs = (gw, info) => {
    let delay = info.phraseIdx * stagger;
    if (preset.entrance === "typewriter") delay += (gw.wordIdx | 0) * stagger;
    return Math.max(comp.startMs, info.wordStartAbs - 60) + delay;
  };

  // v1.33.2 ENTRANCE/EXIT CROSSFIRE FIX (mirror of motion.ts): a word whose
  // entrance ran while the composition's exit fade was already live faded IN
  // and OUT simultaneously — late words peaked at ~30% opacity ("not
  // properly visible"). Fix: each word's entrance COMPRESSES to finish before
  // the nominal exit window, and the exit fade DEFERS past the last entrance
  // (shrinking to 0 when there is no room — full opacity beats a fade that
  // erases the word).
  const nominalExitStartAbs = comp.endMs - exitMs;
  const enterPlan = new Map(); // wordIdx -> { enterStartAbs, enterMs }
  let lastEnterEndAbs = -Infinity;
  for (const gw of geo.words) {
    const info = wordInfo(gw);
    const es = enterStartAbs(gw, info);
    const room = Math.max(80, nominalExitStartAbs - es - 40);
    const eff = Math.max(60, Math.min(entranceMs, Math.round(room)));
    enterPlan.set(gw.wordIdx | 0, { enterStartAbs: es, enterMs: eff });
    if (es + eff > lastEnterEndAbs) lastEnterEndAbs = es + eff;
  }
  const effExitStartAbs = Math.max(nominalExitStartAbs, lastEnterEndAbs + 60);
  // v1.33.2: the effective fade-out — only when the composition truly ENDS
  // inside this window (a window-clipped composition continues in the NEXT
  // chunk/segment; fading at every window tail would pulse at boundaries) —
  // and only the DEFERRED window (comp end − effective exit start), never
  // the raw preset exitMs; <40ms of fade is noise → no fade at all.
  const endsInWindow = comp.endMs <= ctx.winEnd;
  const rawFadeOutMs = endsInWindow
    ? Math.max(0, Math.min(exitMs, Math.round(comp.endMs - effExitStartAbs)))
    : 0;
  const fadeOutMs = rawFadeOutMs >= 40 ? rawFadeOutMs : 0;

  // Settled alpha (§27 supporting muted tier). motion.ts hardcodes the
  // supporting multiplier at 0.82 — preset.supportAlpha is a dead field in
  // the preview painter — mirror the painter's actual number (v1.27.2).
  // v1.33.2: emphasis words are EXEMPT — the accent-colored highlight must
  // stay fully legible even in a supporting-tier phrase (the dimmed accent
  // was the "colour highlight not showing properly" report).
  const settledAlpha = (info) => {
    const num = info.role === "supporting" && !info.emphasis ? 0.82 : 1;
    return { num, hex: "&H" + hexByte(Math.round((1 - num) * 255)) + "&" };
  };

  // Per-word static visual tags: \fs (the measured phrase font), \b (the
  // word's EFFECTIVE measured weight — inline emphasis bumps included),
  // \1c (accent for emphasis words), \frz (diagonal block rotation).
  const visualTags = (info, gw) => {
    const phraseWeight =
      info.phrase && typeof info.phrase.weight === "number"
        ? info.phrase.weight
        : preset.baseWeight;
    const effWeight = Number(gw.weight) > 0 ? Math.round(Number(gw.weight)) : phraseWeight;
    const colorBgr = info.emphasis ? hexToAssBgr(accent) : hexToAssBgr(ctx.textColor);
    let s = `\\fs${Math.round(Number(gw.fontPx) || 40)}\\b${effWeight >= 600 ? 1 : 0}\\1c${colorBgr}&`;
    if (preset.blockRotateDeg) s += `\\frz${preset.blockRotateDeg}`;
    return s;
  };

  // Emphasis event (§21): scale-punch/pulse at the word's spoken moment.
  // Skipped when the punch already passed before the window opened.
  const emphasisTags = (info, sRel) => {
    if (!info.emphasis) return "";
    if (preset.emphasisMotion !== "scale-punch" && preset.emphasisMotion !== "pulse") return "";
    if (info.wordStartAbs + 320 <= ctx.winStart) return "";
    const wsAbs = clampNum(info.wordStartAbs - ctx.winStart, 0, ctx.clampDur);
    const ws = Math.max(0, Math.round(wsAbs - sRel));
    return (
      `\\t(${ws},${ws + 200},\\fscx118\\fscy118)` +
      `\\t(${ws + 200},${ws + 320},\\fscx100\\fscy100)`
    );
  };

  // Push-out phrase dimming (motion.ts: phrases whose words have ALL been
  // spoken dim to 55% after their last word + 60ms; the upward drift needs
  // \pos animation → dim-only approximation).
  const phraseLastEndAbs = (phraseIdx) => {
    let last = -Infinity;
    for (const w of planWords) {
      if (w && w.phraseIndex === phraseIdx && typeof w.endMs === "number") {
        last = Math.max(last, w.endMs);
      }
    }
    return last;
  };
  const pushDimTags = (info, sRel) => {
    // motion.ts condition: push entrance OR push-out exit (either arms the
    // dim; the upward drift needs \pos animation → dim-only approximation).
    if (preset.entrance !== "push" && preset.exit !== "push-out") return "";
    const peAbs = phraseLastEndAbs(info.phraseIdx);
    if (!Number.isFinite(peAbs)) return "";
    const dimByte = hexByte(Math.round((1 - settledAlpha(info).num * 0.55) * 255));
    const pe = Math.max(0, Math.round(peAbs + 60 - ctx.winStart - sRel));
    return `\\t(${pe},${pe + 600},\\alpha&H${dimByte}&)`;
  };

  const dlg = (start, end, text) =>
    `Dialogue: 0,${assFmtTime(start / 1000)},${assFmtTime(end / 1000)},KineticC${ctx.styleIdx},,0,0,0,,${text}`;

  // motion.ts from-vector for the positional entrances (per-word \move).
  // x-motion: slide-x/burst/converge. y-motion (v1.27.2): fade-rise/slide-y/
  // push — the exact motion.ts e=0 offsets, rising/alternating/pushing into
  // place instead of the old alpha-only degradation.
  const moveFromVector = (gw, info, cx, cy) => {
    const idx = gw.wordIdx | 0;
    if (preset.entrance === "slide-x") {
      const align = info.phrase ? info.phrase.align : null;
      const dir = align === "right" ? 1 : align === "left" ? -1 : idx % 2 === 0 ? -1 : 1;
      return { x0: cx + Math.round(56 * ctx.energy * dir), y0: cy };
    }
    if (preset.entrance === "burst") {
      const v = burstVector(idx);
      const re = roleEnergyOf(info.role);
      return {
        x0: cx + Math.round(v.dx * 64 * ctx.energy * re),
        y0: cy + Math.round(v.dy * 46 * ctx.energy * re),
      };
    }
    if (preset.entrance === "converge") {
      // converge — words fly IN from outside toward their anchor.
      const v = burstVector(idx);
      return {
        x0: cx + Math.round(v.dx * 90 * ctx.energy),
        y0: cy + Math.round(v.dy * 60 * ctx.energy),
      };
    }
    if (preset.entrance === "fade-rise") {
      // motion.ts: offsetY = (1-e) * 36 * energy * roleEnergy (rises up).
      return {
        x0: cx,
        y0: cy + Math.round(36 * ctx.energy * roleEnergyOf(info.role)),
      };
    }
    if (preset.entrance === "slide-y") {
      // motion.ts: offsetY = (1-e) * 42 * energy * (idx even ? up : down).
      return {
        x0: cx,
        y0: cy + Math.round(42 * ctx.energy * (idx % 2 === 0 ? -1 : 1)),
      };
    }
    // push — motion.ts: offsetY = (1-e) * 30 * energy (phrase rises in).
    return { x0: cx, y0: cy + Math.round(30 * ctx.energy) };
  };

  const events = [];
  // v1.27.2: ANY positional entrance rides the per-word \move path (x-motion
  // slide-x/burst/converge; y-motion fade-rise/slide-y/push; typewriter's
  // reveal IS the Dialogue start). Scale/blur/clip entrances keep the
  // one-Dialogue-per-LINE inline form (their transforms are inline tags).
  const perWordMode =
    preset.entrance === "slide-x" ||
    preset.entrance === "burst" ||
    preset.entrance === "converge" ||
    preset.entrance === "typewriter" ||
    preset.entrance === "fade-rise" ||
    preset.entrance === "slide-y" ||
    preset.entrance === "push";

  if (perWordMode) {
    // ── PER-WORD MODE: ONE Dialogue PER WORD (\move carries the x-motion;
    // typewriter's reveal IS the Dialogue start time). Per-word Dialogues
    // at the same time overlay fine in libass. v1.33.2: each word's entrance
    // duration is the COMPRESSED plan (enterPlan) so late words finish
    // entering before the exit fade opens. ──
    for (const gw of geo.words) {
      const info = wordInfo(gw);
      const wt = escapeAssText(gw.text || "");
      if (!wt) continue;
      const cx = Math.round(gw.x + gw.w / 2);
      const cy = Math.round(gw.y + gw.h / 2);
      const dAbs = enterStartAbs(gw, info);
      const d = Math.max(0, Math.round(dAbs - ctx.winStart)); // Dialogue start
      if (d >= relEnd) continue;
      const plan = enterPlan.get(gw.wordIdx | 0) || { enterStartAbs: dAbs, enterMs: entranceMs };
      const effEnt = plan.enterMs;
      // Entrance already complete when the window opens → settled \pos
      // (mid-composition chunk continuity, no re-animation).
      const settled = dAbs + effEnt <= ctx.winStart;
      const instant = preset.entrance === "typewriter"; // step alpha (no ramp)

      let head = "{\\an5";
      if (settled || instant) {
        head += `\\pos(${cx},${cy})`;
      } else {
        const v0 = moveFromVector(gw, info, cx, cy);
        head += `\\move(${v0.x0},${v0.y0},${cx},${cy},0,${effEnt})`;
      }
      head += visualTags(info, gw);
      head += "\\alpha" + settledAlpha(info).hex;
      if (!settled && !instant) {
        // burst/converge from-scale (motion.ts 0.86/0.9 → 1).
        if (preset.entrance === "burst") {
          head += `\\fscx86\\fscy86\\t(0,${effEnt},\\fscx100\\fscy100)`;
        } else if (preset.entrance === "converge") {
          head += `\\fscx90\\fscy90\\t(0,${effEnt},\\fscx100\\fscy100)`;
        }
      }
      head += emphasisTags(info, d);
      head += pushDimTags(info, d);
      const fadeIn = settled || instant ? 0 : effEnt;
      if (fadeIn > 0 || fadeOutMs > 0) head += `\\fad(${fadeIn},${fadeOutMs})`;
      head += "}";
      events.push(dlg(d, relEnd, head + wt));
    }
  } else {
    // ── INLINE MODE: ONE Dialogue per LINE, \an5\pos(lineCenter) anchored,
    // every word in its own {...} block before the word. Words are in
    // reading order; a new line starts when the word's y differs from the
    // previous word's y (measured line-local y — one value per line). ──
    const lines = [];
    let cur = null;
    for (const gw of geo.words) {
      if (!cur || gw.y !== cur[0].y) {
        cur = [];
        lines.push(cur);
      }
      cur.push(gw);
    }

    for (const lineWords of lines) {
      const first = lineWords[0];
      const last = lineWords[lineWords.length - 1];
      // \an5 anchors the line's center → the measured line box center.
      const cx = Math.round((first.x + last.x + last.w) / 2);
      const cy = Math.round(first.y + first.h / 2);
      const firstInfo = wordInfo(first);
      const firstDAbs = enterStartAbs(first, firstInfo);
      const S = Math.max(0, Math.round(firstDAbs - ctx.winStart)); // Dialogue start
      if (S >= relEnd) continue;

      // Line lead block: \an5 + absolute center + exit fade (+ the
      // clip-wipe rect animation — animated \clip via \t with two rect
      // forms is the proven v1.17 mask-wipe recipe). v1.33.2: the wipe ride
      // the LINE-LEAD word's compressed entrance.
      let lead = `{\\an5\\pos(${cx},${cy})`;
      if (preset.entrance === "clip-wipe") {
        const x1 = Math.round(Math.min.apply(null, lineWords.map((w) => w.x)));
        const x2 = Math.round(Math.max.apply(null, lineWords.map((w) => w.x + w.w)));
        const y1 = Math.round(first.y);
        const y2 = Math.round(first.y + first.h);
        const d0 = Math.max(0, Math.round(firstDAbs - ctx.winStart - S)); // = 0
        const wipeEnt = (enterPlan.get(first.wordIdx | 0) || { enterMs: entranceMs }).enterMs;
        lead +=
          `\\clip(${x1},${y1},${x1},${y2})` +
          `\\t(${d0},${d0 + wipeEnt},\\clip(${x1},${y1},${x2},${y2}))`;
      }
      if (fadeOutMs > 0) lead += `\\fad(0,${fadeOutMs})`;
      lead += "}";

      const parts = [];
      for (const gw of lineWords) {
        const info = wordInfo(gw);
        const wt = escapeAssText(gw.text || "");
        if (!wt) continue;
        const dAbs = enterStartAbs(gw, info);
        const settled = settledAlpha(info);
        // \t times are ms RELATIVE TO THE DIALOGUE START (libass semantics).
        const d = Math.max(0, Math.round(dAbs - ctx.winStart - S));
        // v1.33.2: per-word COMPRESSED entrance (mirror of the per-word mode
        // + motion.ts) — late words pop fast instead of fading in under the
        // already-running exit fade.
        const effEnt = (enterPlan.get(gw.wordIdx | 0) || { enterMs: entranceMs }).enterMs;
        let block = "{" + visualTags(info, gw);
        let ts = "";
        if (dAbs + effEnt <= ctx.winStart) {
          // Entrance already complete when the window opens → settled.
          block += "\\alpha" + settled.hex;
        } else {
          switch (preset.entrance) {
            case "fade-rise":
            case "slide-y":
            case "push":
              // DEFENSIVE FALLBACK ONLY — these entrances ride PER-WORD mode
              // (real \move y-motion) and never reach the inline switch; if
              // the per-word routing is ever disabled again, alpha-only is
              // the documented inline degradation.
              block += "\\alpha&HFF&";
              ts += `\\t(${d},${d + effEnt},\\alpha${settled.hex})`;
              break;
            case "word-pop": {
              // 0.4→1 overshoot: alpha over the first 40% (motion.ts
              // alpha = min(1, et*2.5)), scale two-phase pop 115%→100%.
              block += "\\alpha&HFF&\\fscx40\\fscy40";
              const aDur = Math.max(1, Math.round(effEnt / 2.5));
              ts +=
                `\\t(${d},${d + aDur},\\alpha${settled.hex})` +
                `\\t(${d},${d + effEnt},\\fscx115\\fscy115)` +
                `\\t(${d + effEnt},${d + Math.round(effEnt * 1.3)},\\fscx100\\fscy100)`;
              break;
            }
            case "scale-slam": {
              // 2.4→1 slam in ≤120 ms (fast attack), alpha rides along.
              block += "\\alpha&HFF&\\fscx240\\fscy240";
              const dur = Math.min(120, effEnt);
              ts += `\\t(${d},${d + dur},\\fscx100\\fscy100\\alpha${settled.hex})`;
              break;
            }
            case "blur-focus": {
              // blur (1-e)*10*energy → 0, scale 1.12 → 1, alpha → settled.
              const fromByte = hexByte(Math.round((1 - settled.num * 0.5) * 255));
              const blurFrom = Math.max(1, Math.round(10 * ctx.energy));
              block += `\\blur${blurFrom}\\fscx112\\fscy112\\alpha&H${fromByte}&`;
              ts += `\\t(${d},${d + effEnt},\\blur0\\fscx100\\fscy100\\alpha${settled.hex})`;
              break;
            }
            case "flash": {
              // Near-instant alpha + scale punch (emphasis words 1.9×,
              // others 1.4× — motion.ts flash case).
              const fromPct = info.emphasis ? 190 : 140;
              block += `\\alpha&HFF&\\fscx${fromPct}\\fscy${fromPct}`;
              ts += `\\t(${d},${d + effEnt},\\fscx100\\fscy100\\alpha${settled.hex})`;
              break;
            }
            case "clip-wipe":
            default: {
              // The line-level \clip rect does the wipe; the word rides an
              // alpha ramp (motion.ts alpha = min(1, et*1.6)).
              block += "\\alpha&HFF&";
              const aDur = Math.max(1, Math.round(effEnt / 1.6));
              ts += `\\t(${d},${d + aDur},\\alpha${settled.hex})`;
              break;
            }
          }
        }
        ts += emphasisTags(info, S);
        ts += pushDimTags(info, S);
        parts.push(block + ts + "}" + wt);
      }
      if (parts.length === 0) continue;
      events.push(dlg(S, relEnd, lead + parts.join(" ")));
    }
  }

  if (events.length === 0) return null;

  // ── ONE ASS Style per composition (Alignment 5 middle-center; all real
  // positioning is absolute inline \pos/\move — margins are zero). v1.27.2
  // preview parity: the canvas painter draws shadow-ONLY — NO text stroke
  // and NO letter-spacing (it never reads trackingFrac, and the geometry was
  // measured without it) — so Outline=0/Spacing=0 or libass renders heavier,
  // wider words than the preview and re-flows lines away from the measured
  // geometry. Shadow ≈ the painter's rgba(0,0,0,0.55) soft glow → BackColour
  // at 0.55 alpha with the same 3px·hScale depth the native Rust renderer
  // bakes into its strips. ──
  const hScale = ctx.height / 1080;
  const fontPx = Math.round(Number(geo.fontPx) || 40);
  const fontName = String(ctx.resolveFont(ctx.settings.fontOverride || preset.fontId) || "Segoe UI");
  const bold = preset.emphasisWeight >= 600 ? -1 : 0;
  const outline = 0;
  const shadowVal = preset.shadow ? Math.max(1, Math.round(3 * hScale)) : 0;
  const spacing = 0;
  const primary = hexToAssColor(ctx.textColor);
  const outlineColour = hexToAssColor("#000000");
  // Canvas painter shadow: rgba(0,0,0,0.55) → BackColour at alpha 0.55.
  const backColour = hexToAssColor("#000000", 0.55);

  const styleLine =
    `Style: KineticC${ctx.styleIdx},${fontName},${fontPx},${primary},${primary},` +
    `${outlineColour},${backColour},${bold},0,0,0,100,100,${spacing},0,` +
    `1,${outline},${shadowVal},5,0,0,0,1`;

  if (process.env.FF_DEBUG_KINETIC === "1") {
    console.log(`[kinetic-ass] ${preset.id} @${comp.startMs}ms → ${events.length} Dialogue(s)`);
    for (const ev of events) console.log("  " + ev);
  }

  return { styleLine, events };
}

/**
 * Convert renderer-planned kinetic compositions + renderer-measured
 * geometry into ASS Style + Dialogue lines (per-word inline override tags).
 *
 * opts = {
 *   compositions,      // KineticCuePayload[] (renderer-planned; see types.ts)
 *   geometry,          // KineticGeoComposition[] (renderer-measured at the
 *                      //   export dims; matched by cueStartMs === startMs)
 *   settings,          // KineticCaptionSettings (cs.kinetic) — motion,
 *                      //   fontOverride, accentOverride
 *   textColor,         // primary text color hex (cs.textColor)
 *   width, height,     // export dims
 *   winStart, winEnd, clampDur, // the segment/chunk window (ms) — SAME
 *                      //   semantics as buildAssDocument's
 *   fontNameResolver,  // optional (fontId) => ASS Fontname override
 * }
 *
 * Returns { styleLines: string[], eventLines: string[], count: number }
 * (same shape as buildHeadlineEvents' return in main.js). Compositions
 * outside the window — or WITHOUT a geometry match — emit NOTHING (main.js
 * falls back to the legacy caption path for their cues).
 */
function emitKineticCompositions(opts) {
  const o = opts || {};
  const compositions = Array.isArray(o.compositions) ? o.compositions : [];
  const geometry = Array.isArray(o.geometry) ? o.geometry : [];
  const settings = o.settings || {};
  const textColor = o.textColor || "#FFFFFF";
  const height = Number(o.height) || 1080;
  const winStart = Number(o.winStart) || 0;
  const winEnd = o.winEnd != null ? o.winEnd : Infinity;
  const clampDur = o.clampDur != null ? o.clampDur : Infinity;
  const resolveFont =
    typeof o.fontNameResolver === "function" ? o.fontNameResolver : resolveKineticFontName;

  const motionLevel = settings.motion || "dynamic";
  const energy =
    (MOTION_ENERGY[motionLevel] != null ? MOTION_ENERGY[motionLevel] : 1) * (height / 1080);

  const styleLines = [];
  const eventLines = [];
  let count = 0;

  for (let ci = 0; ci < compositions.length; ci++) {
    const comp = compositions[ci];
    if (!comp || typeof comp.startMs !== "number" || typeof comp.endMs !== "number") continue;
    if (comp.endMs <= winStart || comp.startMs >= winEnd) continue;
    // Geometry match (renderer-measured at the export dims). Missing
    // geometry → this composition emits nothing; main falls back.
    const geo = geometry.find((g) => g && g.cueStartMs === comp.startMs);
    if (!geo || !Array.isArray(geo.words) || geo.words.length === 0) continue;

    const emitted = emitKineticComposition(comp, geo, {
      styleIdx: ci,
      preset: getKineticPresetSpec(comp.presetId),
      settings,
      textColor,
      height,
      winStart,
      winEnd,
      clampDur,
      energy,
      motionLevel,
      resolveFont,
    });
    if (emitted) {
      styleLines.push(emitted.styleLine);
      for (const ev of emitted.events) eventLines.push(ev);
      count += emitted.events.length;
    }
  }

  return { styleLines, eventLines, count };
}

module.exports = {
  // mirror data (mirror of src/lib/merger/kinetic/presets.ts + motion.ts +
  // captionPresets.ts FONT_OPTIONS — keep in sync)
  KINETIC_PRESET_SPECS,
  FONT_ASS_NAMES,
  MOTION_ENERGY,
  // mirror helpers
  getKineticPresetSpec,
  resolveKineticFontName,
  easeOutCubic,
  easeOutBack,
  burstVector,
  roleEnergyOf,
  // ASS helpers
  hexToAssColor,
  hexToAssBgr,
  escapeAssText,
  assFmtTime,
  // the emitter
  emitKineticCompositions,
};
