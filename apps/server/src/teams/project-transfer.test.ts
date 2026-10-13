import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApplication } from "../app";
import { JsonDatabase } from "../storage/database";

for (const legacy of [false, true]) test(`transferred projects have one protected owner${legacy ? " with legacy owner memberships" : ""}`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-transfer-"));
  try {
    const options = { features: { serverAuth: true }, bootstrapAdmin: { email: "admin@example.test", password: "fixture-password-long-enough" } };
    let app = await createApplication(directory, options);
    const request = (path: string, token?: string, method = "GET", body?: unknown) => app(new Request("http://test" + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const json = async (path: string, token?: string, method = "GET", body?: unknown) => { const response = await request(path, token, method, body); expect(response.status).toBeLessThan(300); return await response.json() as any; };
    const oldOwner = await json("/api/auth/register", undefined, "POST", { email: "old@example.test", password: "fixture-password-long-enough" });
    const newOwner = await json("/api/auth/register", undefined, "POST", { email: "new@example.test", password: "fixture-password-long-enough" });
    const project = await json("/api/projects", oldOwner.token, "POST", { name: "Ownership transfer" });
    const base = "/api/projects/" + project.id;
    await json(base + "/transfer", oldOwner.token, "POST", { personalOwnerUserId: newOwner.user.id });
    if (legacy) {
      // Simulate a persisted project transferred by an older server, then restart.
      const database = new JsonDatabase(directory); await database.initialize();
      await database.mutate(state => { state.projectMembers.find(member => member.projectId === project.id && member.userId === oldOwner.user.id)!.role = "owner"; });
      app = await createApplication(directory, options);
    } else {
      const membership = await json(base + "/members", newOwner.token);
      expect(membership.members.filter((member: any) => member.role === "owner").map((member: any) => member.userId)).toEqual([newOwner.user.id]);
    }
    expect((await request(base + "/transfer", oldOwner.token, "POST", { personalOwnerUserId: oldOwner.user.id })).status).toBe(403);
    expect((await request(base + "/members/" + newOwner.user.id, newOwner.token, "DELETE")).status).toBe(409);
    await json(base + "/members/" + oldOwner.user.id, newOwner.token, "PATCH", { role: "viewer" });
    expect((await request(base + "/members/" + oldOwner.user.id, newOwner.token, "DELETE")).status).toBe(204);
    expect((await request(base, oldOwner.token)).status).toBe(403);
    expect((await json(base, newOwner.token)).personalOwnerUserId).toBe(newOwner.user.id);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
