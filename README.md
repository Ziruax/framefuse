# FrameFuse v4.7

Native desktop **image → video** merger with a **live audio waveform timeline**, **beat-synced cutting with a strength dial**, **viral kinetic captions with favorites**, **segment transitions**, **per-boundary transition overrides**, **export quality profiles**, **watermark/logo overlay**, **undo/redo**, exact **word-by-word timing**, **GPU-accelerated export**, and a preview that matches the exported video **pixel-for-pixel**.

## Highlights

### 🌊 Audio waveform timeline (new in v4.7)
Drop any track and the timeline renders its **full peak waveform** between the ruler and the segment bars — bright cyan bars mark playback progress in real time (audio-relative, pixel-exact at any scrub position), dim bars show what's coming. Mirrored bars use sqrt perceptual shaping so quiet passages stay visible, and the static pass is cached offscreen keyed by decode identity for 60fps-safe redraws.

### 🎚 Beat-snap strength dial (new in v4.7)
Choose how often cuts land: every **Beat**, every **2** beats, a **Bar** (4/4), or **2 bars**. Fast cuts for energetic tracks, cinematic pacing for slow ones — the strided walk still follows tempo drift and stays export-parity (duration overrides only). Persisted across sessions.

### ⭐ Caption preset favorites (new in v4.7)
Star any of the 42 presets — favorites pin to a **★ group at the top** of the picker (deduplicated from their home categories), get their own filter option, and persist across restarts.

### 🎨 Visual polish pass (new in v4.7)
VLM-reviewed UI refresh (6.5 → 8.5/10): desaturated timeline bars with bright color reserved for the playhead, playhead drop-shadow readability over bars and waveform, ringed legend dots, secondary-styled Random button, clearer toggle off-states, 44px transport hit targets, timecode separator hierarchy, and tactile press feedback on Export.

### 🥁 Beat-synced editing (v4.6)
Drop a music track and hit **Detect beats** — a local onset-envelope DSP (no network, no wasm download) estimates the **BPM** and every beat. **Snap cuts** retimes all boundaries onto the pulse (tempo-tracking walk over the real beat list, or median-grid quantization when the music is slower than your cut rate), and **Fit video to audio** scales the whole timeline to end with the song. Beat ticks render on the ruler (the beat under the playhead pulses live), every snap/fit is undoable, and because it only produces duration overrides the FFmpeg export stays in exact parity automatically.

### 🔍 Caption preset search (v4.6)
42 presets now have a **search box** (name, description, animation, word-mode) + a **category filter** — find "Hormozi", "karaoke" or "glitch" in one keystroke instead of scrolling nine groups.

### 🎤 Karaoke WebVTT (v4.6)
`words .vtt` export emits **word-level timing via WebVTT intra-cue timestamps** — supporting players highlight each word as it's spoken, straight from the Whisper alignment.

### ⚡ Export quality profiles (new in v4.5)
One-click encode bundles — **Draft** (720p · 30fps · CRF 27, fastest rough cut), **Social** (1080p · 30fps · CRF 20, the upload sweet spot) and **Cinema** (1080p · 60fps · CRF 17 + slower preset, maximum-quality master). Every encoder gets its own tuning (NVENC p1/p4/p6 + cq, QSV, AMF, libx264 preset), fine-tuning any field flips to **Custom** with a live CRF slider, and the header shows a live **size/duration estimate** for the current timeline before you ever hit Export.

### 🔗 Per-boundary transitions (new in v4.5)
The global style is just the default — click any boundary link between clips to pin its **own** transition (dissolve at 3, flash into the hook, hard cut for the punchline). Pinned boundaries show amber pills + amber timeline hatches, `boundaryStyle()` is the single resolution point shared by the canvas preview, browser exports and the FFmpeg graph builder (36-check harness, real-FFmpeg verified), overrides round-trip through projects/undo/persistence, and **reset all** is one click.

### ✋ Drag to reorder (new in v4.5)
Drag media cards to re-sequence duration-based timelines; beat/absolute storyboards honestly lock order (filename timestamps rule) with explanatory hints instead of silently doing nothing.

### 🏷 Watermark / logo overlay (v4.4)
Upload a PNG logo and brand **every frame** — 9-position grid, size (5–50% of width), opacity and margin controls. One shared geometry function drives both the canvas preview and the FFmpeg overlay filter, so the burn-in matches the preview exactly (probe-verified). Watermarks composite correctly during transitions, persist in project files, and are fully undoable.

### 📄 WebVTT sidecar (new in v4.4)
`.vtt` joins `.srt` and `.ass` exports for HTML5 `<track>` / web video players.

