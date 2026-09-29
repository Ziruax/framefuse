faster-whisper runtime — OPT-IN (v1.15)
======================================

This folder is intentionally EMPTY in the default build. Since v1.15 the
faster-whisper runtime + model are no longer bundled in the installer
(-300 MB): captions run through the Groq Whisper API (user's own key,
stored on-device) with the bundled ONNX tiny model as the offline fallback.

To build an installer WITH the local faster-whisper engine (offline,
whisper-large-v3-class accuracy), stage the runtime first:

    npm run electron:build:fw        # stages runtime + model here
    npm run electron:build           # then build as usual

At runtime FrameFuse detects this folder's python/python.exe +
transcriber.py; when absent the engine chain simply falls back
(Groq -> local faster-whisper if present -> bundled ONNX tiny).
