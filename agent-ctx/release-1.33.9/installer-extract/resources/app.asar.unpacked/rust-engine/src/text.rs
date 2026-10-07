//! Text rasterization — DIRECTIVE 6 rule 1: fonts are NOT bundled in Rust.
//! Electron passes OS font paths (e.g. `C:\Windows\Fonts\arial.ttf`) in the
//! timeline JSON; `fontdue` loads them at runtime and rasterizes headline
//! strips once, which the compositor blits per frame (with fade alpha).

use crate::compositor::TextLayer;
use crate::compositor::{Bitmap, parse_hex_color};
use crate::timeline::{TextOverlay, Timeline};
use std::collections::HashMap;

pub struct TextRenderer {
    fonts: HashMap<String, fontdue::Font>,
}

impl TextRenderer {
    pub fn new() -> Self {
        TextRenderer { fonts: HashMap::new() }
    }

    fn font(&mut self, timeline: &Timeline, key: &str) -> Result<&fontdue::Font, String> {
        let k = if timeline.fonts.contains_key(key) {
            key.to_string()
        } else if timeline.fonts.contains_key("sans") {
            "sans".to_string()
        } else {
            return Err(format!("no font configured for `{}` (timeline.fonts is empty — Electron must pass OS font paths)", key));
        };
        if !self.fonts.contains_key(&k) {
            let path = timeline
                .fonts
                .get(&k)
                .cloned()
                .ok_or_else(|| format!("font path missing for {}", k))?;
            let bytes = std::fs::read(&path)
                .map_err(|e| format!("cannot read font `{}` ({}): {}", k, path, e))?;
            let font = fontdue::Font::from_bytes(
                bytes,
                fontdue::FontSettings { collection_index: 0, scale: 40.0, load_substitutions: true },
            )
            .map_err(|e| format!("cannot parse font `{}`: {}", path, e))?;
            self.fonts.insert(k.clone(), font);
        }
        Ok(self.fonts.get(&k).unwrap())
    }

    /// Rasterize one text overlay into a RGBA bitmap + pixel dest rect
    /// (position presets map to canvas fractions; scale relative to 1080p).
    pub fn rasterize(
        &mut self,
        timeline: &Timeline,
        text: &TextOverlay,
        canvas_w: u32,
        canvas_h: u32,
    ) -> Result<TextLayer, String> {
        let font = self.font(timeline, &text.font)?;
        let size = (((text.size.max(4.0)) as f32) * (canvas_h as f32 / 1080.0)).max(8.0);
        let color = parse_hex_color(&text.color);
        let outline = parse_hex_color(&text.outline_color);

        // measure (single line; shrink to fit 92% of canvas width)
        let chars: Vec<char> = text.text.chars().collect();
        let mut width = 0.0f32;
        let mut max_h = 0.0f32;
        let mut advance_x: Vec<f32> = Vec::with_capacity(chars.len());
        for &ch in &chars {
            let m = font.metrics(ch, size);
            advance_x.push(m.advance_width);
            width += m.advance_width;
            max_h = max_h.max(m.height as f32);
        }
        let max_w = canvas_w as f32 * 0.92;
        let fit = if width > max_w && width > 0.0 { max_w / width } else { 1.0 };
        let size = size * fit;
        // re-measure at fitted size
        let mut width = 0.0f32;
        let mut advance_x = Vec::with_capacity(chars.len());
        for &ch in &chars {
            let m = font.metrics(ch, size);
            advance_x.push(m.advance_width);
            width += m.advance_width;
        }
        let line_h = size * 1.15;
        let outline_w = (size / 24.0).ceil().max(1.5) as i32;
        let pad = outline_w.max(2);

        let strip_w = (width.ceil() as i32 + pad * 2 + 4).max(1) as u32;
        let strip_h = (line_h.ceil() as i32 + pad * 2 + 4).max(1) as u32;
        let mut rgba = vec![0u8; strip_w as usize * strip_h as usize * 4];

        // `is_fill` marks the TOPMOST glyph pass: it owns its pixels
        // unconditionally. The under-passes (outline offsets) max-blend so
        // the strongest outline coverage wins — but an alpha-equality
        // comparison would let the outline's identical coverage suppress
        // the fill and render the glyph body in the OUTLINE color (the
        // v1.20 caption shadow/outline-only render bug, same class here).
        let place = |rgba: &mut Vec<u8>, ox: i32, oy: i32, col: [u8; 4], use_alpha: bool, is_fill: bool| {
            let mut x = pad as i32;
            for (i, &ch) in chars.iter().enumerate() {
                let (m, cov) = font.rasterize(ch, size);
                let gx = x + m.xmin as i32 + ox;
                let gy = pad + (line_h.ceil() as i32) - (m.ymin as i32) - (m.height as i32) + oy;
                for py in 0..m.height as i32 {
                    for px in 0..m.width as i32 {
                        let c = cov[(py as usize) * m.width as usize + px as usize];
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
                        if is_fill || a > rgba[d + 3] {
                            rgba[d] = col[0];
                            rgba[d + 1] = col[1];
                            rgba[d + 2] = col[2];
                            rgba[d + 3] = a;
                        }
                    }
                }
                x += advance_x[i] as i32;
            }
        };

        // outline pass (4 directions), then the glyph pass on top
        if outline[3] > 0 {
            for &(ox, oy) in &[
                (-outline_w, 0),
                (outline_w, 0),
                (0, -outline_w),
                (0, outline_w),
                (-outline_w, -outline_w),
                (outline_w, -outline_w),
                (-outline_w, outline_w),
                (outline_w, outline_w),
            ] {
                place(&mut rgba, ox, oy, outline, false, false);
            }
        }
        place(&mut rgba, 0, 0, color, true, true);

        // dest rect: anchor from position preset / explicit x
        let y_frac = match text.position.as_str() {
            "top" => 0.10,
            "upper" => 0.25,
            "center" => 0.48,
            "lower" => 0.72,
            "bottom" => 0.86,
            _ => 0.86,
        };
        let cx = (if text.x > 0.0 { text.x } else { 0.5 }) * canvas_w as f64;
        let cy = y_frac * canvas_h as f64;
        let dx = (cx - strip_w as f64 / 2.0).round().clamp(0.0, (canvas_w - 1) as f64) as u32;
        let dy = (cy - strip_h as f64 / 2.0).round().clamp(0.0, (canvas_h - 1) as f64) as u32;

        Ok(TextLayer {
            bitmap: Bitmap::new(rgba, strip_w, strip_h),
            dest_px: (dx, dy, strip_w, strip_h),
            alpha: 1.0,
        })
    }
}

impl Default for TextRenderer {
    fn default() -> Self {
        Self::new()
    }
}
