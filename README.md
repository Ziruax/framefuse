# FrameFuse v4.1

Native desktop **image → video** merger with **viral kinetic captions**, exact **word-by-word timing**, **GPU-accelerated export**, and a preview that matches the exported video **pixel-for-pixel**.

## Highlights

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

### ✨ 21 kinetic typography animations
Pop-In · Slide-Up · Bounce-In · Scale-Pulse · Fade-Through · Typewriter · Reveal · Wave · Jitter · Shake · Drift · **Slam · Glitch · Spin-In · Flip-In · Elastic · Color-Cycle · Spotlight · Swing · Squash · Zoom-Words** — all rendered identically in the canvas preview and the burned-in ASS export (karaoke-safe tags included).

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
- Settings persist across restarts
- Keyboard shortcuts: `Space` play/pause, `←/→` ±1s, `Shift+←/→` segment step, `Home` restart
- Drag & drop images, audio **and** `.srt` files
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
