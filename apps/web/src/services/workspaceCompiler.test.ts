import { describe, expect, test } from "bun:test";
import { addCompileFile } from "./workspaceCompiler";

describe("workspace compiler paths", () => {
  test("aliases files relative to a nested main document", () => {
    const files: Record<string, string | Uint8Array> = {};
    addCompileFile(files, "paper/sections/method.tex", "paper/main.tex", "method");
    addCompileFile(files, "paper/references.bib", "paper/main.tex", "references");

    expect(files).toEqual({
      "paper/sections/method.tex": "method",
      "sections/method.tex": "method",
      "paper/references.bib": "references",
      "references.bib": "references"
    });
  });

  test("does not create aliases for root main documents or outside files", () => {
    const files: Record<string, string | Uint8Array> = {};
    addCompileFile(files, "sections/method.tex", "main.tex", "root method");
    addCompileFile(files, "figures/result.pdf", "paper/main.tex", new Uint8Array([1, 2, 3]));

    expect(Object.keys(files)).toEqual(["sections/method.tex", "figures/result.pdf"]);
  });
});
