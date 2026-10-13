import { describe, expect, test } from "bun:test";
import { createApplication } from "../app";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("external adapter API", () => {
  test("a project maintainer cannot override the server's adapter destination", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fastwrite-adapter-auth-"));
    let calls = 0;
    try {
      const app = await createApplication(directory, {
        features: { serverAuth: true }, bootstrapAdmin: { email: "admin@example.test", password: "fixture-password-long-enough" },
        researchAdapterBaseUrls: { zotero: "http://127.0.0.1:23119" },
        researchFetcher: async (input) => { calls++; expect(String(input)).toBe("http://127.0.0.1:23119/health"); return Response.json({ ok: true }); }
      });
      const request = (path: string, token?: string, body?: unknown) => app(new Request("http://test" + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) }));
      const owner = await (await request("/api/auth/register", undefined, { email: "owner@example.test", password: "fixture-password-long-enough" })).json() as any;
      const member = await (await request("/api/auth/register", undefined, { email: "member@example.test", password: "fixture-password-long-enough" })).json() as any;
      const project = await (await request("/api/projects", owner.token, { name: "Adapter permissions" })).json() as any;
      const base = "/api/projects/" + project.id;
      const invite = await (await request(base + "/invitations", owner.token, { email: "member@example.test", role: "maintainer" })).json() as any;
      expect((await request("/api/invitations/" + invite.token + "/accept", member.token)).status).toBe(200);
      const call = (baseUrl?: string) => request(base + "/research-adapters/zotero", member.token, { baseUrl, operation: "health", authorized: true });
      expect((await call("http://127.0.0.1:9999/internal/admin#")).status).toBe(400);
      expect((await call("http://127.0.0.1:9999")).status).toBe(403);
      expect(calls).toBe(0);
      expect((await call()).status).toBe(200);
      expect(calls).toBe(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  test("requires project and explicit authorization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fastwrite-adapter-"));
    try {
      const app = await createApplication(directory, { researchFetcher: async (_input, init) => new Response(JSON.stringify({ ok: true, method: init?.method })) as Response });
      const project = await (await app(new Request("http://fastwrite.local/api/projects", { method: "POST", body: JSON.stringify({ name: "Adapter" }), headers: { "content-type": "application/json" } }))).json() as { id: string };
      const response = await app(new Request(`http://fastwrite.local/api/projects/${project.id}/research-adapters/zotero`, { method: "POST", body: JSON.stringify({ baseUrl: "http://127.0.0.1:23119", operation: "health" }), headers: { "content-type": "application/json" } }));
      expect(response.status).toBe(403);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
