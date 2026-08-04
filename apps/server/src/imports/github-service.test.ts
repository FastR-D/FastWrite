import { describe, expect, test } from "bun:test";
import { cleanGitError, parseGithubRepository } from "./github-service";

describe("parseGithubRepository", () => {
  test("accepts canonical and SSH-shaped GitHub URLs", () => {
    expect(parseGithubRepository("https://github.com/example/paper.git").cloneUrl).toBe("https://github.com/example/paper.git");
    expect(parseGithubRepository("git@github.com:example/paper.git").repository).toBe("paper");
  });

  test("rejects non-GitHub and nested URLs", () => {
    expect(() => parseGithubRepository("https://example.com/example/paper")).toThrow();
    expect(() => parseGithubRepository("https://github.com/example/paper/issues")).toThrow();
  });

  test("removes local clone paths from user-facing Git errors", () => {
    expect(cleanGitError("Cloning into '/private/tmp/github-123/repository'...\nremote: Repository not found.\nfatal: repository unavailable")).toBe("GitHub repository not found or access was denied");
  });
});
