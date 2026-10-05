//! CPU rasterizer compositor — the always-works fallback path.
//!
//! Scales each layer bitmap (crop window → dest rect) with
//! `fast_image_resize` (SIMD), then alpha-blends into an RGBA canvas with
//! optional chroma key. Static image layers hit the scale cache; video
//! frames (fresh Arc pointers each frame) resize per frame.

use super::{chroma_alpha, rgb_to_yuv601, Compositor, Layer, OutputFormat, TextLayer};
use fast_image_resize::FilterType;
use fast_image_resize::{ImageView, ImageViewMut, ResizeAlg, Resizer};
use std::collections::HashMap;
use std::num::NonZeroU32;
use std::sync::Arc;

/// v2.1 scale-cache caps. Entries are `Arc<Vec<u8>>` (refcounted scaled
/// bitmaps), so eviction is a single-entry LRU pop — never a clear-all wipe
/// (the wipe let per-frame VIDEO entries (fresh ids) evict the static
/// image/text entries every ~12 frames → resize thrash). A byte budget on
/// top bounds one-shot VIDEO entries (fresh id per frame) to a fixed
/// memory footprint instead of a fixed entry count.
const SCALE_CACHE_CAP: usize = 32;
const SCALE_CACHE_BUDGET: usize = 64 * 1024 * 1024;

type CacheKey = (u64, u32, u32, (u32, u32, u32, u32));

pub struct CpuCompositor {
    width: u32,
    height: u32,
    canvas: Vec<u8>,
    resizer: Resizer,
    /// scale cache: (bitmap id, dest w, dest h, crop bits) → scaled pixels.
    /// v2.1: values are `Arc` — a cache hit is a refcount bump, NOT the
    /// multi-megabyte deep clone it used to be.
    cache: HashMap<CacheKey, Arc<Vec<u8>>>,
    /// LRU order (oldest first) for single-entry eviction.
    lru: Vec<CacheKey>,
    /// Total bytes pinned by the cache (bounded by SCALE_CACHE_BUDGET).
    cached_bytes: usize,
}

impl CpuCompositor {
    pub fn new(width: u32, height: u32) -> Self {
        CpuCompositor {
            width,
            height,
            canvas: vec![0; (width as usize) * (height as usize) * 4],
            resizer: Resizer::new(ResizeAlg::Convolution(FilterType::Bilinear)),
            cache: HashMap::new(),
            lru: Vec::new(),
            cached_bytes: 0,
        }
    }

    /// Scaled source pixels for one layer (dest-sized), from the cache or
    /// computed fresh. v2.1 memory model: the returned `Arc` shares the
    /// cached buffer — blitting borrows the Arc, not `self.cache`, so no
    /// defensive deep copies are needed anywhere.
    fn scale_layer(&mut self, layer: &Layer, dw: u32, dh: u32) -> Arc<Vec<u8>> {
        let crop_bits = (
            layer.crop.0.to_bits(),
            layer.crop.1.to_bits(),
            layer.crop.2.to_bits(),
            layer.crop.3.to_bits(),
        );
        let key: CacheKey = (layer.bitmap.id, dw, dh, crop_bits);
        if let Some(v) = self.cache.get(&key) {
            let out = Arc::clone(v);
            self.lru_touch(&key);
            return out;
        }
        // extract the crop window (or the full bitmap) then resize.
        let bmp = &layer.bitmap;
        let (cx, cy, cw, ch) = layer.crop;
        let full = (cx, cy, cw, ch) == (0.0, 0.0, 1.0, 1.0);
        let (mut sw, mut sh) = (bmp.w.max(1), bmp.h.max(1));
        // No crop, no scale: the source pixels ARE the result — zero copies.
        if full && sw == dw && sh == dh {
            let out = Arc::clone(&bmp.data);
            self.cache_insert(key, Arc::clone(&out));
            return out;
        }
        // Cropped (and possibly scaled): materialize the crop window once.
        // v2.1 FIX: the CROPPED dims become the source dims for the resize —
        // v2.0 returned (pixels, cw, ch) from crop_rgba and resized with
        // those; keeping the full-frame dims here made the resize read the
        // smaller cropped buffer with full-frame geometry (OOB panic /
        // misaligned pixels on every cropped+resized layer, e.g. Ken Burns).
        let cropped: Option<Vec<u8>> = if full { None } else {
            let (v, c_w, c_h) = crop_rgba(&bmp.data, bmp.w, bmp.h, cx, cy, cw, ch);
            sw = c_w;
            sh = c_h;
            Some(v)
        };
        let dst: Arc<Vec<u8>> = if sw == dw && sh == dh {
            match cropped {
                Some(v) => Arc::new(v),
                None => Arc::clone(&bmp.data), // unreachable (handled above)
            }
        } else {
            // Resize from a BORROWED source view — the v2.0 code deep-cloned
            // the full source bitmap before every resize (plus once more
            // for the cache), which was several MB per layer per frame.
            let src: &[u8] = cropped.as_deref().unwrap_or(&bmp.data);
            let resized = resize_borrowed(&mut self.resizer, src, sw, sh, dw, dh)
                .unwrap_or_else(|| nearest_scale(src, sw, sh, dw, dh));
            Arc::new(resized)
        };
        self.cache_insert(key, Arc::clone(&dst));
        dst
    }

