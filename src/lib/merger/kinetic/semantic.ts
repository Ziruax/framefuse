// src/lib/merger/kinetic/semantic.ts — semantic word classification (§6) +
// phrase grouping (§22). The engine understands WHICH words deserve visual
// treatment and HOW words group into semantic phrases — never mechanical
// random emphasis, never awkward mid-word splits.
//
// Pure deterministic TS. Zero imports.

// ── Word-class lexicons (curated for storytelling narration) ───────────────

const STOP_WORDS = new Set([
  "i", "me", "my", "mine", "we", "us", "our", "you", "your", "he", "him",
  "his", "she", "her", "it", "its", "they", "them", "their", "this", "that",
  "these", "those", "the", "a", "an", "and", "or", "so", "of", "to", "in",
  "into", "on", "at", "by", "for", "with", "from", "as", "is", "am", "are",
  "was", "were", "be", "been", "being", "do", "does", "did", "have", "has",
  "had", "will", "would", "shall", "should", "may", "might", "must", "just",
  "very", "really", "there", "here", "up", "down", "out", "about",
]);

/** Emotional vocabulary — weight 4. */
const EMOTIONAL_WORDS = new Set([
  "love", "loved", "hate", "hated", "afraid", "scared", "terrified",
  "frightened", "happy", "sad", "sadder", "cried", "crying", "tears", "tear",
  "heart", "broken", "broke", "alone", "lonely", "hope", "hoped", "dream",
  "dreamed", "miss", "missed", "missed", "wish", "wished", "regret",
  "regretted", "forgive", "forgave", "forgiveness", "grief", "grieved",
  "pain", "painful", "hurt", "hurt", "joy", "joyful", "smile", "smiled",
  "laughed", "laughing", "soul", "spirit", "warm", "cold", "empty", "lost",
  "found", "peace", "calm", "panic", "anxious", "worried", "dread",
]);

/** Revelation / narrative-turn vocabulary — weight 5. */
const REVELATION_WORDS = new Set([
  "realized", "realised", "discovered", "discovery", "found", "truth",
  "secret", "secrets", "suddenly", "finally", "revealed", "learned",
  "understood", "understand", "shocked", "shocking", "unbelievable",
  "never", "always", "forever", "everything", "nothing", "change",
  "changed", "moment", "instant", "second", "minute", "day", "night",
  "years", "year", "weeks", "months", "times", "last", "first", "only",
]);

/** Negations carry outsized narrative meaning — weight 3.5. */
const NEGATIONS = new Set([
  "never", "not", "no", "nothing", "nobody", "none", "never", "cannot",
  "can't", "cant", "won't", "wont", "didn't", "didnt", "wasn't", "wasnt",
  "isn't", "isnt", "aren't", "arent", "don't", "dont", "doesn't",
  "doesnt", "couldn't", "couldnt", "wouldn't", "wouldnt", "without",
]);

/** Conflict / accusation vocabulary — weight 4. */
const CONFLICT_WORDS = new Set([
  "lied", "lying", "lie", "liar", "betrayed", "betrayal", "cheated",
  "cheating", "stole", "stolen", "steal", "blamed", "blame", "fought",
  "fight", "fighting", "argument", "argued", "screamed", "screaming",
  "yelled", "yelling", "shouted", "shouting", "left", "abandoned",
  "abandon", "ignored", "ignore", "hated", "enemy", "war", "attacked",
  "attack", "accused", "accuse", "threat", "threatened", "toxic",
]);

/** Suspense / setup vocabulary — weight 3. */
const SUSPENSE_WORDS = new Set([
  "until", "then", "something", "someone", "somebody", "strange", "odd",
  "weird", "quiet", "silence", "silent", "waiting", "waited", "watched",
  "watching", "noticed", "notice", "began", "started", "start", "one",
  "night", "morning", "evening", "later", "after", "before", "behind",
  "hidden", "hiding", "secret", "unknown", "question", "wondered",
  "wonder", "curious", "stranger", "knock", "phone", "message", "letter",
]);

const NUMBER_WORDS = new Set([
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty",
  "fifty", "hundred", "thousand", "million", "once", "twice",
]);

/** Words that START a new semantic group (break before these). */
const PHRASE_BREAKERS = new Set([
  "but", "and", "so", "because", "until", "when", "while", "then",
  "however", "although", "though", "after", "before", "if", "since",
  "that's", "there", "meanwhile", "suddenly", "finally", "instead",
]);

// ── Per-word emphasis scoring ───────────────────────────────────────────────

