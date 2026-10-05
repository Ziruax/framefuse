//! Native caption rendering — v1.20.
//!
//! Burned-in subtitle cues with the full v4.1 style vocabulary: word modes
//! (karaoke highlight / word-only / stack), the 24 CaptionAnimations, bg
//! boxes, strokes and offset shadows — painted through fontdue + the
//! compositor's TextLayer path so captions no longer force the CLI/libass
//! fallback (the router's `captions` gate is gone for everything except the
//! kinetic-typography engine, which still rides libass per-word override
//! tags).
//!
//! Contract (electron/rust-engine-router.js builds it; every number is
//! pre-scaled to the OUTPUT canvas): `timeline.captions` = resolved style +
//! cue list. Layout math mirrors drawCaption in src/lib/merger/native.ts
//! (the preview ground truth): 1.25 line height, balanced triangle wrap,
//! position anchor + positionY inset, 4% safe margins, bg box padded around
//! the widest line. Animation math mirrors computeWordTransform in
//! captionAnimations.ts (the canvas/ASS shared engine).
//!
//! Bitmaps are rasterized ONCE per unique (word, color-variant) pair and
//! cached — speech vocabulary repeats heavily, so a 3000-word export stays
//! in the tens of MB, and per-frame work is pure blit math (dest rect +
//! alpha), identical to the headline-text path.
//!
//! Documented deviations from the canvas (all in the same class the ASS
//! emitter already makes): rotation (swing/spin-in) → dropped (rect blits
//! cannot rotate; offsets/scale kept), clipLeft (typewriter/reveal) →
//! alpha-ramp approximation, letterSpacing animation (tracking-in) →
//! dropped, glitch RGB-split → x-jump + flicker only, rounded bg corners →
//! square (libass drops radius too), blur (there is none in this family).

use crate::compositor::{Bitmap, TextLayer, parse_hex_color};
use crate::timeline::{CaptionWord, CaptionsTimeline, Timeline};
use std::collections::HashMap;

// ── animation constants (captionAnimations.ts) ─────────────────────────────
const POP_IN_MS: f64 = 220.0;
const SLIDE_UP_MS: f64 = 280.0;
const BOUNCE_IN_MS: f64 = 380.0;
const REVEAL_MS: f64 = 320.0;
const SHAKE_MS: f64 = 280.0;
const TYPEWRITER_MS_PER_CHAR: f64 = 45.0;
const SLAM_MS: f64 = 180.0;
const GLITCH_MS: f64 = 220.0;
const SPIN_IN_MS: f64 = 300.0;
const FLIP_IN_MS: f64 = 260.0;
const ELASTIC_MS: f64 = 450.0;
const ZOOM_WORDS_MS: f64 = 160.0;
const SQUASH_MS: f64 = 340.0;
const TRACKING_IN_MS: f64 = 300.0;
const BLUR_IN_MS: f64 = 260.0;
const HEARTBEAT_MS: f64 = 640.0;

/// Viral color-cycle palette (captionAnimations.ts COLOR_CYCLE_PALETTE).
const COLOR_CYCLE_PALETTE: [&str; 4] = ["#FDE047", "#22D3EE", "#F472B6", "#A3E635"];

#[inline]
fn clamp01(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}
#[inline]
fn ease_out_cubic(t: f64) -> f64 {
    1.0 - (1.0 - t).powi(3)
}
#[inline]
fn ease_out_quart(t: f64) -> f64 {
    1.0 - (1.0 - t).powi(4)
}
#[inline]
fn ease_out_back(t: f64) -> f64 {
    let c1 = 1.70158;
    let c3 = c1 + 1.0;
    1.0 + c3 * (t - 1.0).powi(3) + c1 * (t - 1.0).powi(2)
}
#[inline]
fn ease_out_elastic(t: f64) -> f64 {
    let c4 = (std::f64::consts::TAU) / 3.0;
    if t <= 0.0 {
        return 0.0;
    }
    if t >= 1.0 {
        return 1.0;
    }
    (2.0f64).powf(-10.0 * t) * ((t * 10.0 - 0.75) * c4).sin() + 1.0
}

/// Deterministic per-word jitter (mirrors seededRand — hash loop).
fn seeded_rand(seed: i64) -> f64 {
    let mut h: u32 = 2166136261;
    for i in 0..seed.max(0) {
        h = (h ^ (i as u32)).wrapping_mul(16777619);
    }
    (h % 10000) as f64 / 10000.0
}

/// One word's visual state at a point in time (the Rust-expressible subset
/// of WordTransform).
#[derive(Clone, Copy, Debug)]
pub struct WordAnim {
    pub alpha: f64,
    pub scale: f64,
    pub scale_x: f64,
    pub scale_y: f64,
    pub off_x: f64,
    pub off_y: f64,
    /// 0 = normal, 1 = highlight, 2..5 = color-cycle palette idx-2.
    pub color_idx: u8,
    /// Draw the spotlight box behind this word (active word only).
    pub spotlight: bool,
}

impl Default for WordAnim {
    fn default() -> Self {
        WordAnim {
            alpha: 1.0,
            scale: 1.0,
            scale_x: 1.0,
            scale_y: 1.0,
            off_x: 0.0,
            off_y: 0.0,
            color_idx: 0,
            spotlight: false,
        }
    }
}

