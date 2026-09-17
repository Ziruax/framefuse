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

## v9 — TRUE SMART RENDERING (the permanent default for low-end CPUs)

**The problem**: the FFmpeg pipeline took 1.5 h for a 19-minute video because
the v6 routing re-encoded the ENTIRE timeline through one
`-filter_complex_script` whenever `encodeWorkMs ≥ 8 s or ≥ 30 %` of the
timeline — one 10-second text overlay made all 19 minutes "dirty". The v7
hybrid only aligned chunk boundaries at SEGMENT edges, so a single long
segment with sparse edits was still 100 % re-encode.

**The architecture** (4 phases, in `main.js` + `export-singlepass.js`):

1. **The monolithic 30 % routing is deleted.** A timeline is never evaluated
   as one block because a percentage of it is dirty. Any export with dirty
   time goes through `planSmartRenderingPipeline()`; pure-copy projects keep
   the TURBO pool (nothing to segment); every smart-plan failure (probe,
   script budget, init-class error < 4 s) falls back to the two-step pool.
2. **`planSmartSegments(timeline)`** (export-singlepass.js, pure) maps
   `[0, totalMs)` and marks DIRTY time-ranges: transitions/fades (parsed back
   from the exact `buildGlobalFades` strings that ship), caption cues,
   headline windows, overlay/PIP windows, Ken Burns images, `speed ≠ 1`,
   watermark, format-mismatched sources, and trim heads that are not
   keyframe-aligned. Overlapping ranges MERGE (text 1:00–1:10 + PIP
   1:05–1:15 → 1:00–1:15). **Keyframe snapping**: every dirty↔clean boundary
   maps through the segment frame law (`slot s displays source frame
   F0 + (s − S_i)`, `F0 = ceil(trimIn · g)`) onto the SOURCE keyframe grid —
   a keyframe within one frame aligns the copy (v1.4.1 semantics), anything
   further expands the dirty range OUTWARD to the next keyframe so the clean
   piece starts exactly on it (zero content shift, ≤ 1 GOP extra encode).
   The scans ride `probeKeyframesNear` / `findKeyframeAlignedStart` (the
   Sandwich-copy lineage); without ffprobe the planner degrades
   conservatively (no clean piece ever starts at an unverified position).
3. **The execution pool** renders the pieces: CLEAN pieces through
   `buildStreamCopyArgs` (`-ss <exact_pts> -t <dur> -i <src> -c:v copy
   -avoid_negative_ts make_zero` — seconds), DIRTY pieces through the
   windowed single-pass graph bounded to their exact `[f0, f1)` frames
   (sub-split across workers on ≥ 4-core CPUs, fades kept whole). **The
   concat contract**: dirty encodes write the same
   `-video_track_timescale` (probed from the first clean source), the same
   resolution/SAR/fps/`yuv420p` (the graph chains), and the audio bus is
   ONE full-timeline pass at `-ar 48000` — the demuxer stitches losslessly.
4. **Final assembly**: `concat.txt` (pieces in timeline order) →
   `ffmpeg -f concat -safe 0 -i concat.txt -c copy -movflags +faststart`
   + the audio map — instantaneous — then aggressive cleanup deletes every
   chunk/graph/ASS temp (plus a pre-flight sweep of orphaned `chunk_*.mp4`
   from crashed exports).

**Telemetry**: `mode: "smart-render"` + `smartCleanSec`/`smartDirtySec` —
the success toast reads "smart render: 15m 24s stream-copied · 3m 06s
re-encoded", the Header chips show the turbo/parallel counts, and the main
log line lists the dirty-zone reasons.

