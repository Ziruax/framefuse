//! FrameFuse Rust engine — timeline schema (v1).
//!
//! This is the JSON contract between Electron's main process (which adapts
//! the existing `export-native` payload) and the Rust pipeline. Serde uses
//! camelCase so the JS side is a plain object dump. Every field is optional
//! or defaulted where possible: a malformed timeline must never panic, only
//! error.

use serde::Deserialize;
use serde_json::Value;

/// v0.4.2 LENIENT PARSE TABLE (the v1.33.9 "Timeline parse error: invalid
/// type: null, expected f64" fix). The JSON contract's numeric fields are
/// non-Option f64 on the Rust side, but the Electron router (or a
/// hand-crafted/legacy payload, or a NaN that `JSON.stringify` silently
/// serializes as `null`) can hand us a null. One null used to fail the WHOLE
/// `serde_json::from_str` — the export then fell into the slow FFmpeg-CLI
/// fallback with only a badge hint (the user's "image loop + 10-min audio"
/// report: parse error at column 1350 AND a hours-long CLI export). The
/// contract's own docs say "a malformed timeline must never panic, only
/// error" — this table makes the common corruption (null/NaN/string-number
/// on a numeric key) REPAIR itself into the documented default instead.
///
/// Keyed by the camelCase JSON name (context-agnostic: `startMs` means 0 in
/// every struct that carries it; `sanitized()` re-clamps everything after).
const NUMERIC_DEFAULTS: &[(&str, f64)] = &[
    // Timeline
    ("fps", 30.0),
    ("bitrateMbps", 0.0),
    ("totalMs", 0.0),
    ("fadeInMs", 0.0),
    ("fadeOutMs", 0.0),
    // Segment (+ cues/words/kinetic share startMs/endMs)
    ("startMs", 0.0),
    ("endMs", 0.0),
    ("durationMs", 0.0),
    ("trimInMs", 0.0),
    ("speed", 1.0),
    ("volume", 1.0),
    ("opacity", 1.0),
    ("transHeadMs", 0.0),
    ("transTailMs", 0.0),
    ("bookendStartMs", 0.0),
    ("bookendEndMs", 0.0),
    // KenBurns
    ("zoomMax", 1.06),
    // OverlayGeometry / TextOverlay / Watermark / kinetic words / motion
    ("x", 0.5),
    ("y", 0.5),
    ("w", 0.3),
    ("h", 0.0),
    // ChromaKey
    ("similarity", 0.31),
    ("smoothness", 0.08),
    // TextOverlay
    ("size", 72.0),
    ("fadeMs", 250.0),
    // CaptionsTimeline
    ("fontSizePx", 48.0),
    ("borderWidthPx", 0.0),
    ("bgAlpha", 1.0),
    ("bgPaddingPx", 12.0),
    ("shadowPx", 3.0),
    ("letterSpacingPx", 0.0),
    ("positionY", 50.0),
    ("maxWidthFrac", 0.84),
    // Kinetic spec / words
    ("entranceMs", 300.0),
    ("staggerMs", 110.0),
    ("overshoot", 0.0),
    ("exitMs", 300.0),
    ("supportAlpha", 0.78),
    ("fontPx", 40.0),
    // MotionKey
    ("tMs", 0.0),
];

/// Repair pass: walk a parsed timeline `Value`, replacing null / non-finite
/// / numeric-STRING values on the known numeric keys with their defaults.
/// Returns how many fields were repaired (diagnostics; 0 = clean input).
pub fn coerce_numeric_nulls(v: &mut Value) -> usize {
    let mut repaired = 0usize;
    coerce_walk(v, &mut repaired);
    repaired
}

