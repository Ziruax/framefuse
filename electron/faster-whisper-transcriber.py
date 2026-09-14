# electron/faster-whisper-transcriber.py — FrameFuse v1.3 Whisper sidecar.
#
# Runs INSIDE the bundled self-contained Python runtime (faster-whisper +
# CTranslate2 int8) spawned by electron/main.js. Reads any audio/video file
# (PyAV decodes it — no ffmpeg needed on PATH), transcribes with word-level
# timestamps + VAD silence filtering, and streams JSON-lines on stdout:
#
#   {"type":"stage","stage":"load"}                       before model load
#   {"type":"info","durationMs":1140000,"language":"en"}  after decode probe
#   {"type":"progress","progress":37}                     0..100 of timeline
#   {"type":"result","chunks":[...],"language":"en",      final payload
#    "wordLevel":true,"durationMs":1140000}
#   {"type":"error","message":"..."}                      fatal
#
# The chunk shape matches the app's existing Whisper IPC contract exactly:
# [{ "text": str, "timestamp": [startSec|null, endSec|null] }] — in
# word-level mode each chunk is ONE word (parseWhisperOutput's word path),
# and when a segment produced no word timings it degrades to phrase chunks
# (wordLevel=false) so the renderer's estimator takes over.
#
# Why faster-whisper (user request): CTranslate2 + int8 quantization runs
# ~4x faster than the previous onnxruntime path on the same CPU, and the
# base/small/medium models become practical — small at int8 typically
# transcribes a 19-minute video in ~1-3 minutes on a laptop CPU.

import argparse
import json
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", default=None)
    ap.add_argument("--model", default="tiny")
    ap.add_argument("--language", default="auto")
    ap.add_argument("--cache", default=None)
    ap.add_argument("--cpu-threads", type=int, default=0)
    # v1.3.1: preload mode — load (download) the model and exit. Used by the
    # Captions panel's pre-download button so first transcription is offline.
    ap.add_argument("--preload", action="store_true")
    args = ap.parse_args()

    # v7 FIX A: bound huggingface_hub's network calls (its requests have NO
    # read timeout by default — a stalled socket hangs the whole sidecar and
    # the host UI shows "Working…" forever) + silence tqdm progress noise.
    import os
    os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "30")
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")

    if not args.preload and not args.audio:
        emit({"type": "error", "message": "--audio is required (or pass --preload)"})
        return 1

    try:
        from faster_whisper import WhisperModel
    except Exception as e:  # noqa: BLE001 - surfaced to the host verbatim
        emit({"type": "error", "message": f"faster-whisper import failed: {e}"})
        return 1

    lang = None if args.language in ("auto", "", None) else args.language

    emit({"type": "stage", "stage": "load"})
    # v7 FIX A: heartbeat while loading. WhisperModel() includes the FIRST-RUN
    # model download, which can take minutes with no other output — the
    # heartbeats tell the host's watchdog the sidecar is alive (a hard hang
    # stops them and the watchdog kills + falls back to the bundled engine).
    # The main thread is blocked inside WhisperModel() during the heartbeat
    # window, so emit() never runs concurrently from two threads.
    import threading
    stop_beat = threading.Event()

    def heartbeat():
        while not stop_beat.wait(5.0):
            emit({"type": "stage", "stage": "load"})

    beat = threading.Thread(target=heartbeat, daemon=True)
    beat.start()
    try:
        kwargs = {"device": "cpu", "compute_type": "int8"}
        if args.cache:
            kwargs["download_root"] = args.cache
        if args.cpu_threads and args.cpu_threads > 0:
            kwargs["cpu_threads"] = args.cpu_threads
        model = WhisperModel(args.model, **kwargs)
    except Exception as e:  # noqa: BLE001
        emit({"type": "error", "message": f"Model load failed: {e}"})
        return 1
    finally:
        stop_beat.set()

    if args.preload:
        # The model constructor above already downloaded + cached the files;
        # report success in the same protocol and stop.
        emit({"type": "result", "chunks": None, "language": None,
              "wordLevel": False, "durationMs": 0, "preloaded": True})
        return 0

    try:
        segments, info = model.transcribe(
            args.audio,
            language=lang,
            word_timestamps=True,
            # VAD skips silence/music — the biggest speedup on long videos
            # (a 19-min talking video often contains minutes of pauses).
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            beam_size=5,
        )
    except Exception as e:  # noqa: BLE001
        emit({"type": "error", "message": f"Transcription failed: {e}"})
        return 1

    duration_s = float(info.duration or 0.0)
    emit({
        "type": "info",
        "durationMs": int(duration_s * 1000),
        "language": info.language,
    })

    word_chunks = []
    phrase_chunks = []
    have_words = False
    for seg in segments:
        if seg.words:
            have_words = True
            for w in seg.words:
                text = (w.word or "").strip()
                if not text:
                    continue
                word_chunks.append({
                    "text": text,
                    "timestamp": [w.start, w.end],
                })
        else:
            phrase_chunks.append({
                "text": (seg.text or "").strip(),
                "timestamp": [seg.start, seg.end],
            })
        # Progress = fraction of the timeline covered by this segment.
        if duration_s > 0:
            frac = min(1.0, float(seg.end or 0.0) / duration_s)
            emit({"type": "progress", "progress": int(frac * 100)})

    if have_words:
        chunks = word_chunks + phrase_chunks
        word_level = True
    else:
        chunks = phrase_chunks
        word_level = False

    emit({
        "type": "result",
        "chunks": chunks,
        "language": info.language,
        "wordLevel": word_level,
        "durationMs": int(duration_s * 1000),
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
