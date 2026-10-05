//! v1.21 NATIVE KINETIC TYPOGRAPHY renderer — the v1.18 engine off the
//! FFmpeg-CLI/libass path.
//!
//! Architecture (mirrors captions.rs, the v1.20 native caption renderer):
//!   * The RENDERER measured every word rect (absolute x/y/w/h/fontPx at
//!     the export resolution) with the SAME bundled TTFs the engine loads
//!     — layout parity by construction. Rust never re-derives the semantic
//!     plan (§36 determinism): the payload carries per-word timing,
//!     emphasis/role/phraseIndex and the effective font weight.
//!   * Electron embeds each composition's preset motion/visual spec
//!     (from its kinetic-ass.js mirror of kinetic/presets.ts).
//!   * This module ports src/lib/merger/kinetic/motion.ts EXACTLY (math
//!     only) to solve per-word transforms per frame, then blits
//!     pre-rasterized fontdue strips through the compositor's scaled
//!     TextLayer path (identical to animated caption words).
//!
//! Documented deviations from the canvas painter (all cosmetic-entrance):
//!   * blur (blur-focus entrance) → dropped (CPU compositor has no per-blit
//!     blur; the scale component still animates — 1.12 → 1.0).
//!   * clipLeft (clip-wipe entrance) → alpha ramp approximation.
//!   * blockRotateDeg (diagonal-stack, -3°) → dropped for the one preset
//!     that uses it (rect blits cannot rotate; the ASS twin keeps \frz).
//! Everything else — entrances, emphasis events, hold, push-out, exits,
//! tier alphas, offsets (1080p-referenced × ch/1080) — is an exact port.

use crate::captions::PreparedCaptions;
use crate::compositor::{parse_hex_color, Bitmap, TextLayer};
use crate::timeline::{KineticComp, KineticGeoWordR, KineticPresetSpec, Timeline};
use std::collections::HashMap;

// ── motion.ts math (exact port) ─────────────────────────────────────────────

fn motion_energy(level: &str) -> f64 {
    match level {
        "subtle" => 0.6,
        "balanced" => 1.0,
        "dynamic" => 1.25,
        "extreme" => 1.6,
        _ => 1.0,
    }
}

fn ease_out_cubic(t: f64) -> f64 {
    1.0 - (1.0 - t).powi(3)
}

fn ease_out_back(t: f64, overshoot: f64) -> f64 {
    let c1 = 1.2 + overshoot * 2.2;
    let c3 = c1 + 1.0;
    1.0 + c3 * (t - 1.0).powi(3) + c1 * (t - 1.0).powi(2)
}

fn ease_in_out_sine(t: f64) -> f64 {
    -(f64::cos(std::f64::consts::PI * t) - 1.0) / 2.0
}

fn clamp01(v: f64) -> f64 {
    if v < 0.0 { 0.0 } else if v > 1.0 { 1.0 } else { v }
}

/// Radial directions for burst/converge — deterministic per word index.
fn burst_vector(idx: usize) -> (f64, f64) {
    const PATTERN: [(f64, f64); 6] = [
        (-1.0, -0.55),
        (1.0, -0.5),
        (-1.0, 0.6),
        (1.0, 0.55),
        (-0.55, -1.0),
        (0.6, 1.0),
    ];
    PATTERN[idx % PATTERN.len()]
}

/// The per-word transform (the fields of KineticWordTransform the native
/// renderer can express; blur/clipLeft/rotate/colorOverride documented away).
#[derive(Clone, Copy, Debug)]
pub struct KineticTransform {
    pub alpha: f64,
    pub scale: f64,
    pub offset_x: f64,
    pub offset_y: f64,
}

impl Default for KineticTransform {
    fn default() -> Self {
        KineticTransform { alpha: 1.0, scale: 1.0, offset_x: 0.0, offset_y: 0.0 }
    }
}

