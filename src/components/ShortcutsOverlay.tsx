"use client";

import { useCallback, useEffect, useRef } from "react";
import { Keyboard, X } from "lucide-react";

/**
 * v1.2: Keyboard shortcuts reference overlay — opened with `?` (Shift+/) or
 * the header keyboard button, closed with Esc / backdrop click / the X
 * button. The global key handler in page.tsx bails out while this overlay is
 * open (except for Esc/`?`), so shortcuts like Space can never fire through
 * the dialog.
 */

interface ShortcutRow {
  keys: string[];
  action: string;
}

interface ShortcutGroup {
  title: string;
  icon: React.ReactNode;
  rows: ShortcutRow[];
}

const GROUPS: ShortcutGroup[] = [
  {
    title: "Playback",
    icon: <span aria-hidden>▶</span>,
    rows: [
      { keys: ["Space"], action: "Play / pause" },
      { keys: ["F"], action: "Full screen preview (Esc exits)" },
      { keys: ["L"], action: "Play / speed up (shuttle)" },
      { keys: ["J"], action: "Play / slow down (shuttle)" },
      { keys: ["K"], action: "Pause" },
      { keys: ["←"], action: "Back 1 second" },
      { keys: ["→"], action: "Forward 1 second" },
      { keys: ["Shift", "←"], action: "Previous clip" },
      { keys: ["Shift", "→"], action: "Next clip" },
      { keys: ["Home"], action: "Go to start" },
    ],
  },
  {
    title: "Editing",
    icon: <span aria-hidden>✂</span>,
    rows: [
      { keys: ["S"], action: "Split clip at playhead" },
      { keys: ["Del"], action: "Delete selection / active clip" },
      { keys: ["Ctrl", "Z"], action: "Undo" },
      { keys: ["Ctrl", "Shift", "Z"], action: "Redo" },
      { keys: ["Ctrl", "Y"], action: "Redo" },
    ],
  },
  {
    title: "Selection & clipboard",
    icon: <span aria-hidden>▣</span>,
    rows: [
      { keys: ["Ctrl", "A"], action: "Select all clips" },
      { keys: ["Esc"], action: "Clear selection" },
      { keys: ["Ctrl", "C"], action: "Copy selection" },
      { keys: ["Ctrl", "V"], action: "Paste at playhead" },
      { keys: ["Shift", "click"], action: "Select a range" },
      { keys: ["Ctrl", "click"], action: "Toggle one clip" },
    ],
  },
  {
    title: "Timeline & panels",
    icon: <span aria-hidden>⇔</span>,
    rows: [
      { keys: ["?"], action: "This shortcut sheet" },
      { keys: ["drag splitter"], action: "Resize panels" },
      { keys: ["dbl·click splitter"], action: "Reset panel size" },
      { keys: ["drag clip"], action: "Move clip in time" },
      { keys: ["drag clip edges"], action: "Trim clip in / out" },
    ],
  },
];

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      className="inline-flex h-5 min-w-5 items-center justify-center rounded border px-1.5 font-mono text-[10px] font-medium leading-none"
      style={{
        borderColor: "#e0d8c9",
        backgroundColor: "#f6f2ea",
        color: "#78716c",
        boxShadow: "0 1px 0 rgba(87,66,27,0.08), inset 0 -1px 0 rgba(87,66,27,0.06)",
      }}
    >
      {children}
    </kbd>
  );
}

export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Focus the close button on mount so keyboard users land inside the dialog;
  // Esc is handled by page.tsx's global handler via the open-state ref.
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const onBackdrop = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  return (
    <div
      className="ff-shortcuts-backdrop fixed inset-0 z-[120] flex items-center justify-center p-4"
      onMouseDown={onBackdrop}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className="ff-shortcuts-card flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border"
        style={{
          borderColor: "#e8e1d4",
          backgroundColor: "#ffffff",
          boxShadow:
            "0 24px 64px rgba(87,66,27,0.25), 0 2px 8px rgba(87,66,27,0.08)",
        }}
      >
        {/* Header */}
        <div
          className="flex shrink-0 items-center gap-3 border-b px-5 py-3.5"
          style={{
            borderColor: "#e8e1d4",
            background: "linear-gradient(180deg, #faf7f1 0%, #ffffff 100%)",
          }}
        >
          <div
            className="flex size-8 items-center justify-center rounded-lg"
            style={{
              backgroundImage: "linear-gradient(135deg, #f06214, #ea580c)",
              boxShadow: "0 4px 14px rgba(234, 88, 12, 0.35)",
            }}
          >
            <Keyboard className="size-4 text-white" aria-hidden />
          </div>
          <div className="flex-1">
            <div className="text-[13px] font-semibold" style={{ color: "#292524" }}>
              Keyboard shortcuts
            </div>
            <div className="text-[11px]" style={{ color: "#a8a29e" }}>
              FrameFuse works fastest from the keyboard
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close shortcuts"
            className="flex size-7 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-800"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Body — grouped shortcut rows (scrolls on short screens) */}
        <div className="ff-shortcuts-scroll grid flex-1 grid-cols-1 gap-x-6 overflow-y-auto p-5 sm:grid-cols-2">
          {GROUPS.map((g) => (
            <section key={g.title} aria-label={g.title} className="mb-4 last:mb-0">
              <h3
                className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider"
                style={{ color: "#a8a29e" }}
              >
                <span style={{ color: "#c2410c" }} aria-hidden>
                  {g.icon}
                </span>
                {g.title}
              </h3>
              <ul className="flex flex-col gap-1">
                {g.rows.map((r, i) => (
                  <li
                    key={`${g.title}-${i}-${r.action}`}
                    className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-stone-900/[0.04]"
                  >
                    <span className="text-[12px]" style={{ color: "#44403c" }}>
                      {r.action}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {r.keys.map((k, i) =>
                        i === 0 ? (
                          <Kbd key={k}>{k}</Kbd>
                        ) : (
                          <span key={k} className="flex items-center gap-1">
                            <span className="text-[9px]" style={{ color: "#a8a29e" }}>
                              +
                            </span>
                            <Kbd>{k}</Kbd>
                          </span>
                        ),
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        {/* Footer */}
        <div
          className="flex shrink-0 items-center justify-between border-t px-5 py-2.5"
          style={{ borderColor: "#e8e1d4", backgroundColor: "#faf7f1" }}
        >
          <span className="text-[10px]" style={{ color: "#a8a29e" }}>
            On macOS use ⌘ instead of Ctrl
          </span>
          <span className="flex items-center gap-1.5 text-[10px]" style={{ color: "#78716c" }}>
            <Kbd>Esc</Kbd> to close
          </span>
        </div>
      </div>
    </div>
  );
}
