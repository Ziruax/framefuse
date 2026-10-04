/**
 * Hinglish (romanized Hindi, QWERTY) → Devanagari engine.
 *
 * Conventions follow how people actually type Hindi in Latin letters:
 * capitals select retroflex/aspirate contrasts the lowercase alphabet cannot
 * express (T→ट, Th→ठ, D→ड, Dh→ढ, N→ण, Sh→ष, Kh→ख़-ish velar fricative is
 * NOT used — kh stays क्ष-free कख family).
 */
import { scanWord, type EngineConfig } from "./engine";
import { COMMON_WORDS, type DictEntry } from "./dict";

const VIRAMA = "\u094D";

/** Longest-first vowel digraphs → independent (word-initial) forms. */
const VOWELS: Array<[string, string]> = [
  ["aa", "आ"],
  ["ai", "ऐ"],
  ["au", "औ"],
  ["ee", "ई"],
  ["ii", "ई"],
  ["oo", "ऊ"],
  ["uu", "ऊ"],
  ["ri", "ऋ"],
  ["a", "अ"],
  ["i", "इ"],
  ["u", "उ"],
  ["e", "ए"],
  ["o", "ओ"],
];

/** Vowel digraphs → matras (note: single 'a' is the inherent vowel → ""). */
const MATRAS: Array<[string, string]> = [
  ["aa", "ा"],
  ["ai", "ै"],
  ["au", "ौ"],
  ["ee", "ी"],
  ["ii", "ी"],
  ["oo", "ू"],
  ["uu", "ू"],
  ["ri", "ृ"],
  ["a", ""],
  ["i", "ि"],
  ["u", "ु"],
  ["e", "े"],
  ["o", "ो"],
];

const CONS: Array<[string, string]> = [
  ["cch", "च्छ"],
  ["ksh", "क्ष"],
  ["chh", "छ"],
  ["ch", "च"],
  ["jh", "झ"],
  ["kh", "ख"],
  ["gh", "घ"],
  ["th", "थ"],
  ["dh", "ध"],
  ["ph", "फ़"],
  ["bh", "भ"],
  ["sh", "श"],
  ["Th", "ठ"],
  ["Dh", "ढ"],
  ["Sh", "ष"],
  ["gy", "ज्ञ"],
  ["k", "क"],
  ["g", "ग"],
  ["j", "ज"],
  ["z", "ज़"],
  ["t", "त"],
  ["T", "ट"],
  ["d", "द"],
  ["D", "ड"],
  ["N", "ण"],
  ["n", "न"],
  ["p", "प"],
  ["f", "फ़"],
  ["b", "ब"],
  ["m", "म"],
  ["y", "य"],
  ["r", "र"],
  ["l", "ल"],
  ["v", "व"],
  ["w", "व"],
  ["s", "स"],
  ["h", "ह"],
  ["c", "क"],
  ["q", "क़"],
];

const CFG: EngineConfig = {
  vowels: VOWELS,
  matras: MATRAS,
  consonants: CONS,
  semiVowels: { y: "य", w: "व", v: "व", r: "र" },
  virama: VIRAMA,
  nBeforeVelar: "ं",
  finalI: "ी",
  finalU: "ू",
  semiALong: "ा",
  noViramaWhenNextConsonantHasVowel: true,
  finalA: (w, consIdx) => {
    const cons = w[consIdx];
    const before = w[consIdx - 1] ?? "";
    // -na / -nna infinitives & ना nouns: karna → करना, khana → खाना
    if (cons === "n") return "ा";
    // past-tense / e-o-i-stem + Ca: mila → मिला, bola → बोला, beta → बेटा
    if ("aeiou".includes(before)) return "ा";
    // doubled + a: pakka → पक्का
    if (before === cons) return "ा";
    // otherwise Hindi drops the final schwa: karam → करम, dharm+a → धरम
    return "";
  },
};

