import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../app";
import fixture from "./fixtures/fastread-bundle.json";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-read-integration-")); directories.push(directory);
  const app = await createApplication(directory, { bootstrapAdmin: { email: "admin@example.test", password: "admin-password-2026" } });
  const request = (path: string, method = "GET", token = "", body?: unknown) => app(new Request(`http://fastwrite.test${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const owner = await (await request("/api/auth/register", "POST", "", { email: "owner@example.test", password: "owner-password-2026" })).json() as { token: string; user: { id: string } };
  const other = await (await request("/api/auth/register", "POST", "", { email: "other@example.test", password: "other-password-2026" })).json() as { token: string; user: { id: string } };
  const project = await (await request("/api/projects", "POST", owner.token, { name: "Reading evidence" })).json() as { id: string };
  const privateProject = await (await request("/api/projects", "POST", other.token, { name: "Other project" })).json() as { id: string };
  const connectionResponse = await request("/api/integrations/fastread/token", "POST", owner.token); expect(connectionResponse.status).toBe(201);
  const connection = await connectionResponse.json() as { token: string };
  return { directory, request, owner, other, project, privateProject, connection };
}

test("FastRead connection is explicit, hashed, revocable and scoped to writable projects", async () => {
  const { directory, request, owner, project, privateProject, connection } = await setup();
  expect((await request("/api/integrations/fastread/token")).status).toBe(401);
  expect(await (await request("/api/integrations/fastread/token", "GET", connection.token)).json()).toEqual({ connected: true });
  const listed = await (await request("/api/integrations/fastread/projects", "GET", connection.token)).json() as { items: Array<{ id: string }> };
  expect(listed.items.map(item => item.id)).toContain(project.id); expect(listed.items.map(item => item.id)).not.toContain(privateProject.id);
  expect((await request(`/api/integrations/fastread/projects/${privateProject.id}/bundles`, "POST", connection.token, fixture)).status).toBe(403);
  expect(await readFile(join(directory, "database.json"), "utf8")).not.toContain(connection.token);
  const rotated = await (await request("/api/integrations/fastread/token", "POST", owner.token)).json() as { token: string };
  expect((await request("/api/integrations/fastread/token", "GET", connection.token)).status).toBe(401);
  expect((await request("/api/integrations/fastread/token", "DELETE", owner.token)).status).toBe(200);
  expect((await request("/api/integrations/fastread/token", "GET", rotated.token)).status).toBe(401);
});

test("Go FastRead bundle imports idempotently and returns writing feedback to its source paper", async () => {
  const { request, owner, project, connection } = await setup();
  const path = `/api/integrations/fastread/projects/${project.id}/bundles`;
  const first = await request(path, "POST", connection.token, fixture); expect(first.status).toBe(201);
  const result = await first.json() as { ok: boolean; receipts: Array<{ status: string; evidenceIds: string[] }> }; expect(result.ok).toBe(true); expect(result.receipts[0]?.status).toBe("imported"); expect(result.receipts[0]?.evidenceIds).toHaveLength(1);
  expect((await request(path, "POST", connection.token, fixture)).status).toBe(201);
  const changed = structuredClone(fixture); changed.files[0]!.content += "Different content";
  expect((await request(path, "POST", connection.token, changed)).status).toBe(409);
  const saved = await request(`/api/projects/${project.id}/research/fastread-feedback`, "PUT", owner.token, { paper_id: "fixture-paper", title: "Methods section", content: "Use the page-linked evidence workflow in our methods discussion." }); expect(saved.status).toBe(200);
  const response = await request(`/api/integrations/fastread/projects/${project.id}/feedback`, "GET", connection.token); expect(response.status).toBe(200);
  const feedback = await response.json() as { items: Array<{ paper_id: string; content: string }>; papers: Array<{ id: string }> };
  expect(feedback.papers.map(paper => paper.id)).toEqual(["fixture-paper"]); expect(feedback.items.some(item => item.paper_id === "fixture-paper" && item.content.includes("methods discussion"))).toBe(true);
  expect(feedback.items.some(item => item.content.includes("The method preserves page-linked evidence."))).toBe(true);
});

test("FastRead writes respect path ACLs and never leave the bundle directory", async () => {
  const { request, owner, project, connection } = await setup();
  const bad = structuredClone(fixture); bad.files[0]!.path = "main.tex";
  expect((await request(`/api/integrations/fastread/projects/${project.id}/bundles`, "POST", connection.token, bad)).status).toBe(400);
  const acl = await request(`/api/projects/${project.id}/acl/new`, "PUT", owner.token, { pathPrefix: "references/fastread", subjectType: "user", subjectId: owner.user.id, action: "edit", effect: "deny" }); expect(acl.status).toBe(200);
  expect((await request(`/api/integrations/fastread/projects/${project.id}/bundles`, "POST", connection.token, fixture)).status).toBe(403);
  const listed = await (await request("/api/integrations/fastread/projects", "GET", connection.token)).json() as { items: unknown[] }; expect(listed.items).toEqual([]);
});

test("disabling an account invalidates its existing FastRead connection", async () => {
  const { request, owner, connection } = await setup();
  const admin = await (await request("/api/auth/login", "POST", "", { email: "admin@example.test", password: "admin-password-2026" })).json() as { token: string };
  expect((await request(`/api/admin/users/${owner.user.id}/disable`, "POST", admin.token, { reason: "Integration access test" })).status).toBe(204);
  expect((await request("/api/integrations/fastread/projects", "GET", connection.token)).status).toBe(401);
});
