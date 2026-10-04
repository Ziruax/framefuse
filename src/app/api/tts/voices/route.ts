import { NextRequest, NextResponse } from "next/server";

import { getVoiceCatalog } from "@/lib/server/edge-tts";
import type { TtsVoice, TtsVoicePair } from "@/lib/server/edge-tts";
import { DUB_LANG_NAMES } from "@/lib/server/dub-langs";

export const runtime = "nodejs";

interface LanguageEntry {
  code: string;
  name: string;
  locales: string[];
}

/** Human-readable English name for a 2-3 letter language code. */
function languageName(code: string): string {
  const known = DUB_LANG_NAMES[code];
  if (known) return known;
  try {
    // Node ships full ICU — Intl.DisplayNames gives e.g. "Hausa" for "ha".
    const dn = new Intl.DisplayNames(["en"], { type: "language" });
    const name = dn.of(code);
    if (name && name !== code) return name;
  } catch {
    // Intl unavailable → fall through to the raw code
  }
  return code;
}

/** Group catalog voices by language part of the locale (before "-"). */
function groupLanguages(voices: TtsVoice[]): LanguageEntry[] {
  const byLang = new Map<string, Set<string>>();
  for (const v of voices) {
    const code = (v.locale || "").split("-")[0].toLowerCase();
    if (!code) continue;
    let locales = byLang.get(code);
    if (!locales) {
      locales = new Set<string>();
      byLang.set(code, locales);
    }
    if (v.locale) locales.add(v.locale);
  }
  const entries: LanguageEntry[] = [];
  for (const [code, locales] of byLang) {
    entries.push({
      code,
      name: languageName(code),
      locales: Array.from(locales).sort(),
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code));
  return entries;
}

export async function GET(_req: NextRequest) {
  try {
    const { voices, pairs }: { voices: TtsVoice[]; pairs: Record<string, TtsVoicePair> } =
      await getVoiceCatalog();
    const languages = groupLanguages(voices);
    return NextResponse.json({ ok: true, voices, pairs, languages });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load the voice catalog";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
