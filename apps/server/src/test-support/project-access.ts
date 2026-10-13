import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApplication } from "../app";

export async function projectAccessFixture(options: Parameters<typeof createApplication>[1] = {}) {
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-access-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const app = await createApplication(directory, { ...options, features: { serverAuth: true }, bootstrapAdmin: { email: "admin@example.test", password: "fixture-password-long-enough" } });
    const request = (path: string, token?: string, method = "GET", body?: unknown) => app(new Request("http://test" + path, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }));
    const json = async (path: string, token?: string, method = "GET", body?: unknown) => { const response = await request(path, token, method, body); expect(response.status).toBeLessThan(300); return await response.json() as any; };
    const owner = await json("/api/auth/register", undefined, "POST", { email: "owner@example.test", password: "fixture-password-long-enough" });
    const member = await json("/api/auth/register", undefined, "POST", { email: "member@example.test", password: "fixture-password-long-enough" });
    const project = await json("/api/projects", owner.token, "POST", { name: "Path permissions" });
    const base = "/api/projects/" + project.id;
    const invite = await json(base + "/invitations", owner.token, "POST", { email: "member@example.test", role: "maintainer" });
    await json("/api/invitations/" + invite.token + "/accept", member.token, "POST");
    const deny = (pathPrefix: string, action = "read") => json(base + "/acl/new", owner.token, "PUT", { pathPrefix, subjectType: "user", subjectId: member.user.id, action, effect: "deny" });
    return { app, directory, request, json, owner, member, project, base, deny, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
