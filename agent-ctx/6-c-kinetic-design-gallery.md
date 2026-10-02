# Task 6-c — Kinetic Typography Design Library (make the 24 designs VISIBLE)

Agent: main (Z.ai Code) · Status: COMPLETE · lint exit 0 · tsc = exactly the 9 documented baseline errors (zero new) · browser-verified end-to-end.

## The complaint

"newly added kinetic typography design are not shown in frontend what the hell you are doing update them properly" — root cause verified: in the default state (engine ON, mode "auto") the UI showed ONLY abstract controls (mode/variation/intensity/density/motion/seed). The 24 presets were reachable solely through a plain text `<select>` that existed ONLY in "single" mode, and the whole KineticTypographySection returned `null` when no word-timed cues existed (`if (!hasWords) return null;`), so the designs were invisible before transcription too.

## What was built (all inside KineticTypographySection's region, ~3990–4850 in the current file)

**1. `KineticPresetGallery` component** (new, inserted after `KINETIC_PREVIEW_CUES`): a "Design library" Field containing a `@container max-h-[26rem] overflow-y-auto` scroll box (global `*::-webkit-scrollbar` styling applies) with:
- **Tile 1 — "Auto mix"**: full-width button, Shuffle icon (lucide) in a bordered chip, "Auto mix" + "Engine picks per scene — all 24 presets scored" two-line label. Click → `setKinetic({ mode: "auto" })`; selected (mode === "auto") → amber-400 border + glow + amber icon chip.
- **Tiles 2–25 — the 24 presets**, grouped by family with a `text-[10px] uppercase tracking-wider text-zinc-500` header row per group (KINETIC_FAMILY_ORDER + KINETIC_FAMILY_LABELS: Cinematic · Dramatic · Conflict · Conversational · High Intensity). Responsive grid: `grid-cols-2 gap-1.5 @min-[420px]:grid-cols-3 @min-[560px]:grid-cols-4` (container queries — 2 cols at the default 320px panel, more when the splitter widens it).
- Tile click → `setKinetic({ mode: "single", presetId })`; selected (mode === "single" && presetId matches) → cyan-400 border + `shadow-[0_0_12px_rgba(34,211,238,0.3)]` glow + `aria-pressed`.
- Tile styling per the spec: `bg-zinc-900/80 border border-zinc-800 hover:border-zinc-600 rounded-lg p-1.5`, name `text-[11px] text-zinc-300 truncate`, full tooltip = name + description, native button (keyboard/touch OK, ~100px touch target).

