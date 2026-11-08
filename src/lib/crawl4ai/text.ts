/**
 * Text scoring primitives ported from Crawl4AI: clean_tokens (stop words + noise), a Porter stemmer
 * (Crawl4AI uses the Snowball English stemmer), BM25Okapi (rank_bm25 defaults k1=1.5, b=0.75,
 * epsilon=0.25) and the 1.3 tokens-per-word estimate used for LLM chunking.
 */

export const WORD_TOKEN_RATE = 1.3;
export const OVERLAP_RATE = 0.1;
export const CHUNK_TOKEN_THRESHOLD = 2048;

const NOISE = new Set(["ccp", "up", "↑", "▲", "⬆️", "a", "an", "at", "by", "in", "of", "on", "to", "the"]);
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "he", "in", "is", "it", "its", "of", "on", "that", "the", "to", "was", "were", "will", "with",
  "i", "you", "she", "we", "they", "me", "him", "her", "us", "them", "my", "your", "his", "our", "their", "mine", "yours", "hers", "ours", "theirs",
  "myself", "yourself", "himself", "herself", "itself", "ourselves", "themselves",
  "am", "been", "being", "have", "had", "having", "do", "does", "did", "doing",
  "about", "above", "across", "after", "against", "along", "among", "around", "before", "behind", "below", "beneath", "beside", "between", "beyond",
  "down", "during", "except", "inside", "into", "near", "off", "out", "outside", "over", "past", "through", "toward", "under", "underneath", "until", "upon", "within",
  "but", "or", "nor", "yet", "so", "although", "because", "since", "unless",
  "this", "these", "those", "what", "which", "who", "whom", "whose", "when", "where", "why", "how", "all", "any", "both", "each", "few", "more", "most", "other", "some", "such",
  "can", "cannot", "can't", "could", "couldn't", "may", "might", "must", "mustn't", "shall", "should", "shouldn't", "won't", "would", "wouldn't", "not", "n't", "no", "none",
]);

/** Unicode-aware word split (Latin, Devanagari and other scripts keep their combining marks). */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’]*/gu) ?? [];
}

export function cleanTokens(tokens: string[]): string[] {
  return tokens.filter((t) => [...t].length > 2 && !NOISE.has(t) && !STOP_WORDS.has(t) && !/^[↑▲⬆]/.test(t));
}

export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

export function estimateTokens(text: string): number {
  return Math.ceil(wordCount(text) * WORD_TOKEN_RATE);
}

// ---------------------------------------------------------------- Porter stemmer (ASCII words only)
const STEP2: Record<string, string> = {
  ational: "ate", tional: "tion", enci: "ence", anci: "ance", izer: "ize", bli: "ble", alli: "al", entli: "ent", eli: "e", ousli: "ous",
  ization: "ize", ation: "ate", ator: "ate", alism: "al", iveness: "ive", fulness: "ful", ousness: "ous", aliti: "al", iviti: "ive", biliti: "ble", logi: "log",
};
const STEP3: Record<string, string> = { icate: "ic", ative: "", alize: "al", iciti: "ic", ical: "ic", ful: "", ness: "" };
const cons = "[^aeiou]";
const vow = "[aeiouy]";
const CONS_SEQ = `${cons}[^aeiouy]*`;
const VOW_SEQ = `${vow}[aeiou]*`;
const MGR0 = new RegExp(`^(${CONS_SEQ})?${VOW_SEQ}${CONS_SEQ}`);
const MEQ1 = new RegExp(`^(${CONS_SEQ})?${VOW_SEQ}${CONS_SEQ}(${VOW_SEQ})?$`);
const MGR1 = new RegExp(`^(${CONS_SEQ})?${VOW_SEQ}${CONS_SEQ}${VOW_SEQ}${CONS_SEQ}`);
const S_V = new RegExp(`^(${CONS_SEQ})?${vow}`);
const CVC = new RegExp(`^${CONS_SEQ}${vow}[^aeiouwxy]$`);

