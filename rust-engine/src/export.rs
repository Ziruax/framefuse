//! Export pipeline v2 — "full potential" architecture.
//!
//! STAGE PIPELINE (the wall clock is max(stage), not sum(stage)):
//!   [producer thread]  decode-ahead: video decode (threaded avcodec) +
//!                      RGBA convert + layer building (incl. the native
//!                      transition plan)  ──sync_channel(4)──▶
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
use crate::ffmpeg_ffi::*;
use crate::ffi_offsets::*;
use crate::text::TextRenderer;
use crate::timeline::{Segment, Timeline};
use rayon::prelude::*;
use std::ffi::CString;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::sync_channel;
use std::sync::Arc;
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
}
/// The decoder + format contexts are created, used, and dropped by EXACTLY
/// one thread (the producer) — safe to move there at spawn time.
unsafe impl Send for VideoSource {}

impl VideoSource {
    pub fn new(ff: Arc<FFmpegLibs>, path: &str) -> Result<Self, String> {
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
        Ok(VideoSource {
            ff,
            fc,
            vstream,
            dec,
            frame,
            pkt,
            sws: None,
            sws_key: (0, 0, 0),
            width: src_w,
            height: src_h,
            fps: if fps.is_finite() && fps > 1.0 && fps < 240.0 { fps } else { 30.0 },
            stream_tb: if tb.den > 0 { tb } else { Rational::new(1, 30) },
            cur_src_t: -1.0,
            have_frame: false,
            eof: false,
        })
    }

    fn frame_pts_sec(&self) -> f64 {
        let pts = self.ff.frame_pts(self.frame.raw);
        if pts.is_negative() {
            return -1.0;
        }
        (pts as f64) * self.stream_tb.as_f64()
    }