/// computeWordTransform port (captionAnimations.ts). `ch` = output height
/// (offsets are 1080p-referenced and rescaled).
fn compute_word_transform(anim: &str, word_start_ms: f64, word_end_ms: f64, now_ms: f64, word_index: usize, ch: f64, color_cycle: bool) -> WordAnim {
    if anim == "none" || anim.is_empty() {
        return WordAnim::default();
    }
    let mut t = WordAnim::default();
    let active = now_ms >= word_start_ms && now_ms < word_end_ms;
    let since_start = now_ms - word_start_ms;
    let dur = (word_end_ms - word_start_ms).max(1.0);
    let ch_scale = ch / 1080.0;

    match anim {
        "pop-in" => {
            let p = clamp01(since_start / POP_IN_MS);
            let eased = ease_out_back(p);
            let scale = 0.4 + eased * 0.6;
            t.scale = if p >= 1.0 { 1.0 } else { scale.max(0.01) };
            t.alpha = clamp01(since_start / (POP_IN_MS * 0.4));
        }
        "slide-up" => {
            let p = clamp01(since_start / SLIDE_UP_MS);
            let e = ease_out_cubic(p);
            t.off_y = (1.0 - e) * 30.0 * ch_scale;
            t.alpha = e;
        }
        "bounce-in" => {
            let p = clamp01(since_start / BOUNCE_IN_MS);
            let e = ease_out_elastic(p);
            t.off_y = -(1.0 - e) * 25.0 * ch_scale;
            t.alpha = clamp01(p * 2.0);
        }
        "scale-pulse" => {
            if active {
                let phase = (now_ms - word_start_ms) / dur;
                let pulse = (phase * std::f64::consts::PI * 4.0).sin();
                t.scale = 1.0 + pulse * 0.09;
            }
        }
        "fade-through" => {
            let in_t = clamp01(since_start / 150.0);
            let out_t = clamp01((word_end_ms - now_ms) / 150.0);
            t.alpha = in_t.min(out_t);
        }
        "typewriter" => {
            // Canvas clips from the left per character; rect blits can't
            // clip — alpha-ramp approximation (the ASS karaoke variant does
            // the same).
            let revealed = (since_start / TYPEWRITER_MS_PER_CHAR).floor().max(0.0);
            let frac = clamp01(revealed / 6.0);
            t.alpha = frac;
        }
        "reveal" => {
            let p = clamp01(since_start / REVEAL_MS);
            let e = ease_out_cubic(p);
            t.off_x = (1.0 - e) * 15.0 * ch_scale;
            t.alpha = 0.4 + 0.6 * e;
        }
        "wave" => {
            if active {
                let phase = (now_ms - word_start_ms) / dur;
                t.off_y = (phase * std::f64::consts::PI * 4.0).sin() * 6.0 * ch_scale;
            }
        }
        "jitter" => {
            if active {
                let bucket = (since_start / 80.0).floor() as i64;
                let seed = word_index as i64 * 1000 + bucket;
                t.off_x = (seeded_rand(seed) - 0.5) * 4.0 * ch_scale;
                t.off_y = (seeded_rand(seed + 1) - 0.5) * 4.0 * ch_scale;
            }
        }
        "shake" => {
            let p = clamp01(since_start / SHAKE_MS);
            if p < 1.0 {
                let decay = 1.0 - p;
                let seed = word_index as i64 * 100 + (since_start / 40.0).floor() as i64;
                t.off_x = (seeded_rand(seed) - 0.5) * 12.0 * ch_scale * decay;
                t.alpha = clamp01(p * 3.0);
            }
        }
        "drift" => {
            if active {
                let phase = clamp01(since_start / dur);
                t.off_y = -phase * 8.0 * ch_scale;
            }
        }
        "slam" => {
            let p = clamp01(since_start / SLAM_MS);
            let e = ease_out_quart(p);
            let scale = 2.4 - 1.4 * e;
            if p >= 1.0 && since_start < SLAM_MS + 120.0 {
                let seed = word_index as i64 * 77 + (since_start / 40.0).floor() as i64;
                t.off_x = (seeded_rand(seed) - 0.5) * 5.0 * ch_scale;
            }
            t.scale = if p >= 1.0 { 1.0 } else { scale.max(0.01) };
            t.alpha = clamp01(p * 2.5);
        }
        "glitch" => {
            // RGB-split dropped; x-jumps + flicker kept.
            let mut in_window = since_start < GLITCH_MS;
            let mut rel = since_start;
            if !in_window && active {
                let cycle = (since_start - GLITCH_MS) % 500.0;
                if cycle < 90.0 {
                    in_window = true;
                    rel = cycle;
                }
            }
            if in_window {
                let bucket = (rel / 60.0).floor() as i64;
                let seed = word_index as i64 * 977 + bucket;
                t.off_x = (seeded_rand(seed) - 0.5) * 14.0 * ch_scale;
                let flick = 0.6 + 0.4 * seeded_rand(seed + 3).round();
                t.alpha = flick;
            }
        }
        "spin-in" => {
            // Rotation dropped → scale + alpha only.
            let p = clamp01(since_start / SPIN_IN_MS);
            let e = ease_out_back(p);
            let scale = 0.6 + 0.4 * e;
            t.scale = if p >= 1.0 { 1.0 } else { scale.max(0.01) };
            t.alpha = clamp01(p * 1.6);
        }
        "flip-in" => {
            let p = clamp01(since_start / FLIP_IN_MS);
            let e = ease_out_cubic(p);
            t.scale_y = e.max(0.02);
            t.alpha = clamp01(p * 1.8);
        }
        "elastic" => {
            let p = clamp01(since_start / ELASTIC_MS);
            let e = ease_out_elastic(p);
            let scale = 0.3 + 0.7 * e;
            t.scale = if p >= 1.0 { 1.0 } else { scale.max(0.01) };
            t.alpha = clamp01(p * 2.0);
        }
        "color-cycle" => {
            let p = clamp01(since_start / 160.0);
            let e = ease_out_cubic(p);
            t.color_idx = if color_cycle { 2 + (word_index % 4) as u8 } else { 0 };
            t.scale = 0.85 + 0.15 * e;
            t.alpha = clamp01(p * 2.0);
        }
        "spotlight" => {
            let p = clamp01(since_start / 200.0);
            let e = ease_out_back(p);
            let scale = 0.7 + 0.3 * e;
            t.scale = if p >= 1.0 { 1.0 } else { scale.max(0.01) };
            t.alpha = clamp01(p * 2.0);
            t.spotlight = active;
        }
        "swing" => {
            // Pendulum rotation → horizontal sway approximation.
            if active {
                let phase = (now_ms - word_start_ms) / dur;
                t.off_x = (phase * std::f64::consts::PI * 4.0).sin() * 4.0 * ch_scale;
            }
        }
        "squash" => {
            let p = clamp01(since_start / SQUASH_MS);
            if p < 1.0 {
                if p < 0.6 {
                    let k = p / 0.6;
                    t.scale_y = (1.0 - 0.6 * k).max(0.05);
                    t.scale_x = 1.0 + 0.35 * k;
                    t.off_y = 0.3 * k * 12.0 * ch_scale;
                    t.alpha = clamp01(p * 3.0);
                } else {
                    let k = (p - 0.6) / 0.4;
                    let e = ease_out_back(k);
                    t.scale_y = (0.4 + 0.6 * e).max(0.05);
                    t.scale_x = 1.35 - 0.35 * e;
                }
            }
        }
        "zoom-words" => {
            let p = clamp01(since_start / ZOOM_WORDS_MS);
            let e = ease_out_quart(p);
            let scale = 1.6 - 0.6 * e;
            t.scale = if p >= 1.0 { 1.0 } else { scale.max(0.01) };
            t.alpha = clamp01(p * 2.2);
        }
        "tracking-in" => {
            // Letter-spacing animation dropped → scale + fade kept.
            let p = clamp01(since_start / TRACKING_IN_MS);
            let e = ease_out_cubic(p);
            t.scale = 0.96 + 0.04 * e;
            t.alpha = clamp01(p * 2.0);
        }
        "blur-in" => {
            let p = clamp01(since_start / BLUR_IN_MS);
            let e = ease_out_cubic(p);
            let scale = 1.18 - 0.18 * e;
            t.scale = if p >= 1.0 { 1.0 } else { scale.max(0.01) };
            t.alpha = clamp01(p * 1.8);
        }
        "heartbeat" => {
            let p = clamp01(since_start / HEARTBEAT_MS);
            let mut scale = 1.0;
            if p < 0.28 {
                let k = p / 0.28;
                scale = 1.0 + (k * std::f64::consts::PI).sin() * 0.14;
            } else if (0.5..0.78).contains(&p) {
                let k = (p - 0.5) / 0.28;
                scale = 1.0 + (k * std::f64::consts::PI).sin() * 0.08;
            }
            t.scale = scale;
        }
        _ => {}
    }
    t
}

