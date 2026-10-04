"use client";

// src/components/AiModelsSection.tsx — v1.27 SETTINGS TAB.
//
// The ONE place provider/model defaults are configured:
//   • API keys (Groq + Gemini — localStorage, ride each API request)
//   • Caption transcription (Captions → AI Captions + Dub Studio stage 1)
//   • Dubbing script writing (Dub Studio stage 2)
//
// The Dub Studio / Captions cards used to embed their own model pickers —
// they now show read-only summaries that link here (onOpenSettings).
// Visual tokens mirror the SettingsPanel cards (#332e28 borders, #26221e /
// #211e1a fills, stone text) so the tab looks native.

import { useCallback, useState } from "react";
import {
  BadgeCheck,
  Check,
  ExternalLink,
  KeyRound,
  Languages,
  Loader2,
  Mic,
  Settings2,
  Sparkles,
  Trash2,
} from "lucide-react";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  BUILTIN_TEXT_MODELS,
  GEMINI_TEXT_MODELS,
  GROQ_TEXT_MODELS,
  GROQ_WHISPER_MODELS,
  saveAiSettings,
  useAiSettings,
  type AiModelOption,
  type AiSettings,
  type AiSttProvider,
  type AiTextProvider,
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
// Key row (masked display + save/test/remove)
// ---------------------------------------------------------------------------

function KeyRow({ provider }: { provider: "groq" | "gemini" }) {
  const ai = useAiSettings();
  const isGroq = provider === "groq";
  const savedKey = isGroq ? ai.groqKey : ai.geminiKey;
  const [editing, setEditing] = useState(!savedKey);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "test">("");

  const persist = useCallback(
    (next: Partial<AiSettings>) => {
      saveAiSettings({ ...ai, ...next });
    },
    [ai],
  );

  const save = useCallback(() => {
    const key = input.trim();
    if (!key) return;
    persist(isGroq ? { groqKey: key } : { geminiKey: key });
    setEditing(false);
    setInput("");
    toast.success(`${isGroq ? "Groq" : "Gemini"} key saved`, {
      description: "It stays in this browser and rides each AI request.",
    });
  }, [input, isGroq, persist]);

  const test = useCallback(async () => {
    const key = editing && input.trim() ? input.trim() : savedKey;
    if (!key) return;
    setBusy("test");
    try {
      const res = await fetch("/api/ai/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, key }),
      });
      const j = (await res.json()) as { ok?: boolean; message?: string; error?: string };
      if (res.ok && j.ok) {
        toast.success(`${isGroq ? "Groq" : "Gemini"} key works`, { description: j.message });
      } else {
        toast.error("Key check failed", { description: j.message ?? j.error ?? `HTTP ${res.status}` });
      }
    } catch (err) {
      toast.error("Could not reach the key test", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy("");
    }
  }, [editing, input, isGroq, savedKey, provider]);

  const masked = savedKey
    ? `${savedKey.slice(0, 6)}${"•".repeat(Math.max(4, Math.min(24, savedKey.length - 8)))}${savedKey.slice(-3)}`
    : "";

  return (
    <div className="rounded-lg border p-2.5" style={INNER}>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-stone-500">
          <KeyRound size={10} className="text-orange-600" />
          {isGroq ? "Groq API key" : "Gemini API key"}
        </span>
        {savedKey && !editing && (
          <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-300">
            <Check size={10} /> Key saved
          </span>
        )}
      </div>

      {!editing && savedKey ? (
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
              onClick={() => persist(isGroq ? { groqKey: "" } : { geminiKey: "" })}
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
          ? "Used for Whisper transcription + Groq script models. It stays in this browser and rides each request — the server never stores it."
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

  const groqReady = ai.groqKey.trim().length > 0;
  const geminiReady = ai.geminiKey.trim().length > 0;

  return (
    <section aria-label="Default AI models" className="mb-4 rounded-lg border p-3" style={CARD}>
      <div className="mb-2 flex items-center gap-1.5">
        <Settings2 size={13} className="text-orange-600" />
        <span className="text-[11px] font-semibold text-stone-200">Default AI models</span>
        <span className="ml-auto text-[9px] text-stone-500">v1.27 · one place</span>
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
        <div className="mb-2 grid grid-cols-2 gap-1" role="group" aria-label="Transcription provider">
          <ProviderButton
            active={ai.sttProvider === "builtin"}
            onClick={() => update({ sttProvider: "builtin" })}
            icon={<Sparkles size={12} />}
            label="Built-in Cloud ASR"
            title="Keyless cloud transcription (word timings estimated)"
          />
          <ProviderButton
            active={ai.sttProvider === "groq"}
            onClick={() => update({ sttProvider: "groq" })}
            icon={<Mic size={12} />}
            label="Groq Whisper"
            title="Whisper with REAL per-word timestamps — needs the Groq key (best for word-to-word dub timing)"
          />
        </div>
        {ai.sttProvider === "groq" && (
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
                No Groq key saved — transcription falls back to the built-in cloud ASR.
              </span>
            )}
          </div>
        )}
        {ai.sttProvider === "builtin" && (
          <p className="text-[10px] leading-relaxed text-stone-500">
            Keyless cloud ASR with silence-based utterance windows — word timings are estimated
            inside each line.
          </p>
        )}
      </div>

      {/* ── Dubbing script writing ───────────────────────────────────── */}
      <div className="rounded-lg border p-2.5" style={INNER}>
        <CardTitle
          icon={<Languages size={12} />}
          title="Dubbing script writing"
          sub="Dub stage 2"
        />
        <div className="mb-2 grid grid-cols-3 gap-1" role="group" aria-label="Script writing provider">
          <ProviderButton
            active={ai.dubTextProvider === "builtin"}
            onClick={() => update({ dubTextProvider: "builtin" })}
            icon={<Sparkles size={12} />}
            label="Built-in Cloud AI"
            title="Keyless cloud model (GLM) — speaker detection + translation"
          />
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
          {ai.dubTextProvider === "builtin" && (
            <ModelSelect
              label="Cloud model"
              value={ai.dubBuiltinModel}
              catalog={BUILTIN_TEXT_MODELS}
              onChange={(id) => update({ dubBuiltinModel: id })}
              ariaLabel="Built-in script model"
            />
          )}
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
                No Groq key — the script falls back to the built-in cloud model.
              </span>
            ))}
          {ai.dubTextProvider === "gemini" &&
            (geminiReady ? (
              <span className="flex items-center gap-1 pb-1.5 text-[10px] font-medium text-emerald-300">
                <Check size={10} /> Gemini key ready
              </span>
            ) : (
              <span className="pb-1.5 text-[10px] text-orange-400/90">
                No Gemini key — the script falls back to the built-in cloud model.
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
