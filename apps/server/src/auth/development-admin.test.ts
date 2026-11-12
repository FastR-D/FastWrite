import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionAccount } from "../../test-support/accounts";
import { AuthService } from "./auth-service";
import { JsonDatabase } from "../storage/database";
import { createApplication } from "../app";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-dev-admin-"));
  directories.push(directory);
  const database = new JsonDatabase(directory);
  await database.initialize();
  return { directory, database };
}

test("development administrator has global access without reusable login credentials", async () => {
  const { directory } = await fixture();
  const app = await createApplication(directory, { developmentAdmin: true, features: { serverAuth: true } });
  const response = await app(new Request("http://localhost/api/auth/dev-session", { method: "POST" }));
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toBeNull();
  const { user, token } = await response.json() as { user: { platformRole: string }; token: string };
  expect(user.platformRole).toBe("platform_admin");
  for (const path of ["/api/auth/me", "/api/admin/health", "/api/admin/users", "/api/projects"]) {
    expect((await app(new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${token}` } }))).status).toBe(200);
  }
  const registration = await provisionAccount(app, new Request("http://localhost/test/accounts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "member@example.test", password: "ordinary-member-password" }) }), { token });
  const member = await registration.json() as { token: string };
  const project = await app(new Request("http://localhost/api/projects", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${member.token}` }, body: JSON.stringify({ name: "Member private project", mainDocument: "main.tex", venue: "general" }) }));
  expect(project.status).toBe(201);
  const projects = await app(new Request("http://localhost/api/projects", { headers: { authorization: `Bearer ${token}` } }));
  expect((await projects.json() as Array<{ name: string }>).map(project => project.name)).toContain("Member private project");
  const main = await createApplication(directory, { developmentAdmin: false, features: { serverAuth: true }, bootstrapAdmin: { email: "real-admin@example.test", password: "unique-real-admin-password" } });
  expect((await main(new Request("http://localhost/api/auth/dev-session", { method: "POST" }))).status).toBe(404);
  expect((await main(new Request("http://localhost/api/auth/me", { headers: { authorization: `Bearer ${token}` } }))).status).toBe(401);
  expect((await main(new Request("http://localhost/api/admin/health"))).status).toBe(401);
  expect(await (await main(new Request("http://localhost/api/projects"))).json()).toEqual([]);
});

test("development sessions and collaboration grants are rejected outside development", async () => {
  const { database } = await fixture();
  const dev = new AuthService(database, "same-room-secret", true);
  const result = await dev.developmentSession();
  const request = new Request("http://localhost/api/auth/me", { headers: { authorization: `Bearer ${result.token}` } });
  const principal = dev.principal(request)!;
  const room = dev.issueCollaborationRoomToken(principal, { projectId: "project", path: "main.tex", scope: "read" });
  const main = new AuthService(database, "same-room-secret");
  expect(() => main.principal(request)).toThrow("Your session has expired");
  expect(() => main.collaborationRoomGrant(room.token)).toThrow();
  await expect(main.ensureBootstrapAdmin()).rejects.toThrow("No active administrator exists");
  await expect(main.developmentSession()).rejects.toMatchObject({ status: 404 });
  expect(database.snapshot().localCredentials).toHaveLength(0);
  expect(database.snapshot().externalIdentities).toHaveLength(0);
});
