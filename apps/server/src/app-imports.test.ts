import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileContentResponse, PaperProject, UploadSession } from "@fastwrite/shared";
import { createApplication } from "./app";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function importApplication(serverAuth = true) {
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-import-auth-"));
  temporaryDirectories.push(directory);
  const app = await createApplication(directory, { features: { serverAuth } });
  return { directory, request: (path: string, init?: RequestInit) => app(new Request(`http://fastwrite.test${path}`, init)) };
}

type RequestApplication = Awaited<ReturnType<typeof importApplication>>["request"];

async function register(request: RequestApplication, email: string) {
  const response = await request("/api/auth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct-horse-battery-staple" })
  });
  expect(response.status).toBe(201);
  return await response.json() as { token: string; user: { id: string } };
}

const sources = [
  ["main.tex", "\\documentclass{article}\n\\begin{document}\\input{sections/intro}\\bibliography{refs}\\end{document}"],
  ["sections/intro.tex", "\\section{Introduction}\nImported paper \\cite{example}."],
  ["refs.bib", "@article{example, title={Imported Reference}, year={2026}}"]
] as const;

function manifest(ownerUserId?: string) {
  return JSON.stringify({
    projectName: "Private imported paper", mainDocument: "main.tex", venue: "network-information-security", sourceName: "paper-folder",
    entries: sources.map(([path, content]) => ({ path, kind: "file", size: new TextEncoder().encode(content).byteLength })),
    ...(ownerUserId ? { ownerUserId } : {})
  });
}

describe("authenticated project imports", () => {
  test("keeps upload sessions private and registers the importer as the project owner", async () => {
    const { directory, request } = await importApplication();
    await register(request, "admin@example.test");
    const owner = await register(request, "importer@example.test");
    const stranger = await register(request, "stranger@example.test");
    const ownerHeaders = { authorization: `Bearer ${owner.token}` };
    const strangerHeaders = { authorization: `Bearer ${stranger.token}` };
    const created = await request("/api/upload-sessions", {
      method: "POST", headers: { ...ownerHeaders, "content-type": "application/json" }, body: manifest(stranger.user.id)
    });
    expect(created.status).toBe(201);
    const session = await created.json() as UploadSession;
    expect(session.ownerUserId).toBe(owner.user.id);

    for (const [path, method, body] of [
      [`/api/upload-sessions/${session.id}`, "GET", undefined],
      [`/api/upload-sessions/${session.id}/files?path=main.tex`, "PUT", new TextEncoder().encode(sources[0][1])],
      [`/api/upload-sessions/${session.id}/complete`, "POST", undefined],
      [`/api/upload-sessions/${session.id}`, "DELETE", undefined]
    ] as const) {
      expect((await request(path, { method, headers: strangerHeaders, ...(body ? { body } : {}) })).status).toBe(403);
      expect((await request(path, { method, ...(body ? { body } : {}) })).status).toBe(401);
    }
    expect((await request(`/api/upload-sessions/${session.id}`, { headers: ownerHeaders })).status).toBe(200);
    expect((await request(`/api/upload-sessions/${session.id}/complete`, { method: "POST", headers: ownerHeaders })).status).toBe(409);
    for (const [path, content] of sources) {
      expect((await request(`/api/upload-sessions/${session.id}/files?path=${encodeURIComponent(path)}`, {
        method: "PUT", headers: ownerHeaders, body: new TextEncoder().encode(content)
      })).status).toBe(200);
    }
    const completed = await request(`/api/upload-sessions/${session.id}/complete`, { method: "POST", headers: ownerHeaders });
    expect(completed.status).toBe(201);
    const project = await completed.json() as PaperProject;
    expect(project).toMatchObject({ personalOwnerUserId: owner.user.id, visibility: "private" });
    const retried = await request(`/api/upload-sessions/${session.id}/complete`, { method: "POST", headers: ownerHeaders });
    expect(retried.status).toBe(201);
    expect(await retried.json()).toMatchObject({ id: project.id, personalOwnerUserId: owner.user.id });
    expect((await request(`/api/upload-sessions/${session.id}/complete`, { method: "POST", headers: strangerHeaders })).status).toBe(403);
    expect(await (await request("/api/projects", { headers: ownerHeaders })).json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: project.id })]));
    expect(await (await request("/api/projects", { headers: strangerHeaders })).json()).toEqual([]);
    expect((await request(`/api/projects/${project.id}`, { headers: strangerHeaders })).status).toBe(403);
    expect(await (await request(`/api/projects/${project.id}/members`, { headers: ownerHeaders })).json()).toMatchObject({ members: expect.arrayContaining([expect.objectContaining({ userId: owner.user.id, role: "owner" })]) });
    for (const [path, content] of sources) {
      const opened = await request(`/api/projects/${project.id}/file?path=${encodeURIComponent(path)}`, { headers: ownerHeaders });
      expect(opened.status).toBe(200);
      expect((await opened.json() as FileContentResponse).content).toBe(content);
    }
    const persisted = await createApplication(directory, { features: { serverAuth: true } });
    expect((await persisted(new Request(`http://fastwrite.test/api/projects/${project.id}`, { headers: ownerHeaders }))).status).toBe(200);
    expect((await persisted(new Request(`http://fastwrite.test/api/upload-sessions/${session.id}`, { headers: strangerHeaders }))).status).toBe(403);
  });

  test("requires authentication before creating directory or GitHub imports", async () => {
    const { request } = await importApplication();
    expect((await request("/api/upload-sessions", { method: "POST", headers: { "content-type": "application/json" }, body: manifest() })).status).toBe(401);
    expect((await request("/api/project-imports/github", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repository: "https://github.com/example/paper" }) })).status).toBe(401);
    expect((await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Anonymous template", initializeFromTemplate: true }) })).status).toBe(401);
  });

  test("does not let an authenticated user claim an ownerless legacy upload", async () => {
    const { directory, request } = await importApplication(false);
    const response = await request("/api/upload-sessions", { method: "POST", headers: { "content-type": "application/json" }, body: manifest() });
    expect(response.status).toBe(201);
    const session = await response.json() as UploadSession;
    const authenticated = await createApplication(directory, { features: { serverAuth: true } });
    const authenticatedRequest: RequestApplication = (path, init) => authenticated(new Request(`http://fastwrite.test${path}`, init));
    const user = await register(authenticatedRequest, "new-user@example.test");
    for (const [path, method] of [
      [`/api/upload-sessions/${session.id}`, "GET"],
      [`/api/upload-sessions/${session.id}/files?path=main.tex`, "PUT"],
      [`/api/upload-sessions/${session.id}/complete`, "POST"],
      [`/api/upload-sessions/${session.id}`, "DELETE"]
    ] as const) {
      expect((await authenticatedRequest(path, { method, headers: { authorization: `Bearer ${user.token}` } })).status).toBe(403);
    }
  });
});
