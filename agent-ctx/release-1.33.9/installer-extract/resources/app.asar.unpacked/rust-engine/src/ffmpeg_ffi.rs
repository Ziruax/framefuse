//! Runtime FFmpeg FFI — DIRECTIVE 3: dynamic resolution of C function
//! pointers from the SHARED FFmpeg libraries (avcodec/avformat/avutil/
//! swscale/swresample) that ship inside the app's `resources/ffmpeg`
//! directory.
//!
//! Why libloading instead of link-time binding (ffmpeg-sys/ffmpeg-next):
//! a cdylib with C link deps cannot cross-compile with cargo-xwin, and a
//! statically linked FFmpeg would lose NVENC/QSV/AMF. Runtime dlopen keeps
//! the Rust build pure, guarantees the SAME encoder set as the CLI engine,
//! and upgrades FFmpeg without rebuilding Rust.
//!
//! Safety model:
//! * The supported FFmpeg family is pinned at load time by soname AND
//!   runtime version check: avcodec 61 / avformat 61 / avutil 59 /
//!   swscale 8 / swresample 5 (FFmpeg 7.x — exactly what gyan/BtbN shared
//!   builds and Debian trixie ship). Any mismatch is a clean error → the
//!   Electron router falls back to the CLI pipeline; we never call into a
//!   struct layout we don't own.
//! * All struct field access goes through `ffi_offsets` — constants
//!   mechanically generated from the REAL n7.1 headers via offsetof().
//! * Every allocation is wrapped in a `PtrGuard` whose Drop calls the
//!   matching FFmpeg free function — no VRAM/RAM leaks across the FFI.
//! * No panics on the FFI boundary: null checks, `Result<_, String>`.

// FFI symbol fields mirror their C names (sws_getContext, …) on purpose.
#![allow(non_snake_case)]

use crate::ffi_offsets::*;
use libloading::{Library, Symbol};
use std::ffi::{c_char, c_void, CString};
use std::path::Path;

const _KEEP_SYMBOL_IMPORT: Option<Symbol<'static, unsafe extern "C" fn()>> = None;

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Rational {
    pub num: i32,
    pub den: i32,
}

impl Rational {
    pub fn new(num: i32, den: i32) -> Self {
        Rational { num, den }
    }
    pub fn as_f64(&self) -> f64 {
        if self.den == 0 {
            0.0
        } else {
            self.num as f64 / self.den as f64
        }
    }
}

// ── raw field accessors (unaligned reads/writes at generated offsets) ──────

#[inline]
pub(crate) unsafe fn rd_i32(p: *mut u8, off: usize) -> i32 {
    (p.add(off) as *const i32).read_unaligned()
}
#[inline]
pub(crate) unsafe fn wr_i32(p: *mut u8, off: usize, v: i32) {
    (p.add(off) as *mut i32).write_unaligned(v)
}
#[inline]
pub(crate) unsafe fn rd_i64(p: *mut u8, off: usize) -> i64 {
    (p.add(off) as *const i64).read_unaligned()
}
#[inline]
pub(crate) unsafe fn wr_i64(p: *mut u8, off: usize, v: i64) {
    (p.add(off) as *mut i64).write_unaligned(v)
}
#[inline]
pub(crate) unsafe fn rd_ptr(p: *mut u8, off: usize) -> *mut u8 {
    (p.add(off) as *const *mut u8).read_unaligned()
}
#[inline]
#[allow(dead_code)]
pub(crate) unsafe fn wr_ptr(p: *mut u8, off: usize, v: *mut u8) {
    (p.add(off) as *mut *mut u8).write_unaligned(v)
}
#[inline]
pub(crate) unsafe fn rd_rational(p: *mut u8, off: usize) -> Rational {
    Rational {
        num: rd_i32(p, off),
        den: rd_i32(p, off + 4),
    }
}
#[inline]
pub(crate) unsafe fn wr_rational(p: *mut u8, off: usize, v: Rational) {
    wr_i32(p, off, v.num);
    wr_i32(p, off + 4, v.den);
}

/// Writes an AVChannelLayout { order=NATIVE, nb_channels, u.mask } blob at
/// `off`. Only native mono/stereo layouts are used by this engine.
#[inline]
pub(crate) unsafe fn wr_channel_layout(p: *mut u8, off: usize, nb_channels: i32, mask: u64) {
    wr_i32(p, off + AVCHANNELLAYOUT_ORDER, AV_CHANNEL_ORDER_NATIVE);
    wr_i32(p, off + AVCHANNELLAYOUT_NB_CHANNELS, nb_channels);
    (p.add(off + AVCHANNELLAYOUT_U_MASK) as *mut u64).write_unaligned(mask);
}

#[inline]
pub(crate) unsafe fn rd_channel_nb(p: *mut u8, off: usize) -> i32 {
    rd_i32(p, off + AVCHANNELLAYOUT_NB_CHANNELS)
}

