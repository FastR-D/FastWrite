import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonDatabase } from "../storage/database";
import { WorkspaceService } from "../workspace/workspace-service";
import { AuthorizationService } from "../auth/authorization-service";
import { cleanGitError, GithubService, parseGithubRepository } from "./github-service";

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

describe("GitHub ownership", () => {
  test("registers an imported repository with its authenticated owner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fastwrite-github-owner-"));
    const database = new JsonDatabase(directory);
    await database.initialize();
    const workspaces = new WorkspaceService(directory, database);
    await workspaces.initialize();
    const originalSpawn = Bun.spawn;
    const spawn = spyOn(Bun, "spawn");
    const processResult = (stdout: string, exited = Promise.resolve(0)) => ({
      stdout: new Blob([stdout]).stream(), stderr: new Blob([]).stream(), exited
    });
    spawn.mockImplementation(((command: string[], options: unknown) => {
      if (command[0] === "git" && command[1] === "clone") {
        const destination = command.at(-1)!;
        const exited = mkdir(destination, { recursive: true })
          .then(() => writeFile(join(destination, "main.tex"), "\\documentclass{article}\n\\begin{document}GitHub paper\\end{document}"))
          .then(() => 0);
        return processResult("", exited);
      }
      if (command[0] === "git" && command[1] === "-C" && command[2]?.endsWith("repository")) {
        if (command[3] === "rev-parse") return processResult("0123456789abcdef0123456789abcdef01234567\n");
        if (command[3] === "symbolic-ref") return processResult("main\n");
      }
      return originalSpawn(command, options as Parameters<typeof Bun.spawn>[1]);
    }) as typeof Bun.spawn);
    try {
      const ownerUserId = "user_github_importer";
      const project = await new GithubService(directory, workspaces).import({ repository: "https://github.com/example/paper" }, ownerUserId);
      expect(project).toMatchObject({ personalOwnerUserId: ownerUserId, visibility: "private", source: { type: "github", ref: "main" } });
      const authorization = new AuthorizationService(database);
      expect(authorization.projectRole(ownerUserId, project.id)).toBe("owner");
      expect(authorization.projectRole("user_other", project.id)).toBeUndefined();
      expect(database.snapshot().projectMembers).toContainEqual(expect.objectContaining({ projectId: project.id, userId: ownerUserId, role: "owner" }));
      expect(database.snapshot().auditEvents).toContainEqual(expect.objectContaining({ resourceId: project.id, actorUserId: ownerUserId, action: "project.create" }));
    } finally {
      spawn.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
