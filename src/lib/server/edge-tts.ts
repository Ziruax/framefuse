/**
 * SERVER-ONLY wrapper around the shared Edge-TTS engine (electron/edge-tts.js).
 *
 * The CJS module lives OUTSIDE the Next source tree and is loaded at RUNTIME
 * through `createRequire` — this keeps it out of the bundler graph (turbopack /
 * webpack would otherwise rewrite its `__dirname`-dependent sibling lookups)
 * and guarantees the exact same module the packaged Electron app uses.
 *
 * NEVER import this file from a client component — it talks to the network,
 * spawns nothing, but holds server-side caches and Node built-ins only.
 */

import { createRequire } from "node:module";
import path from "node:path";

// ---------------------------------------------------------------------------
// Public types (mirroring electron/edge-tts.js return shapes)
// ---------------------------------------------------------------------------

export interface TtsVoice {
  shortName: string;
  gender: "Male" | "Female";
  locale: string;
  friendlyName: string;
  displayName: string;
  localName?: string;
  styleList?: string[];
}

export interface TtsWord {
  text: string;
  offsetMs: number;
  durationMs: number;
}

export interface TtsVoicePair {
  female: string;
  male: string;
}

export interface SynthesizeOptions {
  /** 1…2800 chars (longer → use synthesizeLongText). */
  text: string;
  /** Short name, e.g. "hi-IN-SwaraNeural". */
  voice: string;
  /** Rate delta % — +10 = 10% faster. */
  ratePct?: number;
  /** Pitch delta in Hz. */
  pitchHz?: number;
  /** Volume delta in % (SSML volume). */
  volumePct?: number;
}

export interface SynthesizeResult {
  filePath: string | null;
  bytes: Buffer;
  bytesLen: number;
  words: TtsWord[];
}

export interface SynthesizeLongResult {
  bytes: Buffer;
  bytesLen: number;
  words: TtsWord[];
  chunkCount: number;
}

interface EdgeTtsCjs {
  listVoices(): Promise<TtsVoice[]>;
  voicePairsByLocale(): Record<string, TtsVoicePair>;
  synthesize(o: SynthesizeOptions): Promise<SynthesizeResult>;
  synthesizeLong(o: SynthesizeOptions): Promise<SynthesizeLongResult>;
  FALLBACK_VOICES: TtsVoice[];
}

// ---------------------------------------------------------------------------
// Runtime loading (createRequire + absolute path — bundler-opaque)
// ---------------------------------------------------------------------------

/** Project root — next dev / build always run with cwd = project root. */
function projectRoot(): string {
  const cwd = process.cwd();
  return cwd;
}

let edgeTtsModule: EdgeTtsCjs | null = null;

function loadEdgeTts(): EdgeTtsCjs {
  if (edgeTtsModule) return edgeTtsModule;
  // Base the require at the project root; the target is an ABSOLUTE path so
  // resolution works regardless of where compiled chunks live.
  const requireCjs = createRequire(path.join(projectRoot(), "index.cjs"));
  const modulePath = path.join(projectRoot(), "electron", "edge-tts.js");
  const mod = requireCjs(modulePath) as EdgeTtsCjs;
  if (!mod || typeof mod.synthesize !== "function") {
    throw new Error("Edge-TTS engine failed to load (electron/edge-tts.js)");
  }
  edgeTtsModule = mod;
  return mod;
}

// ---------------------------------------------------------------------------
// Cached catalog (in-memory, ~5 min TTL)
// ---------------------------------------------------------------------------

const VOICES_TTL_MS = 5 * 60 * 1000;
let voicesCache: { voices: TtsVoice[]; pairs: Record<string, TtsVoicePair>; at: number } | null =
  null;

export interface VoiceCatalog {
  voices: TtsVoice[];
  pairs: Record<string, TtsVoicePair>;
}

/** Fresh (≤5 min) voice catalog. `listVoices()` never rejects — the engine
 *  falls back to its built-in catalog when the service is unreachable. */
export async function getVoiceCatalog(): Promise<VoiceCatalog> {
  if (voicesCache && Date.now() - voicesCache.at < VOICES_TTL_MS) {
    return { voices: voicesCache.voices, pairs: voicesCache.pairs };
  }
  const engine = loadEdgeTts();
  const voices = await engine.listVoices();
  const pairs = engine.voicePairsByLocale();
  voicesCache = { voices, pairs, at: Date.now() };
  return { voices, pairs };
}

/** Voice list alone (cached). */
export async function listVoicesCached(): Promise<TtsVoice[]> {
  return (await getVoiceCatalog()).voices;
}

/** locale → {female, male} ShortNames (cached). */
export async function pairsCached(): Promise<Record<string, TtsVoicePair>> {
  return (await getVoiceCatalog()).pairs;
}

/** Built-in offline catalog (always available, no network). */
export function fallbackVoices(): TtsVoice[] {
  return loadEdgeTts().FALLBACK_VOICES.slice();
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

/** Single-shot synthesis (≤ 2800 chars recommended; engine hard-caps higher). */
export async function synthesize(opts: SynthesizeOptions): Promise<SynthesizeResult> {
  return loadEdgeTts().synthesize(opts);
}

/** Long-form synthesis — sentence-aware ≤2800-char chunks, one merged MP3,
 *  cumulative word offsets. Returns chunkCount ≥ 1. */
export async function synthesizeLongText(opts: SynthesizeOptions): Promise<SynthesizeLongResult> {
  return loadEdgeTts().synthesizeLong(opts);
}
