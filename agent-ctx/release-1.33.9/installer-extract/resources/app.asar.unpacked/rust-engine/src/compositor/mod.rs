//! Compositor — DIRECTIVE 4: trait-based renderer with wgpu GPU first and
//! an instant CPU fallback. Both implementations consume the SAME layer
//! list so preview parity is architectural, not aspirational.

pub mod cpu;
#[cfg(feature = "gpu")]
pub mod gpu;

use crate::timeline::{ChromaKey, Timeline};
use std::sync::Arc;

/// The byte layout the compositor emits for each rendered frame.
///
/// v2 pipeline: the GPU compositor converts RGBA → planar YUV ON THE GPU
/// (compute shader, BT.601 limited-range — the same matrix sws_scale
/// defaults to) and reads back 1.5 bytes/pixel instead of 4, which the
/// encoder consumes with a plain per-plane memcpy (no CPU sws pass at
/// all). The CPU rasterizer keeps emitting RGBA (sws handles the
/// conversion on that path — it is already on the CPU).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputFormat {
    Rgba,
    /// Planar YUV 4:2:0 (BT.601 limited): Y plane (w×h), then U (w/2×h/2),
    /// then V — rows padded to a 4-byte stride (tail bytes ignored).
    Yuv420p,
    /// NV12 (BT.601 limited): Y plane, then interleaved UV. Rows padded to
    /// a 4-byte stride.
    Nv12,
}

/// Which YUV packing the GPU compute pass should emit — chosen by the
/// encoder that actually opened (QSV/AMF/MF want NV12; NVENC/x264 want
/// YUV420P).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum YuvMode {
    Yuv420p,
    Nv12,
}

/// An RGBA8 source bitmap (decoded video frame or image) at native size.
///
/// `id` is a monotonically-increasing content identity: caches (CPU scale
/// cache, GPU texture cache) key on it because HEAP ADDRESSES are recycled
/// by the allocator once the previous frame's Arc drops — keying by
/// address made every decoded frame alias the first one.
#[derive(Clone)]
pub struct Bitmap {
    pub data: Arc<Vec<u8>>,
    pub w: u32,
    pub h: u32,
    pub id: u64,
}

static NEXT_BITMAP_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

impl Bitmap {
    pub fn new(data: Vec<u8>, w: u32, h: u32) -> Self {
        Bitmap {
            data: Arc::new(data),
            w,
            h,
            id: NEXT_BITMAP_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        }
    }

    /// v2.1: wrap an ALREADY-OWNED shared buffer (e.g. recycled out of the
    /// producer's RGBA pool) — same fresh-id semantics as `new`, zero copy.
    pub fn from_shared(data: Arc<Vec<u8>>, w: u32, h: u32) -> Self {
        Bitmap {
            data,
            w,
            h,
            id: NEXT_BITMAP_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        }
    }
}

/// One draw call: bitmap → (crop window) → (dest rect) with alpha/chroma.
#[derive(Clone)]
pub struct Layer {
    pub bitmap: Bitmap,
    /// Normalized source crop window (x, y, w, h) — Ken Burns zoom.
    pub crop: (f32, f32, f32, f32),
    /// Normalized destination rect on the output canvas.
    pub dest: (f32, f32, f32, f32),
    /// Multiply alpha (fade / overlay opacity).
    pub alpha: f32,
    /// Chroma key applied before alpha blend. v2.1: Arc — the key is
    /// immutable per segment, so per-frame layer building is a refcount
    /// bump instead of a `ChromaKey { color: String }` deep clone.
    pub chroma: Option<Arc<ChromaKey>>,
    /// v2: true for VIDEO-layer content (a fresh Bitmap id per decoded
    /// frame) — the GPU compositor uploads these through a pooled slot
    /// instead of the static LRU texture cache. Images/texts stay false.
    #[allow(clippy::clone_on_copy)]
    pub dynamic: bool,
}

/// A text strip produced by `text.rs` — rasterized once, blitted per frame.
#[derive(Clone)]
pub struct TextLayer {
    pub bitmap: Bitmap,
    /// PIXEL destination rect on the output canvas.
    pub dest_px: (u32, u32, u32, u32),
    pub alpha: f32,
}