// ── symbol table ───────────────────────────────────────────────────────────

// The full table is resolved once; unused entries are kept for the Phase-2/3
// paths (av_opt_set, av_malloc, …) rather than re-plumbing loads.
#[allow(dead_code)]
pub struct FFSyms {
    // avutil
    pub avutil_version: unsafe extern "C" fn() -> u32,
    pub av_log_set_level: unsafe extern "C" fn(level: i32),
    pub av_malloc: unsafe extern "C" fn(size: usize) -> *mut u8,
    pub av_free: unsafe extern "C" fn(ptr: *mut u8),
    pub av_frame_alloc: unsafe extern "C" fn() -> *mut u8,
    pub av_frame_free: unsafe extern "C" fn(frame: *mut *mut u8),
    pub av_frame_unref: unsafe extern "C" fn(frame: *mut u8),
    pub av_frame_make_writable: unsafe extern "C" fn(frame: *mut u8) -> i32,
    pub av_frame_get_buffer: unsafe extern "C" fn(frame: *mut u8, align: i32) -> i32,
    pub av_dict_set: unsafe extern "C" fn(pm: *mut *mut u8, key: *const c_char, value: *const c_char, flags: i32) -> i32,
    pub av_dict_free: unsafe extern "C" fn(pm: *mut *mut u8),
    pub av_opt_set: unsafe extern "C" fn(obj: *mut c_void, name: *const c_char, val: *const c_char, search_flags: i32) -> i32,
    pub av_strerror: unsafe extern "C" fn(errnum: i32, errbuf: *mut c_char, errbuf_size: usize) -> i32,
    // avcodec
    pub avcodec_version: unsafe extern "C" fn() -> u32,
    pub avcodec_find_encoder_by_name: unsafe extern "C" fn(name: *const c_char) -> *mut u8,
    pub avcodec_find_decoder: unsafe extern "C" fn(id: i32) -> *mut u8,
    pub avcodec_alloc_context3: unsafe extern "C" fn(codec: *const u8) -> *mut u8,
    pub avcodec_free_context: unsafe extern "C" fn(avctx: *mut *mut u8),
    pub avcodec_parameters_to_context: unsafe extern "C" fn(codec_ctx: *mut u8, par: *const u8) -> i32,
    pub avcodec_parameters_from_context: unsafe extern "C" fn(par: *mut u8, codec_ctx: *const u8) -> i32,
    pub avcodec_open2: unsafe extern "C" fn(avctx: *mut u8, codec: *const u8, options: *mut *mut u8) -> i32,
    pub avcodec_send_frame: unsafe extern "C" fn(avctx: *mut u8, frame: *const u8) -> i32,
    pub avcodec_receive_packet: unsafe extern "C" fn(avctx: *mut u8, avpkt: *mut u8) -> i32,
    pub avcodec_send_packet: unsafe extern "C" fn(avctx: *mut u8, avpkt: *const u8) -> i32,
    pub avcodec_receive_frame: unsafe extern "C" fn(avctx: *mut u8, frame: *mut u8) -> i32,
    pub avcodec_flush_buffers: unsafe extern "C" fn(avctx: *mut u8),
    pub av_packet_alloc: unsafe extern "C" fn() -> *mut u8,
    pub av_packet_free: unsafe extern "C" fn(pkt: *mut *mut u8),
    pub av_packet_unref: unsafe extern "C" fn(pkt: *mut u8),
    pub av_packet_rescale_ts: unsafe extern "C" fn(pkt: *mut u8, tb_src: Rational, tb_dst: Rational),
    /// v0.4 (loop dedup): allocate a refcounted data buffer on a packet so
    /// cloned bitstream packets can be handed to av_interleaved_write_frame
    /// without aliasing encoder-owned memory.
    pub av_new_packet: unsafe extern "C" fn(pkt: *mut u8, size: i32) -> i32,
    // avformat
    pub avformat_version: unsafe extern "C" fn() -> u32,
    pub avformat_open_input: unsafe extern "C" fn(ps: *mut *mut u8, url: *const c_char, fmt: *mut u8, options: *mut *mut u8) -> i32,
    pub avformat_find_stream_info: unsafe extern "C" fn(ic: *mut u8, options: *mut *mut u8) -> i32,
    pub avformat_find_best_stream: unsafe extern "C" fn(ic: *mut u8, type_: i32, wanted_stream_idx: i32, related_stream: i32, decoder_ret: *mut *mut u8, flags: i32) -> i32,
    pub av_read_frame: unsafe extern "C" fn(ic: *mut u8, pkt: *mut u8) -> i32,
    pub av_seek_frame: unsafe extern "C" fn(ic: *mut u8, stream_index: i32, timestamp: i64, flags: i32) -> i32,
    pub avformat_close_input: unsafe extern "C" fn(s: *mut *mut u8),
    pub avformat_alloc_output_context2: unsafe extern "C" fn(ctx: *mut *mut u8, oformat: *mut u8, format_name: *const c_char, filename: *const c_char) -> i32,
    pub avformat_free_context: unsafe extern "C" fn(s: *mut u8),
    pub avformat_new_stream: unsafe extern "C" fn(s: *mut u8, c: *const u8) -> *mut u8,
    pub avformat_write_header: unsafe extern "C" fn(s: *mut u8, options: *mut *mut u8) -> i32,
    pub av_interleaved_write_frame: unsafe extern "C" fn(s: *mut u8, pkt: *mut u8) -> i32,
    pub av_write_trailer: unsafe extern "C" fn(s: *mut u8) -> i32,
    pub avio_open: unsafe extern "C" fn(s: *mut *mut u8, url: *const c_char, flags: i32) -> i32,
    pub avio_closep: unsafe extern "C" fn(s: *mut *mut u8) -> i32,
    // swscale
    pub swscale_version: unsafe extern "C" fn() -> u32,
    pub sws_getContext: unsafe extern "C" fn(srcW: i32, srcH: i32, srcFormat: i32, dstW: i32, dstH: i32, dstFormat: i32, flags: i32, srcFilter: *mut u8, dstFilter: *mut u8, param: *const f64) -> *mut u8,
    pub sws_scale: unsafe extern "C" fn(c: *mut u8, srcSlice: *const *const u8, srcStride: *const i32, srcSliceY: i32, srcSliceH: i32, dst: *const *mut u8, dstStride: *const i32) -> i32,
    pub sws_freeContext: unsafe extern "C" fn(c: *mut u8),
    // swresample
    pub swresample_version: unsafe extern "C" fn() -> u32,
    pub swr_alloc_set_opts2: unsafe extern "C" fn(ps: *mut *mut u8, out_ch_layout: *const u8, out_sample_fmt: i32, out_sample_rate: i32, in_ch_layout: *const u8, in_sample_fmt: i32, in_sample_rate: i32, log_offset: i32, log_ctx: *mut u8) -> i32,
    pub swr_init: unsafe extern "C" fn(s: *mut u8) -> i32,
    pub swr_convert: unsafe extern "C" fn(s: *mut u8, out: *mut *mut u8, out_count: i32, in_: *const *const u8, in_count: i32) -> i32,
    pub swr_free: unsafe extern "C" fn(s: *mut *mut u8),
}

