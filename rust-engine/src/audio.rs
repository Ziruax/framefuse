//! Audio bus — DIRECTIVE 6 rule 3: decode all source audio via the runtime
//! `libavformat`/`libavcodec` FFI, convert to interleaved f32 @ output rate
//! with `swresample`, mix the PCM buffers in Rust using `rayon`, then feed
//! the mix to the runtime `libavcodec` AAC encoder (in export.rs). No Web
//! Audio API, no CLI `amix`.

use crate::ffi_offsets::*;
use crate::ffmpeg_ffi::*;
use std::ffi::CString;
use std::sync::Arc;

/// Interleaved f32 PCM at the timeline sample rate.
#[derive(Clone)]
#[allow(dead_code)] // rate/channels carried for future adaptive audio
pub struct PcmBuffer {
    pub samples: Arc<Vec<f32>>,
    pub channels: usize,
    pub rate: u32,
}

/// One placed audio source on the output timeline.
pub struct Track {
    pub data: Arc<Vec<f32>>,
    pub start_sample: i64,
    pub gain: f32,
    /// Playback speed on the source (base-lane video speed).
    pub speed: f64,
    /// Loop the source across the remaining timeline (music / overlay loop).
    pub loop_src: bool,
}

/// RAII cell for a SwrContext that can be REPLACED mid-decode when a source
/// changes stream layout (per-frame re-configure without dangling guards).
struct SwrCell {
    raw: *mut u8,
    free: unsafe extern "C" fn(*mut *mut u8),
}

unsafe impl Send for SwrCell {}

impl SwrCell {
    fn new(raw: *mut u8, free: unsafe extern "C" fn(*mut *mut u8)) -> Self {
        SwrCell { raw, free }
    }
    fn replace(&mut self, new_raw: *mut u8) {
        if !self.raw.is_null() {
            let mut old = self.raw;
            unsafe { (self.free)(&mut old) };
        }
        self.raw = new_raw;
    }
    fn ptr(&self) -> *mut u8 {
        self.raw
    }
}

impl Drop for SwrCell {
    fn drop(&mut self) {
        self.replace(std::ptr::null_mut());
    }
}

fn native_layout(nb_channels: i32) -> [u8; 24] {
    let mut buf = [0u8; 24];
    let mask: u64 = match nb_channels {
        1 => 0x4,
        2 => 0x3,
        n if n < 64 => (1u64 << n) - 1,
        _ => u64::MAX,
    };
    unsafe {
        wr_channel_layout(buf.as_mut_ptr(), 0, nb_channels.max(1), mask);
    }
    buf
}

/// Create a SwrContext → interleaved f32, `out_channels`, `out_rate`, fed
/// from (in_fmt, in_ch, in_rate).
fn make_swr(
    ff: &FFmpegLibs,
    in_fmt: i32,
    in_ch: i32,
    in_rate: i32,
    out_rate: u32,
    out_channels: u32,
) -> Result<*mut u8, String> {
    let out_nb = if out_channels == 1 { 1i32 } else { 2 };
    let out_layout = native_layout(out_nb);
    let in_layout = native_layout(in_ch);
    let mut swr: *mut u8 = std::ptr::null_mut();
    let r = unsafe {
        (ff.syms.swr_alloc_set_opts2)(
            &mut swr,
            out_layout.as_ptr(),
            AV_SAMPLE_FMT_FLT,
            out_rate as i32,
            in_layout.as_ptr(),
            in_fmt,
            in_rate,
            0,
            std::ptr::null_mut(),
        )
    };
    if r < 0 || swr.is_null() {
        return Err("swr_alloc_set_opts2 failed".into());
    }
    let r = unsafe { (ff.syms.swr_init)(swr) };
    if r < 0 {
        let mut s = swr;
        unsafe { (ff.syms.swr_free)(&mut s) };
        return Err(format!("swr_init: {}", ff.err2str(r)));
    }
    Ok(swr)
}

