import { describe, expect, test } from "bun:test";
import { completionSuffix } from "./completion";

describe("completionSuffix", () => {
  test("keeps only text not already typed immediately before the cursor", () => {
    expect(completionSuffix("The system remains secure.", "Introduction: The system"))
      .toBe(" remains secure.");
  });

  test("does not remove text when the suggestion begins differently", () => {
    expect(completionSuffix(" remains secure.", "Introduction: The system"))
      .toBe(" remains secure.");
  });

  test("allows a fully duplicated suggestion to be ignored", () => {
    expect(completionSuffix("system", "The system")).toBe("");
  });
});
