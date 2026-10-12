import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexHarnessAdapter } from "@fastwrite/harness-codex";
import { ClaudeHarnessAdapter } from "@fastwrite/harness-claude";
import type { SendMessageInput } from "@fastwrite/harness-core";
import { createApplication } from "./app";
import { createServerOptions } from "./server";
import { AuthService } from "./auth/auth-service";
import { JsonDatabase } from "./storage/database";
import { harnessEventBus } from "./agent/harness-event-bus";

const directories: string[] = [];
const cleanup: Array<() => void> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0)) stop();
  mock.restore();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture(serverAuth = true) {
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-harness-auth-"));
  directories.push(directory);
  const database = new JsonDatabase(directory);
  await database.initialize();
  const auth = new AuthService(database);
  const adminCredentials = { email: "admin@example.test", password: "test-password-long-enough" };
  await auth.ensureBootstrapAdmin(adminCredentials);
  const admin = await auth.login(adminCredentials);
  const user = await auth.register({ email: "user@example.test", password: "test-password-long-enough" });
  const auditor = await auth.register({ email: "auditor@example.test", password: "test-password-long-enough" });
  const timestamp = new Date().toISOString();
  const runId = `run_${crypto.randomUUID()}`;
  await database.mutate(state => {
    state.users.find(item => item.id === auditor.user.id)!.platformRole = "support_auditor";
    state.harnessSessions.push({ harness: "codex", sessionId: "private-session", cwd: directory, createdAt: timestamp, updatedAt: timestamp });
    state.harnessRuns.push({ id: runId, session: state.harnessSessions[0]!, actorUserId: admin.user.id, status: "running", skills: [], events: [{ type: "assistant.delta", runId, text: "Private manuscript" }], approvals: [{ id: "private-approval", runId, status: "pending", reason: "Private tool call", createdAt: timestamp, updatedAt: timestamp }], createdAt: timestamp, updatedAt: timestamp });
  });
  const app = await createApplication(directory, { features: { serverAuth } });
  const request = (path: string, token?: string, method = "GET", body?: unknown) => app(new Request(`http://fastwrite.test${path}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  }));
  return { app, request, admin, user, auditor, runId, directory };
}

test("raw Harness routes reject anonymous and non-admin callers before reading data or invoking adapters", async () => {
  const { request, admin, user, auditor, runId } = await fixture();
  const create = spyOn(CodexHarnessAdapter.prototype, "createSession");
  const resume = spyOn(CodexHarnessAdapter.prototype, "resumeSession");
  const send = spyOn(CodexHarnessAdapter.prototype, "sendMessage");
  const approve = spyOn(CodexHarnessAdapter.prototype, "resolveApproval");
  const routes: Array<[string, string]> = [
    ["GET", "/api/harness-sessions"], ["GET", "/api/harness-runs"],
    ["GET", `/api/harness-runs/${runId}`], ["GET", `/api/harness-runs/${runId}/events`],
    ["GET", `/api/harness-runs/${runId}/approvals`], ["GET", "/api/mcp/audit"],
    ["PUT", "/api/harness-settings"], ["POST", "/api/harness-approvals/private-approval"],
    ["POST", "/api/harness-runs"], ["POST", "/api/harnesses/codex/sessions"],
    ["POST", "/api/harnesses/codex/sessions/private-session/resume"],
    ["POST", "/api/harnesses/codex/sessions/private-session/messages"],
    ["POST", "/api/harnesses/claude/sessions"]
  ];
  const body = { cwd: "C:/", sessionId: "private-session", kind: "codex", content: "run a task", decision: "approved" };
  for (const [method, path] of routes) {
    for (const [token, status] of [[undefined, 401], ["invalid", 401], [user.token, 403], [auditor.token, 403]] as const) {
      expect((await request(path, token, method, method === "GET" ? undefined : body)).status, `${method} ${path}`).toBe(status);
    }
  }
  // The same guards apply to the route helper's optional trailing slash.
  expect((await request("/api/harness-runs/", user.token)).status).toBe(403);
  for (const operation of [create, resume, send, approve]) expect(operation).not.toHaveBeenCalled();
  expect((await request(`/api/harness-runs/${runId}/approvals`, admin.token)).status).toBe(200);
  expect(await (await request(`/api/harness-runs/${runId}/approvals`, admin.token)).json()).toMatchObject([{ status: "pending" }]);
});

test("Harness discovery requires login and only admins can change shared settings", async () => {
  const { request, admin, user } = await fixture();
  spyOn(CodexHarnessAdapter.prototype, "getStatus").mockResolvedValue({ kind: "codex", state: "ready" });
  spyOn(ClaudeHarnessAdapter.prototype, "getStatus").mockResolvedValue({ kind: "claude", state: "ready" });
  for (const path of ["/api/harnesses", "/api/harness-settings", "/api/mcp"]) {
    expect((await request(path)).status).toBe(401);
    expect((await request(path, user.token)).status).toBe(200);
  }
  const settings = { apiKey: "test-only-key", baseURL: "https://model.example.test", model: "test-model", wireAPI: "chat" };
  expect((await request("/api/harness-settings", user.token, "PUT", settings)).status).toBe(403);
  expect((await request("/api/harness-settings", admin.token, "PUT", settings)).status).toBe(200);
  expect(JSON.stringify(await (await request("/api/harness-settings", user.token)).json())).not.toContain(settings.apiKey);
});

test("Harness admins retain raw session, run and approval operations", async () => {
  const { request, admin, directory, runId } = await fixture();
  spyOn(CodexHarnessAdapter.prototype, "createSession").mockImplementation(async input => ({ harness: "codex", sessionId: "new-session", cwd: input.cwd }));
  spyOn(CodexHarnessAdapter.prototype, "resumeSession").mockImplementation(async session => session);
  spyOn(CodexHarnessAdapter.prototype, "sendMessage").mockImplementation(async function* (_input: SendMessageInput) {
    yield { type: "run.completed", runId: `run_${crypto.randomUUID()}` };
  });
  const approve = spyOn(CodexHarnessAdapter.prototype, "resolveApproval").mockResolvedValue(undefined);
  expect((await request("/api/harnesses/codex/sessions", admin.token, "POST", { cwd: directory })).status).toBe(201);
  expect((await request("/api/harnesses/codex/sessions/new-session/resume", admin.token, "POST", { cwd: directory })).status).toBe(200);
  expect((await request("/api/harnesses/codex/sessions/new-session/messages", admin.token, "POST", { cwd: directory, content: "Test" })).status).toBe(200);
  expect((await request("/api/harness-runs", admin.token, "POST", { kind: "codex", sessionId: "new-session", cwd: directory, content: "Test" })).status).toBe(201);
  expect((await request(`/api/harness-runs/${runId}/events`, admin.token)).status).toBe(200);
  expect((await request("/api/harness-approvals/private-approval", admin.token, "POST", { decision: "approved" })).status).toBe(200);
  expect(approve).toHaveBeenCalledTimes(1);
});

test("project MCP audit requires project permission and global audit requires an admin", async () => {
  const { request, admin, user, auditor } = await fixture();
  const project = await (await request("/api/projects", user.token, "POST", { name: "Private project" })).json() as { id: string };
  const path = `/api/mcp/audit?projectId=${project.id}`;
  expect((await request(path)).status).toBe(401);
  expect((await request(path, auditor.token)).status).toBe(403);
  expect((await request(path, user.token)).status).toBe(200);
  expect((await request("/api/mcp/audit", user.token)).status).toBe(403);
  expect((await request("/api/mcp/audit", admin.token)).status).toBe(200);
  expect((await request(`/api/projects/${project.id}/mcp/call`, undefined, "POST", { name: "workspace.read", input: { path: "main.tex" }, allow: ["workspace.read"] })).status).toBe(401);
});

test("local mode keeps its existing Harness access behavior", async () => {
  const { request, runId } = await fixture(false);
  for (const path of ["/api/harness-settings", "/api/harness-sessions", "/api/harness-runs", `/api/harness-runs/${runId}/events`, "/api/mcp", "/api/mcp/audit"]) {
    expect((await request(path)).status).toBe(200);
  }
  spyOn(CodexHarnessAdapter.prototype, "createSession").mockImplementation(async input => ({ harness: "codex", sessionId: "local-session", cwd: input.cwd }));
  expect((await request("/api/harnesses/codex/sessions", undefined, "POST", { cwd: "/tmp" })).status).toBe(201);
});

test("Harness sockets authorize before upgrading and stop delivering after logout", async () => {
  const { app, request, admin, user, runId } = await fixture();
  const options = createServerOptions(app);
  let data: unknown;
  const upgrade = mock((_request: Request, input: { data: unknown }) => { data = input.data; return true; });
  const server = { upgrade } as unknown as Parameters<typeof options.fetch>[1];
  const socketRequest = (token?: string, id = runId, origin?: string) => new Request(`http://fastwrite.test/api/harness/socket?runId=${id}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}) } });
  expect((await options.fetch(socketRequest(), server))?.status).toBe(401);
  expect((await options.fetch(new Request(`http://fastwrite.test/api/harness/socket?runId=${runId}&token=${admin.token}`), server))?.status).toBe(401);
  expect((await options.fetch(socketRequest("invalid"), server))?.status).toBe(401);
  expect((await options.fetch(socketRequest(user.token), server))?.status).toBe(403);
  expect((await options.fetch(socketRequest(admin.token, "missing"), server))?.status).toBe(404);
  expect((await options.fetch(socketRequest(admin.token, runId, "https://untrusted.example"), server))?.status).toBe(403);
  expect(upgrade).not.toHaveBeenCalled();
  expect(await options.fetch(socketRequest(admin.token, runId, "http://fastwrite.test"), server)).toBeUndefined();
  expect(upgrade).toHaveBeenCalledTimes(1);
  const send = mock((_message: string) => 1);
  const close = mock((_code: number, _reason: string) => {});
  const socket = { data, send, close } as unknown as Parameters<typeof options.websocket.open>[0];
  cleanup.push(() => options.websocket.close(socket));
  options.websocket.open(socket);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(send).toHaveBeenCalledWith(JSON.stringify({ type: "assistant.delta", runId, text: "Private manuscript" }));
  harnessEventBus.publish({ type: "assistant.delta", runId, text: "Live text" });
  expect(send).toHaveBeenCalledWith(JSON.stringify({ type: "assistant.delta", runId, text: "Live text" }));
  expect((await request("/api/auth/logout", admin.token, "POST")).status).toBe(204);
  const delivered = send.mock.calls.length;
  harnessEventBus.publish({ type: "assistant.delta", runId, text: "Must not leak" });
  expect(send).toHaveBeenCalledTimes(delivered);
  expect(close).toHaveBeenCalledWith(4003, "Harness access revoked");
  expect((await options.fetch(socketRequest(admin.token), server))?.status).toBe(401);
});

test("Harness socket upgrades fail closed without an authorization callback", async () => {
  const options = createServerOptions(async () => new Response("[]"));
  const upgrade = mock(() => true);
  const response = await options.fetch(new Request("http://fastwrite.test/api/harness/socket?runId=private"), { upgrade } as unknown as Parameters<typeof options.fetch>[1]);
  expect(response?.status).toBe(503);
  expect(upgrade).not.toHaveBeenCalled();
});

test.each(["before-open", "during-history"] as const)("Harness socket rechecks revocation %s", async stage => {
  const { app, request, admin, runId } = await fixture();
  let releaseHistory!: () => void;
  const historyGate = new Promise<void>(resolve => { releaseHistory = resolve; });
  const delayedFetch = Object.assign(async (input: Request) => {
    const response = await app(input);
    await historyGate;
    return response;
  }, { authorizeHarnessRun: app.authorizeHarnessRun });
  const options = createServerOptions(delayedFetch);
  let data: unknown;
  const server = { upgrade: (_request: Request, input: { data: unknown }) => { data = input.data; return true; } } as unknown as Parameters<typeof options.fetch>[1];
  // The alternate HTTP session header is also supported, without URL credentials.
  expect(await options.fetch(new Request(`http://fastwrite.test/api/harness/socket?runId=${runId}`, { headers: { "x-fastwrite-session": admin.token } }), server)).toBeUndefined();
  const send = mock((_message: string) => 1);
  const close = mock((_code: number, _reason: string) => {});
  const socket = { data, send, close } as unknown as Parameters<typeof options.websocket.open>[0];
  cleanup.push(() => { releaseHistory(); options.websocket.close(socket); });
  if (stage === "during-history") options.websocket.open(socket);
  expect((await request("/api/auth/logout", admin.token, "POST")).status).toBe(204);
  if (stage === "before-open") options.websocket.open(socket);
  releaseHistory();
  await new Promise(resolve => setTimeout(resolve, 20));
  harnessEventBus.publish({ type: "assistant.delta", runId, text: "Revoked content" });
  expect(send).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledWith(4003, "Harness access revoked");
});