fn coerce_walk(v: &mut Value, repaired: &mut usize) {
    match v {
        Value::Object(map) => {
            for (key, val) in map.iter_mut() {
                let needs_fix = val.is_null()
                    || match val.as_f64() {
                        Some(f) => !f.is_finite(),
                        None => false,
                    };
                if needs_fix {
                    if let Some((_, default)) = NUMERIC_DEFAULTS.iter().find(|(k, _)| k == key) {
                        *val = Value::from(*default);
                        *repaired += 1;
                        continue;
                    }
                }
                // numeric strings on numeric keys ("16" where f64 expected)
                if let Value::String(s) = &val {
                    let trimmed = s.trim();
                    if let Ok(num) = trimmed.parse::<f64>() {
                        if num.is_finite() && NUMERIC_DEFAULTS.iter().any(|(k, _)| k == key) {
                            *val = Value::from(num);
                            *repaired += 1;
                            continue;
                        }
                    }
                }
                coerce_walk(val, repaired);
            }
        }
        Value::Array(items) => {
            for item in items.iter_mut() {
                coerce_walk(item, repaired);
            }
        }
        _ => {}
    }
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Timeline {
    /// Contract version (currently 1).
    pub version: u32,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    /// Output audio sample rate (default 48000).
    pub sample_rate: u32,
    pub audio_channels: u32,
    /// Encoder preferences; 0 / None = let the engine pick.
    pub bitrate_mbps: f64,
    pub crf: Option<u32>,
    /// "social" | "balanced" | "cinema" — maps to encoder presets.
    pub quality: Option<String>,
    pub audio_kbps: u32,
    /// Background color (#rrggbb) behind all layers.
    pub background_color: String,
    /// Total timeline length in ms (computed by the caller; engine verifies).
    pub total_ms: f64,
    /// Master-bus fade-in (ms, 0 = off) — applied to the final mix.
    pub fade_in_ms: f64,
    /// Master-bus fade-out (ms, 0 = off) — applied to the final mix.
    pub fade_out_ms: f64,
    /// Font files by family key ("sans" | "serif" | "mono") — OS font paths
    /// passed from Electron (DIRECTIVE 6 rule 1: never bundle fonts in Rust).
    pub fonts: std::collections::HashMap<String, String>,
    pub segments: Vec<Segment>,
    /// Global background music track.
    pub music: Option<MusicTrack>,
    /// Headline text overlays.
    pub texts: Vec<TextOverlay>,
    /// Corner watermark image.
    pub watermark: Option<Watermark>,
    /// v2: extra placed audio sources (voiceover narration + dub segments
    /// + SFX placements) mixed into the output bus. Electron maps BOTH the
    /// v1.17 `voiceovers` and `sfx` payload lists onto these — they are
    /// absolute-timeline, never ducked, never looped.
    #[serde(default)]
    pub extra_audio: Vec<ExtraAudio>,
    /// v1.20 NATIVE CAPTIONS: burned-in subtitle cues with the full v4.1
    /// style vocabulary (word modes, karaoke highlight, per-word kinetic
    /// animations). Electron precomputes every concrete style number (the
    /// renderer resolved the CaptionPreset before the payload shipped), so
    /// this is a pure paint contract — no preset knowledge lives in Rust.
    /// Stack Text headlines still ride the CLI/libass compositor.
    #[serde(default)]
    pub captions: Option<CaptionsTimeline>,
    /// v0.3 AUDIO-EXTENDED / LOOP SCENARIOS: the engine renders the FULL
    /// payload totalMs — frames past the last visual segment composite over
    /// the background (the CLI's black-tail parity) and the audio bus mixes
    /// to the same length. Combined with `Segment.loop_src` (base-lane
    /// loop-to-fill) this covers the loop-video + long-voiceover timelines
    /// that previously rode the FFmpeg-CLI pipeline.
    #[serde(default)]
    pub normalize_audio: bool,
    /// v0.3: per-source loudness normalization target in LUFS (EBU R128
    /// K-weighted gated measurement in-process — the ffmpeg loudnorm
    /// parity without spawning a CLI child). Default −16 (social standard).
    #[serde(default)]
    pub audio_target_lufs: Option<f64>,
    /// v1.21 NATIVE KINETIC TYPOGRAPHY: the v1.18 kinetic-typography engine
    /// rendered natively (per-word choreography over renderer-measured
    /// geometry). The renderer measured every word rect with the SAME
    /// bundled TTFs, and Electron embedded each composition's preset
    /// motion/visual spec — Rust solves motion (a math-only port of
    /// kinetic/motion.ts) and blits fontdue strips. When this is present it
    /// REPLACES `captions` (the preview painter dispatches the same way).
    #[serde(default)]
    pub kinetic: Option<KineticTimeline>,
}

/// v1.21: the native kinetic typography timeline.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct KineticTimeline {
    /// Base (non-emphasis) text color, "#rrggbb" — customColor override or
    /// the canvas default white.
    pub base_color: String,
    /// Emphasis/accent color — accentOverride or the preset's accent.
    pub accent_color: String,
    /// "subtle" | "balanced" | "dynamic" | "extreme" (motion energy).
    pub motion_level: String,
    /// Compositions in time order.
    pub comps: Vec<KineticComp>,
}

