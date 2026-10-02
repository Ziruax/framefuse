# Task 6-b — Remove ALL local whisper transcription; Groq Cloud only

Agent: groq-only-stt-agent (Z.ai Code)
Status: COMPLETE (lint 0 / tsc baseline-only / harness-verified / dev server 200)

## What changed (for later agents)

- `electron/main.js`: whisper:transcribe is GROQ-ONLY — no key → `"No Groq API key saved. Open Settings → Captions → Transcription and paste your free Groq API key (console.groq.com)."`; Groq failure → real error rethrown (recorded as `groq: <msg>` in whisperState). ENGINE 1 (faster-whisper sidecar) + ENGINE 2 (onnxruntime utilityProcess) fully deleted, incl. their helpers/watchdogs and the will-quit child kill. IPC surface now: `whisper:transcribe` / `whisper:cancel` (groqAbort only) / `whisper:status` (returns groqConfigPayload) / `whisper:groq-get|set|test` (untouched). `whisper:preload` + `whisper:fw-preload` REMOVED — do not call them. `utilityProcess` no longer imported.
- `electron/preload.js`: `whisperPreload` / `whisperFwPreload` bridge entries REMOVED.
- DELETED: `electron/whisper-core.js`, `electron/whisper-child.js`, `electron/faster-whisper-transcriber.py`, `src/lib/merger/whisper-worker.ts`, `scripts/stage-{whisper-service,whisper-model,faster-whisper,faster-whisper-model}.js`, `scripts/patch-transformers.js`, folders `whisper-service/` + `faster-whisper-runtime/`.
- `src/lib/merger/whisper.ts`: rewritten — Electron-bridge-only; non-Electron THROWS `"Transcription runs in the FrameFuse desktop app with a Groq API key."`; `isWhisperAvailable()` = bridge present; `WhisperOptions.model` field REMOVED; worker path / preloadWhisper / preloadFasterWhisperModel / WhisperModelStatus / mapWorkerProgress all gone.
- `src/lib/merger/sttSettings.ts`: `SttEngine = "groq"`; stored `"local"` migrates to `"groq"` on read; `sttRouting()` → `{ engine: "groq", groqModel }`.
- `src/lib/merger/types.ts`: `GroqConfigPayload.fwAvailable` removed; Window.electronAPI `whisperTranscribe` payload engine = `"groq"`, no `model` field; `whisperPreload`/`whisperFwPreload` declarations removed.
- `src/components/SettingsPanel.tsx` (transcription region ONLY — kinetic/dub/script-writer regions untouched): fixed "Groq Cloud — Only engine" badge replaces the engine toggle; local model picker + model-status/pre-download UI + sttEngine/pickEngine state deleted; clearGroqKey just clears the key; Groq key management + model buttons kept. `whisperModel`/`onWhisperModelChange` props still declared+passed (page.tsx wiring preserved) but unused inside CaptionsSection.
- `src/app/page.tsx`: transcribe call no longer passes `model`; isWhisperAvailable toast rewritten; whisperModel state kept for project-doc compat.
- `package.json`: `@xenova/transformers` dependency removed (bun.lock synced); postinstall = `node scripts/patch-electron-builder.js` only; staging scripts + `electron:build:fw` removed; electron:build has no whisper staging; extraResources = ffmpeg-static + ffmpeg + icon only. VERSION 1.19.0 KEPT.
- `.github/workflows/build-windows.yml`: build-chain comment updated (no whisper staging).

## Concurrency notes

main.js/SettingsPanel/types/preload/page were being edited by parallel agents DURING this task. All my edits were content-anchored (python splice with asserts / exact-string Edit) — no clobbering (verified coexistence). If you edit these files, re-verify anchors; don't trust stale line numbers.

## Verification

- `node --check electron/main.js` + `preload.js` pass.
- `bun run lint` exit 0.
- `bunx tsc --noEmit` → 9 errors = EXACTLY the documented baseline (test-export-parity ×3, engine.ts ×2, gpu-worker-client ×3, chroma ×1); zero new.
- Stub-electron harness (outside repo, /home/z/task-6b-tmp/harness.js): 6 whisper handlers; no-key error exact; status payload shape; groq set/get round-trip; cancel semantics; fake-key run goes straight to Groq (progress 8/12) with the real error rethrown — no fallback anywhere.
- dev.log: transient mid-edit errors self-healed; GET / → 200.
- Known leftover (intentional): `scripts/copy-wasm.js` still runs in build chains and self-skips ("@xenova/transformers not found") — per task "keep the rest intact".
