//! Export pipeline v2 — "full potential" architecture.
//!
//! STAGE PIPELINE (the wall clock is max(stage), not sum(stage)):
//!   [producer thread]  decode-ahead: video decode (threaded avcodec) +
//!                      RGBA convert + layer building (incl. the native
//!                      transition plan)  ──sync_channel(8)──▶
//!   [consumer thread]  wgpu composite (ONE submit/frame) → GPU YUV →
//!                      plane memcpy → avcodec encode → mux.
//!   [audio thread]     all audio decode + mixdown runs IN PARALLEL with
//!                      the video loop; the consumer joins it at the audio
//!                      phase and feeds the AAC encoder.
//!
//! Encoder fixes vs v1:
//!   * per-encoder pixel format — QSV/AMF/MF get NV12 (QSV can ONLY open
//!     NV12: the v1 code asked every tier for YUV420P, so Intel machines
//!     silently fell back to single-threaded libx264),
//!   * libx264 primary gets thread_count=auto + FRAME|SLICE (v1 never set
//!     threads on the primary encoder — it ran single-threaded),
//!   * NVENC keeps its async delay (v1's delay=0 forced synchronous
//!     packet-per-frame and killed NVENC pipelining),
//!   * preset ladders per tier follow NVIDIA/AMD/Intel guidance.
//!
//! Muxer: movflags +faststart (moov at the front, instant seeking).

use crate::audio::{self, PcmBuffer, Track};
use crate::compositor::{self, Bitmap, Compositor, Layer, OutputFormat, TextLayer, YuvMode};
use crate::captions::{self, PreparedCaptions};
use crate::ffmpeg_ffi::*;
use crate::ffi_offsets::*;
use crate::kinetic::{self, PreparedKinetic};
use crate::text::TextRenderer;
use crate::timeline::{ChromaKey, Segment, Timeline};
use rayon::prelude::*;
use std::ffi::CString;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// Progress event pushed through the ThreadsafeFunction (adapted in lib.rs).
#[derive(Clone, Debug)]
pub struct ProgressEvent {
    pub phase: String,     // prepare | video | audio | mux
    pub percent: f64,      // 0..100
    pub fps: f64,          // encode fps (informational)
    pub timemark_sec: f64, // content position
}
pub type ProgressSink = Arc<dyn Fn(ProgressEvent) + Send + Sync>;

pub struct ExportOutcome {
    pub engine_used: String,
    pub encoder_name: String,
    pub frames: u64,
    pub duration_ms: i64,
    pub compositor_ms: i64,
    pub encode_ms: i64,
    pub decode_ms: i64,
    pub audio_ms: i64,
    pub size_bytes: u64,
    pub adapter: Option<String>,
}

// ── sws guard (sws_freeContext takes the pointer directly) ────────────────

struct SwsGuard {
    raw: *mut u8,
    free: unsafe extern "C" fn(*mut u8),
}
unsafe impl Send for SwsGuard {}
impl SwsGuard {
    fn ptr(&self) -> *mut u8 {
        self.raw
    }
}
impl Drop for SwsGuard {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            unsafe { (self.free)(self.raw) };
        }
    }
}

// ── v2.1 RGBA buffer pool ──────────────────────────────────────────────────
// The producer converts every decoded video frame to a full-frame RGBA
// `Bitmap` (4 B/px — 8.3 MB at 1080p). v2.0 allocated a fresh zeroed Vec
// per frame and freed it on the consumer side: on Windows/MSVC the CRT
// serves 8 MB blocks via VirtualAlloc, so every frame paid commit +
// first-touch page faults + decommit. The pool hands the SAME buffers
// back: the consumer pushes the spent Arcs after a frame is fully
// rendered/encoded, the producer `Arc::try_unwrap`s one out and sws
// overwrites it in place. Alloc-free steady state, bounded by in-flight
// frames; any leftover reference simply falls back to a fresh allocation
// (never a correctness hazard).
#[derive(Default)]
pub(crate) struct RgbaPool {
    inner: Mutex<Vec<Arc<Vec<u8>>>>,
}

impl RgbaPool {
    /// Hard cap — deeper than the producer↔consumer in-flight window on
    /// purpose so a burst never evicts usable buffers.
    const CAP: usize = 16;

    fn take(&self, len: usize) -> Vec<u8> {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        while let Some(arc) = guard.pop() {
            // Only unwrap buffers nobody else references; entries that
            // still have clones (held-frame cache keeps one for a frame)
            // are simply discarded — the next pop may unwrap.
            if let Ok(mut v) = Arc::try_unwrap(arc) {
                if v.len() == len {
                    return v; // sws_scale overwrites every byte
                }
                // dimension change (rare): re-init once, still reusing the
                // allocation's capacity when it fits.
                v.clear();
                v.resize(len, 0);
                return v;
            }
        }
        vec![0u8; len]
    }

    fn put(&self, buf: Arc<Vec<u8>>) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if guard.len() < Self::CAP {
            guard.push(buf);
        }
    }
}

// FF_DEBUG_CAPTIONS is consulted PER FRAME — cache the env probe (a lock +
// allocation) behind a OnceLock instead of re-reading it 300+ times.
static CAPTIONS_DEBUG: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
fn captions_debug_enabled() -> bool {
    *CAPTIONS_DEBUG.get_or_init(|| std::env::var("FF_DEBUG_CAPTIONS").is_ok())
}

// ── video source decoder (LIVES ON THE PRODUCER THREAD) ───────────────────

pub struct VideoSource {
    ff: Arc<FFmpegLibs>,
    fc: PtrGuard,
    vstream: i32,
    dec: PtrGuard,
    frame: PtrGuard,
    pkt: PtrGuard,
    sws: Option<SwsGuard>,
    sws_key: (i32, i32, i32),
    /// v2.1: shared recycling pool for the RGBA output buffers (see RgbaPool).
    pool: Option<Arc<RgbaPool>>,
    /// v2.1 held-frame cache: when the timeline's output frame maps to the
    /// SAME decoded source frame as the previous call (frame-hold: source
    /// fps < output fps, speed < 1, EOF tail), the RGBA snapshot is reused
    /// as-is — skipping both the sws pass AND the GPU texture re-upload
    /// (same Bitmap id → dynamic-slot reuse). Keyed by (pts, w, h, fmt),
    /// invalidated on seek, bypassed for NOPTS frames.
    held: Option<Bitmap>,
    held_key: Option<(i64, i32, i32, i32)>,
    #[allow(dead_code)] // source topology — diagnostics + future smart render paths
    pub width: u32,
    #[allow(dead_code)]
    pub height: u32,
    #[allow(dead_code)]
    pub fps: f64,
    stream_tb: Rational,
    cur_src_t: f64,
    have_frame: bool,
    eof: bool,
    /// v0.3 LOOP-TO-FILL: the source length in seconds, pinned from the last
    /// decoded frame's pts at EOF — the authoritative span for the caller's
    /// modulo wrap when the payload's `sourceDurationMs` is absent (no
    /// AVFormatContext.duration offset needed — EOF is ground truth).
    measured_duration: f64,
}
/// The decoder + format contexts are created, used, and dropped by EXACTLY
/// one thread (the producer) — safe to move there at spawn time.
unsafe impl Send for VideoSource {}

impl VideoSource {
    pub fn new(ff: Arc<FFmpegLibs>, path: &str, pool: Option<Arc<RgbaPool>>) -> Result<Self, String> {
        let c_path = CString::new(path).map_err(|e| format!("bad path: {}", e))?;
        let mut fc: *mut u8 = std::ptr::null_mut();
        let r = unsafe {
            (ff.syms.avformat_open_input)(&mut fc, c_path.as_ptr(), std::ptr::null_mut(), std::ptr::null_mut())
        };
        if r < 0 || fc.is_null() {
            return Err(format!("open failed `{}`: {}", path, ff.err2str(r)));
        }
        let fc = PtrGuard::new(fc, ff.syms.avformat_close_input).map_err(|e| e)?;
        unsafe { (ff.syms.avformat_find_stream_info)(fc.raw, std::ptr::null_mut()) };
        let vstream = unsafe {
            (ff.syms.avformat_find_best_stream)(fc.raw, AVMEDIA_TYPE_VIDEO, -1, -1, std::ptr::null_mut(), 0)
        };
        if vstream < 0 {
            return Err(format!("no video stream in `{}`", path));
        }
        let st = ff.fmt_streams(fc.raw, vstream as usize);
        let par = ff.stream_codecpar(st);
        let codec_id = ff.par_codec_id(par);
        let codec = unsafe { (ff.syms.avcodec_find_decoder)(codec_id) };
        if codec.is_null() {
            return Err(format!("no decoder for codec id {}", codec_id));
        }
        let dec = unsafe { (ff.syms.avcodec_alloc_context3)(codec) };
        let dec = PtrGuard::new(dec, ff.syms.avcodec_free_context).map_err(|e| e)?;
        let r = unsafe { (ff.syms.avcodec_parameters_to_context)(dec.raw, par) };
        if r < 0 {
            return Err(format!("video parameters_to_context: {}", ff.err2str(r)));
        }
        ff.cc_set_threads_auto(dec.raw);
        let r = unsafe { (ff.syms.avcodec_open2)(dec.raw, codec, std::ptr::null_mut()) };
        if r < 0 {
            return Err(format!("video decoder open `{}`: {}", path, ff.err2str(r)));
        }
        let tb = ff.stream_time_base(st);
        let afr = unsafe { rd_rational(st, AVSTREAM_AVG_FRAME_RATE) };
        let fps = afr.as_f64();
        let src_w = ff.par_width(par).max(1) as u32;
        let src_h = ff.par_height(par).max(1) as u32;
        let frame = ff.frame_alloc()?;
        let pkt = ff.packet_alloc()?;
        // v0.3: container duration as the INITIAL hint (AVFormatContext
        // offset-derived: the PB/NB_STREAMS/STREAMS anchors pin the prefix,
        // filename[1024] then url/start_time → duration @ 1096). EOF pins the
        // authoritative value over this.
        let mut duration_hint = 0f64;
        unsafe {
            let d_us = ((fc.raw as *const u8).add(AVFMTCTX_DURATION) as *const i64).read_unaligned();
            if d_us > 0 {
                duration_hint = d_us as f64 / 1_000_000.0;
            }
        }
        Ok(VideoSource {
            ff,
            fc,
            vstream,
            dec,
            frame,
            pkt,
            sws: None,
            sws_key: (0, 0, 0),
            pool,
            held: None,
            held_key: None,
            width: src_w,
            height: src_h,
            fps: if fps.is_finite() && fps > 1.0 && fps < 240.0 { fps } else { 30.0 },
            stream_tb: if tb.den > 0 { tb } else { Rational::new(1, 30) },
            cur_src_t: -1.0,
            have_frame: false,
            eof: false,
            measured_duration: if duration_hint.is_finite() && duration_hint > 0.05 && duration_hint < 86400.0 { duration_hint } else { 0.0 },
        })
    }

    fn frame_pts_sec(&self) -> f64 {
        let pts = self.ff.frame_pts(self.frame.raw);
        if pts.is_negative() {
            return -1.0;
        }
        (pts as f64) * self.stream_tb.as_f64()
    }

    /// v0.3: the source length in seconds — the container hint until EOF
    /// pins the authoritative value (the last decoded frame's pts).
    pub fn duration(&self) -> f64 {
        self.measured_duration
    }