/// v0.3: add ONE track into an existing interleaved mix buffer (the audio
/// thread mixes per-track so a large decoded source can be dropped right
/// after its pass — peak RAM = mix + largest track, not the SUM of all
/// tracks). Slice math identical to the v2 mixdown inner loop.
pub fn mix_into(out: &mut [f32], t: &Track, channels: usize) {
    let chans = channels.max(1);
    use rayon::prelude::*;
    let chunk = 4096 * chans;
    out.par_chunks_mut(chunk).enumerate().for_each(|(ci, slice)| {
        let base = ci * chunk;
        for (i, o) in slice.iter_mut().enumerate() {
            let gi = base + i; // global interleaved index
            let sample_idx = gi / chans;
            let sub = gi % chans;
            let tc = if t.data.len() % chans == 0 { chans } else { 1 };
            if tc != chans && sub != 0 {
                continue;
            }
            let sidx = if tc == chans { gi } else { sample_idx };
            let t_start = (t.start_sample.max(0) as usize) * chans;
            if sidx < t_start {
                continue;
            }
            // timeline sample → source sample: source window spans
            // (timeline window × speed) — multiply, not divide.
            let local = (sidx - t_start) as f64 * t.speed;
            let len = t.data.len() / tc;
            let li = local as usize;
            let v = if li < len {
                let base_idx = t_start + li * chans;
                let a = base_idx.min(t.data.len().saturating_sub(chans.max(1)));
                let b = (a + chans).min(t.data.len().saturating_sub(1));
                let v0 = t.data[a];
                let v1 = t.data[b];
                let f = (local - li as f64) as f32;
                v0 + (v1 - v0) * f
            } else if t.loop_src && len > 0 {
                let m = li % len;
                t.data[m * tc + sub.min(tc - 1)]
            } else {
                continue;
            };
            *o += v * t.gain;
        }
    });
}

// ── v0.3 EBU R128 K-WEIGHTED LOUDNESS (the loudnorm measurement parity,
// in-process — no ffmpeg CLI child). ITU-R BS.1770-4: two-stage K-filter
// (high shelf + high pass, the reference coefficients at 48 kHz — the
// engine's fixed bus rate; other rates return None so the caller keeps the
// natural level rather than guessing), 400 ms blocks with 75 % overlap,
// −70 LUFS absolute gate + relative −10 LU gate. ─────────────────────

/// Integrated loudness (LUFS) of an interleaved f32 buffer, or None when
/// the buffer is too short / the rate is not 48 kHz.
pub fn measure_lufs(samples: &[f32], channels: usize, rate: u32) -> Option<f64> {
    if rate != 48000 || channels == 0 || samples.len() < channels * 4800 {
        return None; // < 100 ms — not measurable
    }
    // stage 1: high shelf (ITU/EBU reference @ 48 kHz)
    let s1 = [
        1.53512485958697f64,
        -2.69169618940638f64,
        1.19839281085285f64,
        -1.69065929318241f64,
        0.73248077421585f64,
    ];
    // stage 2: high pass (ITU/EBU reference @ 48 kHz)
    let s2 = [
        1.0f64,
        -2.0f64,
        1.0f64,
        -1.99004745483398f64,
        0.99007225036621f64,
    ];
    let block_len = 19200usize; // 400 ms @ 48 kHz
    let step = 4800usize; // 100 ms → 75 % overlap
    let n = samples.len() / channels;
    let n_blocks = if n >= block_len { 1 + (n - block_len) / step } else { 0 };
    if n_blocks == 0 {
        return None;
    }

    // per-channel K-weighted mean-square per block, summed across channels
    // (BS.1770: the block loudness is the channel SUM, not the average).
    // ONE filter pass per channel; each sample's energy lands in every block
    // whose 400 ms window covers it (blocks step by 100 ms → ≤4 blocks).
    let mut blocks: Vec<f64> = vec![0.0f64; n_blocks];
    for ch in 0..channels {
        // biquad states for the two cascaded stages
        let (mut x1_1, mut x2_1, mut y1_1, mut y2_1) = (0f64, 0f64, 0f64, 0f64);
        let (mut x1_2, mut x2_2, mut y1_2, mut y2_2) = (0f64, 0f64, 0f64, 0f64);
        for i in 0..n {
            let x = samples[i * channels + ch] as f64;
            // stage 1
            let y_a = s1[0] * x + s1[1] * x1_1 + s1[2] * x2_1 - s1[3] * y1_1 - s1[4] * y2_1;
            x2_1 = x1_1;
            x1_1 = x;
            y2_1 = y1_1;
            y1_1 = y_a;
            // stage 2
            let y = s2[0] * y_a + s2[1] * x1_2 + s2[2] * x2_2 - s2[3] * y1_2 - s2[4] * y2_2;
            x2_2 = x1_2;
            x1_2 = y_a;
            y2_2 = y1_2;
            y1_2 = y;
            // sample i belongs to block b when b*step ≤ i < b*step+block_len:
            // b ∈ [ (i+1-block_len)/step , i/step ] (floor, clamped ≥ 0)
            let last = i / step;
            let first = if i + 1 >= block_len { (i + 1 - block_len) / step } else { 0 };
            let z = y * y;
            let mut b = first;
            while b <= last && b < n_blocks {
                blocks[b] += z;
                b += 1;
            }
        }
    }
    // BS.1770-4: the block loudness is the SUM of the per-channel
    // mean-squares (each channel contributes z_j = (1/N)Σx²) — divide the
    // channel-accumulated energy by block_len ONLY (the old
    // block_len×channels division averaged instead of summing: −3 dB on
    // every stereo measurement).
    for b in blocks.iter_mut() {
        *b /= block_len as f64;
    }

    // gating (BS.1770-4): absolute −70 LUFS, then relative −10 LU
    let lu = |z: f64| -0.691 + 10.0 * z.max(1e-12).log10();
    let abs_kept: Vec<f64> = blocks.iter().copied().filter(|&z| lu(z) > -70.0).collect();
    if abs_kept.is_empty() {
        return None;
    }
    let abs_mean = abs_kept.iter().sum::<f64>() / abs_kept.len() as f64;
    let rel_thresh = lu(abs_mean) - 10.0;
    let rel_kept: Vec<f64> = abs_kept
        .iter()
        .copied()
        .filter(|&z| lu(z) > rel_thresh)
        .collect();
    if rel_kept.is_empty() {
        return None;
    }
    let mean = rel_kept.iter().sum::<f64>() / rel_kept.len() as f64;
    Some(-0.691 + 10.0 * mean.max(1e-12).log10())
}

