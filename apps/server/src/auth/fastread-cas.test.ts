import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonDatabase } from "../storage/database";
import { AuthService } from "./auth-service";
import { AuthorizationService } from "./authorization-service";
import { FastCASService } from "./fastcas-service";
import { connectReadCAS } from "./fastread-cas";
import { FastReadIntegration } from "../research/fastread-integration";
import type { WorkspaceService } from "../workspace/workspace-service";
import type { ResearchService } from "../research/research-service";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "write-read-cas-")); directories.push(path);
  const database = new JsonDatabase(path); await database.initialize();
  const service = new FastCASService({ issuer: "https://cas.test", clientId: "write", clientSecret: "fixture", redirectUri: "https://write.test/callback" }, database, new AuthService(database));
  const link = { id: "link", client_id: "write", subject: "subject", local_account_ref: "owner", state: "active" as const, version: 2, verified_at: new Date().toISOString() };
  const claims = { iss: "https://cas.test", sub: "fastread-sync", client_id: "fastread-sync", aud: ["write"], scope: "fastread:connect", service: true, token_use: "access" };
  const live = { active: true, sub: "fastread-sync", client_id: "fastread-sync", aud: ["write"], scope: "fastread:connect" };
  spyOn(service.sdk, "verifyAccessToken").mockImplementation(async (_token, audience, scopes) => { expect(audience).toBe("write"); expect(scopes).toEqual(["fastread:connect"]); return claims; });
  spyOn(service.sdk, "introspectToken").mockImplementation(async () => live);
  spyOn(service.sdk, "resolveLink").mockResolvedValue(link);
  const now = new Date().toISOString();
  await database.mutate(state => {
    state.users.push({ id: "owner", emailNormalized: "owner@example.test", displayName: "Owner", platformRole: "platform_admin", status: "active", authzVersion: 1, createdAt: now, updatedAt: now });
    state.fastcasLinks.push({ issuer: "https://cas.test", userId: "owner", link });
  });
  const request = (subject = "subject") => new Request("https://write.test/api/integrations/fastread/cas-connect", { method: "POST", headers: { authorization: "Bearer service", "content-type": "application/json" }, body: JSON.stringify({ subject }) });
  const integration = new FastReadIntegration(database, new AuthorizationService(database), {} as WorkspaceService, {} as ResearchService, service);
  return { database, service, claims, live, link, request, integration };
}

test("CAS connection maps the same identity and pins revocable credentials without admin authority", async () => {
  const f = await fixture(); const actor = await connectReadCAS(f.service, f.database, f.request());
  expect(actor.principal.user.id).toBe("owner"); expect(actor.principal.user.platformRole).toBe("user");
  const connection = await f.integration.issue(actor.principal, actor.identity);
  expect(JSON.stringify(f.database.snapshot())).not.toContain(connection.token);
  const request = () => new Request("https://write.test/api/integrations/fastread/projects", { headers: { authorization: `Bearer ${connection.token}` } });
  expect((await f.integration.authenticate(request())).user.id).toBe("owner");
  await f.database.mutate(state => { state.fastcasLinks[0]!.link = { ...state.fastcasLinks[0]!.link, state: "revoked", version: 3 }; });
  await expect(f.integration.authenticate(request())).rejects.toMatchObject({ status: 403 });
  await f.database.mutate(state => { state.fastcasLinks[0]!.link = { ...state.fastcasLinks[0]!.link, state: "active", version: 4 }; });
  await expect(f.integration.authenticate(request())).rejects.toMatchObject({ status: 403 });
});

test("user tokens, wrong audience, missing scope and revoked grants cannot connect", async () => {
  const f = await fixture();
  for (const change of [() => { f.claims.service = false; }, () => { f.live.active = false; }, () => { f.live.aud = ["other"]; }, () => { f.live.scope = "workspace:read"; }]) {
    change(); await expect(connectReadCAS(f.service, f.database, f.request())).rejects.toMatchObject({ status: 403 });
    f.claims.service = true; f.live.active = true; f.live.aud = ["write"]; f.live.scope = "fastread:connect";
  }
  await expect(connectReadCAS(f.service, f.database, f.request("missing"))).rejects.toMatchObject({ status: 403 });
  expect(f.database.snapshot().users).toHaveLength(1);
  await f.database.mutate(state => { state.users[0]!.status = "disabled"; });
  await expect(connectReadCAS(f.service, f.database, f.request())).rejects.toMatchObject({ status: 403 });
});

test("central binding outages and credential revocation fail closed", async () => {
  const f = await fixture(); const actor = await connectReadCAS(f.service, f.database, f.request());
  const connection = await f.integration.issue(actor.principal, actor.identity);
  const request = () => new Request("https://write.test/api/integrations/fastread/projects", { headers: { authorization: `Bearer ${connection.token}` } });
  spyOn(f.service.sdk, "resolveLink").mockRejectedValue(Error("offline"));
  await expect(f.integration.authenticate(request())).rejects.toMatchObject({ status: 503 });
  await f.integration.revoke(actor.principal);
  await expect(f.integration.authenticate(request())).rejects.toMatchObject({ status: 401 });
});