// ── prepared structures ────────────────────────────────────────────────────

struct PreparedWord {
    text: String,
    start_ms: f64,
    end_ms: f64,
    /// Glyph-rect top-left (canvas px) in off/word modes (line layout) and
    /// in stack mode (own line); word-only recomputes per frame.
    x: f64,
    y: f64,
    /// Glyph advance width.
    w: f64,
    line_h: f64,
    strip_w: u32,
    strip_h: u32,
}

struct PreparedCue {
    start_ms: f64,
    end_ms: f64,
    words: Vec<PreparedWord>,
    /// Number of layout lines (off/word modes).
    line_count: usize,
    /// Widest line width (canvas px).
    max_line_w: f64,
    /// Block top (canvas px) for off/word layout.
    block_top: f64,
    /// Block width for centering/box.
    block_w: f64,
    /// Anchor for whole-cue animation scaling (block center).
    block_cx: f64,
    block_cy: f64,
    /// has word-level timing?
    has_words: bool,
}

/// The prepared caption system: rasterized word-bitmap cache + per-cue
/// layout. Cheap to Arc across the frame producer.
pub struct PreparedCaptions {
    cues: Vec<PreparedCue>,
    style: CaptionsTimeline,
    /// word text → per-color-variant bitmaps (index 0 = normal,
    /// 1 = highlight, 2..5 = color-cycle palette). v2.1: keyed by String
    /// ONLY so `layers_at` can look a word up by `&str` with ZERO
    /// allocation (the v2.0 `(String, u8)` tuple key forced a fresh String
    /// per word per frame just to probe the map).
    bitmaps: HashMap<String, [Option<Bitmap>; COLOR_SLOTS]>,
    /// Solid 1×1 fills by hex (bg box + spotlight) — created ONCE so the
    /// GPU texture cache sees stable ids (per-frame fresh ids would churn
    /// the LRU and realloc textures every frame).
    fills: HashMap<String, Bitmap>,
    line_h: f64,
}

/// Color variants rasterized per word: 0 normal, 1 highlight, 2..5 palette.
const COLOR_SLOTS: usize = 6;

/// Load the caption font from the timeline's font table (falls back to
/// "sans", mirroring text.rs).
fn load_font(timeline: &Timeline, key: &str) -> Result<fontdue::Font, String> {
    let k = if timeline.fonts.contains_key(key) {
        key.to_string()
    } else if timeline.fonts.contains_key("sans") {
        "sans".to_string()
    } else {
        return Err("caption font missing (timeline.fonts empty)".into());
    };
    let path = timeline
        .fonts
        .get(&k)
        .cloned()
        .ok_or_else(|| format!("font path missing for {}", k))?;
    let bytes = std::fs::read(&path)
        .map_err(|e| format!("cannot read caption font `{}` ({}): {}", k, path, e))?;
    fontdue::Font::from_bytes(
        bytes,
        fontdue::FontSettings { collection_index: 0, scale: 40.0, load_substitutions: true },
    )
    .map_err(|e| format!("cannot parse caption font `{}`: {}", path, e))
}

fn transform_text(text: &str, mode: &str) -> String {
    match mode {
        "uppercase" => text.to_uppercase(),
        "lowercase" => text.to_lowercase(),
        _ => text.to_string(),
    }
}

/// Measure a single-line string (advance + letterSpacing between chars).
fn measure_str(font: &fontdue::Font, s: &str, size: f32, spacing: f32) -> f32 {
    let mut w = 0.0f32;
    let mut first = true;
    for ch in s.chars() {
        let m = font.metrics(ch, size);
        w += m.advance_width;
        if !first {
            w += spacing;
        }
        first = false;
    }
    w
}

/// Greedy wrap (wrapText in native.ts).
fn wrap_greedy(font: &fontdue::Font, words: &[&str], max_w: f32, size: f32, spacing: f32) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut line = String::new();
    for w in words {
        let candidate = if line.is_empty() {
            (*w).to_string()
        } else {
            format!("{} {}", line, w)
        };
        let width = measure_str(font, &candidate, size, spacing);
        if width > max_w && !line.is_empty() {
            out.push(line.clone());
            line = (*w).to_string();
        } else {
            line = candidate;
        }
    }
    if !line.is_empty() {
        out.push(line);
    }
    out
}

/// Balanced triangle wrap (balancedWrapText in native.ts): try 2- and
/// 3-line splits, prefer decreasing widths, fall back to greedy.
fn wrap_balanced(font: &fontdue::Font, text: &str, max_w: f32, size: f32, spacing: f32) -> Vec<String> {
    let mut result: Vec<String> = Vec::new();
    for para in text.split('\n') {
        if para.is_empty() {
            result.push(String::new());
            continue;
        }
        let words: Vec<&str> = para.split_whitespace().collect();
        if words.len() <= 1 {
            result.push(para.to_string());
            continue;
        }
        if measure_str(font, para, size, spacing) <= max_w {
            result.push(para.to_string());
            continue;
        }
        if words.iter().all(|w| measure_str(font, w, size, spacing) > max_w) {
            result.push(para.to_string());
            continue;
        }

        let mut best_split: Vec<String> = vec![para.to_string()];
        let mut best_score = f64::INFINITY;

        // 2-line splits.
        for i in 1..words.len() {
            let line1 = words[..i].join(" ");
            let line2 = words[i..].join(" ");
            let w1 = measure_str(font, &line1, size, spacing);
            let w2 = measure_str(font, &line2, size, spacing);
            if w1 > max_w || w2 > max_w {
                continue;
            }
            let triangle_bonus = if w1 > w2 { 0.0 } else { 50.0 };
            let score = (w1 - w2).abs() as f64 + triangle_bonus;
            if score < best_score {
                best_score = score;
                best_split = vec![line1, line2];
            }
        }

        // 3-line splits (5+ words).
        if words.len() >= 5 {
            for i in 1..words.len() - 1 {
                for j in i + 1..words.len() {
                    let line1 = words[..i].join(" ");
                    let line2 = words[i..j].join(" ");
                    let line3 = words[j..].join(" ");
                    let w1 = measure_str(font, &line1, size, spacing);
                    let w2 = measure_str(font, &line2, size, spacing);
                    let w3 = measure_str(font, &line3, size, spacing);
                    if w1 > max_w || w2 > max_w || w3 > max_w {
                        continue;
                    }
                    let triangle_bonus = if w1 > w2 && w2 > w3 { 0.0 } else { 100.0 };
                    let score = ((w1 - w2).abs() + (w2 - w3).abs()) as f64 + triangle_bonus;
                    if score < best_score {
                        best_score = score;
                        best_split = vec![line1, line2, line3];
                    }
                }
            }
        }

        if best_split.len() > 1 {
            result.extend(best_split);
        } else {
            result.extend(wrap_greedy(font, &words, max_w, size, spacing));
        }
    }
    result
}

