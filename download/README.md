# FrameFuse Downloads

## Latest Release: v1.1 — Turbo Export

**Windows Installer (recommended):**
https://github.com/Ziruax/framefuse/releases/download/v1.1.0/FrameFuse.Setup.1.1.0.exe

~145 MB — bundles FFmpeg + the Whisper caption service. Run the installer,
then launch FrameFuse from the Start Menu.

### What's new in v1.1 (Turbo Export)

- **Fixes the 5–10 hour export problem** — a 19-minute video now exports in
  minutes; cuts-only projects export in **seconds** (stream-copy fast path,
  measured 177× faster per clip).
- Removed the `-hwaccel auto` decode hazard (WARP software-rasterizer path
  that decoded 1080p at ~1 fps on some Windows machines).
- Hardened GPU encoder detection with a real throughput gate — broken
  NVENC/QSV/AMF driver stacks are detected and bypassed.
- Export stats in the success toast + header: elapsed time, encoder used,
  and how many clips were turbo-copied.

### All releases

https://github.com/Ziruax/framefuse/releases
