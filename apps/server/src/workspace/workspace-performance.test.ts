import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonDatabase } from "../storage/database";
import { WorkspaceService } from "./workspace-service";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("large workspace", () => {
  test("loads a 1000-file paper lazily within the interaction budget", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fastwrite-large-workspace-"));
    temporaryDirectories.push(directory);
    const database = new JsonDatabase(directory);
    await database.initialize();
    const workspaces = new WorkspaceService(directory, database);
    await workspaces.initialize();
    const project = await workspaces.createEmpty("Large Paper");
    const sections = join(workspaces.workspaceRoot(project.id), "sections");
    await mkdir(sections, { recursive: true });
    await Promise.all(Array.from({ length: 1_000 }, (_, index) => writeFile(join(sections, `section-${String(index).padStart(4, "0")}.tex`), `% ${index}`, "utf8")));

    const startedAt = performance.now();
    const rootTree = await workspaces.treeLevel(project.id);
    const rootElapsed = performance.now() - startedAt;
    const sectionDirectory = rootTree.find((node) => node.path === "sections");
    expect(sectionDirectory?.type).toBe("directory");
    expect(sectionDirectory?.type === "directory" ? sectionDirectory.children : null).toEqual([]);
    expect(sectionDirectory?.type === "directory" ? sectionDirectory.loaded : null).toBe(false);
    expect(rootElapsed).toBeLessThan(500);

    const expansionStartedAt = performance.now();
    const sectionFiles = await workspaces.treeLevel(project.id, "sections");
    const expansionElapsed = performance.now() - expansionStartedAt;
    expect(sectionFiles).toHaveLength(1_000);
    expect(expansionElapsed).toBeLessThan(2_000);
  });
});
