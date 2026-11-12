import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FastCAS } from "@fastrd/fastcas/server";
import { JsonDatabase } from "../storage/database";
import { workspaceSummary } from "./workspace-summary";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "fastwrite-workspace-")); directories.push(path);
  const database = new JsonDatabase(path); await database.initialize();
  const sdk = new FastCAS({ issuer: "https://cas.test", clientId: "write", clientSecret: "fixture", redirectUri: "https://write.test/callback" }, { put: async () => {}, take: async () => undefined });
  const link = { id: "link", client_id: "write", subject: "subject", local_account_ref: "owner", state: "active" as const, version: 2, verified_at: new Date().toISOString() };
  const claims = { iss: "https://cas.test", sub: "fastresearch", client_id: "fastresearch", aud: ["write"], scope: "workspace:read", service: true, token_use: "access" };
  spyOn(sdk, "verifyAccessToken").mockImplementation(async (_token, audience, scopes) => { expect(audience).toBe("write"); expect(scopes).toEqual(["workspace:read"]); return claims; });
  spyOn(sdk, "introspectToken").mockResolvedValue({ active: true, sub: "fastresearch", client_id: "fastresearch", aud: ["write"], scope: "workspace:read" });
  spyOn(sdk, "resolveLink").mockResolvedValue(link);
  const now = new Date().toISOString();
  await database.mutate(state => {
    for (const id of ["owner", "other"]) state.users.push({ id, emailNormalized: `${id}@example.test`, displayName: id, platformRole: "user", status: "active", authzVersion: 1, createdAt: now, updatedAt: now });
    state.fastcasLinks.push({ issuer: "https://cas.test", userId: "owner", link });
    // A project fixture only needs persisted metadata for the summary ACL.
    state.projects.push({ id: "own-project", name: "My paper", mainDocument: "main.tex", skill: { id: "network-information-security", name: "Paper", version: "1", venue: "network-information-security" }, source: { type: "local", displayName: "Empty" }, personalOwnerUserId: "owner", createdAt: now, updatedAt: now, version: 1 } as typeof state.projects[number]);
    state.projects.push({ ...state.projects[0]!, id: "other-project", name: "Private other paper", personalOwnerUserId: "other" });
    state.commentThreads.push({ id: "thread", projectId: "own-project", documentId: "doc", path: "main.tex", startRelativePosition: "", endRelativePosition: "", quote: "", contextHash: "", fileVersion: 1, status: "open", authorUserId: "owner", createdAt: now, updatedAt: now });
    state.notifications.push({ id: "comment", threadId: "thread", userId: "owner", projectId: "own-project", type: "discussion", title: "New comment", body: "never expose comment body", inApp: true, createdAt: now });
    state.notifications.push({ id: "mention", threadId: "thread", userId: "owner", projectId: "own-project", type: "mention", title: "You were mentioned", inApp: true, createdAt: now });
    state.notifications.push({ id: "old", userId: "owner", projectId: "own-project", type: "discussion", title: "Already read", inApp: true, createdAt: now, readAt: now });
    state.notifications.push({ id: "private", userId: "other", projectId: "other-project", type: "discussion", title: "Other private comment", inApp: true, createdAt: now });
  });
  const request = (subject = "subject") => new Request("https://write.test/api/integrations/fastresearch/workspace", { method: "POST", headers: { authorization: "Bearer fixture", "content-type": "application/json" }, body: JSON.stringify({ subject }) });
  return { database, sdk, claims, request, config: { issuer: "https://cas.test", clientId: "write" } };
}
test("workspace summary isolates account, ACL and unread state without comment bodies", async () => {
  const f = await fixture(); const result = await workspaceSummary(f.sdk, f.config, f.database, f.request());
  expect(result.accountState).toBe("active"); expect(result.metrics.map(item => item.value)).toEqual([1, 1, 1]);
  expect(JSON.stringify(result)).not.toContain("Other private"); expect(JSON.stringify(result)).not.toContain("never expose comment body"); expect(JSON.stringify(result)).not.toContain("Already read");
  expect(f.database.snapshot().notifications.find(item => item.id === "comment")?.readAt).toBeUndefined();
  expect((await workspaceSummary(f.sdk, f.config, f.database, f.request("missing"))).accountState).toBe("missing"); expect(f.database.snapshot().users).toHaveLength(2);
});
test("revoked tokens, user tokens and unavailable binding checks cannot yield private data", async () => {
  const f = await fixture(); f.claims.service = false;
  await expect(workspaceSummary(f.sdk, f.config, f.database, f.request())).rejects.toMatchObject({ status: 403 }); f.claims.service = true;
  spyOn(f.sdk, "introspectToken").mockResolvedValue({ active: false });
  await expect(workspaceSummary(f.sdk, f.config, f.database, f.request())).rejects.toMatchObject({ status: 403 });
  spyOn(f.sdk, "introspectToken").mockResolvedValue({ active: true, sub: "fastresearch", client_id: "fastresearch", aud: ["write"], scope: "workspace:read" });
  spyOn(f.sdk, "resolveLink").mockRejectedValue(Error("offline"));
  await expect(workspaceSummary(f.sdk, f.config, f.database, f.request())).rejects.toMatchObject({ status: 503 });
});

test("a revoked document ACL hides its existing comment notification", async () => {
  const f = await fixture();
  const now = new Date().toISOString();
  await f.database.mutate(state => state.projectAclRules.push({ id: "deny", projectId: "own-project", pathPrefix: "main.tex", subjectType: "user", subjectId: "owner", action: "read", effect: "deny", createdByUserId: "owner", createdAt: now, updatedAt: now }));
  const result = await workspaceSummary(f.sdk, f.config, f.database, f.request());
  expect(result.metrics.map(item => item.value)).toEqual([0, 0, 1]);
  expect(result.items.some(item => item.kind === "comment" || item.kind === "mention")).toBe(false);
});
