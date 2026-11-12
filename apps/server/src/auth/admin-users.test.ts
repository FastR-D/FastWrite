import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../app";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const admin = { email: "admin@example.test", password: "admin-testing-password" };
const input = { email: "member@example.test", password: "member-testing-password", displayName: "成员", platformRole: "user", status: "active", reason: "测试管理员创建用户操作" };
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "fastwrite-admin-users-")); directories.push(path);
  const app = await createApplication(path, { features: { serverAuth: true }, bootstrapAdmin: admin });
  const request = (url: string, method = "GET", body?: unknown, token?: string) => app(new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  const login = await (await request("/api/auth/login", "POST", admin)).json() as any;
  return { request, token: login.token as string, adminId: login.user.id as string };
}
test("deployment rejects public registration but administrator creates users without replacing their own session", async () => {
  const { request, token, adminId } = await fixture();
  expect((await request("/api/auth/providers")).status).toBe(200);
  expect(await (await request("/api/auth/providers")).json()).toMatchObject({ registration: false });
  expect((await request("/api/auth/register", "POST", input)).status).toBe(403);
  expect((await request("/api/admin/users", "POST", input)).status).toBe(401);
  const created = await request("/api/admin/users", "POST", input, token);
  expect(created.status).toBe(201); expect(created.headers.get("set-cookie")).toBeNull();
  const user = await created.json() as any;
  expect(user).toMatchObject({ displayName: "成员", platformRole: "user" }); expect(user.passwordHash).toBeUndefined();
  expect(await (await request("/api/auth/me", "GET", undefined, token)).json()).toMatchObject({ id: adminId });
  const member = await (await request("/api/auth/login", "POST", input)).json() as any;
  expect((await request("/api/admin/users", "POST", { ...input, email: "another@example.test" }, member.token)).status).toBe(403);
  expect((await request("/api/admin/users", "POST", input, token)).status).toBe(409);
});
test("editing updates login credentials, revokes sessions and enforces administrator protections", async () => {
  const { request, token, adminId } = await fixture();
  const user = await (await request("/api/admin/users", "POST", input, token)).json() as any;
  const login = await (await request("/api/auth/login", "POST", input)).json() as any;
  const changed = { ...input, email: "changed@example.test", displayName: "新名称", password: "new-member-testing-password" };
  expect((await request(`/api/admin/users/${user.id}`, "PATCH", changed, token)).status).toBe(200);
  expect((await request("/api/auth/me", "GET", undefined, login.token)).status).toBe(401);
  expect((await request("/api/auth/login", "POST", input)).status).toBe(401);
  expect((await request("/api/auth/login", "POST", changed)).status).toBe(200);
  expect((await request(`/api/admin/users/${adminId}`, "PATCH", { ...input, ...admin, status: "disabled" }, token)).status).toBe(409);
  expect((await request(`/api/admin/users/${adminId}`, "DELETE", { reason: input.reason }, token)).status).toBe(409);
  expect((await request(`/api/admin/users/${adminId}`, "PATCH", { ...input, ...admin, platformRole: "user" }, token)).status).toBe(409);
});
test("user team management protects last owners; deletion removes access and requires ownership transfer", async () => {
  const { request, token } = await fixture();
  const user = await (await request("/api/admin/users", "POST", input, token)).json() as any;
  const member = await (await request("/api/auth/login", "POST", input)).json() as any;
  const team = await (await request("/api/teams", "POST", { name: "测试团队" }, token)).json() as any;
  const url = `/api/admin/users/${user.id}/teams/${team.id}`;
  expect((await request(url, "PUT", { role: "admin", reason: input.reason }, member.token)).status).toBe(403);
  expect((await request(url, "PUT", { role: "admin", reason: input.reason }, token)).status).toBe(204);
  expect(await (await request(`/api/admin/users/${user.id}/teams`, "GET", undefined, token)).json()).toContainEqual({ id: team.id, name: team.name, role: "admin" });
  expect((await request(url, "PUT", { role: "", reason: input.reason }, token)).status).toBe(204);
  const owned = await (await request("/api/teams", "POST", { name: "成员拥有的团队" }, member.token)).json() as any;
  expect((await request(`/api/admin/users/${user.id}/teams/${owned.id}`, "PUT", { role: "member", reason: input.reason }, token)).status).toBe(409);
  expect((await request(`/api/admin/users/${user.id}`, "DELETE", { reason: input.reason }, token)).status).toBe(409);
  const adminUser = await (await request("/api/auth/me", "GET", undefined, token)).json() as any;
  expect((await request(`/api/admin/users/${adminUser.id}/teams/${owned.id}`, "PUT", { role: "owner", reason: input.reason }, token)).status).toBe(204);
  expect((await request(`/api/admin/users/${user.id}/teams/${owned.id}`, "PUT", { role: "member", reason: input.reason }, token)).status).toBe(204);
  expect((await request(`/api/admin/users/${user.id}`, "DELETE", { reason: "" }, token)).status).toBe(400);
  expect((await request(`/api/admin/users/${user.id}`, "DELETE", { reason: input.reason }, token)).status).toBe(204);
  expect((await request("/api/auth/me", "GET", undefined, member.token)).status).toBe(401);
  expect((await request("/api/auth/login", "POST", input)).status).toBe(401);
});