    fn decode_one(&mut self) -> Result<bool, String> {
        // returns true when a NEW frame is available in self.frame
        loop {
            let fr = unsafe { (self.ff.syms.avcodec_receive_frame)(self.dec.raw, self.frame.raw) };
            if fr == 0 {
                self.have_frame = true;
                return Ok(true);
            }
            if fr == AVERROR_EAGAIN {
                // need more input
                loop {
                    let pr = unsafe { (self.ff.syms.av_read_frame)(self.fc.raw, self.pkt.raw) };
                    if pr == AVERROR_EOF {
                        let s = unsafe { (self.ff.syms.avcodec_send_packet)(self.dec.raw, std::ptr::null()) };
                        self.eof = true;
                        if s < 0 && s != AVERROR_EOF {
                            return Err(format!("decode flush: {}", self.ff.err2str(s)));
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
                return Ok(false);
            }
            return Err(format!("receive_frame: {}", self.ff.err2str(fr)));
        }
    }

    /// Decode forward until the LATEST frame at/just-before `t` is current.
    /// Returns the RGBA bitmap snapshot for compositing.
    pub fn ensure_frame(&mut self, t: f64) -> Result<Option<Bitmap>, String> {
        let cur_t = self.frame_pts_sec();
        if self.cur_src_t < 0.0 || (t + 0.001) < cur_t - 0.75 {
            // seek backwards (or first use): land slightly before the target
            let target = (t - 0.5).max(0.0);
            let ts = (target / self.stream_tb.as_f64()).round() as i64;
            unsafe {
                (self.ff.syms.av_seek_frame)(self.fc.raw, self.vstream, ts, AVSEEK_FLAG_BACKWARD);
                (self.ff.syms.avcodec_flush_buffers)(self.dec.raw);
            }
            self.have_frame = false;
            self.eof = false;
            self.cur_src_t = -1.0;
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
        self.to_rgba().map(Some)
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
        let mut out = vec![0u8; w as usize * h as usize * 4];
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
        Ok(Bitmap::new(out, w as u32, h as u32))
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

    // ── AVFrame ring (encoder buffering makes ONE reused frame copy every
    //    frame via make_writable — a ring amortizes it to ~never) ─────────
    const FRAME_RING: usize = 10;
    let frame_fmt = venc.pix_fmt;
    let mut frame_ring: Vec<PtrGuard> = Vec::with_capacity(FRAME_RING);
    for _ in 0..FRAME_RING {
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
    let (audio_tx, audio_rx) = std::sync::mpsc::channel::<Result<Vec<f32>, String>>();
    {
        let ff = ff.clone();
        let timeline = timeline.clone();
        std::thread::Builder::new()
            .name("framefuse-audio".into())
            .spawn(move || {
                let jobs: Vec<usize> = timeline
                    .segments
                    .iter()
                    .enumerate()
                    .filter(|(_, s)| s.has_audio && s.volume > 0.001)
                    .map(|(i, _)| i)
                    .collect();
                let results: Vec<(usize, Result<PcmBuffer, String>)> = jobs
                    .par_iter()
                    .map(|&i| {
                        let s = &timeline.segments[i];
                        let pcm = audio::decode_audio(&ff, &s.path, timeline.sample_rate, timeline.audio_channels);
                        (i, pcm)
                    })
                    .collect();
                let mut tracks: Vec<Track> = Vec::new();
                for (i, res) in results {
                    let seg = &timeline.segments[i];
                    match res {
                        Ok(pcm) => {
                            tracks.push(Track {
                                data: pcm.samples.clone(),
                                start_sample: (seg.start_ms / 1000.0 * timeline.sample_rate as f64).round() as i64,
                                gain: seg.volume.clamp(0.0, 2.0) as f32,
                                speed: seg.speed,
                                loop_src: false,
                            });
                        }
                        Err(e) => {
                            if !e.contains("no audio stream") {
                                log::warn!("[rust-engine] audio decode `{}`: {}", seg.path, e);
                            }
                        }
                    }
                }
                // global music
                if let Some(music) = &timeline.music {
                    if !music.path.is_empty() && std::path::Path::new(&music.path).exists() {
                        match audio::decode_audio(&ff, &music.path, timeline.sample_rate, timeline.audio_channels) {
                            Ok(pcm) => tracks.push(Track {
                                data: pcm.samples.clone(),
                                start_sample: (music.start_ms / 1000.0 * timeline.sample_rate as f64).round() as i64,
                                gain: music.volume.clamp(0.0, 2.0) as f32,
                                speed: 1.0,
                                loop_src: music.loop_track,
                            }),
                            Err(e) => log::warn!("[rust-engine] music decode: {}", e),
                        }
                    }
                }
                // v2 EXTRA AUDIO: voiceovers + SFX — mixed like every other
                // placed track (absolute timeline, own gain, never ducked).
                for ea in timeline.extra_audio.iter() {
                    if ea.path.is_empty() || !std::path::Path::new(&ea.path).exists() {
                        continue;
                    }
                    match audio::decode_audio(&ff, &ea.path, timeline.sample_rate, timeline.audio_channels) {
                        Ok(pcm) => tracks.push(Track {
                            data: pcm.samples.clone(),
                            start_sample: (ea.start_ms.max(0.0) / 1000.0 * timeline.sample_rate as f64).round() as i64,
                            gain: ea.volume.clamp(0.0, 2.0) as f32,
                            speed: 1.0,
                            loop_src: false,
                        }),
                        Err(e) => log::warn!("[rust-engine] extra audio decode `{}`: {}", ea.path, e),
                    }
                }

                let out = if tracks.is_empty() {
                    Ok(Vec::new())
                } else {
                    let total_samples = (timeline.total_ms / 1000.0 * timeline.sample_rate as f64).ceil() as usize;
                    Ok(audio::mixdown(
                        &tracks,
                        total_samples,
                        timeline.audio_channels as usize,
                        ((timeline.fade_in_ms / 1000.0) * timeline.sample_rate as f64).round() as usize,
                        ((timeline.fade_out_ms / 1000.0) * timeline.sample_rate as f64).round() as usize,
                    ))
                };
                let _ = audio_tx.send(out);
            })
            .map_err(|e| format!("audio thread spawn failed: {}", e))?;
    }

    // ── PRODUCER THREAD (decode-ahead + layer building) ──────────────────
    let (tx, rx) = sync_channel::<ProducerMsg>(4);
    {
        let ff = ff.clone();
        let timeline = timeline.clone();
        let base = base.clone();
        let overlays = overlays.clone();
        let image_bitmaps = image_bitmaps.clone();
        let texts = texts.clone();
        let watermark = watermark.clone();
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
                        match VideoSource::new(ff.clone(), &seg.path) {
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
                        &image_bitmaps,
                        &mut video_sources,
                        &texts,
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
                ring_pos = (ring_pos + 1) % FRAME_RING;
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
                            let copy_plane = |dst: *mut u8, dst_ls: i32, src: &[u8], src_stride: usize, rows: usize, row_bytes: usize| {
                                for row in 0..rows {
                                    let d = dst.add(row * dst_ls.max(1) as usize);
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
                                let dst_ls = ff.frame_linesize(avframe.raw, 1);
                                for row in 0..uv_rows {
                                    let d = dst.add(row * dst_ls.max(1) as usize);
                                    let s = &frame_bytes[y_plane_bytes + row * y_stride..y_plane_bytes + row * y_stride + uv_row_bytes];
                                    std::ptr::copy_nonoverlapping(s.as_ptr(), d, uv_row_bytes);
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
                            if drain_video_encoder(&ff, venc.ctx.raw, pkt.raw, oc.raw, vstream, &v_tb_enc, &v_tb, &mut wrote_packets)? == 0 {
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
                drain_video_encoder(&ff, venc.ctx.raw, pkt.raw, oc.raw, vstream, &v_tb_enc, &v_tb, &mut wrote_packets)?;
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
    drain_video_encoder(&ff, venc.ctx.raw, pkt.raw, oc.raw, vstream, &v_tb_enc, &v_tb, &mut wrote_packets)?;
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
                    ff.packet_set_stream_index(pkt.raw, vstream_idx_of(oc.raw, astream, &ff));
                    let w = unsafe { (ff.syms.av_interleaved_write_frame)(oc.raw, pkt.raw) };
                    ff.packet_unref(pkt.raw);
                    if w < 0 {
                        return Err(format!("write audio packet: {}", ff.err2str(w)));
                    }
                }
                sample_pos += take * chn;
                let frac = (sample_pos as f64 / mixed.len().max(1) as f64).min(1.0);
                progress(ProgressEvent {
                    phase: "audio".into(),
                    percent: 92.0 + 6.0 * frac,
                    fps: 0.0,
                    timemark_sec: total_sec,
                });
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
                        ff.packet_set_stream_index(pkt.raw, vstream_idx_of(oc.raw, astream, &ff));
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

#[allow(clippy::too_many_arguments)]
fn build_frame_job(
    k: u64,
    timeline: &Timeline,
    t: f64,
    base: &[usize],
    overlays: &[usize],
    image_bitmaps: &std::collections::HashMap<usize, Bitmap>,
    video_sources: &mut std::collections::HashMap<usize, VideoSource>,
    texts: &[(usize, TextLayer, f64, f64, f64)],
    watermark: &Option<TextLayer>,
    decode_ms: &mut i64,
    cw: u32,
    ch: u32,
) -> Result<FrameJob, String> {
    let mut layers: Vec<Layer> = Vec::new();
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
            let src_t = (seg.trim_in_ms / 1000.0) + local_t * seg.speed;
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
    for &oi in overlays.iter() {
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
            let src_dur = seg.source_duration_ms.unwrap_or(0.0) / 1000.0;
            let mut src_t = seg.trim_in_ms / 1000.0 + local_t * seg.speed;
            if seg.overlay_loop && src_dur > 0.05 {
                src_t = seg.trim_in_ms / 1000.0 + ((local_t * seg.speed) % src_dur);
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
            let dest = (
                ((gx - gw / 2.0).clamp(0.0, 1.0)) as f32,
                ((gy - gh / 2.0).clamp(0.0, 1.0)) as f32,
                gw as f32,
                gh as f32,
            );
            let ov_gain = if dissolve_head { 1.0 } else { fade_gain };
            layers.push(Layer {
                bitmap: bmp,
                crop: (0.0, 0.0, 1.0, 1.0),
                dest,
                alpha: (seg.opacity as f32) * ov_gain,
                chroma: seg.chroma.clone(),
                dynamic: seg.media_type == "video",
            });
        }
    }

    // ── texts (pre-rasterized, NEVER dip-faded — the layering contract:
    //    captions/headlines render above dip/bookend fades) + watermark ──
    let mut text_layers: Vec<TextLayer> = Vec::new();
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
    if let Some(wm) = watermark {
        text_layers.push(wm.clone());
    }

    Ok(FrameJob { k, layers, texts: text_layers, background })
}

/// Drain the video encoder into the muxer. Returns how many packets were
/// written (0 when the encoder has none yet — EAGAIN).
#[allow(clippy::too_many_arguments)]
fn drain_video_encoder(
    ff: &FFmpegLibs,
    ctx: *mut u8,
    pkt: *mut u8,
    oc: *mut u8,
    vstream: *mut u8,
    v_tb_enc: &Rational,
    v_tb: &Rational,
    wrote_packets: &mut u64,
) -> Result<usize, String> {
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
        ff.packet_set_stream_index(pkt, vstream_idx_of(oc, vstream, ff));
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