const stemCache = new Map<string, string>();

export function stem(word: string): string {
  if (word.length < 3 || !/^[a-z]+$/.test(word)) return word;
  const hit = stemCache.get(word);
  if (hit) return hit;
  let w = word;
  const firstY = w[0] === "y";
  if (firstY) w = "Y" + w.slice(1);
  let m: RegExpExecArray | null;
  // Step 1a
  if ((m = /^(.+?)(ss|i)es$/.exec(w))) w = m[1]! + m[2]!;
  else if ((m = /^(.+?)([^s])s$/.exec(w))) w = m[1]! + m[2]!;
  // Step 1b
  if ((m = /^(.+?)eed$/.exec(w))) {
    if (MGR0.test(m[1]!)) w = w.slice(0, -1);
  } else if ((m = /^(.+?)(ed|ing)$/.exec(w))) {
    const s = m[1]!;
    if (S_V.test(s)) {
      w = s;
      if (/(at|bl|iz)$/.test(w)) w += "e";
      else if (/([^aeiouylsz])\1$/.test(w)) w = w.slice(0, -1);
      else if (CVC.test(w)) w += "e";
    }
  }
  // Step 1c
  if ((m = /^(.+?)y$/.exec(w)) && S_V.test(m[1]!)) w = m[1]! + "i";
  // Step 2
  if ((m = /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/.exec(w)) && MGR0.test(m[1]!)) {
    w = m[1]! + STEP2[m[2]!];
  }
  // Step 3
  if ((m = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/.exec(w)) && MGR0.test(m[1]!)) w = m[1]! + STEP3[m[2]!];
  // Step 4
  if ((m = /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/.exec(w))) {
    if (MGR1.test(m[1]!)) w = m[1]!;
  } else if ((m = /^(.+?)(s|t)(ion)$/.exec(w))) {
    const s = m[1]! + m[2]!;
    if (MGR1.test(s)) w = s;
  }
  // Step 5
  if ((m = /^(.+?)e$/.exec(w))) {
    const s = m[1]!;
    if (MGR1.test(s) || (MEQ1.test(s) && !CVC.test(s))) w = s;
  }
  if (/ll$/.test(w) && MGR1.test(w)) w = w.slice(0, -1);
  if (firstY) w = "y" + w.slice(1);
  if (stemCache.size > 20000) stemCache.clear();
  stemCache.set(word, w);
  return w;
}

/** Tokenize → stem → clean, the BM25ContentFilter pipeline. */
export function scoringTokens(text: string, useStemming = true): string[] {
  const toks = tokenize(text);
  return cleanTokens(useStemming ? toks.map(stem) : toks);
}

// ---------------------------------------------------------------- BM25Okapi
export function bm25Scores(corpus: string[][], query: string[], k1 = 1.5, b = 0.75, epsilon = 0.25): number[] {
  const n = corpus.length;
  if (!n || !query.length) return new Array(n).fill(0);
  const docFreq = new Map<string, number>();
  const termFreqs = corpus.map((doc) => {
    const tf = new Map<string, number>();
    for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of tf.keys()) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    return tf;
  });
  const avgdl = corpus.reduce((s, d) => s + d.length, 0) / n || 1;
  const idf = new Map<string, number>();
  let idfSum = 0;
  const negatives: string[] = [];
  for (const [term, freq] of docFreq) {
    const v = Math.log(n - freq + 0.5) - Math.log(freq + 0.5);
    idf.set(term, v);
    idfSum += v;
    if (v < 0) negatives.push(term);
  }
  const floor = epsilon * (idfSum / (docFreq.size || 1));
  for (const term of negatives) idf.set(term, floor);
  return corpus.map((doc, i) => {
    const tf = termFreqs[i]!;
    let score = 0;
    for (const q of query) {
      const f = tf.get(q) ?? 0;
      if (!f) continue;
      score += (idf.get(q) ?? 0) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.length) / avgdl)));
    }
    return score;
  });
}