impl PreparedCaptions {
    /// Rasterize one word into an RGBA strip (outline + baked offset
    /// shadow + fill in `color`).
    ///
    /// Strip height is IDENTICAL for every word (line height + padding) so
    /// baselines align when blitted at the same y.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn rasterize_word(
        font: &fontdue::Font,
        text: &str,
        color: [u8; 4],
        outline: [u8; 4],
        outline_w: i32,
        shadow_col: [u8; 4],
        shadow_px: i32,
        size: f32,
        spacing: f32,
        line_h: f32,
    ) -> (Bitmap, u32, u32) {
        let pad = outline_w.max(shadow_px).max(2) + 2;
        let word_w = measure_str(font, text, size, spacing).ceil().max(1.0) as i32;
        let strip_w = (word_w + pad * 2 + 4).max(1) as u32;
        let strip_h = (line_h.ceil() as i32 + pad * 2 + 4).max(1) as u32;
        let mut rgba = vec![0u8; strip_w as usize * strip_h as usize * 4];

        let baseline = pad + line_h.ceil() as i32;
        // (dx, dy, color, use_alpha) — shadow offset pass, outline pass
        // (8-direction), fill pass.
        let passes: [(i32, i32, [u8; 4], bool); 3] = [
            (0, shadow_px, shadow_col, true), // shadow offset
            (0, 0, outline, false),           // outline (8-dir)
            (0, 0, color, true),              // fill
        ];
        let chars: Vec<char> = text.chars().collect();
        let mut advances: Vec<f32> = Vec::with_capacity(chars.len());
        for &ch in &chars {
            let m = font.metrics(ch, size);
            advances.push(m.advance_width);
        }
        let outline_offsets: [(i32, i32); 8] = [
            (-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, -1), (-1, 1), (1, 1),
        ];
        for (pass_idx, &(ox, oy, col, use_alpha)) in passes.iter().enumerate() {
            let o_scale = if pass_idx == 1 { outline_w } else { 0 };
            let dirs: &[(i32, i32)] = if pass_idx == 1 {
                &outline_offsets
            } else {
                &[(0, 0)]
            };
            let mut x = pad;
            for (i, &ch) in chars.iter().enumerate() {
                let (m, cov) = font.rasterize(ch, size);
                for &(dox, doy) in dirs {
                    let gx = x + m.xmin + ox + dox * o_scale;
                    let gy = baseline - m.ymin - m.height as i32 + oy + doy * o_scale;
                    for py in 0..m.height as i32 {
                        for px in 0..m.width as i32 {
                            let c = cov[(py as usize) * m.width + px as usize];
                            if c == 0 {
                                continue;
                            }
                            let dx = gx + px;
                            let dy = gy + py;
                            if dx < 0 || dy < 0 || dx >= strip_w as i32 || dy >= strip_h as i32 {
                                continue;
                            }
                            let d = (dy as usize * strip_w as usize + dx as usize) * 4;
                            let a = if use_alpha {
                                ((c as u16 * col[3] as u16) / 255) as u8
                            } else {
                                c
                            };
                            // Max-blend composites the UNDER-layers (shadow,
                            // 8-direction outline). The FILL pass is the
                            // topmost layer and must own its pixels
                            // unconditionally — an alpha-equality max-blend
                            // would let the outline's identical coverage
                            // suppress the fill and the glyphs would render
                            // in the OUTLINE color (the shadow/outline-only
                            // render bug).
                            if pass_idx == 2 || a > rgba[d + 3] {
                                rgba[d] = col[0];
                                rgba[d + 1] = col[1];
                                rgba[d + 2] = col[2];
                                rgba[d + 3] = a;
                            }
                        }
                    }
                }
                x += advances[i] as i32;
                if i + 1 < chars.len() {
                    x += spacing as i32;
                }
            }
        }
        (Bitmap::new(rgba, strip_w, strip_h), strip_w, strip_h)
    }

    fn fill_bitmap(hex: &str) -> Bitmap {
        let c = parse_hex_color(hex);
        Bitmap::new(vec![c[0], c[1], c[2], 255], 1, 1)
    }

    fn word_bitmap(&self, text: &str, idx: u8) -> Option<&Bitmap> {
        self.bitmaps
            .get(text)
            .and_then(|v| v.get(idx as usize))
            .and_then(Option::as_ref)
    }

    fn fill(&self, hex: &str) -> Bitmap {
        self.fills
            .get(hex)
            .cloned()
            .unwrap_or_else(|| Self::fill_bitmap(hex))
    }
}