/// One kinetic composition: measured word rects + the embedded preset spec.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct KineticComp {
    pub start_ms: f64,
    pub end_ms: f64,
    /// The preset motion/visual spec (embedded by Electron from its mirror
    /// of kinetic/presets.ts — Rust never looks presets up by id).
    pub preset: KineticPresetSpec,
    /// Per-comp accent color (accentOverride ?? the preset's accentColor).
    /// Empty → the timeline-level accent.
    pub accent_color: String,
    /// Renderer-measured word rects (absolute px at the output dims), each
    /// carrying its own timing + semantics + weight.
    pub words: Vec<KineticGeoWordR>,
    /// Per-phrase role/align (indexed by word.phrase_index).
    pub phrases: Vec<KineticPhraseSpec>,
}

/// Motion/visual spec subset of KineticPresetSpec (presets.ts) — exactly the
/// fields the motion solver + rasterizer read.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct KineticPresetSpec {
    pub entrance: String,
    pub entrance_ms: f64,
    pub stagger_ms: f64,
    pub overshoot: f64,
    /// "scale-punch" | "pulse" | "shake" | "hold".
    pub emphasis_motion: String,
    /// "none" | "drift" | "pulse" | "active-word" | "active-accent".
    pub hold: String,
    /// "fade" | "slide-down" | "scale-out" | "collapse" | "push-out".
    pub exit: String,
    pub exit_ms: f64,
    pub shadow: bool,
    /// Supporting-tier alpha multiplier (§27 muted tier).
    pub support_alpha: f64,
}

/// A renderer-measured kinetic word.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct KineticGeoWordR {
    pub text: String,
    pub start_ms: f64,
    pub end_ms: f64,
    /// Absolute rect (px at output dims; y = line top).
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub font_px: f64,
    /// Effective font weight — routes the rasterizer to the weight file.
    pub weight: u32,
    pub emphasis: bool,
    /// "primary" | "secondary" | "supporting".
    pub role: String,
    pub phrase_index: usize,
    /// Font key into timeline.fonts (Electron resolved family+weight → file).
    pub font_key: String,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct KineticPhraseSpec {
    pub role: String,
    /// "left" | "center" | "right" — drives slide-x direction.
    pub align: String,
}

