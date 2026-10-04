"use client";

// v1.25 — shared Edge-TTS voice-catalog hook, extracted from
// SettingsPanel.tsx so the TTS Studio, Voiceover and Dub sections can share
// ONE lazy loader without importing the whole panel. Behavior is identical
// to the previous in-file hook (same fetch, same cancellation guard, same
// return shape); only the optional `styleList` passthrough was typed in
// (the main-process catalog already sends it — the free endpoint ships none).

import { useEffect, useState } from "react";

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
 *  main process caches too — repeated calls are cheap). */
export function useTtsVoices() {
  const [voices, setVoices] = useState<TtsVoice[] | null>(null);
  const [pairs, setPairs] = useState<
    Record<string, { female: string; male: string }>
  >({});
  useEffect(() => {
    const get = window.electronAPI?.ttsVoices;
    if (typeof get !== "function") return;
    let cancelled = false;
    get()
      .then((r) => {
        if (cancelled || !r) return;
        setVoices(r.voices ?? []);
        setPairs(r.pairs ?? {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return { voices, pairs };
}