/// Prepare the caption system: load the font, lay out every cue, rasterize
/// every needed word/color bitmap ONCE. Returns None when there are no cues
/// (painting is a no-op).
pub fn prepare(timeline: &Timeline, cw: u32, ch: u32) -> Result<Option<PreparedCaptions>, String> {
    let style = match &timeline.captions {
        Some(c) if !c.cues.is_empty() => c.clone(),
        _ => return Ok(None),
    };
    let font = load_font(timeline, &style.font_key)?;

    let ch_f = ch as f64;
    let cw_f = cw as f64;
    let font_px = (style.font_size_px.max(6.0) as f32).min(ch_f as f32 * 0.25);
    let line_h = (font_px * 1.25).round();
    let spacing = style.letter_spacing_px.max(0.0) as f32;
    let space_w = font.metrics(' ', font_px).advance_width;
    let max_w = (style.max_width_frac.clamp(0.1, 1.0) * cw_f).max(40.0) as f32;

    let text_col = parse_hex_color(&style.text_color);
    let highlight_col = style.highlight_color.as_deref().map(parse_hex_color);
    let palette_cols: Vec<[u8; 4]> = COLOR_CYCLE_PALETTE.iter().map(|p| parse_hex_color(p)).collect();
    let border_col = parse_hex_color(&style.border_color);
    let border_w = (style.border_width_px.max(0.0).ceil() as i32).min(12);
    let shadow_col = parse_hex_color(&style.shadow_color);
    // 0.55 opacity baked shadow — the canvas shadow alpha ballpark.
    let shadow_col_a = [shadow_col[0], shadow_col[1], shadow_col[2], 140];
    let shadow_px = if style.shadow {
        (style.shadow_px.max(1.0).ceil() as i32).min(16)
    } else {
        0
    };

    let outline_active = border_w > 0 && style.bg_color.is_none() && border_col[3] > 0;
    let outline = if outline_active { border_col } else { [0u8, 0, 0, 0] };
    let outline_w = if outline_active { border_w } else { 0 };

    let anim = style.animation.as_str();
    let word_mode = style.word_mode.as_str();
    let color_cycle = anim == "color-cycle";
    let needs_highlight = highlight_col.is_some()
        && (word_mode == "word" || word_mode == "word-only" || word_mode == "stack");

    let transform = style.text_transform.as_str();

    // Layout per cue.
    let mut cues_out: Vec<PreparedCue> = Vec::with_capacity(style.cues.len());
    // Bitmap cache: word text → per-color bitmaps. Pre-rasterized during layout.
    let mut bitmaps: HashMap<String, [Option<Bitmap>; COLOR_SLOTS]> = HashMap::new();

    let rasterize_into = |text: &str, idx: u8, bitmaps: &mut HashMap<String, [Option<Bitmap>; COLOR_SLOTS]>| {
        let slot = (idx as usize).min(COLOR_SLOTS - 1);
        let entry = bitmaps
            .entry(text.to_string())
            .or_insert([const { None }; COLOR_SLOTS]);
        if entry[slot].is_some() {
            return;
        }
        let color = match idx {
            0 => text_col,
            1 => highlight_col.unwrap_or(text_col),
            i if (2..=5).contains(&i) => palette_cols[(i - 2) as usize],
            _ => text_col,
        };
        let (bmp, _, _) = PreparedCaptions::rasterize_word(
            &font, text, color, outline, outline_w, shadow_col_a, shadow_px,
            font_px, spacing, line_h,
        );
        entry[slot] = Some(bmp);
    };

    let stack_mode = word_mode == "stack";

    for cue in &style.cues {
        if cue.end_ms <= cue.start_ms {
            continue;
        }
        let has_words = !cue.words.is_empty();
        // Build the display word list (transformed).
        let (disp_text, words_src): (String, Vec<CaptionWord>) = if has_words {
            (
                cue.words
                    .iter()
                    .map(|w| transform_text(&w.text, transform))
                    .collect::<Vec<_>>()
                    .join(" "),
                cue.words.clone(),
            )
        } else {
            (transform_text(&cue.text, transform), Vec::new())
        };
        if disp_text.trim().is_empty() {
            continue;
        }

        // Wrap (balanced, mirroring captionSettings.balancedWrap default).
        let lines = wrap_balanced(&font, &disp_text, max_w, font_px, spacing);
        if lines.is_empty() {
            continue;
        }
        let line_count = lines.len();
        let block_h = line_count as f64 * line_h as f64;
        let max_line_w = lines
            .iter()
            .map(|l| measure_str(&font, l, font_px, spacing))
            .fold(0.0f32, f32::max) as f64;

        // Anchor Y (drawCaption): top / center / bottom + positionY inset.
        let pos_y = style.position_y.max(0.0);
        let block_top = match style.position.as_str() {
            "top" => pos_y,
            "center" => (ch_f - block_h) / 2.0 + pos_y,
            _ => ch_f - block_h - pos_y,
        };

        // Horizontal anchor: 4% safe margins, center default.
        let safe = (cw_f * 0.04).round();
        let effective_max = max_line_w.min(cw_f - safe * 2.0);
        let block_left = (cw_f - effective_max) / 2.0;
        let block_right = block_left + effective_max;

        // Word positions within the layout.
        let mut prepared_words: Vec<PreparedWord> = Vec::new();
        let mut word_global_idx = 0usize;
        for (li, line) in lines.iter().enumerate() {
            let line_top = block_top + li as f64 * line_h as f64;
            let line_w = measure_str(&font, line, font_px, spacing) as f64;
            let line_x = match style.alignment.as_str() {
                "left" => block_left,
                "right" => block_right - line_w,
                _ => (cw_f - line_w) / 2.0,
            };
            // Walk words of this line: split the display line back into
            // words and lay them sequentially (single-space advance).
            let line_words: Vec<&str> = line.split_whitespace().collect();
            let mut x = line_x;
            let mut first = true;
            for lw in line_words {
                let word_w = measure_str(&font, lw, font_px, spacing) as f64;
                if !first {
                    x += space_w as f64 + spacing as f64;
                }
                first = false;

                // Timing source: the word-timed list when present.
                let (ws, we) = if has_words && word_global_idx < words_src.len() {
                    (
                        words_src[word_global_idx].start_ms,
                        words_src[word_global_idx].end_ms,
                    )
                } else {
                    // No word timing: the whole cue window (per-word anims
                    // degenerate to the cue window — the canvas falls back
                    // to full-text rendering, same behavior).
                    (cue.start_ms, cue.end_ms)
                };

                // Rasterize the needed variants for this word. Color-cycle
                // rasterizes ALL four palette slots (the wordIndex that
                // picks the slot varies by mode — off mode uses 0, word
                // modes use the layout index).
                rasterize_into(lw, 0, &mut bitmaps);
                if needs_highlight {
                    rasterize_into(lw, 1, &mut bitmaps);
                }
                if color_cycle {
                    for slot in 2u8..=5 {
                        rasterize_into(lw, slot, &mut bitmaps);
                    }
                }

                let strip_w = (word_w.ceil() as i32
                    + (outline_w.max(shadow_px).max(2) + 2) * 2
                    + 4)
                    .max(1) as u32;
                let strip_h = (line_h.ceil() as i32
                    + (outline_w.max(shadow_px).max(2) + 2) * 2
                    + 4)
                    .max(1) as u32;

                prepared_words.push(PreparedWord {
                    text: lw.to_string(),
                    start_ms: ws,
                    end_ms: we,
                    x,
                    y: line_top,
                    w: word_w,
                    line_h: line_h as f64,
                    strip_w,
                    strip_h,
                });
                word_global_idx += 1;
                x += word_w;
            }
        }

        // Stack mode: relayout — one word per line, growing block. y is
        // computed per frame (the block grows); x centers each word.
        if stack_mode {
            for pw in prepared_words.iter_mut() {
                pw.x = (cw_f - pw.w) / 2.0;
            }
        }

        let block_cx = block_left + effective_max / 2.0;
        let block_cy = block_top + block_h / 2.0;

        cues_out.push(PreparedCue {
            start_ms: cue.start_ms,
            end_ms: cue.end_ms,
            words: prepared_words,
            line_count,
            max_line_w,
            block_top,
            block_w: effective_max,
            block_cx,
            block_cy,
            has_words,
        });
    }

    if cues_out.is_empty() {
        return Ok(None);
    }

    // Solid fills created ONCE (stable bitmap ids → stable GPU textures).
    let mut fills: HashMap<String, Bitmap> = HashMap::new();
    if let Some(bg_hex) = &style.bg_color {
        fills.insert(bg_hex.clone(), PreparedCaptions::fill_bitmap(bg_hex));
    }
    if anim == "spotlight" {
        let spot_hex = style
            .highlight_color
            .clone()
            .unwrap_or_else(|| "#FDE047".to_string());
        fills.insert(spot_hex.clone(), PreparedCaptions::fill_bitmap(&spot_hex));
    }

    Ok(Some(PreparedCaptions {
        cues: cues_out,
        style,
        bitmaps,
        fills,
        line_h: line_h as f64,
    }))
}