    fn cache_insert(&mut self, key: CacheKey, v: Arc<Vec<u8>>) {
        self.cached_bytes += v.len();
        self.cache.insert(key, v);
        self.lru.push(key);
        while self.cache.len() > SCALE_CACHE_CAP || self.cached_bytes > SCALE_CACHE_BUDGET {
            match self.lru.first().copied() {
                Some(k) => {
                    self.lru.remove(0);
                    if let Some(v) = self.cache.remove(&k) {
                        self.cached_bytes -= v.len();
                    }
                }
                None => break,
            }
        }
    }

    fn lru_touch(&mut self, key: &CacheKey) {
        if let Some(pos) = self.lru.iter().position(|k| k == key) {
            let last = self.lru.remove(pos);
            self.lru.push(last);
        }
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

/// Bilinear resize from a BORROWED RGBA source slice into a fresh dest
/// buffer (fast_image_resize over an `ImageView` — zero source copies).
/// Returns None when the buffers/views are rejected (caller falls back to
/// nearest-neighbor).
fn resize_borrowed(resizer: &mut Resizer, src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Option<Vec<u8>> {
    use fast_image_resize::pixels::U8x4;
    let nw = NonZeroU32::new(sw)?;
    let nh = NonZeroU32::new(sh)?;
    let dww = NonZeroU32::new(dw)?;
    let dhh = NonZeroU32::new(dh)?;
    let src_img = ImageView::<U8x4>::from_buffer(nw, nh, src).ok()?;
    let mut dst_buf = vec![0u8; dw as usize * dh as usize * 4];
    {
        let dst_img = ImageViewMut::<U8x4>::from_buffer(dww, dhh, &mut dst_buf).ok()?;
        resizer.resize(&src_img.into(), &mut dst_img.into()).ok()?;
    }
    Some(dst_buf)
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
            // v1.20 CAPTIONS: text strips may be SCALED (animated words,
            // 1×1 solid fills for bg boxes). The blit path indexes the
            // source by dest dims — pre-scale when they differ.
            if t.bitmap.w == dw && t.bitmap.h == dh {
                self.blit(&t.bitmap.data, dw, dh, dx, dy, t.alpha.clamp(0.0, 1.0), None, 0.0, 0.0);
            } else {
                let scaled = scale_text_strip(&mut self.resizer, &t.bitmap.data, t.bitmap.w, t.bitmap.h, dw, dh);
                self.blit(&scaled, dw, dh, dx, dy, t.alpha.clamp(0.0, 1.0), None, 0.0, 0.0);
            }
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
    // 1×1 solid fills (caption bg boxes) — straight memset-style fill.
    if sw == 1 && sh == 1 {
        let mut out = vec![0u8; dw as usize * dh as usize * 4];
        for px in out.chunks_exact_mut(4) {
            px.copy_from_slice(&src[0..4]);
        }
        return out;
    }
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

/// Scale an RGBA text strip to (dw, dh) — bilinear via fast_image_resize
/// over BORROWED buffers (the v2.0 path deep-copied the strip per word per
/// frame), nearest (or solid fill) otherwise. Used by the v1.20 caption text
/// path (animated word scaling + bg-box fills).
fn scale_text_strip(resizer: &mut Resizer, src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Vec<u8> {
    if sw == 0 || sh == 0 || dw == 0 || dh == 0 {
        return Vec::new();
    }
    if sw == dw && sh == dh {
        return src.to_vec();
    }
    if let Some(v) = resize_borrowed(resizer, src, sw, sh, dw, dh) {
        return v;
    }
    nearest_scale(src, sw, sh, dw, dh)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compositor::{Bitmap, Compositor, Layer};

    /// v2.1 regression lock: a CROPPED layer that also needs a RESIZE (Ken
    /// Burns, cover-crop overlays). The buggy v2.1 draft resized the cropped
    /// buffer with FULL-FRAME geometry (OOB panic / misaligned pixels); the
    /// cropped dims must be the resize source dims (v2.0 semantics).
    #[test]
    fn crop_then_resize_uses_cropped_dims() {
        // 64x32: left half solid red, right half solid blue.
        let (w, h) = (64u32, 32u32);
        let mut data = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let d = ((y * w + x) * 4) as usize;
                let red = x < w / 2;
                data[d] = if red { 255 } else { 40 };
                data[d + 1] = 0;
                data[d + 2] = if red { 0 } else { 255 };
                data[d + 3] = 255;
            }
        }
        let bmp = Bitmap::new(data, w, h);
        // compositor 64x32; crop = left half (32x32), dest 32x16 → resize
        // 32x32 → 32x16 through the crop+scale path.
        let layer = Layer {
            bitmap: bmp,
            crop: (0.0, 0.0, 0.5, 1.0),
            dest: (0.0, 0.0, 0.5, 0.5),
            alpha: 1.0,
            chroma: None,
            dynamic: false,
        };
        let mut c = CpuCompositor::new(64, 32);
        c.render_frame(&[layer], &[], [0, 0, 0, 255], 64, 32)
            .expect("crop+resize layer must not panic");
        let out = c.output();
        let mut red = 0usize;
        let mut other = 0usize;
        // dest rect = rows 0..16, cols 0..32 on the 64x32 canvas
        for row in 0..16usize {
            for col in 0..32usize {
                let px = &out[(row * 64 + col) * 4..][..4];
                if px[0] > 200 && px[2] < 60 { red += 1; } else { other += 1; }
            }
        }
        assert_eq!(other, 0, "all 512 dest px must be red-ish, {} were not", other);
        assert_eq!(red, 32 * 16, "dest rect should be fully red: {}", red);

        // crop → SAME dims (no resize): cropped pixels pass through.
        let (w2, h2) = (64u32, 32u32);
        let bmp2 = Bitmap::new((0..(w2 * h2) as usize).flat_map(|_| vec![10u8, 200, 30, 255]).collect(), w2, h2);
        let layer2 = Layer {
            bitmap: bmp2,
            crop: (0.0, 0.0, 0.5, 1.0),
            dest: (0.0, 0.0, 0.5, 1.0),
            alpha: 1.0,
            chroma: None,
            dynamic: true,
        };
        let mut c2 = CpuCompositor::new(64, 32);
        c2.render_frame(&[layer2], &[], [0, 0, 0, 255], 64, 32).unwrap();
        let out2 = c2.output();
        // right half must stay background black (crop took the left half only)
        assert_eq!(&out2[(31 * 64 + 40) * 4..][..3], &[0, 0, 0], "right half must be untouched");
        let p = &out2[(16 * 64 + 16) * 4..][..3];
        assert!(p[1] > 150, "left half should be green-ish, got {:?}", p);

        // full-frame, no crop, SAME dims → zero-copy path (dynamic source)
        let (w3, h3) = (32u32, 16u32);
        let bmp3 = Bitmap::new((0..(w3 * h3) as usize).flat_map(|_| vec![255u8, 255, 0, 255]).collect(), w3, h3);
        let layer3 = Layer {
            bitmap: bmp3,
            crop: (0.0, 0.0, 1.0, 1.0),
            dest: (0.0, 0.0, 0.5, 0.5),
            alpha: 1.0,
            chroma: None,
            dynamic: true,
        };
        let mut c3 = CpuCompositor::new(64, 32);
        c3.render_frame(&[layer3], &[], [0, 0, 0, 255], 64, 32).unwrap();
        let out3 = c3.output();
        let p3 = &out3[(8 * 64 + 16) * 4..][..3];
        assert!(p3[0] > 200 && p3[1] > 200, "full/no-scale layer should be yellow, got {:?}", p3);
    }
}
