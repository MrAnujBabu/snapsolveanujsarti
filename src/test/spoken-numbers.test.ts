import { describe, expect, it } from "vitest";
import { numberToWords, spellOutNumbers } from "@/lib/spoken-numbers";

describe("spoken numbers for live voice", () => {
  it("spells out the skeletal system counts exactly", () => {
    expect(spellOutNumbers("Total 206 bones hoti hain, axial skeleton me 80, appendicular me 126."))
      .toBe("Total two hundred six bones hoti hain, axial skeleton me 80, appendicular me one hundred twenty-six.");
  });

  it("never turns 126 into 1206", () => {
    expect(numberToWords(126)).toBe("one hundred twenty-six");
    expect(numberToWords(1206)).toBe("one thousand two hundred six");
  });

  it("uses lakh and crore for big numbers", () => {
    expect(spellOutNumbers("NEET mein 20,00,000 students")).toBe("NEET mein twenty lakh students");
    expect(numberToWords(12_500_000)).toBe("one crore twenty-five lakh");
  });

  it("keeps years, small numbers, decimals and ratios as written", () => {
    expect(spellOutNumbers("NEET 2027 mein 180 questions, 720 marks")).toBe("NEET 2027 mein one hundred eighty questions, seven hundred twenty marks");
    expect(spellOutNumbers("Class 11 chapter 7")).toBe("Class 11 chapter 7");
    expect(spellOutNumbers("pH 7.4, ratio 9:3:3:1, 1.602 coulomb")).toBe("pH 7.4, ratio 9:3:3:1, 1.602 coulomb");
  });
});
