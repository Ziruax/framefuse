/**
 * SERVER-ONLY language metadata for the dubbing pipeline.
 *
 * DUB_LANG_NAMES is the ISO-639-1 → English name map the Electron dub UI
 * uses (copied verbatim from electron/dub-workflow.js LANG_NAMES) so the web
 * routes return identical labels to the packaged app.
 */

export const DUB_LANG_NAMES: Record<string, string> = {
  hi: "Hindi", en: "English", ur: "Urdu", ar: "Arabic", bn: "Bengali",
  ta: "Tamil", te: "Telugu", mr: "Marathi", es: "Spanish", fr: "French",
  de: "German", pt: "Portuguese", ru: "Russian", zh: "Chinese", ja: "Japanese",
  ko: "Korean", id: "Indonesian", tr: "Turkish", vi: "Vietnamese", th: "Thai",
  nl: "Dutch", pl: "Polish", it: "Italian", fa: "Persian", sw: "Swahili",
  pa: "Punjabi", gu: "Gujarati", kn: "Kannada", ml: "Malayalam", uk: "Ukrainian",
  // Extras beyond the required list.
  cs: "Czech", sv: "Swedish", da: "Danish", no: "Norwegian", fi: "Finnish",
  el: "Greek", he: "Hebrew", hu: "Hungarian", ro: "Romanian", ms: "Malay",
  ne: "Nepali", si: "Sinhala", af: "Afrikaans", bg: "Bulgarian", sk: "Slovak",
};

/** English display name for an ISO code ("hi" → "Hindi"); falls back to the
 *  code itself when unknown. */
export function dubLangName(code: string): string {
  const c = String(code || "").toLowerCase().trim();
  return DUB_LANG_NAMES[c] || c;
}

/** Writing-system hint used in translation prompts (native-script guidance). */
export const DUB_SCRIPT_HINTS: Record<string, string> = {
  hi: "written in the Devanagari script",
  ur: "written in the Urdu (Nastaliq) script",
  ar: "written in the Arabic script",
  fa: "written in the Persian script",
  bn: "written in the Bengali script",
  ta: "written in the Tamil script",
  te: "written in the Telugu script",
  mr: "written in the Devanagari script",
  gu: "written in the Gujarati script",
  kn: "written in the Kannada script",
  ml: "written in the Malayalam script",
  pa: "written in the Gurmukhi script",
  ne: "written in the Devanagari script",
  si: "written in the Sinhala script",
  zh: "written in Simplified Chinese characters",
  ja: "written in Japanese (kanji/kana)",
  ko: "written in Hangul",
  ru: "written in the Cyrillic script",
  uk: "written in the Cyrillic script",
  th: "written in the Thai script",
  he: "written in the Hebrew script",
  el: "written in the Greek script",
  ka: "written in the Georgian script",
  am: "written in the Ethiopic script",
};

/** Script guidance sentence for a language code ("hi" → "…Devanagari…"). */
export function dubScriptHint(code: string): string {
  const c = String(code || "").toLowerCase().trim();
  return DUB_SCRIPT_HINTS[c] || "written in its standard native script";
}

/** Prefer a female/male ShortName for a locale using the engine's pairs
 *  map; falls back to null when the locale has no pair. */
export function dubLocaleForLang(
  lang: string,
  pairs: Record<string, { female: string; male: string }>,
): string | null {
  const l = String(lang || "").toLowerCase().trim();
  if (!l) return null;
  if (pairs[l]) return l;
  const hit = Object.keys(pairs).find((locale) => locale.toLowerCase().startsWith(`${l}-`));
  return hit || null;
}