// FFmpeg library APIs are thread-safe for independent contexts (each
// decoder/encoder/muxer context is confined to one owner thread); the
// library handles themselves are just dlopen module handles.
unsafe impl Send for FFmpegLibs {}
unsafe impl Sync for FFmpegLibs {}

/// Loaded FFmpeg shared libraries + resolved symbols.
///
/// Field order is load-independence order (deps first); Rust drops struct
/// fields in DECLARATION order, so dependents (avformat) drop before their
/// dependencies (avutil) — by the time anything unloads, every context has
/// already been freed by its own guard.
pub struct FFmpegLibs {
    _avformat: Library,
    _avcodec: Library,
    _swscale: Library,
    _swresample: Library,
    _avutil: Library,
    pub syms: FFSyms,
    /// Detected family (e.g. "61/61/59/8/5").
    pub family: String,
}

fn lib_candidates(dir: Option<&Path>, stem: &str, major: u32) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    if let Some(d) = dir {
        // scan the directory for matching shared libraries of any version
        if let Ok(rd) = std::fs::read_dir(d) {
            let mut hits: Vec<(u32, std::path::PathBuf)> = Vec::new();
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let lower = name.to_lowercase();
                let is_dll = lower.starts_with(&format!("{}-", stem)) && lower.ends_with(".dll");
                let is_so = lower.starts_with(&format!("lib{}.so", stem));
                if is_dll || is_so {
                    // extract version digits after the stem
                    let rest: String = if is_so {
                        lower.replace(&format!("lib{}.so", stem), "")
                    } else {
                        lower.replace(&format!("{}-", stem), "").replace(".dll", "")
                    };
                    let ver: u32 = rest
                        .chars()
                        .skip_while(|c| *c == '.')
                        .take_while(|c| c.is_ascii_digit())
                        .collect::<String>()
                        .parse()
                        .unwrap_or(0);
                    hits.push((ver, entry.path()));
                }
            }
            hits.sort_by(|a, b| b.0.cmp(&a.0)); // highest first
            for (v, p) in hits.iter() {
                if *v == major {
                    out.push(p.clone());
                }
            }
            // no exact match: remember the highest available for the error message
            if out.is_empty() {
                if let Some((v, p)) = hits.first() {
                    out.push(p.clone());
                    let _ = v;
                }
            }
        }
        // exact soname fallbacks inside the dir
        let win = format!("{}-{}.dll", stem, major);
        let lin = format!("lib{}.so.{}", stem, major);
        out.push(d.join(&win));
        out.push(d.join(&lin));
    }
    // system-mode sonames (dlopen searches the OS loader path)
    if cfg!(windows) {
        out.push(std::path::PathBuf::from(format!("{}-{}.dll", stem, major)));
    } else {
        out.push(std::path::PathBuf::from(format!("lib{}.so.{}", stem, major)));
        out.push(std::path::PathBuf::from(format!("lib{}.so", stem)));
    }
    out
}

