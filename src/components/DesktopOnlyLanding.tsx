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
 * studio UI ("Open studio preview") for development/verification — the
 * studio in a browser is a UI preview, exports intentionally refuse to run.
 */

import { useCallback, useState } from "react";
import {
  ArrowRight,
  Captions,
  Cpu,
  Download,
  Film,
  Layers,
  MonitorSmartphone,
  Sparkles,
  TerminalSquare,
  Zap,
} from "lucide-react";

const RELEASES_URL = "https://github.com/Ziruax/framefuse/releases/latest";

/** Matches the app icon (Task 43): deep-cyan rounded badge, white play
 * triangle, sprocket dots. Inline so the landing has zero asset deps. */
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
          <stop offset="0%" stopColor="#0891b2" />
          <stop offset="100%" stopColor="#0e7490" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#ff-landing-badge)" />
      {/* sprocket holes — film reel nod */}
      <circle cx="15" cy="16" r="2.6" fill="#164e63" />
      <circle cx="15" cy="32" r="2.6" fill="#164e63" />
      <circle cx="15" cy="48" r="2.6" fill="#164e63" />
      <path
        d="M29 20.5 L47 32 L29 43.5 Z"
        fill="#ffffff"
        stroke="#ffffff"
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
    icon: Zap,
    title: "True Smart Rendering",
    body: "Untouched cuts are stream-copied at disk speed — only the ranges you actually edited get re-encoded.",
  },
  {
    icon: Cpu,
    title: "Parallel native FFmpeg export",
    body: "The timeline is sliced across your CPU's physical cores, with the audio bus mixed in one global pass.",
  },
  {
    icon: Captions,
    title: "Offline Whisper captions",
    body: "AI transcription and burned-in animated captions run entirely on your machine — nothing leaves it.",
  },
  {
    icon: Layers,
    title: "Chroma key & picture-in-picture",
    body: "Green/white/black screen removal with on-canvas PiP and a multi-track overlay lane.",
  },
  {
    icon: Sparkles,
    title: "SFX & music bus",
    body: "Synthesized sound effects, looping background music, loudness normalization on the master bus.",
  },
  {
    icon: Film,
    title: "Native project files",
    body: "Save/open .framefuse projects with your recent files list — a real desktop workflow, not browser tabs.",
  },
];

