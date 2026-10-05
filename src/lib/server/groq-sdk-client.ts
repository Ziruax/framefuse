/**
 * SERVER-ONLY Groq SDK client (v1.33, user brief Part 2).
 *
 * The official `groq-sdk` is the request engine for every web-route Groq
 * call (key test probe, chat, Dub Studio transcription). The desktop app
 * uses the same SDK through electron/groq-fetch-adapter.js (which rides
 * Chromium's net stack); the web dev-server routes use the default fetch
 * here. Keys NEVER reach the renderer or a NEXT_PUBLIC_ variable — they
 * arrive per-request from the Settings panel or fall back to the
 * server-side GROQ_API_KEY environment variable.
 *
 * Also hosts the shared AudioJobError shape (user brief Part 5) and the
 * magic-byte audio validation bridge into electron/audio-format.js (the
 * exact same module the packaged app uses — one implementation, both
 * runtimes).
 */
import { createRequire } from "node:module";
import path from "node:path";
import Groq from "groq-sdk";

export interface AudioJobError {
  service: "edge-tts" | "groq";
  code: string;
  message: string;
  retryable: boolean;
}

/** Typed facts extracted from a groq-sdk error — feeds the same
 *  classification logic the raw implementation used (status + body text). */
export interface SdkErrorFacts {
  status: number;
  bodyText: string;
  apiMessage: string;
  errType: string;
  isJson: boolean;
}

/** One shared client per (key, timeout) (dev-server routes are
 *  single-process). v1.33.1: the timeout is part of the cache key — the
 *  v1.33 (key)-only cache handed the key-test's 120 s client to callers
 *  that asked for a LONGER transcription budget, and the groq-sdk merges
 *  per-request timeouts as `options.timeout ?? this.timeout`, so a cached
 *  short client silently capped every real transcription. */
const clientCache = new Map<string, Groq>();

export function groqClient(apiKey: string, timeoutMs = 120_000): Groq {
  const key = apiKey.trim();
  const cacheKey = `${key}|${timeoutMs}`;
  const cached = clientCache.get(cacheKey);
  if (cached) return cached;
  const client = new Groq({
    apiKey: key,
    timeout: timeoutMs,
    maxRetries: 0, // route handlers own retry/classification policy
  });
  clientCache.set(cacheKey, client);
  return client;
}

/** v1.33.1: true when the groq-sdk error is the SDK's own request timeout
 *  (APIConnectionTimeoutError / "Request timed out.") — NOT a connectivity
 *  verdict. Blaming the network for the app's own request cap is exactly
 *  the "test green, captions fail" confusion this release fixes. */
export function isSdkTimeoutError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { constructor?: { name?: string }; message?: string; cause?: { message?: string } | Error };
  const name = err.constructor?.name;
  if (name === "APIConnectionTimeoutError") return true;
  if (name === "APIUserAbortError") return false;
  if (err.message && /timed? ?out/i.test(err.message)) return true;
  const causeMsg =
    err.cause instanceof Error ? err.cause.message : typeof err.cause?.message === "string" ? err.cause.message : "";
  return !!causeMsg && /timed? ?out|ETIMEDOUT/i.test(causeMsg);
}

/** Request key → saved key → GROQ_API_KEY env (never NEXT_PUBLIC_). */
export function resolveGroqKey(bodyKey: string | undefined): string {
  const fromBody = typeof bodyKey === "string" ? bodyKey.trim() : "";
  if (fromBody) return fromBody;
  const fromEnv = typeof process.env.GROQ_API_KEY === "string" ? process.env.GROQ_API_KEY.trim() : "";
  return fromEnv;
}

/** Extract classification facts from a groq-sdk error (APIError family). */
export function sdkErrorFacts(e: unknown): SdkErrorFacts {
  const err = e as { status?: number; error?: unknown; message?: string };
  const status = typeof err?.status === "number" ? err.status : 0;
  const bodyText = err?.error !== undefined ? safeStringify(err.error) : "";
  let apiMessage = "";
  let errType = "";
  let isJson = false;
  try {
    const j = JSON.parse(bodyText) as {
      error?: { message?: string; type?: string; code?: string };
      message?: string;
    };
    apiMessage = j.error?.message ?? j.message ?? "";
    errType = j.error?.type ?? j.error?.code ?? "";
    isJson = true;
  } catch {
    /* non-JSON body */
  }
  return { status, bodyText, apiMessage, errType, isJson };
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

/** Build the structured AudioJobError for a classified Groq failure. */
export function groqJobError(status: number, bodyText: string, genuine: boolean, message: string): AudioJobError {
  let code = "GROQ_REQUEST_FAILED";
  if (!status) code = "GROQ_CONNECTION";
  else if (status === 404) code = genuine ? "GROQ_MODEL_NOT_FOUND" : "GROQ_INTERCEPTED_404";
  else if (status === 401) code = genuine ? "GROQ_KEY_REJECTED" : "GROQ_BLOCKED_BEFORE_PROVIDER";
  else if (status === 403) {
    if (genuine) code = "GROQ_PERMISSION";
    else code = bodyText ? "GROQ_EDGE_BLOCK" : "GROQ_BLOCKED_BEFORE_PROVIDER";
  } else if (status === 413) code = "GROQ_FILE_TOO_LARGE";
  else if (status === 429) code = "GROQ_RATE_LIMIT";
  else if (status >= 500) code = "GROQ_SERVER_ERROR";
  else if (status === 400) code = "GROQ_BAD_REQUEST";
  return {
    service: "groq",
    code,
    message,
    retryable: status === 429 || status >= 500 || !status,
  };
}

// ---------------------------------------------------------------------------
// Magic-byte audio validation — the SAME implementation the packaged app
// runs (electron/audio-format.js), loaded bundler-opaque via createRequire
// (the pattern src/lib/server/edge-tts.ts established).
// ---------------------------------------------------------------------------

interface AudioFormatModule {
  validateAudioFile(
    filePath: string,
    opts?: { maxBytes?: number; supported?: string[] },
  ): { ok: boolean; code?: string; message?: string; format?: string; size?: number };
  sniffAudioFormat(buf: Buffer): string;
  isMp3Buffer(buf: Buffer): boolean;
}

let audioFormatModule: AudioFormatModule | null = null;

function loadAudioFormat(): AudioFormatModule {
  if (audioFormatModule) return audioFormatModule;
  const requireCjs = createRequire(path.join(process.cwd(), "index.cjs"));
  const modulePath = path.join(process.cwd(), "electron", "audio-format.js");
  const mod = requireCjs(modulePath) as AudioFormatModule;
  if (!mod || typeof mod.validateAudioFile !== "function") {
    throw new Error("Audio format module failed to load (electron/audio-format.js)");
  }
  audioFormatModule = mod;
  return mod;
}

/** Validate an audio file before any Groq upload (exists / non-empty /
 *  real container by magic bytes / size cap). Never throws. */
export function validateAudioFileServer(
  filePath: string,
  opts?: { maxBytes?: number; supported?: string[] },
): { ok: boolean; code?: string; message?: string; format?: string; size?: number } {
  try {
    return loadAudioFormat().validateAudioFile(filePath, opts);
  } catch {
    // Module unavailable (packaged edge cases) → do not block the request.
    return { ok: true };
  }
}

export function isMp3BufferServer(buf: Buffer): boolean {
  try {
    return loadAudioFormat().isMp3Buffer(buf);
  } catch {
    return true; // do not block on module-load failure
  }
}
