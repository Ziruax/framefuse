/**
 * SERVER-ONLY lazy singleton for the z-ai-web-dev-sdk (LLM + ASR).
 *
 * The SDK is imported dynamically INSIDE this module so it stays out of any
 * client bundle; the instance is created once and reused. If creation or a
 * request fails the singleton resets so the next call can retry.
 */

import fs from "node:fs";

// Minimal structural types for the SDK surfaces we use (the SDK itself
// returns `any` for these endpoints).
interface ZaiChatCompletion {
  choices?: { message?: { content?: string } }[];
}

interface ZaiAsrResult {
  text?: string;
}

interface ZaiInstance {
  chat: {
    completions: {
      create(body: {
        messages: { role: "system" | "user" | "assistant"; content: string }[];
        thinking?: { type: "enabled" | "disabled" };
        [key: string]: unknown;
      }): Promise<ZaiChatCompletion>;
    };
  };
  audio: {
    asr: {
      create(body: { file_base64?: string; [key: string]: unknown }): Promise<ZaiAsrResult>;
    };
  };
}

type ZaiCtor = { create(): Promise<ZaiInstance> };

let zaiPromise: Promise<ZaiInstance> | null = null;

/** Get (or lazily create) the shared z-ai client instance. */
export async function getZai(): Promise<ZaiInstance> {
  if (!zaiPromise) {
    zaiPromise = (async () => {
      const mod = (await import("z-ai-web-dev-sdk")) as { default: ZaiCtor };
      const ZAI = mod.default;
      if (!ZAI || typeof ZAI.create !== "function") {
        throw new Error("z-ai-web-dev-sdk did not load correctly");
      }
      return await ZAI.create();
    })();
    // Reset on failure so the next request can retry cleanly.
    zaiPromise.catch(() => {
      zaiPromise = null;
    });
  }
  return zaiPromise;
}

/**
 * One chat completion (thinking disabled) → assistant text.
 * `system` is delivered with the sandbox-verified role layout.
 * Retries once on transient 429 rate limits.
 */
export async function zaiChatText(
  system: string,
  user: string,
  opts?: { maxTokens?: number },
): Promise<string> {
  const zai = await getZai();
  const body = {
    messages: [
      { role: "assistant" as const, content: system },
      { role: "user" as const, content: user },
    ],
    thinking: { type: "disabled" as const },
    ...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {}),
  };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const completion = await zai.chat.completions.create(body);
      const text = completion.choices?.[0]?.message?.content;
      return typeof text === "string" ? text : "";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const rateLimited = /429|Too many requests/i.test(msg);
      if (rateLimited && attempt === 1) {
        await new Promise((res) => setTimeout(res, 1500));
        continue;
      }
      throw err;
    }
  }
  return "";
}

/** Transcribe one WAV/WebM file (absolute path) via z-ai ASR → text.
 *  Retries once on transient 429 rate limits. */
export async function zaiAsrFile(absPath: string): Promise<string> {
  const zai = await getZai();
  const b64 = fs.readFileSync(absPath).toString("base64");
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await zai.audio.asr.create({ file_base64: b64 });
      return typeof result.text === "string" ? result.text : "";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const rateLimited = /429|Too many requests/i.test(msg);
      if (rateLimited && attempt === 1) {
        await new Promise((res) => setTimeout(res, 1500));
        continue;
      }
      throw err;
    }
  }
  return "";
}