fn load_lib(path: &Path, stem: &str) -> Result<Library, String> {
    unsafe { Library::new(path) }
        .map_err(|e| format!("failed to load {} (`{}`): {}", stem, path.display(), e))
}

impl FFmpegLibs {
    /// Load the FFmpeg shared-library family. `ffmpeg_dir` may be empty /
    /// missing → system loader path. Loads dependencies FIRST
    /// (avutil → swresample → swscale → avcodec → avformat) so the OS
    /// loader resolves inter-DLL deps against our handles.
    pub fn load(ffmpeg_dir: &str) -> Result<Self, String> {
        let dir: Option<&Path> = if !ffmpeg_dir.is_empty() && Path::new(ffmpeg_dir).is_dir() {
            Some(Path::new(ffmpeg_dir))
        } else {
            None
        };

        let avutil = Self::load_first(dir, "avutil", 59)?;
        let swresample = Self::load_first(dir, "swresample", 5)?;
        let swscale = Self::load_first(dir, "swscale", 8)?;
        let avcodec = Self::load_first(dir, "avcodec", 61)?;
        let avformat = Self::load_first(dir, "avformat", 61)?;

        // resolve symbols
        let syms = unsafe { Self::resolve(&avutil, &swresample, &swscale, &avcodec, &avformat)? };

        let (family, checks) = unsafe {
            (
                format!(
                    "{}/{}/{}/{}/{}",
                    (syms.avcodec_version)() >> 16,
                    (syms.avformat_version)() >> 16,
                    (syms.avutil_version)() >> 16,
                    (syms.swscale_version)() >> 16,
                    (syms.swresample_version)() >> 16
                ),
                [
                    ((syms.avcodec_version)() >> 16, 61u32, "avcodec"),
                    ((syms.avformat_version)() >> 16, 61, "avformat"),
                    ((syms.avutil_version)() >> 16, 59, "avutil"),
                    ((syms.swscale_version)() >> 16, 8, "swscale"),
                    ((syms.swresample_version)() >> 16, 5, "swresample"),
                ],
            )
        };
        for (got, want, name) in checks {
            if got != want {
                return Err(format!(
                    "FFmpeg family mismatch: {} major is {} but this engine is ABI-pinned to {} (loaded family {}). Install FFmpeg 7.1 shared libraries.",
                    name, got, want, family
                ));
            }
        }

        // quiet FFmpeg unless diagnostics are requested
        let level = match std::env::var("FRAMEFUSE_FFMPEG_LOG").as_deref() {
            Ok("debug") | Ok("trace") => 48,
            Ok("info") => AV_LOG_INFO,
            _ => AV_LOG_WARN,
        };
        unsafe { (syms.av_log_set_level)(level) };

        Ok(FFmpegLibs {
            _avformat: avformat,
            _avcodec: avcodec,
            _swscale: swscale,
            _swresample: swresample,
            _avutil: avutil,
            syms,
            family,
        })
    }

