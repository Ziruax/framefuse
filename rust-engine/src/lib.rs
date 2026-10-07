//! FrameFuse Rust engine — N-API bridge (DIRECTIVE 2).
//!
//! `export_video(timeline_json, output_path, ffmpeg_dir, progress_cb)` runs
//! the full native pipeline on a dedicated worker thread and returns a
//! Promise (JsDeferred) so the Node event loop is never blocked; progress
//! streams back through a ThreadsafeFunction. The napi `async fn` transform
//! was rejected deliberately: it keeps the `JsFunction` argument alive
//! across await points (not `Send`), while a deferred + worker thread is
//! the napi-rs-endorsed shape for TSFN + multi-minute jobs. From
//! JavaScript: `await engine.exportVideo(...)` behaves identically.
//!
//! No panics cross the FFI (catch_unwind at the worker boundary); every
//! failure rejects the promise with a plain error string the Electron
//! router maps to the FFmpeg-CLI Safe Mode fallback.

#![deny(clippy::all)]

mod audio;
mod captions;
mod compositor;
mod export;
mod ffmpeg_ffi;
mod ffi_offsets;
mod kinetic;
mod text;
mod timeline;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{
    ErrorStrategy, ThreadSafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use napi::{Env, JsObject};
use napi_derive::napi;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use crate::export::{ProgressEvent, ProgressSink};
use crate::ffmpeg_ffi::FFmpegLibs;

/// One export at a time (v0.1) — the cancel flag for the in-flight export.
static CANCELLED: AtomicBool = AtomicBool::new(false);

#[napi(object)]
pub struct ExportProgress {
    /// prepare | video | audio | mux | done — matches the app's existing
    /// export-progress phases.
    pub phase: String,
    /// 0..100 overall.
    pub percent: f64,
    /// Encode fps (informational).
    pub fps: f64,
    /// ETA in ms (0 while warming up).
    pub eta_ms: i64,
    /// content-seconds per wall-second (×realtime).
    pub rate: Option<f64>,
    /// Current content position (sec).
    pub timemark_sec: Option<f64>,
    pub elapsed_sec: Option<f64>,
    pub total_sec: Option<f64>,
}

#[napi(object)]
pub struct ExportResult {
    pub success: bool,
    /// "rust-gpu" | "rust-cpu" (the compositor that ACTUALLY ran).
    pub engine_used: String,
    /// e.g. "h264_nvenc", "libx264" — displayed in the completion toast.
    pub encoder_name: String,
    /// Total wall time (ms) — telemetry `total_wall_ms`.
    pub duration_ms: i64,
    pub frames: u32,
    /// Telemetry: gpu_compositor_ms / rust_encode_ms / decode / audio.
    pub compositor_ms: i64,
    pub encode_ms: i64,
    pub decode_ms: i64,
    pub audio_ms: i64,
    pub size_bytes: f64,
    /// wgpu adapter description when the GPU path engaged.
    pub adapter: Option<String>,
    /// Loaded FFmpeg shared-library family (e.g. "61/61/59/8/5").
    pub ffmpeg_family: String,
}

#[napi]
pub fn engine_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Diagnostic probe: which FFmpeg family loads from `ffmpeg_dir`?
/// Returns "61/61/59/8/5" on success, or "error: …" the router logs before
/// falling back to the CLI engine.
#[napi]
pub fn probe_ffmpeg_family(ffmpeg_dir: String) -> String {
    match FFmpegLibs::load(&ffmpeg_dir) {
        Ok(f) => f.family,
        Err(e) => format!("error: {}", e),
    }
}

/// Request cancellation of the in-flight export (best effort; the video
/// loop checks between frames).
#[napi]
pub fn cancel_export() {
    CANCELLED.store(true, Ordering::SeqCst);
}

#[napi]
pub fn export_video(
    env: Env,
    timeline_json: String,
    output_path: String,
    ffmpeg_dir: String,
    progress_cb: JsFunction,
) -> Result<JsObject> {
    let _ = env_logger::try_init();
    let start = Instant::now();

    // 0. Parse the timeline BEFORE touching FFmpeg — a malformed payload
    //    must not look like a DLL problem.
    let timeline: timeline::Timeline = serde_json::from_str(&timeline_json)
        .map_err(|e| Error::new(napi::Status::InvalidArg, format!("Timeline parse error: {}", e)))?;
    let total_sec = timeline.total_ms / 1000.0;

    // 1. Initialize Runtime FFmpeg FFI (DIRECTIVE 3) — synchronous, on the
    //    JS thread, so a DLL failure rejects immediately.
    let ff = FFmpegLibs::load(&ffmpeg_dir)
        .map_err(|e| Error::new(napi::Status::GenericFailure, format!("FFmpeg DLL load failed: {}", e)))?;
    let ffmpeg_family = ff.family.clone();

    // 2. Setup Threadsafe progress callback (DIRECTIVE 2).
    let tsfn: ThreadsafeFunction<ExportProgress, ErrorStrategy::CalleeHandled> =
        progress_cb.create_threadsafe_function(0, |ctx: ThreadSafeCallContext<ExportProgress>| {
            let mut obj: JsObject = ctx.env.create_object()?;
            obj.set("phase", ctx.value.phase.as_str())?;
            obj.set("percent", ctx.value.percent)?;
            obj.set("fps", ctx.value.fps)?;
            obj.set("etaMs", ctx.value.eta_ms)?;
            obj.set("rate", ctx.value.rate)?;
            obj.set("timemarkSec", ctx.value.timemark_sec)?;
            obj.set("elapsedSec", ctx.value.elapsed_sec)?;
            obj.set("totalSec", ctx.value.total_sec)?;
            Ok(vec![obj])
        })?;

    let sink: ProgressSink = Arc::new(move |ev: ProgressEvent| {
        let elapsed = start.elapsed().as_secs_f64();
        // v0.4: the pipeline owns the ETA math (phase-local, from the actual
        // video-fps / audio-sample rates — see export.rs). The old
        // (100-pct)/pct × elapsed whole-run extrapolation misread phase
        // boundaries: ETA climbing while paging slowed the machine, then 0 s
        // through the audio/mux tail. 0 = "estimating…" for the UI.
        let eta_ms = ev.eta_ms.filter(|ms| *ms > 0).unwrap_or(0);
        let rate = if elapsed > 0.5 && ev.timemark_sec > 0.0 {
            Some((ev.timemark_sec / elapsed * 100.0).round() / 100.0)
        } else {
            None
        };
        let p = ExportProgress {
            phase: ev.phase,
            percent: ev.percent,
            fps: ev.fps,
            eta_ms,
            rate,
            timemark_sec: Some(ev.timemark_sec),
            elapsed_sec: Some((elapsed * 10.0).round() / 10.0),
            total_sec: Some(total_sec),
        };
        // progress is best-effort: a JS-side exception must not abort export
        let _ = tsfn.call(Ok(p), ThreadsafeFunctionCallMode::NonBlocking);
    });

    // 3. Execute the pipeline on a dedicated worker — the promise resolves
    //    from the thread; the event loop stays free.
    let (deferred, promise) = env.create_deferred()?;
    CANCELLED.store(false, Ordering::SeqCst);
    let ff = Arc::new(ff);
    let worker = std::thread::Builder::new()
        .name("framefuse-rust-export".into())
        .spawn(move || {
            let outcome = catch_unwind(AssertUnwindSafe(|| {
                export::run_pipeline(timeline, output_path, ff, sink, &CANCELLED)
            }));
            match outcome {
                Ok(Ok(o)) => {
                    let _ = deferred.resolve(move |_env| {
                        Ok(ExportResult {
                            success: true,
                            engine_used: o.engine_used,
                            encoder_name: o.encoder_name,
                            duration_ms: o.duration_ms,
                            frames: o.frames.min(u32::MAX as u64) as u32,
                            compositor_ms: o.compositor_ms,
                            encode_ms: o.encode_ms,
                            decode_ms: o.decode_ms,
                            audio_ms: o.audio_ms,
                            size_bytes: o.size_bytes as f64,
                            adapter: o.adapter,
                            ffmpeg_family,
                        })
                    });
                }
                Ok(Err(e)) => {
                    let _ = deferred.reject(Error::new(napi::Status::GenericFailure, format!("export failed: {}", e)));
                }
                Err(panic) => {
                    let _ = deferred.reject(Error::new(napi::Status::GenericFailure, format!("rust engine panicked: {}", panic_message(&panic))));
                }
            }
        })
        .map_err(|e| Error::new(napi::Status::GenericFailure, format!("worker spawn failed: {}", e)))?;
    std::mem::forget(worker);

    Ok(promise)
}

fn panic_message(panic: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = panic.downcast_ref::<&str>() {
        s.to_string()
    } else if let Some(s) = panic.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic payload".to_string()
    }
}
