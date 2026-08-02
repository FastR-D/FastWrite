import { describe, expect, test } from "bun:test";
import { isIgnoredWorkspacePath, isImageFile, isTextFile, normalizeWorkspacePath, sortWorkspaceNames } from "./path";

describe("normalizeWorkspacePath", () => {
  test("normalizes browser and Windows separators", () => {
    expect(normalizeWorkspacePath("./sections\\01-intro.tex")).toBe("sections/01-intro.tex");
  });

  test("rejects paths that could escape the workspace", () => {
    expect(() => normalizeWorkspacePath("../secret.tex")).toThrow();
    expect(() => normalizeWorkspacePath("/etc/passwd")).toThrow();
    expect(() => normalizeWorkspacePath("C:\\paper\\main.tex")).toThrow();
  });
});

test("recognizes workspace file types", () => {
  expect(isTextFile("paper/main.tex")).toBe(true);
  expect(isImageFile("figures/result.PNG")).toBe(true);
  expect(isTextFile("paper.pdf")).toBe(false);
});

test("uses natural ordering for paper files", () => {
  expect(["10-results.tex", "2-method.tex"].sort(sortWorkspaceNames)).toEqual(["2-method.tex", "10-results.tex"]);
});

test("excludes editor metadata, copied backups and generated output", () => {
  expect(isIgnoredWorkspacePath(".writeagent/backups/main.tex/old.tex")).toBe(true);
  expect(isIgnoredWorkspacePath("paper/.git/config")).toBe(true);
  expect(isIgnoredWorkspacePath("build/paper.pdf")).toBe(true);
  expect(isIgnoredWorkspacePath("sections/main.tex")).toBe(false);
});