    fn load_first(dir: Option<&Path>, stem: &str, major: u32) -> Result<Library, String> {
        let candidates = lib_candidates(dir, stem, major);
        let mut last_err = String::new();
        for c in &candidates {
            match load_lib(c, stem) {
                Ok(l) => return Ok(l),
                Err(e) => last_err = e,
            }
        }
        Err(format!(
            "no usable shared library for {} (tried {}): {}",
            stem,
            candidates
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", "),
            last_err
        ))
    }

    unsafe fn resolve(
        avutil: &Library,
        swresample: &Library,
        swscale: &Library,
        avcodec: &Library,
        avformat: &Library,
    ) -> Result<FFSyms, String> {
        macro_rules! sym {
            ($lib:expr, $name:literal) => {{
                let bytes: &[u8] = &$name[..];
                match $lib.get::<unsafe extern "C" fn()>(bytes) {
                    Ok(f) => *f,
                    Err(e) => {
                        return Err(format!(
                            "FFmpeg symbol `{}` missing: {}",
                            String::from_utf8_lossy(bytes),
                            e
                        ))
                    }
                }
            }};
        }
        macro_rules! cast {
            ($f:expr, $ty:ty) => {
                std::mem::transmute::<unsafe extern "C" fn(), $ty>($f)
            };
        }

        let f = FFSyms {
            avutil_version: cast!(sym!(avutil, b"avutil_version"), _),
            av_log_set_level: cast!(sym!(avutil, b"av_log_set_level"), _),
            av_malloc: cast!(sym!(avutil, b"av_malloc"), _),
            av_free: cast!(sym!(avutil, b"av_free"), _),
            av_frame_alloc: cast!(sym!(avutil, b"av_frame_alloc"), _),
            av_frame_free: cast!(sym!(avutil, b"av_frame_free"), _),
            av_frame_unref: cast!(sym!(avutil, b"av_frame_unref"), _),
            av_frame_make_writable: cast!(sym!(avutil, b"av_frame_make_writable"), _),
            av_frame_get_buffer: cast!(sym!(avutil, b"av_frame_get_buffer"), _),
            av_dict_set: cast!(sym!(avutil, b"av_dict_set"), _),
            av_dict_free: cast!(sym!(avutil, b"av_dict_free"), _),
            av_opt_set: cast!(sym!(avutil, b"av_opt_set"), _),
            av_strerror: cast!(sym!(avutil, b"av_strerror"), _),
            avcodec_version: cast!(sym!(avcodec, b"avcodec_version"), _),
            avcodec_find_encoder_by_name: cast!(sym!(avcodec, b"avcodec_find_encoder_by_name"), _),
            avcodec_find_decoder: cast!(sym!(avcodec, b"avcodec_find_decoder"), _),
            avcodec_alloc_context3: cast!(sym!(avcodec, b"avcodec_alloc_context3"), _),
            avcodec_free_context: cast!(sym!(avcodec, b"avcodec_free_context"), _),
            avcodec_parameters_to_context: cast!(sym!(avcodec, b"avcodec_parameters_to_context"), _),
            avcodec_parameters_from_context: cast!(sym!(avcodec, b"avcodec_parameters_from_context"), _),
            avcodec_open2: cast!(sym!(avcodec, b"avcodec_open2"), _),
            avcodec_send_frame: cast!(sym!(avcodec, b"avcodec_send_frame"), _),
            avcodec_receive_packet: cast!(sym!(avcodec, b"avcodec_receive_packet"), _),
            avcodec_send_packet: cast!(sym!(avcodec, b"avcodec_send_packet"), _),
            avcodec_receive_frame: cast!(sym!(avcodec, b"avcodec_receive_frame"), _),
            avcodec_flush_buffers: cast!(sym!(avcodec, b"avcodec_flush_buffers"), _),
            av_packet_alloc: cast!(sym!(avcodec, b"av_packet_alloc"), _),
            av_packet_free: cast!(sym!(avcodec, b"av_packet_free"), _),
            av_packet_unref: cast!(sym!(avcodec, b"av_packet_unref"), _),
            av_packet_rescale_ts: cast!(sym!(avcodec, b"av_packet_rescale_ts"), _),
            av_new_packet: cast!(sym!(avcodec, b"av_new_packet"), _),
            avformat_version: cast!(sym!(avformat, b"avformat_version"), _),
            avformat_open_input: cast!(sym!(avformat, b"avformat_open_input"), _),
            avformat_find_stream_info: cast!(sym!(avformat, b"avformat_find_stream_info"), _),
            avformat_find_best_stream: cast!(sym!(avformat, b"av_find_best_stream"), _),
            av_read_frame: cast!(sym!(avformat, b"av_read_frame"), _),
            av_seek_frame: cast!(sym!(avformat, b"av_seek_frame"), _),
            avformat_close_input: cast!(sym!(avformat, b"avformat_close_input"), _),
            avformat_alloc_output_context2: cast!(sym!(avformat, b"avformat_alloc_output_context2"), _),
            avformat_free_context: cast!(sym!(avformat, b"avformat_free_context"), _),
            avformat_new_stream: cast!(sym!(avformat, b"avformat_new_stream"), _),
            avformat_write_header: cast!(sym!(avformat, b"avformat_write_header"), _),
            av_interleaved_write_frame: cast!(sym!(avformat, b"av_interleaved_write_frame"), _),
            av_write_trailer: cast!(sym!(avformat, b"av_write_trailer"), _),
            avio_open: cast!(sym!(avformat, b"avio_open"), _),
            avio_closep: cast!(sym!(avformat, b"avio_closep"), _),
            swscale_version: cast!(sym!(swscale, b"swscale_version"), _),
            sws_getContext: cast!(sym!(swscale, b"sws_getContext"), _),
            sws_scale: cast!(sym!(swscale, b"sws_scale"), _),
            sws_freeContext: cast!(sym!(swscale, b"sws_freeContext"), _),
            swresample_version: cast!(sym!(swresample, b"swresample_version"), _),
            swr_alloc_set_opts2: cast!(sym!(swresample, b"swr_alloc_set_opts2"), _),
            swr_init: cast!(sym!(swresample, b"swr_init"), _),
            swr_convert: cast!(sym!(swresample, b"swr_convert"), _),
            swr_free: cast!(sym!(swresample, b"swr_free"), _),
        };
        Ok(f)
    }

    /// FFmpeg error code → human string.
    pub fn err2str(&self, code: i32) -> String {
        if code == 0 {
            return "ok".into();
        }
        let mut buf = [0 as c_char; 128];
        let ok = unsafe { (self.syms.av_strerror)(code, buf.as_mut_ptr(), buf.len()) };
        if ok == 0 {
            let s = buf.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect::<Vec<u8>>();
            if let Ok(s) = String::from_utf8(s) {
                return format!("{} ({})", s, code);
            }
        }
        format!("FFmpeg error {}", code)
    }

    /// av_dict_set helper (dict must be a *mut *mut u8 initialized to null).
    pub fn dict_set(&self, dict: &mut *mut u8, key: &str, value: &str) -> Result<(), String> {
        let k = CString::new(key).map_err(|e| format!("bad dict key {}: {}", key, e))?;
        let v = CString::new(value).map_err(|e| format!("bad dict value {}: {}", value, e))?;
        let r = unsafe { (self.syms.av_dict_set)(dict as *mut *mut u8, k.as_ptr(), v.as_ptr(), 0) };
        if r < 0 {
            Err(self.err2str(r))
        } else {
            Ok(())
        }
    }

    pub fn dict_free(&self, dict: &mut *mut u8) {
        unsafe { (self.syms.av_dict_free)(dict as *mut *mut u8) };
    }

    /// av_opt_set helper on any object (codec ctx, swr, …).
    #[allow(dead_code)]
    pub fn opt_set(&self, obj: *mut u8, key: &str, value: &str) -> Result<(), String> {
        let k = CString::new(key).map_err(|e| format!("bad opt key {}: {}", key, e))?;
        let v = CString::new(value).map_err(|e| format!("bad opt value {}: {}", value, e))?;
        let r = unsafe { (self.syms.av_opt_set)(obj as *mut c_void, k.as_ptr(), v.as_ptr(), 0) };
        if r < 0 {
            Err(format!("av_opt_set({}, {}) failed: {}", key, value, self.err2str(r)))
        } else {
            Ok(())
        }
    }
}

