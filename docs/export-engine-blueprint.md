# Universal High-Throughput Video Export Engine Blueprint

> Saved per user request (Task 44, v1.14.2 round). This is the reference architecture
> for FrameFuse's export engine. Drop this pattern into any future video editor,
> whether built with Electron, Tauri, or a standalone Node.js/Go backend.

### Core Philosophy

1. **Never transcode what hasn't changed:** If a segment is an untouched cut, stream-copy (`-c copy`) it at disk speed (1,000+ FPS).
2. **Never run monolithic filters on CPU:** FFmpeg filtergraphs (`libass`, `overlay`, `scale`) are single-threaded. Split heavy timelines into parallel temporal time slices across CPU cores.
3. **Decouple audio from video:** Slicing audio causes boundary clicking and AAC sample padding desync. Video is sliced; audio is mixed globally in one pass.
4. **Adapt to physical hardware:** Match process count and presets to the specific CPU topology (AVX2 multicore vs. shared-FPU legacy APUs vs. hardware ASICs).

---

## 1. System Architecture Flow

```
                     [ Timeline State (Clips, Captions, Audio) ]
                                         |
                                         v
                     +--------------------------------------+
                     | 1. Hardware Profiler (3-Tier Engine) |
                     +------------------+-------------------+
                                        |
                                        v
                     +--------------------------------------+
                     | 2. Timeline Planner (Clean vs Dirty) |
                     +---------+--------------------+-------+
                               |                    |
               Clean Regions   |                    | Dirty Regions (>70% of timeline)
               (Cuts, Trims)   |                    | (Burned-in Captions, Overlays)
                               v                    v
                     +--------------+       +-------------------------------+
                     | TURBO Copy   |       | Parallel Temporal Slicing     |
                     | (-c:v copy)  |       | (W Workers: libx264/NVENC/QSV)|
                     +------+-------+       +---------------+---------------+
                            |                               |
                            |   +---------------------------+
                            v   v
                     [ Slices 0..N (.mp4) ]   +   [ 3. Global Audio Pass (full_audio.m4a) ]
                                        |                    |
                                        +----------+---------+
                                                   |
                                                   v
                     +--------------------------------------+
                     | 4. Concat Demuxer Assembly           |
                     |    (-f concat -c copy -shortest)     |
                     +------------------+-------------------+
                                        |
                                        v
                               [ Final Exported MP4 ]

```

---

## 2. Phase 1: The Adaptive Hardware Profiler

At startup, probe system capabilities. Never apply a static, one-size-fits-all FFmpeg command.

```javascript
function resolveHardwareProfile(gpuCaps, cpuCount, cpuModel) {
  // TIER 1: Dedicated Hardware ASIC (NVIDIA / Modern Intel / Modern AMD)
  if (gpuCaps.hasNvenc) {
    return {
      tier: 'TIER_1_GPU',
      encoder: 'h264_nvenc',
      extraArgs: ['-preset', 'p2', '-tune', 'ull', '-rc', 'vbr'],
      workers: 2,
      hwaccel: ['-hwaccel', 'cuda'],
      optimizeSubtitles: false
    };
  }
  if (gpuCaps.hasQsv) {
    return {
      tier: 'TIER_1_GPU',
      encoder: 'h264_qsv',
      extraArgs: ['-preset', 'veryfast', '-b:v', '6000k'],
      workers: 2,
      hwaccel: ['-init_hw_device', 'd3d11va=dx', '-init_hw_device', 'qsv=qsv@dx'],
      optimizeSubtitles: false
    };
  }

  // TIER 2: Modern Multicore CPU (>= 6 Cores)
  if (cpuCount >= 6) {
    return {
      tier: 'TIER_2_MODERN_CPU',
      encoder: 'libx264',
      extraArgs: ['-preset', 'superfast', '-tune', 'fastdecode', '-crf', '22', '-g', '60'],
      workers: Math.min(4, Math.floor(cpuCount / 2)),
      threadsPerWorker: 2,
      hwaccel: ['-hwaccel', 'auto'],
      optimizeSubtitles: false
    };
  }

  // TIER 3: Constrained / Legacy CPU (<= 4 Cores, e.g., AMD A-Series / Intel Celeron)
  return {
    tier: 'TIER_3_CONSTRAINED_CPU',
    encoder: 'libx264',
    // -bf 0 prevents frame reordering latency and B-frame concat sync issues
    extraArgs: ['-preset', 'ultrafast', '-tune', 'fastdecode', '-crf', '24', '-g', '60', '-bf', '0'],
    workers: 2, // Hard-cap at 2 to avoid cache & shared-FPU contention
    threadsPerWorker: 2,
    hwaccel: ['-hwaccel', 'auto'],
    optimizeSubtitles: true // Force \blur0 on subtitles to save ~35% CPU rasterization
  };
}
```