/// v1.20: the native caption system's resolved style + cue list.
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CaptionsTimeline {
    /// Key into `timeline.fonts` (Electron resolves the preset fontId to an
    /// OS font file, preferring a bold face when fontWeight >= 600).
    pub font_key: String,
    /// Font size in px, ALREADY scaled to the output height.
    pub font_size_px: f64,
    /// "#rrggbb".
    pub text_color: String,
    /// Karaoke / active-word color ("#rrggbb"), when the preset defines one.
    pub highlight_color: Option<String>,
    /// "#rrggbb" stroke color (used when no background box).
    pub border_color: String,
    /// Stroke width in px at the output height.
    pub border_width_px: f64,
    /// Background box color ("#rrggbb") or None for no box.
    pub bg_color: Option<String>,
    /// 0..1 background opacity.
    pub bg_alpha: f64,
    /// Box padding in px at the output height.
    pub bg_padding_px: f64,
    /// Solid offset shadow on/off.
    pub shadow: bool,
    /// "#rrggbb".
    pub shadow_color: String,
    /// Shadow offset in px at the output height.
    pub shadow_px: f64,
    /// "none" | "uppercase" | "lowercase".
    pub text_transform: String,
    /// Extra tracking between glyphs in px at the output height.
    pub letter_spacing_px: f64,
    /// "left" | "center" | "right".
    pub alignment: String,
    /// "top" | "center" | "bottom".
    pub position: String,
    /// Inset from the position anchor, px at the output height (positive =
    /// inward).
    pub position_y: f64,
    /// Wrap width as a fraction of canvas width (e.g. 0.84).
    pub max_width_frac: f64,
    /// "off" | "word" | "word-only" | "stack" (the v4.1 word modes).
    pub word_mode: String,
    /// CaptionAnimation id ("none" | "pop-in" | "slam" | ... — the full
    /// 24-animation vocabulary, mirrored from assAnimTags timings).
    pub animation: String,
    pub cues: Vec<CaptionCue>,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CaptionCue {
    pub start_ms: f64,
    pub end_ms: f64,
    pub text: String,
    /// Per-word timestamps (absolute timeline ms). Empty = full-text mode.
    pub words: Vec<CaptionWord>,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CaptionWord {
    pub text: String,
    pub start_ms: f64,
    pub end_ms: f64,
}

/// v2: a placed audio source outside the segment/music lanes.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct ExtraAudio {
    /// Absolute source path (WAV or MP3 — decoded + resampled to the bus).
    pub path: String,
    /// Absolute timeline placement (ms).
    pub start_ms: f64,
    /// 0..2 gain (1 = unity).
    pub volume: f64,
    /// v0.3: loop the source across the remaining timeline (music-clip
    /// placements on this bus — the music channel's loopTrack parity).
    #[serde(default)]
    pub loop_src: bool,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Segment {
    pub id: String,
    /// "video" | "image"
    pub media_type: String,
    /// Absolute source path.
    pub path: String,
    /// Timeline window (ms). Base lane (track 0) is sequential; overlay
    /// lanes place by start/end.
    pub start_ms: f64,
    pub end_ms: f64,
    /// Timeline duration (ms) = (end - start) normally; kept explicit for
    /// speed-remapped segments.
    pub duration_ms: f64,
    /// Trim offset into the source (ms).
    pub trim_in_ms: f64,
    /// Full source duration in ms when known (video).
    pub source_duration_ms: Option<f64>,
    /// Playback speed 0.25..4 (base-lane video; 1 for everything else).
    pub speed: f64,
    /// 0 = base lane; >=1 overlay track (drawn in ascending order).
    pub track: u32,
    /// 0..2, 1 = unity.
    pub volume: f64,
    /// Source dimensions (px) when known — lets the compositor pre-fit.
    pub source_width: Option<u32>,
    pub source_height: Option<u32>,
    /// Source fps when known.
    pub source_fps: Option<f64>,
    /// Per-segment Ken Burns (base-lane images).
    pub ken_burns: Option<KenBurns>,
    /// Overlay lane geometry (normalized 0..1 relative to canvas).
    pub geometry: Option<OverlayGeometry>,
    /// Chroma key settings (overlay lane).
    pub chroma: Option<ChromaKey>,
    /// Overlay alpha 0..1.
    pub opacity: f64,
    /// Loop the overlay source across its window.
    pub overlay_loop: bool,
    /// v0.3: base-lane LOOP-TO-FILL — repeat the trimmed source span across
    /// the segment's whole timeline window (the CLI `-stream_loop` parity;
    /// the overlay lane's `overlay_loop` mirror for track 0). When set, the
    /// video decode position wraps modulo (sourceDuration − trimIn) and the
    /// segment's own audio loops across the timeline on the audio bus.
    #[serde(default)]
    pub loop_src: bool,
    /// v0.3: overlay MOTION PATH keyframes (piecewise-linear, hold-first /
    /// hold-last — the same curve the renderer interpolates and the CLI
    /// reproduces via overlay x/y time expressions). ≥2 keys override the
    /// static geometry center (x/y) across the window; the scale (w) stays
    /// from the geometry.
    #[serde(default)]
    pub motion: Vec<MotionKey>,
    /// Has an audio stream (video only).
    pub has_audio: bool,
    // ── v2 TRANSITION PLAN (baked by Electron — EXACT mirror of the CLI
    // pipeline's planBoundaryFades: style per boundary = overrides[seg.id]
    // ?? global; duration clamped to ≤45% of the segment; dissolve at a
    // boundary where EITHER side is video degrades to a hard cut). All
    // values are 0 when no transition applies. ──────────────────────────
    /// Fade/dissolve window at the START of this segment (ms).
    #[serde(default)]
    pub trans_head_ms: f64,
    /// "none" | "dissolve" | "dip-black" | "dip-white" (the styles the
    /// NATIVE engine implements; slide/wipe/circleopen never reach Rust).
    #[serde(default)]
    pub trans_head_style: String,
    /// Dip window at the END of this segment (ms, style of the NEXT
    /// boundary's dip).
    #[serde(default)]
    pub trans_tail_ms: f64,
    #[serde(default)]
    pub trans_tail_style: String,
    /// Whole-video fade-in from black at the FIRST segment (ms).
    #[serde(default)]
    pub bookend_start_ms: f64,
    /// Whole-video fade-out to black at the LAST segment (ms).
    #[serde(default)]
    pub bookend_end_ms: f64,
}

/// v0.3: one overlay motion-path keyframe (the v5.6 OverlayKeyframe —
/// normalized 0..1 canvas-center coordinates, time local to the overlay's
/// window).
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MotionKey {
    /// Time into the overlay clip's window, ms (≥ 0).
    pub t_ms: f64,
    /// Normalized 0..1 canvas center x.
    pub x: f64,
    /// Normalized 0..1 canvas center y.
    pub y: f64,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct KenBurns {
    pub enabled: bool,
    /// "in" | "out"
    pub direction: String,
    /// Peak zoom (e.g. 1.06 + intensity/100 * 0.18, computed Electron-side
    /// so preview and export agree).
    pub zoom_max: f64,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct OverlayGeometry {
    /// Normalized center coordinates / size (0..1), matching the app's
    /// overlay editor. The engine scales by output width/height.
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ChromaKey {
    /// "#rrggbb"
    pub color: String,
    /// 0..1 similarity threshold.
    pub similarity: f64,
    /// 0..1 edge softness.
    pub smoothness: f64,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct MusicTrack {
    pub path: String,
    pub volume: f64,
    pub start_ms: f64,
    pub loop_track: bool,
    /// v0.3: this track participates in loudness normalization (the CLI
    /// measures the LEGACY single-music input only — music-clip placements
    /// are user-volume SFX-style branches and stay untouched).
    #[serde(default)]
    pub normalize_src: bool,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TextOverlay {
    pub text: String,
    pub start_ms: f64,
    pub end_ms: f64,
    /// Font family key into timeline.fonts.
    pub font: String,
    /// Font size in px at 1080p reference height, scaled by output height.
    pub size: f64,
    /// "#rrggbb" or "#rrggbbaa".
    pub color: String,
    pub outline_color: String,
    /// Preset position: "top" | "center" | "bottom" | "upper" | "lower".
    pub position: String,
    /// Normalized anchor x (0.5 = centered) when position is custom.
    pub x: f64,
    /// Fade in/out duration (ms), symmetric.
    pub fade_ms: f64,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Watermark {
    pub path: String,
    /// Pixel coords on the output canvas.
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// 0.05..1
    pub opacity: f64,
}

impl Timeline {
    /// Sanitize to engine-safe values. Never fails — clamps.
    pub fn sanitized(mut self) -> Timeline {
        self.width = self.width.clamp(16, 7680);
        self.height = self.height.clamp(16, 4320);
        if !(self.fps.is_finite() && self.fps >= 1.0 && self.fps <= 120.0) {
            self.fps = 30.0;
        }
        if self.sample_rate == 0 {
            self.sample_rate = 48000;
        }
        self.audio_channels = if self.audio_channels == 1 { 1 } else { 2 };
        if self.total_ms <= 0.0 {
            // derive from segments
            let mut end = 0.0f64;
            for s in &self.segments {
                let e = if s.end_ms > s.start_ms {
                    s.end_ms
                } else {
                    s.start_ms + s.duration_ms
                };
                end = end.max(e);
            }
            self.total_ms = end;
        }
        for s in self.segments.iter_mut() {
            s.volume = s.volume.clamp(0.0, 2.0);
            s.speed = s.speed.clamp(0.25, 4.0);
            s.opacity = s.opacity.clamp(0.0, 1.0);
            if s.duration_ms <= 0.0 {
                s.duration_ms = (s.end_ms - s.start_ms).max(0.0);
            }
            if s.trim_in_ms < 0.0 {
                s.trim_in_ms = 0.0;
            }
        }
        self
    }

    /// Total output frame count.
    pub fn total_frames(&self) -> u64 {
        ((self.total_ms / 1000.0) * self.fps).ceil().max(0.0) as u64
    }
}


// v0.3.1 SENSIBLE DEFAULTS: serde's container-level `default` pulls every
// MISSING field from Default::default() — the DERIVED impl gave opacity
// 0.0 (invisible layers) and volume 0.0 (silent audio) for hand-crafted
// timelines that omit them (the Electron router always sends them, but the
// engine contract should not require that). One-alpha/unity-gain/live
// defaults match the renderer's semantics.
impl Default for Segment {
    fn default() -> Self {
        Segment {
            id: String::new(),
            media_type: "video".into(),
            path: String::new(),
            start_ms: 0.0,
            end_ms: 0.0,
            duration_ms: 0.0,
            trim_in_ms: 0.0,
            source_duration_ms: None,
            speed: 1.0,
            track: 0,
            volume: 1.0,
            source_width: None,
            source_height: None,
            source_fps: None,
            ken_burns: None,
            geometry: None,
            chroma: None,
            opacity: 1.0,
            overlay_loop: false,
            loop_src: false,
            motion: Vec::new(),
            has_audio: false,
            trans_head_ms: 0.0,
            trans_head_style: String::new(),
            trans_tail_ms: 0.0,
            trans_tail_style: String::new(),
            bookend_start_ms: 0.0,
            bookend_end_ms: 0.0,
        }
    }
}


// v0.3.1: unity-gain defaults (the derived 0.0 made an omitted volume
// silent — see the Segment note above).
impl Default for ExtraAudio {
    fn default() -> Self {
        ExtraAudio {
            path: String::new(),
            start_ms: 0.0,
            volume: 1.0,
            loop_src: false,
        }
    }
}

impl Default for MusicTrack {
    fn default() -> Self {
        MusicTrack {
            path: String::new(),
            volume: 1.0,
            start_ms: 0.0,
            loop_track: false,
            normalize_src: false,
        }
    }
}