// ── RAII guards ────────────────────────────────────────────────────────────

/// Owns a raw FFmpeg object and frees it on Drop via the captured free
/// function (all `*_free` APIs share the `fn(*mut *mut u8)` shape).
pub struct PtrGuard {
    pub raw: *mut u8,
    free_fn: unsafe extern "C" fn(*mut *mut u8),
}

impl PtrGuard {
    pub fn new(raw: *mut u8, free_fn: unsafe extern "C" fn(*mut *mut u8)) -> Result<Self, String> {
        if raw.is_null() {
            Err("FFmpeg returned a null object".into())
        } else {
            Ok(PtrGuard { raw, free_fn })
        }
    }
}

impl Drop for PtrGuard {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            unsafe { (self.free_fn)(&mut self.raw as *mut *mut u8) };
        }
    }
}

/// Output format context: on Drop, closes the AVIO stream then frees the
/// context (avio_closep zero-fills ctx->pb so we must read its address
/// first).
pub struct OutFormatGuard {
    pub raw: *mut u8,
    free_ctx: unsafe extern "C" fn(*mut u8),
    close_pb: unsafe extern "C" fn(*mut *mut u8) -> i32,
}

impl OutFormatGuard {
    pub fn new(
        raw: *mut u8,
        free_ctx: unsafe extern "C" fn(*mut u8),
        close_pb: unsafe extern "C" fn(*mut *mut u8) -> i32,
    ) -> Self {
        OutFormatGuard { raw, free_ctx, close_pb }
    }
}

impl Drop for OutFormatGuard {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            unsafe {
                let pb_addr = self.raw.add(AVFMTCTX_PB);
                let pb = rd_ptr(pb_addr, 0);
                if !pb.is_null() {
                    (self.close_pb)(pb_addr as *mut *mut u8);
                }
                (self.free_ctx)(self.raw);
            }
        }
    }
}

unsafe impl Send for PtrGuard {}
unsafe impl Send for OutFormatGuard {}

// ── convenience: frame field accessors (offset-verified) ───────────────────

#[allow(dead_code)] // full accessor set resolved for future pipeline stages
impl FFmpegLibs {
    pub fn frame_alloc(&self) -> Result<PtrGuard, String> {
        let raw = unsafe { (self.syms.av_frame_alloc)() };
        PtrGuard::new(raw, self.syms.av_frame_free)
    }
    pub fn packet_alloc(&self) -> Result<PtrGuard, String> {
        let raw = unsafe { (self.syms.av_packet_alloc)() };
        PtrGuard::new(raw, self.syms.av_packet_free)
    }
    pub fn frame_unref(&self, f: &PtrGuard) {
        unsafe { (self.syms.av_frame_unref)(f.raw) };
    }