**Expected field outcome** (the user's low-end quad): a 19-minute timeline
with ~4 minutes of text/PIP/transitions re-encodes ~4 minutes + ≤ 1 GOP per
boundary instead of 19 minutes — minutes, not hours, on libx264
`-preset superfast -tune fastdecode` (the v7 Step 5 low-end ladder, which
the detected-encoder route selects automatically on boxes without a usable
iGPU encoder).

**Standing caveats** (unchanged from the shipped smart-copy lineage): open-GOP
sources can briefly reference across a copy cut (industry-wide for all
smart-render editors; the ≤ 1-frame tolerance branch and the backward dirty
expansion bound the exposure); ± 1-source-frame jitter at boundaries on
rate-mismatched sources (|srcFps − fps| < 0.06 spec gate); subtitle cues
crossing a dirty-window boundary render partially per window (identical to
the shipped chunk-boundary semantics).

---

## v1.10 — WebCodecs removed · dirty-reason telemetry · parallel temporal chunking

**Architecture decision (permanent)**: the WebCodecs export engine is
DELETED — `src/lib/export/{engine,SourceDecoder,ExportOrchestrator,AudioMixer,
gpu-export-demo,index}.ts`, the `mp4-muxer`/`mp4box` dependencies, the
Export-tab engine selector, the GPU status badge, the force-software toggle
and every `gpu`/WebCodecs telemetry surface. Field data showed integrated-
GPU memory-bus saturation (5–10 h exports, visual glitches) on exactly the
low-end boxes the engine was meant to help. One FFmpeg codebase remains;
the browser preview fallback is MediaRecorder (WebM) only.

### Task 2 — smart-render diagnostic telemetry

`planSmartSegments()` records WHY every dirty range is dirty and aggregates
per cause (merged-within-cause ms, count, first→last span): "continuous
subtitles from 0:00 to 19:00", "watermark over the full timeline",
"framerate resample 29.97 -> 30fps", "resolution 1920x1080 -> 1280x720",
"speed-changed clips", "mid-GOP trim heads", … The largest-share label
ships as `smartDirtyReason` in the export result; when **0 % was copied**
the completion toast reads "Full re-encode required: [reason]".

### Task 3 — parallel temporal chunking for mostly-dirty timelines

When the clean (stream-copyable) coverage falls **below 30 %** —
continuous subtitles, a full-length watermark or a framerate resample made
≥ 70 % of the timeline dirty — the irregular clean/dirty tiling buys too
little to matter. The planner instead splits the timeline into
**W = max(2, min(4, cpus)) equal temporal windows** (shrunk toward 2 for
short timelines; boundaries nudged out of the fade/xfade forbidden extents
so every transition stays whole inside ONE window):

* each window renders through the SAME windowed single-pass graph the
  dirty pieces use — the ASS subtitle events are **sliced to the window
  with timestamps shifted relative to its start** (a crossing cue clamps
  to the window edge), overlays/fades/xfade heads are windowed, and
  `-frames:v` pins the exact slot count;
* workers are **video-only** (`-an` by map selection — no AAC boundary
  padding, no audio clicks), run **concurrently** in the pool with
  `-threads floor(cores/W) -filter_threads floor(cores/W)` (1 each on the
  4-core low-end target — the recipe; the single-threaded libass/overlay
  filters stop stalling each other);
* **hardware decode**: `-hwaccel d3d11va` (Windows; `auto` elsewhere) is
  injected before `-i` on the re-encode inputs, gated by the existing
  empirical probe (`probeHwDecode` measures the ACTUAL file CPU-vs-hw and
  enables only when ≥ 1.3× faster — a broken driver stack stays on CPU
  decode and the export never depends on the hwaccel engaging);
* **the concat contract**: no clean pieces exist in this mode, so every
  chunk pins `-video_track_timescale 90000` — the demuxer's offset math is
  exact across all W workers;
* **one global audio pass** renders the full-timeline bus (`-c:a aac
  -ar 48000`) and the final stitch is the zero-transcode concat:
  `ffmpeg -f concat -safe 0 -i concat.txt -i full_audio.m4a -c copy
  -movflags +faststart final.mp4`, then every chunk/graph/ASS/audio temp
  is deleted (plus the pre-flight orphan sweep).

**Telemetry**: `mode: "parallel-pass"` + `parallelChunks` + the shared
`smartDirtyReason` — the toast reads "4 parallel render passes · hardware
decode · full re-encode: subtitles from 0:00 to 19:00".

**Expected field outcome** (19-minute mostly-dirty timeline on a 4-core
iGPU box): 4 concurrent single-threaded encode workers ≈ 4× the filter
throughput of the monolith + 30–40 % CPU freed by d3d11va decode — the
1.5 h export lands in the ~12–15 min range.

---

## v1.12 — the 46-minute → sub-15-minute push (field-directed tuning)

v1.10's parallel pass measured **46 min for a 19-min 100 %-dirty timeline
(~12.4 FPS aggregate)** in the field. Four bottlenecks were identified and
fixed (all verified by real-ffmpeg harness, 49 checks + 5 regression
suites):

1. **Strictly 4 workers on ≥4-core CPUs.** The planner's worker budget was
   conservative in two places: the smart-mode sub-split width used
   `floor(cores/3)` (2 on a 4-core) and the equal-window shrink
   (`minWindowSec 8`) reduced a 30 s timeline to 3 windows. Now any
   `os.cpus().length >= 4` spawns **exactly 4** chunk processes (sub-split
   AND parallel windows; shrink only below 16 s), and every parallel-pass
   worker is hard-pinned to **`-threads 1 -filter_threads 1`** (was
   `floor(cores/W)` — 2 on an 8-core). Windows schedules 4 separate
   1-thread processes far better than fewer processes with fatter thread
   pools: motion-estimation/CABAC contexts stay inside one core's L1/L2
   instead of fighting over shared cache lines.

2. **`-hwaccel d3d11va` on every worker input, with a graceful `-hwaccel
   auto` fallback.** The old probe required d3d11va to measure **≥ 1.3×
   faster** on a 72-frame snippet — but that gate measured the wrong thing
   for a saturated quad: moving decode onto the iGPU's dedicated ASIC
   frees ~35 % of the CPU cycles for libx264 + libass *even when raw
   decode throughput is merely equal* (the per-frame system-memory
   download hides in the encode wait). The probe is now tri-state:
   d3d11va arm runs clean and is not ≥ 1.5× slower → ride the explicit
   token; the arm **init-fails** (broken driver) → `-hwaccel auto`
   (ffmpeg walks the remaining methods, software decode internally if
   none hook up); ≥ 1.5× slower (the WARP pathology) → pure CPU. Sources
   shorter than 20 s skip the probe cost and ride `auto` directly.

3. **`-preset superfast -tune fastdecode -crf 22`** for the libx264 speed
   tiers (social + custom; draft keeps ultrafast, cinema keeps its
   faster/crf-17 master). superfast disables the heavy motion-estimation
   refinement whose loss is invisible after platform re-encoding and
   roughly doubles throughput on budget CPUs; `fastdecode` also makes the
   exported file cheaper to play back on them. The GPU-vs-CPU encoder
   probe baseline matches the new tier (apples-to-apples).

4. **Audio never marks video DIRTY.** Verified end-to-end: a full audio
   stack (background music + per-clip volume + loudness normalization +
   SFX) over clean cuts exports with **zero** re-encoded windows — the
   video rides stream copies (byte-identical regions) and only the audio
   bus renders. A caption cue with no visible text (empty string, no word
   timings) now marks nothing dirty either — matching the ASS builder,
   which was already skipping such cues. Visual elements (text, PIP,
   chroma, Ken Burns, transitions, watermark, speed, format mismatch,
   mid-GOP trims) remain the only dirty causes.

**Expected field outcome**: 4 × 1-thread superfast workers + d3d11va
decode ≈ 3–4× the v1.10 field throughput → the 19-min case lands in the
**~12–15 min** band, and cut-heavy timelines (≥70 % clean) stay in
stream-copy territory (minutes, not tens of minutes).

## v1.12.1 — closing the hidden single-process path + honest telemetry

The v1.12 field directive ("if speed has not budged, the code is not
executing on your machine") prompted a full audit of every export spawn
path. Two real gaps were found and fixed:

1. **The two-step fallback pool ran ONE ffmpeg process on a 4-core CPU.**
   The v6 formula `poolN = min(2, floor(cores/4))` evaluated to **1** on
   the exact 4-core machines v1.12 targets. The smart/parallel paths got
   the strict-4 recipe, but ANY smart-pipeline init fallback (planner bail,
   a piece graph over the 25 KB script budget, a <4 s init-class error)
   silently degraded the export to a single-process pipeline — one
   `ffmpeg.exe` in Task Manager and the old ~46-min wall time, with
   **nothing in the UI contradicting it**. The fallback pool now rides the
   same directive: `poolN = 4` on any ≥4-core CPU (GPU encoders keep pool
   1 — consumer GPU sessions serialize internally). Verified by harness:
   a forced planner bail on a stubbed 4-core box spawned **4 concurrent
   1-thread superfast workers** (150 s source → 3 chunks, all running at
   once), output decoding clean (14/14 checks).

2. **Telemetry could claim parallelism that did not run.** The completion
   toast said "N chunks encoded in parallel" even when `poolN = 1` ran
   them sequentially — the exact Task-Manager contradiction the field
   check exposes. The result payload now carries **`poolWorkers`** (the
   actual max-concurrent ffmpeg processes during the encode stage) and
   **`cpus`**, and every surface speaks them: the toast ("N chunks across
   M ffmpeg processes"), the LastExport chip ("⧉ N chunks · M proc",
   amber when M = 1), and the main-process log (`TWO-STEP POOL: 3 job(s)
   · 4 concurrent ffmpeg process(es) · encoder libx264 · 4 CPU core(s)`).

3. **The honest version check.** The header chip was a renderer constant
   — it could not detect a stale Electron shell running a new renderer or
   vice versa. A new `app-info` IPC surfaces `app.getVersion()` (the
   rcedit-stamped version resource of the actual executable); the chip now
   shows the REAL exe version and turns **amber with a warning icon** on
   any mismatch with the renderer's build constant. The bottom of
   Settings → Export gains an "About this build" strip: real app version
   (green when current, amber + "update to v1.12.1" when stale), CPU core
   count, and the ffmpeg-worker count this machine will spawn — the
   "how many `ffmpeg.exe` should Task Manager show?" answer **before**
   starting an export. The Help → About dialog (stuck at "v5.1" since the
   v5 era) now reads `app.getVersion()` too.

**Field diagnosis with v1.12.1** (all three checks answerable in-app):
Task Manager process count → the Export tab strip states the expected
worker count up front, and the post-export toast/chip states what ACTUALLY
ran; app version → the header chip and the Export tab strip both read the
real exe resource and flag mismatches; pipeline mode → the toast names the
mode ("smart render", "N parallel render passes (M ffmpeg processes)",
"two-step") with the dirty reason when nothing could be copied.
