# FrameFuse v5.2

Native desktop **multi-track video studio** with a **resizable Shotcut-style panel layout**, **CapCut-style on-canvas overlay manipulation**, **first-class background music (drag to place, volume, loop-to-fill)**, a **filmstrip storyboard timeline** (thumbnails in every segment, double-click to jump), **middle-truncating filename rows**, **click-to-aim Ken Burns motion**, a **grid media library for 100+ image storyboards**, a **live audio waveform timeline**, **beat-synced cutting with a strength dial**, **viral kinetic captions with favorites**, **segment transitions**, **per-boundary transition overrides**, **export quality profiles**, **watermark/logo overlay**, **undo/redo**, exact **word-by-word timing**, **GPU-accelerated export**, and a preview that matches the exported video **pixel-for-pixel**.

## Highlights

### 🔧 What's new in v5.2 — the "make it work like a real editor" release
- **Fixed Whisper tiny downloads** — sharp-runtime guard, HuggingFace mirror fallback (`hf-mirror.com`) with retries, per-file download progress, model status diagnostics + one-click pre-download, per-run cancellation. The model (~42 MB) downloads once and works offline after.
- **Preview that fills the panel** — the stage is now fully responsive (letterboxed to the available space instead of a fixed 960px box), auto-matches the project aspect to your first imported video, and has a Fit (letterbox) / Fill (cover) toggle.
- **Resizable editor panels** — draggable, keyboard-accessible splitters between the media panel, preview column, settings panel, and the timeline (persisted, snap-to-default, double-click reset).
- **Background music done right** — the music track is now a first-class timeline clip: drag it to reposition, adjust volume (0–200%), and **loop it to fill the entire video** (background tracks are usually longer than the edit). Export mixes with volume/delay/loop exactly as previewed.
- **Green screen like CapCut** — click an overlay on the preview canvas to select it, **drag to move, corner-handles to resize** (with center snapping), key-color picker + auto-detect, and **"Span entire video"** so short green-screen clips loop to cover the whole timeline.
- **2–5× faster export** — static clips skip the zoompan supersampler entirely, clips encode video-only while audio extracts in parallel as PCM and mixes in a single pass (no double AAC encode, no synthesized silence tracks, master limiter), CPU threads are budgeted across the encode pool instead of oversubscribing, and the cinema preset uses `faster`.
- **Nothing applies by default** — Ken Burns, caption burn-in and effects are strictly opt-in now; features turn on when YOU add them.


### 🧠 Native Whisper captions — fixed + 5× faster (new in v5.1)
Transcription now runs in an Electron **utility process** with **onnxruntime-node** (native, multi-threaded CPU inference) instead of the renderer Web Worker — which also fixes the packaged-app worker path failure that broke every transcription in v5.0. Audio is decoded by **FFmpeg** (streamed, native), and the whisper-tiny model downloads **once** to `<userData>/whisper-models` on disk and stays there forever — offline after the first run.

### ⚡ Non-blocking, GPU-first export (new in v5.1)
The v5.0 export froze the whole app before the first frame: GPU detection and per-video probes ran as **blocking** `execSync`/`spawnSync` calls (up to 25 s). v5.1 warms the encoder probe at startup, probes all media **in parallel** (async spawn), tries **every** GPU encoder (NVENC → QSV → AMF — a broken driver no longer hides a working GPU), adds **hardware video decode** (`-hwaccel auto`) for base clips, and shows the active encoder in the export tab.

### 🎚 Timeline zoom + split + speed (new in v5.1)
A true pixel-based timeline: **zoom 4–400 px/s** (buttons, slider, Ctrl+wheel toward the cursor, Fit), adaptive ruler ticks, **Split at playhead** (S key / scissors — one undo step), per-clip **speed 0.25–4×** (preview + `setpts`/`atempo` export), duplicate/delete clip tools, and a **Circle Open** transition + random-mix/apply-all.

### 📁 Native project files (new in v5.1)
Save/Open/Save-As with **real OS dialogs** (Cmd/Ctrl+S, Cmd/Ctrl+O), a current-project chip in the header, a persisted recents list, and New Project reset — the same self-contained `.framefuse.json` document (media inlined), so projects move between machines.

