import { describe, expect, test } from "bun:test";
import { preserveLatexComments, stripLatexComments } from "./latex-comments";

describe("stripLatexComments", () => {
  test("hides full-line and inline comments while preserving escaped percent signs and line positions", () => {
    const source = "\\section{Method}\n% TODO: rewrite with an unsupported claim\nAccuracy is 95\\%. % private note\nFinal claim.\n";
    expect(stripLatexComments(source)).toBe("\\section{Method}\n\nAccuracy is 95\\%.\nFinal claim.\n");
  });
});

describe("preserveLatexComments", () => {
  test("restores full-line and inline user comments without treating escaped percent signs as comments", () => {
    const before = "\\section{Method}\n% Keep this instruction\nOld claim. % Explain the boundary\nAccuracy is 95\\%.\n";
    const generated = "\\section{Method}\nNew claim.\nAccuracy is 96\\%.\n";

    const preserved = preserveLatexComments(before, generated);

    expect(preserved).toContain("% Keep this instruction");
    expect(preserved).toContain("% Explain the boundary");
    expect(preserved.match(/95\\%/g)).toBeNull();
  });

  test("does not duplicate comments already retained by the model", () => {
    const content = "\\section{Method}\n% Keep this instruction\nNew claim.\n";
    expect(preserveLatexComments(content, content).match(/Keep this instruction/g)).toHaveLength(1);
  });
});
