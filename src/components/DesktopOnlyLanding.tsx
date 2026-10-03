"use client";

import {
  Film,
  Download,
  ArrowRight,
  Captions,
  Sparkles,
  PenLine,
  Languages,
  Zap,
  Scissors,
  MonitorPlay,
  Play,
} from "lucide-react";

interface DesktopOnlyLandingProps {
  version: string;
  onEnterPreview: () => void;
}

/**
 * v1.23 FLOW landing — a completely new first-run surface: a bright paper
 * canvas, a split hero with a CSS-built studio mockup, and a feature bento.
 * The preview escape hatch ("Launch the Studio") is unchanged behavior —
 * same handler, same sessionStorage flag.
 */
export function DesktopOnlyLanding({
  version,
  onEnterPreview,
}: DesktopOnlyLandingProps) {
  return (
    <div
      className="flex min-h-screen w-full flex-col"
      style={{ backgroundColor: "#f4f1ea", color: "#292524" }}
    >
      {/* ── Top bar ─────────────────────────────────────────────────── */}
      <header
        className="flex h-16 shrink-0 items-center justify-between border-b px-6 sm:px-10"
        style={{ borderColor: "#e8e1d4" }}
      >
        <div className="flex items-center gap-3">
          <div
            className="flex size-9 items-center justify-center rounded-[10px]"
            style={{
              backgroundImage: "linear-gradient(135deg, #f06214 0%, #ea580c 55%, #d84e08 100%)",
              boxShadow: "0 4px 14px rgba(234, 88, 12, 0.3)",
            }}
          >
            <Film className="size-[18px]" style={{ color: "#ffffff" }} />
          </div>
          <div className="leading-tight">
            <div className="text-[15px] font-semibold tracking-tight text-stone-900">
              FrameFuse
            </div>
            <div className="text-[11px] text-stone-400">Video Studio</div>
          </div>
          <span
            className="ml-1 hidden rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium text-stone-400 sm:inline-flex"
            style={{ borderColor: "#e8e1d4", backgroundColor: "#f6f2ea" }}
          >
            v{version}
          </span>
        </div>
        <nav className="flex items-center gap-2">
          <button
            type="button"
            onClick={onEnterPreview}
            className="ff-btn-ghost hidden items-center gap-2 rounded-[10px] px-4 py-2 text-[13px] font-semibold sm:flex"
          >
            Try the interface
            <ArrowRight className="size-4" />
          </button>
          <a
            href="https://github.com/Ziruax/framefuse/releases/latest"
            target="_blank"
            rel="noreferrer"
            className="ff-btn-primary flex items-center gap-2 rounded-[10px] px-4 py-2 text-[13px]"
          >
            <Download className="size-4" />
            Get the app
          </a>
        </nav>
      </header>

      {/* ── Hero ────────────────────────────────────────────────────── */}
      <section
        className="relative flex flex-1 flex-col items-center overflow-hidden px-6 pb-14 pt-16 sm:px-10 sm:pt-20"
        style={{
          backgroundImage:
            "radial-gradient(900px 480px at 18% 8%, rgba(234, 88, 12, 0.10), transparent 62%)," +
            "radial-gradient(700px 420px at 88% 0%, rgba(13, 148, 136, 0.08), transparent 60%)",
        }}
      >
        <div className="grid w-full max-w-6xl items-center gap-12 lg:grid-cols-[1.05fr_1fr]">
          {/* Copy */}
          <div className="max-w-xl">
            <span
              className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-semibold"
              style={{
                borderColor: "rgba(234, 88, 12, 0.35)",
                backgroundColor: "#fff3ea",
                color: "#c2410c",
              }}
            >
              <Zap className="size-3" />
              Native Rust engine · GPU composited
            </span>
            <h1 className="mt-5 text-[40px] font-extrabold leading-[1.06] tracking-tight text-stone-900 sm:text-[54px]">
              Edit videos at
              <br />
              the{" "}
              <span
                style={{
                  backgroundImage: "linear-gradient(100deg, #ea580c, #0d9488)",
                  WebkitBackgroundClip: "text",
                  backgroundClip: "text",
                  color: "transparent",
                }}
              >
                speed of thought
              </span>
            </h1>
            <p className="mt-5 text-[15px] leading-relaxed text-stone-500 sm:text-[17px]">
              FrameFuse turns raw clips into finished videos — captions that
              dance, AI voiceovers in any language, beat-synced cuts — and
              exports through a native engine instead of waiting on a
              browser tab.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={onEnterPreview}
                className="ff-btn-primary flex h-12 items-center gap-2.5 rounded-xl px-6 text-[15px]"
              >
                <Play className="size-4" />
                Launch the Studio
              </button>
              <a
                href="https://github.com/Ziruax/framefuse/releases/latest"
                target="_blank"
                rel="noreferrer"
                className="ff-btn-ghost flex h-12 items-center gap-2.5 rounded-xl px-6 text-[15px] font-semibold"
              >
                <Download className="size-4" />
                Download for Windows
              </a>
            </div>
            <div className="mt-7 flex flex-wrap gap-x-6 gap-y-2 text-[12px] font-medium text-stone-400">
              <span>Free during beta</span>
              <span>·</span>
              <span>No account, no upload</span>
              <span>·</span>
              <span>Everything stays on your PC</span>
            </div>
          </div>

          {/* CSS-built studio mockup — a miniature of the real Flow shell:
              rail, cinema card, timeline card. No screenshots needed. */}
          <div
            className="ff-card relative mx-auto hidden w-full max-w-[520px] overflow-hidden rounded-2xl p-3 lg:block"
            style={{ padding: 12 }}
            aria-hidden
          >
            {/* toolbar */}
            <div
              className="flex h-9 items-center gap-2 rounded-lg border px-2.5"
              style={{ borderColor: "#eee8dc", backgroundColor: "#faf7f1" }}
            >
              <div
                className="size-4 rounded-[5px]"
                style={{
                  backgroundImage: "linear-gradient(135deg, #f06214, #ea580c)",
                }}
              />
              <div className="h-2 w-16 rounded-full bg-stone-200" />
              <div className="flex-1" />
              <div
                className="h-5 w-16 rounded-[7px]"
                style={{ backgroundImage: "linear-gradient(135deg, #f06214, #d84e08)" }}
              />
            </div>
            {/* rail + cinema + timeline */}
            <div className="mt-2.5 flex gap-2.5">
              <div
                className="flex w-11 flex-col items-center gap-1.5 rounded-xl border py-2.5"
                style={{ borderColor: "#eee8dc", backgroundColor: "#faf7f1" }}
              >
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <div
                    key={i}
                    className="flex h-7 w-8 items-center justify-center rounded-lg"
                    style={
                      i === 0
                        ? { backgroundColor: "#fdeade", color: "#c2410c" }
                        : undefined
                    }
                  >
                    <div
                      className="h-2.5 w-2.5 rounded-[4px]"
                      style={{
                        backgroundColor:
                          i === 0 ? "#ea580c" : "#d6cfc2",
                      }}
                    />
                  </div>
                ))}
              </div>
              <div className="flex flex-1 flex-col gap-2.5">
                {/* cinema card */}
                <div
                  className="relative flex h-40 items-center justify-center overflow-hidden rounded-xl"
                  style={{
                    background:
                      "linear-gradient(160deg, #2a2521 0%, #1b1815 70%)",
                  }}
                >
                  <div
                    className="absolute left-5 top-4 h-2.5 w-20 rounded-full"
                    style={{ backgroundColor: "rgba(255,255,255,0.16)" }}
                  />
                  <div
                    className="absolute left-5 top-9 h-2.5 w-32 rounded-full"
                    style={{ backgroundColor: "rgba(255,255,255,0.10)" }}
                  />
                  <div
                    className="flex size-11 items-center justify-center rounded-full"
                    style={{
                      background: "rgba(234, 88, 12, 0.92)",
                      boxShadow: "0 6px 24px rgba(234, 88, 12, 0.55)",
                    }}
                  >
                    <Play className="size-5" style={{ color: "#fff", fill: "#fff" }} />
                  </div>
                  <div
                    className="absolute bottom-4 left-5 rounded-md px-2 py-1 text-[9px] font-bold tracking-wide"
                    style={{
                      background: "rgba(234, 88, 12, 0.25)",
                      color: "#fdba74",
                      border: "1px solid rgba(234, 88, 12, 0.45)",
                    }}
                  >
                    KINETIC CAPTIONS
                  </div>
                </div>
                {/* timeline card */}
                <div
                  className="rounded-xl border p-2"
                  style={{ borderColor: "#eee8dc", backgroundColor: "#faf7f1" }}
                >
                  <div className="flex gap-1.5">
                    <div
                      className="h-5 w-20 rounded-md"
                      style={{ background: "linear-gradient(135deg, #fdba74, #f97316)" }}
                    />
                    <div
                      className="h-5 w-14 rounded-md"
                      style={{ background: "linear-gradient(135deg, #5eead4, #14b8a6)" }}
                    />
                    <div
                      className="h-5 w-24 rounded-md"
                      style={{ background: "linear-gradient(135deg, #fcd6b8, #fb923c)" }}
                    />
                    <div className="h-5 flex-1 rounded-md bg-stone-200/70" />
                  </div>
                  <div className="mt-1.5 flex gap-1.5">
                    <div
                      className="h-3.5 w-16 rounded-md"
                      style={{ background: "linear-gradient(90deg, #99f6e4, #5eead4)" }}
                    />
                    <div className="h-3.5 flex-1 rounded-md bg-stone-200/60" />
                  </div>
                  <div className="mt-1.5 h-px w-full bg-stone-200" />
                  <div className="relative mt-1.5 h-3.5">
                    <div
                      className="absolute left-[38%] top-[-3px] h-3.5 w-[2px] rounded-full"
                      style={{ backgroundColor: "#06b6d4", boxShadow: "0 0 6px rgba(6,182,212,0.8)" }}
                    />
                  </div>
                </div>
              </div>
            </div>
            {/* floating badge */}
            <div
              className="absolute right-5 top-16 flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold"
              style={{
                borderColor: "rgba(5, 150, 105, 0.35)",
                backgroundColor: "#ecfdf5",
                color: "#047857",
                boxShadow: "0 6px 18px rgba(5, 150, 105, 0.15)",
              }}
            >
              <span className="size-1.5 rounded-full bg-emerald-500" />
              Rust engine · live
            </div>
          </div>
        </div>
      </section>

      {/* ── Feature bento ───────────────────────────────────────────── */}
      <section className="shrink-0 px-6 pb-6 sm:px-10">
        <div className="mx-auto grid w-full max-w-6xl gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {[
            {
              icon: Captions,
              tint: "#fdeade",
              fg: "#c2410c",
              title: "Captions that dance",
              line: "Word-by-word karaoke, kinetic typography presets, real bundled fonts — burned in natively.",
            },
            {
              icon: Sparkles,
              tint: "#fef3c7",
              fg: "#b45309",
              title: "Effects without the crawl",
              line: "Ken Burns motion, geometric transitions, watermarks and PiP overlays — all previewed live.",
            },
            {
              icon: PenLine,
              tint: "#fae8ff",
              fg: "#a21caf",
              title: "AI script writer",
              line: "Draft your video with Gemini or Groq inside the studio, then voice it in one click.",
            },
            {
              icon: Languages,
              tint: "#f0fdfa",
              fg: "#0f766e",
              title: "Translate & dub",
              line: "Multi-speaker dubs with speaker detection, per-speaker voices and studio ducking.",
            },
            {
              icon: Scissors,
              tint: "#eff6ff",
              fg: "#0369a1",
              title: "Beat-synced cuts",
              line: "Drop a track, detect beats, snap every clip to the rhythm automatically.",
            },
            {
              icon: Zap,
              tint: "#ecfdf5",
              fg: "#047857",
              title: "A native engine, not a tab",
              line: "The Rust core composites on your GPU and encodes through the FFmpeg libraries directly.",
            },
          ].map((f) => (
            <div
              key={f.title}
              className="ff-card rounded-2xl p-5 transition-transform duration-150 hover:-translate-y-0.5"
            >
              <div
                className="flex size-10 items-center justify-center rounded-xl"
                style={{ backgroundColor: f.tint, color: f.fg }}
              >
                <f.icon className="size-5" />
              </div>
              <h3 className="mt-3.5 text-[15px] font-bold tracking-tight text-stone-800">
                {f.title}
              </h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-stone-500">
                {f.line}
              </p>
            </div>
          ))}
        </div>

        {/* Why desktop strip */}
        <div
          className="mx-auto mt-3.5 flex w-full max-w-6xl flex-col items-start gap-3 rounded-2xl border px-6 py-5 sm:flex-row sm:items-center"
          style={{ borderColor: "#e8e1d4", backgroundColor: "#faf7f1" }}
        >
          <div
            className="flex size-10 shrink-0 items-center justify-center rounded-xl"
            style={{ backgroundColor: "#fff3ea", color: "#c2410c" }}
          >
            <MonitorPlay className="size-5" />
          </div>
          <div className="flex-1">
            <div className="text-[14px] font-bold text-stone-800">
              Why a desktop app?
            </div>
            <p className="mt-0.5 text-[13px] leading-relaxed text-stone-500">
              GPU encoding, direct file access and the native Rust engine only
              exist outside the browser sandbox. This page is just the
              front door — the studio itself runs as a Windows app.
            </p>
          </div>
          <button
            type="button"
            onClick={onEnterPreview}
            className="ff-btn-ghost flex shrink-0 items-center gap-2 rounded-[10px] px-4 py-2.5 text-[13px] font-semibold"
          >
            Preview the UI anyway
            <ArrowRight className="size-4" />
          </button>
        </div>

        {/* Footer */}
        <footer className="mx-auto mt-6 flex w-full max-w-6xl items-center justify-between text-[11px] text-stone-400">
          <span>FrameFuse v{version} · built for Windows</span>
          <a
            href="https://github.com/Ziruax/framefuse"
            target="_blank"
            rel="noreferrer"
            className="transition-colors hover:text-stone-700"
          >
            github.com/Ziruax/framefuse
          </a>
        </footer>
      </section>
    </div>
  );
}