/// Port of kineticWordTransforms for ONE word (the TS loop body, verbatim).
#[allow(clippy::too_many_arguments)]
fn word_transform(
    comp: &KineticComp,
    preset: &KineticPresetSpec,
    word: &KineticGeoWordR,
    idx: usize,
    now_ms: f64,
    motion_level: &str,
    ch: f64,
    phrase_align: Option<&str>,
    phrase_last_end_ms: Option<f64>,
) -> KineticTransform {
    let energy = motion_energy(motion_level) * (ch / 1080.0);
    let scale_ref = ch / 1080.0;
    let mut t = KineticTransform::default();

    // motion.ts: entranceMs = Math.max(60, entranceMs * (subtle ? 1.2 : 1)) —
    // the subtle stretch applies BEFORE the 60ms floor (v1.27.2: exact mirror;
    // the old two-step form clamped first, stretching <50ms presets 20% longer
    // than the preview — unreachable with the shipped 90ms+ presets but wrong).
    let entrance_ms = (preset.entrance_ms
        * if motion_level == "subtle" {
            1.2
        } else {
            1.0
        })
    .max(60.0);
    let stagger = preset.stagger_ms;
    let exit_ms = preset.exit_ms;

    let role = word.role.as_str();
    let role_energy = if role == "primary" { 1.0 } else if role == "secondary" { 0.6 } else { 0.35 };
    let phrase_idx = word.phrase_index;

    // Entrance window: stagger is PER PHRASE (§22) + typewriter per word.
    let delay = (phrase_idx as f64) * stagger
        + if preset.entrance == "typewriter" { idx as f64 * stagger } else { 0.0 };
    let enter_start = (comp.start_ms.max(word.start_ms - 60.0)) + delay;
    let enter_end = enter_start + entrance_ms;
    let et = clamp01((now_ms - enter_start) / (enter_end - enter_start).max(0.0001));

    // Exit window (whole composition).
    let exit_start = comp.end_ms - exit_ms;
    let xt = clamp01((now_ms - exit_start) / exit_ms.max(0.0001));

    // Emphasis event window (§21).
    let emph_t = clamp01(
        (now_ms - word.start_ms) / (word.end_ms - word.start_ms).max(160.0),
    );

    // ── Entrance choreography per preset ──
    if et < 1.0 {
        let e = ease_out_cubic(et);
        let e_b = ease_out_back(et, preset.overshoot);
        match preset.entrance.as_str() {
            "fade-rise" => {
                t.alpha = e;
                t.offset_y = (1.0 - e) * 36.0 * energy * role_energy;
            }
            "word-pop" => {
                t.alpha = (et * 2.5).min(1.0);
                t.scale = 0.4 + 0.6 * e_b;
            }
            "scale-slam" => {
                t.alpha = (et * 3.0).min(1.0);
                t.scale = 2.4 - 1.4 * e_b;
                if et < 0.4 && word.emphasis {
                    t.offset_x = (et * 40.0).sin() * 5.0 * energy;
                }
            }
            "slide-x" => {
                t.alpha = e;
                let dir = match phrase_align {
                    Some("right") => 1.0,
                    Some("left") => -1.0,
                    _ => if idx % 2 == 0 { -1.0 } else { 1.0 },
                };
                t.offset_x = (1.0 - e) * 56.0 * energy * dir;
            }
            "slide-y" => {
                t.alpha = e;
                t.offset_y = (1.0 - e) * 42.0 * energy * if idx % 2 == 0 { -1.0 } else { 1.0 };
            }
            "clip-wipe" => {
                // Deviation: wipe reveal → alpha ramp (documented).
                t.alpha = (et * 1.6).min(1.0);
            }
            "blur-focus" => {
                // Deviation: blur dropped; scale still animates 1.12 → 1.0.
                t.alpha = e;
                t.scale = 1.12 - 0.12 * e;
            }
            "burst" => {
                let (dx, dy) = burst_vector(idx);
                t.alpha = e;
                t.offset_x = (1.0 - e) * dx * 64.0 * energy * role_energy;
                t.offset_y = (1.0 - e) * dy * 46.0 * energy * role_energy;
                t.scale = 0.86 + 0.14 * e;
            }
            "converge" => {
                let (dx, dy) = burst_vector(idx);
                t.alpha = e;
                t.offset_x = (1.0 - e) * dx * 90.0 * energy;
                t.offset_y = (1.0 - e) * dy * 60.0 * energy;
                t.scale = 0.9 + 0.1 * e_b;
            }
            "push" => {
                t.alpha = e;
                t.offset_y = (1.0 - e) * 30.0 * energy;
            }
            "flash" => {
                t.alpha = if et < 0.25 { et / 0.25 } else { 1.0 };
                t.scale = if word.emphasis {
                    1.9 - 0.9 * e_b
                } else {
                    1.4 - 0.4 * e
                };
            }
            "typewriter" => {
                t.alpha = if et > 0.0 { 1.0 } else { 0.0 };
            }
            _ => {}
        }
    }

    // ── Emphasis event (§21) ──
    if word.emphasis && emph_t < 1.0 {
        match preset.emphasis_motion.as_str() {
            "scale-punch" => {
                let punch = ease_out_back(clamp01(emph_t), preset.overshoot);
                t.scale *= 0.7 + 0.3 * punch + 0.18 * (1.0 - emph_t);
            }
            "pulse" => {
                let pulse = 1.0 + 0.07 * (emph_t * std::f64::consts::PI * 2.0).sin() * (1.0 - emph_t);
                t.scale *= pulse;
            }
            "shake" => {
                if emph_t < 0.5 {
                    t.offset_x += (emph_t * 36.0).sin() * 6.0 * energy * (1.0 - emph_t * 2.0);
                }
                t.scale *= 1.0 + 0.12 * (1.0 - emph_t);
            }
            _ => {
                // "hold" + default
                t.scale *= 1.0 + 0.06 * (1.0 - emph_t);
            }
        }
    }

    // ── Hold behavior (§20) ──
    let spoken = now_ms >= word.start_ms && now_ms < word.end_ms;
    if preset.hold == "drift" && now_ms > word.end_ms {
        let held = clamp01(
            (now_ms - word.end_ms) / (comp.end_ms - word.end_ms).max(1.0),
        );
        t.offset_y -= held * 4.0 * scale_ref;
    }
    if spoken && preset.hold == "active-word" {
        t.scale *= 1.06;
    }

    // ── Push-out: phrases whose words have ALL been spoken drift up + dim ──
    if preset.entrance == "push" || preset.exit == "push-out" {
        if let Some(last_end) = phrase_last_end_ms {
            if now_ms > last_end + 60.0 {
                let since = clamp01((now_ms - last_end) / 600.0);
                t.alpha *= 1.0 - 0.45 * since;
                t.offset_y -= since * 26.0 * scale_ref;
            }
        }
    }

    // ── Exit choreography ──
    if xt > 0.0 {
        let ex = ease_in_out_sine(xt);
        match preset.exit.as_str() {
            "slide-down" => {
                t.alpha *= 1.0 - ex;
                t.offset_y += ex * 24.0 * scale_ref;
            }
            "scale-out" => {
                t.alpha *= 1.0 - ex;
                t.scale *= 1.0 - 0.25 * ex;
            }
            "collapse" => {
                t.alpha *= 1.0 - ex;
                t.scale *= 1.0 - 0.55 * ex;
                t.offset_y -= ex * 10.0 * scale_ref;
            }
            "push-out" => {
                t.alpha *= 1.0 - ex;
                t.offset_y -= ex * 46.0 * scale_ref;
            }
            _ => {
                // "fade" + default
                t.alpha *= 1.0 - ex;
            }
        }
    }

    // Supporting words render muted (§27 color tiers).
    if role == "supporting" {
        t.alpha *= 0.82;
    }

    t
}

