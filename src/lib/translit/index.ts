/**
 * QWERTY (romanized) → native-script transliteration for Hindi & Urdu.
 *
 * Users asked to write Hindi/Urdu on an English (QWERTY) keyboard — Hinglish
 * and Roman Urdu — and have the app produce the native script text that
 * Edge TTS voices (hi-IN / ur-PK) and burned-in captions actually need.
 *
 * Public API:
 *   transliterate(text, "hi" | "ur")     → native script text
 *   transliterateForLocale(text, locale) → auto-picks hi/ur by voice locale
 *   localeWantsTranslit(locale)          → does this locale want conversion?
 *   isLikelyRomanized(text)              → text looks like Latin romanization
 */
import { toDevanagari } from "./hi";
import { toUrdu } from "./ur";

export type TranslitScript = "hi" | "ur";

export function transliterate(text: string, script: TranslitScript): string {
  if (!text) return text;
  return script === "hi" ? toDevanagari(text) : toUrdu(text);
}

/** Map an Edge-TTS locale (hi-IN, ur-PK …) to a transliteration target. */
export function localeWantsTranslit(locale: string): TranslitScript | null {
  const l = (locale || "").toLowerCase();
  if (l.startsWith("hi")) return "hi";
  if (l.startsWith("ur")) return "ur";
  return null;
}

export function transliterateForLocale(text: string, locale: string): string {
  const target = localeWantsTranslit(locale);
  if (!target) return text;
  return transliterate(text, target);
}

const DEVA_RE = /[\u0900-\u097F]/;
const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F]/;
const LATIN_RE = /[A-Za-z]/;

/**
 * Heuristic: text is "romanized" when it has Latin letters and essentially
 * no Devanagari/Arabic-script characters (mixed text already contains the
 * native script, so conversion is not wanted).
 */
export function isLikelyRomanized(text: string): boolean {
  if (!text) return false;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (latin < 3) return false;
  const native = (text.match(/[\u0900-\u097F\u0600-\u06FF\u0750-\u077F]/g) ?? []).length;
  return native === 0;
}

/** Suggest a target script from the dominant content of the text. */
export function detectScript(text: string): TranslitScript | null {
  if (!text) return null;
  const deva = (text.match(/[\u0900-\u097F]/g) ?? []).length;
  const arabic = (text.match(/[\u0600-\u06FF\u0750-\u077F]/g) ?? []).length;
  if (deva === 0 && arabic === 0) return null;
  return arabic > deva ? "ur" : "hi";
}

export { toDevanagari, toUrdu };
