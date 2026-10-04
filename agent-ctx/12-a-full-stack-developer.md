# Task 12-a — Backend "speech" API routes (server-side Edge-TTS + ffmpeg + z-ai)

Agent: full-stack-developer (subagent, delegated by Task 12 lead)
Date: 2026-10-04

## What was built

Six Next.js App Router API routes + five server-only libs giving the WEB
preview (no `window.electronAPI`) the full speech capabilities the packaged
app has via IPC:

| Route | Verb | Lib | Purpose |
|---|---|---|---|
| `/api/tts/voices` | GET | `src/lib/server/edge-tts.ts` | 322-voice catalog, locale pairs, grouped languages |
| `/api/tts/synthesize` | POST | same | Edge-TTS MP3 (base64) + word timings, >2800 chars auto-chunked |
| `/api/dub/transcribe` | POST (multipart) | `src/lib/server/dub-transcribe.ts` | ffmpeg extract → silencedetect → z-ai ASR → timed utterances + language |
| `/api/dub/script` | POST | `src/lib/server/dub-script.ts` | LLM dubbing script (speakers + translation, JSON, retries) |
| `/api/dub/synthesize` | POST | `src/lib/server/dub-synthesize.ts` | per-speaker TTS + duration fit (speed-up re-synthesis) |
| `/api/dub/models` | GET | — | `{ models: [], langNames, provider: "web", web: true }` |

Shared server libs: `src/lib/server/edge-tts.ts` (createRequire runtime loader
of `electron/edge-tts.js` + 5-min voice cache), `dub-langs.ts` (DUB_LANG_NAMES
+ script hints), `zai.ts` (lazy z-ai-web-dev-sdk singleton, 429 retry).

## Key implementation notes (for the 12-b frontend agent)

- **Loading strategy**: `electron/edge-tts.js` and `ffmpeg-static` are loaded
  at RUNTIME via `createRequire(path.join(process.cwd(), "index.cjs"))` with
  ABSOLUTE paths — keeps them out of the turbopack graph (bundling would
  rewrite `__dirname` and break ffmpeg-static's binary path).
- **z-ai-web-dev-sdk**: NOT in project package.json. It exists only in the
  bun global install (`~/.bun/install/global/node_modules/z-ai-web-dev-sdk`).
  A symlink does NOT work (turbopack resolves the real path outside the
  project root → "Module not found"). Fix applied: real COPY into
  `node_modules/z-ai-web-dev-sdk` (`cp -rL ~/.bun/install/global/node_modules/z-ai-web-dev-sdk node_modules/`).
  **If node_modules is ever reinstalled, re-run that copy.** Config comes
  from `/etc/.z-ai-config` (runtime path, bundler-safe).
- **Transcribe timeline semantics**: when `meta` is present, `-ss startMs/1000
  -t (endMs-startMs)/1000` are applied as INPUT options on the uploaded file
  (the frontend should send FULL media files + their timeline trim windows);
  the extracted window maps onto the timeline starting at `startMs`. With no
  `meta`, files are laid out back-to-back (cumulative durations).
- ASR (WAV only) has NO timestamps → utterance word timings are estimated by
  char-weighted distribution inside each silence-detected speech segment.
- LLM role layout (sandbox-verified): system prompt goes as
  `{role:"assistant"}` + user message; `thinking:{type:"disabled"}`.
- The z-ai endpoints rate-limit (HTTP 429) under rapid-fire testing; both
  zai helpers retry once after 1.5 s. Transcribe drops failed segments and
  only 500s ("Speech recognition failed for every audio segment") when ALL
  segments fail.

## Verified results (curl, dev server port 3000)

1. `GET /api/tts/voices` → `ok:true`, 322 voices, 75 languages, pairs hi-IN = Swara/Madhur
2. `POST /api/tts/synthesize` (Hindi) → `ok:true`, bytesLen 21024, 5 words with real WordBoundary timings, chunkCount 1
3. `POST /api/dub/transcribe` (`/tmp/asr-test.wav` + meta) → `ok:true`, language "English", totalMs 6506, wordCount 17, 2 utterances
4. `POST /api/dub/script` (1 EN utterance → hi) → `ok:true`, Devanagari line, speakerCount 1, warnings []
5. `POST /api/dub/synthesize` (hi line, Swara) → `ok:true`, ttsDurMs 1263, speedApplied 1, base64 MP3
6. `GET /api/dub/models` → `ok:true, models:[], langNames, provider:"web"`

Extra checks: multi-file transcribe with per-file meta windows (timeline
coords correct), no-meta back-to-back, duration-fit speed-up path
(speedApplied 1.6 + "exceeds its slot" warning), 400/413 validation paths,
long-text 6000-char synthesize (chunkCount 2), lint clean, tsc 0 new errors.

## Contract deviations from the Task 12-a spec

- `volume` (0..2 linear) is mapped to the engine's `volumePct` as
  `(volume-1)*100` (1.0 = unchanged) — the engine takes an SSML percentage.
- rate/pitch/volume out-of-range values are CLAMPED (not 400); only
  non-numeric types are 400. Text/voice validation is 400 per spec.
- `maxDuration = 300` also exported on tts/synthesize, dub/script and
  dub/synthesize (spec required it only on transcribe) — harmless locally.
- Dub synthesize `totalDurationMs` = max(startMs + ttsDurMs) (audio end),
  matching the spec's example numbers.
- LLM `speakerCount` clamped to 1..6, `speaker` to 0..5; timings and `i`
  always copied from the request, never from the LLM.
