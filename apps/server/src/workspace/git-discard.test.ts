import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { JsonDatabase } from "../storage/database";
import { WorkspaceService } from "./workspace-service";
import { CollaborationService } from "../collaboration/collaboration-service";

test("discard advances versions and reconciles CRDT state so old updates cannot restore discarded text", async () => {
  const root = await mkdtemp(join(tmpdir(), "fastwrite-discard-"));
  try {
    const database = new JsonDatabase(root); await database.initialize();
    const workspaces = new WorkspaceService(root, database); await workspaces.initialize();
    const project = await workspaces.createEmpty("Discard");
    const original = await workspaces.readTextFile(project.id, "main.tex");
    const collaboration = new CollaborationService(database, workspaces);
    const initial = await collaboration.open(project.id, "main.tex");
    const client = new Y.Doc(); Y.applyUpdate(client, Buffer.from(initial.update, "base64"));
    client.getText("content").insert(0, "discard me\n");
    const oldUpdate = Buffer.from(Y.encodeStateAsUpdate(client)).toString("base64");
    await collaboration.apply(project.id, "main.tex", oldUpdate, initial.fileVersion);
    const before = await workspaces.readTextFile(project.id, "main.tex"); const version = workspaces.getProject(project.id).version;
    await collaboration.discardPaths(project.id, ["main.tex"]);
    const after = await workspaces.readTextFile(project.id, "main.tex");
    expect(after.content).toBe(original.content);
    expect(after.file.version).toBeGreaterThan(before.file.version);
    expect(workspaces.getProject(project.id).version).toBeGreaterThan(version);
    const current = await collaboration.open(project.id, "main.tex");
    Y.applyUpdate(client, Buffer.from(current.update, "base64"));
    expect(client.getText("content").toString()).toBe(original.content);
    await collaboration.apply(project.id, "main.tex", oldUpdate, current.fileVersion);
    await collaboration.flushProject(project.id);
    expect((await workspaces.readTextFile(project.id, "main.tex")).content).toBe(original.content);
    await workspaces.createFile(project.id, "untracked.tex", "new");
    await collaboration.open(project.id, "untracked.tex");
    await collaboration.discardPaths(project.id, ["untracked.tex"]);
    expect(await workspaces.fileExists(project.id, "untracked.tex")).toBe(false);
    await collaboration.flushProject(project.id);
    expect(database.snapshot().collaborationDocuments.find(doc => doc.path === "untracked.tex")?.status).toBe("archived");
    client.destroy();
  } finally { await rm(root, { recursive: true, force: true }); }
});