/// v0.3 measurement window (the v1.33.5 policy parity): ≤ 120 s → measure
/// whole; longer → a 90 s sample starting 20 % in (past silent intros /
/// fades). EBU R128 I converges — ±½ LU on a static gain is inaudible — and
/// the measurement cost stays CONSTANT regardless of source length.
pub fn windowed_lufs(samples: &[f32], channels: usize, rate: u32) -> Option<f64> {
    let chans = channels.max(1);
    let n = samples.len() / chans;
    let dur = n as f64 / rate as f64;
    let (start, take) = if dur <= 120.0 {
        (0usize, n)
    } else {
        let start = ((dur * 0.20) * rate as f64) as usize;
        let take = (90.0 * rate as f64) as usize;
        (start.min(n.saturating_sub(1)), take.min(n))
    };
    if take < 1 || start >= n {
        return None;
    }
    let end = (start + take).min(n);
    let slice = &samples[start * chans..end * chans];
    measure_lufs(slice, chans, rate)
}


// ── v0.3.1 STREAMING AUDIO DECODER (bounded-memory mixing) ─────────────────
// Whole-file decode (the v0.2 path) holds the ENTIRE resampled track in RAM
// next to the mix buffer: a 69-minute source is 2×1.6 GB — beyond low-RAM
// machines (the 4-core/0-GPU target). The stream reader decodes in bounded
// windows while the caller mixes each into the output immediately: peak RAM
// = mix + one window (~23 MB at 60 s), for ANY source length. The decoder
// stays open across windows (sequential reads — sample-accurate stitching,
// no per-chunk seek drift); `seek_start` handles loop replays.

/// The per-stream decode state (owned by exactly one thread — the audio
/// thread — matching the VideoSource rule).
pub struct AudioStream {
    ff: Arc<FFmpegLibs>,
    fc: PtrGuard,
    astream: i32,
    dec: PtrGuard,
    frame: PtrGuard,
    pkt: PtrGuard,
    swr: SwrCell,
    cur_cfg: (i32, i32, i32),
    out_rate: u32,
    out_channels: u32,
    eof: bool,
}

unsafe impl Send for AudioStream {}

