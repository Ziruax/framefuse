# Task 26-a — GPU WebCodecs + Canvas Export Architecture

## Status: COMPLETE — all 4 modules implemented, E2E-validated in the browser, gates green

## Files
- NEW `src/lib/export/SourceDecoder.ts` (707 lines) — mp4box demux → VideoDecoder, pull API (`getFrameForTimestamp`), decoder-owned frame queue with strict close discipline, backward-seek rewind path, Annex B fallback.
- NEW `src/lib/export/AudioMixer.ts` (269 lines) — OfflineAudioContext 48 kHz stereo mixdown → AudioEncoder (mp4a.40.2, 128 kbps) in 1024-frame f32-planar AudioData chunks; `isAudioEncoderSupported()`.
- NEW `src/lib/export/ExportOrchestrator.ts` (743 lines) — `runGpuExport(opts)`: ChunkSink (IPC 5 MB chunks / in-memory), mp4-muxer StreamTarget, VideoEncoder hardware→software ladder, per-clip SourceDecoders, caption drawing (wrap/stroke/background/karaoke via `activeWordIndex`), AbortSignal, typed errors.
- NEW `src/lib/export/gpu-export-demo.ts` (199 lines) — `runGpuExportSmokeTest(url, opts)` (never throws; returns stats + first 12 muxed bytes).
- NEW `src/lib/export/index.ts` (23 lines) — barrel.
- EDIT `electron/main.js` (+69 lines near other ipcMain registrations) — `exportStream` + `export-start` / `export-chunk` / `export-end`.
- EDIT `electron/preload.js` (+8 lines) — `exportStart` / `exportChunk` / `exportEnd` on `electronAPI`.
- FIXTURES (untracked): `public/samples/gpu-test-vp9.mp4` (140 KB, vp09.00.21.08), `public/samples/gpu-test-h264.mp4` (296 KB, avc1.42c01e Constrained Baseline), `public/samples/gpu-test-audio.wav` (192 KB).

## Parent E2E recipe (the promised browser validation)
The demo is importable from any same-origin page context on the dev server. Bundle + run:
```bash
cd /home/z/my-project
cat > __e2e-entry.ts <<'EOF'
export { runGpuExportSmokeTest } from "./src/lib/export/gpu-export-demo";
EOF
bun build __e2e-entry.ts --bundle --format=esm --target=browser --outfile=public/__e2e.js
# then in ANY browser console on http://localhost:3000:
#   const m = await import('/__e2e.js');
#   const r = await m.runGpuExportSmokeTest('/samples/gpu-test-vp9.mp4');
#   assert r.ok === true && r.framesDecoded > 0 && r.framesEncoded > 0
#          && r.headBytes[4..8] === 'f','t','y','p' (102,116,121,112)
# cleanup: rm public/__e2e.js __e2e-entry.ts
```
My run's numbers: VP9 → ok, 24/24 frames, 126,536 B, head 'ftyp' ✓; H.264 source → ok, 24/24 (avcC description path); 90-frame deep export re-parses to exactly 90 samples; 2 s export decoded by the real ffmpeg CLI → 60/60 frames, Duration 00:00:02.00.

## Two real bugs found by the E2E (both fixed in the shipped code)
1. **mp4-muxer 5.2.2 arity-validates `onData`** — must declare `(data, position)`, not `(data)`.
2. **`fastStart: false` patches the mdat box size at finalize()** — a backward 16-byte write at position ftypSize that an append-only IPC stream cannot apply. Switched to `fastStart: "fragmented"` (fully append-only byte stream; moov at start; 1 s fragments ≈ 200 KB overhead for 19 min; playability proven with ffmpeg). ChunkSink asserts strictly-sequential write positions and fails loud otherwise.

## Sandbox capability matrix (probed live)
- VideoDecoder: avc1 ✓, vp09 ✓ (both decode). VideoEncoder: vp09 prefer-hardware ✗ / software ✓ (ladder falls back), avc1.640028 ✓. AudioEncoder: mp4a.40.2 ✗ (open Chromium), opus ✓ → audio E2E here covers the typed-error path only; full AAC needs Electron/branded Chrome.

## Gates
`bunx tsc --noEmit` (minus pre-existing test-export-parity) → clean; `bun run lint` → 0 problems; `node --check electron/main.js && node --check electron/preload.js` → exit 0; dev.log clean; browser console 0 errors.

## VRAM audit
Every `new VideoFrame` (3 sites) and decoder-emitted frame is closed exactly once on success/error/abort/early-return — full path-by-path audit recorded in worklog.md Task 26-a. AudioData chunks and all encoders/decoders also close-on-every-path.

## Notes / follow-ups for parent
- Nothing committed (per constraints) — src/lib/export/ untracked, electron diffs uncommitted.
- Default export codec is VP9 (portable); H.264 works in sandbox Chromium if opted in (`videoCodec: "avc1.640028"`, `muxerVideoCodec: "avc"`).
- On Electron: gate audio on `isAudioEncoderSupported()`; if AAC is missing, fall back to the existing ffmpeg audio bus before calling `runGpuExport` with `tracks`.
- Dev server is reaped by the environment between tool calls — restart with the double-fork pattern and run the E2E inside one tool call.
