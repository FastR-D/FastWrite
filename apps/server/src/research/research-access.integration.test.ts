import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../app";

for (const action of ["logout", "cancel"] as const) test(`research HTTP ${action} while providers are running prevents candidate persistence`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "research-http-access-"));
  let release!: () => void;
  let ready!: () => void;
  const responseGate = new Promise<void>(resolve => { release = resolve; });
  const allRequests = new Promise<void>(resolve => { ready = resolve; });
  let requests = 0;
  try {
    const app = await createApplication(directory, { researchFetcher: async () => {
      if (++requests === 4) ready();
      await responseGate;
      return Response.json({ message: { items: [{ title: ["Withheld candidate"], DOI: "10.5555/withheld" }] }, results: [], data: [] });
    } });
    const request = (path: string, init?: RequestInit) => app(new Request(`http://fastwrite.test${path}`, init));
    const user = await (await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "research-owner@example.test", password: "correct-horse-battery-staple" }) })).json() as { token: string };
    const headers = { authorization: `Bearer ${user.token}`, "content-type": "application/json" };
    const project = await (await request("/api/projects", { method: "POST", headers, body: JSON.stringify({ name: "Research access" }) })).json() as { id: string };
    const controller = new AbortController();
    const operation = request(`/api/projects/${project.id}/research-runs`, { method: "POST", headers, signal: controller.signal, body: JSON.stringify({ query: "access fixture" }) });
    await allRequests;
    if (action === "logout") expect((await request("/api/auth/logout", { method: "POST", headers })).status).toBe(204);
    else controller.abort();
    release();
    const result = await operation;
    expect(result.status).toBe(action === "logout" ? 401 : 499);
    // Log back in to inspect project state after the revoked operation.
    const login = await (await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "research-owner@example.test", password: "correct-horse-battery-staple" }) })).json() as { token: string };
    const readHeaders = { authorization: `Bearer ${login.token}` };
    expect(await (await request(`/api/projects/${project.id}/research-works`, { headers: readHeaders })).json()).toEqual([]);
    const runs = await (await request(`/api/projects/${project.id}/research-runs`, { headers: readHeaders })).json() as Array<{ status: string; workIds: string[] }>;
    expect(runs[0]).toMatchObject({ status: action === "logout" ? "failed" : "cancelled", workIds: [] });
  } finally { release?.(); await rm(directory, { recursive: true, force: true }); }
});
