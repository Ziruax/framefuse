# Task 6-e — Google Gemini models for AI script writing (Gemini 3.5 Flash Lite default)

Agent: main (Z.ai Code) · Status: COMPLETE · All checks green.

## What was built

**1. NEW `electron/gemini-chat.js`** (plain Node CommonJS, ZERO Electron imports — `node -e "require('./electron/gemini-chat')"` works):
- `GEMINI_TEXT_MODELS`: gemini-3.5-flash-lite (DEFAULT), gemini-3.5-flash, gemini-3.1-flash-lite, gemini-2.5-flash, gemini-2.5-pro; `GEMINI_DEFAULT_TEXT_MODEL = "gemini-3.5-flash-lite"` (exported).
- Key storage mirroring groq-whisper.js exactly: `geminiConfigPath`, `loadGeminiConfig`, `saveGeminiConfig` (userData/gemini.json, mode **0600**, mkdir recursive), `removeGeminiConfig`, `maskGeminiKey` (first-7 + last-4), `geminiConfigPayload` → `{ hasKey, maskedKey }` — raw key NEVER crosses the bridge.
- `geminiChat({ apiKey, model, systemPrompt, userPrompt, temperature=0.8, maxOutputTokens=4096, timeoutMs=120000, retries=2, abortRef, signal })`:
  - POST `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`, header `x-goog-api-key`, body `{ systemInstruction:{parts:[{text}]}, contents:[{role:"user",parts:[{text}]}], generationConfig:{temperature,maxOutputTokens} }`.
  - Joins `candidates[0].content.parts[].text`; SAFETY/RECITATION (+ `promptFeedback.blockReason`) → clear non-retryable error; empty content split into transient (STOP/no reason, retryable) vs named reason (e.g. MAX_TOKENS, non-retryable).
  - HTTP map: 400 invalid request, 401/403 key invalid/missing access, 404 model-not-found→pick another, 429 rate limit, 5xx server; 2-retry backoff (1.5s/4s) on 429/5xx/network ONLY; 10 MB response cap; total-request timeout; abortRef + AbortSignal both wired (verified vs live Google API: bogus key → status 400, retryable false, `[API key not valid…]` appended).
- `geminiTestKey({ apiKey } | "key")` → GET /v1beta/models → `{ ok, message, modelCount }`.

**2. `electron/main.js`** — requires `GM = gemini-chat` + `GC = groq-chat` after the DUB require; `// ── v1.20 GEMINI SCRIPT WRITING ──` block inserted AFTER `whisper:groq-test` / BEFORE the v1.17 VOICEOVER comment (survived the concurrent whisper-region edits — now at ~1072-1213 after line shifts):
- `gemini:get` → masked payload; `gemini:set` ({ apiKey }, non-empty validated) → save + masked payload; `gemini:test` ({ apiKey? } — candidate or saved key); `gemini:clear` → unlink gemini.json → { ok }.
- `script:generate` ({ provider:"gemini"|"groq", model, prompt, tone?, durationSec?, language? }): ONE `buildScriptSystemPrompt` (hook-first-line, spoken-word contractions/short sentences, `[pause]` + CAPS emphasis cues, narration-ready plain text NO markdown, ~2.5 words/sec length target, tone default "energetic", language default English, prompt cap 2000 chars). Gemini path → saved gemini.json key (friendly error if none); Groq path → `GC.groqChat` with the saved groq.json key from `GQ.loadGroqConfig` (error if none) — messages [{system},{user}], temperature 0.8, maxTokens 2048. Returns `{ ok:true, text, model, provider }` | `{ ok:false, error }` — NEVER throws.
- `script:models` → `{ gemini:{ models, default:"gemini-3.5-flash-lite", hasKey }, groq:{ models: GC.GROQ_TEXT_MODELS, default: GC.DEFAULT_TEXT_MODEL, hasKey } }`.

**3. `electron/preload.js`** — `geminiGet/geminiSet/geminiTest/geminiClear`, `scriptGenerate: (p) => invoke("script:generate", p)`, `scriptModels: () => invoke("script:models")` (JSDoc'd, after the dub block).

**4. `src/lib/merger/types.ts`** — new `GeminiConfigPayload`, `ScriptModelInfo`, `ScriptModelCatalog` interfaces + the 6 optional methods on the global `window.electronAPI` declaration (scriptGenerate typed as the ok-true/ok-false union).

**5. NEW `src/components/ScriptWriterSection.tsx`** ("use client", zero props, fully self-contained):
- Collapsible section card replicating SettingsPanel's Section tokens (rounded-lg, #27272a border, #131316 body, rotating chevron, Sparkles icon, "AI Script Writer" header + "Generate narration scripts with Gemini or Groq" subtitle).
- Model `<select>` with optgroups "Google Gemini" (5 models, gemini-3.5-flash-lite FIRST) + "Groq" (6 groq models); loads from `scriptModels()` IPC, hardcoded identical fallback otherwise; persisted selection normalized against the known ids.
- Gemini key row mirrors the Groq key UX: masked mono display + Test/Replace/Remove when hasKey; password input + Save key/Test/Cancel + "Get a free key" (aistudio.google.com/apikey) when not; Groq model selected → "Groq key is managed in Captions → Transcription" + hasKey badge.
- Prompt textarea (topic placeholder), Tone (5) / Duration (15/30/60/90/120s) / Language (English/Urdu/Hindi/Arabic/Spanish/French/German) selects row.
- "Generate script" button (spinner + disabled busy state), inline red error panel + `@/lib/toast` toasts (the project-wide toast lib), editable result textarea with live word count + ≈duration at 2.5 words/s + Copy (navigator.clipboard, transient check), note "Copy the script into the Voiceover narration field to synthesize it."
- All prefs (model/prompt/tone/durationSec/language/lastScript) persist in localStorage `framefuse.scriptwriter.v1`.

**6. `src/components/SettingsPanel.tsx`** — exactly 2 surgical edits: one import line (after `import { cn }`) + `{inElectron && <ScriptWriterSection />}` between the VoiceoverSection block and the v1.17 Dub comment. No other lines touched.

## Verification
- `node --check` gemini-chat.js + main.js + preload.js → OK (re-verified AFTER the concurrent whisper-removal edits landed; my block sits intact between `whisper:groq-test` and the v1.17 VOICEOVER banner).
- Live network smoke: bogus key → `Gemini rejected the request … [API key not valid. Please pass a valid API key.]` (status 400, retryable false). Config storage: 0600 mode, masked `AIzaSyA…0xyz`, remove→true/false semantics.
- `bun run lint` → exit 0 (fixed one `react-hooks/preserve-manual-memoization` dep-subproperty issue + removed an unused eslint-disable).
- `bunx tsc --noEmit` → EXACTLY the 9 known baseline errors (test-export-parity ×3, export/engine ×2, gpu-worker-client ×3, chroma ×1) — ZERO new.
- dev.log: `GET / 200`, clean Turbopack compiles, no errors.

## Notes for other agents
- The Gemini key file is `userData/gemini.json` (0600); groq.json remains the single Groq key (shared by whisper + dub + script:generate groq provider).
- `script:generate` NEVER throws — renderers must check `r.ok` and display `r.error`.
- SettingsPanel.tsx Audio-tab order is now: Audio → Voiceover → **AI Script Writer** → Dub.
