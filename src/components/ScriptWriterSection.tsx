"use client";

// src/components/ScriptWriterSection.tsx — v1.20 AI Script Writer.
//
// Generates narration scripts with a cloud text model. DEFAULT provider is
// Google Gemini (Gemini 3.5 Flash Lite — fastest + generous free tier); the
// model picker also offers the wider Gemini family AND the Groq chat models
// (the Groq provider reuses the key the Captions → Transcription region
// manages — there is no second Groq key UI here).
//
// The Gemini API key is the USER'S OWN and lives ONLY on this device
// (userData/gemini.json, mode 0600, main-process owned). This component only
// ever sees a MASKED form (hasKey + maskedKey) — same discipline as the Groq
// key UI in CaptionsSection, whose visuals this mirrors (the Section/Field
// helpers are local to SettingsPanel.tsx, so the card look is replicated
// with plain divs + tailwind at the exact same tokens).
//
// Everything is local state + window.electronAPI — no props, no global
// stores. User preferences (model/prompt/tone/duration/language/last script)
// persist in localStorage under "framefuse.scriptwriter.v1" (app-level, never
// inside project files).

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BadgeCheck,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  Sparkles,
  Trash2,
} from "lucide-react";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { GeminiConfigPayload, ScriptModelCatalog } from "@/lib/merger/types";

// ---------------------------------------------------------------------------
// Model vocabulary — identical to electron/gemini-chat.js (GEMINI_TEXT_MODELS)
// and electron/groq-chat.js (GROQ_TEXT_MODELS). Used as the fallback when the
// script:models IPC is unavailable (browser preview); in the desktop app the
// live catalog (with hasKey flags) replaces it.
// ---------------------------------------------------------------------------