// ── prepared state ──────────────────────────────────────────────────────────

pub struct PreparedKinetic {
    style: crate::timeline::KineticTimeline,
    comps: Vec<PreparedComp>,
    /// (resolved font key, text, FILL COLOR hex, size) → strip. The color is
    /// part of the key because accent colors are PER COMPOSITION (each
    /// preset carries its own accentColor — auto-mode mixes need distinct
    /// strips for the same word text).
    bitmaps: HashMap<(String, String, String, u32), Bitmap>,
    /// Same key → (strip_w, strip_h, baseline_from_top, pad). The placement
    /// math needs to know where rasterize_word put the baseline inside the
    /// strip (pad + ceil(line_h)) and the side padding (exact ink parity:
    /// canvas fillText(wx, wy) with textBaseline="top" ⇒ ink-left at
    /// strip_x + pad + xmin₀ == wx + xmin₀ ⇒ strip_x = wx − pad, and the
    /// baseline lands at wy + ascent ⇒ strip_y = wy + ascent − baseline_top).
    strip_meta: HashMap<(String, String, String, u32), (u32, u32, i32, i32)>,
}

struct PreparedComp {
    comp: KineticComp,
    /// Per-word rasterization references (cache key + the canvas ascent at
    /// this word's size — captured from the SAME TTF the renderer measured
    /// with, so the vertical anchor is metric-exact).
    words: Vec<PreparedWord>,
    /// phrase align + last word end (push-out grouping).
    phrase_align: Vec<String>,
    phrase_last_end: Vec<f64>,
}

