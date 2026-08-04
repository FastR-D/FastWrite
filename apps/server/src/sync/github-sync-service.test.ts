import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GithubSyncRun } from "@fastwrite/shared";
import { JsonDatabase } from "../storage/database";
import { WorkspaceService } from "../workspace/workspace-service";
import { GithubSyncService } from "./github-sync-service";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("GithubSyncService", () => {
  test("publishes local changes as one public commit after a successful compile", async () => {
    const fixture = await syncFixture();
    const opened = await fixture.workspaces.readTextFile(fixture.projectId, "main.tex");
    await fixture.workspaces.saveTextFile(fixture.projectId, "main.tex", { baseVersion: opened.file.version, content: opened.content.replace("base", "fastwrite") });

    const ready = await fixture.sync.start(fixture.projectId);
    expect(ready).toMatchObject({ status: "ready-to-compile", hasChangesToPush: true, conflicts: [] });
    await expect(fixture.sync.finalize(fixture.projectId, ready.id)).rejects.toThrow("successful compile");
    await recordSuccessfulCompile(fixture.database, ready);
    const completed = await fixture.sync.finalize(fixture.projectId, ready.id);

    expect(completed.status).toBe("completed");
    expect(completed.pushedCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(await gitText(["--git-dir", fixture.remote, "rev-list", "--count", "main"])).toBe("2");
    expect(await gitText(["--git-dir", fixture.remote, "show", "main:main.tex"])).toContain("fastwrite");
  });

  test("applies GitHub-only changes without creating an empty FastWrite commit", async () => {
    const fixture = await syncFixture();
    await writeFile(join(fixture.seed, "main.tex"), paper("github"), "utf8");
    await commitAndPush(fixture.seed, "GitHub edit");

    const ready = await fixture.sync.start(fixture.projectId);
    expect(ready).toMatchObject({ status: "ready-to-compile", hasChangesToPush: false });
    expect((await fixture.workspaces.readTextFile(fixture.projectId, "main.tex")).content).toContain("github");
    await recordSuccessfulCompile(fixture.database, ready);
    const completed = await fixture.sync.finalize(fixture.projectId, ready.id);

    expect(completed.status).toBe("completed");
    expect(completed.pushedCommit).toBeUndefined();
    expect(await gitText(["--git-dir", fixture.remote, "rev-list", "--count", "main"])).toBe("2");
  });

  test("pauses on an overlapping edit and continues with the edited resolution", async () => {
    const fixture = await syncFixture();
    const opened = await fixture.workspaces.readTextFile(fixture.projectId, "main.tex");
    await fixture.workspaces.saveTextFile(fixture.projectId, "main.tex", { baseVersion: opened.file.version, content: paper("fastwrite") });
    await writeFile(join(fixture.seed, "main.tex"), paper("github"), "utf8");
    await commitAndPush(fixture.seed, "Conflicting GitHub edit");

    const conflicted = await fixture.sync.start(fixture.projectId);
    expect(conflicted.status).toBe("conflicts");
    expect(conflicted.conflicts).toEqual([expect.objectContaining({ path: "main.tex", kind: "text", fastwriteContent: expect.stringContaining("fastwrite"), githubContent: expect.stringContaining("github") })]);

    const mergedContent = paper("fastwrite sentence\nGitHub sentence");
    const ready = await fixture.sync.resolve(fixture.projectId, conflicted.id, [{ path: "main.tex", choice: "edited", content: mergedContent }]);
    expect(ready).toMatchObject({ status: "ready-to-compile", hasChangesToPush: true });
    expect((await fixture.workspaces.readTextFile(fixture.projectId, "main.tex")).content).toContain("fastwrite sentence\nGitHub sentence");
    await recordSuccessfulCompile(fixture.database, ready);
    const completed = await fixture.sync.finalize(fixture.projectId, ready.id);

    expect(completed.status).toBe("completed");
    expect(await gitText(["--git-dir", fixture.remote, "show", "main:main.tex"])).toContain("fastwrite sentence\nGitHub sentence");
    expect(await gitText(["--git-dir", fixture.remote, "rev-list", "--count", "main"])).toBe("3");
  });

  test("rejects a conflict choice outside the explicit resolution options", async () => {
    const fixture = await syncFixture();
    const opened = await fixture.workspaces.readTextFile(fixture.projectId, "main.tex");
    await fixture.workspaces.saveTextFile(fixture.projectId, "main.tex", { baseVersion: opened.file.version, content: paper("fastwrite") });
    await writeFile(join(fixture.seed, "main.tex"), paper("github"), "utf8");
    await commitAndPush(fixture.seed, "Conflicting GitHub edit");
    const conflicted = await fixture.sync.start(fixture.projectId);

    await expect(fixture.sync.resolve(fixture.projectId, conflicted.id, [
      { path: "main.tex", choice: "unresolved" as never }
    ])).rejects.toThrow("explicit conflict resolution");
  });

  test("requires a side choice for binary conflicts instead of accepting edited text", async () => {
    const fixture = await syncFixture();
    await writeFile(join(fixture.workspaces.workspaceRoot(fixture.projectId), "figure.bin"), new Uint8Array([0, 1, 2]));
    await writeFile(join(fixture.seed, "figure.bin"), new Uint8Array([0, 3, 4]));
    await commitAndPush(fixture.seed, "Conflicting binary asset");
    const conflicted = await fixture.sync.start(fixture.projectId);

    expect(conflicted.conflicts).toEqual([expect.objectContaining({ path: "figure.bin", kind: "binary" })]);
    await expect(fixture.sync.resolve(fixture.projectId, conflicted.id, [
      { path: "figure.bin", choice: "edited", content: "not a binary merge" }
    ])).rejects.toThrow("Only text conflicts");
  });

  test("never force-pushes when GitHub advances after fetch", async () => {
    const fixture = await syncFixture();
    const opened = await fixture.workspaces.readTextFile(fixture.projectId, "main.tex");
    await fixture.workspaces.saveTextFile(fixture.projectId, "main.tex", { baseVersion: opened.file.version, content: paper("fastwrite") });
    const ready = await fixture.sync.start(fixture.projectId);
    await recordSuccessfulCompile(fixture.database, ready);

    await writeFile(join(fixture.seed, "remote-only.tex"), "Remote edit\n", "utf8");
    await commitAndPush(fixture.seed, "Advance GitHub after fetch");
    const stopped = await fixture.sync.finalize(fixture.projectId, ready.id);

    expect(stopped.status).toBe("remote-changed");
    expect(stopped.pushedCommit).toBeUndefined();
    expect(await gitText(["--git-dir", fixture.remote, "rev-list", "--count", "main"])).toBe("2");
    expect(await gitText(["--git-dir", fixture.remote, "show", "main:main.tex"])).toContain("base");
  });
});

async function syncFixture() {
  const root = await mkdtemp(join(tmpdir(), "fastwrite-sync-test-"));
  temporaryDirectories.push(root);
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const data = join(root, "data");
  await mkdir(seed, { recursive: true });
  await runGit(["init", "--bare", "--initial-branch=main", remote]);
  await runGit(["-C", seed, "init", "--initial-branch=main"]);
  await runGit(["-C", seed, "config", "user.name", "Test Author"]);
  await runGit(["-C", seed, "config", "user.email", "test@example.com"]);
  await writeFile(join(seed, "main.tex"), paper("base"), "utf8");
  await runGit(["-C", seed, "add", "main.tex"]);
  await runGit(["-C", seed, "commit", "-m", "Initial paper"]);
  await runGit(["-C", seed, "remote", "add", "origin", remote]);
  await runGit(["-C", seed, "push", "-u", "origin", "main"]);
  const commit = await gitText(["-C", seed, "rev-parse", "HEAD"]);

  const database = new JsonDatabase(data);
  await database.initialize();
  const workspaces = new WorkspaceService(data, database);
  await workspaces.initialize();
  const project = await workspaces.copyExternalDirectory({
    sourceDirectory: seed,
    name: "Synced paper",
    mainDocument: "main.tex",
    venue: "security-top4",
    source: { type: "github", repository: "https://github.com/example/paper", ref: "main", commit }
  });
  const sync = new GithubSyncService(data, database, workspaces, () => remote);
  return { root, remote, seed, data, database, workspaces, sync, projectId: project.id };
}

async function commitAndPush(seed: string, message: string): Promise<void> {
  await runGit(["-C", seed, "add", "-A"]);
  await runGit(["-C", seed, "commit", "-m", message]);
  await runGit(["-C", seed, "push", "origin", "main"]);
}

async function recordSuccessfulCompile(database: JsonDatabase, run: GithubSyncRun): Promise<void> {
  if (run.projectVersion === undefined) throw new Error("Sync run is missing a project version");
  await database.mutate((state) => {
    state.compileRecords.push({
      id: `compile_${crypto.randomUUID()}`,
      projectId: run.projectId,
      projectVersion: run.projectVersion!,
      status: "success",
      summary: "Compiled in integration test",
      createdAt: new Date(Date.parse(run.updatedAt) + 1).toISOString()
    });
  });
}

async function runGit(args: string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], { stdout: "ignore", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const stderr = await new Response(child.stderr).text();
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(stderr || `git ${args[0]} failed`);
}

async function gitText(args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(stderr || `git ${args[0]} failed`);
  return stdout.trim();
}

function paper(value: string): string {
  return `\\documentclass{article}\n\\begin{document}\nResult: ${value}\n\\end{document}\n`;
}
