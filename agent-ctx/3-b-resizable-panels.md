# Task 3-b — Resizable editor panels (work record)

Agent: main (Z.ai Code)
Status: COMPLETE
Files I own/modified:
- NEW `src/components/ResizableSplitters.tsx` — `Splitter` component + `useResizableLayout()` hook (ALL layout state lives here)
- `src/app/page.tsx` — layout JSX region only (6 diff hunks: import, hook setup before `const debug`, main grid, media splitter insert, timeline wrapper, settings splitter insert). No panel props/handlers touched.
- `src/app/globals.css` — appended `.ff-splitter*`, `body.ff-resizing[-col|-row]`, `.ff-timeline-scroll`

## How the splitter system works (for later agents)

- Grid: `${mediaW}px 6px 1fr 6px ${settingsW}px` — splitters are grid children in their own 6px tracks; center column stays `1fr`.
- Timeline: `<Splitter>` row + wrapper div with explicit height + `.ff-timeline-scroll` (overflow-y auto, custom scrollbar), gated on `timelineIsV5` const (always true — page passes all v5 TimelineRuler props).
- Ranges: mediaW 220–560 (def 300) · settingsW 260–640 (def 320) · timelineH 150–65% viewportH (def 300).
- Persistence: localStorage key **`framefuse.layout.v52`** `{mediaW, settingsW, timelineH}`, 300ms debounce. Do NOT merge into `framefuse.settings.v50`.
- Compact: matchMedia `(min-width: 1024px)` — below 1024px → fixed `300px 1fr 320px`, auto timeline height, splitters hidden.
- State: module store + `useSyncExternalStore` (eslint `react-hooks/set-state-in-effect` errors block the naive useEffect approach in this repo — keep that in mind for similar hydration-restore features).
- Keyboard/a11y: role=separator, tabIndex=0, arrows ±16/Shift±64, Home/End, Enter/Space no-op; right panel + timeline drags are sign-inverted (ArrowRight shrinks settings, ArrowUp grows timeline).

## Verification (headless Chromium, live dev server)
- Drag math, snap ≤24px, dblclick reset, keyboard steps/bounds, inverted drags, 65% cap re-clamp, compact fallback + return, persistence round-trip, cyan hover vs zinc idle line, body class during drag — all verified.
- `bunx tsc --noEmit` clean · `bun run lint` 0 errors in my files (1 error exists in PreviewPanel.tsx from the parallel 3-c agent) · dev.log clean recompiles, GET / 200.

See worklog.md "Task ID: 3-b" for the full entry.