> **FrameFuse v1.14.1 amendment:** the tier gate consumes *strong physical cores*
> (wmic/PowerShell topology detection; AMD module-era APUs count logical/2), and
> Tier 3 splits its worker pool by **workload shape**: filter-dominated timelines
> (image / Ken Burns storyboards) widen to `min(4, logical)` single-thread
> processes, video-dominated timelines keep 2 workers x 2 threads. See
> `electron/main.js` (`detectCpuTopology`, `filterWorkers`, `filterDominant`).

---

## 3. Phase 2: Timeline Segmentation (Smart Rendering)

Divide the timeline into **CLEAN** and **DIRTY** ranges.

### The Categorization Rules:

* **CLEAN:** Untouched source video, matching project resolution/framerate, `speed === 1.0`, zero overlays, zero transitions, zero burned-in text.
* **DIRTY:** Active overlays, picture-in-picture, speed alterations, transitions, or text.
* **Crucial Rule:** Audio clips, volume adjustments, and background music **never** make a video range dirty. Audio is handled on an independent bus.

### Keyframe Snapping & B-Frame Correction:

A clean stream-copy piece **must start on an I-frame (keyframe)**.

* Scan keyframes using `ffprobe -skip_frame nokey -show_frames`.
* Expand the dirty region outward to the nearest source keyframes so the clean cuts remain frame-accurate.
* **B-Frame Compensation:** When cutting a stream-copy piece with B-frames, `-t` bounds on DTS rather than PTS. Deduct the reorder frames from duration:

$$\text{copyDuration} = \frac{\text{targetFrames} - \text{bFrames}}{\text{fps}}$$

```bash
# TURBO Stream-Copy Command Pattern (Clean Segments)
ffmpeg -y -ss <keyframePts> -t <copyDuration> -noaccurate_seek \
  -i <sourceFile> -c:v copy -an -avoid_negative_ts make_zero clean_slice_N.mp4
```

---

## 4. Phase 3: Parallel Temporal Slicing (For Dirty Timelines)

When continuous subtitles or watermarks make >70% of the timeline dirty, parallel slice processing bypasses single-threaded filter locks.

### 1. Partition Windows

Divide total duration into W equal time windows (where W comes from `profile.workers`):

* Window 0: `[00:00, 04:45]`
* Window 1: `[04:45, 09:30]`
* Window 2: `[09:30, 14:15]`
* Window 3: `[14:15, 19:00]`

### 2. Slicing Subtitles (ASS Events)

Do not pass a 19-minute subtitle file to a 4-minute worker process.

* Filter the `.ass` file events to only lines active within `[windowStart, windowEnd]`.
* Normalize dialogue timestamps so that `windowStart` becomes `00:00:00.00`.
* If on **Tier 3 (Constrained CPU)**, run a regex to strip heavy blur styling:
```javascript
assText = assText.replace(/\\blur\d+(\.\d+)?/g, '\\blur0');
```

### 3. Worker Spawn Execution

Run all W workers in parallel using `Promise.all()`. Render video only (`-an`):

