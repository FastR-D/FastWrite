import { describe, expect, test } from "bun:test";
import { createApplication } from "../app";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("external adapter API", () => {
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
