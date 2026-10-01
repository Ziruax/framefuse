//! CPU rasterizer compositor — the always-works fallback path.
//!
//! Scales each layer bitmap (crop window → dest rect) with
//! `fast_image_resize` (SIMD), then alpha-blends into an RGBA canvas with
//! optional chroma key. Static image layers hit the scale cache; video
//! frames (fresh Arc pointers each frame) resize per frame.

use super::{chroma_alpha, rgb_to_yuv601, Compositor, Layer, OutputFormat, TextLayer};
use fast_image_resize::FilterType;
use fast_image_resize::{Image, PixelType, ResizeAlg, Resizer};
use std::collections::HashMap;
use std::num::NonZeroU32;

pub struct CpuCompositor {
    width: u32,
    height: u32,
    canvas: Vec<u8>,
    resizer: Resizer,
    /// scale cache: (bitmap ptr identity, dest w, dest h, crop bits) → scaled
    cache: HashMap<(u64, u32, u32, (u32, u32, u32, u32)), Vec<u8>>,
}

impl CpuCompositor {
    pub fn new(width: u32, height: u32) -> Self {
        CpuCompositor {
            width,
            height,
            canvas: vec![0; (width as usize) * (height as usize) * 4],
            resizer: Resizer::new(ResizeAlg::Convolution(FilterType::Bilinear)),
            cache: HashMap::new(),
        }
    }

    fn scale_layer(&mut self, layer: &Layer, dw: u32, dh: u32) -> Vec<u8> {
        let crop_bits = (
            layer.crop.0.to_bits(),
            layer.crop.1.to_bits(),
            layer.crop.2.to_bits(),
            layer.crop.3.to_bits(),
        );
        let key = (layer.bitmap.id, dw, dh, crop_bits);
        if let Some(v) = self.cache.get(&key) {
            return v.clone();
        }
        // extract the crop window (or the full bitmap) then resize.
        let bmp = &layer.bitmap;
        let (cx, cy, cw, ch) = layer.crop;
        let full = (cx, cy, cw, ch) == (0.0, 0.0, 1.0, 1.0);
        let (src, sw, sh): (Vec<u8>, u32, u32) = if full {
            ((*bmp.data).clone(), bmp.w.max(1), bmp.h.max(1))
        } else {
            crop_rgba(&bmp.data, bmp.w, bmp.h, cx, cy, cw, ch)
        };
        let dst: Vec<u8>;
        if sw == dw && sh == dh {
            dst = src;
        } else {
            let nw = NonZeroU32::new(sw).unwrap_or(NonZeroU32::MIN);
            let nh = NonZeroU32::new(sh).unwrap_or(NonZeroU32::MIN);
            let dww = NonZeroU32::new(dw).unwrap_or(NonZeroU32::MIN);
            let dhh = NonZeroU32::new(dh).unwrap_or(NonZeroU32::MIN);
            let via_fir = match (
                Image::from_vec_u8(nw, nh, src.clone(), PixelType::U8x4),
                Image::from_vec_u8(dww, dhh, vec![0u8; dw as usize * dh as usize * 4], PixelType::U8x4),
            ) {
                (Ok(src_img), Ok(mut dst_img)) => {
                    let _ = self.resizer.resize(&src_img.view(), &mut dst_img.view_mut());
                    Some(dst_img.into_vec())
                }
                _ => None,
            };
            dst = via_fir.unwrap_or_else(|| nearest_scale(&src, sw, sh, dw, dh));
        }
        if self.cache.len() > 12 {
            self.cache.clear();
        }
        self.cache.entry(key).or_insert(dst).clone()
    }

    fn blit(&mut self, rgba: &[u8], dw: u32, dh: u32, dx: i64, dy: i64, alpha: f32, chroma: Option<(f32, f32, f32)>, sim: f32, smooth: f32) {
        let cw = self.width as i64;
        let chh = self.height as i64;
        let x0 = dx.max(0);
        let y0 = dy.max(0);
        let x1 = (dx + dw as i64).min(cw);
        let y1 = (dy + dh as i64).min(chh);
        if x1 <= x0 || y1 <= y0 {
            return;
        }
        let sx_step = dw as f64 / (dw as i64).max(1) as f64;
        let sy_step = dh as f64 / (dh as i64).max(1) as f64;
        let canvas = &mut self.canvas;
        let cw_us = self.width as usize;
        for py in y0..y1 {
            let syy = ((py - dy) as f64 * sy_step) as usize;
            let syy = syy.min(dh as usize - 1);
            for px in x0..x1 {
                let sxx = ((px - dx) as f64 * sx_step) as usize;
                let sxx = sxx.min(dw as usize - 1);
                let s = ((syy * dw as usize) + sxx) * 4;
                let d = ((py as usize) * cw_us) + px as usize;
                let d = d * 4;
                let sa = rgba[s + 3] as f32 / 255.0;
                if sa <= 0.0 {
                    continue;
                }
                let a = if let Some(key) = chroma {
                    let r = rgba[s] as f32 / 255.0;
                    let g = rgba[s + 1] as f32 / 255.0;
                    let b = rgba[s + 2] as f32 / 255.0;
                    chroma_alpha(r, g, b, sa, key, sim, smooth)
                } else {
                    sa
                } * alpha;
                if a <= 0.0 {
                    continue;
                }
                if a >= 1.0 {
                    canvas[d] = rgba[s];
                    canvas[d + 1] = rgba[s + 1];
                    canvas[d + 2] = rgba[s + 2];
                    canvas[d + 3] = 255;
                } else {
                    let inv = 1.0 - a;
                    canvas[d] = (rgba[s] as f32 * a + canvas[d] as f32 * inv) as u8;
                    canvas[d + 1] = (rgba[s + 1] as f32 * a + canvas[d + 1] as f32 * inv) as u8;
                    canvas[d + 2] = (rgba[s + 2] as f32 * a + canvas[d + 2] as f32 * inv) as u8;
                    canvas[d + 3] = (255.0 * (a + (canvas[d + 3] as f32 / 255.0) * inv)) as u8;
                }
            }
        }
    }
}

