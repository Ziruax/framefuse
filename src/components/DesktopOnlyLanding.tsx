"use client";

/**
 * v1.14.2 (user directive: "make this desktop app only, no browser, so the
 * aim becomes clear — this is a Windows app"): when the studio is opened in
 * a plain browser (no Electron shell), it renders THIS landing page instead
 * of the editor. FrameFuse is a native Windows desktop application — its
 * export engine spawns real FFmpeg child processes, which a browser page
 * cannot do. The landing states that plainly and points at the installer.
 *
 * The only other thing this page can do is hand the session over to the
 * studio UI ("Launch the Studio") for development/verification — the
 * studio in a browser is a UI preview, exports intentionally refuse to run.
 *
 * v1.22 "Ember Studio" redesign: warm dark studio palette (stone-950 base,
 * amber honey accents), radial amber glow behind the hero, feature-card
 * grid with icon tiles, and a bold amber CTA.
 */

import { useCallback, useState } from "react";
import {
  ArrowRight,
  Captions,
  Layers,
  Mic,
  MonitorSmartphone,
  PenLine,
  Rocket,
  TerminalSquare,
  Type,
  Zap,
} from "lucide-react";

const RELEASES_URL = "https://github.com/Ziruax/framefuse/releases/latest";

/** Matches the app icon identity (recolored v1.22: warm amber rounded
 * badge, stone play triangle, sprocket dots). Inline so the landing has
 * zero asset deps. */