struct PreparedWord {
    gw: KineticGeoWordR,
    /// The exact bitmap-cache key (resolved font + fill color + size).
    key: (String, String, String, u32),
    /// Font ascent at this word's size (px) — the textBaseline="top" offset.
    ascent_px: f32,
}

/// Load a font file from the timeline's font table by key.
fn load_font(timeline: &Timeline, key: &str) -> Result<fontdue::Font, String> {
    let path = timeline
        .fonts
        .get(key)
        .cloned()
        .ok_or_else(|| format!("kinetic font key `{}` missing", key))?;
    let bytes = std::fs::read(&path)
        .map_err(|e| format!("cannot read kinetic font `{}` ({}): {}", key, path, e))?;
    fontdue::Font::from_bytes(
        bytes,
        fontdue::FontSettings { collection_index: 0, scale: 40.0, load_substitutions: true },
    )
    .map_err(|e| format!("cannot parse kinetic font `{}`: {}", path, e))
}

/// Prepare: load every referenced font, rasterize every word strip once.
/// Returns None when the timeline carries no kinetic compositions.
pub fn prepare(timeline: &Timeline, cw: u32, ch: u32) -> Result<Option<PreparedKinetic>, String> {
    let style = match &timeline.kinetic {
        Some(k) if !k.comps.is_empty() => k.clone(),
        _ => return Ok(None),
    };

    let _ = cw; // rasterization uses per-word font_px (already scaled)
    let ch = ch.max(16);

    // Distinct font keys → fontdue fonts.
    let mut fonts: HashMap<String, fontdue::Font> = HashMap::new();
    let mut fallback_key: Option<String> = None;
    for comp in &style.comps {
        for w in &comp.words {
            if w.font_key.is_empty() || fonts.contains_key(&w.font_key) {
                continue;
            }
            match load_font(timeline, &w.font_key) {
                Ok(f) => {
                    fonts.insert(w.font_key.clone(), f);
                    if fallback_key.is_none() {
                        fallback_key = Some(w.font_key.clone());
                    }
                }
                Err(e) => {
                    // A missing face degrades per-word (fallback font), never
                    // fails the export — parity with the caption tolerance.
                    log::warn!("[rust-engine] kinetic font load failed: {}", e);
                }
            }
        }
    }
    if fonts.is_empty() {
        return Err("no kinetic fonts resolvable".into());
    }
    let fallback_key = fallback_key.unwrap_or_default();

    // Shadow: canvas shadow rgba(0,0,0,0.55) blur 7·scaleRef — baked as the
    // caption-style offset shadow (documented approximation).
    let shadow_col = [10u8, 10, 12, 150];
    let shadow_px = ((ch as f64 / 1080.0) * 3.0).round().max(2.0) as i32;

    let mut bitmaps: HashMap<(String, String, String, u32), Bitmap> = HashMap::new();
    let mut strip_meta: HashMap<(String, String, String, u32), (u32, u32, i32, i32)> = HashMap::new();

    let mut comps_out: Vec<PreparedComp> = Vec::with_capacity(style.comps.len());
    for comp in &style.comps {
        if comp.end_ms <= comp.start_ms || comp.words.is_empty() {
            continue;
        }

        // Phrase metadata (align + last word end) indexed by phraseIndex.
        let phrase_count = comp.phrases.len().max(
            comp.words.iter().map(|w| w.phrase_index + 1).max().unwrap_or(1),
        );
        let mut phrase_align = vec!["center".to_string(); phrase_count];
        for (i, p) in comp.phrases.iter().enumerate() {
            if i < phrase_count {
                phrase_align[i] = p.align.clone();
            }
        }
        let mut phrase_last_end = vec![0.0f64; phrase_count];
        for w in &comp.words {
            if w.phrase_index < phrase_count {
                phrase_last_end[w.phrase_index] = phrase_last_end[w.phrase_index].max(w.end_ms);
            }
        }

        let mut words_out: Vec<PreparedWord> = Vec::with_capacity(comp.words.len());
        for w in &comp.words {
            let resolved_key = if fonts.contains_key(&w.font_key) {
                w.font_key.clone()
            } else {
                fallback_key.clone()
            };
            let Some(font) = fonts.get(&resolved_key) else { continue };
            // Per-comp accent (accentOverride ?? preset accentColor); the
            // timeline-level accent is the fallback for empty.
            let accent_hex = if comp.accent_color.is_empty() {
                style.accent_color.clone()
            } else {
                comp.accent_color.clone()
            };
            let fill_hex = if w.emphasis { accent_hex } else { style.base_color.clone() };
            let fill_col = parse_hex_color(&fill_hex);
            let size = w.font_px.max(8.0) as f32;
            let line_h = w.h.max(1.0) as f32;
            let ck = (resolved_key.clone(), w.text.clone(), fill_hex, size as u32);
            if !bitmaps.contains_key(&ck) {
                let spx = if comp.preset.shadow { shadow_px } else { 0 };
                let (bmp, sw, sh) = PreparedCaptions::rasterize_word(
                    font,
                    &w.text,
                    fill_col,
                    [0u8, 0, 0, 0],
                    0, // no outline (all kinetic presets: outline false)
                    shadow_col,
                    spx,
                    size,
                    0.0, // canvas painter draws without letterSpacing
                    line_h,
                );
                // rasterize_word's internals (keep in sync):
                //   pad = max(outline_w, shadow_px).max(2) + 2
                //   baseline = pad + ceil(line_h)
                let pad = 0i32.max(spx).max(2) + 2;
                let baseline_top = pad + line_h.ceil() as i32;
                bitmaps.insert(ck.clone(), bmp);
                strip_meta.insert(ck.clone(), (sw, sh, baseline_top, pad));
            }
            // The ascent at this size — the textBaseline="top" offset the
            // canvas painter used when it measured/drew at wy.
            let ascent_px = font
                .horizontal_line_metrics(size)
                .map(|m| m.ascent)
                .unwrap_or(size * 0.9);
            words_out.push(PreparedWord { gw: w.clone(), key: ck, ascent_px });
        }
        if words_out.is_empty() {
            continue;
        }

        comps_out.push(PreparedComp {
            comp: comp.clone(),
            words: words_out,
            phrase_align,
            phrase_last_end,
        });
    }

    Ok(Some(PreparedKinetic { style, comps: comps_out, bitmaps, strip_meta }))
}