    pub unsafe fn frame_data(&self, f: *mut u8, plane: usize) -> *mut u8 {
        rd_ptr(f, AVFRAME_DATA + 8 * plane)
    }
    pub unsafe fn frame_extended_data(&self, f: *mut u8) -> *mut *mut u8 {
        rd_ptr(f, AVFRAME_EXTENDED_DATA) as *mut *mut u8
    }
    pub unsafe fn frame_linesize(&self, f: *mut u8, plane: usize) -> i32 {
        rd_i32(f, AVFRAME_LINESIZE + 4 * plane)
    }
    pub fn frame_width(&self, f: *mut u8) -> i32 {
        unsafe { rd_i32(f, AVFRAME_WIDTH) }
    }
    pub fn frame_height(&self, f: *mut u8) -> i32 {
        unsafe { rd_i32(f, AVFRAME_HEIGHT) }
    }
    pub fn frame_nb_samples(&self, f: *mut u8) -> i32 {
        unsafe { rd_i32(f, AVFRAME_NB_SAMPLES) }
    }
    pub fn frame_format(&self, f: *mut u8) -> i32 {
        unsafe { rd_i32(f, AVFRAME_FORMAT) }
    }
    pub fn frame_pts(&self, f: *mut u8) -> i64 {
        unsafe { rd_i64(f, AVFRAME_PTS) }
    }
    pub fn frame_set_pts(&self, f: *mut u8, pts: i64) {
        unsafe { wr_i64(f, AVFRAME_PTS, pts) };
    }
    pub fn frame_set_format(&self, f: *mut u8, fmt: i32) {
        unsafe { wr_i32(f, AVFRAME_FORMAT, fmt) };
    }
    pub fn frame_channels(&self, f: *mut u8) -> i32 {
        unsafe { rd_channel_nb(f, AVFRAME_CH_LAYOUT) }
    }
    pub fn frame_sample_rate(&self, f: *mut u8) -> i32 {
        unsafe { rd_i32(f, AVFRAME_SAMPLE_RATE) }
    }
    pub unsafe fn frame_set_layout(&self, f: *mut u8, nb_channels: i32, mask: u64) {
        wr_channel_layout(f, AVFRAME_CH_LAYOUT, nb_channels, mask)
    }

    pub fn packet_data(&self, p: *mut u8) -> *mut u8 {
        unsafe { rd_ptr(p, AVPACKET_DATA) }
    }
    pub fn packet_size(&self, p: *mut u8) -> i32 {
        unsafe { rd_i32(p, AVPACKET_SIZE) }
    }
    pub fn packet_pts(&self, p: *mut u8) -> i64 {
        unsafe { rd_i64(p, AVPACKET_PTS) }
    }
    pub fn packet_set_pts(&self, p: *mut u8, v: i64) {
        unsafe { wr_i64(p, AVPACKET_PTS, v) };
    }
    pub fn packet_set_dts(&self, p: *mut u8, v: i64) {
        unsafe { wr_i64(p, AVPACKET_DTS, v) };
    }
    pub fn packet_set_duration(&self, p: *mut u8, v: i64) {
        unsafe { wr_i64(p, AVPACKET_DURATION, v) };
    }
    pub fn packet_set_stream_index(&self, p: *mut u8, v: i32) {
        unsafe { wr_i32(p, AVPACKET_STREAM_INDEX, v) };
    }
    pub fn packet_flags(&self, p: *mut u8) -> i32 {
        unsafe { rd_i32(p, AVPACKET_FLAGS) }
    }
    pub fn packet_set_flags(&self, p: *mut u8, v: i32) {
        unsafe { wr_i32(p, AVPACKET_FLAGS, v) };
    }
    pub fn packet_dts(&self, p: *mut u8) -> i64 {
        unsafe { rd_i64(p, AVPACKET_DTS) }
    }
    pub fn packet_duration(&self, p: *mut u8) -> i64 {
        unsafe { rd_i64(p, AVPACKET_DURATION) }
    }
    /// v0.4: allocate `size` bytes of refcounted storage on `p`
    /// (av_new_packet — the write path then memcpy's clone bytes in and
    /// av_interleaved_write_frame takes the reference cleanly).
    pub fn packet_new(&self, p: *mut u8, size: usize) -> Result<(), String> {
        let r = unsafe { (self.syms.av_new_packet)(p, size.min(i32::MAX as usize) as i32) };
        if r < 0 {
            return Err(format!("av_new_packet({} bytes) failed", size));
        }
        Ok(())
    }
    pub fn packet_rescale_ts(&self, p: *mut u8, src: Rational, dst: Rational) {
        unsafe { (self.syms.av_packet_rescale_ts)(p, src, dst) };
    }
    pub fn packet_unref(&self, p: *mut u8) {
        unsafe { (self.syms.av_packet_unref)(p) };
    }