### 🛤 Multi-track timeline (v5.0)
Four stacked lanes — **VIDEO** (base filmstrips), **OVERLAY** (draggable chroma-key clips), **AUDIO** (music waveform) and **SFX** (sound-effect pills). Drag clip bodies to move, edges to trim, and vertically past the 24px threshold to switch lanes. One continuous playhead spans every lane.

### 🎬 Video import + chroma key (new in v5.0)
Drop **MP4/WebM/MOV** files — they join the base track at source length (or the overlay lane with one click). Each clip gets **Trim start**, **Volume**, and a full **green-screen keyer**: auto-detected key color, similarity / blend / spill sliders, and a live keyed preview swatch. WebGL preview matches the FFmpeg `chromakey + despill` export exactly.

### 💥 Synthesized sound effects (new in v5.0)
A palette of **10 procedurally-synthesized SFX** (whoosh, pop, ding, impact, riser, click, sparkle, boom, swipe, record-scratch) — zero asset files, click to preview, **+ to place at the playhead**, drag pills along the SFX lane, mix with music through the export `amix` graph.

### ⚡ Parallel FFmpeg export (new in v5.0)
Step-1 clips encode in a **CPU-sized parallel pool** (up to 4 concurrent encodes, GPU encoder when available), per-clip timemarks aggregate into live progress, and the step-2 mux mixes clip audio + music + SFX with sample-exact `adelay` placement. Overlay compositing, chroma keying and video trimming all ride the same graph.

### 🗂 Tabbed settings (new in v5.0)
The right panel is now **Media / Captions / Effects / Audio / Export** tabs — same controls, half the scroll, persisted selection, keyboard-navigable (arrow keys, Home/End), with live indicators while Whisper runs.


### 🎞 Filmstrip storyboard timeline (new in v4.9)
The timeline segments are no longer colored bars — each clip renders its **own thumbnail** under a translucent kind-tint (cyan absolute / emerald beat / violet duration), with a scrimmed **index chip**, a **duration tag** on wide strips, and hover outlines. The active clip pops (ring + violet glow + lift) while inactive strips recede. **Double-click any strip to jump to its first frame** — single click and drag still scrub, so the interaction never fights the playhead. Rich tooltips carry the full filename, range, duration and motion.

### ✂️ Middle-truncating filenames (new in v4.9)
Storyboard filenames front-load timing metadata and bury the differentiator at the end — so the media rows now **keep the tail visible** (`…OOM_camera.jpg` vs `…OOM_PROTAG.jpg`) while the head ellipsizes responsively. Pure helper in `lib/merger/text.ts` (harness-tested), shared by the preview overlay and the list rows.

### 🧹 Coherence + hygiene pass (new in v4.9)
VLM-reviewed styling sweep (4 → 8.5/10 on the list view): icon-only header method badge, quieter mode badges, lucide `Dices` Random button at a lighter weight, violet-unified control toggles, tighter effects grid with press feedback, brighter add-more affordance, keyboard focus rings on tiles, brighter ruler ticks. Hygiene: **removing an image now prunes its motion/transition overrides** (orphan-free maps, still fully undoable), and settings persistence moved to a **versioned localStorage key** (`framefuse.settings.v49`, one-shot migration from the legacy v41 blob).

### 🎯 Click-to-aim motion (v4.8)
Hover the preview canvas and a **crosshair + aim chip** appear — click anywhere to pin the active segment's Ken Burns direction (center = zoom in, edges = pan toward the click). Every card's motion label is also a **6-direction popover** with per-segment pinning; overrides flow into the timeline, the project file, undo history, AND the FFmpeg zoompan — one resolution point, exact export parity.

### 🗞 Media library grid view (v4.8)
One toggle flips the library between rich **list rows** and compact **tiles** built for 100+ image storyboards: index + duration badges, active-tile highlight, click-to-jump, hover remove, drag-reorder, and pinned-motion flags. The preference persists.

### 🕶 Timeline hover timecode (v4.8)
Ghost hairline + timecode chip follow the cursor across the ruler and waveform — preview exactly where a click or scrub lands.

### 🌊 Audio waveform timeline (v4.7)
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