/** English words that pass through untouched inside Hinglish text. */
const ENGLISH_PASS = new Set([
  "the", "a", "and", "or", "but", "if", "of", "to", "in", "on", "at", "for",
  "with", "from", "by", "this", "that", "these", "those", "is", "are", "was",
  "were", "be", "been", "being", "am", "does", "did", "have", "has", "had",
  "will", "would", "can", "could", "should", "shall", "may", "might", "must",
  "not", "yes", "so", "very", "just", "only", "also", "then", "than", "when",
  "where", "why", "how", "what", "who", "whom", "which", "all", "some", "any",
  "many", "much", "more", "most", "less", "now", "here", "there", "up", "down",
  "out", "over", "under", "again", "once", "about", "against", "between",
  "through", "during", "before", "after", "above", "below", "both", "each",
  "few", "other", "such", "same", "too", "own", "my", "your", "our", "their",
  "video", "videos", "audio", "music", "youtube", "channel", "subscribe",
  "like", "share", "comment", "comments", "views", "watch", "watching", "film",
  "movie", "movies", "scene", "clip", "clips", "edit", "editing", "reel",
  "reels", "shorts", "story", "post", "upload", "download", "file", "files",
  "image", "photo", "photos", "picture", "camera", "light", "sound", "voice",
  "text", "word", "words", "page", "site", "website", "app", "phone", "mobile",
  "laptop", "computer", "internet", "online", "free", "new", "best", "top",
  "link", "click", "tag", "tags", "follow", "followers", "likes", "viral",
  "trend", "trending", "meme", "content", "creator", "brand", "product",
  "price", "buy", "sell", "order", "offer", "deal", "sale", "gift", "card",
  "money", "cash", "bank", "pay", "payment", "okay", "ok", "hello", "hi",
  "hey", "please", "thanks", "thank", "you", "wow", "nice", "super", "wow",
]);

function lookupDict(word: string): DictEntry | undefined {
  return COMMON_WORDS[word.toLowerCase()];
}

/** Transliterate one roman token; keeps English/acronyms as-is. */
export function hiWord(word: string): string {
  if (!/[A-Za-z]/.test(word)) return word;
  if (/\d/.test(word)) return word;
  if (/^[A-Z]{2,}$/.test(word)) return word; // AI, HD, NSIS …
  const d = lookupDict(word);
  if (d) return d.hi;
  if (ENGLISH_PASS.has(word.toLowerCase())) return word;
  return scanWord(word, CFG);
}

/**
 * Transliterate a whole Hinglish text to Devanagari. Two-word dictionary
 * phrases ("kya haal", "theek hai") are consumed together.
 */
export function toDevanagari(text: string): string {
  if (!text) return text;
  // v1.25.1: bracketed production markers ("[pause]", "[sfx:whoosh]",
  // "[music fades]") must stay verbatim — mask them out before tokenizing.
  const masked: string[] = [];
  const maskedText = text.replace(/\[[^\]\n]{1,60}\]/g, (m) => {
    masked.push(m);
    return `\u0000${masked.length - 1}\u0000`;
  });
  let out = transliterateUnmasked(maskedText);
  for (let i = 0; i < masked.length; i++) {
    out = out.replace(`\u0000${i}\u0000`, masked[i]);
  }
  return out;
}

function transliterateUnmasked(text: string): string {
  if (!text) return text;
  const parts = text.split(/([A-Za-z][A-Za-z']*)/); // alternating sep/word
  for (let i = 1; i < parts.length; i += 2) {
    const w = parts[i];
    const next = i + 2 < parts.length ? parts[i + 2] : undefined;
    if (next) {
      const key = `${w.toLowerCase()}_${next.toLowerCase()}`;
      const phrase = COMMON_WORDS[key];
      if (phrase) {
        parts[i] = phrase.hi;
        parts[i + 1] = ""; // swallow the separator inside the phrase
        parts[i + 2] = "";
        continue;
      }
    }
    parts[i] = hiWord(w);
  }
  return parts.join("");
}
