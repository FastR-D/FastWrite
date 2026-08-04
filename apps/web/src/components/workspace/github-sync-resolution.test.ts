import { describe, expect, test } from "bun:test";
import type { GithubSyncConflict } from "@fastwrite/shared";
import { createPendingResolutions, editTextResolution, keepConflictSide } from "./github-sync-resolution";

const conflict: GithubSyncConflict = {
  path: "main.tex",
  kind: "text",
  baseContent: "Shared sentence.\nBase sentence.\n",
  fastwriteContent: "Shared sentence.\nFastWrite sentence.\n",
  githubContent: "Shared sentence.\nGitHub sentence.\n"
};

describe("GitHub text conflict resolution", () => {
  test("a Keep choice is an editable starting point for a line-level merged result", () => {
    const initial = createPendingResolutions([conflict])[conflict.path]!;
    expect(initial).toEqual({ choice: "", content: conflict.fastwriteContent ?? "" });

    const fromGithub = keepConflictSide(conflict, initial, "github");
    expect(fromGithub).toEqual({ choice: "github", content: conflict.githubContent ?? "" });

    const manuallyMerged = editTextResolution(fromGithub, "Shared sentence.\nFastWrite sentence.\nGitHub sentence.\n");
    expect(manuallyMerged).toEqual({
      choice: "edited",
      content: "Shared sentence.\nFastWrite sentence.\nGitHub sentence.\n"
    });
  });
});
