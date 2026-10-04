"use client";

// v1.25 — shared Edge-TTS voice-catalog hook, extracted from
// SettingsPanel.tsx so the TTS Studio, Voiceover and Dub sections can share
// ONE lazy loader without importing the whole panel.
//
// v1.26 — the loader now goes through src/lib/speech-api.ts (IPC-first,
// /api/tts/voices fallback), so the catalog ALSO loads in the web preview
// (previously the pickers were empty outside the desktop app — that was the
// "can't select language / voices" complaint). It also exposes the grouped
// language list used by the TTS tab's language picker.

import { useEffect, useState } from "react";
import {
  fetchTtsVoices,
  type SpeechLanguage,
  type SpeechVoice,
} from "@/lib/speech-api";

/** One Edge-TTS catalog voice (the subset the pickers render). */
export interface TtsVoice {
  shortName: string;
  gender: string;
  locale: string;
  friendlyName: string;
  displayName: string;
  /** v1.25: advertised express-as styles (rare on the free endpoint). */
  styleList?: string[];
}

/** Shared lazy voice-catalog loader (one fetch per mounted section; the
 *  main process AND the API route both cache — repeated calls are cheap). */
export function useTtsVoices() {
  const [voices, setVoices] = useState<TtsVoice[] | null>(null);
  const [pairs, setPairs] = useState<
    Record<string, { female: string; male: string }>
  >({});
  const [languages, setLanguages] = useState<SpeechLanguage[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchTtsVoices()
      .then((r) => {
        if (cancelled || !r) return;
        setVoices(r.voices ?? []);
        setPairs(r.pairs ?? {});
        setLanguages(r.languages ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return { voices, pairs, languages };
}