const FALLBACK_GEMINI_MODELS = [
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
];
const FALLBACK_GROQ_MODELS = [
  { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B Versatile" },
  { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B Instant" },
  { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B" },
  { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B" },
  { id: "qwen/qwen3-32b", label: "Qwen 3 32B" },
  { id: "gemma2-9b-it", label: "Gemma 2 9B" },
];
const GEMINI_DEFAULT_MODEL = "gemini-3.5-flash-lite";
const GEMINI_KEY_URL = "https://aistudio.google.com/apikey";

/** Narration pace used for the length target AND the est-duration readout. */
const WORDS_PER_SECOND = 2.5;

const TONES = ["energetic", "professional", "cinematic", "friendly", "educational"];
const DURATIONS_SEC = [15, 30, 60, 90, 120];
const LANGUAGES = [
  "English",
  "Urdu",
  "Hindi",
  "Arabic",
  "Spanish",
  "French",
  "German",
];

// ---------------------------------------------------------------------------
// localStorage persistence (app-level preference, never in project files).
// ---------------------------------------------------------------------------

const LS_KEY = "framefuse.scriptwriter.v1";

interface ScriptWriterPrefs {
  model: string;
  prompt: string;
  tone: string;
  durationSec: number;
  language: string;
  lastScript: string;
}

function loadPrefs(): ScriptWriterPrefs {
  const fallback: ScriptWriterPrefs = {
    model: GEMINI_DEFAULT_MODEL,
    prompt: "",
    tone: "energetic",
    durationSec: 60,
    language: "English",
    lastScript: "",
  };
  try {
    if (typeof window === "undefined") return fallback;
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return fallback;
    const j = JSON.parse(raw) as Partial<ScriptWriterPrefs>;
    return {
      model: typeof j.model === "string" && j.model ? j.model : fallback.model,
      prompt: typeof j.prompt === "string" ? j.prompt : "",
      tone: typeof j.tone === "string" && TONES.includes(j.tone) ? j.tone : "energetic",
      durationSec:
        Number.isFinite(Number(j.durationSec)) && DURATIONS_SEC.includes(Number(j.durationSec))
          ? Number(j.durationSec)
          : 60,
      language:
        typeof j.language === "string" && LANGUAGES.includes(j.language)
          ? j.language
          : "English",
      lastScript: typeof j.lastScript === "string" ? j.lastScript : "",
    };
  } catch {
    return fallback;
  }
}

function savePrefs(p: ScriptWriterPrefs) {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(p));
  } catch {
    /* private mode / quota — the in-memory state still works */
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ScriptWriterSection() {
  const [open, setOpen] = useState(false);

  const [prefs, setPrefs] = useState<ScriptWriterPrefs>(() => loadPrefs());
  const [catalog, setCatalog] = useState<ScriptModelCatalog | null>(null);
  const [geminiCfg, setGeminiCfg] = useState<GeminiConfigPayload | null>(null);
  const [geminiKeyInput, setGeminiKeyInput] = useState("");
  const [geminiKeyEditing, setGeminiKeyEditing] = useState(false);
  const [geminiBusy, setGeminiBusy] = useState<"" | "save" | "test" | "clear">("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const api = typeof window !== "undefined" ? window.electronAPI : undefined;

  // Live model catalog + saved-key state (masked) once on mount.
  useEffect(() => {
    let cancelled = false;
    const getModels = api?.scriptModels;
    if (typeof getModels === "function") {
      getModels()
        .then((c) => {
          if (!cancelled && c) setCatalog(c);
        })
        .catch(() => {
          /* IPC hiccup → the fallback lists below carry the UI */
        });
    }
    const getGemini = api?.geminiGet;
    if (typeof getGemini === "function") {
      getGemini()
        .then((cfg) => {
          if (!cancelled && cfg) setGeminiCfg(cfg);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Model bookkeeping ────────────────────────────────────────────────────
  const geminiModels = useMemo(
    () => catalog?.gemini.models ?? FALLBACK_GEMINI_MODELS,
    [catalog],
  );
  const groqModels = useMemo(
    () => catalog?.groq.models ?? FALLBACK_GROQ_MODELS,
    [catalog],
  );
  const knownIds = useMemo(
    () => new Set([...geminiModels, ...groqModels].map((m) => m.id)),
    [geminiModels, groqModels],
  );
  // Normalize the persisted selection: unknown ids (or a stale one after a
  // catalog refresh) fall back to the Gemini default.
  const model = knownIds.has(prefs.model) ? prefs.model : GEMINI_DEFAULT_MODEL;
  const selectedIsGemini = geminiModels.some((m) => m.id === model);
  const provider: "gemini" | "groq" = selectedIsGemini ? "gemini" : "groq";
  const groqHasKey = catalog?.groq.hasKey ?? false;

  const updatePrefs = useCallback((patch: Partial<ScriptWriterPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      savePrefs(next);
      return next;
    });
  }, []);

  // ── Gemini key management (mirrors the Groq key UX in Captions) ──────────

  const saveGeminiKey = useCallback(async () => {
    const set = api?.geminiSet;
    const key = geminiKeyInput.trim();
    if (typeof set !== "function") return;
    if (!key) {
      toast.error("Paste an API key first", {
        description: `Create a free key at ${GEMINI_KEY_URL}.`,
      });
      return;
    }
    setGeminiBusy("save");
    try {
      const cfg = await set({ apiKey: key });
      setGeminiCfg(cfg);
      setGeminiKeyInput("");
      setGeminiKeyEditing(false);
      toast.success("Gemini API key saved on this device", {
        description: "Gemini 3.5 Flash Lite is the default script model.",
      });
    } catch (err) {
      toast.error("Could not save the key", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setGeminiBusy("");
    }
  }, [api, geminiKeyInput]);

  const testGeminiKey = useCallback(async () => {
    const test = api?.geminiTest;
    if (typeof test !== "function") return;
    setGeminiBusy("test");
    try {
      const r = await test(
        (geminiKeyEditing || !geminiCfg?.hasKey) && geminiKeyInput.trim()
          ? { apiKey: geminiKeyInput.trim() }
          : {},
      );
      if (r.ok) {
        toast.success("Gemini key works", { description: r.message });
      } else {
        toast.error("Gemini key check failed", { description: r.message });
      }
    } catch (err) {
      toast.error("Could not reach Gemini", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setGeminiBusy("");
    }
  }, [api, geminiCfg, geminiKeyEditing, geminiKeyInput]);

  const removeGeminiKey = useCallback(async () => {
    const clear = api?.geminiClear;
    if (typeof clear !== "function") return;
    setGeminiBusy("clear");
    try {
      await clear();
      setGeminiCfg({ hasKey: false, maskedKey: "" });
      setGeminiKeyEditing(false);
      setGeminiKeyInput("");
      toast.success("Gemini API key removed", {
        description: "Paste a new key here any time to write scripts again.",
      });
    } catch (err) {
      toast.error("Could not remove the key", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setGeminiBusy("");
    }
  }, [api]);

  // ── Script generation ────────────────────────────────────────────────────

  const script = prefs.lastScript;
  const scriptWords = useMemo(
    () =>
      script.trim() ? script.trim().split(/\s+/).filter(Boolean).length : 0,
    [script],
  );
  const estSec = Math.round(scriptWords / WORDS_PER_SECOND);

  const generate = useCallback(async () => {
    const gen = api?.scriptGenerate;
    const topic = prefs.prompt.trim();
    if (typeof gen !== "function") return;
    if (!topic) {
      setError("Describe the video first — the prompt is empty.");
      return;
    }
    setError("");
    setGenerating(true);
    try {
      const r = await gen({
        provider,
        model,
        prompt: topic,
        tone: prefs.tone,
        durationSec: prefs.durationSec,
        language: prefs.language,
      });
      if (r.ok) {
        updatePrefs({ lastScript: r.text });
        toast.success("Script ready", {
          description: `${r.model} · ${r.text.trim().split(/\s+/).filter(Boolean).length} words`,
        });
      } else {
        setError(r.error);
        toast.error("Script generation failed", { description: r.error });
      }
    } catch (err) {
      // Defensive: script:generate never throws user-facing failures, but a
      // dead IPC channel still lands here.
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast.error("Script generation failed", { description: msg });
    } finally {
      setGenerating(false);
    }
  }, [api, model, prefs, provider, updatePrefs]);

  const copyScript = useCallback(async () => {
    const t = script.trim();
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
      setCopied(true);
      toast.success("Script copied", {
        description: "Paste it into the Voiceover narration field.",
      });
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      toast.error("Copy failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, [script]);

  // ── Render ───────────────────────────────────────────────────────────────

  const selectCls =
    "w-full rounded border bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-200 focus:border-cyan-500 focus:outline-none";
  const canUseApi =
    typeof api?.scriptGenerate === "function" && typeof api?.geminiSet === "function";

  return (
    // Section card — the exact visual tokens of SettingsPanel's Section
    // (rounded-lg, 1px #27272a border, #131316 body, uppercase zinc-500
    // header with a rotating chevron).
    <div
      className="mx-2 mb-2 overflow-hidden rounded-lg border"
      style={{ borderColor: "#27272a", backgroundColor: "#131316" }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-none px-3 py-2.5 text-left transition-colors hover:bg-white/5"
        aria-expanded={open}
      >
        <ChevronDown
          size={14}
          className={cn(
            "shrink-0 text-zinc-500 transition-transform duration-200",
            open ? "rotate-0" : "-rotate-90",
          )}
        />
        <span className="shrink-0 text-zinc-400">
          <Sparkles size={13} />
        </span>
        <span className="flex-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          AI Script Writer
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1">
          <p className="mb-3 text-[10px] leading-relaxed text-zinc-500">
            Generate narration scripts with Gemini or Groq — then paste the
            result into the Voiceover narration field to synthesize it.
          </p>

          {/* ── Model picker (two optgroups; Gemini first, default first) ── */}
          <div className="mb-2.5">
            <label className="mb-0.5 block text-[10px] font-medium text-zinc-400">
              Model
            </label>
            <select
              value={model}
              onChange={(e) => updatePrefs({ model: e.target.value })}
              className={selectCls}
              style={{ borderColor: "#3f3f46" }}
              aria-label="Script model"
            >
              <optgroup label="Google Gemini">
                {geminiModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Groq">
                {groqModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>

          {/* ── API key state for the selected provider ── */}
          {selectedIsGemini ? (
            <div
              className="mb-2.5 rounded-lg border p-2.5"
              style={{ borderColor: "#3f3f46", backgroundColor: "#141416" }}
            >
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                  Gemini API key
                </span>
                {geminiCfg?.hasKey && (
                  <span
                    className="flex items-center gap-1 text-[10px] font-medium text-emerald-400"
                    title="Gemini key saved on this device"
                  >
                    <Check size={10} /> Key saved
                  </span>
                )}
              </div>
              {!canUseApi ? (
                <p className="text-[10px] leading-relaxed text-zinc-500">
                  AI script writing runs in the desktop app.
                </p>
              ) : geminiCfg?.hasKey && !geminiKeyEditing ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <KeyRound size={11} className="shrink-0 text-cyan-400" />
                    <span
                      className="flex-1 truncate rounded border bg-zinc-900 px-2 py-1 font-mono text-[10px] text-zinc-300"
                      style={{ borderColor: "#3f3f46" }}
                      title={geminiCfg.maskedKey}
                    >
                      {geminiCfg.maskedKey}
                    </span>
                  </div>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => void testGeminiKey()}
                      disabled={geminiBusy !== ""}
                      className="flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-medium text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                      style={{ borderColor: "#3f3f46" }}
                    >
                      {geminiBusy === "test" ? (
                        <Loader2 size={10} className="animate-spin" />
                      ) : (
                        <BadgeCheck size={10} />
                      )}
                      Test key
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setGeminiKeyEditing(true);
                        setGeminiKeyInput("");
                      }}
                      disabled={geminiBusy !== ""}
                      className="rounded border px-2 py-1 text-[10px] font-medium text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                      style={{ borderColor: "#3f3f46" }}
                    >
                      Replace
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeGeminiKey()}
                      disabled={geminiBusy !== ""}
                      className="flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-medium text-red-400/90 transition-colors hover:border-red-500/40 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                      style={{ borderColor: "#3f3f46" }}
                    >
                      {geminiBusy === "clear" ? (
                        <Loader2 size={10} className="animate-spin" />
                      ) : (
                        <Trash2 size={10} />
                      )}
                      Remove
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <input
                    type="password"
                    value={geminiKeyInput}
                    onChange={(e) => setGeminiKeyInput(e.target.value)}
                    placeholder="AIza… paste your Gemini API key"
                    spellCheck={false}
                    autoComplete="off"
                    className="w-full rounded border bg-zinc-900 px-2 py-1.5 font-mono text-[10px] text-zinc-200 placeholder:text-zinc-600 focus:border-cyan-500/60 focus:outline-none"
                    style={{ borderColor: "#3f3f46" }}
                    aria-label="Gemini API key"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void saveGeminiKey();
                      }
                    }}
                  />
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void saveGeminiKey()}
                      disabled={geminiBusy !== "" || !geminiKeyInput.trim()}
                      className="flex items-center gap-1 rounded bg-cyan-500 px-2.5 py-1 text-[10px] font-semibold text-zinc-900 transition-colors hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {geminiBusy === "save" ? (
                        <Loader2 size={10} className="animate-spin" />
                      ) : (
                        <KeyRound size={10} />
                      )}
                      Save key
                    </button>
                    <button
                      type="button"
                      onClick={() => void testGeminiKey()}
                      disabled={geminiBusy !== "" || !geminiKeyInput.trim()}
                      className="flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-medium text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                      style={{ borderColor: "#3f3f46" }}
                      title="Check the pasted key before saving"
                    >
                      {geminiBusy === "test" ? (
                        <Loader2 size={10} className="animate-spin" />
                      ) : (
                        <BadgeCheck size={10} />
                      )}
                      Test
                    </button>
                    {geminiKeyEditing && (
                      <button
                        type="button"
                        onClick={() => {
                          setGeminiKeyEditing(false);
                          setGeminiKeyInput("");
                        }}
                        className="rounded border px-2 py-1 text-[10px] font-medium text-zinc-400 transition-colors hover:bg-zinc-800"
                        style={{ borderColor: "#3f3f46" }}
                      >
                        Cancel
                      </button>
                    )}
                    <a
                      href={GEMINI_KEY_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto flex items-center gap-1 text-[10px] font-medium text-cyan-400 underline-offset-2 hover:underline"
                    >
                      Get a free key
                      <ExternalLink size={9} />
                    </a>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div
              className="mb-2.5 flex items-center justify-between gap-2 rounded border px-2.5 py-2"
              style={{ borderColor: "#3f3f46", backgroundColor: "#141416" }}
            >
              <span className="text-[10px] leading-relaxed text-zinc-500">
                Groq key is managed in Captions → Transcription.
              </span>
              {groqHasKey ? (
                <span
                  className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-emerald-400"
                  title="Groq key saved on this device"
                >
                  <Check size={10} /> Key saved
                </span>
              ) : (
                <span className="shrink-0 text-[10px] font-medium text-amber-400/90">
                  No key saved
                </span>
              )}
            </div>
          )}

          {/* ── Topic prompt ── */}
          <textarea
            value={prefs.prompt}
            onChange={(e) => updatePrefs({ prompt: e.target.value })}
            rows={3}
            placeholder="What should the video be about? e.g. 'A 60-second video about why morning sunlight improves sleep'"
            className="mb-2 w-full resize-y rounded border bg-zinc-900 px-2 py-1.5 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:border-cyan-500 focus:outline-none"
            style={{ borderColor: "#3f3f46" }}
            aria-label="Script topic prompt"
          />

          {/* ── Tone / duration / language ── */}
          <div className="mb-2.5 grid grid-cols-3 gap-1.5">
            <div>
              <label className="mb-0.5 block text-[10px] font-medium text-zinc-400">
                Tone
              </label>
              <select
                value={prefs.tone}
                onChange={(e) => updatePrefs({ tone: e.target.value })}
                className={selectCls}
                style={{ borderColor: "#3f3f46" }}
                aria-label="Script tone"
              >
                {TONES.map((t) => (
                  <option key={t} value={t}>
                    {t[0].toUpperCase() + t.slice(1)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-0.5 block text-[10px] font-medium text-zinc-400">
                Duration
              </label>
              <select
                value={prefs.durationSec}
                onChange={(e) =>
                  updatePrefs({ durationSec: Number(e.target.value) })
                }
                className={selectCls}
                style={{ borderColor: "#3f3f46" }}
                aria-label="Target script duration"
              >
                {DURATIONS_SEC.map((d) => (
                  <option key={d} value={d}>
                    {d}s
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-0.5 block text-[10px] font-medium text-zinc-400">
                Language
              </label>
              <select
                value={prefs.language}
                onChange={(e) => updatePrefs({ language: e.target.value })}
                className={selectCls}
                style={{ borderColor: "#3f3f46" }}
                aria-label="Script language"
              >
                {LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* ── Generate ── */}
          <button
            type="button"
            onClick={() => void generate()}
            disabled={generating || !canUseApi}
            className="flex w-full items-center justify-center gap-1.5 rounded bg-cyan-500 px-3 py-2 text-[11px] font-semibold text-zinc-900 transition-colors hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {generating ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Sparkles size={12} />
            )}
            {generating ? "Writing script…" : "Generate script"}
          </button>

          {error && (
            <p
              className="mt-2 rounded border px-2 py-1.5 text-[10px] leading-relaxed text-red-400"
              style={{ borderColor: "#7f1d1d", backgroundColor: "#1a0d0d" }}
              role="alert"
            >
              {error}
            </p>
          )}

          {/* ── Result (editable — tweak before copying) ── */}
          {script && (
            <div className="mt-2.5">
              <textarea
                value={script}
                onChange={(e) => updatePrefs({ lastScript: e.target.value })}
                rows={8}
                aria-label="Generated script (editable)"
                className="w-full resize-y rounded border bg-zinc-900 px-2 py-1.5 text-[11px] leading-relaxed text-zinc-200 focus:border-cyan-500 focus:outline-none"
                style={{ borderColor: "#3f3f46" }}
              />
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="text-[10px] text-zinc-500">
                  {scriptWords} words · ≈{estSec}s at{" "}
                  {WORDS_PER_SECOND} words/s
                </span>
                <button
                  type="button"
                  onClick={() => void copyScript()}
                  disabled={!script.trim()}
                  className="flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-medium text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ borderColor: "#3f3f46" }}
                >
                  {copied ? (
                    <Check size={10} className="text-emerald-400" />
                  ) : (
                    <Copy size={10} />
                  )}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          )}

          <p className="mt-2 text-[10px] leading-relaxed text-zinc-500">
            Copy the script into the Voiceover narration field to synthesize
            it.
          </p>
        </div>
      )}
    </div>
  );
}
