/**
 * Shared rule-scanner for romanized → native-script transliteration.
 * Used by both the Devanagari (Hinglish) and Urdu (Roman Urdu) engines.
 *
 * Design notes (why the rules look the way they do):
 * - Roman typers type ONE 'a' for both inherent-a and long ā, so the scanner
 *   consumes explicit vowels as matras and applies script-specific "final a"
 *   heuristics (drop schwa vs lengthen) at word end.
 * - Hindi clusters (py → प्य, sw → स्व, kr → क्र) emit an explicit virama;
 *   Urdu never needs one (پیار = پ + ی + ا + ر), so its virama is "".
 * - A consonant directly followed by another consonant that still has a vowel
 *   after it gets NO virama in Hindi ("karna" → करना, not कर्ना); a consonant
 *   whose follower has no vowel gets the virama ("karm" → कर्म).
 */

export interface EngineConfig {
  /** roman vowel digraph → word-initial independent form (longest first) */
  vowels: Array<[string, string]>;
  /** roman vowel digraph → post-consonant matra (longest first) */
  matras: Array<[string, string]>;
  /** roman consonant/digraph → native consonant (longest first) */
  consonants: Array<[string, string]>;
  /** semi-vowels that form clusters when they directly follow a consonant */
  semiVowels: Record<string, string>;
  /** "" for Urdu (no virama), "\u094D" for Devanagari */
  virama: string;
  /** output for n before k/g (Devanagari anusvara ं; Urdu keeps ن so undefined) */
  nBeforeVelar?: string;
  /** word-final single 'a' resolution: returns the matra suffix to append */
  finalA: (word: string, consIdx: number) => string;
  /** word-final i / u overrides (Devanagari lengthens: ि→ी, ु→ू) */
  finalI: string;
  finalU: string;
  /** long form of 'a' inside a consonant+semi-vowel cluster (kya → क्या) */
  semiALong: string;
  /** when true: C + C + V does NOT insert a virama after the first C */
  noViramaWhenNextConsonantHasVowel: boolean;
}

const VOWEL_START = /^[aeiouAEIOU]/;

function matchToken(
  s: string,
  i: number,
  tokens: Array<[string, string]>,
): { out: string; len: number; roman: string } | null {
  for (const [roman, out] of tokens) {
    if (s.startsWith(roman, i)) return { out, len: roman.length, roman };
  }
  return null;
}

function matchTokenAt(
  s: string,
  tokens: Array<[string, string]>,
): { out: string; len: number; roman: string } | null {
  for (const [roman, out] of tokens) {
    if (s.startsWith(roman)) return { out, len: roman.length, roman };
  }
  return null;
}

/** Scan one romanized word with the given engine tables. */
export function scanWord(word: string, cfg: EngineConfig): string {
  const w = word.replace(/'/g, "");
  if (!w) return "";
  let out = "";
  let i = 0;

  while (i < w.length) {
    // n directly before a velar → anusvara (Hindi only), unless doubled nn
    if (
      cfg.nBeforeVelar &&
      w[i] === "n" &&
      w[i - 1] !== "n" &&
      i + 1 < w.length &&
      /^[kg]h?/.test(w.slice(i + 1))
    ) {
      out += cfg.nBeforeVelar;
      i++;
      continue;
    }

    const cons = matchToken(w, i, cfg.consonants);
    if (cons) {
      const rest = w.slice(i + cons.len);
      const consIdx = i + cons.len - 1; // index of the consonant's last roman char

      // doubled consonant (kk, tt, nn, pp …): emit the cluster start; the twin
      // is processed next iteration together with its own vowel.
      //   Hindi: kk → क् + क (conjunct), nn → न + न (नन, no virama)
      //   Urdu : kk → ک + ّ (shadda) + ک
      if (cons.len === 1 && rest.length > 0 && rest[0] === cons.roman[0]) {
        if (cfg.virama) {
          out += cons.out + (w[i] === "n" ? "" : cfg.virama);
        } else {
          out += cons.out + "\u0651"; // shadda
        }
        i += cons.len;
        continue;
      }

      // cluster: C + semi-vowel + vowel  (pya, swa, kra, vya …)
      if (
        rest.length >= 2 &&
        cfg.semiVowels[rest[0]] !== undefined &&
        VOWEL_START.test(rest[1])
      ) {
        const semiOut = cfg.semiVowels[rest[0]];
        const v = matchTokenAt(rest.slice(1), cfg.matras) ?? matchTokenAt(rest.slice(1), cfg.vowels);
        let matra = v ? v.out : "";
        if (v && v.roman === "a") matra = cfg.semiALong;
        out += cons.out + cfg.virama + semiOut + matra;
        i += cons.len + 1 + (v ? v.len : 1);
        continue;
      }

      // consonant + vowel → matra
      if (rest.length >= 1 && VOWEL_START.test(rest[0])) {
        const v = matchTokenAt(rest, cfg.matras) ?? matchTokenAt(rest, cfg.vowels);
        const vlen = v ? v.len : 1;
        const isFinalVowel = vlen >= rest.length;
        let matra = v ? v.out : "";
        if (isFinalVowel && v) {
          if (v.roman === "a") matra = cfg.finalA(w, consIdx);
          else if (v.roman === "i") matra = cfg.finalI || matra;
          else if (v.roman === "u") matra = cfg.finalU || matra;
        }
        out += cons.out + matra;
        i += cons.len + vlen;
        continue;
      }

      // consonant at word end → bare
      if (rest.length === 0) {
        out += cons.out;
        i += cons.len;
        continue;
      }

      // next is a consonant: does IT still get a vowel? ("karma" vs "karm")
      const nextCons = matchTokenAt(rest, cfg.consonants);
      const afterNext = nextCons ? rest.slice(nextCons.len) : "";
      const nextHasVowel = afterNext.length > 0 && VOWEL_START.test(afterNext[0]);
      const insertVirama = !(cfg.noViramaWhenNextConsonantHasVowel && nextHasVowel);
      out += cons.out + (insertVirama ? cfg.virama : "");
      i += cons.len;
      continue;
    }

    // vowel (word-initial or stray) → independent form
    const v = matchToken(w, i, cfg.vowels);
    if (v) {
      out += v.out;
      i += v.len;
      continue;
    }
    // unknown character — drop
    i++;
  }
  return out;
}

export const isVowelStart = VOWEL_START;
export { matchToken, matchTokenAt };
