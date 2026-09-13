# FrameFuse Worklog

Project: FrameFuse v5.2 improvement sprint (cloned from https://github.com/Ziruax/framefuse.git)
Location: /home/z/my-project (Next.js 16 + Electron video editor)
Dev server: `bun run dev` on port 3000 (logs → dev.log)

## Architecture Summary (from end-to-end analysis)

- **UI**: src/app/page.tsx (3153 lines, main editor) + MediaPanel/SettingsPanel/PreviewPanel/TimelineRuler/Header components
- **Data model**: src/lib/merger/types.ts (MediaSegment, ItemEdit{track,volume,trim,speed,chroma,overlay}, SfxItem, AudioSettings, ExportSettings)
- **Timeline**: src/lib/merger/timeline.ts — base lane (track 0) + overlay lanes (track ≥1), absolute/sequential modes
- **Preview**: hidden <video> elems → canvas compositing (renderer.ts), WebGL ChromaKeyer (chroma.ts)
- **Export (Electron)**: native.ts → IPC export-native → electron/main.js two-step (parallel clip encode pool → concat + amix audio) using ffmpeg-static; filter graphs in electron/export-graph.js
- **Whisper**: dual-engine — native utilityProcess (electron/whisper-child.js + whisper-core.js, onnxruntime-node 1.14.0 pinned) + browser worker fallback (whisper-worker.ts, WASM). Model: Xenova/whisper-tiny from HuggingFace.
- **SFX**: procedural synthesis (sfx.ts, OfflineAudioContext → WAV) mixed via amix+adelay
- **Music**: single global audioTrack pinned at t=0, NO volume, NOT editable on timeline

## User Requirements (from task)

1. Fix Whisper tiny (download + work reliably, no errors)
2. Fix preview video sizing (16:9 shrunk in fixed container; other aspects too) → responsive stage + auto aspect detect + fit/cover
3. Resizable editor panel areas (draggable splitters like other editors)
4. SFX/music: proper timeline editing for background music — draggable music clip, volume control, place on entire video (loop), editable timeline
5. Green screen overlay: on-canvas area select/adjust like CapCut PiP, chroma key color picker (exists), extend overlay to entire video length (loop)
6. No features applied by default (Ken Burns off, captions opt-in)
7. Export speed improvements (study open-source editors: single audio mix pass, thread budgeting, async IO)
8. UI/feature audit vs Shotcut-style editors, low-end friendly
9. Push to GitHub (token provided), build Windows installer, push to GitHub release

---
Task ID: 1
Agent: main (Z.ai Code)
Task: Project setup — clone framefuse into /home/z/my-project, install deps, start dev server

Work Log:
- Cloned https://github.com/Ziruax/framefuse.git to /home/z/framefuse-src, analyzed end-to-end with 3 parallel research agents (frontend UI, panels+whisper, electron+export)
- Replaced template my-project contents with framefuse (git history preserved, remote origin → Ziruax/framefuse)
- package.json: version 5.2.0, dev script now logs to dev.log, electron:build → --win nsis (real installer), added trustedDependencies (electron, ffmpeg-static, electron-builder, unrs-resolver)
- bun install --trust OK (719 pkgs; ffmpeg-static 5.3.0 with Linux binary; electron dist downloaded; onnxruntime-node 1.14.0 with win32/linux/darwin bindings)
- Dev server running on :3000, GET / 200, baseline UI renders

Stage Summary:
- Environment ready; baseline verified (HTTP 200, FrameFuse UI renders)
- HuggingFace reachable from sandbox (needed for Whisper model download test)
- Next: Task 2 — data model v5.2 changes (OverlayTransform x/y free positioning, music track fields, defaults-off)
