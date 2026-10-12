import { expect, test, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApplication } from "../app";
import { GithubService } from "./github-service";

test("project creation and upload lifecycle authenticate before side effects and preserve ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-import-access-"));
  const app = await createApplication(directory, { features: { serverAuth: true }, bootstrapAdmin: { email: "admin@example.test", password: "test-password-long-enough" } });
  const request = (path: string, token?: string, method = "GET", body?: unknown) => app(new Request(`http://test${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }));
  const github = spyOn(GithubService.prototype, "import");
  try {
    const owner = await (await request("/api/auth/register", undefined, "POST", { email: "owner@example.test", password: "test-password-long-enough" })).json() as any;
    const other = await (await request("/api/auth/register", undefined, "POST", { email: "other@example.test", password: "test-password-long-enough" })).json() as any;
    for (const path of ["/api/projects", "/api/upload-sessions", "/api/project-imports/github"]) expect((await request(path, undefined, "POST", {})).status).toBe(401);
    expect(github).not.toHaveBeenCalled();
    expect((await request("/api/projects", owner.token, "POST", { name: "Denied team", teamId: "someone-elses-team" })).status).toBe(403);
    expect(await (await request("/api/projects", owner.token)).json()).toEqual([]);
    const created = await (await request("/api/projects", owner.token, "POST", { name: "Owned" })).json() as any;
    expect(created.personalOwnerUserId).toBe(owner.user.id);
    const content = "\\documentclass{article}\n\\begin{document}Test\\end{document}\n";
    const upload = await (await request("/api/upload-sessions", owner.token, "POST", { projectName: "Import", mainDocument: "main.tex", venue: "network-information-security", sourceName: "test", entries: [{ kind: "file", path: "main.tex", size: Buffer.byteLength(content) }] })).json() as any;
    expect(upload.ownerUserId).toBe(owner.user.id);
    const base = `/api/upload-sessions/${upload.id}`;
    for (const [suffix, method] of [["", "GET"], ["/files?path=main.tex", "PUT"], ["/complete", "POST"], ["", "DELETE"]]) {
      for (const [token, status] of [[undefined, 401], [other.token, 404]] as const) expect((await request(base + suffix, token, method!, method === "PUT" ? content : undefined)).status).toBe(status);
    }
    expect((await request(base + "/files?path=main.tex", owner.token, "PUT", content)).status).toBe(200);
    const response = await request(base + "/complete", owner.token, "POST");
    expect(response.status).toBe(201);
    const project = await response.json() as any;
    expect(project.personalOwnerUserId).toBe(owner.user.id);
    expect((await request(`/api/projects/${project.id}`, owner.token)).status).toBe(200);
    expect((await request(`/api/projects/${project.id}`, other.token)).status).toBe(403);
    expect((await (await request("/api/projects", owner.token)).json() as any[]).map(p => p.id)).toContain(project.id);
  } finally { github.mockRestore(); await rm(directory, { recursive: true, force: true }); }
});
