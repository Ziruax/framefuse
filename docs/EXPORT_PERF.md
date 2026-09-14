# FrameFuse v6.5 — Export Performance Pipeline (CPU-first)

> Modules: `electron/export-singlepass.js` (chunk planner + windowed builder),
> `electron/export-graph.js` (Ken Burns on-offset), `electron/main.js` (routing)
> Verification: `bun run test:export-parity` (50) · `node scripts/verify-timeline-chunks.js` (30) ·
> `npm run bench:export` (F1–F4 + cancellation)

## v6.5 — CPU-FIRST PARALLEL SINGLE-PASS (the headline change)

**Most FrameFuse users have no GPU.** A single ffmpeg process cannot use a
many-core CPU when the filter graph (libass subtitles, overlay compositing,
zoompan) is the bottleneck — those stages are single-threaded, so an 8-core
box exported at ~1-core speed. v6.5 splits the timeline into **W frame-aligned
windows** and renders them in **parallel ffmpeg processes** (each with
cores/W encoder threads), renders the audio bus **once** as its own process,
and glues everything with a **lossless concat + mux**:

```
CPU export (≥4 cores), timeline ≥ 30 s:
  planTimelineChunks  → W windows on the GLOBAL OUTPUT FRAME GRID
                      (W = clamp(floor(cpus/3), 2, 4), chunks ≈ 22.5–45 s)
  W × videoOnly single-pass graphs (pool, cores/W threads each)
  1 × audioOnly render (full timeline — no per-chunk AAC boundary glitches)
  1 × concat + mux (-c copy both streams)
GPU export / short timelines / <4 cores → W=1 single-pass (unchanged v6)
```

Speedup on an 8-core CPU box: ~2–3× (filter-bound timelines). On 12–16 cores:
up to ~4×. GPU boxes keep the W=1 single-pass (one NVENC session saturates the
GPU; the <40 s KPI target does not need chunking).

### Why the chunk math is safe (all verified against real ffmpeg)