pub trait Compositor: Send {
    fn name(&self) -> &'static str;
    /// GPU adapter description when the hardware path engaged.
    fn adapter_name(&self) -> Option<String> {
        None
    }
    /// Render one output frame. `layers` are ordered back-to-front.
    fn render_frame(
        &mut self,
        layers: &[Layer],
        texts: &[TextLayer],
        background: [u8; 4],
        width: u32,
        height: u32,
    ) -> Result<(), String>;
    /// The composited frame, borrowed (the buffer is reused across frames —
    /// no per-frame allocation or ownership juggling).
    fn output_format(&self) -> OutputFormat;
    fn output(&self) -> &[u8];
    /// Packed-YUV plane geometry the consumer must respect: (y_stride,
    /// c_stride) in BYTES. Only meaningful when output_format() is
    /// Yuv420p/Nv12 — consumers memcpy `width` real bytes per row and skip
    /// the padding tail.
    fn yuv_strides(&self) -> (usize, usize) {
        (0, 0)
    }
}

/// Factory: GPU first, CPU fallback (DIRECTIVE 4). A wgpu adapter failure
/// (missing driver, TDR'd device, headless sandbox) must degrade, never
/// crash — the export continues at CPU raster speed.
pub fn create_compositor(width: u32, height: u32, yuv: YuvMode) -> Box<dyn Compositor> {
    #[cfg(feature = "gpu")]
    {
        match gpu::GpuCompositor::new(width, height, yuv) {
            Ok(gpu) => {
                log::info!(
                    "[rust-engine] wGPU compositor initialized ({}) — hardware accelerated, GPU YUV {}",
                    gpu.adapter_info(),
                    if yuv == YuvMode::Nv12 { "NV12" } else { "YUV420P" }
                );
                Box::new(gpu)
            }
            Err(e) => {
                log::warn!("[rust-engine] wGPU compositor unavailable ({}), using the CPU rasterizer", e);
                Box::new(cpu::CpuCompositor::new(width, height))
            }
        }
    }
    #[cfg(not(feature = "gpu"))]
    {
        let _ = yuv;
        log::info!("[rust-engine] CPU rasterizer (compiled without wgpu feature)");
        Box::new(cpu::CpuCompositor::new(width, height))
    }
}

/// Shared chroma-key math (BT.601 YUV distance) — used by BOTH the CPU and
/// GPU paths so their output matches. `similarity`/`smoothness` are 0..1.
#[inline]
pub fn rgb_to_yuv601(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let y = 0.299 * r + 0.587 * g + 0.114 * b;
    let u = -0.147 * r - 0.289 * g + 0.436 * b;
    let v = 0.615 * r - 0.515 * g - 0.100 * b;
    (y, u, v)
}

#[inline]
pub fn chroma_alpha(
    r: f32,
    g: f32,
    b: f32,
    a: f32,
    key: (f32, f32, f32),
    similarity: f32,
    smoothness: f32,
) -> f32 {
    let (py, pu, pv) = rgb_to_yuv601(r, g, b);
    let dy = py - key.0;
    let du = pu - key.1;
    let dv = pv - key.2;
    let d = (dy * dy + du * du + dv * dv).sqrt();
    let thresh = similarity * 0.7;
    let soft = if smoothness > 0.001 { smoothness * 0.7 } else { 0.001 };
    let k = ((d - thresh) / soft).clamp(0.0, 1.0);
    a * k
}

/// Parse "#rrggbb" / "#rrggbbaa" into RGBA bytes.
pub fn parse_hex_color(s: &str) -> [u8; 4] {
    let h = s.trim_start_matches('#');
    let v = |i: usize| u32::from_str_radix(&h[i..i + 2], 16).unwrap_or(255) as u8;
    if h.len() >= 6 {
        let a = if h.len() >= 8 { v(6) } else { 255 };
        [v(0), v(2), v(4), a]
    } else {
        [0, 0, 0, 255]
    }
}

/// Timeline-referenced font resolution helper.
#[allow(dead_code)]
pub fn font_path(timeline: &Timeline, key: &str) -> Option<String> {
    timeline.fonts.get(key).cloned().filter(|p| !p.is_empty())
}