function LogoMark({ size = 44 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="FrameFuse logo"
      className="shrink-0"
    >
      <defs>
        <linearGradient id="ff-landing-badge" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#fcd34d" />
          <stop offset="100%" stopColor="#f59e0b" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#ff-landing-badge)" />
      {/* sprocket holes — film reel nod */}
      <circle cx="15" cy="16" r="2.6" fill="#78350f" />
      <circle cx="15" cy="32" r="2.6" fill="#78350f" />
      <circle cx="15" cy="48" r="2.6" fill="#78350f" />
      <path
        d="M29 20.5 L47 32 L29 43.5 Z"
        fill="#1c1917"
        stroke="#1c1917"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const FEATURES: Array<{
  icon: typeof Zap;
  title: string;
  body: string;
}> = [
  {
    icon: Captions,
    title: "Captions",
    body: "Groq Whisper transcription with burned-in animated captions — styled, timed, and fully offline after upload.",
  },
  {
    icon: Type,
    title: "Kinetic typography",
    body: "24 choreographed caption designs — per-word entrances, emphasis pops and exits that dance with the beat.",
  },
  {
    icon: Mic,
    title: "AI dubbing",
    body: "Turn any script into a natural voice track, ducked against your music, in a single click.",
  },
  {
    icon: PenLine,
    title: "AI script writer",
    body: "A built-in writer that drafts hooks and scripts for your video, ready to send straight to the dubbing studio.",
  },
  {
    icon: Rocket,
    title: "Rust GPU export",
    body: "The native engine composites and encodes on your GPU — smart-rendered exports finish at multiples of realtime.",
  },
  {
    icon: Layers,
    title: "Multi-track timeline",
    body: "Video, overlays, music, SFX and voice lanes with drag-trim, multi-select, motion paths and beat snapping.",
  },
];

export function DesktopOnlyLanding({
  version = "1.22.0",
  onEnterPreview,
}: {
  version?: string;
  onEnterPreview?: () => void;
}) {
  const [previewRequested, setPreviewRequested] = useState(false);
  const handleEnterPreview = useCallback(() => {
    if (previewRequested) return;
    setPreviewRequested(true);
    onEnterPreview?.();
  }, [previewRequested, onEnterPreview]);

  return (
    <div className="relative flex min-h-screen w-full flex-col bg-stone-950 text-stone-200">
      {/* v1.22: subtle radial amber glow behind the hero */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[560px]"
        style={{
          background:
            "radial-gradient(60% 55% at 50% 0%, rgba(245, 158, 11, 0.10) 0%, rgba(245, 158, 11, 0.03) 45%, rgba(12, 10, 9, 0) 75%)",
        }}
      />

      {/* Top bar */}
      <header className="relative z-10 flex items-center gap-3 px-5 py-4 sm:px-10">
        <LogoMark size={38} />
        <div className="min-w-0">
          <div className="text-[15px] font-semibold leading-tight text-stone-50">FrameFuse</div>
          <div className="text-[11px] leading-tight text-stone-500">
            v{version} · Windows desktop app
          </div>
        </div>
        <a
          href={RELEASES_URL}
          target="_blank"
          rel="noreferrer"
          className="ml-auto hidden items-center gap-1.5 rounded-lg border border-stone-800 bg-stone-900/60 px-3 py-1.5 text-[12px] font-medium text-stone-300 transition-colors hover:bg-stone-800/70 hover:text-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 sm:flex"
        >
          Releases
          <ArrowRight className="size-3.5" />
        </a>
      </header>

      {/* Hero */}
      <main className="relative z-10 mx-auto flex w-full max-w-5xl flex-1 flex-col px-5 py-10 sm:px-10 sm:py-16">
        <div className="mb-6 inline-flex w-fit items-center gap-2 rounded-full border border-amber-500/25 bg-amber-500/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-amber-300">
          <MonitorSmartphone className="size-3.5" />
          Built for Windows — not the browser
        </div>

        <h1 className="max-w-3xl text-3xl font-bold leading-tight tracking-tight text-stone-50 sm:text-5xl">
          Make scroll-stopping videos,{" "}
          <span
            style={{
              backgroundImage: "linear-gradient(to right, #fcd34d, #fbbf24)",
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
            }}
          >
            fast
          </span>
          .
        </h1>

        <p className="mt-5 max-w-2xl text-[15px] leading-relaxed text-stone-400 sm:text-lg">
          FrameFuse is a warm little video studio with a cold-fast engine —
          captions, kinetic typography, AI dubbing and GPU-native export, all
          in one calm, focused timeline.
        </p>

        {/* CTA */}
        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={handleEnterPreview}
            disabled={previewRequested || !onEnterPreview}
            className="flex h-12 items-center justify-center gap-2 rounded-lg bg-amber-400 px-6 text-[14px] font-semibold text-stone-950 shadow-[0_4px_18px_rgba(245,158,11,0.35)] transition-all duration-150 hover:bg-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            title="Open the FrameFuse studio UI in this browser (UI preview — exports run in the Windows app)"
          >
            {previewRequested ? "Opening…" : "Launch the Studio"}
            {!previewRequested && <ArrowRight className="size-4" />}
          </button>
          <a
            href={RELEASES_URL}
            target="_blank"
            rel="noreferrer"
            className="flex h-12 items-center justify-center gap-2 rounded-lg border border-stone-800 bg-stone-900/60 px-6 text-[14px] font-medium text-stone-300 transition-colors duration-150 hover:bg-stone-800/70 hover:text-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60"
            title="Download the FrameFuse installer from the latest GitHub release"
          >
            Download for Windows
          </a>
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-stone-500">
            <span className="rounded-full border border-stone-800 px-2.5 py-1">
              Windows 10 / 11 · 64-bit
            </span>
            <span className="rounded-full border border-stone-800 px-2.5 py-1">
              FFmpeg bundled
            </span>
          </div>
        </div>

        {/* Feature grid */}
        <section aria-label="What the studio includes" className="mt-14">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-500">
            Everything in the studio
          </h2>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="rounded-xl border border-stone-800/70 bg-stone-900/60 p-4 transition-colors duration-150 hover:border-amber-500/40 hover:bg-stone-900/80 sm:p-5"
              >
                <div className="flex items-center gap-2.5">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-amber-500/10 text-amber-300">
                    <f.icon className="size-4" />
                  </span>
                  <span className="text-sm font-semibold text-stone-200">{f.title}</span>
                </div>
                <p className="mt-2.5 text-[12.5px] leading-relaxed text-stone-400">
                  {f.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Why desktop-only */}
        <section
          className="mt-10 rounded-xl border border-teal-500/20 bg-teal-500/5 p-5 sm:p-6"
          aria-label="Why FrameFuse is desktop-only"
        >
          <h2 className="text-sm font-semibold text-stone-200">
            Why a desktop app?
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-stone-400">
            Fast exports, offline captions and real video processing need
            desktop power a web page can&rsquo;t provide.
          </p>
        </section>

        {/* Development preview entry */}
        {onEnterPreview && (
          <section
            className="mt-10 rounded-xl border border-dashed border-stone-700 bg-stone-950/60 p-4 sm:p-5"
            aria-label="Development preview"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <TerminalSquare className="mt-0.5 size-4 shrink-0 text-stone-500" />
                <div>
                  <div className="text-[12.5px] font-medium text-stone-300">
                    Development: open the studio UI in this browser
                  </div>
                  <div className="mt-0.5 text-[11.5px] leading-relaxed text-stone-500">
                    UI preview only — exporting is disabled outside the Windows
                    app by design.
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={handleEnterPreview}
                disabled={previewRequested}
                className="flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-stone-700 bg-stone-900/60 px-4 text-[12px] font-medium text-stone-300 transition-colors duration-150 hover:bg-stone-800/70 hover:text-stone-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 disabled:opacity-60"
              >
                {previewRequested ? "Opening…" : "Open studio preview"}
                {!previewRequested && <ArrowRight className="size-3.5" />}
              </button>
            </div>
          </section>
        )}
      </main>

      {/* Sticky footer (mt-auto keeps it pinned on short viewports) */}
      <footer className="relative z-10 mt-auto border-t border-stone-800 px-5 py-5 text-[11px] text-stone-500 sm:px-10">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-1">
          <span>FrameFuse v{version}</span>
          <span aria-hidden>·</span>
          <a
            href={RELEASES_URL}
            target="_blank"
            rel="noreferrer"
            className="underline-offset-2 transition-colors hover:text-stone-300 hover:underline"
          >
            Download the Windows installer
          </a>
          <span aria-hidden>·</span>
          <span>Video exports, captions and project files live in the desktop app.</span>
        </div>
      </footer>
    </div>
  );
}