export function DesktopOnlyLanding({
  version = "1.14.2",
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
    <div
      className="flex min-h-screen w-full flex-col"
      style={{ backgroundColor: "#0a0a0a", color: "#e4e4e7" }}
    >
      {/* Top bar */}
      <header className="flex items-center gap-3 px-5 py-4 sm:px-10">
        <LogoMark size={38} />
        <div className="min-w-0">
          <div className="text-[15px] font-semibold leading-tight">FrameFuse</div>
          <div className="text-[11px] leading-tight" style={{ color: "#71717a" }}>
            v{version} · Windows desktop app
          </div>
        </div>
        <a
          href={RELEASES_URL}
          target="_blank"
          rel="noreferrer"
          className="ml-auto hidden items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors sm:flex"
          style={{
            borderColor: "#27272a",
            backgroundColor: "rgba(24,24,27,0.6)",
            color: "#a1a1aa",
          }}
        >
          Releases
          <ArrowRight className="size-3.5" />
        </a>
      </header>

      {/* Hero */}
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-5 py-10 sm:px-10 sm:py-16">
        <div
          className="mb-5 inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-wider"
          style={{
            borderColor: "rgba(34, 211, 238, 0.35)",
            backgroundColor: "rgba(8, 145, 178, 0.1)",
            color: "#67e8f9",
          }}
        >
          <MonitorSmartphone className="size-3.5" />
          Built for Windows — not the browser
        </div>

        <h1 className="max-w-3xl text-3xl font-bold leading-tight tracking-tight sm:text-5xl">
          FrameFuse is a{" "}
          <span
            style={{
              backgroundImage: "linear-gradient(to right, #22d3ee, #67e8f9)",
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
            }}
          >
            desktop video studio
          </span>
          .
        </h1>

        <p className="mt-5 max-w-2xl text-[15px] leading-relaxed sm:text-lg" style={{ color: "#a1a1aa" }}>
          The full studio — timeline editing, the multi-core FFmpeg export engine,
          offline Whisper captions — runs as a native Windows application.
          Exports spawn real FFmpeg processes on your CPU, which a browser page
          can never do. Install the desktop app to create and export videos.
        </p>

        {/* CTA */}
        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
          <a
            href={RELEASES_URL}
            target="_blank"
            rel="noreferrer"
            className="ff-btn-export flex h-12 items-center justify-center gap-2 rounded-lg px-6 text-[14px] font-semibold transition-all active:scale-[0.97] active:brightness-90"
            title="Download the FrameFuse installer from the latest GitHub release"
          >
            <Download className="size-4.5" />
            Download for Windows
          </a>
          <div
            className="flex flex-wrap items-center gap-2 text-[11px]"
            style={{ color: "#71717a" }}
          >
            <span
              className="rounded-full border px-2.5 py-1"
              style={{ borderColor: "#27272a" }}
            >
              Windows 10 / 11 · 64-bit
            </span>
            <span
              className="rounded-full border px-2.5 py-1"
              style={{ borderColor: "#27272a" }}
            >
              FFmpeg bundled
            </span>
            <span
              className="rounded-full border px-2.5 py-1"
              style={{ borderColor: "#27272a" }}
            >
              ~380 MB installer
            </span>
          </div>
        </div>

        {/* Feature grid */}
        <section aria-label="What the desktop app includes" className="mt-14">
          <h2 className="text-[13px] font-semibold uppercase tracking-wider" style={{ color: "#a1a1aa" }}>
            What&rsquo;s inside the desktop app
          </h2>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="rounded-xl border p-4 transition-colors sm:p-5"
                style={{
                  borderColor: "#27272a",
                  backgroundColor: "rgba(18,18,21,0.65)",
                }}
              >
                <div className="flex items-center gap-2.5">
                  <span
                    className="flex size-8 items-center justify-center rounded-lg"
                    style={{ backgroundColor: "rgba(8,145,178,0.14)", color: "#22d3ee" }}
                  >
                    <f.icon className="size-4" />
                  </span>
                  <span className="text-[13.5px] font-semibold">{f.title}</span>
                </div>
                <p className="mt-2.5 text-[12.5px] leading-relaxed" style={{ color: "#a1a1aa" }}>
                  {f.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Why desktop-only */}
        <section
          className="mt-10 rounded-xl border p-5 sm:p-6"
          style={{
            borderColor: "rgba(34, 211, 238, 0.22)",
            backgroundColor: "rgba(8, 145, 178, 0.06)",
          }}
          aria-label="Why FrameFuse is desktop-only"
        >
          <h2 className="text-[14px] font-semibold" style={{ color: "#e4e4e7" }}>
            Why not the browser?
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed" style={{ color: "#a1a1aa" }}>
            Fast exports mean native FFmpeg child processes sliced across your
            CPU, hardware decode probes, and offline speech models — none of
            which a web page is allowed to run. Keeping FrameFuse desktop-only
            keeps the export engine honest: what you configure is what renders,
            at the speed your machine can actually deliver.
          </p>
        </section>

        {/* Development preview entry */}
        {onEnterPreview && (
          <section
            className="mt-10 rounded-xl border border-dashed p-4 sm:p-5"
            style={{ borderColor: "#3f3f46", backgroundColor: "rgba(12,12,14,0.6)" }}
            aria-label="Development preview"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <TerminalSquare className="mt-0.5 size-4 shrink-0" style={{ color: "#71717a" }} />
                <div>
                  <div className="text-[12.5px] font-medium" style={{ color: "#d4d4d8" }}>
                    Development: open the studio UI in this browser
                  </div>
                  <div className="mt-0.5 text-[11.5px] leading-relaxed" style={{ color: "#71717a" }}>
                    UI preview only — exporting is disabled outside the Windows
                    app by design.
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={handleEnterPreview}
                disabled={previewRequested}
                className="flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md border px-4 text-[12px] font-medium transition-colors disabled:opacity-60"
                style={{
                  borderColor: "#3f3f46",
                  backgroundColor: "rgba(24,24,27,0.8)",
                  color: "#d4d4d8",
                }}
              >
                {previewRequested ? "Opening…" : "Open studio preview"}
                {!previewRequested && <ArrowRight className="size-3.5" />}
              </button>
            </div>
          </section>
        )}
      </main>

      {/* Sticky footer (mt-auto keeps it pinned on short viewports) */}
      <footer
        className="mt-auto border-t px-5 py-5 text-[11px] sm:px-10"
        style={{ borderColor: "#27272a", color: "#71717a" }}
      >
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-1">
          <span>FrameFuse v{version}</span>
          <span aria-hidden>·</span>
          <a
            href={RELEASES_URL}
            target="_blank"
            rel="noreferrer"
            className="underline-offset-2 transition-colors hover:text-[#a1a1aa] hover:underline"
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