    fn decode_one(&mut self) -> Result<bool, String> {
        // returns true when a NEW frame is available in self.frame
        loop {
            let fr = unsafe { (self.ff.syms.avcodec_receive_frame)(self.dec.raw, self.frame.raw) };
            if fr == 0 {
                // v0.3.1 PHANTOM-FRAME GUARD: frame-threaded decoders emit a
                // DRAIN SENTINEL at EOF — receive_frame returns 0 with a
                // "frame" whose planes are NULL and w/h=0/1, format −1
                // (AV_PIX_FMT_NONE). Trusting it feeds sws_getContext an
                // invalid pix_fmt → av_pix_fmt_desc_get(NULL) → the Debian
                // assertion abort (release builds: UB). Skip and keep
                // decoding — a real frame (or EOF) follows.
                let d0 = unsafe { self.ff.frame_data(self.frame.raw, 0) };
                let fw = self.ff.frame_width(self.frame.raw);
                let ffmt = self.ff.frame_format(self.frame.raw);
                if d0.is_null() || fw <= 0 || ffmt < 0 {
                        self.ff.frame_unref(&self.frame);
                    continue;
                }
                self.have_frame = true;
                return Ok(true);
            }
            if fr == AVERROR_EAGAIN {
                // need more input
                loop {
                    let pr = unsafe { (self.ff.syms.av_read_frame)(self.fc.raw, self.pkt.raw) };
                    if pr == AVERROR_EOF {
                        // v0.3.1: the drain-NULL goes ONCE (a second
                        // send_packet(NULL) after the drain started resets
                        // frame-thread state and the decoder EAGAINs
                        // forever). After the one-shot: keep returning
                        // "no more input" — the drain frames are already
                        // flowing out of receive_frame.
                        if !self.eof {
                            let s = unsafe { (self.ff.syms.avcodec_send_packet)(self.dec.raw, std::ptr::null()) };
                            self.eof = true;
                            if s < 0 && s != AVERROR_EOF {
                                return Err(format!("decode flush: {}", self.ff.err2str(s)));
                            }
                            // frame-threaded decoders buffer up to
                            // thread_count frames AND send_packet(NULL)
                            // clears the output frame — the drain loop's
                            // receive_frame calls (phantom-guarded) return
                            // the remaining REAL frames and repopulate it.
                            continue;
                        }
                        return Ok(false);
                    }
                    if pr < 0 {
                        return Err(format!("read: {}", self.ff.err2str(pr)));
                    }
                    let idx = unsafe { rd_i32(self.pkt.raw, AVPACKET_STREAM_INDEX) };
                    if idx == self.vstream {
                        let s = unsafe { (self.ff.syms.avcodec_send_packet)(self.dec.raw, self.pkt.raw) };
                        self.ff.packet_unref(self.pkt.raw);
                        if s < 0 && s != AVERROR_EAGAIN {
                            return Err(format!("send_packet: {}", self.ff.err2str(s)));
                        }
                        break;
                    } else {
                        self.ff.packet_unref(self.pkt.raw);
                    }
                }
                continue;
            }
            if fr == AVERROR_EOF {
                self.eof = true;
                return Ok(false);
            }
            return Err(format!("receive_frame: {}", self.ff.err2str(fr)));
        }
    }

    /// Decode forward until the LATEST frame at/just-before `t` is current.
    /// Returns the RGBA bitmap snapshot for compositing. When the decode
    /// loop ends on the SAME source frame as the previous call, the cached
    /// snapshot is reused (byte-identical — the input frame is identical).
    pub fn ensure_frame(&mut self, t: f64) -> Result<Option<Bitmap>, String> {
        let cur_t = self.frame_pts_sec();
        // v0.3.1 LOOP-WRAP SEEK: after EOF the drain can leave the frame
        // CLEARED (pts NOPTS → cur_t −1) while cur_src_t still tracks the
        // last REAL decoded position — a loop wrap to an earlier t must
        // still seek backwards. Use the max of the two as the reference.
        let seek_ref = cur_t.max(self.cur_src_t);
        if self.cur_src_t < 0.0 || (t + 0.001) < seek_ref - 0.75 {
            // seek backwards (or first use): land slightly before the target
            let target = (t - 0.5).max(0.0);
            let ts = (target / self.stream_tb.as_f64()).round() as i64;
            let sr = unsafe {
                let r = (self.ff.syms.av_seek_frame)(self.fc.raw, self.vstream, ts, AVSEEK_FLAG_BACKWARD);
                (self.ff.syms.avcodec_flush_buffers)(self.dec.raw);
                r
            };
            self.have_frame = false;
            self.eof = false;
            self.cur_src_t = -1.0;
            self.held = None;
            self.held_key = None;
            self.ff.frame_unref(&self.frame);
        }
        // decode until the next frame's pts exceeds t (or EOF)
        loop {
            let cur_pts = self.frame_pts_sec();
            if self.have_frame && cur_pts >= 0.0 && cur_pts > t + 0.0005 && (cur_pts - t) < 1.5 {
                break; // current frame is already past t → hold
            }
            match self.decode_one() {
                Ok(true) => {
                    let pts = self.frame_pts_sec();
                    if pts >= 0.0 {
                        self.cur_src_t = pts;
                    }
                    if pts > t + 0.0005 && (pts - t) < 1.5 {
                        break;
                    }
                    // if the new frame is way past t (>1.5s), it's still the
                    // best we have (sparse fps or imprecise seek) → hold
                    if pts > t {
                        break;
                    }
                }
                Ok(false) => {
                    if self.eof {
                        break; // hold last frame
                    }
                }
                Err(e) => return Err(e),
            }
        }
        if !self.have_frame {
            return Ok(None);
        }
        // v0.3.1 CLEARED-FRAME GUARD: avcodec_send_packet(NULL) (the drain
        // start) and the drain tail can leave the output frame EMPTY
        // (planes NULL, w 0, format AV_PIX_FMT_NONE) while have_frame is
        // still true. Running to_rgba on that state feeds sws_getContext an
        // invalid pix_fmt (av_pix_fmt_desc_get → NULL → the Debian
        // av_assert0 abort; release builds: UB). The last REAL frame's
        // snapshot lives in the held cache — hold-last-frame semantics.
        {
            let fw = self.ff.frame_width(self.frame.raw);
            let ffmt = self.ff.frame_format(self.frame.raw);
            let fd0 = unsafe { self.ff.frame_data(self.frame.raw, 0) };
            if fd0.is_null() || fw <= 0 || ffmt < 0 {
                if let Some(b) = &self.held {
                    return Ok(Some(b.clone()));
                }
                return Ok(None);
            }
        }
        // v0.3 LOOP-TO-FILL: EOF pins the authoritative source length (the
        // last decoded frame's pts) — the caller's modulo wrap uses it when
        // the payload's sourceDurationMs (and the container hint) are
        // absent. Overwrites the container hint when they disagree (EOF
        // always wins — it is ground truth).
        if self.eof {
            let d = self.frame_pts_sec();
            if d > 0.05 && d > self.measured_duration {
                self.measured_duration = d;
            }
        }
        // v2.1 held-frame reuse: identical source frame → identical snapshot.
        let pts = self.ff.frame_pts(self.frame.raw);
        let key = (
            pts,
            self.ff.frame_width(self.frame.raw),
            self.ff.frame_height(self.frame.raw),
            self.ff.frame_format(self.frame.raw),
        );
        if pts >= 0 && self.held_key == Some(key) {
            if let Some(b) = &self.held {
                return Ok(Some(b.clone()));
            }
        }
        let bmp = self.to_rgba()?;
        if pts >= 0 {
            self.held = Some(bmp.clone());
            self.held_key = Some(key);
        } else {
            // NOPTS frames cannot be keyed safely — never cache them.
            self.held = None;
            self.held_key = None;
        }
        Ok(Some(bmp))
    }

    fn to_rgba(&mut self) -> Result<Bitmap, String> {
        let w = self.ff.frame_width(self.frame.raw).max(1);
        let h = self.ff.frame_height(self.frame.raw).max(1);
        let fmt = self.ff.frame_format(self.frame.raw);
        let key = (w, h, fmt);
        if self.sws.is_none() || self.sws_key != key {
            self.sws = None;
            let ctx = unsafe {
                (self.ff.syms.sws_getContext)(
                    w,
                    h,
                    fmt,
                    w,
                    h,
                    AV_PIX_FMT_RGBA,
                    SWS_BILINEAR,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                )
            };
            if ctx.is_null() {
                return Err("sws_getContext(RGBA) failed".into());
            }
            self.sws = Some(SwsGuard { raw: ctx, free: self.ff.syms.sws_freeContext });
            self.sws_key = key;
        }
        let n = w as usize * h as usize * 4;
        // v2.1: recycled pool buffer (or a fresh one the first frames). The
        // Arc is brand new here → exclusive &mut access is guaranteed.
        let mut data: Arc<Vec<u8>> = match &self.pool {
            Some(p) => Arc::new(p.take(n)),
            None => Arc::new(vec![0u8; n]),
        };
        let out = Arc::get_mut(&mut data).expect("fresh Arc is exclusively owned");
        let frame = self.frame.raw;
        unsafe {
            let mut src_planes: [*const u8; 8] = [std::ptr::null(); 8];
            let mut src_strides: [i32; 8] = [0; 8];
            for i in 0..8 {
                src_planes[i] = self.ff.frame_data(frame, i) as *const u8;
                src_strides[i] = self.ff.frame_linesize(frame, i);
            }
            let mut dst_planes: [*mut u8; 1] = [out.as_mut_ptr()];
            let dst_strides: [i32; 1] = [w * 4];
            let r = (self.ff.syms.sws_scale)(
                self.sws.as_ref().unwrap().ptr(),
                src_planes.as_ptr(),
                src_strides.as_ptr(),
                0,
                h,
                dst_planes.as_mut_ptr() as *const *mut u8,
                dst_strides.as_ptr(),
            );
            if r != h {
                return Err(format!("sws_scale returned {} (expected {})", r, h));
            }
        }
        Ok(Bitmap::from_shared(data, w as u32, h as u32))
    }
}

// ── layer geometry helpers ─────────────────────────────────────────────────

/// Cover-fit crop window (normalized) from source aspect → canvas aspect.
fn cover_crop(src_w: u32, src_h: u32, dst_w: u32, dst_h: u32) -> (f32, f32, f32, f32) {
    let sa = src_w as f64 / src_h.max(1) as f64;
    let da = dst_w as f64 / dst_h.max(1) as f64;
    if sa > da {
        let cw = (da / sa) as f32;
        ((1.0 - cw) / 2.0, 0.0, cw, 1.0)
    } else {
        let chh = (sa / da) as f32;
        (0.0, (1.0 - chh) / 2.0, 1.0, chh)
    }
}

/// Shrink a crop window around its center by 1/zoom (Ken Burns).
fn zoom_crop(base: (f32, f32, f32, f32), zoom: f32) -> (f32, f32, f32, f32) {
    let z = zoom.max(1.0);
    let nw = base.2 / z;
    let nh = base.3 / z;
    let cx = base.0 + base.2 / 2.0;
    let cy = base.1 + base.3 / 2.0;
    (
        (cx - nw / 2.0).max(0.0),
        (cy - nh / 2.0).max(0.0),
        nw.min(1.0),
        nh.min(1.0),
    )
}

fn ken_burns_zoom(seg: &Segment, progress: f64) -> f32 {
    let kb = match &seg.ken_burns {
        Some(k) if k.enabled => k,
        _ => return 1.0,
    };
    let p = (progress.clamp(0.0, 1.0)) as f32;
    let zoom_max = kb.zoom_max.clamp(1.0, 3.0) as f32;
    if kb.direction == "out" {
        zoom_max + (1.0 - zoom_max) * p
    } else {
        1.0 + (zoom_max - 1.0) * p
    }
}

/// The Ken Burns zoom at the END of a segment — used by the dissolve head
/// (the CLI's frozenZoompanExpr shows the PREVIOUS image at its final
/// state during the crossfade).
fn ken_burns_frozen(seg: &Segment) -> f32 {
    let kb = match &seg.ken_burns {
        Some(k) if k.enabled => k,
        _ => return 1.0,
    };
    let zoom_max = kb.zoom_max.clamp(1.0, 3.0) as f32;
    if kb.direction == "out" {
        1.0
    } else {
        zoom_max
    }
}