```bash
ffmpeg -y \
  ${profile.hwaccel.join(' ')} \
  -ss <windowStartSec> -to <windowEndSec> \
  -i <sourceFile> \
  -filter_complex_script <windowFilterScript> \
  -c:v ${profile.encoder} \
  ${profile.extraArgs.join(' ')} \
  -threads ${profile.threadsPerWorker || 1} \
  -filter_threads 1 \
  -video_track_timescale 90000 \
  -an \
  dirty_slice_<index>.mp4
```

---

## 5. Phase 4: Global Audio Pipeline

Never render audio per chunk. Process all timeline audio in a single pass while the video workers are running:

```bash
ffmpeg -y \
  -i <videoSource> -i <backgroundMusic> -i <voiceover> \
  -filter_complex "
    [0:a]volume=1.0,adelay=0|0[a0];
    [1:a]volume=0.4,afade=t=in:st=0:d=2[a1];
    [2:a]volume=1.2,adelay=5000|5000[a2];
    [a0][a1][a2]amix=inputs=3:duration=longest:normalize=0,
    dynaudnorm=p=0.9:m=10.0[amix];
    [amix]apad=whole_dur=<totalDurationSec>[aout]
  " \
  -map "[aout]" \
  -c:a aac -b:a 192k -ar 48000 \
  -vn \
  global_audio.m4a
```

---

## 6. Phase 5: Concat Demuxer Assembly & Clean-up

Once all video slices (`clean_slice_*.mp4` and `dirty_slice_*.mp4`) and `global_audio.m4a` finish:

### 1. Write `concat_list.txt`

```text
file 'slices/slice_000.mp4'
file 'slices/slice_001.mp4'
file 'slices/slice_002.mp4'
file 'slices/slice_003.mp4'
```

### 2. Execute Zero-Transcode Final Assembly

```bash
ffmpeg -y \
  -f concat -safe 0 -i concat_list.txt \
  -i global_audio.m4a \
  -c:v copy \
  -c:a copy \
  -shortest \
  -movflags +faststart \
  final_output.mp4
```

*Time to execute this final mux:* **1 to 3 seconds**.

### 3. Immediate Garbage Collection

Delete `slices/`, `concat_list.txt`, temporary `.ass` files, and `global_audio.m4a` immediately in a `finally` block to prevent disk bloat.

---

## 7. The Golden Rules & Pitfalls Reference Sheet

| Problem | Why It Happens | The Permanent Fix |
| --- | --- | --- |
| **WebCodecs 5–10 Hr Crawl** | Integrated GPUs share system RAM. Passing thousands of uncompressed 1080p frames through Chromium saturates memory bandwidth. | Never use browser Canvas/WebCodecs for long full-video exports on low-end PCs. Keep rendering inside native FFmpeg. |
| **Audio Popping / Desync at Cuts** | Slicing audio with `-c:a aac` introduces encoder padding frames (~1024 samples) at boundaries. | Video workers run `-an`. Mix audio in **one global pass** using `amix`. |
| **CPU Spikes to 100% with Low FPS** | Single-threaded filters like `libass` and `overlay` choke on 1 process while `libx264` starves waiting for frames. | Split the timeline into W temporal slice workers with `-threads 1 -filter_threads 1`. |
| **Bulldozer/Piledriver Sluggishness** | Dual-module CPUs (like AMD A8/FX) share 1 Floating Point Unit across 2 cores. 4 workers cause FPU contention. | Hardcode `workers = 2` for CPUs with ≤ 4 cores or legacy architectures. |
| **DTS Glitches on Concat** | B-frame reordering creates negative/misaligned presentation timestamps. | Add `-video_track_timescale 90000` to all slice encodes, and use `-bf 0` on low-end profiles. |
| **Stale Installer Testing** | Testing code changes against an old packaged desktop build or cached binary. | Always stamp `app.getVersion()` via IPC to display the exact live running build directly in your UI. |
