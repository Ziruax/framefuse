"use client";

// src/components/AiModelsSection.tsx — v1.28/v1.29 SETTINGS TAB.
//
// The ONE place provider/model defaults are configured:
//   • API keys (Groq + Gemini)
//   • Caption transcription (Captions → AI Captions + Dub Studio stage 1)
//   • Dubbing script writing (Dub Studio stage 2)
//
// v1.28: the sandbox-only "Built-in Cloud" provider is REMOVED — Groq and
// Gemini are the real providers. Key handling is DUAL-TRANSPORT:
//   • DESKTOP (electronAPI): keys are stored by the MAIN process
//     (userData/groq.json + gemini.json, 0600) via whisperGroqSet/geminiSet
//     IPC; the bridge never returns the raw key (masked payloads only);
//     Test runs the main-process key check (no CORS, real network).
//   • WEB PREVIEW: keys stay in localStorage and ride each API request;
//     Test goes through POST /api/ai/test (server-side fetch).
//
// v1.29 KEY TRUTH (the "groq rejected the api key but the console shows no
// call" fix): on DESKTOP the DEVICE key file is the ONLY key any AI feature
// ever sends — so it is also the only key the Test button tests. A stale
// localStorage mirror (web-preview or v1.27 era) is MIGRATED to the device
// on first hydrate and then cleared, and keys are FORMAT-CHECKED before any
// network call (gsk_… / AIza…, no quotes, no spaces). Rejection messages now
// echo the MASKED key that was refused, because auth-rejected requests do
// NOT appear in the provider consoles' usage.
// Visual tokens mirror the SettingsPanel cards (#332e28 borders, #26221e /
// #211e1a fills, stone text) so the tab looks native.

import { useCallback, useEffect, useState } from "react";
import {
  BadgeCheck,
  Check,
  ExternalLink,
  KeyRound,
  Languages,
  Loader2,
  Mic,
  Settings2,
  Trash2,
} from "lucide-react";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  GEMINI_TEXT_MODELS,
  GROQ_TEXT_MODELS,
  GROQ_WHISPER_MODELS,
  saveAiSettings,
  useAiSettings,
  type AiModelOption,
  type AiSettings,
} from "@/lib/merger/ai-settings";

// ---------------------------------------------------------------------------
// Small local UI helpers (Section/Field equivalents at the same tokens)
// ---------------------------------------------------------------------------

const CARD = { borderColor: "#2b2723", backgroundColor: "#26221e" } as const;
const INNER = { borderColor: "#2b2723", backgroundColor: "#211e1a" } as const;
const ROW_BORDER = { borderColor: "#332e28" } as const;

function CardTitle({ icon, title, sub }: { icon: React.ReactNode; title: string; sub: string }) {
  return (
    <div className="mb-2 flex items-center gap-1.5">
      <span className="text-orange-600">{icon}</span>
      <span className="text-[11px] font-semibold text-stone-200">{title}</span>
      <span className="ml-auto text-[9px] text-stone-500">{sub}</span>
    </div>
  );
}

