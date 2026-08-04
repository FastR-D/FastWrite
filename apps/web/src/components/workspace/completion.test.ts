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

  test("keeps adjacent English words separated", () => {
    expect(completionSuffix("reduces manual recovery time.", "The workflow"))
      .toBe(" reduces manual recovery time.");
  });

  test("does not split an echoed partial word", () => {
    expect(completionSuffix("systematic", "The system")).toBe("atic");
  });

  test("allows a fully duplicated suggestion to be ignored", () => {
    expect(completionSuffix("system", "The system")).toBe("");
  });
});