/// Per-frame layer emission (the compositor's scaled TextLayer path).
///
/// Placement is EXACT canvas parity with drawKineticComposition:
///   * unscaled strip rect: fillText(wx, wy), textBaseline="top"
///     → strip_x = wx − pad, strip_y = wy + ascent − baseline_top;
///   * the word transform (scale around the word-box center + 1080p-scaled
///     offsets) maps the strip rect exactly like the painter's
///     translate(cx,cy)/scale/translate(−cx,−cy).
pub fn layers_at(pk: &PreparedKinetic, now_ms: f64, ch: u32) -> Vec<TextLayer> {
    let mut out: Vec<TextLayer> = Vec::new();
    let ch_f = ch.max(16) as f64;
    let scale_ref = ch_f / 1080.0;

    for pc in &pk.comps {
        let comp = &pc.comp;
        if now_ms < comp.start_ms || now_ms >= comp.end_ms {
            continue;
        }
        let preset = &comp.preset;

        for (idx, pw) in pc.words.iter().enumerate() {
            let w = &pw.gw;
            let phrase_align = pc
                .phrase_align
                .get(w.phrase_index)
                .map(|s| s.as_str())
                .or(Some("center"));
            let phrase_last_end = pc.phrase_last_end.get(w.phrase_index).copied();

            let t = word_transform(
                comp,
                preset,
                w,
                idx,
                now_ms,
                &pk.style.motion_level,
                ch_f,
                phrase_align,
                phrase_last_end,
            );
            if t.alpha <= 0.01 {
                continue;
            }

            let Some(bmp) = pk.bitmaps.get(&pw.key) else { continue };
            let Some(&(sw, sh, baseline_top, pad)) = pk.strip_meta.get(&pw.key) else { continue };

            // ── unscaled strip rect (canvas ink parity) ──
            let strip_x = w.x - pad as f64;
            let strip_y = w.y + pw.ascent_px as f64 - baseline_top as f64;

            // ── transform around the word-box center (painter math) ──
            let cx = w.x + w.w / 2.0;
            let cy = w.y + w.h / 2.0;
            let s = t.scale;
            let mx = cx + t.offset_x * scale_ref + s * (strip_x - cx);
            let my = cy + t.offset_y * scale_ref + s * (strip_y - cy);
            let mw = (s * sw as f64).max(1.0);
            let mh = (s * sh as f64).max(1.0);

            out.push(TextLayer {
                bitmap: bmp.clone(),
                dest_px: (
                    mx.round().max(0.0) as u32,
                    my.round().max(0.0) as u32,
                    mw.round().max(1.0) as u32,
                    mh.round().max(1.0) as u32,
                ),
                alpha: t.alpha.clamp(0.0, 1.0) as f32,
            });
        }
    }
    out
}