fn crop_rgba(src: &[u8], w: u32, h: u32, cx: f32, cy: f32, cw: f32, ch: f32) -> (Vec<u8>, u32, u32) {
    let x0 = (cx * w as f32).round().clamp(0.0, w as f32) as u32;
    let y0 = (cy * h as f32).round().clamp(0.0, h as f32) as u32;
    let x1 = ((cx + cw) * w as f32).round().clamp(0.0, w as f32) as u32;
    let y1 = ((cy + ch) * h as f32).round().clamp(0.0, h as f32) as u32;
    let cw = (x1 - x0).max(1);
    let chh = (y1 - y0).max(1);
    let mut out = Vec::with_capacity(cw as usize * chh as usize * 4);
    for y in y0..y1 {
        let row = y as usize * w as usize * 4 + x0 as usize * 4;
        out.extend_from_slice(&src[row..row + cw as usize * 4]);
    }
    (out, cw, chh)
}

impl Compositor for CpuCompositor {
    fn name(&self) -> &'static str {
        "rust-cpu"
    }

    fn render_frame(
        &mut self,
        layers: &[Layer],
        texts: &[TextLayer],
        background: [u8; 4],
        _width: u32,
        _height: u32,
    ) -> Result<(), String> {
        // reset canvas to background
        let bg = background;
        for px in self.canvas.chunks_exact_mut(4) {
            px.copy_from_slice(&bg);
        }
        for layer in layers {
            let dw = ((layer.dest.2 * self.width as f32).round().max(1.0)) as u32;
            let dh = ((layer.dest.3 * self.height as f32).round().max(1.0)) as u32;
            let dx = (layer.dest.0 * self.width as f32).round() as i64;
            let dy = (layer.dest.1 * self.height as f32).round() as i64;
            let chroma = layer.chroma.as_ref().map(|c| {
                let rgb = crate::compositor::parse_hex_color(&c.color);
                let (r, g, b) = (rgb[0] as f32 / 255.0, rgb[1] as f32 / 255.0, rgb[2] as f32 / 255.0);
                rgb_to_yuv601(r, g, b)
            });
            let (sim, smooth) = layer
                .chroma
                .as_ref()
                .map(|c| (c.similarity.clamp(0.0, 1.0), c.smoothness.clamp(0.0, 1.0)))
                .unwrap_or((0.0, 0.0));
            let alpha = layer.alpha.clamp(0.0, 1.0);
            let scaled = self.scale_layer(layer, dw, dh);
            self.blit(&scaled, dw, dh, dx, dy, alpha, chroma, sim as f32, smooth as f32);
        }
        for t in texts {
            let (dx, dy, dw, dh) = (t.dest_px.0 as i64, t.dest_px.1 as i64, t.dest_px.2, t.dest_px.3);
            self.blit(&t.bitmap.data, dw, dh, dx, dy, t.alpha.clamp(0.0, 1.0), None, 0.0, 0.0);
        }
        Ok(())
    }

    fn output_format(&self) -> OutputFormat {
        OutputFormat::Rgba
    }

    fn output(&self) -> &[u8] {
        &self.canvas
    }
}



/// Fallback nearest-neighbor RGBA scale (when fast_image_resize rejects the
/// buffer alignment).
fn nearest_scale(src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Vec<u8> {
    let mut out = vec![0u8; dw as usize * dh as usize * 4];
    for y in 0..dh as usize {
        let sy = (y * sh as usize / dh.max(1) as usize).min(sh.saturating_sub(1) as usize);
        for x in 0..dw as usize {
            let sx = (x * sw as usize / dw.max(1) as usize).min(sw.saturating_sub(1) as usize);
            let s = (sy * sw as usize + sx) * 4;
            let d = (y * dw as usize + x) * 4;
            out[d] = src[s];
            out[d + 1] = src[s + 1];
            out[d + 2] = src[s + 2];
            out[d + 3] = src[s + 3];
        }
    }
    out
}
