/**
 * Roman Urdu (QWERTY) → Urdu Nastaliq script engine.
 *
 * Urdu notes:
 * - No virama: consonant clusters are just adjacent letters (کرنا = ک ر ن ا).
 * - Short vowels a/i/u between consonants are unwritten (zer/zabar implied):
 *   "karna" → کرنا. Long ones are ا (ā), ی (ē/ī), و (ō/ū).
 * - kh/gh default to the aspirates کھ/گھ (native words); capitals Kh/Gh give
 *   the Arabic fricatives خ/غ (khabar → خبر needs the dictionary).
 * - Doubled consonants render with shadda ّ (pakka → پکّا).
 * - n before k/g stays ن (رنگی renders naturally from letters).
 */
import { scanWord, type EngineConfig } from "./engine";
import { COMMON_WORDS, type DictEntry } from "./dict";

const VOWELS: Array<[string, string]> = [
  ["aa", "آ"],
  ["ai", "اے"],
  ["au", "او"],
  ["ee", "ای"],
  ["ii", "ای"],
  ["oo", "او"],
  ["uu", "او"],
  ["a", "ا"],
  ["i", "ا"],
  ["u", "ا"],
  ["e", "ای"],
  ["o", "او"],
];

const MATRAS: Array<[string, string]> = [
  ["aa", "ا"],
  ["ai", "ی"],
  ["au", "و"],
  ["ee", "ی"],
  ["ii", "ی"],
  ["oo", "و"],
  ["uu", "و"],
  ["a", ""],
  ["i", ""],
  ["u", ""],
  ["e", "ی"],
  ["o", "و"],
];

const CONS: Array<[string, string]> = [
  ["chh", "چھ"],
  ["ch", "چ"],
  ["jh", "جھ"],
  ["kh", "کھ"],
  ["Kh", "خ"],
  ["gh", "گھ"],
  ["Gh", "غ"],
  ["th", "تھ"],
  ["Th", "ٹھ"],
  ["dh", "دھ"],
  ["Dh", "ڈھ"],
  ["ph", "پھ"],
  ["bh", "بھ"],
  ["sh", "ش"],
  ["zh", "ژ"],
  ["k", "ک"],
  ["g", "گ"],
  ["j", "ج"],
  ["z", "ز"],
  ["t", "ت"],
  ["T", "ٹ"],
  ["d", "د"],
  ["D", "ڈ"],
  ["N", "ن"],
  ["n", "ن"],
  ["p", "پ"],
  ["f", "ف"],
  ["b", "ب"],
  ["m", "م"],
  ["y", "ی"],
  ["r", "ر"],
  ["R", "ڑ"],
  ["l", "ل"],
  ["v", "و"],
  ["w", "و"],
  ["s", "س"],
  ["h", "ہ"],
  ["c", "ک"],
  ["q", "ق"],
];

const CFG: EngineConfig = {
  vowels: VOWELS,
  matras: MATRAS,
  consonants: CONS,
  semiVowels: { y: "ی", w: "و", v: "و", r: "ر" },
  virama: "",
  finalI: "ی",
  finalU: "و",
  semiALong: "ا",
  noViramaWhenNextConsonantHasVowel: true,
  finalA: (w, consIdx) => {
    const cons = w[consIdx];
    // karam → کرم, dharam → دھرم: final schwa after m is absorbed
    if (cons === "m") return "";
    // karna → کرنا, khana-type words: keep the final alif
    return "ا";
  },
};

/** English words that pass through untouched inside Roman Urdu text. */
const ENGLISH_PASS = new Set([
  "the", "a", "and", "or", "but", "if", "of", "to", "in", "on", "at", "for",
  "with", "from", "by", "this", "that", "is", "are", "was", "were", "be",
  "been", "am", "does", "did", "have", "has", "had", "will", "would", "can",
  "could", "should", "shall", "may", "might", "must", "not", "yes", "so",
  "very", "just", "only", "also", "then", "than", "when", "where", "why",
  "how", "what", "who", "which", "all", "some", "any", "many", "much", "more",
  "most", "now", "here", "there", "video", "videos", "audio", "music",
  "youtube", "channel", "subscribe", "like", "share", "comment", "comments",
  "views", "watch", "film", "movie", "movies", "scene", "clip", "clips",
  "edit", "editing", "reel", "reels", "shorts", "story", "post", "upload",
  "download", "file", "files", "image", "photo", "photos", "picture",
  "camera", "light", "sound", "voice", "text", "word", "words", "page",
  "site", "website", "app", "phone", "mobile", "laptop", "computer",
  "internet", "online", "free", "new", "best", "top", "link", "click", "tag",
  "tags", "follow", "followers", "likes", "viral", "trend", "trending",
  "meme", "content", "creator", "brand", "product", "price", "buy", "sell",
  "order", "offer", "deal", "sale", "gift", "card", "money", "cash", "bank",
  "pay", "payment", "okay", "ok", "hello", "hi", "hey", "please", "thanks",
  "thank", "you", "wow", "nice", "super",
]);

function lookupDict(word: string): DictEntry | undefined {
  return COMMON_WORDS[word.toLowerCase()];
}

/** Transliterate one roman token; keeps English/acronyms as-is. */
export function urWord(word: string): string {
  if (!/[A-Za-z]/.test(word)) return word;
  if (/\d/.test(word)) return word;
  if (/^[A-Z]{2,}$/.test(word)) return word;
  const d = lookupDict(word);
  if (d) return d.ur;
  if (ENGLISH_PASS.has(word.toLowerCase())) return word;
  return scanWord(word, CFG);
}

/** Transliterate a whole Roman Urdu text to Nastaliq script. */
export function toUrdu(text: string): string {
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
  const parts = text.split(/([A-Za-z][A-Za-z']*)/);
  for (let i = 1; i < parts.length; i += 2) {
    const w = parts[i];
    const next = i + 2 < parts.length ? parts[i + 2] : undefined;
    if (next) {
      const key = `${w.toLowerCase()}_${next.toLowerCase()}`;
      const phrase = COMMON_WORDS[key];
      if (phrase) {
        parts[i] = phrase.ur;
        parts[i + 1] = ""; // swallow the separator inside the phrase
        parts[i + 2] = "";
        continue;
      }
    }
    parts[i] = urWord(w);
  }
  return parts.join("");
}
