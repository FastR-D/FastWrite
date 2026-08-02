import { describe, expect, test } from "bun:test";
import { parseGithubRepository } from "./github-service";

describe("parseGithubRepository", () => {
  test("accepts canonical and SSH-shaped GitHub URLs", () => {
    expect(parseGithubRepository("https://github.com/example/paper.git").cloneUrl).toBe("https://github.com/example/paper.git");
    expect(parseGithubRepository("git@github.com:example/paper.git").repository).toBe("paper");
  });

  test("rejects non-GitHub and nested URLs", () => {
    expect(() => parseGithubRepository("https://example.com/example/paper")).toThrow();
    expect(() => parseGithubRepository("https://github.com/example/paper/issues")).toThrow();
  });
});