/// dip-black / dip-white background clear color.
fn dip_color(style: &str) -> Option<[u8; 4]> {
    match style {
        "dip-black" => Some([0, 0, 0, 255]),
        "dip-white" => Some([255, 255, 255, 255]),
        _ => None,
    }
}

// ── encoder setup ───────────────────────────────────────────────────────────

struct EncoderPick {
    name: String,
    ctx: PtrGuard,
    /// The pixel format this encoder was opened with (YUV420P or NV12).
    pix_fmt: i32,
}

/// Hardware tiers need NV12 (QSV *only* opens NV12 — asking for YUV420P made
/// the tier fail and silently fall to libx264); NVENC/x264 take YUV420P.
fn encoder_pix_fmt(name: &str) -> i32 {
    match name {
        "h264_qsv" | "h264_amf" | "h264_mf" => AV_PIX_FMT_NV12,
        _ => AV_PIX_FMT_YUV420P,
    }
}

fn open_video_encoder(
    ff: &FFmpegLibs,
    timeline: &Timeline,
    global_header: bool,
) -> Result<EncoderPick, String> {
    let ladder = [
        "h264_nvenc",
        "h264_qsv",
        "h264_amf",
        "libx264",
        "h264_mf",
    ];
    let mut chosen: Option<(&str, *mut u8)> = None;
    for name in ladder {
        let c = CString::new(name).unwrap();
        let enc = unsafe { (ff.syms.avcodec_find_encoder_by_name)(c.as_ptr()) };
        if !enc.is_null() {
            chosen = Some((name, enc));
            break;
        }
    }
    let (name, codec) = chosen.ok_or_else(|| "no H.264 encoder in the FFmpeg build".to_string())?;

    let ctx = unsafe { (ff.syms.avcodec_alloc_context3)(codec) };
    let ctx = PtrGuard::new(ctx, ff.syms.avcodec_free_context).map_err(|e| e)?;

    let fps1000 = (timeline.fps * 1000.0).round().max(1.0) as i32;
    let pix_fmt = encoder_pix_fmt(name);
    ff.cc_set_dimensions(ctx.raw, timeline.width as i32, timeline.height as i32);
    ff.cc_set_pix_fmt(ctx.raw, pix_fmt);
    ff.cc_set_time_base(ctx.raw, Rational::new(1000, fps1000));
    ff.cc_set_framerate(ctx.raw, Rational::new(fps1000, 1000));
    ff.cc_set_gop(ctx.raw, (timeline.fps * 2.0).round().max(12.0) as i32);
    if global_header {
        ff.cc_set_flags_or(ctx.raw, AV_CODEC_FLAG_GLOBAL_HEADER);
    }
    let quality = timeline.quality.as_deref().unwrap_or("social");
    let crf = timeline.crf.unwrap_or(21).clamp(0, 51);
    let bitrate = (timeline.bitrate_mbps.max(0.0) * 1_000_000.0) as i64;

    let mut dict: *mut u8 = std::ptr::null_mut();
    match name {
        "h264_nvenc" => {
            // NVIDIA SDK-10 preset ladder + the async pipeline INTACT (no
            // delay=0 — v1's synchronous mode cost 5-25% throughput).
            let (preset, multipass, lookahead, aq, bref) = match quality {
                "cinema" => ("p6", "fullres", 32, true, "each"),
                "balanced" => ("p4", "qres", 16, true, "middle"),
                _ => ("p3", "disabled", 0, false, ""),
            };
            let _ = ff.dict_set(&mut dict, "preset", preset);
            let _ = ff.dict_set(&mut dict, "tune", "hq");
            let _ = ff.dict_set(&mut dict, "rc", "vbr");
            let _ = ff.dict_set(&mut dict, "cq", &(crf + 2).to_string());
            let _ = ff.dict_set(&mut dict, "b", "0");
            let _ = ff.dict_set(&mut dict, "bf", "2");
            let _ = ff.dict_set(&mut dict, "multipass", multipass);
            let _ = ff.dict_set(&mut dict, "rc-lookahead", &lookahead.to_string());
            if aq {
                let _ = ff.dict_set(&mut dict, "spatial-aq", "1");
                let _ = ff.dict_set(&mut dict, "aq-strength", if quality == "cinema" { "10" } else { "8" });
            }
            if !bref.is_empty() && quality != "social" {
                let _ = ff.dict_set(&mut dict, "b_ref_mode", bref);
            }
        }
        "h264_qsv" => {
            // QSV numbers are inverted (7 = veryfast); async_depth stays at
            // its throughput-optimal default 4.
            let (preset, look) = match quality {
                "cinema" => ("medium", 40),
                "balanced" => ("fast", 20),
                _ => ("veryfast", 0),
            };
            let _ = ff.dict_set(&mut dict, "preset", preset);
            let _ = ff.dict_set(&mut dict, "global_quality", &crf.to_string());
            let _ = ff.dict_set(&mut dict, "look_ahead", if look > 0 { "1" } else { "0" });
            if look > 0 {
                let _ = ff.dict_set(&mut dict, "look_ahead_depth", &look.to_string());
            }
            if quality != "social" {
                let _ = ff.dict_set(&mut dict, "extbrc", "1");
            }
        }
        "h264_amf" => {
            let (q, vbaq) = match quality {
                "cinema" => ("quality", true),
                "balanced" => ("balanced", true),
                _ => ("speed", false),
            };
            let _ = ff.dict_set(&mut dict, "quality", q);
            let _ = ff.dict_set(&mut dict, "usage", "transcoding");
            if vbaq {
                let _ = ff.dict_set(&mut dict, "vbaq", "1");
            }
            if bitrate > 0 {
                let _ = ff.dict_set(&mut dict, "rc", "vbr_peak");
            }
        }
        _ => {
            // libx264 / h264_mf — CPU tiers: auto threads (v1 never set
            // them on the primary encoder → single-threaded libx264!).
            let preset = match quality {
                "cinema" => "slow",
                "balanced" => "medium",
                // v1.33.7: the CLI's speed tiers (draft/fastMode on
                // constrained CPUs) drop to ultrafast — the engine honors
                // the same ladder so a draft export is a DRAFT everywhere.
                "draft" | "fast" => "ultrafast",
                _ => "veryfast",
            };
            let _ = ff.dict_set(&mut dict, "preset", preset);
            let _ = ff.dict_set(&mut dict, "crf", &crf.to_string());
            ff.cc_set_threads_auto(ctx.raw);
        }
    }
    if bitrate > 0 && (name == "h264_amf" || timeline.crf.is_none()) {
        let _ = ff.dict_set(&mut dict, "b", &bitrate.to_string());
    }
    let r = unsafe { (ff.syms.avcodec_open2)(ctx.raw, codec, &mut dict) };
    ff.dict_free(&mut dict);
    if r < 0 {
        // retry once with the software encoder when a hardware open fails
        if name != "libx264" {
            let c = CString::new("libx264").unwrap();
            let sw = unsafe { (ff.syms.avcodec_find_encoder_by_name)(c.as_ptr()) };
            if !sw.is_null() {
                let ctx2 = unsafe { (ff.syms.avcodec_alloc_context3)(sw) };
                if let Ok(g) = PtrGuard::new(ctx2, ff.syms.avcodec_free_context) {
                    ff.cc_set_dimensions(g.raw, timeline.width as i32, timeline.height as i32);
                    ff.cc_set_pix_fmt(g.raw, AV_PIX_FMT_YUV420P);
                    ff.cc_set_time_base(g.raw, Rational::new(1000, fps1000));
                    ff.cc_set_framerate(g.raw, Rational::new(fps1000, 1000));
                    ff.cc_set_gop(g.raw, (timeline.fps * 2.0).round().max(12.0) as i32);
                    if global_header {
                        ff.cc_set_flags_or(g.raw, AV_CODEC_FLAG_GLOBAL_HEADER);
                    }
                    ff.cc_set_threads_auto(g.raw);
                    let mut d2: *mut u8 = std::ptr::null_mut();
                    let _ = ff.dict_set(&mut d2, "preset", "veryfast");
                    let _ = ff.dict_set(&mut d2, "crf", &crf.to_string());
                    let r2 = unsafe { (ff.syms.avcodec_open2)(g.raw, sw, &mut d2) };
                    ff.dict_free(&mut d2);
                    if r2 == 0 {
                        return Ok(EncoderPick { name: "libx264".into(), ctx: g, pix_fmt: AV_PIX_FMT_YUV420P });
                    }
                }
            }
        }
        return Err(format!("encoder open({}): {}", name, ff.err2str(r)));
    }
    Ok(EncoderPick { name: name.into(), ctx, pix_fmt })
}

// ── producer job shape ─────────────────────────────────────────────────────

/// One fully-built frame handed producer → consumer.
struct FrameJob {
    k: u64,
    layers: Vec<Layer>,
    texts: Vec<TextLayer>,
    /// Per-frame background clear color (dip transitions / black).
    background: [u8; 4],
}

enum ProducerMsg {
    Frame(FrameJob),
    Failed(String),
    Done { decode_ms: i64 },
}

// ── the pipeline ────────────────────────────────────────────────────────────