/// The per-frame caption layer assembly. Pure math — no rasterization.
/// Layer order: [bg box?] [spotlight?] [words...].
pub fn layers_at(pc: &PreparedCaptions, now_ms: f64, cw: u32, ch: u32) -> Vec<TextLayer> {
    let mut out: Vec<TextLayer> = Vec::new();
    let cw_f = cw as f64;
    let ch_f = ch as f64;
    let word_mode = pc.style.word_mode.as_str();
    let anim = pc.style.animation.as_str();
    let color_cycle = anim == "color-cycle";
    // v2.1: borrow instead of cloning the Option<String> per frame.
    let bg = pc.style.bg_color.as_deref();
    let bg_alpha = pc.style.bg_alpha.clamp(0.0, 1.0);
    let bg_pad = pc.style.bg_padding_px.max(0.0);
    let line_h = pc.line_h;
    // v2.1: borrow (was a fresh String per spotlight word per frame).
    let default_spot: &str = "#FDE047";
    let spot_col = pc.style.highlight_color.as_deref().unwrap_or(default_spot);

    for cue in &pc.cues {
        if now_ms < cue.start_ms || now_ms >= cue.end_ms {
            continue;
        }

        // Cue-level: find the visible word set + the active word index.
        let active_idx: Option<usize> = cue
            .words
            .iter()
            .position(|w| now_ms >= w.start_ms && now_ms < w.end_ms)
            .or_else(|| {
                // most recent started word (keeps word-only/stack stable
                // between word gaps)
                let mut last: Option<usize> = None;
                for (i, w) in cue.words.iter().enumerate() {
                    if now_ms >= w.start_ms {
                        last = Some(i);
                    }
                }
                last
            });

        // ── mode: word-only — the active word alone, centered ──
        if word_mode == "word-only" && cue.has_words {
            let Some(ai) = active_idx else { continue };
            let pw = &cue.words[ai];
            let t = compute_word_transform(anim, pw.start_ms, pw.end_ms, now_ms, ai, ch_f, color_cycle);
            if t.alpha <= 0.01 {
                continue;
            }
            // centered at the position anchor (1-line block)
            let block_h = line_h;
            let pos_y = pc.style.position_y.max(0.0);
            let block_top = match pc.style.position.as_str() {
                "top" => pos_y,
                "center" => (ch_f - block_h) / 2.0 + pos_y,
                _ => ch_f - block_h - pos_y,
            };
            let cx = cw_f / 2.0;
            let cy = block_top + block_h / 2.0;
            let color_idx = if pc.style.highlight_color.is_some() { 1 } else { t.color_idx };
            if let Some(bmp) = pc.word_bitmap(&pw.text, if t.color_idx >= 2 { t.color_idx } else { color_idx }) {
                push_word_layer(&mut out, bmp, pw, cx - pw.w / 2.0, block_top, &t, (cx, cy), pw.line_h);
            }
            continue;
        }

        // ── mode: stack — spoken words stacked, active highlighted ──
        if word_mode == "stack" && cue.has_words {
            let Some(ai) = active_idx else { continue };
            let from = ai.saturating_sub(7); // max 8 rows (canvas window)
            // block bottom is anchored; rows grow upward
            let pos_y = pc.style.position_y.max(0.0);
            let visible = ai - from + 1;
            let block_h = visible as f64 * line_h;
            let block_top = match pc.style.position.as_str() {
                "top" => pos_y,
                "center" => (ch_f - block_h) / 2.0 + pos_y,
                _ => ch_f - block_h - pos_y,
            };
            // bg box spans the stack block
            if let Some(bg_hex) = bg {
                if bg_alpha > 0.01 {
                    let fill = pc.fill(bg_hex);
                    let bw = cue.max_line_w.min(cw_f * 0.92) + bg_pad * 2.0;
                    out.push(TextLayer {
                        bitmap: fill,
                        dest_px: (
                            ((cw_f - bw) / 2.0).round().max(0.0) as u32,
                            (block_top - bg_pad).round().max(0.0) as u32,
                            bw.round().max(1.0) as u32,
                            (block_h + bg_pad * 2.0).round().max(1.0) as u32,
                        ),
                        alpha: bg_alpha as f32,
                    });
                }
            }
            for j in from..=ai {
                let pw = &cue.words[j];
                let row = j - from;
                let y = block_top + row as f64 * line_h;
                let cx = pw.x + pw.w / 2.0;
                let cy = y + line_h / 2.0;
                let t = compute_word_transform(anim, pw.start_ms, pw.end_ms, now_ms, j, ch_f, color_cycle);
                let is_active = j == ai;
                let mut t = t;
                if !is_active {
                    // spoken words above: dim (ASS &HA0& ≈ 0.37 opacity)
                    t.alpha *= 0.37;
                    t.spotlight = false;
                }
                if t.alpha <= 0.01 {
                    continue;
                }
                let color_idx = if is_active && pc.style.highlight_color.is_some() {
                    1
                } else if t.color_idx >= 2 {
                    t.color_idx
                } else {
                    0
                };
                if let Some(bmp) = pc.word_bitmap(&pw.text, color_idx) {
                    push_word_layer(&mut out, bmp, pw, pw.x, y, &t, (cx, cy), line_h);
                }
            }
            continue;
        }

        // ── modes: off / word (karaoke) — the wrapped block layout ──
        // bg box behind the block.
        if let Some(bg_hex) = bg {
            if bg_alpha > 0.01 {
                let fill = pc.fill(bg_hex);
                let box_w = (cue.block_w + bg_pad * 2.0).round().max(1.0) as u32;
                out.push(TextLayer {
                    bitmap: fill,
                    dest_px: (
                        ((cw_f - cue.block_w) / 2.0 - bg_pad).round().max(0.0) as u32,
                        (cue.block_top - bg_pad).round().max(0.0) as u32,
                        box_w,
                        (cue.line_count as f64 * line_h + bg_pad * 2.0).round().max(1.0) as u32,
                    ),
                    alpha: bg_alpha as f32,
                });
            }
        }

        for (i, pw) in cue.words.iter().enumerate() {
            let t = if word_mode == "word" && cue.has_words {
                compute_word_transform(anim, pw.start_ms, pw.end_ms, now_ms, i, ch_f, color_cycle)
            } else {
                // "off" (or no word timing): whole-cue transform (the
                // canvas passes wordIndex 0 — all words share one transform)
                compute_word_transform(anim, cue.start_ms, cue.end_ms, now_ms, 0, ch_f, color_cycle)
            };
            if t.alpha <= 0.01 {
                continue;
            }
            // Karaoke highlight: the ACTIVE word (most recent started —
            // mirrors activeWordIndex, the canvas ground truth the preview
            // renders; the ASS \k approximation fills every spoken word,
            // which visibly drifted from the preview).
            let karaoke_active = word_mode == "word" && cue.has_words && active_idx == Some(i);
            let color_idx = if t.color_idx >= 2 {
                t.color_idx
            } else if karaoke_active && pc.style.highlight_color.is_some() {
                1
            } else {
                0
            };
            let bmp = match pc.word_bitmap(&pw.text, color_idx) {
                Some(b) => b,
                None => continue,
            };
            // spotlight box behind the active word
            if t.spotlight {
                let fill = pc.fill(spot_col);
                let grow = 0.6 + 0.4 * t.scale.min(1.0);
                let bw = ((pw.w + bg_pad * 2.0) * grow).round().max(1.0) as u32;
                let bh = ((pw.line_h + bg_pad * 0.6) * grow).round().max(1.0) as u32;
                let ccx = pw.x + pw.w / 2.0 + t.off_x;
                let ccy = pw.y + pw.line_h / 2.0 + t.off_y;
                out.push(TextLayer {
                    bitmap: fill,
                    dest_px: (
                        (ccx - bw as f64 / 2.0).round().max(0.0) as u32,
                        (ccy - bh as f64 / 2.0).round().max(0.0) as u32,
                        bw,
                        bh,
                    ),
                    alpha: (t.alpha * 0.95) as f32,
                });
            }
            let anchor = if word_mode == "word" && cue.has_words {
                (pw.x + pw.w / 2.0, pw.y + pw.line_h / 2.0)
            } else {
                // whole-cue animation scales around the block center
                (cue.block_cx, cue.block_cy)
            };
            push_word_layer(&mut out, bmp, pw, pw.x, pw.y, &t, anchor, line_h);
        }
    }
    out
}

