import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import * as decoding from "lib0/decoding";
import { JsonDatabase } from "../storage/database";
import { WorkspaceService } from "../workspace/workspace-service";
import { CollaborationService } from "./collaboration-service";
import { createApplication } from "../app";
import { createServerOptions } from "../server";

async function fixture(run: (workspaces: WorkspaceService, collaboration: CollaborationService, projectId: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "fastwrite-workspace-crdt-"));
  try {
    const database = new JsonDatabase(root); await database.initialize();
    const workspaces = new WorkspaceService(root, database); await workspaces.initialize();
    const project = await workspaces.createEmpty("Workspace synchronization");
    await run(workspaces, new CollaborationService(database, workspaces), project.id);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("ordinary saves update open CRDTs, preserve anchors and cannot be undone by an old snapshot", async () => {
  await fixture(async (workspaces, collaboration, id) => {
    await workspaces.createFile(id, "section.tex", "prefix original suffix");
    const initial = await collaboration.open(id, "section.tex");
    const client = new Y.Doc(); Y.applyUpdate(client, Buffer.from(initial.update, "base64"));
    const anchor = Y.createRelativePositionFromTypeIndex(client.getText("content"), 2);
    const stop = collaboration.onDocumentChange(change => Y.applyUpdate(client, Buffer.from(change.update, "base64")));
    try {
      const saved = await workspaces.saveTextFile(id, "section.tex", { content: "prefix replacement suffix", baseVersion: initial.fileVersion });
      expect(client.getText("content").toString()).toBe("prefix replacement suffix");
      expect(Y.createAbsolutePositionFromRelativePosition(anchor, client)?.index).toBe(2);
      const current = await collaboration.open(id, "section.tex");
      expect(current.fileVersion).toBe(saved.file.version);
      const persisted = await collaboration.persistSnapshot(id, "section.tex", initial.documentId, initial.update);
      expect(persisted.content).toBe("prefix replacement suffix");
      await collaboration.flushProject(id);
      expect((await workspaces.readTextFile(id, "section.tex")).file.version).toBe(saved.file.version);
    } finally { stop(); client.destroy(); }
  });
});

test("pending live edits survive a stale REST save and a later save uses the shared project lock", async () => {
  await fixture(async (workspaces, collaboration, id) => {
    const initial = await collaboration.open(id, "main.tex");
    const client = new Y.Doc(); Y.applyUpdate(client, Buffer.from(initial.update, "base64"));
    try {
      client.getText("content").insert(0, "% live unsaved edit\n");
      await collaboration.applyLive(id, "main.tex", Buffer.from(Y.encodeStateAsUpdate(client)).toString("base64"));
      await expect(workspaces.saveTextFile(id, "main.tex", { content: "stale REST overwrite", baseVersion: initial.fileVersion })).rejects.toMatchObject({ status: 409, code: "version_conflict" });
      const live = await workspaces.readTextFile(id, "main.tex");
      expect(live.content).toBe(client.getText("content").toString());
      await Promise.all([
        workspaces.saveTextFile(id, "main.tex", { content: live.content + "\n% reviewed edit", baseVersion: live.file.version }),
        collaboration.flushProject(id)
      ]);
      const current = await collaboration.open(id, "main.tex");
      Y.applyUpdate(client, Buffer.from(current.update, "base64"));
      expect(client.getText("content").toString()).toBe(live.content + "\n% reviewed edit");
      expect(current.fileVersion).toBe((await workspaces.readTextFile(id, "main.tex")).file.version);
    } finally { client.destroy(); }
  });
});

test("history restoration reconciles every open file before the next collaboration flush", async () => {
  await fixture(async (workspaces, collaboration, id) => {
    await workspaces.createFile(id, "section.tex", "checkpoint text");
    const checkpoint = await workspaces.commitHistory(id, "Before edit");
    expect(checkpoint).toBeTruthy();
    const initial = await collaboration.open(id, "section.tex");
    await workspaces.saveTextFile(id, "section.tex", { content: "later text", baseVersion: initial.fileVersion });
    await workspaces.restoreHistoryFiles(id, checkpoint!, ["section.tex"], workspaces.getProject(id).version);
    await collaboration.flushProject(id);
    const current = await collaboration.open(id, "section.tex");
    const client = new Y.Doc();
    try {
      Y.applyUpdate(client, Buffer.from(current.update, "base64"));
      expect(client.getText("content").toString()).toBe("checkpoint text");
      expect(current.fileVersion).toBe((await workspaces.readTextFile(id, "section.tex")).file.version);
    } finally { client.destroy(); }
  });
});

test("GitHub tree replacement reconciles changed rooms, archives deleted rooms and rejects intervening live edits", async () => {
  const source = await mkdtemp(join(tmpdir(), "fastwrite-sync-tree-"));
  try {
    await writeFile(join(source, "main.tex"), "remote main text");
    await fixture(async (workspaces, collaboration, id) => {
      await workspaces.createFile(id, "deleted.tex", "deleted remotely");
      await collaboration.open(id, "deleted.tex");
      const initial = await collaboration.open(id, "main.tex");
      const client = new Y.Doc(); Y.applyUpdate(client, Buffer.from(initial.update, "base64"));
      try {
        const expectedVersion = workspaces.getProject(id).version;
        client.getText("content").insert(0, "% live during merge\n");
        await collaboration.applyLive(id, "main.tex", Buffer.from(Y.encodeStateAsUpdate(client)).toString("base64"));
        await expect(workspaces.applyGithubSyncTree(id, source, expectedVersion)).rejects.toMatchObject({ code: "github_sync_workspace_changed" });
        expect((await workspaces.readTextFile(id, "main.tex")).content).toContain("live during merge");
        expect(await workspaces.fileExists(id, "deleted.tex")).toBe(true);
        await workspaces.applyGithubSyncTree(id, source, workspaces.getProject(id).version);
        await collaboration.flushProject(id);
        expect(await workspaces.fileExists(id, "deleted.tex")).toBe(false);
        const current = await collaboration.open(id, "main.tex");
        Y.applyUpdate(client, Buffer.from(current.update, "base64"));
        expect(client.getText("content").toString()).toBe("remote main text");
        const old = await collaboration.persistSnapshot(id, "main.tex", initial.documentId, initial.update);
        expect(old.content).toBe("remote main text");
      } finally { client.destroy(); }
    });
  } finally { await rm(source, { recursive: true, force: true }); }
});

test("accepted proposals reach connected peers and revoked peers receive no workspace writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "fastwrite-proposal-crdt-"));
  let closeSocket: (() => void) | undefined;
  const client = new Y.Doc();
  try {
    const app = await createApplication(root, { features: { serverAuth: true }, bootstrapAdmin: { email: "admin@example.test", password: "fixture-password-long-enough" } });
    const request = (path: string, token?: string, method = "GET", body?: unknown) => app(new Request("http://test" + path, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }));
    const json = async (path: string, token?: string, method = "GET", body?: unknown) => {
      const response = await request(path, token, method, body); expect(response.status).toBeLessThan(300); return await response.json() as any;
    };
    const owner = await json("/api/auth/register", undefined, "POST", { email: "owner@example.test", password: "fixture-password-long-enough" });
    const member = await json("/api/auth/register", undefined, "POST", { email: "member@example.test", password: "fixture-password-long-enough" });
    const project = await json("/api/projects", owner.token, "POST", { name: "Proposal synchronization" });
    const base = "/api/projects/" + project.id;
    const invite = await json(base + "/invitations", owner.token, "POST", { email: "member@example.test", role: "editor" });
    await json("/api/invitations/" + invite.token + "/accept", member.token, "POST");
    await json(base + "/files", owner.token, "POST", { path: "section.tex", content: "original text\n" });
    const initial = await json(base + "/collaboration?path=section.tex", member.token);
    Y.applyUpdate(client, Buffer.from(initial.update, "base64"));
    const room = await json("/api/collaboration/tokens", member.token, "POST", { projectId: project.id, path: "section.tex" });
    const options = createServerOptions(app);
    let data: unknown;
    const server = { upgrade: (_request: Request, input: { data: unknown }) => { data = input.data; return true; } } as unknown as Parameters<typeof options.fetch>[1];
    expect(await options.fetch(new Request(`http://test/api/collaboration/socket?clientId=fixture&token=${encodeURIComponent(room.token)}`), server)).toBeUndefined();
    let closed = false;
    const socket = { data, send: (bytes: Uint8Array) => {
      const decoder = decoding.createDecoder(bytes);
      if (decoding.readVarUint(decoder) === 0 && decoding.readVarUint(decoder) === 2) Y.applyUpdate(client, decoding.readVarUint8Array(decoder));
      return 1;
    }, close: () => { closed = true; } } as unknown as Parameters<typeof options.websocket.open>[0];
    options.websocket.open(socket); closeSocket = () => options.websocket.close(socket);
    const proposal = await json(base + "/table-equation-candidates", owner.token, "POST", { kind: "equation", targetPath: "section.tex", sourceFormat: "latex", source: "x=1" });
    await json(base + "/change-sets/" + proposal.changeSet.id + "/accept", owner.token, "POST");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(client.getText("content").toString()).toContain("x=1");
    const flushed = await json(base + "/collaboration/flush", owner.token, "POST", { path: "section.tex" });
    expect(flushed.content).toBe(client.getText("content").toString());
    await json(base + "/acl/new", owner.token, "PUT", { pathPrefix: "section.tex", subjectType: "user", subjectId: member.user.id, action: "read", effect: "deny" });
    await json(base + "/file?path=section.tex", owner.token, "PUT", { content: "private new text", baseVersion: flushed.file.version });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(closed).toBe(true);
    expect(client.getText("content").toString()).toBe(flushed.content);
    const saved = await json(base + "/collaboration/flush", owner.token, "POST", { path: "section.tex" });
    expect(saved.content).toBe("private new text");
  } finally { closeSocket?.(); client.destroy(); await rm(root, { recursive: true, force: true }); }
});
