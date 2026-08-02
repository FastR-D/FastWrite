import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonDatabase } from "../storage/database";
import { WorkspaceService } from "./workspace-service";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("managed Git history", () => {
  test("commits imports and saves without creating copied version files", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "fastwrite-git-history-"));
    temporaryDirectories.push(dataDirectory);
    const database = new JsonDatabase(dataDirectory);
    await database.initialize();
    const workspaces = new WorkspaceService(dataDirectory, database);
    await workspaces.initialize();

    const project = await workspaces.createEmpty("History paper");
    const opened = await workspaces.readTextFile(project.id, "main.tex");
    await workspaces.saveTextFile(project.id, "main.tex", { content: `${opened.content}\n% saved`, baseVersion: opened.file.version });
    await workspaces.createHistoryCheckpoint(project.id);

    const gitDirectory = join(dataDirectory, "projects", project.id, "history.git");
    const child = Bun.spawn(["git", `--git-dir=${gitDirectory}`, "rev-list", "--count", "--all"], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    expect((await new Response(child.stdout).text()).trim()).toBe("2");
    expect(await stat(join(dataDirectory, "projects", project.id, "versions")).then(() => true).catch(() => false)).toBe(false);
  });

  test("repairs a legacy backup path selected as the main document", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "fastwrite-main-migration-"));
    temporaryDirectories.push(dataDirectory);
    const database = new JsonDatabase(dataDirectory);
    await database.initialize();
    const workspaces = new WorkspaceService(dataDirectory, database);
    await workspaces.initialize();
    const project = await workspaces.createEmpty("Legacy paper");
    const backup = ".writeagent/backups/main.tex/old.tex";
    await mkdir(join(workspaces.workspaceRoot(project.id), ".writeagent", "backups", "main.tex"), { recursive: true });
    await writeFile(join(workspaces.workspaceRoot(project.id), backup), "\\documentclass{article}", "utf8");
    await database.mutate((state) => { state.projects[0]!.mainDocument = backup; });

    const restarted = new WorkspaceService(dataDirectory, database);
    await restarted.initialize();

    expect(restarted.getProject(project.id).mainDocument).toBe("main.tex");
    expect((await restarted.tree(project.id)).some((node) => node.path === ".writeagent")).toBe(false);
  });
});