/// Push one word's TextLayer with the transform applied around `anchor`.
#[allow(clippy::too_many_arguments)]
fn push_word_layer(
    out: &mut Vec<TextLayer>,
    bmp: &Bitmap,
    pw: &PreparedWord,
    x: f64,
    y: f64,
    t: &WordAnim,
    anchor: (f64, f64),
    line_h: f64,
) {
    let sw = pw.strip_w as f64 * t.scale * t.scale_x;
    let sh = pw.strip_h as f64 * t.scale * t.scale_y;
    // The strip is drawn around the glyph rect: strip center sits at
    // (x + w/2 ± offsets) — same visual anchor the canvas uses.
    let gcx = x + pw.w / 2.0 + t.off_x;
    let gcy = y + line_h / 2.0 + t.off_y;
    // Scale around the ANCHOR (block center for whole-cue, glyph center
    // for per-word): map the glyph center through the anchor scaling.
    let (dx, dy) = if (anchor.0 - gcx).abs() < 0.5 && (anchor.1 - gcy).abs() < 0.5 {
        (gcx - sw / 2.0, gcy - sh / 2.0)
    } else {
        let rx = anchor.0 + (gcx - anchor.0) * t.scale * t.scale_x;
        let ry = anchor.1 + (gcy - anchor.1) * t.scale * t.scale_y;
        (rx - sw / 2.0, ry - sh / 2.0)
    };
    out.push(TextLayer {
        bitmap: bmp.clone(),
        dest_px: (
            // Negative coords wrap to huge u32 — the compositor's rect
            // clamp then skips fully-offscreen strips (words animate
            // around in-place anchors, so this only fires far offscreen).
            dx.round().max(0.0) as u32,
            dy.round().max(0.0) as u32,
            sw.round().max(1.0) as u32,
            sh.round().max(1.0) as u32,
        ),
        alpha: t.alpha.clamp(0.0, 1.0) as f32,
    });
}

// ── unit tests (cargo test) ────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use crate::timeline::{CaptionCue, CaptionWord};

    fn sans_font() -> String {
        let p = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
        if std::path::Path::new(p).exists() {
            p.to_string()
        } else {
            // Windows CI: arial.ttf
            let w = "C:\\Windows\\Fonts\\arial.ttf";
            if std::path::Path::new(w).exists() {
                w.to_string()
            } else {
                String::new()
            }
        }
    }

    fn timeline_with_captions(word_mode: &str, animation: &str) -> Timeline {
        let mut t = Timeline::default();
        t.width = 1280;
        t.height = 720;
        t.fps = 30.0;
        t.total_ms = 6000.0;
        if let Some(p) = {
            let p = sans_font();
            if p.is_empty() { None } else { Some(p) }
        } {
            t.fonts.insert("caption".into(), p);
        }
        t.fonts.insert(
            "sans".into(),
            sans_font(),
        );
        t.captions = Some(CaptionsTimeline {
            font_key: "caption".into(),
            font_size_px: 36.0,
            text_color: "#FFFFFF".into(),
            highlight_color: Some("#FFD700".into()),
            border_color: "#000000".into(),
            border_width_px: 3.0,
            bg_color: None,
            bg_alpha: 1.0,
            bg_padding_px: 10.0,
            shadow: true,
            shadow_color: "#000000".into(),
            shadow_px: 3.0,
            text_transform: "uppercase".into(),
            letter_spacing_px: 1.0,
            alignment: "center".into(),
            position: "bottom".into(),
            position_y: 40.0,
            max_width_frac: 0.84,
            word_mode: word_mode.into(),
            animation: animation.into(),
            cues: vec![CaptionCue {
                start_ms: 1000.0,
                end_ms: 3000.0,
                text: "the quick brown fox".into(),
                words: vec![
                    CaptionWord { text: "the".into(), start_ms: 1000.0, end_ms: 1300.0 },
                    CaptionWord { text: "quick".into(), start_ms: 1300.0, end_ms: 1700.0 },
                    CaptionWord { text: "brown".into(), start_ms: 1700.0, end_ms: 2100.0 },
                    CaptionWord { text: "fox".into(), start_ms: 2100.0, end_ms: 2400.0 },
                ],
            }],
        });
        t
    }

    #[test]
    fn prepare_lays_out_cues() {
        let t = timeline_with_captions("word", "none");
        if sans_font().is_empty() {
            eprintln!("(no system font on this machine — skipping)");
            return;
        }
        let pc = prepare(&t, 1280, 720).expect("prepare ok").expect("some captions");
        assert_eq!(pc.cues.len(), 1);
        let cue = &pc.cues[0];
        assert_eq!(cue.words.len(), 4);
        // uppercase transform applied
        assert_eq!(cue.words[0].text, "THE");
        // bottom anchor: block sits near the bottom, above positionY inset
        assert!(cue.block_top > 720.0 * 0.6, "block_top {} should be low", cue.block_top);
        // words laid out left-to-right with increasing x
        let xs: Vec<f64> = cue.words.iter().map(|w| w.x).collect();
        assert!(xs.windows(2).all(|p| p[1] > p[0]), "xs increasing: {:?}", xs);
        // bitmaps cached for normal + highlight variants (word mode)
        assert!(pc.bitmaps.get("THE").map(|v| v[0].is_some()).unwrap_or(false));
        assert!(pc.bitmaps.get("THE").map(|v| v[1].is_some()).unwrap_or(false));
    }

    #[test]
    fn karaoke_highlight_kicks_in() {
        let t = timeline_with_captions("word", "none");
        if sans_font().is_empty() {
            eprintln!("(no system font on this machine — skipping)");
            return;
        }
        let pc = prepare(&t, 1280, 720).unwrap().unwrap();
        // before any word starts: 4 layers, all normal color
        let before = layers_at(&pc, 999.0, 1280, 720);
        // 999 < cue.start (1000) → NOTHING
        assert_eq!(before.len(), 0);
        // mid-cue: all 4 words visible
        let mid = layers_at(&pc, 1600.0, 1280, 720);
        assert_eq!(mid.len(), 4);
        // all words are the SAME bitmap height (baseline alignment)
        let hs: Vec<u32> = mid.iter().map(|l| l.dest_px.3).collect();
        assert!(hs.windows(2).all(|p| p[0] == p[1]), "equal strip heights: {:?}", hs);
        // word-only mode: exactly ONE visible word at a time
        let t2 = timeline_with_captions("word-only", "none");
        let pc2 = prepare(&t2, 1280, 720).unwrap().unwrap();
        let one = layers_at(&pc2, 1500.0, 1280, 720);
        assert_eq!(one.len(), 1);
        // stack mode: spoken words stack (2 at 1500: "the","quick"), older dimmed
        let t3 = timeline_with_captions("stack", "none");
        let pc3 = prepare(&t3, 1280, 720).unwrap().unwrap();
        let stack = layers_at(&pc3, 1500.0, 1280, 720);
        assert_eq!(stack.len(), 2);
        let alphas: Vec<f32> = stack.iter().map(|l| l.alpha).collect();
        assert!(alphas[0] < 0.5 && alphas[1] >= 0.99, "dim + active: {:?}", alphas);
    }

    #[test]
    fn animation_transforms_play() {
        let t = timeline_with_captions("word", "pop-in");
        if sans_font().is_empty() {
            eprintln!("(no system font on this machine — skipping)");
            return;
        }
        let pc = prepare(&t, 1280, 720).unwrap().unwrap();
        // t=1001: the FIRST word is mid pop-in; future words are hidden
        // (canvas ground truth: karaoke + per-word entrance = words appear
        // as spoken — drawWordHighlight draws each word through
        // computeWordTransform, and a future word's alpha is 0).
        let early = layers_at(&pc, 1001.0, 1280, 720);
        assert_eq!(early.len(), 1, "only the spoken-so-far word: {:?}", early.len());
        // the first word's strip must be SMALLER than its resting size
        let first = &early[0];
        let rest = pc.cues[0].words[0].strip_w;
        assert!(
            (first.dest_px.2 as f64) < rest as f64 * 0.9,
            "pop-in scale-in expected: dest {} vs strip {}",
            first.dest_px.2,
            rest
        );
        assert!(first.alpha < 0.9, "pop-in alpha ramp expected");
        // mid-cue: the + quick (brown starts at 1700)
        let mid = layers_at(&pc, 1600.0, 1280, 720);
        assert_eq!(mid.len(), 2);
        // settled past every entrance (cue still runs to 3000): all 4 words
        let settled = layers_at(&pc, 2600.0, 1280, 720);
        assert_eq!(settled.len(), 4);
        for l in &settled {
            assert!((l.alpha - 1.0).abs() < 0.001, "settled alpha: {}", l.alpha);
        }
        // cue fully over at 3000 → nothing
        assert_eq!(layers_at(&pc, 3000.0, 1280, 720).len(), 0);
    }

    #[test]
    fn bg_box_and_fills() {
        let mut t = timeline_with_captions("word", "none");
        if sans_font().is_empty() {
            eprintln!("(no system font on this machine — skipping)");
            return;
        }
        t.captions.as_mut().unwrap().bg_color = Some("#101010".into());
        let pc = prepare(&t, 1280, 720).unwrap().unwrap();
        let layers = layers_at(&pc, 1500.0, 1280, 720);
        // bg box first + 4 words
        assert_eq!(layers.len(), 5);
        let bg = &layers[0];
        assert_eq!((bg.bitmap.w, bg.bitmap.h), (1, 1), "solid fill");
        assert!(bg.dest_px.2 > 100, "box width spans the block: {}", bg.dest_px.2);
        assert_eq!(bg.alpha, 1.0);
    }
}