    // codec context field helpers
    pub fn cc_set_dimensions(&self, cc: *mut u8, w: i32, h: i32) {
        unsafe {
            wr_i32(cc, AVCC_WIDTH, w);
            wr_i32(cc, AVCC_HEIGHT, h);
        }
    }
    pub fn cc_set_pix_fmt(&self, cc: *mut u8, fmt: i32) {
        unsafe { wr_i32(cc, AVCC_PIX_FMT, fmt) };
    }
    pub fn cc_set_time_base(&self, cc: *mut u8, tb: Rational) {
        unsafe { wr_rational(cc, AVCC_TIME_BASE, tb) };
    }
    pub fn cc_set_framerate(&self, cc: *mut u8, fr: Rational) {
        unsafe { wr_rational(cc, AVCC_FRAMERATE, fr) };
    }
    pub fn cc_set_gop(&self, cc: *mut u8, gop: i32) {
        unsafe { wr_i32(cc, AVCC_GOP_SIZE, gop) };
    }
    pub fn cc_set_flags_or(&self, cc: *mut u8, flags: i32) {
        unsafe {
            let old = rd_i32(cc, AVCC_FLAGS);
            wr_i32(cc, AVCC_FLAGS, old | flags);
        }
    }
    pub fn cc_set_sample_fmt(&self, cc: *mut u8, fmt: i32) {
        unsafe { wr_i32(cc, AVCC_SAMPLE_FMT, fmt) };
    }
    pub fn cc_set_bit_rate(&self, cc: *mut u8, rate: i64) {
        unsafe { wr_i64(cc, AVCC_BIT_RATE, rate) };
    }
    pub fn cc_set_sample_rate(&self, cc: *mut u8, rate: i32) {
        unsafe { wr_i32(cc, AVCC_SAMPLE_RATE, rate) };
    }
    pub unsafe fn cc_set_channel_layout(&self, cc: *mut u8, nb: i32, mask: u64) {
        wr_channel_layout(cc, AVCC_CH_LAYOUT, nb, mask)
    }
    pub fn cc_frame_size(&self, cc: *mut u8) -> i32 {
        unsafe { rd_i32(cc, AVCC_FRAME_SIZE) }
    }
    pub fn cc_set_threads_auto(&self, cc: *mut u8) {
        unsafe {
            wr_i32(cc, AVCC_THREAD_COUNT, 0); // 0 = auto
            wr_i32(cc, AVCC_THREAD_TYPE, FF_THREAD_FRAME | FF_THREAD_SLICE);
        }
    }

    // stream helpers
    pub fn stream_codecpar(&self, st: *mut u8) -> *mut u8 {
        unsafe { rd_ptr(st, AVSTREAM_CODECPAR) }
    }
    pub fn stream_set_time_base(&self, st: *mut u8, tb: Rational) {
        unsafe { wr_rational(st, AVSTREAM_TIME_BASE, tb) };
    }
    pub fn stream_time_base(&self, st: *mut u8) -> Rational {
        unsafe { rd_rational(st, AVSTREAM_TIME_BASE) }
    }
    pub fn stream_set_avg_frame_rate(&self, st: *mut u8, fr: Rational) {
        unsafe { wr_rational(st, AVSTREAM_AVG_FRAME_RATE, fr) };
    }

    // format context helpers
    pub fn fmt_streams(&self, fc: *mut u8, idx: usize) -> *mut u8 {
        unsafe {
            let arr = rd_ptr(fc, AVFMTCTX_STREAMS);
            if arr.is_null() {
                return std::ptr::null_mut();
            }
            (arr as *const *mut u8).add(idx).read_unaligned()
        }
    }
    pub fn fmt_nb_streams(&self, fc: *mut u8) -> u32 {
        unsafe { rd_i32(fc, AVFMTCTX_NB_STREAMS) as u32 }
    }
    pub fn fmt_oformat_flags(&self, fc: *mut u8) -> i32 {
        unsafe {
            let of = rd_ptr(fc, AVFMTCTX_OFORMAT);
            if of.is_null() {
                return 0;
            }
            rd_i32(of, AVOFMT_FLAGS)
        }
    }

    // codec parameters helpers (input streams)
    pub fn par_codec_id(&self, par: *mut u8) -> i32 {
        unsafe { rd_i32(par, AVCP_CODEC_ID) }
    }
    pub fn par_codec_type(&self, par: *mut u8) -> i32 {
        unsafe { rd_i32(par, AVCP_CODEC_TYPE) }
    }
    pub fn par_width(&self, par: *mut u8) -> i32 {
        unsafe { rd_i32(par, AVCP_WIDTH) }
    }
    pub fn par_height(&self, par: *mut u8) -> i32 {
        unsafe { rd_i32(par, AVCP_HEIGHT) }
    }
    pub fn par_format(&self, par: *mut u8) -> i32 {
        unsafe { rd_i32(par, AVCP_FORMAT) }
    }
    pub fn par_sample_rate(&self, par: *mut u8) -> i32 {
        unsafe { rd_i32(par, AVCP_SAMPLE_RATE) }
    }
    pub fn par_channels(&self, par: *mut u8) -> i32 {
        unsafe { rd_channel_nb(par, AVCP_CH_LAYOUT) }
    }
}
