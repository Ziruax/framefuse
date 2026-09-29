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

/// Decode an audio stream (or the audio stream of a video) to interleaved
/// f32 at `out_rate`/`out_channels`.
pub fn decode_audio(
    ff: &FFmpegLibs,
    path: &str,
    out_rate: u32,
    out_channels: u32,
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

/// Mix all tracks onto `total_samples` (interleaved, `channels` wide) with
/// rayon chunk parallelism (DIRECTIVE 6 rule 3). Handles per-track start
/// offsets, speed (linear resample), gain, and looping. `fade_in_samples` /
/// `fade_out_samples` apply master-bus ramps (parity with the CLI's
/// afade stages).
pub fn mixdown(
    tracks: &[Track],
    total_samples: usize,
    channels: usize,
    fade_in_samples: usize,
    fade_out_samples: usize,
) -> Vec<f32> {
    let chans = channels.max(1);
    let n = total_samples * chans;
    let mut out = vec![0f32; n];
    use rayon::prelude::*;
    let chunk = 4096 * chans;
    out.par_chunks_mut(chunk).enumerate().for_each(|(ci, slice)| {
        let base = ci * chunk;
        for t in tracks {
            let tc = if t.data.len() % chans == 0 { chans } else { 1 };
            let t_start = (t.start_sample.max(0) as usize) * chans;
            for (i, o) in slice.iter_mut().enumerate() {
                let gi = base + i; // global interleaved index
                let sample_idx = gi / chans;
                let sub = gi % chans;
                if tc != chans && sub != 0 {
                    continue;
                }
                let sidx = if tc == chans { gi } else { sample_idx };
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
        }
    });
    // master-bus fades
    if fade_in_samples > 0 {
        for i in 0..total_samples.min(fade_in_samples) {
            let g = i as f32 / fade_in_samples as f32;
            for c in 0..chans {
                out[i * chans + c] *= g;
            }
        }
    }
    if fade_out_samples > 0 && total_samples > 0 {
        let start = total_samples.saturating_sub(fade_out_samples);
        for i in start..total_samples {
            let g = (total_samples - i) as f32 / fade_out_samples as f32;
            for c in 0..chans {
                out[i * chans + c] *= g;
            }
        }
    }
    for v in out.iter_mut() {
        *v = v.clamp(-1.0, 1.0);
    }
    out
}