#[cfg(test)]
mod dbg_tests {
    use super::*;
    use crate::timeline::{CaptionCue, CaptionWord};

    #[test]
    fn word_bitmap_has_pixels() {
        let p = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
        let bytes = std::fs::read(p).unwrap();
        let font = fontdue::Font::from_bytes(bytes, fontdue::FontSettings { collection_index: 0, scale: 40.0, load_substitutions: true }).unwrap();
        let (bmp, sw, sh) = PreparedCaptions::rasterize_word(
            &font, "THE", [255,255,255,255], [0,0,0,0], 0, [0,0,0,140], 2, 26.0, 0.0, 32.5,
        );
        let mut nonzero = 0;
        let mut max_a = 0u8;
        for i in 0..bmp.data.len()/4 {
            let a = bmp.data[i*4+3];
            if a > 0 { nonzero += 1; }
            if a > max_a { max_a = a; }
        }
        eprintln!("bitmap {}x{} nonzero={} max_a={}", sw, sh, nonzero, max_a);
        assert!(nonzero > 50, "word bitmap should have glyph pixels: {}x{} nonzero={}", sw, sh, nonzero);
        assert!(max_a > 200, "fill pass should write near-opaque pixels, max_a={}", max_a);
    }
}

#[cfg(test)]
mod dbg2_tests {
    use super::*;
    use crate::compositor::cpu::CpuCompositor;
    use crate::compositor::{Bitmap, Compositor, TextLayer};

    #[test]
    fn cpu_compositor_blits_word_layer() {
        // 60x30 strip, solid-ish glyph pattern in the middle
        let (w, h) = (60u32, 30u32);
        let mut data = vec![0u8; (w * h * 4) as usize];
        for y in 10..20 {
            for x in 10..50 {
                let d = ((y * w + x) * 4) as usize;
                data[d] = 255; data[d+1] = 255; data[d+2] = 255; data[d+3] = 255;
            }
        }
        let bmp = Bitmap::new(data, w, h);
        // equal dims — direct path
        let mut c = CpuCompositor::new(200, 100);
        c.render_frame(&[], &[TextLayer { bitmap: bmp.clone(), dest_px: (50, 50, w, h), alpha: 1.0 }], [32,32,32,255], 200, 100).unwrap();
        let out = c.output().to_vec();
        let mut white = 0;
        for i in (0..out.len()).step_by(4) {
            if out[i] > 220 && out[i+1] > 220 && out[i+2] > 220 { white += 1; }
        }
        eprintln!("equal-dims white px: {}", white);
        assert!(white > 300, "direct blit failed: {}", white);

        // scaled path — dest 30x15 (half)
        let mut c2 = CpuCompositor::new(200, 100);
        c2.render_frame(&[], &[TextLayer { bitmap: bmp, dest_px: (50, 50, 30, 15), alpha: 1.0 }], [32,32,32,255], 200, 100).unwrap();
        let out2 = c2.output().to_vec();
        let mut white2 = 0;
        for i in (0..out2.len()).step_by(4) {
            if out2[i] > 200 && out2[i+1] > 200 && out2[i+2] > 200 { white2 += 1; }
        }
        eprintln!("scaled white px: {}", white2);
        assert!(white2 > 30, "scaled blit failed: {}", white2);
    }
}
