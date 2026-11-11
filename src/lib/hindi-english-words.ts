// Browser-safe: how English words appear in spoken Hindi interpretations.
// Shared by the interpreter, the reviewer and the final English-letters check so every
// step follows one rule — the everyday Hindi an Indian student actually speaks.

/** The interpretation rule for English words (also given to the reviewer). */
export const EVERYDAY_ENGLISH_RULE = `English words — write them the way Indians say them in everyday Hindi conversation, never in English letters and never in textbook Hindi:
a. English words that are normal in spoken Hindi stay English but are written in Devanagari exactly as Indians pronounce them: exam → एग्ज़ाम, test → टेस्ट, marks → मार्क्स, notes → नोट्स, revision → रिवीज़न, chapter → चैप्टर, topic → टॉपिक, syllabus → सिलेबस, practice → प्रैक्टिस, schedule → शेड्यूल, phone → फ़ोन, app → ऐप, video → वीडियो, online → ऑनलाइन, spreadsheet → स्प्रेडशीट, column → कॉलम, flashcard → फ़्लैशकार्ड, concept → कॉन्सेप्ट, doctor → डॉक्टर.
b. English words people do NOT normally say in Hindi get the plain everyday Hindi a friend would use: retention → याद रहना, procrastinate → काम टालना, efficient → कम मेहनत में ज़्यादा काम वाला, struggle → मुश्किल होना, overwhelming → बहुत भारी लगना, consistent → रोज़ लगातार. Never use formal or Sanskritised words such as पुनरावृत्ति, उपयोगकर्ता, अनुप्रयोग, प्रभावशीलता, स्मरण-शक्ति.
c. Names of people, places, brands, apps, websites and books: Devanagari as pronounced — अली अब्दाल, गूगल शीट्स, ऐंकी, क्विज़लेट, यूट्यूब, ऑक्सफ़ोर्ड. Acronyms letter by letter — डीएनए, एनसीईआरटी, एआई, पीडीएफ़ — unless they are spoken as a word (नीट, नासा).
d. Subject and technical terms keep the English term students hear in class, written in Devanagari (माइटोकॉन्ड्रिया, ऐक्टिव रिकॉल, स्पेस्ड रिपिटिशन). Only at the first mention, and only when a beginner would not know it, add a few simple Hindi words of meaning ("ऐक्टिव रिकॉल, यानी खुद से याद करके देखना"); afterwards use just the short term. Never repeat dictionary-style expansions.
e. Spell for clear pronunciation: ऑ for the English "o" in doctor/column/topic (डॉक्टर, कॉलम, टॉपिक), nukta for z and f sounds (ज़ीरो, फ़ोन), and the same spelling every time — follow the glossary.
f. Keep English letters only for what must be typed or read exactly: equations, chemical formulas (H2O, CO2), units right after a number (5 mg), code, URLs and email addresses.`;

const URL_OR_EMAIL = /\b(?:https?:\/\/|www\.)\S+|[\w.+-]+@[\w-]+\.[\w.]+/gi;
const CODE = /`[^`]*`/g;
// Chunks that are formulas, code or identifiers rather than spoken words.
const FORMULA_LIKE = /[\d_=\\/^{}<>+*|#~]/;
const LATIN_RUN = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
const EDGE_PUNCT = /^[\s"'“”‘’()[\]«»,.;:!?।॥…-]+|[\s"'“”‘’()[\]«»,.;:!?।॥…-]+$/g;
const NUMBER_CHUNK = /^[\d.,]+$/;

/**
 * Words still written in English letters that a Hindi listener should get in Devanagari
 * (or plain Hindi). Formulas, units after a number, single letters, code and links are allowed.
 */
export function latinWords(text: string): string[] {
  const cleaned = text.replace(CODE, ' ').replace(URL_OR_EMAIL, ' ');
  const chunks = cleaned.split(/\s+/).map(c => c.replace(EDGE_PUNCT, '')).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  chunks.forEach((chunk, i) => {
    if (FORMULA_LIKE.test(chunk)) return;
    const previous = chunks[i - 1] ?? '';
    for (const match of chunk.match(LATIN_RUN) ?? []) {
      if (match.length < 2) continue;
      // "5 mg", "10 km": units directly after a number stay as written.
      if (match.length <= 3 && NUMBER_CHUNK.test(previous)) continue;
      const key = match.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(match);
    }
  });
  return out;
}

/** Reviewer note listing words still in English letters; empty when the block is clean. */
export function englishLettersNote(hindi: string): string {
  const words = latinWords(hindi);
  return words.length ? `ENGLISH LETTERS TO REWRITE: ${words.join(', ')}` : '';
}