function ProviderButton({
  active,
  onClick,
  icon,
  label,
  title,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={cn(
        "flex items-center justify-center gap-1.5 rounded border px-2 py-1.5 text-[11px] font-medium transition-colors",
        active
          ? "border-orange-500/50 bg-orange-500/15 text-orange-300"
          : "border-[#2b2723] bg-[#26221e] text-stone-500 hover:bg-white/[0.04] hover:text-stone-300",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function ModelSelect({
  label,
  value,
  catalog,
  onChange,
  ariaLabel,
}: {
  label: string;
  value: string;
  catalog: AiModelOption[];
  onChange: (id: string) => void;
  ariaLabel: string;
}) {
  return (
    <div className="min-w-0 flex-1">
      <label className="mb-0.5 block text-[10px] font-medium text-stone-500">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        className="w-full rounded border bg-[#211e1a] px-2 py-1.5 text-[11px] text-stone-300 focus:border-orange-500 focus:outline-none"
        style={ROW_BORDER}
      >
        {catalog.map((m) => (
          <option key={m.id} value={m.id} title={m.hint}>
            {m.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Key row (masked display + save/test/remove) — dual transport
// ---------------------------------------------------------------------------

/** The desktop bridge (typed minimal — the full shape lives in types.ts). */
type KeyBridge = {
  whisperGroqGet?: () => Promise<{ hasKey: boolean; maskedKey: string; model?: string }>;
  whisperGroqSet?: (p: { apiKey?: string; model?: string }) => Promise<{ hasKey: boolean; maskedKey: string }>;
  whisperGroqTest?: (p: { apiKey?: string }) => Promise<{ ok: boolean; message: string }>;
  geminiGet?: () => Promise<{ hasKey: boolean; maskedKey: string }>;
  geminiSet?: (p: { apiKey: string }) => Promise<{ hasKey: boolean; maskedKey: string }>;
  geminiTest?: (p: { apiKey?: string }) => Promise<{ ok: boolean; message: string }>;
  geminiClear?: () => Promise<{ ok: boolean }>;
};

function keyBridge(): KeyBridge | null {
  if (typeof window === "undefined") return null;
  const api = (window as { electronAPI?: KeyBridge }).electronAPI;
  return api ?? null;
}

// ---------------------------------------------------------------------------
// v1.29 key pre-flight — catch the classic paste artifacts BEFORE any
// network call (a quoted/spaced/prefixed-wrong key can only ever produce
// a 403 "rejected the API key" with no trace in console usage).
// ---------------------------------------------------------------------------

/** Strip ONE pair of wrapping quotes (the classic copy-paste artifact) —
 *  mirrors main.js's GQ.normalizeGroqApiKey backstop. */
function stripWrappingQuotes(s: string): string {
  const t = s.trim();
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) ||
      (t.startsWith("'") && t.endsWith("'")))
  ) {
    return t.slice(1, -1).trim();
  }
  return t;
}

interface KeyProblem {
  title: string;
  description: string;
}

/** Groq keys start with "gsk_" and carry no whitespace/quotes/newlines. */
function groqKeyProblem(key: string): KeyProblem | null {
  if (!key) {
    return {
      title: "Paste your Groq API key first",
      description: "Get a free key at console.groq.com/keys.",
    };
  }
  if (!key.startsWith("gsk_")) {
    return {
      title: "That doesn't look like a Groq API key",
      description: "Copy the full gsk_… key from console.groq.com/keys (no quotes, no spaces).",
    };
  }
  if (/\s/.test(key) || /["']/.test(key)) {
    return {
      title: "The Groq API key contains spaces or quotes",
      description: "Copy the full gsk_… key from console.groq.com/keys — exactly as shown, no quotes, no spaces.",
    };
  }
  return null;
}

/** Gemini keys are AIza…-style; sanity only (no hard length rule — Google
 *  has shipped more than one length). */
function geminiKeyProblem(key: string): KeyProblem | null {
  if (!key) {
    return {
      title: "Paste your Gemini API key first",
      description: "Get a free key at aistudio.google.com/apikey.",
    };
  }
  if (/\s/.test(key) || /["']/.test(key)) {
    return {
      title: "That doesn't look like a Gemini API key",
      description: "Copy the full AIza… key from aistudio.google.com/apikey (no quotes, no spaces).",
    };
  }
  return null;
}

function KeyRow({ provider }: { provider: "groq" | "gemini" }) {
  const ai = useAiSettings();
  const isGroq = provider === "groq";
  const savedKey = isGroq ? ai.groqKey : ai.geminiKey;
  const onDevice = isGroq ? ai.groqKeyOnDevice === true : ai.geminiKeyOnDevice === true;
  const bridge = keyBridge();
  const [editing, setEditing] = useState(!savedKey && !onDevice);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "test">("");
  /** Desktop masked key from the main process (the raw key never crosses
   *  the bridge — this is the display form when a key file exists). */
  const [deviceMasked, setDeviceMasked] = useState("");

  const persist = useCallback(
    (next: Partial<AiSettings>) => {
      saveAiSettings({ ...ai, ...next });
    },
    [ai],
  );

  // Hydrate the desktop key status (masked form + on-device flag) once.
  // v1.29 KEY TRUTH: on desktop the DEVICE key file (userData/groq.json /
  // gemini.json) is the ONLY key transcription and script writing ever
  // send, so this effect also reconciles any localStorage mirror:
  //   • device has NO key + localStorage has one (web-preview or v1.27
  //     era) → MIGRATE it onto the device, then clear the localStorage copy;
  //   • device HAS a key + localStorage also has one (stale — possibly a
  //     DIFFERENT key) → keep the device key, clear the localStorage copy
  //     so the masked display and the Test button can never point at the
  //     wrong key. This is the exact v1.28 bug: Test passed on the
  //     localStorage key while transcription sent the device one.
  // Runs once per mount (deps [isGroq]) — a second run would find an empty
  // localStorage mirror and do nothing.
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    (async () => {
      try {
        if (isGroq) {
          const st = await bridge.whisperGroqGet?.();
          if (!alive || !st) return;
          if (st.hasKey) {
            setDeviceMasked(st.maskedKey || "");
            persist(
              savedKey
                ? { groqKey: "", groqKeyOnDevice: true }
                : { groqKeyOnDevice: true },
            );
            // A device key exists — never leave the row in its editing
            // state (v1.28 quirk: first desktop mount with a pre-existing
            // groq.json showed an EMPTY input instead of the masked key).
            setEditing(false);
            return;
          }
          if (savedKey) {
            const cleaned = stripWrappingQuotes(savedKey);
            if (groqKeyProblem(cleaned)) {
              // A malformed mirror can never work — drop it so the row
              // starts clean in its editing state.
              persist({ groqKey: "", groqKeyOnDevice: false });
              return;
            }
            await bridge.whisperGroqSet?.({ apiKey: cleaned, model: ai.sttGroqModel });
            const st2 = await bridge.whisperGroqGet?.();
            if (!alive) return;
            setDeviceMasked(st2?.maskedKey || "");
            persist({ groqKey: "", groqKeyOnDevice: true });
            setEditing(false);
          }
        } else {
          const st = await bridge.geminiGet?.();
          if (!alive || !st) return;
          if (st.hasKey) {
            setDeviceMasked(st.maskedKey || "");
            persist(
              savedKey
                ? { geminiKey: "", geminiKeyOnDevice: true }
                : { geminiKeyOnDevice: true },
            );
            setEditing(false);
            return;
          }
          if (savedKey) {
            const cleaned = stripWrappingQuotes(savedKey);
            if (geminiKeyProblem(cleaned)) {
              persist({ geminiKey: "", geminiKeyOnDevice: false });
              return;
            }
            await bridge.geminiSet?.({ apiKey: cleaned });
            const st2 = await bridge.geminiGet?.();
            if (!alive) return;
            setDeviceMasked(st2?.maskedKey || "");
            persist({ geminiKey: "", geminiKeyOnDevice: true });
            setEditing(false);
          }
        }
      } catch {
        /* bridge hiccup — the row just starts in its editing state */
      }
    })();
    return () => {
      alive = false;
    };
  }, [isGroq]);

  const save = useCallback(async () => {
    const key = stripWrappingQuotes(input);
    if (!key) return;
    // v1.29 pre-flight: never store or send an obviously malformed key.
    const problem = isGroq ? groqKeyProblem(key) : geminiKeyProblem(key);
    if (problem) {
      toast.error(problem.title, { description: problem.description });
      return;
    }
    setBusy("save");
    try {
      if (bridge) {
        // Desktop — the MAIN process owns the key file (userData, 0600).
        // The localStorage mirror stays EMPTY (device key is the truth).
        if (isGroq) {
          await bridge.whisperGroqSet?.({ apiKey: key, model: ai.sttGroqModel });
        } else {
          await bridge.geminiSet?.({ apiKey: key });
        }
        persist(isGroq ? { groqKey: "", groqKeyOnDevice: true } : { geminiKey: "", geminiKeyOnDevice: true });
        setEditing(false);
        setInput("");
        toast.success(`${isGroq ? "Groq" : "Gemini"} key saved`, {
          description: "Stored on this device (the app data folder) — used by transcription, script writing and dubbing.",
        });
      } else {
        // Web preview — localStorage, rides each request.
        persist(isGroq ? { groqKey: key, groqKeyOnDevice: false } : { geminiKey: key, geminiKeyOnDevice: false });
        setEditing(false);
        setInput("");
        toast.success(`${isGroq ? "Groq" : "Gemini"} key saved`, {
          description: "It stays in this browser and rides each AI request.",
        });
      }
    } catch (err) {
      toast.error("Could not save the key", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy("");
    }
  }, [input, isGroq, persist, bridge, ai.sttGroqModel]);

  const test = useCallback(async () => {
    // v1.29 KEY TRUTH: on DESKTOP the device key file is the only key the
    // app ever sends — so it is the only "saved" key Test checks:
    //   • editing with input → validate + test the INPUT (pre-flight first);
    //   • otherwise → send NO apiKey: the main process tests the key saved
    //     on this device (userData/groq.json / gemini.json). The
    //     localStorage mirror is NEVER sent from desktop — it may be a
    //     different key, which is exactly the v1.28 "test passed but
    //     transcription said the key was rejected" bug.
    const typed = editing ? stripWrappingQuotes(input) : "";
    if (typed) {
      const problem = isGroq ? groqKeyProblem(typed) : geminiKeyProblem(typed);
      if (problem) {
        toast.error(problem.title, { description: problem.description });
        return;
      }
    }
    if (!bridge && !typed && !savedKey) return; // web with nothing to test
    setBusy("test");
    try {
      let ok = false;
      let message = "";
      if (bridge) {
        // Desktop — the main-process check (real https, no CORS). An empty
        // payload means "test the key saved on this device".
        const r = isGroq
          ? await bridge.whisperGroqTest?.(typed ? { apiKey: typed } : {})
          : await bridge.geminiTest?.(typed ? { apiKey: typed } : {});
        ok = !!r?.ok;
        message = r?.message ?? "";
      } else {
        // Web preview — the localStorage key rides the request.
        const candidate = typed || savedKey;
        if (!candidate) return;
        const res = await fetch("/api/ai/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, key: candidate }),
        });
        const j = (await res.json()) as { ok?: boolean; message?: string; error?: string };
        ok = res.ok && !!j.ok;
        message = j.message ?? j.error ?? `HTTP ${res.status}`;
      }
      if (ok) {
        toast.success(`${isGroq ? "Groq" : "Gemini"} key works`, { description: message });
      } else {
        toast.error("Key check failed", { description: message });
      }
    } catch (err) {
      toast.error("Could not reach the key test", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy("");
    }
  }, [editing, input, isGroq, savedKey, provider, bridge]);

  const remove = useCallback(async () => {
    setBusy("save");
    try {
      if (bridge) {
        if (isGroq) await bridge.whisperGroqSet?.({ apiKey: "" });
        else await bridge.geminiClear?.();
        setDeviceMasked("");
        // v1.29: clear the localStorage mirror too — after removal NO key
        // may linger anywhere (the row must start clean in editing mode).
        persist(isGroq ? { groqKey: "", groqKeyOnDevice: false } : { geminiKey: "", geminiKeyOnDevice: false });
      } else {
        persist(isGroq ? { groqKey: "" } : { geminiKey: "" });
      }
      toast.info(`${isGroq ? "Groq" : "Gemini"} key removed`);
    } catch (err) {
      toast.error("Could not remove the key", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy("");
    }
  }, [bridge, isGroq, persist]);

  const hasSomeKey = !!savedKey || onDevice;
  const localMask = savedKey
    ? `${savedKey.slice(0, 6)}${"•".repeat(Math.max(4, Math.min(24, savedKey.length - 8)))}${savedKey.slice(-3)}`
    : "";
  // v1.29: on DESKTOP the DEVICE key is the truth — its masked form wins
  // whenever we're not mid-edit (a stale localStorage copy must never be
  // the thing the user reads back). The local mask only shows as a
  // pre-hydrate fallback — and on the web preview, where localStorage IS
  // the truth.
  const masked = bridge && !editing ? deviceMasked || localMask : localMask || deviceMasked;

  return (
    <div className="rounded-lg border p-2.5" style={INNER}>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-stone-500">
          <KeyRound size={10} className="text-orange-600" />
          {isGroq ? "Groq API key" : "Gemini API key"}
        </span>
        {hasSomeKey && !editing && (
          <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-300">
            <Check size={10} /> Key saved
          </span>
        )}
      </div>

      {!editing && hasSomeKey ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span
              className="flex-1 truncate rounded border bg-[#26221e] px-2 py-1 font-mono text-[10px] text-stone-400"
              style={ROW_BORDER}
              title={masked}
            >
              {masked}
            </span>
          </div>
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              onClick={test}
              disabled={busy !== ""}
              className="flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-medium text-stone-400 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
              style={ROW_BORDER}
            >
              {busy === "test" ? <Loader2 size={10} className="animate-spin" /> : <BadgeCheck size={10} />}
              Test key
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(true);
                setInput("");
              }}
              disabled={busy !== ""}
              className="rounded border px-2 py-1 text-[10px] font-medium text-stone-400 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
              style={ROW_BORDER}
            >
              Replace
            </button>
            <button
              type="button"
              onClick={remove}
              disabled={busy !== ""}
              className="flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-medium text-rose-400/90 transition-colors hover:border-rose-500/50 hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-50"
              style={ROW_BORDER}
            >
              <Trash2 size={10} /> Remove
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <input
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                save();
              }
            }}
            placeholder={isGroq ? "gsk_… paste your Groq API key" : "AIza… paste your Gemini API key"}
            spellCheck={false}
            autoComplete="off"
            aria-label={isGroq ? "Groq API key" : "Gemini API key"}
            className="w-full rounded border bg-[#211e1a] px-2 py-1.5 font-mono text-[10px] text-stone-300 placeholder:text-stone-500 focus:border-orange-500/60 focus:outline-none"
            style={ROW_BORDER}
          />
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={save}
              disabled={busy !== "" || !input.trim()}
              className="flex items-center gap-1 rounded bg-orange-500 px-2.5 py-1 text-[10px] font-semibold text-white transition-colors hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === "save" ? <Loader2 size={10} className="animate-spin" /> : <KeyRound size={10} />}
              Save key
            </button>
            <button
              type="button"
              onClick={test}
              disabled={busy !== "" || !input.trim()}
              className="flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-medium text-stone-400 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
              style={ROW_BORDER}
            >
              {busy === "test" ? <Loader2 size={10} className="animate-spin" /> : <BadgeCheck size={10} />}
              Test
            </button>
            {editing && savedKey && (
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setInput("");
                }}
                className="rounded border px-2 py-1 text-[10px] font-medium text-stone-500 transition-colors hover:bg-white/[0.06]"
                style={ROW_BORDER}
              >
                Cancel
              </button>
            )}
            <a
              href={isGroq ? "https://console.groq.com/keys" : "https://aistudio.google.com/apikey"}
              target="_blank"
              rel="noreferrer"
              className="ml-auto flex items-center gap-1 text-[10px] font-medium text-orange-400 underline-offset-2 hover:underline"
            >
              Get a free key
              <ExternalLink size={9} />
            </a>
          </div>
        </div>
      )}

      <p className="mt-1.5 text-[9px] leading-relaxed text-stone-400">
        {isGroq
          ? bridge
            ? "Stored on this device (app data, private) — used for Whisper transcription + Groq script models."
            : "Used for Whisper transcription + Groq script models. It stays in this browser and rides each request — the server never stores it."
          : bridge
            ? "Stored on this device (app data, private) — used for Gemini script models."
            : "Used for Gemini script models. It stays in this browser and rides each request — the server never stores it."}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main section
// ---------------------------------------------------------------------------

export default function AiModelsSection() {
  const ai = useAiSettings();
  const update = useCallback(
    (next: Partial<AiSettings>) => saveAiSettings({ ...ai, ...next }),
    [ai],
  );

  const groqReady = ai.groqKey.trim().length > 0 || ai.groqKeyOnDevice === true;
  const geminiReady = ai.geminiKey.trim().length > 0 || ai.geminiKeyOnDevice === true;

  return (
    <section aria-label="Default AI models" className="mb-4 rounded-lg border p-3" style={CARD}>
      <div className="mb-2 flex items-center gap-1.5">
        <Settings2 size={13} className="text-orange-600" />
        <span className="text-[11px] font-semibold text-stone-200">Default AI models</span>
        <span className="ml-auto text-[9px] text-stone-500">v1.28 · one place</span>
      </div>
      <p className="mb-3 text-[10px] leading-relaxed text-stone-400">
        Every AI surface (Captions, Dub Studio) reads its provider and model from here. The cards
        in those tabs show a read-only summary — this is the only picker.
      </p>

      {/* ── API keys ─────────────────────────────────────────────────── */}
      <div className="mb-3 grid gap-2 sm:grid-cols-2">
        <KeyRow provider="groq" />
        <KeyRow provider="gemini" />
      </div>

      {/* ── Caption transcription ────────────────────────────────────── */}
      <div className="mb-3 rounded-lg border p-2.5" style={INNER}>
        <CardTitle
          icon={<Mic size={12} />}
          title="Caption transcription"
          sub="Captions + Dub stage 1"
        />
        <div className="mb-2 flex flex-wrap items-center gap-1" role="group" aria-label="Transcription provider">
          <ProviderButton
            active={true}
            onClick={() => update({ sttProvider: "groq" })}
            icon={<Mic size={12} />}
            label="Groq Whisper"
            title="Whisper with REAL per-word timestamps — needs the Groq key (best for word-to-word dub timing)"
          />
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <ModelSelect
            label="Whisper model"
            value={ai.sttGroqModel}
            catalog={GROQ_WHISPER_MODELS}
            onChange={(id) => update({ sttGroqModel: id })}
            ariaLabel="Groq Whisper model"
          />
          {groqReady ? (
            <span className="flex items-center gap-1 pb-1.5 text-[10px] font-medium text-emerald-300">
              <Check size={10} /> Groq key ready
            </span>
          ) : (
            <span className="pb-1.5 text-[10px] text-orange-400/90">
              Save your Groq key above to transcribe (free at console.groq.com).
            </span>
          )}
        </div>
        <p className="mt-1.5 text-[10px] leading-relaxed text-stone-500">
          Groq Whisper gives real per-word timestamps — the input for word-to-word dub timing and
          karaoke captions.
        </p>
      </div>

      {/* ── Dubbing script writing ───────────────────────────────────── */}
      <div className="rounded-lg border p-2.5" style={INNER}>
        <CardTitle
          icon={<Languages size={12} />}
          title="Dubbing script writing"
          sub="Dub stage 2"
        />
        <div className="mb-2 grid grid-cols-2 gap-1" role="group" aria-label="Script writing provider">
          <ProviderButton
            active={ai.dubTextProvider === "groq"}
            onClick={() => update({ dubTextProvider: "groq" })}
            icon={<Mic size={12} />}
            label="Groq"
            title="Groq chat models — needs the Groq key"
          />
          <ProviderButton
            active={ai.dubTextProvider === "gemini"}
            onClick={() => update({ dubTextProvider: "gemini" })}
            icon={<Languages size={12} />}
            label="Gemini"
            title="Google Gemini models — needs the Gemini key"
          />
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {ai.dubTextProvider === "groq" && (
            <ModelSelect
              label="Groq model"
              value={ai.dubGroqModel}
              catalog={GROQ_TEXT_MODELS}
              onChange={(id) => update({ dubGroqModel: id })}
              ariaLabel="Groq script model"
            />
          )}
          {ai.dubTextProvider === "gemini" && (
            <ModelSelect
              label="Gemini model"
              value={ai.dubGeminiModel}
              catalog={GEMINI_TEXT_MODELS}
              onChange={(id) => update({ dubGeminiModel: id })}
              ariaLabel="Gemini script model"
            />
          )}
          {ai.dubTextProvider === "groq" &&
            (groqReady ? (
              <span className="flex items-center gap-1 pb-1.5 text-[10px] font-medium text-emerald-300">
                <Check size={10} /> Groq key ready
              </span>
            ) : (
              <span className="pb-1.5 text-[10px] text-orange-400/90">
                Save your Groq key above to write scripts with Groq.
              </span>
            ))}
          {ai.dubTextProvider === "gemini" &&
            (geminiReady ? (
              <span className="flex items-center gap-1 pb-1.5 text-[10px] font-medium text-emerald-300">
                <Check size={10} /> Gemini key ready
              </span>
            ) : (
              <span className="pb-1.5 text-[10px] text-orange-400/90">
                Save your Gemini key above to write scripts with Gemini.
              </span>
            ))}
        </div>
        <p className="mt-1.5 text-[10px] leading-relaxed text-stone-500">
          This provider writes the dubbing script: speaker detection + translation (default target
          language stays Hindi — pick it in the Dubbing tab).
        </p>
      </div>
    </section>
  );
}
