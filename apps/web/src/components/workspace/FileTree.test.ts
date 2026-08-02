import { describe, expect, test } from "bun:test";
import type { WorkspaceTreeNode } from "@fastwrite/shared";
import { flattenVisible } from "./FileTree";

const tree: WorkspaceTreeNode[] = [
  {
    type: "directory",
    path: "sections",
    name: "sections",
    children: [
      { type: "file", path: "sections/method.tex", name: "method.tex", kind: "text", size: 1, version: 1, updatedAt: "2026-01-01T00:00:00.000Z" },
      {
        type: "directory",
        path: "sections/appendix",
        name: "appendix",
        children: [{ type: "file", path: "sections/appendix/a.tex", name: "a.tex", kind: "text", size: 1, version: 1, updatedAt: "2026-01-01T00:00:00.000Z" }]
      }
    ]
  },
  { type: "file", path: "main.tex", name: "main.tex", kind: "text", size: 1, version: 1, updatedAt: "2026-01-01T00:00:00.000Z" }
];

describe("flattenVisible", () => {
  test("only includes descendants of expanded directories", () => {
    expect(flattenVisible(tree, new Set()).map(({ node }) => node.path)).toEqual(["sections", "main.tex"]);
    expect(flattenVisible(tree, new Set(["sections"])).map(({ node }) => node.path)).toEqual([
      "sections",
      "sections/method.tex",
      "sections/appendix",
      "main.tex"
    ]);
    expect(flattenVisible(tree, new Set(["sections", "sections/appendix"])).at(-2)?.node.path).toBe("sections/appendix/a.tex");
  });
});
