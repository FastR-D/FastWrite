import { afterEach, expect, test } from "bun:test";
import type { Server } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication, type ApplicationOptions } from "./app";
import { config } from "./config";

const servers: Server<unknown>[] = [];
const directories: string[] = [];
const originalProviders = config.agentProviders;
const originalHome = process.env.HOME;
afterEach(async () => {
  config.agentProviders = originalProviders;
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function application(options: ApplicationOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-runtime-agent-"));
  directories.push(directory);
  const app = await createApplication(directory, { ...options, features: { serverAuth: false } });
  const request = (path: string, method = "GET", body?: unknown) => app(new Request(`http://app.test${path}`, {
    method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }));
  const project = await (await request("/api/projects", "POST", { name: "Runtime provider", initializeFromTemplate: false })).json() as { id: string };
  const file = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as { content: string; file: { version: number } };
  return { request, complete: () => request(`/api/projects/${project.id}/completions`, "POST", { path: "main.tex", cursor: file.content.length, fileVersion: file.file.version, kind: "auto" }) };
}

function endpoint() {
  const calls: Array<{ path: string; authorization: string | null; model: string }> = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { model: string };
    const path = new URL(request.url).pathname;
    calls.push({ path, authorization: request.headers.get("authorization"), model: body.model });
    const content = JSON.stringify({ suggestion: `from ${body.model}` });
    return Response.json(path.endsWith("/responses") ? { output_text: content } : { choices: [{ message: { content } }] });
  } });
  servers.push(server);
  return { baseURL: `http://127.0.0.1:${server.port}/v1`, calls };
}

test("saved settings change real requests in services that were already constructed", async () => {
  const remote = endpoint();
  const { request, complete } = await application({ agentProvider: {
    async revise() { return { replacement: "", rationale: "" }; },
    async complete() { return { suggestion: "injected fallback" }; },
  } });
  expect(await (await complete()).json()).toMatchObject({ suggestion: "injected fallback" });
  for (const wireAPI of ["chat", "responses"] as const) {
    const result = await request("/api/harness-settings", "PUT", { apiKey: `test-key-${wireAPI}`, model: wireAPI, baseURL: remote.baseURL, wireAPI });
    expect(result.status).toBe(200);
    const status = await result.json();
    expect(status).toMatchObject({ source: "runtime", configured: true, model: wireAPI, wireAPI });
    expect(JSON.stringify(status)).not.toContain("test-key");
    expect(await (await complete()).json()).toMatchObject({ suggestion: `from ${wireAPI}` });
  }
  expect(remote.calls).toEqual([
    { path: "/v1/chat/completions", authorization: "Bearer test-key-chat", model: "chat" },
    { path: "/v1/responses", authorization: "Bearer test-key-responses", model: "responses" },
  ]);
});

test("invalid changes preserve the previous working provider and settings", async () => {
  const remote = endpoint();
  const { request, complete } = await application();
  const settings = { apiKey: "test-valid-key", model: "working", baseURL: remote.baseURL, wireAPI: "chat" };
  expect((await request("/api/harness-settings", "PUT", settings)).status).toBe(200);
  for (const changes of [
    { harness: config.harness === "codex" ? "claude" : "codex" },
    { baseURL: "file:///tmp/provider" },
    { wireAPI: "invalid" },
    { apiKey: "" },
  ]) expect((await request("/api/harness-settings", "PUT", { ...settings, apiKey: "test-rejected-key", model: "rejected", ...changes })).status).toBe(400);
  expect(await (await request("/api/harness-settings")).json()).toMatchObject({ model: "working", source: "runtime" });
  expect(await (await complete()).json()).toMatchObject({ suggestion: "from working" });
  expect(remote.calls[0]?.authorization).toBe("Bearer test-valid-key");
});

test("environment settings reach the provider before any runtime save", async () => {
  const remote = endpoint();
  config.agentProviders = { ...originalProviders, agent: { apiKey: "test-environment-key", baseURL: remote.baseURL, model: "environment", wireAPI: "chat" } };
  const { request, complete } = await application();
  expect(await (await request("/api/harness-settings")).json()).toMatchObject({ source: "environment", configured: true });
  expect(await (await complete()).json()).toMatchObject({ suggestion: "from environment" });
  expect(remote.calls[0]?.authorization).toBe("Bearer test-environment-key");
});

test("an unconfigured CLI fallback is not reported as an environment provider", async () => {
  config.agentProviders = { ...originalProviders, agent: {} };
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-no-cli-config-"));
  directories.push(directory);
  process.env.HOME = directory;
  const { request } = await application();
  expect(await (await request("/api/harness-settings")).json()).toMatchObject({ configured: false, source: "none" });
});