- **Frame-grid alignment**: every boundary is a GLOBAL OUTPUT FRAME index;
  per-segment sub-windows derive from frame counts with µs-precision seeks
  (`buildVideoInputArgs`' `ssSec`) — the concatenated frames are the W=1
  frames sliced at the boundary. Emitted-frame model per segment type:
  video/static-image `ceil(dur×fps)` (empirically measured), Ken Burns
  `round(dur×fps)` (zoompan `d=`).
- **Ken Burns mid-chunk cuts** continue the exact curve: the zoompan
  expressions use `(on + K)` against the FULL segment's frame divisor
  (`kenBurnsZoompanExprs` onOffset) — frame-MD5-verified.
- **Fades never straddle a boundary**: ffmpeg's `fade` REJECTS negative `st`
  (verified empirically), so a mid-ramp continuation is impossible — the
  planner treats every fade window (and every xfade head zone, which also
  needs the previous segment's input in-process) as a FORBIDDEN ZONE and
  routes boundaries around them. Whole-fade containment ⇒ pure shift.
- **Overlays crossing a boundary** get their input `-t` padded ~120 ms past
  the chunk end (framesync + `eof_action=pass` would otherwise drop the
  overlay from the chunk's LAST frame); overlays ENDING inside a chunk keep
  the unpadded EOF to reproduce the W=1 render's exact end behavior.
- **Boundary plans read the ORIGINAL segments** (`fullSegments` + `origIdx`)
  — a windowed duration must never re-clamp a transition duration.
- **Phase normalization**: every single-pass video chain ends with
  `,setpts=PTS-STARTPTS`. Without it, an input seek whose phase lands in the
  first half of a source frame interval (frac(trimIn×fps) ∈ (0,0.5)) makes
  the fps filter emit its first frame one slot late, and the concat filter
  fills the leading sub-frame gap with a DUPLICATE (+1 frame per affected
  segment — a v6 W=1 bug found by independent review, now fixed and guarded
  by the "W=1 emits EXACTLY the frame model" assertion).
- The residual W=1↔chunked differences, all bounded and drift-free:
  (a) the measured **xfade chroma-resample rounding** (≤4/255 on ≤2 % of
  pixels, sub-perceptual) on frames whose segments lost the head-composite
  passthrough — the chunked render is arguably MORE accurate; and (b) a
  **±1-SOURCE-FRAME phase jitter** for segments cut mid-way with speed ≠ 1
  or srcFps ≠ fps (a seek-based sub-window resets the fps filter's
  fractional phase; W=1 accumulates it from the segment start). The jitter
  is ≤ one source frame (~22–40 ms), never accumulates (frame counts, the
  boundary frame, chunk 0, and the audio bus all stay bit-exact), and the
  sub-seek law `F(j0) = ceil(trimIn×g) + floor(j0·g·speed/fps)` makes
  speed-1 rate-matched cuts bit-exact at ANY trim alignment.
- `node scripts/verify-timeline-chunks.js` (30 assertions) proves all of it
  with **lossless (-qp 0) frame-MD5 parity** between the full W=1 render and
  the chunked render, plus decoded-PCM parity for the audio bus, plus a
  W=1 **byte-differential vs git HEAD** regression guard (0 drift).

### v6.5 also ships

- **Full FFmpeg build bundled** (`scripts/fetch-windows-ffmpeg.js` →
  `resources/ffmpeg/win/{ffmpeg,ffprobe}.exe` via electron-builder
  extraResources; BtbN full GPL build, primary, with the gyan stable 7z as
  fallback and ffmpeg-static as last resort). The pre-v1.5 packaged app
  shipped the ffmpeg-static minimal build: **no NVENC/QSV/AMF** (GPU users
  silently exported on CPU) and **no ffprobe at all** (every media probe fell
  back to the slow `ffmpeg -i` parser). The resolution matrix prefers the
  bundled full build; `ffmpeg-status` reports build kind + encoders + libass
  + ffprobe (Export tab badge).
- **Whisper-tiny bundled in the installer**
  (`scripts/stage-whisper-model.js` stages the quantized ONNX model into
  `whisper-service/models/Xenova/whisper-tiny`, ~42 MB): first transcription
  works fully OFFLINE — local-first pipeline build, remote download only as
  the fallback. Captions panel shows "Bundled with installer — works offline".
- The same BtbN ffmpeg version (N-126549) was validated on Linux by running
  the entire real-ffmpeg harness suite against it (30/36/22/kenburns all
  green) — the Windows exe is the same commit.


## TL;DR — what changed and why it is faster

| Layer | v1.4.2 (before) | v6 (after) |
|---|---|---|
| Architecture | two-step: N per-clip encodes → concat demuxer + audio mux | **routing**: all-copy → TURBO pool (unchanged) · else **single-pass** (ONE ffmpeg process, whole timeline) · else two-step fallback |
| Process count (12-clip KPI fixture) | **41 ffmpeg children** | **1** |
| Clip audio | PCM WAV extraction per clip (pool job) + amix in step 2 | mixed inline from the base inputs' own `[i:a]` streams |
| Audio passes (normalize ON) | ~5 per source (extract → measure → raw-mix WAV render → measure WAV → remux) | **2** (seeked source-window measure, parallel → inline final) |
| Audio passes (normalize OFF, default) | 2 (extract + mix) | **1** (inline) |
| Probes | `ffmpeg -i` stderr parse, per export, no persistence | **ffprobe JSON**, mtime+size keyed, memory + disk cache (24 h TTL) |
| Keyframe scans (TURBO trims) | ffmpeg showinfo window scan per trim | ffprobe `-skip_frame nokey -read_intervals` (decodes only keyframes), cached |
| Mid-GOP trims | full re-encode | **sandwich copy**: ≤2 s edges re-encode, ≥4 s middle rides `-c copy` (frame-accurate at both boundaries) |
| NVENC args | `p4/p6 + tune hq + vbr + cq + maxrate + bufsize` (constrained VBR) | unconstrained CQ VBR + `-multipass qres` (+ `b_ref_mode middle` on quality tiers) — the rate-control pass is gone |
| GPU pool | `min(3, cpus−1)` concurrent sessions (GPU thrash) | **1** session (one NVENC/QSV/AMF session saturates the GPU) |
| CPU pool | `min(4, cpus−2)` | `min(2, floor(cpus/4))` (x264 scales with threads, not processes); single job still gets `-threads 0` |
| Ken Burns (images) | zoompan (single-threaded) per clip process | **same zoompan expressions** (shared `kenBurnsZoompanExprs` source), fed a single-frame input — byte-identical output, verified |
| Captions | burned per clip in step 1 (N libass instances) | burned **once** on the concatenated stream |
| Windows CLI limit | dodged via two-step (short per-clip filter strings) | dodged via **`-filter_complex_script`** file |

## Routing (export-native)

```
build loop decides per-clip: copy / sandwich / encode (unchanged math)
  ├── ALL clips copy          → TURBO pool + concat (seconds-class, unchanged)
  ├── any encode + eligible   → SINGLE-PASS (≤70 segs, ≤40 overlays,
  │                             captioned ≤600 s, graph ≤25 KB)
  │                             └── init-failure (<4 s) or oversize → two-step fallback
  └── else                    → two-step pool (chunked for long videos)
```

Eligibility ceilings are deliberate: captioned projects > 10 min keep the
**chunked pool** (v1.4.2's fix for the single-threaded libass burn on 19-minute
videos), and > 70 segments / > 40 overlays / > 25 KB graphs keep argv/graph
sizes bounded.

## Parity contract (what must NOT drift — and how it is proven)

`bun run test:export-parity` — **50 assertions, all passing**:

1. **Renderer mirrors** (fuzzed 1.5k–4k cases each, 0 mismatches):
   `overlayGeometryMirror ↔ overlayGeometry`, `isXfadeStyleMirror ↔ isXfadeStyle`,
   `clampTrMs ↔ clampTransitionMs`, `planBoundaryFades ↔ transitionHeadMs/TailMs`,
   `sanitizeMotionMirror ↔ sanitizeMotionKeyframes`, `easeInOutSine` canonical.
2. **Two-step byte-differential vs git HEAD** (700 fuzz cases): `buildClipArgs`,
   `buildConcatArgs`, `buildAudioMixGraph` produce **byte-identical argv** — the
   Ken Burns expression extraction and the opt-in `atempo`/`masterLoudnorm`
   graph params changed nothing for the fallback path.
3. **Ken Burns**: single-pass `kenBurnsImageChain` is string-identical to the
   two-step zoompan chain; the 1-frame-input trick is verified MD5-identical to
   the `-loop 1` version (`scripts/verify-kenburns-parity.js`).
   *Deviation note:* the plan's `scale=eval=frame + crop` zoompan replacement was
   implemented and measured — **~2× SLOWER than zoompan** at 1080p on CPU
   (full-frame per-frame resample vs zoompan's window resample), so zoompan
   stays; the scale+crop geometry math (self-correcting crop expressions) is
   preserved in `scripts/verify-kenburns-parity.js` as research.
   *Overlay format*: the plan's `format=yuva420p` swap was also declined —
   the rgba chain is byte-identical to HEAD (the parity differential), and
   chromakey/despill operate in YUV before the conversion either way; the
   win would be one pixel-format conversion per overlay frame against a
   proven-compositing chain. Not worth the parity risk.
4. **Global fades**: dip/bookend windows are emitted as
   `fade=…:enable='between(t,a,b)'` on the global stream AFTER the captions burn
   (the preview's `applyGlobalFade` order) — verified black-only-inside-window
   and window-math-equal to the per-clip windows.
5. **Audio loudness**: the v1.3 master-bus (render mix → WAV → measure → remux)
   vs the v6 **estimated master** (energy-sum of per-branch measured levels):
   measured ΔI = **0.09 LU** on a real 2-branch render; v6 output lands at
   −16 LUFS ±0.05 LU.
6. **Single-pass end-to-end**: real render (2 videos + image + xfade head +
   chroma overlay + captions + music + clip audio) → exact 7.000 s duration,
   h264 yuv420p 640×360 + aac.
7. **Cancellation & leak guard**: real handler killed at 2 s →
   `Export cancelled`, **0 stray ffmpeg processes** (`ps` verified), same
   `activeProcs` Set + `taskkill /pid /f /t` machinery as before.

## Quality ladder (unchanged targets)

| tier | libx264 | NVENC |
|---|---|---|
| draft | CRF 27, **ultrafast** (was veryfast) | p1, CQ 27, multipass qres |
| social | CRF 20, veryfast | p4, CQ 23, multipass qres, b_ref_mode middle, tune hq |
| cinema | CRF 17, faster | p6, CQ 19, multipass qres, b_ref_mode middle, tune hq |
| custom | CRF 14–30 | CQ = custom CRF |

`-pix_fmt yuv420p` rides every encoder branch; the uniform output stream spec
(h264 yuv420p W×H fps) is what keeps the concat demuxer and mixed
copy/encode projects working. GPU candidates are probed with the EXACT tier
args (`gpuProbeExtraArgs`) so a driver that rejects `-multipass`/`-b_ref_mode`
fails the probe and falls back to CPU — never a failed export.

## Benchmark (this repo's CI-style box: 2× Xeon, libx264, 640×360@30 fixtures)

`npm run bench:export` drives the REAL `export-native` handler (electron stub)
for both git-HEAD (pre-v6) and the working tree. Full log → `docs/bench-v6.json`.

| fixture | pipeline | wall | ffmpeg spawns | mode |
|---|---|---|---|---|
| F1 kpi-shaped (12 clips + 2 chroma overlays + captions + music + xfade/dip) | old | 5.5 s | **41** | two-step |
| F1 | old +normalize | 8.4 s | 28 (+measures) | two-step |
| F1 | **v6** | 5.8 s | **1** | single-pass |
| F1 | **v6 +normalize** | 7.3 s | 8 (7 measures + 1) | single-pass |
| F2 turbo (1 clip, no effects) | old | 0.2 s | 4 | two-step, copied 1/1 |
| F2 | v6 | 0.4 s | 3 | two-step, copied 1/1 (routing kept TURBO) |
| F3 single-pass (10 clips + captions + overlay) | old | 3.9 s | 16 | two-step |
| F3 | **v6** | 4.1 s | **1** | single-pass |
| cancellation | v6 killed at 2 s | — | 0 strays | PASS |

**Honest read of the numbers.** On this 2-core CPU box at 360p the encode
itself dominates both paths (the same frames get encoded), so wall-clock is
≈ parity with v1.4.2 — the measured win is structural: 41 → 1 processes, 0
intermediate clip files, 0 clip re-probes, no concat round trip, audio 15 → 8
decode passes (normalize ON) or 7 → 1 (OFF). On the KPI-class machines the
5–10× targets come from the overheads that dominated THERE:

* **NVENC < 40 s target**: the old path ran `min(3, cpus−1)` concurrent NVENC
  sessions (consumer GPUs serialize — throughput collapsed), the
  `maxrate/bufsize` rate-control pass (~15–25 % throughput at CQ targets), and
  ~41 process/session inits at 1080p (~0.3–1 s each). v6: 1 session,
  unconstrained CQ + qres multipass, 1 init, 1 audio pass.
* **libx264 < 80 s target**: one process with `-threads 0` + slice-threaded
  filters (`-filter_threads`), no double AAC pass, no PCM extraction pool, no
  per-clip file writes/reads.
* **TURBO hit rate > 60 %**: untrimmed cuts-only clips always copied; the new
  **sandwich** covers any trim whose GOPs straddle the window (edges ≤ 2 s,
  middle ≥ 4 s) — frame-accurate, unlike widening the keyframe tolerance which
  would shift content up to the tolerance vs the preview.
* NVENC could not be exercised on this box (no GPU; the bundled ffmpeg-static
  is CPU-only) — the encoder-arg and pool changes are covered by the probe
  logic + argv assertions instead, and are expected to be validated on GPU
  hardware in the field.

## Notes & guards

* **Zero-copy local files** (absolute paths over IPC) — untouched; the
  single-pass graph consumes the same paths directly.
* **No `execSync`** anywhere (verified); every probe/measure rides the async
  `captureExec` with timeouts.
* **`-filter_complex_script`** writes one temp graph file per export (added to
  `tempFiles`, cleaned on success/failure/cancel like every other temp).
* **Progress**: the single-pass child reports `time=` against the full timeline
  (same IPC payload shape); ETA keeps the ≥4 % + ≥5 s gate.
* **PCM extraction `-ss` fix**: the v5.2 two-step extracted clip audio from the
  file START — trimmed clips' audio came from the wrong window. Both paths now
  seek to `trimInMs`. (Behavior fix, flagged in the worklog.)
* **apad kept**: the plan suggested dropping `apad=whole_dur` for `-shortest`,
  but `-shortest` stops at the SHORTEST stream — a short mix would truncate the
  video. `apad` costs O(1) per padded sample (no decode); correctness wins.
* **Two-step fallback keeps the v1.3 master-bus WAV** when normalize is ON —
  exact measurement for the rare non-single-pass path; the default
  single-pass path uses the validated estimate instead.
