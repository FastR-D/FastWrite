import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paperSkillForProfile, type PaperProject } from "@fastwrite/shared";
import { JsonDatabase } from "../storage/database";
import type { WorkspaceService } from "../workspace/workspace-service";
import { UploadService } from "./upload-service";

const temporaryDirectories: string[] = [];
const encoded = new TextEncoder().encode("\\documentclass{article}\n\\begin{document}Imported paper\\end{document}");
const content = new ArrayBuffer(encoded.byteLength);
new Uint8Array(content).set(encoded);
type ImportInput = Parameters<WorkspaceService["importStagingDirectory"]>[0];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function testUploads(beforeImport?: () => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-upload-retry-"));
  temporaryDirectories.push(directory);
  const database = new JsonDatabase(directory);
  await database.initialize();
  const projects = new Map<string, PaperProject>();
  const importDirectory = mock(async (input: ImportInput): Promise<PaperProject> => {
    await beforeImport?.();
    const timestamp = new Date().toISOString();
    const project: PaperProject = {
      id: `paper_${crypto.randomUUID()}`, name: input.name, mainDocument: input.mainDocument,
      skill: paperSkillForProfile(input.venue), source: input.source, version: 1,
      ...(input.personalOwnerUserId ? { personalOwnerUserId: input.personalOwnerUserId, visibility: "private" } : {}),
      createdAt: timestamp, updatedAt: timestamp
    };
    projects.set(project.id, project);
    return project;
  });
  const workspaces = { importStagingDirectory: importDirectory, getProject: (id: string) => projects.get(id)! } as unknown as WorkspaceService;
  const uploads = new UploadService(directory, database, workspaces);
  await uploads.initialize();
  const session = await uploads.create({ projectName: "Retry paper", mainDocument: "main.tex", venue: "network-information-security", sourceName: "source", entries: [{ path: "main.tex", kind: "file", size: content.byteLength }] }, "user_importer");
  return { uploads, database, session, importDirectory };
}

describe("upload completion retries", () => {
  test("repeated completion returns the original private project without importing twice", async () => {
    const { uploads, database, session, importDirectory } = await testUploads();
    await uploads.uploadFile(session.id, "main.tex", content);
    const project = await uploads.complete(session.id);
    // A completed receipt remains usable after the staging-upload TTL expires.
    await database.mutate(state => { state.uploadSessions[0]!.expiresAt = new Date(0).toISOString(); });
    const retried = await uploads.complete(session.id);
    expect(retried).toEqual(project);
    expect(retried.personalOwnerUserId).toBe("user_importer");
    expect(importDirectory).toHaveBeenCalledTimes(1);
    expect(uploads.get(session.id)).toMatchObject({ status: "completed", projectId: project.id, ownerUserId: "user_importer" });
  });

  test("concurrent completion shares one import and blocks uploads or cancellation while completing", async () => {
    let started!: () => void;
    let release!: () => void;
    const importing = new Promise<void>(resolve => { started = resolve; });
    const finish = new Promise<void>(resolve => { release = resolve; });
    const { uploads, session, importDirectory } = await testUploads(async () => { started(); await finish; });
    await uploads.uploadFile(session.id, "main.tex", content);
    const first = uploads.complete(session.id);
    const second = uploads.complete(session.id);
    await importing;
    try {
      expect(uploads.get(session.id).status).toBe("completing");
      await expect(uploads.uploadFile(session.id, "main.tex", content)).rejects.toMatchObject({ status: 409, code: "upload_not_writable" });
      await expect(uploads.cancel(session.id)).rejects.toMatchObject({ status: 409, code: "upload_not_writable" });
    } finally { release(); }
    const [project, retried] = await Promise.all([first, second]);
    expect(retried).toEqual(project);
    expect(project.personalOwnerUserId).toBe("user_importer");
    expect(importDirectory).toHaveBeenCalledTimes(1);
    expect(uploads.get(session.id)).toMatchObject({ status: "completed", projectId: project.id, ownerUserId: "user_importer" });
    await expect(uploads.uploadFile(session.id, "main.tex", content)).rejects.toMatchObject({ status: 409, code: "upload_not_writable" });
    await expect(uploads.cancel(session.id)).rejects.toMatchObject({ status: 409, code: "upload_completed" });
  });

  test("an incomplete completion releases the session so missing files can be uploaded and retried", async () => {
    const { uploads, session, importDirectory } = await testUploads();
    await expect(uploads.complete(session.id)).rejects.toMatchObject({ status: 409, code: "upload_incomplete" });
    await uploads.uploadFile(session.id, "main.tex", content);
    const project = await uploads.complete(session.id);
    expect(project.personalOwnerUserId).toBe("user_importer");
    expect(importDirectory).toHaveBeenCalledTimes(1);
  });

  test("a failed import releases the queue and remains closed to further file writes", async () => {
    const { uploads, session, importDirectory } = await testUploads(async () => { throw new Error("workspace import failed"); });
    await uploads.uploadFile(session.id, "main.tex", content);
    await expect(uploads.complete(session.id)).rejects.toThrow("workspace import failed");
    expect(uploads.get(session.id)).toMatchObject({ status: "failed", ownerUserId: "user_importer" });
    await expect(uploads.complete(session.id)).rejects.toMatchObject({ status: 409, code: "upload_not_writable" });
    await expect(uploads.uploadFile(session.id, "main.tex", content)).rejects.toMatchObject({ status: 409, code: "upload_not_writable" });
    await uploads.cancel(session.id);
    expect(uploads.get(session.id).status).toBe("cancelled");
    expect(importDirectory).toHaveBeenCalledTimes(1);
  });
});