### 🎞 Segment transitions (v4.3)
**8 styles** between segments — **Dissolve, Dip-to-Black, Flash (dip-to-white), Slide ←/→, Wipe ←/→** — with a 0.2–1.5s duration slider and an optional **video opener/outro fade**. Every transition is a per-clip head composite (FFmpeg `xfade` at offset 0, blending the previous segment's frozen Ken Burns end-frame), so the timeline duration, audio sync and caption timing are never disturbed — and the burn-in matches the preview exactly (probe-verified against FFmpeg 7.0.2 output, 27/27 parity checks).

### ↩️ Undo / Redo (new in v4.3)
`Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` (or the header buttons) step through **80 levels** of session history — segments, durations, captions, headlines, Ken Burns, transitions, every setting. Removed media restores **byte-perfect**.

### 📐 4:5 aspect (new in v4.3)
Instagram-feed portrait (1080×1350) joins 16:9 / 9:16 / 1:1. The ruler also gains **headline marker chips** (click to jump) and **transition zone hatches** that glow while playing.

### 🪝 Title overlay track (v4.2)
Big hook titles independent of captions — timed text items with 5 viral presets (**Bold Impact, Neon Hook, Sticker, Elegant Serif, Clean Banner**), top/center/bottom placement, 4 entrance animations (Fade / Slide / Pop / Zoom-Punch) and a live size control. Burned into the export with the same preview-parity guarantee as captions, and exported even when captions are off.

### 💾 Project files (v4.2)
**Save / open `.framefuse.json`** — one self-contained file carrying your images, audio, subtitle cues (with word timing), headline track, duration overrides, transitions and every setting. Drop it back onto the app (or use ⌂ Open project) to restore the exact session.

### 🛠 Editor upgrades (v4.2)
- **Duplicate segment** — one click, perfect for beat repetition
- **3 new kinetic animations**: **Tracking-In** (letters slide together), **Blur-In** (focus pull), **Heartbeat** (double-beat pulse) — 24 total, all ASS-parity
- Refreshed UI: gradient buttons, depth shadows, glowing playhead, pulsing beat tracks, hover-lift media cards
- Hydration-safe settings persistence (React #418 fixed)

### 🎬 Captions that behave like their names
42 presets across Viral / Kinetic / Social / YouTube / Streaming / Documentary / Corporate / News / Film — every viral preset ships with its signature behavior:

| Preset | What it actually does |
|---|---|
| **Hormozi** | Single word slams in (2.4× → 1) with green highlight |
| **Karaoke** | Word-by-word yellow fill |
| **Reveal** | Typewriter character reveal |
| **MrBeast Slam** | Giant yellow text + punch shake |
| **Glitch Vibe** | RGB-split digital flicker |
| **Confetti Pop** | Electric per-word color palette |
| **Spotlight** | Active word pops in a highlight box |
| **Word Stack** | Words build a growing centered tower |
| **Rapid Zoom** | Fast-cut 1.6× → 1 machine-gun pacing |

### ✨ 24 kinetic typography animations
Pop-In · Slide-Up · Bounce-In · Scale-Pulse · Fade-Through · Typewriter · Reveal · Wave · Jitter · Shake · Drift · **Slam · Glitch · Spin-In · Flip-In · Elastic · Color-Cycle · Spotlight · Swing · Squash · Zoom-Words · Tracking-In · Blur-In · Heartbeat** — all rendered identically in the canvas preview and the burned-in ASS export (karaoke-safe tags included).

### 🎙️ Whisper word-by-word timing
Whisper-tiny runs **fully locally** (no API keys, ~75 MB download once, then offline) with `return_timestamps: "word"` **DTW alignment** — every word carries its exact spoken timestamp. Anti-repetition setting for long audio. Automatic sentence-aware cue grouping.

### 🚀 Export
- **GPU encoding** (NVENC / Intel QSV / AMD AMF) with runtime probe + CPU fallback
- **Preview parity**: zoompan geometry exactly matches the canvas (centered pan starts, 1.1× supersampled Ken Burns)
- Two-step pipeline: per-segment encode → instant concat
- Real-time progress + ETA
- Audio post: **−16 LUFS normalization**, fade in/out, silence padding (short audio never truncates the video)
- Caption sidecar export: `.srt` + styled `.ass`

### 🎛️ Production tooling
- **Ken Burns multi-select** — randomize between your 2+ favorite effects or fix one
- **Segment transitions** + **headline overlay track** + **project save/open** + **undo/redo** (see above)
- Settings persist across restarts
- Keyboard shortcuts: `Space` play/pause, `←/→` ±1s, `Shift+←/→` segment step, `Home` restart, `Ctrl+Z` / `Ctrl+Shift+Z` undo/redo
- Drag & drop images, audio, `.srt` **and** `.framefuse.json` project files
- Absolute / beat / duration filename timelines

## Install (Windows)

1. Download `FrameFuse-Setup.zip` from [Releases](https://github.com/Ziruax/framefuse/releases)
2. Extract and run `win-unpacked/FrameFuse.exe`

## Development

```bash
bun install          # or npm install
npm run dev          # web dev server
npm run electron:dev # full desktop app
npm run electron:build # package for Windows
```

### Filename timing formats

| Kind | Pattern | Example |
|---|---|---|
| Absolute | `[start - end] name.jpg` | `[00:00:00 - 00:00:06] beach.jpg` |
| Beat | `NNN__Beat_N_0s_name.jpg` | `001__Beat_1_0s_intro.jpg` |
| Duration | `Ns_name.jpg` | `10s_sunset.jpg` |

MIT © FrameFuse
