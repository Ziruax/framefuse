# Task 6-d — Single-voice option for video dubbing

Agent: main (Z.ai Code) · Status: COMPLETE · All checks green (repo lint has ONE error in the parallel 6-e agent's ScriptWriterSection.tsx — NOT this task's files; tsc = the 9 known baseline errors, zero new).

## The user complaint
"you dubbing videos you added two persons multiperson but did not added options to select single voice for dubbing" — the dub card only had per-speaker female/male selects and the pipeline ALWAYS ran LLM speaker detection.

## What changed (6 files, all surgical)

**1. `src/lib/merger/types.ts`**
- `DubSettings` gains `voiceMode: "single" | "multi"` + `singleVoice: string | null` (Edge-TTS ShortName; null = auto → locale pair female). Required fields, but every read site normalizes with `?? "multi"` / `?? null` so absent persisted fields stay legacy-safe.
- `window.electronAPI.dubStart` payload type gains the optional `voiceMode`/`singleVoice` fields.

**2. `src/app/page.tsx`** (3 surgical edits only — other regions belong to parallel agents)
- `DEFAULT_DUB_SETTINGS`: `voiceMode: "multi"`, `singleVoice: null`.
- `loadDubSettings()`: `voiceMode` reads `j.voiceMode === "single" ? "single" : "multi"`; `singleVoice` is only kept when `voiceMode === "single"` AND it's a non-empty string — a stored multi mode with a stale single voice normalizes to null (multi pipeline stays byte-identical).
- `startDub` payload: `voiceMode: dubSettings.voiceMode ?? "multi"`, `singleVoice: dubSettings.singleVoice ?? null` (dubSettings is a machine-level localStorage pref — `framefuse-dub` — never a project-file field, so project.ts needs nothing).

**3. `electron/main.js`** (dub:start mapping — mirrors how femaleVoice/maleVoice flow)
- `voiceMode: p.voiceMode === "single" ? "single" : "multi"`, `singleVoice: typeof p.singleVoice === "string" ? p.singleVoice.trim() : ""` threaded into the `DUB.runDub` options object right after the `speakerVoices` map; handler JSDoc updated.

**4. `electron/dub-workflow.js`** (the core)
- runDub computes `singleVoice` (trimmed) + `singleMode = o.voiceMode === "single" || singleVoice.length > 0`. When singleMode AND singleVoice is non-empty, `ctx.speakerVoices` becomes `{ 0: sv, 1: sv, 2: sv, 3: sv }` — EVERY possible speaker id resolves to the single voice through the EXISTING `pickVoiceForSpeaker` override path (minimal-risk choice: no changes to pickVoiceForSpeaker/pickVoicePair).
- runPipeline's speakers phase branches: `ctx.singleMode ? singleVoiceSpeakers(ctx, trans) : detectSpeakers(ctx, trans)`.
- NEW `singleVoiceSpeakers`: reports "Single voice mode — skipping speaker detection" (5%) then "Single voice — one narrator for every line" (100%); resolves the locale pair with the SAME duplicated pickVoicePair block (kept duplicated so the multi path is untouched); returns `{ speakerCount: 1, voiceList: [{ id: 0, voice, gender }], ids: all 0, warnings: pairPick.warnings }`. NO LLM call, NO heuristicSpeakers — translation + TTS + fit phases unchanged.
- Empty singleVoice + voiceMode "single" → `pickVoiceForSpeaker(0, pair, null)` → the locale pair's default female (exactly the task's fallback rule).
- Multi mode with null/absent singleVoice: `speakerVoices` passthrough + `detectSpeakers` — byte-identical to ≤ v1.19.
- runDub JSDoc documents both new opts.

**5. `electron/preload.js`** — comment-only update (dubStart forwards the payload as-is).