impl AudioStream {
    pub fn open(ff: Arc<FFmpegLibs>, path: &str, out_rate: u32, out_channels: u32) -> Result<Self, String> {
        let c_path = CString::new(path).map_err(|e| format!("bad path: {}", e))?;
        let mut fc: *mut u8 = std::ptr::null_mut();
        let r = unsafe {
            (ff.syms.avformat_open_input)(&mut fc, c_path.as_ptr(), std::ptr::null_mut(), std::ptr::null_mut())
        };
        if r < 0 || fc.is_null() {
            return Err(format!("audio open failed for `{}`: {}", path, ff.err2str(r)));
        }
        let fc = PtrGuard::new(fc, ff.syms.avformat_close_input).map_err(|e| e)?;
        unsafe { (ff.syms.avformat_find_stream_info)(fc.raw, std::ptr::null_mut()) };
        let astream = unsafe {
            (ff.syms.avformat_find_best_stream)(fc.raw, AVMEDIA_TYPE_AUDIO, -1, -1, std::ptr::null_mut(), 0)
        };
        if astream < 0 {
            return Err(format!("no audio stream in `{}`", path));
        }
        let st = ff.fmt_streams(fc.raw, astream as usize);
        if st.is_null() {
            return Err("audio stream lookup failed".into());
        }
        let par = ff.stream_codecpar(st);
        let codec_id = ff.par_codec_id(par);
        let codec = unsafe { (ff.syms.avcodec_find_decoder)(codec_id) };
        if codec.is_null() {
            return Err(format!("no decoder for audio codec id {}", codec_id));
        }
        let dec = unsafe { (ff.syms.avcodec_alloc_context3)(codec) };
        if dec.is_null() {
            return Err("avcodec_alloc_context3(audio stream) failed".into());
        }
        let dec = PtrGuard::new(dec, ff.syms.avcodec_free_context).map_err(|e| e)?;
        let r = unsafe { (ff.syms.avcodec_parameters_to_context)(dec.raw, par) };
        if r < 0 {
            return Err(format!("audio parameters_to_context: {}", ff.err2str(r)));
        }
        ff.cc_set_threads_auto(dec.raw);
        let r = unsafe { (ff.syms.avcodec_open2)(dec.raw, codec, std::ptr::null_mut()) };
        if r < 0 {
            return Err(format!("audio decoder open: {}", ff.err2str(r)));
        }
        let frame = ff.frame_alloc()?;
        let pkt = ff.packet_alloc()?;
        let swr_free = ff.syms.swr_free;
        Ok(AudioStream {
            ff,
            fc,
            astream,
            dec,
            frame,
            pkt,
            swr: SwrCell::new(std::ptr::null_mut(), swr_free),
            cur_cfg: (-1, -1, -1),
            out_rate,
            out_channels,
            eof: false,
        })
    }

