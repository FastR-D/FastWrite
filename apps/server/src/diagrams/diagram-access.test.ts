import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApplication } from "../app";

test("diagram routes require login and isolate records, parents and exports between accounts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-diagram-access-"));
  const app = await createApplication(directory, { features: { serverAuth: true }, bootstrapAdmin: { email: "admin@example.test", password: "test-password-long-enough" } });
  const request = (path: string, token?: string, method = "GET", body?: unknown) => app(new Request(`http://test${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  try {
    const owner = await (await request("/api/auth/register", undefined, "POST", { email: "owner@example.test", password: "test-password-long-enough" })).json() as { token: string; user: { id: string } };
    const other = await (await request("/api/auth/register", undefined, "POST", { email: "other@example.test", password: "test-password-long-enough" })).json() as { token: string };
    const scene = { version: 1, title: "Private", width: 1200, height: 720, nodes: [{ id: "one", label: "Evidence", shape: "roundRect", x: 80, y: 100, width: 250, height: 120, fill: "#EAF1E3", color: "#294D3A" }], edges: [] };
    for (const [path, method] of [["/api/diagrams", "GET"], ["/api/diagrams", "POST"], ["/api/diagrams/generate", "POST"]]) expect((await request(path!, undefined, method!, method === "GET" ? undefined : {})).status).toBe(401);
    const saved = await (await request("/api/diagrams", owner.token, "POST", { scene })).json() as { id: string; ownerUserId: string };
    expect(saved.ownerUserId).toBe(owner.user.id);
    expect(await (await request("/api/diagrams", other.token)).json()).toEqual([]);
    for (const suffix of ["", "/export/svg", "/export/drawio", "/export/pptx"]) {
      expect((await request(`/api/diagrams/${saved.id}${suffix}`)).status).toBe(401);
      expect((await request(`/api/diagrams/${saved.id}${suffix}`, other.token)).status).toBe(404);
      expect((await request(`/api/diagrams/${saved.id}${suffix}`, owner.token)).status).toBe(200);
    }
    expect((await request("/api/diagrams", other.token, "POST", { scene, parentId: saved.id })).status).toBe(404);
    expect((await request("/api/diagrams/generate", other.token, "POST", { instruction: "edit", parentId: saved.id })).status).toBe(404);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
