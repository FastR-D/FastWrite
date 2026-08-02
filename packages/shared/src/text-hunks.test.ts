import { describe, expect, test } from "bun:test";
import { buildTextHunks, materializeTextHunks } from "./text-hunks";

describe("text hunks", () => {
  test("separates changes around stable lines and materializes independent decisions", () => {
    const before = "title\nkeep alpha\nold method\nkeep beta\nold result\nend\n";
    const after = "title\nkeep alpha\nnew method\nkeep beta\nnew result\nend\n";
    const hunks = buildTextHunks(before, after);
    expect(hunks).toHaveLength(2);
    hunks[0]!.status = "accepted";
    expect(materializeTextHunks(before, hunks)).toBe("title\nkeep alpha\nnew method\nkeep beta\nold result\nend\n");
    hunks[1]!.status = "accepted";
    expect(materializeTextHunks(before, hunks)).toBe(after);
  });

  test("handles pure insertion and deletion", () => {
    for (const [before, after] of [["a\nc\n", "a\nb\nc\n"], ["a\nb\nc\n", "a\nc\n"]] as const) {
      const hunks = buildTextHunks(before, after);
      hunks.forEach((hunk) => { hunk.status = "accepted"; });
      expect(materializeTextHunks(before, hunks)).toBe(after);
    }
  });
});