**2. `KineticPresetTile` component** (new): one static mini-canvas (`h-[72px]` full tile width, `#0a0a0c` bg) + preset name.
- Sample cue `KINETIC_GALLERY_CUES` = "but the truth was worth it" — 6 words, 2 semantic phrases, "truth" the emphasis word (semantic score 7 ≥ the emphasis bar, so EVERY preset's accent color + hierarchy pattern shows; the task's suggested "your story starts now" scores 0 emphasis and would render all 24 tiles with no accent at all). Words spoken 0–2600ms + a 600ms cue hold tail (endMs 3200).
- Plans: one `buildKineticPlan(KINETIC_GALLERY_CUES, { ...KINETIC_DEFAULTS, ...kineticRaw, enabled: true, mode: "single", presetId })` per preset, memoized in ONE `useMemo` keyed on the raw persisted `captionSettings.kinetic` (stable identity — no rebuilds on unrelated renders).
- Draw: `drawKineticComposition(ctx, comp, preset, { fontSizeScale: 0.42 (KINETIC_TILE_FONT_SCALE — same floor-dominated regime as the live preview), fontOverride: null, accentOverride: null, motionLevel: kinetic.motion, currentMs = 85% of the composition }, cssW, cssH, ctx.measureText measure)` — the SAME mechanism the live preview uses (draw solves layout internally via layoutKineticComposition; no separate geometry pass needed). Thumbnails deliberately render each preset's OWN font + accent (the design's identity); user overrides still apply to the big live preview. 85% snapshot time = 2720ms: after every entrance (last word enters ≤2517ms even for whisper-type's 480ms) and before every exit (earliest exitStart = 2820ms) — every word fully visible, nothing fading.
- Performance: NO rAF loop. One draw per effect run + ResizeObserver (splitter drag / drawer open) + one `document.fonts.ready` re-render (first paint may measure with fallback fonts). DPR-aware backing store, `clientWidth < 4` guard for hidden-tab mounts. Effect deps `[plan, preset, motionLevel]` — no re-render loops.

**3. Early-return fix** — `if (!hasWords) return null;` REMOVED. When `!hasWords` the section now renders: engine Toggle (stays enabled) + description + (when enabled) the gallery **dimmed + inert** (`opacity-50 pointer-events-none` on the scroll box, `disabled` on every tile button — canvases still painted) + amber hint line "Generate captions with word timing (transcribe your audio) to unlock kinetic typography." The abstract controls (mode/variation/intensity/density/motion/seed/live preview) render only when hasWords — wrapped in `{hasWords && (<> … </>)}`.

**4. The plain single-mode `<select>` REMOVED** (superseded by the gallery; a breadcrumb comment marks where it was). Manual-mix checkbox list, mode Segmented, and ALL other controls kept below the gallery.

**5. Mount-site comment** in CaptionsSection updated ("always rendered (v1.20)… dimmed until then" — was "renders only when word timing exists").

**6. Imports** (surgical, unique anchors): `Shuffle` added to the lucide block; `type KineticPlan, type KineticPresetSpec` added to the kinetic/types import.

## Concurrency

Other agents (6-b Groq-only STT, 6-d single-voice dub, 6-e Gemini script writer) were editing OTHER regions (transcription ~2797–3250, dub ~4905+, a mount ~1455, plus whisper.ts/main.js). All my edits were 8 exact-string MultiEdit anchors inside the kinetic region; after 6-b's later rebase-shifted the file (+144/−330 lines), my region was re-verified intact (grep + full browser pass below). Mid-session tsc briefly showed 6 errors in THEIR in-flight lines (stale preloadWhisper imports etc.) — never in mine; final state: exactly the 9 baseline errors.

## Verification

- `bun run lint` → exit 0. `bunx tsc --noEmit` → 9 errors, byte-identical to the documented baseline (test-export-parity ×3, export/engine ×2, gpu-worker-client ×3, chroma ×1) — ZERO new.
- Isolated plan harness (bun, outside the repo): all 24 presets → exactly 1 composition, 6 words, 2 phrases, emphasis=truth, window [0,3200], t=2720 in-window post-entrance pre-exit, `compositionAt(t)` resolves — 24/24 OK. Layout harness at 150×72 with stub measure + real motion solver: every preset ≥1 line, 6/6 words visible (push-stack 0.55α = its designed push-out state), emphasis word visible, block inside canvas — 24/24 OK.
- Browser (agent-browser, live dev server): landing → studio → Captions tab. **Locked state (no subtitles, engine toggled ON): 24 painted tile canvases** (pixel-sampled: 24/24 with real lit pixels), 5 family headers present, gallery `opacity 0.5` + `pointer-events none`, Auto button `disabled`, amber hint line present, engine toggle clickable. Screenshot `agent-ctx/v1.20-gallery-locked.png`. **Unlocked state (one-word-per-cue words.srt via DataTransfer → regrouped, hasWords true): 25 canvases (24 tiles + live preview), hint gone, Auto mix pressed+enabled.** Click "Punch Stack" → `aria-pressed=true`, border = cyan-400 (Lab-verified), Auto deselected, the "Typography mode" Segmented below syncs to "Single". Click "Auto mix" → amber-400 ring, Segmented back to "Auto Mix". `agent-ctx/v1.20-gallery-punch-selected.png` + `v1.20-gallery-auto-selected.png`. Zero page errors; dev.log clean (GET / 200s).
- NOTE: agent-browser sessions get reaped between long tool calls (the known sandbox behavior) — the full click-path had to run as one chained command per session.

## Files changed

- `src/components/SettingsPanel.tsx` — ONLY the kinetic region + 2 import lines + the mount comment (~+380/−30 lines; everything else in the working tree belongs to the parallel agents).