// ── unit tests (cargo test) ─────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use crate::timeline::{KineticGeoWordR, KineticPhraseSpec, KineticPresetSpec, KineticTimeline};

    fn word(text: &str, idx: usize, start: f64, end: f64) -> KineticGeoWordR {
        KineticGeoWordR {
            text: text.into(),
            start_ms: start,
            end_ms: end,
            x: 100.0 + idx as f64 * 120.0,
            y: 500.0,
            w: 100.0,
            h: 90.0,
            font_px: 84.0,
            weight: 700,
            emphasis: idx == 2,
            role: "primary".into(),
            phrase_index: idx / 3,
            font_key: "kin".into(),
        }
    }

    fn comp(preset: KineticPresetSpec) -> KineticComp {
        KineticComp {
            start_ms: 1000.0,
            end_ms: 4000.0,
            preset,
            accent_color: "#FACC15".into(),
            words: (0..6).map(|i| word("w", i, 1100.0 + i as f64 * 300.0, 1350.0 + i as f64 * 300.0)).collect(),
            phrases: vec![
                KineticPhraseSpec { role: "primary".into(), align: "center".into() },
                KineticPhraseSpec { role: "secondary".into(), align: "center".into() },
            ],
        }
    }

    fn preset(entrance: &str, exit: &str, hold: &str) -> KineticPresetSpec {
        KineticPresetSpec {
            entrance: entrance.into(),
            entrance_ms: 300.0,
            stagger_ms: 110.0,
            overshoot: 0.12,
            emphasis_motion: "scale-punch".into(),
            hold: hold.into(),
            exit: exit.into(),
            exit_ms: 300.0,
            shadow: true,
            support_alpha: 0.78,
        }
    }

    #[test]
    fn entrance_fades_in_then_settles() {
        let c = comp(preset("fade-rise", "fade", "none"));
        let w = &c.words[0];
        // before window
        let t0 = word_transform(&c, &c.preset, w, 0, 900.0, "dynamic", 1080.0, Some("center"), Some(2050.0));
        assert!(t0.alpha <= 0.01);
        // mid entrance
        let t1 = word_transform(&c, &c.preset, w, 0, 1250.0, "dynamic", 1080.0, Some("center"), Some(2050.0));
        assert!(t1.alpha > 0.05 && t1.alpha < 1.0);
        assert!(t1.offset_y > 0.5);
        // settled
        let t2 = word_transform(&c, &c.preset.clone(), w, 0, 2600.0, "dynamic", 1080.0, Some("center"), Some(2050.0));
        assert!((t2.alpha - 1.0).abs() < 1e-6);
        assert!(t2.offset_y.abs() < 1e-6);
    }

    #[test]
    fn exit_fades_out() {
        let c = comp(preset("word-pop", "fade", "none"));
        let w = &c.words[0];
        // 3980ms = 280ms into the 300ms exit window (comp end 4000).
        let t = word_transform(&c, &c.preset, w, 0, 3980.0, "balanced", 1080.0, Some("center"), Some(2050.0));
        assert!(t.alpha < 0.2);
        let t2 = word_transform(&c, &c.preset, w, 0, 2600.0, "balanced", 1080.0, Some("center"), Some(2050.0));
        assert!(t2.alpha > 0.9);
    }

    #[test]
    fn word_pop_scales_from_small() {
        let c = comp(preset("word-pop", "fade", "none"));
        let w = &c.words[0];
        let t = word_transform(&c, &c.preset, w, 0, 1130.0, "dynamic", 1080.0, Some("center"), Some(2050.0));
        assert!(t.scale < 1.0);
    }

    #[test]
    fn push_out_drifts_up_and_dims() {
        let c = comp(preset("push", "push-out", "active-word"));
        let w = &c.words[0]; // phrase 0, last end 2050
        let t = word_transform(&c, &c.preset, w, 0, 3900.0, "dynamic", 1080.0, Some("center"), Some(2050.0));
        assert!(t.offset_y < -10.0);
        assert!(t.alpha < 0.6);
    }

    #[test]
    fn supporting_muted() {
        let mut c = comp(preset("fade-rise", "fade", "none"));
        c.words[5].role = "supporting".into();
        let w = &c.words[5];
        // 3100ms: word 5's entrance settled (enterEnd 2950), pre-exit.
        let t = word_transform(&c, &c.preset, w, 5, 3100.0, "dynamic", 1080.0, Some("center"), Some(2950.0));
        assert!((t.alpha - 0.82).abs() < 1e-6);
    }

    #[test]
    fn emphasis_punch_on_spoken_word() {
        let c = comp(preset("fade-rise", "fade", "none"));
        let w = &c.words[2]; // emphasis, spoken 1700..1950
        // 1850ms = 60% through the emphasis window: the scale-punch peak.
        let t = word_transform(&c, &c.preset, w, 2, 1850.0, "dynamic", 1080.0, Some("center"), Some(2050.0));
        assert!(t.scale > 1.0);
    }

    #[test]
    fn subtle_stretches_entrance_exactly_1_2x() {
        // motion.ts: entranceMs = max(60, entranceMs * (subtle ? 1.2 : 1)) —
        // the subtle stretch applies BEFORE the 60ms floor. Regression lock
        // for the v1.27.2 exact-mirror fix (the old two-step form clamped
        // first, stretching sub-50ms presets past the preview's window).
        // NOTE: subtle ALSO scales energy 0.6, so offsets aren't a clean
        // signal — alpha (energy-independent) is.
        let mut c = comp(preset("fade-rise", "fade", "none"));
        c.preset.entrance_ms = 100.0;
        let w = &c.words[0]; // enterStart = max(1000, 1100-60) = 1040
        // 60ms into the window: dynamic et=0.6 → alpha 0.936; subtle
        // et=60/120=0.5 → alpha 0.875 — the stretch measurably slows it.
        let dyn_t = word_transform(&c, &c.preset, w, 0, 1100.0, "dynamic", 1080.0, Some("center"), Some(2050.0));
        let sub_t = word_transform(&c.clone(), &c.preset, w, 0, 1100.0, "subtle", 1080.0, Some("center"), Some(2050.0));
        assert!(dyn_t.alpha > 0.93 && dyn_t.alpha < 0.94);
        assert!(sub_t.alpha > 0.87 && sub_t.alpha < 0.88);
        assert!(sub_t.alpha < dyn_t.alpha - 0.03);
        // floor case: entrance 40ms + subtle → window = max(60, 48) = 60 (not 72)
        let mut c2 = comp(preset("fade-rise", "fade", "none"));
        c2.preset.entrance_ms = 40.0;
        let t = word_transform(&c2, &c2.preset, &c2.words[0], 0, 1106.0, "subtle", 1080.0, Some("center"), Some(2050.0));
        assert!((t.alpha - 1.0).abs() < 1e-6, "floor: entrance settled by 66ms");
        assert!(t.offset_y.abs() < 1e-6);
    }

    #[test]
    fn timeline_deserializes() {
        let json = r##"{
            "baseColor": "#FFFFFF", "accentColor": "#FACC15", "motionLevel": "dynamic",
            "comps": [{ "startMs": 0, "endMs": 3000,
              "preset": { "entrance": "fade-rise", "entranceMs": 300, "staggerMs": 110,
                          "overshoot": 0.12, "emphasisMotion": "hold", "hold": "drift",
                          "exit": "fade", "exitMs": 300, "shadow": true, "supportAlpha": 0.78 },
              "words": [{ "text": "HELLO", "startMs": 0, "endMs": 400, "x": 10, "y": 20,
                          "w": 100, "h": 90, "fontPx": 84, "weight": 700, "emphasis": true,
                          "role": "primary", "phraseIndex": 0, "fontKey": "kin-700" }],
              "accentColor": "#FACC15",
              "phrases": [{ "role": "primary", "align": "center" }] }]
        }"##;
        let k: KineticTimeline = serde_json::from_str(json).unwrap();
        assert_eq!(k.comps.len(), 1);
        assert_eq!(k.comps[0].words[0].text, "HELLO");
        assert!(k.comps[0].words[0].emphasis);
        assert_eq!(k.comps[0].preset.entrance, "fade-rise");
    }
}