**6. `src/components/SettingsPanel.tsx`** (DubSection ~4905-5400, my assigned region)
- NEW "Voice mode" segmented control ABOVE the speaker selects: two pill buttons "One voice" (User icon) / "Multi-speaker" (Users icon), styled exactly like the STT engine toggle (cyan active pill `border-cyan-500/60 bg-cyan-500/15 text-cyan-300`, `aria-pressed`, role=group).
- "One voice" → hides both speaker selects, shows ONE "Dubbing voice" select (all locale voices, NO gender filter) + preview button. `singleVoiceValue` = the stored pick when the locale offers it, else femaleVoice → pair female → first locale voice (the displayed default IS the voice the backend picks for null). Controlled-select safety: fallback `<option>` when the catalog hasn't loaded.
- "Multi-speaker" → the original Speaker 1/Speaker 2 selects, unchanged.
- `setVoiceMode`: leaving single mode clears `singleVoice` to null (multi stays byte-identical); entering keeps/nulls per stored value.
- Locale hygiene: `changeLanguage` resets `singleVoice` to null (the pick belongs to the old locale); the locale-sync useEffect now ALSO resets a single pick that the (new) locale's catalog doesn't offer (`singleStale`, gated on the catalog having loaded — `voices.length > 0` — so nothing is wiped before ttsVoices resolves).
- All writes flow through `onDubSettingsChange({ ...dubSettings, voiceMode, singleVoice })` (page.tsx persists to `framefuse-dub`).

## Verification (all green)
- `node --check` dub-workflow.js + main.js + preload.js → OK.
- **Pipeline harness** (agent-ctx/6d-harness/dub-single-voice-harness.js — REAL runDub, real ffmpeg/ffprobe, Groq+EdgeTTS stubbed via `_setDepsForTesting`): 6 runs pass —
  1. single+explicit voice: NO speakers LLM call (only translate), all segments speaker 0, all 3 syntheses on the single voice, "Single voice mode — skipping speaker detection" status, speakers `[{id:0,voice:sv,gender:null}]`;
  2. single+empty voice: still no detection, voice = hi-IN-SwaraNeural (pair female), gender "female";
  3. legacy payload (singleVoice only, no voiceMode): single mode per the task rule;
  4. multi (nothing): speakers LLM called, 2 speakers, alternating female/male synth `[Swara, Madhur, Swara]`, "Detecting speakers" status — legacy intact;
  5. multi + speakerVoices overrides: the femaleVoice/maleVoice map still wins per speaker;
  6. multi + leftover singleVoice: the non-empty singleVoice wins per the task rule (unreachable from the UI — the UI clears it).
- **Browser verification** (stub-proxy.js + electron-stub.js on :3100, the worklog 3-b pattern — injected `window.electronAPI` before hydration, HMR WS proxied): studio boots clean (0 page errors, HMR connected) → Audio tab → Translate & Dub:
  - default Multi-speaker pressed, Speaker 1/Speaker 2 selects visible;
  - "One voice" → aria-pressed flips, speaker selects hide, "Dubbing voice" select shows ALL 4 hi-IN voices (incl. male Madhur — no gender filter) with Swara (the female default) selected;
  - pick Madhur → localStorage `framefuse-dub` gains `voiceMode:"single"`, `singleVoice:"hi-IN-MadhurNeural"`;
  - back to Multi-speaker → `voiceMode:"multi"`, `singleVoice:null` (cleared), speaker selects restored;
  - legacy v1.19 prefs (no new fields) → loads as multi (internal defaults; nothing rewritten until a change);
  - single mode + language switch English → singleVoice reset to null, femaleVoice/maleVoice reset;
  - stale singleVoice for a locale with no voices → reset to null once the catalog loads (fixed the initial `localeNames.size > 0` guard to `catalog.length > 0`);
  - screenshot: agent-ctx/6d-single-voice-ui.png.
- `bunx tsc --noEmit` → EXACTLY the 9 documented baseline errors (scripts/test-export-parity ×3, export/engine ×2, gpu-worker-client ×3, chroma ×1) — ZERO new.
- `bunx eslint` on my three src files → exit 0, zero problems. (Repo-wide `bun run lint` currently exit 1 from ONE `react-hooks/preserve-manual-memoization` error in src/components/ScriptWriterSection.tsx — the parallel 6-e agent's untracked file, not touched by this task.)
- dev.log: clean compiles, GET / 200s, no errors.

## End-to-end flow (single voice)
Settings → Audio → Translate & Dub → "One voice" (+ optional pick) → `framefuse-dub` pref persists `voiceMode/singleVoice` → Start dubbing → page.tsx startDub payload carries both → main.js dub:start maps them into runDub opts → dub-workflow: singleMode → speaker detection SKIPPED (progress says "Single voice mode — skipping speaker detection"), every utterance = speaker 0, every synthesis on the one voice (or the locale female when auto) → translate/TTS/fit unchanged → result shows "1 speaker · N segments" → Add to timeline as before.
