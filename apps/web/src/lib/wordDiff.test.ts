import { describe, expect, test } from "bun:test";
import { diffWords } from "./wordDiff";

describe("diffWords", () => {
  test("preserves LaTeX, whitespace and mixed-language text", () => {
    const parts = diffWords("We use \\method{} 提升 security.", "We use \\method{} to improve 安全性.");
    expect(parts.map((part) => part.value).join("")).not.toBe("");
    expect(parts.filter((part) => part.type !== "delete").map((part) => part.value).join("")).toBe("We use \\method{} to improve 安全性.");
    expect(parts.filter((part) => part.type !== "insert").map((part) => part.value).join("")).toBe("We use \\method{} 提升 security.");
  });

  test("compacts a large replacement without quadratic UI work", () => {
    const before = Array.from({ length: 30_000 }, (_, index) => `claim-${index}`).join(" ");
    const after = Array.from({ length: 30_000 }, (_, index) => `evidence-${index}`).join(" ");
    const startedAt = performance.now();
    const parts = diffWords(before, after);
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(parts.length).toBeLessThanOrEqual(3);
    expect(parts.some((part) => part.type === "delete")).toBe(true);
    expect(parts.some((part) => part.type === "insert")).toBe(true);
  });
});