export interface SemanticWordScore {
  word: string;
  score: number;
  /** true when the word carries narrative weight (content word). */
  content: boolean;
}

/**
 * Score one word for visual emphasis candidacy. Deterministic, additive:
 *   content word +2 · emotional +4 · revelation +5 · negation +3.5 ·
 *   conflict +4 · suspense +3 · number +3 · long word +1 · phrase-final +0.5
 */
export function scoreWord(rawWord: string, isPhraseFinal: boolean): SemanticWordScore {
  const word = rawWord.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
  if (!word) return { word: rawWord, score: 0, content: false };

  let score = 0;
  const isStop = STOP_WORDS.has(word);
  if (!isStop) score += 2;

  if (EMOTIONAL_WORDS.has(word)) score += 4;
  if (REVELATION_WORDS.has(word)) score += 5;
  if (NEGATIONS.has(word)) score += 3.5;
  if (CONFLICT_WORDS.has(word)) score += 4;
  if (SUSPENSE_WORDS.has(word)) score += 3;
  if (NUMBER_WORDS.has(word)) score += 3;
  if (/^\d+$/.test(word)) score += 3;
  if (word.length >= 8) score += 1;
  if (word.length >= 11) score += 1;
  if (isPhraseFinal && !isStop) score += 0.5;

  return { word: rawWord, score, content: !isStop };
}

// ── Semantic phrase grouping (§22) ──────────────────────────────────────────

export interface SemanticGroup {
  /** Indices into the source word array. */
  wordIndices: number[];
  /** Highest-scoring word index inside this group. */
  emphasisIndex: number;
  emphasisScore: number;
}

/**
 * Group word indices into semantic phrases of 2-4 words:
 *   - break BEFORE conjunction/adverbial starters (but, and then, because…)
 *   - break AFTER words ending sentences/clauses (punctuation)
 *   - keep phrases ≥2 words when possible (single-word groups only for
 *     punctuation-isolated emphasis words)
 *   - hard cap 4 words per phrase (readability), never mid-word splits
 */
export function groupPhrases(words: string[]): SemanticGroup[] {
  const n = words.length;
  if (n === 0) return [];

  const breaks = new Set<number>(); // index where a NEW phrase starts
  breaks.add(0);
  for (let i = 1; i < n; i++) {
    const prev = words[i - 1];
    const cur = words[i];
    const curKey = cur.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
    const endsClause = /[.!?,;:…]$/.test(prev);
    const isBreaker = PHRASE_BREAKERS.has(curKey);
    const bigGap = prev.length > 1 && cur.length > 1 && endsClause;
    if (isBreaker || endsClause || bigGap) breaks.add(i);
  }

  // Greedy assembly honoring break boundaries + size caps.
  const groups: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i < n; i++) {
    const startNew = breaks.has(i) && cur.length > 0;
    const tooBig = cur.length >= 4;
    if (startNew || tooBig) {
      if (cur.length) groups.push(cur);
      cur = [];
    }
    cur.push(i);
  }
  if (cur.length) groups.push(cur);

  // Merge dangling single-word groups into neighbors when not isolated.
  const merged: number[][] = [];
  for (const g of groups) {
    if (g.length === 1 && merged.length > 0) {
      const prev = merged[merged.length - 1];
      if (prev.length < 4) {
        prev.push(g[0]);
        continue;
      }
    }
    merged.push(g);
  }

  // Score each group → find its emphasis word.
  return merged.map((wordIndices) => {
    let emphasisIndex = wordIndices[0];
    let emphasisScore = -1;
    for (const wi of wordIndices) {
      const s = scoreWord(words[wi], wi === wordIndices[wordIndices.length - 1]);
      if (s.score > emphasisScore) {
        emphasisScore = s.score;
        emphasisIndex = wi;
      }
    }
    return { wordIndices, emphasisIndex, emphasisScore };
  });
}

/**
 * Pick the composition's TOP emphasis word(s): the global emphasis winner
 * is the highest-scoring content word; `never` returns more than 2 so the
 * frame keeps clear hierarchy (§28 — do not over-animate).
 */
export function pickEmphasisWords(words: string[]): number[] {
  const scored = words.map((w, i) => scoreWord(w, i === words.length - 1));
  const ranked = words.map((_, i) => i).sort((a, b) => scored[b].score - scored[a].score);
  const winners: number[] = [];
  for (const idx of ranked) {
    if (scored[idx].score < 4) break; // below the semantic bar → no emphasis
    winners.push(idx);
    if (winners.length >= 2) break;
  }
  return winners;
}