pub fn run_pipeline(
    timeline: Timeline,
    output_path: String,
    ff: Arc<FFmpegLibs>,
    progress: ProgressSink,
    cancelled: &'static AtomicBool,
) -> Result<ExportOutcome, String> {
    let t_start = Instant::now();
    let timeline = timeline.sanitized();
    let (cw, ch) = (timeline.width, timeline.height);
    let fps = timeline.fps;
    let total_frames = timeline.total_frames();
    if total_frames == 0 {
        return Err("empty timeline (total_ms <= 0 and no segments)".into());
    }
    let total_sec = timeline.total_ms / 1000.0;
    let timeline = Arc::new(timeline);

    progress(ProgressEvent {
        phase: "prepare".into(),
        percent: 0.5,
        fps: 0.0,
        timemark_sec: 0.0,
    });

    // ── split segments: base lane (sequential) + overlay lanes ──────────
    let mut base: Vec<usize> = timeline
        .segments
        .iter()
        .enumerate()
        .filter(|(_, s)| s.track == 0)
        .map(|(i, _)| i)
        .collect();
    base.sort_by(|&a, &b| {
        timeline.segments[a]
            .start_ms
            .partial_cmp(&timeline.segments[b].start_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut overlays: Vec<usize> = timeline
        .segments
        .iter()
        .enumerate()
        .filter(|(_, s)| s.track >= 1)
        .map(|(i, _)| i)
        .collect();
    overlays.sort_by(|&a, &b| {
        timeline.segments[a]
            .track
            .cmp(&timeline.segments[b].track)
            .then(
                timeline.segments[a]
                    .start_ms
                    .partial_cmp(&timeline.segments[b].start_ms)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
    });

    // ── static assets: images decoded IN PARALLEL (rayon) ──────────────
    let mut decode_ms: i64 = 0;
    let t_img = Instant::now();
    let image_ids: Vec<usize> = timeline
        .segments
        .iter()
        .enumerate()
        .filter(|(_, s)| s.media_type == "image")
        .map(|(i, _)| i)
        .collect();
    let image_bitmaps: std::collections::HashMap<usize, Bitmap> = image_ids
        .par_iter()
        .map(|&i| {
            let seg = &timeline.segments[i];
            let img = image::open(&seg.path)
                .map_err(|e| format!("image open `{}`: {}", seg.path, e))?;
            let rgba = img.to_rgba8();
            let (w, h) = (rgba.width().max(1), rgba.height().max(1));
            Ok((i, Bitmap::new(rgba.into_raw(), w, h)))
        })
        .collect::<Result<std::collections::HashMap<usize, Bitmap>, String>>()?;
    for seg in timeline.segments.iter() {
        if seg.path.is_empty() {
            return Err(format!("segment `{}` has no source path", seg.id));
        }
        if !std::path::Path::new(&seg.path).exists() {
            return Err(format!("source file missing: `{}`", seg.path));
        }
    }
    let image_bitmaps = Arc::new(image_bitmaps);
    decode_ms += t_img.elapsed().as_millis() as i64;

    // ── rasterize text overlays once ────────────────────────────────────
    let mut text_renderer = TextRenderer::new();
    let mut texts: Vec<(usize, TextLayer, f64, f64, f64)> = Vec::new(); // (key, layer, start, end, fade)
    for (i, t) in timeline.texts.iter().enumerate() {
        let layer = text_renderer.rasterize(&timeline, t, cw, ch)?;
        let key = i;
        texts.push((
            key,
            layer,
            t.start_ms,
            if t.end_ms > t.start_ms { t.end_ms } else { t.start_ms + 500.0 },
            t.fade_ms.clamp(0.0, 2000.0),
        ));
    }
    let texts = Arc::new(texts);

    // ── v1.20 NATIVE CAPTIONS: prepare once (font load + layout + word
    // bitmap cache). None when the timeline carries no caption cues —
    // painting is then a no-op. ─────────────────────────────────────
    // v1.21 NATIVE KINETIC: when the kinetic timeline is present it
    // REPLACES plain captions (the preview painter dispatches the same
    // way — kinetic.enabled wins over the legacy cue path).
    let kinetic_first = timeline.kinetic.as_ref().map(|k| !k.comps.is_empty()).unwrap_or(false);
    let prepared_captions: Option<Arc<PreparedCaptions>> = if kinetic_first {
        None
    } else {
        match captions::prepare(&timeline, cw, ch) {
            Ok(p) => p.map(Arc::new),
            Err(e) => {
                // A caption failure must never kill the export — degrade to
                // captions-less output (the router logs it; parity with the
                // CLI pipeline's error tolerance).
                log::warn!("[rust-engine] captions unavailable ({}): exporting without burn-in", e);
                None
            }
        }
    };

    // ── v1.21 NATIVE KINETIC TYPOGRAPHY: prepare once (fonts + strip
    // rasterization). Same degrade-to-none tolerance as captions. ────
    let prepared_kinetic: Option<Arc<PreparedKinetic>> = if kinetic_first {
        match kinetic::prepare(&timeline, cw, ch) {
            Ok(p) => p.map(Arc::new),
            Err(e) => {
                log::warn!("[rust-engine] kinetic unavailable ({}): exporting without kinetic captions", e);
                None
            }
        }
    } else {
        None
    };

    // ── watermark ────────────────────────────────────────────────────────
    let mut watermark: Option<TextLayer> = None;
    if let Some(wm) = &timeline.watermark {
        if !wm.path.is_empty() && std::path::Path::new(&wm.path).exists() {
            let img = image::open(&wm.path)
                .map_err(|e| format!("watermark open `{}`: {}", wm.path, e))?;
            let rgba = img.to_rgba8();
            let (w, h) = (rgba.width().max(1), rgba.height().max(1));
            // watermark geometry arrives in PIXELS (computed by Electron)
            let dw = if wm.w > 0.0 { wm.w.max(1.0) as u32 } else { w };
            let dh = if wm.h > 0.0 { wm.h.max(1.0) as u32 } else { h };
            watermark = Some(TextLayer {
                bitmap: Bitmap::new(rgba.into_raw(), w, h),
                dest_px: (wm.x.max(0.0) as u32, wm.y.max(0.0) as u32, dw, dh),
                alpha: (wm.opacity.clamp(0.05, 1.0)) as f32,
            });
        }
    }
    let watermark = Arc::new(watermark);

    // ── output context + streams ─────────────────────────────────────────
    let c_out = CString::new(output_path.clone()).map_err(|e| format!("bad output path: {}", e))?;
    let mut oc: *mut u8 = std::ptr::null_mut();
    let r = unsafe {
        (ff.syms.avformat_alloc_output_context2)(&mut oc, std::ptr::null_mut(), b"mp4\0".as_ptr() as *const i8, c_out.as_ptr())
    };
    if r < 0 || oc.is_null() {
        return Err(format!("avformat_alloc_output_context2: {}", ff.err2str(r)));
    }
    let oc = OutFormatGuard::new(oc, ff.syms.avformat_free_context, ff.syms.avio_closep);
    let global_header = ff.fmt_oformat_flags(oc.raw) & AVFMT_GLOBALHEADER != 0;
    let r = unsafe { (ff.syms.avio_open)(oc.raw.add(AVFMTCTX_PB) as *mut *mut u8, c_out.as_ptr(), AVIO_FLAG_WRITE) };
    if r < 0 {
        return Err(format!("avio_open `{}`: {}", output_path, ff.err2str(r)));
    }

    // v2: open the video encoder FIRST — the actual encoder decides the
    // pixel format, which decides the compositor's GPU-YUV packing.
    let venc = open_video_encoder(&ff, &timeline, global_header)?;
    log::info!("[rust-engine] encoder: {} (pix_fmt {})", venc.name, venc.pix_fmt);

    // ── compositor (wgpu first, CPU fallback) — mode matched to encoder ──
    let yuv_mode = if venc.pix_fmt == AV_PIX_FMT_NV12 { YuvMode::Nv12 } else { YuvMode::Yuv420p };
    let mut compositor: Box<dyn Compositor> = compositor::create_compositor(cw, ch, yuv_mode);
    let mut engine_used = compositor.name().to_string();
    let adapter = compositor.adapter_name();

    // video encoder stream
    let vstream = unsafe { (ff.syms.avformat_new_stream)(oc.raw, std::ptr::null()) };
    if vstream.is_null() {
        return Err("avformat_new_stream(video) failed".into());
    }
    let r = unsafe { (ff.syms.avcodec_parameters_from_context)(ff.stream_codecpar(vstream), venc.ctx.raw) };
    if r < 0 {
        return Err(format!("avcodec_parameters_from_context(video): {}", ff.err2str(r)));
    }
    ff.stream_set_time_base(vstream, Rational::new(1000, (timeline.fps * 1000.0).round().max(1.0) as i32));
    ff.stream_set_avg_frame_rate(vstream, Rational::new((timeline.fps * 1000.0).round().max(1.0) as i32, 1000));

    // audio encoder + stream (created BEFORE write_header)
    let sr = timeline.sample_rate as i32;
    let och = timeline.audio_channels;
    let aenc: Option<PtrGuard> = {
        let c = CString::new("aac").unwrap();
        let enc = unsafe { (ff.syms.avcodec_find_encoder_by_name)(c.as_ptr()) };
        if enc.is_null() {
            None
        } else {
            let ctx = unsafe { (ff.syms.avcodec_alloc_context3)(enc) };
            match PtrGuard::new(ctx, ff.syms.avcodec_free_context) {
                Ok(g) => {
                    ff.cc_set_sample_fmt(g.raw, AV_SAMPLE_FMT_FLTP);
                    ff.cc_set_sample_rate(g.raw, sr);
                    unsafe { ff.cc_set_channel_layout(g.raw, och as i32, if och == 1 { 0x4 } else { 0x3 }) };
                    ff.cc_set_time_base(g.raw, Rational::new(1, sr));
                    ff.cc_set_bit_rate(g.raw, (timeline.audio_kbps.clamp(32, 512) * 1000) as i64);
                    if global_header {
                        ff.cc_set_flags_or(g.raw, AV_CODEC_FLAG_GLOBAL_HEADER);
                    }
                    let ro = unsafe { (ff.syms.avcodec_open2)(g.raw, enc, std::ptr::null_mut()) };
                    if ro < 0 {
                        log::warn!("[rust-engine] AAC open failed ({}), exporting video-only", ff.err2str(ro));
                        None
                    } else {
                        Some(g)
                    }
                }
                Err(_) => None,
            }
        }
    };
    let astream: *mut u8 = if let Some(ref ae) = aenc {
        let st = unsafe { (ff.syms.avformat_new_stream)(oc.raw, std::ptr::null()) };
        if !st.is_null() {
            let r = unsafe { (ff.syms.avcodec_parameters_from_context)(ff.stream_codecpar(st), ae.raw) };
            if r < 0 {
                log::warn!("[rust-engine] audio stream param copy failed: {}", ff.err2str(r));
            }
            ff.stream_set_time_base(st, Rational::new(1, sr));
        }
        st
    } else {
        std::ptr::null_mut()
    };

    // v2: movflags +faststart — moov at the front (instant player seeking);
    // the mp4 muxer performs the relocation during av_write_trailer.
    let mut mux_opts: *mut u8 = std::ptr::null_mut();
    let _ = ff.dict_set(&mut mux_opts, "movflags", "+faststart");
    let r = unsafe { (ff.syms.avformat_write_header)(oc.raw, &mut mux_opts) };
    ff.dict_free(&mut mux_opts);
    if r < 0 {
        return Err(format!("avformat_write_header: {}", ff.err2str(r)));
    }
    // muxer may have adjusted stream time bases — read them back
    let v_tb = ff.stream_time_base(vstream);
    let a_tb = if astream.is_null() { Rational::new(1, sr) } else { ff.stream_time_base(astream) };
    let v_tb_enc = Rational::new(1000, (timeline.fps * 1000.0).round().max(1.0) as i32);
    // Stream slots are fixed after write_header — resolve the muxer indices
    // once instead of scanning the stream array for EVERY packet written.
    let v_idx = vstream_idx_of(oc.raw, vstream, &ff);
    let a_idx = if astream.is_null() { -1 } else { vstream_idx_of(oc.raw, astream, &ff) };

    // ── AVFrame ring ─────────────────────────────────────────────────────
    // v2.1: ring sized against the encoder's in-flight window (budget
    // ~160 MB of frame buffers, clamped 12..56). v2.0's fixed ring of 10
    // made async encoders (NVENC reffs input frames until their packet is
    // ready: lookahead 16-32 + b-frames + delay; QSV async_depth +
    // look_ahead_depth 40) hold MORE frames than the ring — every single
    // frame then took the av_frame_make_writable slow path (full-plane
    // copy + re-alloc). A ring larger than the in-flight window makes
    // make_writable a no-op. Worst case (window > ring) is exactly the old
    // behavior — never worse.
    let frame_bytes = (cw as usize * ch as usize * 3 / 2).max(1);
    let frame_ring_size = ((160 * 1024 * 1024) / frame_bytes).clamp(12, 56);
    let frame_fmt = venc.pix_fmt;
    let mut frame_ring: Vec<PtrGuard> = Vec::with_capacity(frame_ring_size);
    for _ in 0..frame_ring_size {
        let f = ff.frame_alloc()?;
        unsafe {
            wr_i32(f.raw, AVFRAME_WIDTH, cw as i32);
            wr_i32(f.raw, AVFRAME_HEIGHT, ch as i32);
            wr_i32(f.raw, AVFRAME_FORMAT, frame_fmt);
            let r = (ff.syms.av_frame_get_buffer)(f.raw, 32);
            if r < 0 {
                return Err(format!("av_frame_get_buffer(yuv ring): {}", ff.err2str(r)));
            }
        }
        frame_ring.push(f);
    }

    // CPU compositor RGBA → YUV/NV12 sws (GPU path never uses this).
    let mut rgba_sws: Option<SwsGuard> = None;
    if compositor.output_format() == OutputFormat::Rgba {
        let ctx = unsafe {
            (ff.syms.sws_getContext)(
                cw as i32,
                ch as i32,
                AV_PIX_FMT_RGBA,
                cw as i32,
                ch as i32,
                frame_fmt,
                SWS_BILINEAR,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        if ctx.is_null() {
            return Err("sws_getContext(YUV) failed".into());
        }
        rgba_sws = Some(SwsGuard { raw: ctx, free: ff.syms.sws_freeContext });
    }

    let pkt = ff.packet_alloc()?;

    // ── AUDIO THREAD (decode + mix runs DURING the video loop) ──────────
    // v0.3 REWORK: (1) base-lane LOOP-TO-FILL segments loop their own audio
    // across the timeline (the CLI `-stream_loop` parity); (2) per-source
    // loudness normalization when `timeline.normalize_audio` — the EBU R128
    // K-weighted gated measurement runs IN-PROCESS (audio::windowed_lufs, ≤90 s
    // sample — constant cost) and applies a STATIC linear gain toward the
    // target (−16 LUFS default), CLI clip/legacy-music semantics: extra-audio
    // (voiceover/SFX/music-clip) placements are NEVER measured; (3) tracks mix
    // ONE AT A TIME into the output buffer — a large decoded source is dropped
    // right after its pass, so peak RAM = mix + largest track (not the SUM of
    // all tracks); small sources still decode in parallel (rayon).
    let (audio_tx, audio_rx) = std::sync::mpsc::channel::<Result<Vec<f32>, String>>();
    {
        let ff = ff.clone();
        let timeline = timeline.clone();
        std::thread::Builder::new()
            .name("framefuse-audio".into())
            .spawn(move || {
                struct AudioJob {
                    path: String,
                    start_ms: f64,
                    volume: f64,
                    speed: f64,
                    loop_src: bool,
                    /// CLI parity: clip audio + LEGACY music normalize;
                    /// voiceover/SFX/music-clip placements never.
                    normalize: bool,
                    tag: String,
                }
                let mut jobs: Vec<AudioJob> = Vec::new();
                for s in timeline.segments.iter() {
                    if s.has_audio && s.volume > 0.001 && !s.path.is_empty() {
                        jobs.push(AudioJob {
                            path: s.path.clone(),
                            start_ms: s.start_ms,
                            volume: s.volume,
                            speed: s.speed,
                            loop_src: s.loop_src,
                            normalize: true,
                            tag: format!("clip:{}", s.id),
                        });
                    }
                }
                if let Some(music) = &timeline.music {
                    if !music.path.is_empty() && std::path::Path::new(&music.path).exists() {
                        jobs.push(AudioJob {
                            path: music.path.clone(),
                            start_ms: music.start_ms,
                            volume: music.volume,
                            speed: 1.0,
                            loop_src: music.loop_track,
                            normalize: music.normalize_src,
                            tag: "music".into(),
                        });
                    }
                }
                for ea in timeline.extra_audio.iter() {
                    if ea.path.is_empty() || !std::path::Path::new(&ea.path).exists() {
                        continue;
                    }
                    jobs.push(AudioJob {
                        path: ea.path.clone(),
                        start_ms: ea.start_ms.max(0.0),
                        volume: ea.volume,
                        speed: 1.0,
                        loop_src: ea.loop_src,
                        normalize: false,
                        tag: "extra".into(),
                    });
                }

                let out = if jobs.is_empty() {
                    Ok(Vec::new())
                } else {
                    let rate = timeline.sample_rate;
                    let chans = timeline.audio_channels as usize;
                    let total_samples =
                        (timeline.total_ms / 1000.0 * rate as f64).ceil() as usize;
                    let mut out: Vec<f32> = vec![0f32; total_samples * chans];
                    let mut any_audio = false;
                    let mut any_normalized = false;
                    let target_lufs = timeline.audio_target_lufs.unwrap_or(-16.0);

                    // v0.3 memory cap: sources ≥ LARGE_SOURCE_BYTES decode one
                    // at a time (mixed + dropped before the next); smaller
                    // sources batch-decode in parallel.
                    const LARGE_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
                    let file_bytes = |p: &str| {
                        std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
                    };
                    let (small, large): (Vec<usize>, Vec<usize>) = (0..jobs.len())
                        .partition(|&ji| file_bytes(&jobs[ji].path) < LARGE_SOURCE_BYTES);

                    let mut mix_job = |job: &AudioJob, pcm: PcmBuffer| {
                        if pcm.samples.is_empty() {
                            return;
                        }
                        any_audio = true;
                        let mut gain = job.volume.clamp(0.0, 2.0) as f32;
                        if timeline.normalize_audio && job.normalize {
                            let measured = audio::windowed_lufs(&pcm.samples, pcm.channels, rate);
                            if let Some(lufs) = measured
                            {
                                let db = target_lufs - lufs;
                                if lufs > -70.0 && lufs < 0.0 && db.abs() <= 40.0 {
                                    gain *= 10f64.powf(db / 20.0) as f32;
                                    any_normalized = true;
                                    log::info!(
                                        "[rust-engine] loudnorm `{}`: measured {:.1} LUFS → {:+.1} dB (target {:.0})",
                                        job.tag,
                                        lufs,
                                        db,
                                        target_lufs
                                    );
                                }
                            }
                        }
                        let track = Track {
                            data: pcm.samples,
                            start_sample: (job.start_ms / 1000.0 * rate as f64).round() as i64,
                            gain,
                            speed: job.speed,
                            loop_src: job.loop_src,
                        };
                        audio::mix_into(&mut out, &track, chans);
                        // `track` (and its PCM Arc) drops HERE — the next large
                        // source starts with this one already freed.
                    };

                    // small sources: parallel decode, then mix (order-free)
                    if !small.is_empty() {
                        let decoded: Vec<Result<PcmBuffer, String>> = small
                            .par_iter()
                            .map(|&ji| {
                                let j = &jobs[ji];
                                audio::decode_audio(&ff, &j.path, rate, timeline.audio_channels)
                            })
                            .collect();
                        for (k, res) in decoded.into_iter().enumerate() {
                            match res {
                                Ok(pcm) => mix_job(&jobs[small[k]], pcm),
                                Err(e) => {
                                    if !e.contains("no audio stream") {
                                        log::warn!(
                                            "[rust-engine] audio decode `{}`: {}",
                                            jobs[small[k]].path,
                                            e
                                        );
                                    }
                                }
                            }
                        }
                    }
                    // v0.3.1 large sources: STREAMING decode + mix — peak
                    // RAM = mix + ONE window (~23 MB at 60 s) instead of mix
                    // + the whole decoded track (a 69-min source is 1.6 GB;
                    // mix + track blew past low-RAM machines). The decoder
                    // stays open across windows (sample-accurate stitching);
                    // loop sources replay from the start each cycle.
                    drop(mix_job); // the streaming path owns out/flags now
                    const AUDIO_WINDOW_SEC: f64 = 60.0;
                    for &ji in large.iter() {
                        let j = &jobs[ji];
                        let window_frames = (AUDIO_WINDOW_SEC * rate as f64) as usize;

                        // (a) loudness measurement FIRST — a dedicated 90 s
                        // window at 20 % in (constant cost, never the whole
                        // file), on its own stream instance.
                        let mut gain = j.volume.clamp(0.0, 2.0) as f32;
                        if timeline.normalize_audio && j.normalize {
                            let dur = audio::audio_duration_sec(&ff, &j.path);
                            if dur > 0.5 {
                                let start_sec = if dur <= 120.0 { 0.0 } else { dur * 0.20 };
                                let measure = audio::AudioStream::open(ff.clone(), &j.path, rate, timeline.audio_channels)
                                    .and_then(|mut ms| ms.seek_sec(start_sec).map(|_| ms))
                                    .and_then(|mut ms| {
                                        let mut buf: Vec<f32> = Vec::new();
                                        let want = (90.0 * rate as f64) as usize * chans.max(1);
                                        while buf.len() < want {
                                            match ms.next_window(window_frames) {
                                                Ok(w) => {
                                                    if w.samples.is_empty() { break; }
                                                    buf.extend_from_slice(&w.samples);
                                                }
                                                Err(e) => return Err(e),
                                            }
                                        }
                                        Ok(buf)
                                    });
                                if let Ok(buf) = measure {
                                    if !buf.is_empty() {
                                        if let Some(lufs) = audio::windowed_lufs(&buf, chans, rate) {
                                            let db = target_lufs - lufs;
                                            if lufs > -70.0 && lufs < 0.0 && db.abs() <= 40.0 {
                                                gain *= 10f64.powf(db / 20.0) as f32;
                                                any_normalized = true;
                                                log::info!(
                                                    "[rust-engine] loudnorm `{}`: measured {:.1} LUFS → {:+.1} dB (target {:.0})",
                                                    j.tag, lufs, db, target_lufs
                                                );
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        // (b) the streaming mix
                        match audio::AudioStream::open(ff.clone(), &j.path, rate, timeline.audio_channels) {
                            Ok(mut stream) => {
                                let t_start = (j.start_ms / 1000.0 * rate as f64).round() as i64;
                                let out_frames = out.len() / chans.max(1);
                                let mut mixed_any = false;
                                // loop cycles map source frame f of cycle k to
                                // out_sample = t_start + (k*L + f)/speed — the
                                // v0.2 mix_into wrap math (local = k*L + f,
                                // mod L). `loop_off` accumulates k*L.
                                let mut loop_off: usize = 0;
                                'cycles: loop {
                                    let mut cycle_frames: usize = 0; // frames this cycle
                                    loop {
                                        let before = stream.pass_frames();
                                        match stream.next_window(window_frames) {
                                            Ok(w) => {
                                                let wf = w.samples.len() / chans.max(1);
                                                if wf == 0 {
                                                    break; // EOF — cycle done
                                                }
                                                let _ = &wf;
                                                let base = loop_off + before;
                                                let out_start = t_start
                                                    + ((base as f64 / j.speed.max(0.01)).round() as i64);
                                                if out_start < out_frames as i64 {
                                                    let track = Track {
                                                        data: w.samples.clone(),
                                                        start_sample: out_start,
                                                        gain,
                                                        speed: j.speed,
                                                        loop_src: false, // cycles handle looping
                                                    };
                                                    audio::mix_into(&mut out, &track, chans);
                                                    mixed_any = true;
                                                } else {
                                                    // this job can no longer contribute
                                                    break 'cycles;
                                                }
                                                cycle_frames += wf;
                                            }
                                            Err(e) => {
                                                log::warn!("[rust-engine] audio stream window `{}`: {}", j.path, e);
                                                break 'cycles;
                                            }
                                        }
                                    }
                                    if !j.loop_src {
                                        break 'cycles;
                                    }
                                    // loop: replay while the timeline has room
                                    if cycle_frames == 0 {
                                        break 'cycles; // zero-length source — nothing to loop
                                    }
                                    if t_start + (((loop_off + cycle_frames) as f64 / j.speed.max(0.01)).round() as i64) >= out_frames as i64 {
                                        break 'cycles; // a full replay would start past the end
                                    }
                                    loop_off += cycle_frames;
                                    match stream.seek_start() {
                                        Ok(()) => continue 'cycles,
                                        Err(e) => {
                                            log::warn!("[rust-engine] audio loop seek `{}`: {}", j.path, e);
                                            break 'cycles;
                                        }
                                    }
                                }
                                if mixed_any {
                                    any_audio = true;
                                }
                            }
                            Err(e) => {
                                if !e.contains("no audio stream") {
                                    log::warn!("[rust-engine] audio decode `{}`: {}", j.path, e);
                                }
                            }
                        }
                    }


                    if !any_audio {
                        Ok(Vec::new())
                    } else {
                        // v0.3 MASTER-BUS normalization: measure the ACTUAL mix
                        // (windowed, constant cost) and apply one static gain
                        // toward the target — strictly better than the CLI's
                        // pre-mix energy ESTIMATE. Only when per-source gains
                        // ran (CLI parity: normalize with nothing measured =
                        // normalize bypassed).
                        if timeline.normalize_audio && any_normalized {
                            if let Some(mix_lufs) = audio::windowed_lufs(&out, chans, rate) {
                                let db = target_lufs - mix_lufs;
                                if mix_lufs > -70.0 && mix_lufs < 0.0 && db.abs() <= 40.0 {
                                    let g = 10f64.powf(db / 20.0) as f32;
                                    for v in out.iter_mut() {
                                        *v *= g;
                                    }
                                    log::info!(
                                        "[rust-engine] loudnorm master: mix measured {:.1} LUFS → {:+.1} dB",
                                        mix_lufs,
                                        db
                                    );
                                }
                            }
                        }
                        audio::finish_mix(
                            &mut out,
                            total_samples,
                            chans,
                            ((timeline.fade_in_ms / 1000.0) * rate as f64).round() as usize,
                            ((timeline.fade_out_ms / 1000.0) * rate as f64).round() as usize,
                        );
                        Ok(out)
                    }
                };
                let _ = audio_tx.send(out);
            })
            .map_err(|e| format!("audio thread spawn failed: {}", e))?;
    }

    // ── PRODUCER THREAD (decode-ahead + layer building) ──────────────────
    // v2.1: (a) the RGBA buffer pool closes the producer↔consumer loop;
    // (b) the channel depth is 8 (was 4) — the producer absorbs decode/sws
    // jitter across more frames, and with pooled buffers the in-flight
    // memory is reused rather than multiplied.
    let rgba_pool = Arc::new(RgbaPool::default());
    // Overlay chroma keys are immutable per segment — Arc them ONCE instead
    // of deep-cloning the {color: String, …} struct into every frame's layer.
    let overlay_chroma: Vec<Option<Arc<ChromaKey>>> = overlays
        .iter()
        .map(|&oi| timeline.segments[oi].chroma.clone().map(Arc::new))
        .collect();
    let (tx, rx) = sync_channel::<ProducerMsg>(8);
    {
        let ff = ff.clone();
        let timeline = timeline.clone();
        let base = base.clone();
        let overlays = overlays.clone();
        let overlay_chroma = overlay_chroma;
        let image_bitmaps = image_bitmaps.clone();
        let texts = texts.clone();
        let prepared_captions = prepared_captions.clone();
        let prepared_kinetic = prepared_kinetic.clone();
        let watermark = watermark.clone();
        let rgba_pool = rgba_pool.clone();
        std::thread::Builder::new()
            .name("framefuse-producer".into())
            .spawn(move || {
                let mut decode_ms: i64 = 0;
                // video decoders LIVE HERE (created + used + dropped on this
                // thread — one context per thread, the FFmpeg rule).
                let mut video_sources: std::collections::HashMap<usize, VideoSource> =
                    std::collections::HashMap::new();
                for &i in base.iter().chain(overlays.iter()) {
                    let seg = &timeline.segments[i];
                    if seg.media_type == "video" && !video_sources.contains_key(&i) {
                        let t0 = Instant::now();
                        match VideoSource::new(ff.clone(), &seg.path, Some(rgba_pool.clone())) {
                            Ok(src) => {
                                video_sources.insert(i, src);
                            }
                            Err(e) => {
                                let _ = tx.send(ProducerMsg::Failed(e));
                                return;
                            }
                        }
                        decode_ms += t0.elapsed().as_millis() as i64;
                    }
                }

                for k in 0u64..total_frames {
                    if cancelled.load(Ordering::Relaxed) {
                        let _ = tx.send(ProducerMsg::Done { decode_ms });
                        return;
                    }
                    let t = k as f64 / fps;
                    let job = build_frame_job(
                        k,
                        &timeline,
                        t,
                        &base,
                        &overlays,
                        &overlay_chroma,
                        &image_bitmaps,
                        &mut video_sources,
                        &texts,
                        &prepared_captions,
                        &prepared_kinetic,
                        &watermark,
                        &mut decode_ms,
                        cw,
                        ch,
                    );
                    let job = match job {
                        Ok(j) => j,
                        Err(e) => {
                            let _ = tx.send(ProducerMsg::Failed(e));
                            return;
                        }
                    };
                    if tx.send(ProducerMsg::Frame(job)).is_err() {
                        // consumer dropped early (cancel / error) — stop
                        return;
                    }
                }
                let _ = tx.send(ProducerMsg::Done { decode_ms });
            })
            .map_err(|e| format!("producer thread spawn failed: {}", e))?;
    }

    // ── CONSUMER LOOP (composite + encode + mux) ─────────────────────────
    let mut compositor_ms: i64 = 0;
    let mut encode_ms: i64 = 0;
    let v_loop_start = Instant::now();
    let mut last_emit: std::time::Duration = std::time::Duration::from_secs(0);
    let mut wrote_packets: u64 = 0;
    let mut producer_decode_ms: i64 = 0;
    let mut ring_pos: usize = 0;

    while let Ok(msg) = rx.recv() {
        match msg {
            ProducerMsg::Failed(e) => return Err(e),
            ProducerMsg::Done { decode_ms: dm } => {
                producer_decode_ms = dm;
                break;
            }
            ProducerMsg::Frame(job) => {
                if cancelled.load(Ordering::Relaxed) {
                    return Err("cancelled".into());
                }
                let FrameJob { k, layers, texts: text_layers, background } = job;
                let t = k as f64 / fps;

                // composite (GPU → CPU mid-export fallback on device loss)
                let t0 = Instant::now();
                if let Err(e) = compositor.render_frame(&layers, &text_layers, background, cw, ch) {
                    log::warn!("[rust-engine] compositor failed at frame {} ({}); switching to CPU rasterizer", k, e);
                    compositor = Box::new(crate::compositor::cpu::CpuCompositor::new(cw, ch));
                    engine_used = "rust-cpu".into();
                    if compositor.output_format() == OutputFormat::Rgba && rgba_sws.is_none() {
                        let ctx = unsafe {
                            (ff.syms.sws_getContext)(
                                cw as i32, ch as i32, AV_PIX_FMT_RGBA,
                                cw as i32, ch as i32, frame_fmt,
                                SWS_BILINEAR, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null(),
                            )
                        };
                        if ctx.is_null() {
                            return Err("sws_getContext(YUV, cpu fallback) failed".into());
                        }
                        rgba_sws = Some(SwsGuard { raw: ctx, free: ff.syms.sws_freeContext });
                    }
                    compositor.render_frame(&layers, &text_layers, background, cw, ch)?;
                }
                let out_fmt = compositor.output_format();
                let frame_bytes: &[u8] = compositor.output();

                // ── fill the AVFrame ──
                let t1 = Instant::now();
                let avframe = &frame_ring[ring_pos];
                ring_pos = (ring_pos + 1) % frame_ring_size;
                unsafe {
                    let r = (ff.syms.av_frame_make_writable)(avframe.raw);
                    if r < 0 {
                        return Err(format!("av_frame_make_writable: {}", ff.err2str(r)));
                    }
                    match out_fmt {
                        OutputFormat::Yuv420p | OutputFormat::Nv12 => {
                            // GPU path: tightly-packed planes (row-padded
                            // strides) → straight per-row memcpy.
                            let (y_stride, c_stride) = compositor.yuv_strides();
                            let w = cw as usize;
                            let h = ch as usize;
                            let h2 = (h + 1) / 2;
                            // v2.1: when both sides are tight (typical: even
                            // widths — 1920, 1280 — with 32-aligned
                            // av_frame_get_buffer linesizes) the whole plane
                            // is ONE memcpy instead of a per-row loop.
                            let copy_plane = |dst: *mut u8, dst_ls: i32, src: &[u8], src_stride: usize, rows: usize, row_bytes: usize| {
                                let dst_ls = dst_ls.max(1) as usize;
                                if dst_ls == row_bytes && src_stride == row_bytes && src.len() >= rows * row_bytes {
                                    std::ptr::copy_nonoverlapping(src.as_ptr(), dst, rows * row_bytes);
                                    return;
                                }
                                for row in 0..rows {
                                    let d = dst.add(row * dst_ls);
                                    let s = &src[row * src_stride..row * src_stride + row_bytes];
                                    std::ptr::copy_nonoverlapping(s.as_ptr(), d, row_bytes);
                                }
                            };
                            if out_fmt == OutputFormat::Yuv420p {
                                let y_plane_bytes = y_stride * h;
                                let c_plane_bytes = c_stride * h2;
                                copy_plane(ff.frame_data(avframe.raw, 0), ff.frame_linesize(avframe.raw, 0), &frame_bytes[..y_plane_bytes], y_stride, h, w);
                                copy_plane(ff.frame_data(avframe.raw, 1), ff.frame_linesize(avframe.raw, 1), &frame_bytes[y_plane_bytes..y_plane_bytes + c_plane_bytes], c_stride, h2, w / 2);
                                copy_plane(ff.frame_data(avframe.raw, 2), ff.frame_linesize(avframe.raw, 2), &frame_bytes[y_plane_bytes + c_plane_bytes..], c_stride, h2, w / 2);
                            } else {
                                // NV12: Y plane + interleaved UV (stride = y_stride)
                                let y_plane_bytes = y_stride * h;
                                let uv_rows = h2;
                                let uv_row_bytes = w;
                                copy_plane(ff.frame_data(avframe.raw, 0), ff.frame_linesize(avframe.raw, 0), &frame_bytes[..y_plane_bytes], y_stride, h, w);
                                let dst = ff.frame_data(avframe.raw, 1);
                                let dst_ls = ff.frame_linesize(avframe.raw, 1).max(1) as usize;
                                if dst_ls == uv_row_bytes && y_stride == uv_row_bytes {
                                    let uv = &frame_bytes[y_plane_bytes..y_plane_bytes + uv_rows * uv_row_bytes];
                                    std::ptr::copy_nonoverlapping(uv.as_ptr(), dst, uv.len());
                                } else {
                                    for row in 0..uv_rows {
                                        let d = dst.add(row * dst_ls);
                                        let s = &frame_bytes[y_plane_bytes + row * y_stride..y_plane_bytes + row * y_stride + uv_row_bytes];
                                        std::ptr::copy_nonoverlapping(s.as_ptr(), d, uv_row_bytes);
                                    }
                                }
                            }
                        }
                        OutputFormat::Rgba => {
                            // CPU path: sws RGBA → (YUV420P|NV12)
                            let sws = rgba_sws.as_ref().ok_or("sws missing for RGBA path")?;
                            let src_planes: [*const u8; 1] = [frame_bytes.as_ptr()];
                            let src_strides: [i32; 1] = [cw as i32 * 4];
                            let mut dst_planes: [*mut u8; 8] = [std::ptr::null_mut(); 8];
                            let dst_strides: [i32; 8] = {
                                let mut s = [0i32; 8];
                                for i in 0..8 {
                                    dst_planes[i] = ff.frame_data(avframe.raw, i);
                                    s[i] = ff.frame_linesize(avframe.raw, i);
                                }
                                s
                            };
                            let r = (ff.syms.sws_scale)(
                                sws.ptr(),
                                src_planes.as_ptr(),
                                src_strides.as_ptr(),
                                0,
                                ch as i32,
                                dst_planes.as_ptr(),
                                dst_strides.as_ptr(),
                            );
                            if r != ch as i32 {
                                return Err(format!("sws_scale(yuv) returned {}", r));
                            }
                        }
                    }
                    ff.frame_set_pts(avframe.raw, k as i64);
                    // send/drain contract: EAGAIN from send_frame means the
                    // frame was NOT consumed — drain packets, then retry.
                    loop {
                        let s = (ff.syms.avcodec_send_frame)(venc.ctx.raw, avframe.raw);
                        if s == AVERROR_EAGAIN {
                            if drain_video_encoder(&ff, venc.ctx.raw, pkt.raw, oc.raw, vstream, v_idx, &v_tb_enc, &v_tb, &mut wrote_packets)? == 0 {
                                return Err("video send_frame stuck on EAGAIN".into());
                            }
                            continue;
                        }
                        if s < 0 {
                            return Err(format!("video send_frame: {}", ff.err2str(s)));
                        }
                        break;
                    }
                }
                // drain encoder → mux (EAGAIN-aware: NVENC async delay is
                // INTACT now, packets arrive a few frames later)
                drain_video_encoder(&ff, venc.ctx.raw, pkt.raw, oc.raw, vstream, v_idx, &v_tb_enc, &v_tb, &mut wrote_packets)?;

                // v2.1: hand the frame's VIDEO-layer RGBA buffers back to the
                // producer's pool. The compositor has fully consumed them
                // (GPU uploads copy at submit time; the CPU rasterizer is
                // synchronous) and the encoded YUV lives in the AVFrame ring.
                // Static (image/text) layers are NOT recycled — they are
                // long-lived and must never be overwritten.
                for layer in layers.iter() {
                    if layer.dynamic {
                        rgba_pool.put(layer.bitmap.data.clone());
                    }
                }

                compositor_ms += t0.elapsed().as_millis() as i64;
                encode_ms += t1.elapsed().as_millis() as i64;

                // progress (throttle to ~8/s, always first/last)
                let el = v_loop_start.elapsed();
                if k == 0 || k + 1 == total_frames || el - last_emit > std::time::Duration::from_millis(125) {
                    last_emit = el;
                    let frac = (k + 1) as f64 / total_frames as f64;
                    let encode_fps = (k + 1) as f64 / el.as_secs_f64().max(0.001);
                    progress(ProgressEvent {
                        phase: "video".into(),
                        percent: 1.0 + 90.0 * frac,
                        fps: if encode_fps.is_finite() { encode_fps } else { 0.0 },
                        timemark_sec: t.max(0.0),
                    });
                }
            }
        }
    }

    // flush video encoder
    unsafe {
        let s = (ff.syms.avcodec_send_frame)(venc.ctx.raw, std::ptr::null());
        if s < 0 && s != AVERROR_EOF {
            return Err(format!("video flush: {}", ff.err2str(s)));
        }
    }
    drain_video_encoder(&ff, venc.ctx.raw, pkt.raw, oc.raw, vstream, v_idx, &v_tb_enc, &v_tb, &mut wrote_packets)?;
    // ── AUDIO PHASE (mix ran in parallel — join it now) ──────────────────
    let mut audio_ms: i64 = 0;
    if let Some(ref _ae) = aenc {
        let a0 = Instant::now();
        progress(ProgressEvent {
            phase: "audio".into(),
            percent: 92.0,
            fps: 0.0,
            timemark_sec: total_sec,
        });
        let mixed = match audio_rx.recv() {
            Ok(Ok(m)) => m,
            Ok(Err(e)) => return Err(format!("audio mix failed: {}", e)),
            Err(_) => return Err("audio thread died".into()),
        };

        if !mixed.is_empty() {
            let frame_size = ff.cc_frame_size(_ae.raw).max(64) as usize;
            let chn = timeline.audio_channels as usize;
            let aframe = ff.frame_alloc()?;
            unsafe {
                wr_i32(aframe.raw, AVFRAME_FORMAT, AV_SAMPLE_FMT_FLTP);
                wr_i32(aframe.raw, AVFRAME_NB_SAMPLES, frame_size as i32);
                wr_i32(aframe.raw, AVFRAME_SAMPLE_RATE, sr);
                ff.frame_set_layout(aframe.raw, chn as i32, if chn == 1 { 0x4 } else { 0x3 });
                let r = (ff.syms.av_frame_get_buffer)(aframe.raw, 0);
                if r < 0 {
                    return Err(format!("audio frame buffer: {}", ff.err2str(r)));
                }
            }
            let mut sample_pos = 0usize;
            // v2.1: audio-phase progress throttled to ~8/s like the video
            // loop — one event per 1024-sample AAC frame was ~47 TSFN calls
            // per second of audio (thousands per export), all crossing the
            // napi boundary for purely informational updates.
            let mut last_emit_a = std::time::Duration::from_secs(0);
            while sample_pos < mixed.len() {
                let take = frame_size.min((mixed.len() - sample_pos) / chn);
                if take == 0 {
                    break;
                }
                unsafe {
                    let r = (ff.syms.av_frame_make_writable)(aframe.raw);
                    if r < 0 {
                        return Err(format!("audio make_writable: {}", ff.err2str(r)));
                    }
                    let lp = ff.frame_data(aframe.raw, 0);
                    let rp = if chn > 1 { ff.frame_data(aframe.raw, 1) } else { lp };
                    for i in 0..take {
                        let l = mixed[sample_pos + i * chn];
                        let rr = if chn > 1 { mixed[sample_pos + i * chn + 1] } else { l };
                        (lp as *mut f32).add(i).write_unaligned(l);
                        if chn > 1 {
                            (rp as *mut f32).add(i).write_unaligned(rr);
                        }
                    }
                    ff.frame_set_pts(aframe.raw, (sample_pos / chn) as i64);
                    let s = (ff.syms.avcodec_send_frame)(_ae.raw, aframe.raw);
                    if s < 0 && s != AVERROR_EAGAIN {
                        return Err(format!("audio send_frame: {}", ff.err2str(s)));
                    }
                }
                loop {
                    let pr = unsafe { (ff.syms.avcodec_receive_packet)(_ae.raw, pkt.raw) };
                    if pr == AVERROR_EAGAIN || pr == AVERROR_EOF {
                        break;
                    }
                    if pr < 0 {
                        return Err(format!("audio receive_packet: {}", ff.err2str(pr)));
                    }
                    ff.packet_rescale_ts(pkt.raw, Rational::new(1, sr), a_tb);
                    ff.packet_set_stream_index(pkt.raw, a_idx);
                    let w = unsafe { (ff.syms.av_interleaved_write_frame)(oc.raw, pkt.raw) };
                    ff.packet_unref(pkt.raw);
                    if w < 0 {
                        return Err(format!("write audio packet: {}", ff.err2str(w)));
                    }
                }
                sample_pos += take * chn;
                let el = a0.elapsed();
                let last_chunk = sample_pos >= mixed.len();
                if sample_pos == take * chn || last_chunk || el - last_emit_a > std::time::Duration::from_millis(125) {
                    last_emit_a = el;
                    let frac = (sample_pos as f64 / mixed.len().max(1) as f64).min(1.0);
                    progress(ProgressEvent {
                        phase: "audio".into(),
                        percent: 92.0 + 6.0 * frac,
                        fps: 0.0,
                        timemark_sec: total_sec,
                    });
                }
            }
            // flush audio encoder
            unsafe {
                let s = (ff.syms.avcodec_send_frame)(_ae.raw, std::ptr::null());
                if s >= 0 || s == AVERROR_EOF {
                    loop {
                        let pr = (ff.syms.avcodec_receive_packet)(_ae.raw, pkt.raw);
                        if pr == AVERROR_EAGAIN || pr == AVERROR_EOF {
                            break;
                        }
                        if pr < 0 {
                            break;
                        }
                        ff.packet_rescale_ts(pkt.raw, Rational::new(1, sr), a_tb);
                        ff.packet_set_stream_index(pkt.raw, a_idx);
                        let w = (ff.syms.av_interleaved_write_frame)(oc.raw, pkt.raw);
                        ff.packet_unref(pkt.raw);
                        if w < 0 {
                            return Err(format!("write audio flush: {}", ff.err2str(w)));
                        }
                    }
                }
            }
        }
        audio_ms = a0.elapsed().as_millis() as i64;
    }

    // ── trailer + finish (movflags +faststart relocates moov here) ──────
    progress(ProgressEvent {
        phase: "mux".into(),
        percent: 98.5,
        fps: 0.0,
        timemark_sec: total_sec,
    });
    let r = unsafe { (ff.syms.av_write_trailer)(oc.raw) };
    if r < 0 {
        return Err(format!("av_write_trailer: {}", ff.err2str(r)));
    }

    log::info!(
        "[rust-engine] export complete: {} packets, {} frames, engine={}, encoder={}",
        wrote_packets, total_frames, engine_used, venc.name
    );
    let size = std::fs::metadata(&output_path).map(|m| m.len()).unwrap_or(0);
    progress(ProgressEvent {
        phase: "done".into(),
        percent: 100.0,
        fps: 0.0,
        timemark_sec: total_sec,
    });

    Ok(ExportOutcome {
        engine_used,
        encoder_name: venc.name,
        frames: total_frames,
        duration_ms: t_start.elapsed().as_millis() as i64,
        compositor_ms,
        encode_ms,
        decode_ms: decode_ms + producer_decode_ms,
        audio_ms,
        size_bytes: size,
        adapter,
    })
}

// ── the frame builder (runs ON THE PRODUCER THREAD) ────────────────────────

/// v0.3: the overlay motion-path center at `local_ms` into the window.
/// Piecewise-linear over `seg.motion` (hold-first / hold-last, ≥2 keys
/// engage); fewer keys return the static geometry center unchanged.
fn motion_center(seg: &Segment, local_ms: f64, fx: f64, fy: f64) -> (f64, f64) {
    let keys = &seg.motion;
    if keys.len() < 2 {
        return (fx, fy);
    }
    let t = local_ms.max(0.0);
    if t <= keys[0].t_ms {
        return (keys[0].x, keys[0].y);
    }
    let last = &keys[keys.len() - 1];
    if t >= last.t_ms {
        return (last.x, last.y);
    }
    for w in 1..keys.len() {
        if t <= keys[w].t_ms {
            let a = &keys[w - 1];
            let b = &keys[w];
            let span = (b.t_ms - a.t_ms).max(1e-6);
            let f = ((t - a.t_ms) / span).clamp(0.0, 1.0);
            return (a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f);
        }
    }
    (last.x, last.y)
}

#[allow(clippy::too_many_arguments)]
fn build_frame_job(
    k: u64,
    timeline: &Timeline,
    t: f64,
    base: &[usize],
    overlays: &[usize],
    // Pre-Arc'd chroma keys, position-aligned with `overlays` (v2.1: no
    // per-frame `ChromaKey { color: String }` clones).
    overlay_chroma: &[Option<Arc<ChromaKey>>],
    image_bitmaps: &std::collections::HashMap<usize, Bitmap>,
    video_sources: &mut std::collections::HashMap<usize, VideoSource>,
    texts: &[(usize, TextLayer, f64, f64, f64)],
    captions: &Option<Arc<PreparedCaptions>>,
    kinetic: &Option<Arc<PreparedKinetic>>,
    watermark: &Option<TextLayer>,
    decode_ms: &mut i64,
    cw: u32,
    ch: u32,
) -> Result<FrameJob, String> {
    let mut layers: Vec<Layer> = Vec::with_capacity(2 + overlays.len());
    let mut fade_gain = 1.0f32;
    let mut background = compositor::parse_hex_color(&timeline.background_color);
    // true while a DISSOLVE head is blending: overlays stay at full opacity
    // (the CLI composites overlay chains ON TOP of the xfade result).
    let mut dissolve_head = false;

    let seg_at = |tms: f64, idxs: &[usize]| -> Option<usize> {
        idxs.iter().copied().find(|&i| {
            let s = &timeline.segments[i];
            let end = if s.end_ms > s.start_ms { s.end_ms } else { s.start_ms + s.duration_ms };
            tms >= s.start_ms - 1e-6 && tms < end
        })
    };

    let now_ms = t * 1000.0;

    // ── base lane + NATIVE TRANSITIONS ──────────────────────────────────
    let cur = seg_at(now_ms, base);
    if let Some(i) = cur {
        let seg = &timeline.segments[i];
        let end = if seg.end_ms > seg.start_ms { seg.end_ms } else { seg.start_ms + seg.duration_ms };
        let local_t = (now_ms - seg.start_ms) / 1000.0;
        let progress = (local_t / (seg.duration_ms / 1000.0).max(0.001)).clamp(0.0, 1.0);

        // v2 TRANSITION HEAD — dissolve: draw the PREVIOUS image at its
        // frozen Ken Burns state, then the current content ramping in.
        if seg.trans_head_ms > 0.0 && seg.trans_head_style == "dissolve" {
            let head = seg.trans_head_ms / 1000.0;
            let p = (local_t / head.max(0.001)).clamp(0.0, 1.0) as f32;
            if p < 1.0 {
                let pos = base.iter().position(|&b| b == i).unwrap_or(0);
                if pos > 0 {
                    let prev_i = base[pos - 1];
                    let prev = &timeline.segments[prev_i];
                    if let Some(pb) = image_bitmaps.get(&prev_i) {
                        let crop_base = cover_crop(pb.w, pb.h, cw, ch);
                        let zoom = ken_burns_frozen(prev);
                        layers.push(Layer {
                            bitmap: pb.clone(),
                            crop: zoom_crop(crop_base, zoom),
                            dest: (0.0, 0.0, 1.0, 1.0),
                            alpha: 1.0,
                            chroma: None,
                            dynamic: false,
                        });
                        fade_gain = p; // current content fades IN over it
                        dissolve_head = true;
                    }
                }
            }
        }
        // v2 TRANSITION HEAD — dip: fade the content in from the dip color.
        if seg.trans_head_ms > 0.0 {
            if let Some(color) = dip_color(&seg.trans_head_style) {
                let head = seg.trans_head_ms / 1000.0;
                let p = (local_t / head.max(0.001)).clamp(0.0, 1.0) as f32;
                fade_gain *= p;
                background = color;
            }
        }
        // v2 TRANSITION TAIL — dip toward the NEXT boundary's color.
        if seg.trans_tail_ms > 0.0 {
            if let Some(color) = dip_color(&seg.trans_tail_style) {
                let tail = seg.trans_tail_ms / 1000.0;
                let till_end = (end - now_ms) / 1000.0;
                let p = (till_end / tail.max(0.001)).clamp(0.0, 1.0) as f32;
                fade_gain *= p;
                background = color;
            }
        }
        // v2 BOOKENDS (fadeStartEnd): first clip in from black, last out.
        if seg.bookend_start_ms > 0.0 {
            let head = seg.bookend_start_ms / 1000.0;
            let p = (local_t / head.max(0.001)).clamp(0.0, 1.0) as f32;
            fade_gain *= p;
            background = [0, 0, 0, 255];
        }
        if seg.bookend_end_ms > 0.0 {
            let tail = seg.bookend_end_ms / 1000.0;
            let till_end = (end - now_ms) / 1000.0;
            let p = (till_end / tail.max(0.001)).clamp(0.0, 1.0) as f32;
            fade_gain *= p;
            background = [0, 0, 0, 255];
        }

        let bitmap: Option<Bitmap> = if seg.media_type == "image" {
            image_bitmaps.get(&i).cloned()
        } else {
            // v0.3 LOOP-TO-FILL: wrap the decode position across the trimmed
            // source span (the CLI `-stream_loop` parity; the overlay lane's
            // `overlay_loop` mirror). Span = sourceDurationMs (payload) with
            // the decoder's EOF-pinned duration as the fallback.
            let payload_dur = seg.source_duration_ms.unwrap_or(0.0) / 1000.0;
            let src_dur = if payload_dur > 0.05 {
                payload_dur
            } else {
                video_sources.get(&i).map(|vs| vs.duration()).unwrap_or(0.0)
            };
            let trim = seg.trim_in_ms / 1000.0;
            let mut src_t = trim + local_t * seg.speed;
            if seg.loop_src && src_dur > 0.05 {
                let span = (src_dur - trim).max(0.05);
                src_t = trim + ((local_t * seg.speed) % span);
            }
            let t0 = Instant::now();
            let b = video_sources.get_mut(&i).and_then(|vs| vs.ensure_frame(src_t).ok().flatten());
            *decode_ms += t0.elapsed().as_millis() as i64;
            b
        };
        if let Some(bmp) = bitmap {
            let crop_base = cover_crop(bmp.w, bmp.h, cw, ch);
            let zoom = ken_burns_zoom(seg, progress);
            let crop = zoom_crop(crop_base, zoom);
            layers.push(Layer {
                bitmap: bmp,
                crop,
                dest: (0.0, 0.0, 1.0, 1.0),
                alpha: fade_gain,
                chroma: None,
                dynamic: seg.media_type == "video",
            });
        }
    }

    // ── overlay lanes in track order (dip fades apply to them too — the
    //    CLI runs dips AFTER the overlay composite) ──────────────────────
    for (ov_pos, &oi) in overlays.iter().enumerate() {
        let seg = &timeline.segments[oi];
        let win_start = seg.start_ms;
        let win_end = if seg.end_ms > win_start { seg.end_ms } else { win_start + seg.duration_ms };
        if now_ms < win_start || now_ms >= win_end {
            continue;
        }
        let local_t = (now_ms - win_start) / 1000.0;
        let bitmap: Option<Bitmap> = if seg.media_type == "image" {
            image_bitmaps.get(&oi).cloned()
        } else {
            // v0.3: payload duration with the decoder's EOF-pinned duration
            // as the fallback (base-lane loop parity).
            let payload_dur = seg.source_duration_ms.unwrap_or(0.0) / 1000.0;
            let src_dur = if payload_dur > 0.05 {
                payload_dur
            } else {
                video_sources.get(&oi).map(|vs| vs.duration()).unwrap_or(0.0)
            };
            let mut src_t = seg.trim_in_ms / 1000.0 + local_t * seg.speed;
            if (seg.overlay_loop || seg.loop_src) && src_dur > 0.05 {
                let span = (src_dur - seg.trim_in_ms / 1000.0).max(0.05);
                src_t = seg.trim_in_ms / 1000.0 + ((local_t * seg.speed) % span);
            }
            let t0 = Instant::now();
            let b = video_sources.get_mut(&oi).and_then(|vs| vs.ensure_frame(src_t).ok().flatten());
            *decode_ms += t0.elapsed().as_millis() as i64;
            b
        };
        if let Some(bmp) = bitmap {
            // geometry: normalized center + width; height from aspect
            let geo = seg.geometry.clone().unwrap_or_default();
            let gw = if geo.w > 0.01 { geo.w as f64 } else { 0.3 };
            let gh = if geo.h > 0.01 {
                geo.h as f64
            } else {
                (gw * (bmp.w as f64 / bmp.h.max(1) as f64)) * (cw as f64 / ch as f64)
            };
            let gx = if geo.x > 0.0 { geo.x as f64 } else { 0.5 };
            let gy = if geo.y > 0.0 { geo.y as f64 } else { 0.5 };
            // v0.3 MOTION PATH: ≥2 keyframes override the center across the
            // window (piecewise-linear, hold-first / hold-last — the same
            // curve the renderer interpolates and the CLI emits as overlay
            // x/y time expressions). The scale (gw/gh) stays from geometry.
            let (mx, my) = motion_center(seg, now_ms - win_start, gx, gy);
            let dest = (
                ((mx - gw / 2.0).clamp(0.0, 1.0)) as f32,
                ((my - gh / 2.0).clamp(0.0, 1.0)) as f32,
                gw as f32,
                gh as f32,
            );
            let ov_gain = if dissolve_head { 1.0 } else { fade_gain };
            layers.push(Layer {
                bitmap: bmp,
                crop: (0.0, 0.0, 1.0, 1.0),
                dest,
                alpha: (seg.opacity as f32) * ov_gain,
                chroma: overlay_chroma.get(ov_pos).and_then(|c| c.clone()),
                dynamic: seg.media_type == "video",
            });
        }
    }

    // ── texts (pre-rasterized, NEVER dip-faded — the layering contract:
    //    captions/headlines render above dip/bookend fades) + watermark ──
    let mut text_layers: Vec<TextLayer> = Vec::with_capacity(8 + texts.len());
    for (_, layer, start, end, fade) in texts.iter() {
        let (start, end, fade) = (*start, *end, *fade);
        if now_ms < start || now_ms >= end {
            continue;
        }
        let mut alpha = layer.alpha;
        let f = fade;
        if f > 0.0 {
            let in_a = ((now_ms - start) / f).clamp(0.0, 1.0);
            let out_a = ((end - now_ms) / f).clamp(0.0, 1.0);
            alpha *= (in_a.min(out_a) as f32).clamp(0.0, 1.0);
        }
        let mut tl = layer.clone();
        tl.alpha = alpha;
        text_layers.push(tl);
    }

    // ── v1.20 CAPTIONS / v1.21 KINETIC: burned-in layers (above texts,
    //    below the watermark — the ASS emission order: headline < kinetic
    //    < cue). The kinetic timeline REPLACES plain cues when present.
    if let Some(pk) = kinetic {
        text_layers.extend(kinetic::layers_at(pk, now_ms, ch));
    } else if let Some(pc) = captions {
        text_layers.extend(captions::layers_at(pc, now_ms, cw, ch));
    }

    if let Some(wm) = watermark {
        text_layers.push(wm.clone());
    }

    if captions_debug_enabled() && !text_layers.is_empty() {
        eprintln!(
            "[captions-dbg] frame {} ({}ms): {} text layers: {:?}",
            k,
            now_ms as i64,
            text_layers.len(),
            text_layers
                .iter()
                .map(|t| format!("{}x{}@{},{} a={:.2} bmp={}x{}", t.dest_px.2, t.dest_px.3, t.dest_px.0, t.dest_px.1, t.alpha, t.bitmap.w, t.bitmap.h))
                .collect::<Vec<_>>()
        );
    }
    Ok(FrameJob { k, layers, texts: text_layers, background })
}

/// Drain the video encoder into the muxer. Returns how many packets were
/// written (0 when the encoder has none yet — EAGAIN). `v_idx` is the
/// pre-resolved muxer stream index (fixed after write_header).
#[allow(clippy::too_many_arguments)]
fn drain_video_encoder(
    ff: &FFmpegLibs,
    ctx: *mut u8,
    pkt: *mut u8,
    oc: *mut u8,
    vstream: *mut u8,
    v_idx: i32,
    v_tb_enc: &Rational,
    v_tb: &Rational,
    wrote_packets: &mut u64,
) -> Result<usize, String> {
    let _ = vstream; // retained for signature clarity; index is precomputed
    let mut n = 0usize;
    loop {
        let pr = unsafe { (ff.syms.avcodec_receive_packet)(ctx, pkt) };
        if pr == AVERROR_EAGAIN || pr == AVERROR_EOF {
            break;
        }
        if pr < 0 {
            return Err(format!("video receive_packet: {}", ff.err2str(pr)));
        }
        ff.packet_rescale_ts(pkt, *v_tb_enc, *v_tb);
        ff.packet_set_stream_index(pkt, v_idx);
        let w = unsafe { (ff.syms.av_interleaved_write_frame)(oc, pkt) };
        ff.packet_unref(pkt);
        if w < 0 {
            return Err(format!("write video packet: {}", ff.err2str(w)));
        }
        n += 1;
        *wrote_packets += 1;
    }
    Ok(n)
}

/// Stream index lookup: which slot in the output's stream array is `st`?
fn vstream_idx_of(oc: *mut u8, st: *mut u8, ff: &FFmpegLibs) -> i32 {
    let n = ff.fmt_nb_streams(oc);
    for i in 0..n {
        if ff.fmt_streams(oc, i as usize) == st {
            return i as i32;
        }
    }
    0
}
