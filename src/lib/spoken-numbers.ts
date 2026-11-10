// Live voices misread bare digits in Hinglish (a spoken "126" came out as "1206"),
// so the answer the voice speaks carries big numbers already spelled out in English words.

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

const one = (n: number) => ONES[n] ?? "";

function belowHundred(n: number): string {
  if (n < 20) return one(n);
  const tens = TENS[Math.floor(n / 10)] ?? "";
  return n % 10 ? `${tens}-${one(n % 10)}` : tens;
}

function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (!hundreds) return belowHundred(rest);
  return rest ? `${one(hundreds)} hundred ${belowHundred(rest)}` : `${one(hundreds)} hundred`;
}

/** English words in the Indian system (lakh, crore) that Indian students hear in class. */
export function numberToWords(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError("Expected a non-negative integer");
  if (n === 0) return "zero";
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1000);
  const rest = n % 1000;
  if (crore) parts.push(`${numberToWords(crore)} crore`);
  if (lakh) parts.push(`${belowHundred(lakh)} lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} thousand`);
  if (rest) parts.push(belowThousand(rest));
  return parts.join(" ");
}

const YEAR = /^(?:19|20)\d\d$/;
// Whole numbers only: decimals, ratios, times, ranges written as 1-2, codes and words like H2O stay as written.
const NUMBER = /(?<![\w.,:/-]|\d)(\d{1,3}(?:,\d{2,3})+|\d+)(?![\w]|[.,:/]\d)/gu;

/** Spell out whole numbers of 100 and above so the voice says exactly that number. Years stay as digits. */
export function spellOutNumbers(text: string): string {
  return text.replace(NUMBER, (match) => {
    const digits = match.replace(/,/g, "");
    if (digits.length > 1 && digits.startsWith("0")) return match;
    const value = Number(digits);
    if (value < 100 || value >= 1_000_000_000 || YEAR.test(match)) return match;
    return numberToWords(value);
  });
}