    /// Decode + resample the NEXT `want_frames` frames (output rate) from
    /// the current position. Returns an empty buffer at EOF.
    pub fn next_window(&mut self, want_frames: usize) -> Result<PcmBuffer, String> {
        if self.eof || want_frames == 0 {
            return Ok(PcmBuffer { samples: Arc::new(Vec::new()), channels: self.out_channels as usize, rate: self.out_rate });
        }
        let oc = (if self.out_channels == 1 { 1 } else { 2 }) as usize;
        let mut samples: Vec<f32> = Vec::with_capacity(want_frames * oc);
        let mut frames_got = 0usize;
        while frames_got < want_frames {
            let fr = unsafe { (self.ff.syms.avcodec_receive_frame)(self.dec.raw, self.frame.raw) };
            if fr == AVERROR_EAGAIN {
                // need more input
                loop {
                    let pr = unsafe { (self.ff.syms.av_read_frame)(self.fc.raw, self.pkt.raw) };
                    if pr < 0 {
                        if pr == AVERROR_EOF {
                            // v0.3.1 ONE-SHOT drain (the VideoSource lesson:
                            // a second send_packet(NULL) after the drain
                            // started resets frame-thread state and the
                            // decoder EAGAINs forever — an infinite loop).
                            if !self.eof {
                                let s = unsafe { (self.ff.syms.avcodec_send_packet)(self.dec.raw, std::ptr::null()) };
                                self.eof = true;
                                if s < 0 && s != AVERROR_EOF && s != AVERROR_EAGAIN {
                                    return Err(format!("audio drain flush: {}", self.ff.err2str(s)));
                                }
                                continue; // drain the remaining real frames
                            }
                            // already drained + demuxer at EOF: nothing more,
                            // ever — return what this window collected.
                            return Ok(PcmBuffer {
                                samples: Arc::new(samples),
                                channels: self.out_channels as usize,
                                rate: self.out_rate,
                            });
                        }
                        return Err(format!("audio read: {}", self.ff.err2str(pr)));
                    }
                    let idx = unsafe { rd_i32(self.pkt.raw, AVPACKET_STREAM_INDEX) };
                    if idx == self.astream {
                        let sent = unsafe { (self.ff.syms.avcodec_send_packet)(self.dec.raw, self.pkt.raw) };
                        self.ff.packet_unref(self.pkt.raw);
                        if sent < 0 && sent != AVERROR_EAGAIN && sent != AVERROR_EOF {
                            return Err(format!("audio send_packet: {}", self.ff.err2str(sent)));
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
                break;
            }
            if fr != 0 {
                return Err(format!("audio receive_frame: {}", self.ff.err2str(fr)));
            }
            // v0.3.1 phantom guard: audio drain frames may be empty
            // (0 samples / NOPTS) — skip, never trust them.
            let nb = self.ff.frame_nb_samples(self.frame.raw).max(0) as usize;
            if nb == 0 {
                self.ff.frame_unref(&self.frame);
                if self.eof {
                    break;
                }
                continue;
            }
            let in_fmt = self.ff.frame_format(self.frame.raw);
            let in_ch = self.ff.frame_channels(self.frame.raw).max(1) as i32;
            let in_sr = if self.ff.frame_sample_rate(self.frame.raw) > 0 {
                self.ff.frame_sample_rate(self.frame.raw)
            } else {
                44100
            };
            let cfg = (in_fmt, in_ch, in_sr);
            if cfg != self.cur_cfg {
                let fresh = make_swr(&self.ff.clone(), in_fmt, in_ch, in_sr, self.out_rate, self.out_channels)?;
                self.swr.replace(fresh);
                self.cur_cfg = cfg;
            }
            let est = ((nb * in_sr as usize) / (self.out_rate as usize) + 64) * oc;
            let mut out = vec![0f32; est];
            let in_planes = unsafe { self.ff.frame_extended_data(self.frame.raw) };
            unsafe {
                let mut out_ptr = out.as_mut_ptr();
                let got = (self.ff.syms.swr_convert)(
                    self.swr.ptr(),
                    (&mut out_ptr) as *mut *mut f32 as *mut *mut u8,
                    (est / oc) as i32,
                    in_planes as *const *const u8,
                    nb as i32,
                );
                if got > 0 {
                    let total = (got as usize) * oc;
                    samples.extend_from_slice(&out[..total]);
                    frames_got += got as usize;
                }
            }
            self.ff.frame_unref(&self.frame);
        }
        Ok(PcmBuffer { samples: Arc::new(samples), channels: self.out_channels as usize, rate: self.out_rate })
    }

    /// Seek back to the stream start (loop replay). AAC/MP3 seek to 0 is
    /// the same priming state as a fresh open — loop cycles stitch exactly
    /// like the v0.2 whole-decode loop did.
    pub fn seek_start(&mut self) -> Result<(), String> {
        self.seek_sec(0.0)
    }

    /// Seek to ~`sec` (packet-inexact on AAC/MP3 — fine for measurement
    /// windows and loop replays; the sequential mix path never re-seeks
    /// mid-stream so stitching stays sample-accurate).
    pub fn seek_sec(&mut self, sec: f64) -> Result<(), String> {
        let st = self.ff.fmt_streams(self.fc.raw, self.astream as usize);
        let tb = if !st.is_null() { self.ff.stream_time_base(st) } else { crate::ffmpeg_ffi::Rational::new(1, self.out_rate as i32) };
        let tb_f = if tb.den > 0 { tb.as_f64() } else { 1.0 / self.out_rate as f64 };
        let ts = ((sec / tb_f).round() as i64).max(0);
        unsafe {
            let r = (self.ff.syms.av_seek_frame)(self.fc.raw, self.astream, ts, 1);
            if r < 0 {
                return Err(format!("audio seek: {}", self.ff.err2str(r)));
            }
            (self.ff.syms.avcodec_flush_buffers)(self.dec.raw);
        }
        self.eof = false;
        Ok(())
    }

    pub fn at_eof(&self) -> bool {
        self.eof
    }
}

/// The container duration of an audio file, in seconds (the streaming
/// mixer's cycle-bound estimate; EOF pins the exact length).
pub fn audio_duration_sec(ff: &FFmpegLibs, path: &str) -> f64 {
    let c_path = match CString::new(path) {
        Ok(c) => c,
        Err(_) => return 0.0,
    };
    let mut fc: *mut u8 = std::ptr::null_mut();
    let r = unsafe {
        (ff.syms.avformat_open_input)(&mut fc, c_path.as_ptr(), std::ptr::null_mut(), std::ptr::null_mut())
    };
    if r < 0 || fc.is_null() {
        return 0.0;
    }
    let guard = match PtrGuard::new(fc, ff.syms.avformat_close_input) {
        Ok(g) => g,
        Err(_) => return 0.0,
    };
    // v0.6: find_stream_info FIRST — MP3s (and several containers) leave
    // duration = AV_NOPTS after a bare open_input; the estimate lands during
    // stream-info probing. AV_NOPTS (i64::MIN) reads as 0 (not measured).
    unsafe { (ff.syms.avformat_find_stream_info)(guard.raw, std::ptr::null_mut()) };
    let d_us = unsafe {
        let base = (guard.raw as *const u8).add(AVFMTCTX_DURATION) as *const i64;
        let v = base.read_unaligned();
        if v == i64::MIN { 0 } else { v }
    };
    if d_us > 0 {
        d_us as f64 / 1_000_000.0
    } else {
        0.0
    }
}

// ── v0.6 MEASURE DECODE (restored v1.33.7 path, capped) ─────────────────────
// The streaming AudioStream measure hit a spurious early-EOF on interleaved
// MP4s (video segment as audio source: ~4 packets then av_read_frame EOF,
// zero samples decoded) while the v1.33.7 whole-file decode reads the same
// files end-to-end. Short sources measure through THIS path again; long
// ones keep the windowed mixer measure.
/// Decode an audio stream (or the audio stream of a video) to interleaved
/// f32 at `out_rate`/`out_channels`.
pub fn decode_audio_capped(
    ff: &FFmpegLibs,
    path: &str,
    out_rate: u32,
    out_channels: u32,
    max_frames: usize,
) -> Result<PcmBuffer, String> {
    let c_path = CString::new(path).map_err(|e| format!("bad path: {}", e))?;

    let mut fc: *mut u8 = std::ptr::null_mut();
    let r = unsafe {
        (ff.syms.avformat_open_input)(&mut fc, c_path.as_ptr(), std::ptr::null_mut(), std::ptr::null_mut())
    };
    if r < 0 || fc.is_null() {
        return Err(format!("audio open failed for `{}`: {}", path, ff.err2str(r)));
    }
    let _in_guard = PtrGuard::new(fc, ff.syms.avformat_close_input).map_err(|e| e)?;

    unsafe { (ff.syms.avformat_find_stream_info)(fc, std::ptr::null_mut()) };

    let astream = unsafe {
        (ff.syms.avformat_find_best_stream)(fc, AVMEDIA_TYPE_AUDIO, -1, -1, std::ptr::null_mut(), 0)
    };
    if astream < 0 {
        return Err(format!("no audio stream in `{}`", path));
    }
    let st = ff.fmt_streams(fc, astream as usize);
    if st.is_null() {
        return Err("audio stream lookup failed".into());
    }
    let par = ff.stream_codecpar(st);
    let codec_id = ff.par_codec_id(par);

    let codec = unsafe { (ff.syms.avcodec_find_decoder)(codec_id) };
    if codec.is_null() {
        return Err(format!("no decoder for audio codec id {}", codec_id));
    }
    let dec = unsafe { (ff.syms.avcodec_alloc_context3)(codec) };
    if dec.is_null() {
        return Err("avcodec_alloc_context3(audio) failed".into());
    }
    let _dec_guard = PtrGuard::new(dec, ff.syms.avcodec_free_context).map_err(|e| e)?;
    let r = unsafe { (ff.syms.avcodec_parameters_to_context)(dec, par) };
    if r < 0 {
        return Err(format!("audio parameters_to_context: {}", ff.err2str(r)));
    }
    ff.cc_set_threads_auto(dec);
    let r = unsafe { (ff.syms.avcodec_open2)(dec, codec, std::ptr::null_mut()) };
    if r < 0 {
        return Err(format!("audio decoder open: {}", ff.err2str(r)));
    }

    let oc = (if out_channels == 1 { 1 } else { 2 }) as usize;

    let frame = ff.frame_alloc()?;
    let pkt = ff.packet_alloc()?;
    let mut samples: Vec<f32> = Vec::new();
    let mut swr = SwrCell::new(std::ptr::null_mut(), ff.syms.swr_free);
    let mut cur_cfg: (i32, i32, i32) = (-1, -1, -1);

    'decode: loop {
        let pr = unsafe { (ff.syms.av_read_frame)(fc, pkt.raw) };
        if pr < 0 {
            if pr == AVERROR_EOF {
                break 'decode;
            }
            return Err(format!("audio read: {}", ff.err2str(pr)));
        }
        let idx = unsafe { rd_i32(pkt.raw, AVPACKET_STREAM_INDEX) };
        if idx == astream {
            let sent = unsafe { (ff.syms.avcodec_send_packet)(dec, pkt.raw) };
            ff.packet_unref(pkt.raw);
            if sent < 0 && sent != AVERROR_EAGAIN && sent != AVERROR_EOF {
                return Err(format!("audio send_packet: {}", ff.err2str(sent)));
            }
            loop {
                let fr = unsafe { (ff.syms.avcodec_receive_frame)(dec, frame.raw) };
                if fr == AVERROR_EAGAIN || fr == AVERROR_EOF {
                    break;
                }
                if fr < 0 {
                    return Err(format!("audio receive_frame: {}", ff.err2str(fr)));
                }
                let nb = ff.frame_nb_samples(frame.raw).max(0) as i32;
                let in_fmt = ff.frame_format(frame.raw);
                let in_ch = ff.frame_channels(frame.raw).max(1) as i32;
                let in_sr = if ff.frame_sample_rate(frame.raw) > 0 {
                    ff.frame_sample_rate(frame.raw)
                } else {
                    44100
                };
                let cfg = (in_fmt, in_ch, in_sr);
                if cfg != cur_cfg {
                    let fresh = make_swr(ff, in_fmt, in_ch, in_sr, out_rate, out_channels)?;
                    swr.replace(fresh);
                    cur_cfg = cfg;
                }
                if samples.len() / oc >= max_frames {
                    break 'decode;
                }
                if nb > 0 {
                    let est = ((nb as usize) * (in_sr as usize) / (out_rate as usize) + 64) * oc;
                    let mut out = vec![0f32; est];
                    let in_planes = unsafe { ff.frame_extended_data(frame.raw) };
                    unsafe {
                        let mut out_ptr = out.as_mut_ptr();
                        let got = (ff.syms.swr_convert)(
                            swr.ptr(),
                            (&mut out_ptr) as *mut *mut f32 as *mut *mut u8,
                            (est / oc) as i32,
                            in_planes as *const *const u8,
                            nb,
                        );
                        if got > 0 {
                            let total = (got as usize) * oc;
                            samples.extend_from_slice(&out[..total]);
                        }
                    }
                }
                ff.frame_unref(&frame);
            }
        } else {
            ff.packet_unref(pkt.raw);
        }
    }

    // flush the resampler tail
    if !swr.ptr().is_null() {
        loop {
            let cap = 4096 * oc;
            let mut out = vec![0f32; cap];
            unsafe {
                let mut out_ptr = out.as_mut_ptr();
                let got = (ff.syms.swr_convert)(
                    swr.ptr(),
                    (&mut out_ptr) as *mut *mut f32 as *mut *mut u8,
                    (cap / oc) as i32,
                    std::ptr::null(),
                    0,
                );
                if got <= 0 {
                    break;
                }
                let total = (got as usize) * oc;
                samples.extend_from_slice(&out[..total]);
            }
        }
    }

    Ok(PcmBuffer {
        samples: Arc::new(samples),
        channels: oc,
        rate: out_rate,
    })
}


// ── v0.4 WINDOWED JOB MIXER (bounded RAM for ANY timeline length) ───────────
// The v0.3 audio thread materialized the FULL timeline mix in RAM next to
// the decoded sources (a 69-min stereo f32 mix alone is ~1.6 GB — the
// pagefile blowup users saw on low-RAM machines). The JobMixer is the
// pull-based counterpart: the caller drives OUTPUT windows [a, b) and each
// mixer returns just that window's contribution, decoding sequentially and
// re-seeking only on loop wraps. Peak RAM = pending window + one decode
// window, regardless of timeline or source length.

/// One placed audio job, in mixer terms (output-sample units).
pub struct JobSpec {
    pub path: String,
    /// Output frame where this job begins (from start_ms).
    pub start_sample: i64,
    /// Playback speed (base-lane video speed; 1 for music/VO/SFX).
    pub speed: f64,
    /// Loop the source across the remaining timeline.
    pub loop_src: bool,
}

pub struct JobMixer {
    stream: AudioStream,
    /// Decoded, resampled, interleaved samples not yet consumed (front =
    /// physical source frame `head`).
    pending: std::collections::VecDeque<f32>,
    /// Physical source frame at the front of `pending`.
    head: usize,
    /// Source length in frames — pinned at the first EOF (the loop cycle
    /// length; also the non-loop end).
    len: Option<usize>,
    /// This job can no longer contribute (non-loop, past EOF/end).
    dead: bool,
    chans: usize,
    /// Physical frame index of the NEXT decode (head + pending frames).
    filled: usize,
}

impl JobMixer {
    pub fn open(
        ff: Arc<FFmpegLibs>,
        spec: &JobSpec,
        rate: u32,
        chans: u32,
    ) -> Result<Self, String> {
        let stream = AudioStream::open(ff, &spec.path, rate, chans)?;
        let chans = (if chans == 1 { 1 } else { 2 }) as usize;
        Ok(JobMixer {
            stream,
            pending: std::collections::VecDeque::new(),
            head: 0,
            len: None,
            dead: false,
            chans,
            filled: 0,
        })
    }

    /// True when this job will never contribute again.
    pub fn finished(&self) -> bool {
        self.dead
    }

    /// Decode until the physical buffer covers `until` (or EOF). Returns
    /// false when the stream is at a FINAL EOF (nothing more to decode
    /// without a rewind).
    fn fill_to(&mut self, until: usize, win_frames: usize) -> Result<bool, String> {
        while self.filled < until {
            match self.stream.next_window(win_frames) {
                Ok(w) => {
                    let got = w.samples.len() / self.chans.max(1);
                    if got == 0 {
                        // EOF: pin the source length on the first hit.
                        if self.len.is_none() {
                            self.len = Some(self.filled);
                        }
                        return Ok(false);
                    }
                    self.pending.extend(w.samples.iter().copied());
                    self.filled += got;
                }
                Err(e) => return Err(e),
            }
        }
        Ok(true)
    }

    /// Consume physical frames [from, until) out of `pending` (from ≥ head).
    /// Returns whatever is available (short at EOF).
    fn consume(&mut self, from: usize, until: usize) -> Vec<f32> {
        if from > self.head {
            let skip = (from - self.head) * self.chans;
            let skip = skip.min(self.pending.len());
            self.pending.drain(..skip);
            self.head += skip / self.chans;
        }
        let want = until.saturating_sub(self.head) * self.chans;
        let take = want.min(self.pending.len());
        let out: Vec<f32> = self.pending.drain(..take).collect();
        self.head += take / self.chans;
        out
    }

    /// Rewind to the physical stream start (loop wrap).
    fn rewind(&mut self) -> Result<(), String> {
        self.stream.seek_start()?;
        self.pending.clear();
        self.head = 0;
        self.filled = 0;
        Ok(())
    }

    /// This job's contribution to output frames [a, b): a list of
    /// (interleaved samples, output start frame) chunks. Chunk boundaries
    /// only occur at loop-cycle wraps; speed maps output→source linearly
    /// inside a chunk (mix_into's interpolation math).
    pub fn pull_for(
        &mut self,
        spec: &JobSpec,
        a: usize,
        b: usize,
        win_frames: usize,
    ) -> Result<Vec<(Vec<f32>, i64)>, String> {
        let mut out: Vec<(Vec<f32>, i64)> = Vec::new();
        if self.dead || b as i64 <= spec.start_sample {
            return Ok(out);
        }
        let t0 = spec.start_sample.max(0) as usize;
        let a2 = a.max(t0);
        let speed = spec.speed.max(0.01);
        // UNWRAPPED source position (fractional frames) for output a2 / b.
        let mut src = (a2 - t0) as f64 * speed;
        let src_end = (b - t0) as f64 * speed;
        if !spec.loop_src {
            if let Some(l) = self.len {
                if src >= l as f64 {
                    self.dead = true;
                    return Ok(out);
                }
            }
            if self.stream.at_eof() && self.filled == 0 && self.pending.is_empty() {
                self.dead = true;
                return Ok(out);
            }
        }
        while src < src_end - 1e-9 {
            // Next cycle boundary (loop only, once L is pinned).
            let seg_end = match self.len {
                Some(l) if spec.loop_src && l > 0 => {
                    let l = l as f64;
                    let cyc = (src / l).floor() * l + l;
                    cyc.min(src_end)
                }
                _ => src_end,
            };
            let from = src.ceil().max(0.0) as usize; // physical = unwrapped mod L after rewind
            let until = seg_end.ceil().max(0.0) as usize;
            if until > from {
                let have = self.fill_to(until, win_frames)?;
                let avail_until = if have { until } else { self.filled.max(from) };
                if avail_until > from {
                    let samples = self.consume(from, avail_until);
                    if !samples.is_empty() {
                        // out_start: output frame whose source position is
                        // `from` (unwrapped): x = t0 + from / speed.
                        let x = t0 as f64 + from as f64 / speed;
                        out.push((samples, x.round() as i64));
                    }
                }
                if !have {
                    // EOF hit while filling.
                    if let Some(l) = self.len {
                        if !spec.loop_src || l == 0 {
                            self.dead = true;
                            break;
                        }
                        // loop wrap: rewind and continue the next cycle.
                        self.rewind()?;
                        src = ((src / l as f64).floor() + 1.0) * l as f64;
                        continue;
                    } else {
                        self.dead = true;
                        break;
                    }
                }
                src = until as f64;
            } else {
                src = seg_end;
            }
            // non-loop past the end
            if !spec.loop_src {
                if let Some(l) = self.len {
                    if src >= l as f64 {
                        self.dead = true;
                        break;
                    }
                }
            }
        }
        Ok(out)
    }
}
