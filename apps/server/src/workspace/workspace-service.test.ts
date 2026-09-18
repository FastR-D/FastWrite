import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceService } from "./workspace-service";
import { JsonDatabase } from "../storage/database";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fastwrite-workspace-queue-"));
  roots.push(root);
  const db = new JsonDatabase(root);
  await db.initialize();
  const workspaces = new WorkspaceService(root, db);
  await workspaces.initialize();
  const project = await workspaces.createEmpty("Queue paper");
  return { root, workspaces, project };
}

test("simultaneous saves cannot both accept the same file version", async () => {
  const { workspaces, project } = await fixture();
  const opened = await workspaces.readTextFile(project.id, "main.tex");
  const results = await Promise.allSettled([
    workspaces.saveTextFile(project.id, "main.tex", { content: "one", baseVersion: opened.file.version }),
    workspaces.saveTextFile(project.id, "main.tex", { content: "two", baseVersion: opened.file.version }),
  ]);
  expect(results[0]!.status).toBe("fulfilled");
  expect(results[1]).toMatchObject({ status: "rejected", reason: { status: 409 } });
  expect((await workspaces.readTextFile(project.id, "main.tex")).content).toBe("one");
});

test("restore rejects stale project versions and recreates deleted files with a new checkpoint", async () => {
  const { workspaces, project } = await fixture();
  await workspaces.createFile(project.id, "deleted.tex", "original");
  const initial = (await workspaces.history(project.id))[0]!.oid;
  const version = workspaces.getProject(project.id).version;
  await workspaces.deletePath(project.id, "deleted.tex");
  await expect(workspaces.restoreHistoryFiles(project.id, initial, ["deleted.tex"], version)).rejects.toMatchObject({ status: 409 });
  expect(await workspaces.fileExists(project.id, "deleted.tex")).toBe(false);
  const current = workspaces.getProject(project.id).version;
  const restored = await workspaces.restoreHistoryFiles(project.id, initial, ["deleted.tex"], current);
  expect(restored.oid).toBeString();
  expect((await workspaces.readTextFile(project.id, "deleted.tex")).content).toBe("original");
  expect((await workspaces.history(project.id))[0]!.message).toBe(`Restore history checkpoint ${initial}`);
  await expect(workspaces.restoreHistoryFiles(project.id, initial, ["deleted.tex"], current)).rejects.toMatchObject({ status: 409 });
  const unchanged = await workspaces.restoreHistoryFiles(project.id, initial, ["deleted.tex"], workspaces.getProject(project.id).version);
  expect(unchanged.oid).toBeString();
  expect(unchanged.oid).not.toBe(restored.oid);
});

test("snapshot contents and version come from one serialized point in time", async () => {
  const { root, workspaces, project } = await fixture();
  const opened = await workspaces.readTextFile(project.id, "main.tex");
  const version = workspaces.getProject(project.id).version;
  const destination = join(root, "snapshot");
  const snapshot = workspaces.copySnapshot(project.id, destination);
  const save = workspaces.saveTextFile(project.id, "main.tex", { content: "newer", baseVersion: opened.file.version });
  expect(await snapshot).toEqual({ mainDocument: "main.tex", projectVersion: version });
  await save;
  expect(await readFile(join(destination, "main.tex"), "utf8")).toBe(opened.content);
  expect((await workspaces.readTextFile(project.id, "main.tex")).content).toBe("newer");
  expect(workspaces.getProject(project.id).version).toBeGreaterThan(version);
});
