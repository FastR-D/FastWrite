import { describe, expect, test } from "bun:test";
import { fitPdfPageScale, MIN_PDF_SCALE } from "./pdfScale";

describe("PDF page fitting", () => {
  test("fits a portrait page within both panel dimensions", () => {
    expect(fitPdfPageScale(440, 700, 595, 842)).toBeCloseTo(404 / 595);
  });

  test("uses height when it is the limiting dimension", () => {
    expect(fitPdfPageScale(1000, 500, 595, 842)).toBeCloseTo(464 / 842);
  });

  test("keeps very small panels usable and rejects incomplete dimensions", () => {
    expect(fitPdfPageScale(120, 120, 595, 842)).toBe(MIN_PDF_SCALE);
    expect(fitPdfPageScale(440, 700, 0, 842)).toBeNull();
  });
});
