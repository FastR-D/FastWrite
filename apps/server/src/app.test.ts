import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRun, AgentTaskPlan, ChangeSet, ChangeSetConflictDetails, ClaimEvidenceLink, CompletionResponse, ComplianceReport, FastReadBundleReceipt, FileContentResponse, PaperClaim, PaperMemory, PaperProject, ProjectResearchWorkDetails, ResearchRun, ResearchWork, ReviseResponse, SaveFileResponse, SourceEvidence, UploadSession, WorkingStatus, WorkspaceTreeNode } from "@fastwrite/shared";
import type { AgentProvider, AgentTaskPlanOutput, CompletionAgentInput, DraftGeneratedFile, ReviseAgentInput } from "./agent/provider";
import { createApplication, mimeType } from "./app";
import type { IdentityProvider } from "./auth/identity-provider";
import type { MailTransport } from "./notifications/mail-delivery-service";
import * as Y from "yjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function testApplication(agentProvider?: AgentProvider, features?: { serverAuth?: boolean }, oidcProvider?: IdentityProvider, casProvider?: IdentityProvider, mailTransport?: MailTransport, researchFetcher?: typeof fetch) {
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-test-"));
  temporaryDirectories.push(directory);
  const app = await createApplication(directory, { ...(agentProvider ? { agentProvider } : {}), ...(features ? { features } : {}), ...(oidcProvider ? { oidcProvider } : {}), ...(casProvider ? { casProvider } : {}), ...(mailTransport ? { mailTransport } : {}), ...(researchFetcher ? { researchFetcher } : {}) });
  return (path: string, init?: RequestInit) => app(new Request(`http://fastwrite.test${path}`, init));
}

describe("workspace API", () => {
  test("sets baseline browser security headers", async () => {
    const request = await testApplication();
    const response = await request("/api/health");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("content-security-policy")).toContain("style-src 'self' 'unsafe-inline'");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self';");
    expect(response.headers.get("x-request-id")).toMatch(/^req_/);
  });

  test("serves the single-page client for invitation links", async () => {
    const request = await testApplication();
    const response = await request("/projects?invite=one-time-token");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
  });

  test("registers local accounts, creates a personal workspace, and accepts scoped invitations", async () => {
    const request = await testApplication();
    const ownerResponse = await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@example.test", password: "correct-horse-battery-staple", displayName: "Owner" }) });
    expect(ownerResponse.status).toBe(201);
    const originalRefreshCookie = ownerResponse.headers.get("set-cookie")?.split(";", 1)[0];
    expect(originalRefreshCookie).toContain("fastwrite.refresh=");
    expect((await request("/api/auth/refresh", { method: "POST", headers: { cookie: originalRefreshCookie!, origin: "https://untrusted.example" } })).status).toBe(403);
    const owner = await ownerResponse.json() as { user: { id: string; emailNormalized: string }; token: string };
    expect(JSON.stringify(owner)).not.toContain("password");
    const ownerHeaders = { authorization: `Bearer ${owner.token}`, "content-type": "application/json" };
    const personal = await request("/api/teams", { headers: ownerHeaders });
    expect(personal.status).toBe(200);
    expect(await personal.json()).toEqual(expect.arrayContaining([expect.objectContaining({ personalUserId: owner.user.id })]));
    const project = await (await request("/api/projects", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "Invited paper" }) })).json() as PaperProject;
    expect((await request(`/api/projects/${project.id}/invitations`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ email: "owner-transfer@example.test", role: "owner" }) })).status).toBe(400);
    const customExpiry = new Date(Date.now() + 2 * 86400_000).toISOString();
    const invitationResponse = await request(`/api/projects/${project.id}/invitations`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ email: "editor@example.test", role: "editor", expiresAt: customExpiry, message: "Please review the methods section." }) });
    expect(invitationResponse.status).toBe(201);
    const invitation = await invitationResponse.json() as { token: string; invitation: { id: string; tokenHash?: string; expiresAt: string; message?: string } };
    expect(invitation.invitation.tokenHash).toBeUndefined();
    expect(invitation.invitation.message).toBe("Please review the methods section.");
    expect(Date.parse(invitation.invitation.expiresAt)).toBeGreaterThan(Date.now() + 47 * 3_600_000);
    expect((await request(`/api/projects/${project.id}/invitations`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ email: "bad-expiry@example.test", role: "viewer", expiresAt: new Date(Date.now() + 5_000).toISOString() }) })).status).toBe(400);
    const listed = await request(`/api/projects/${project.id}/invitations`, { headers: ownerHeaders });
    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.json())).not.toContain("tokenHash");
    const editor = await (await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "editor@example.test", password: "correct-horse-battery-staple" }) })).json() as { token: string; user: { id: string } };
    const resentResponse = await request(`/api/invitations/${invitation.invitation.id}/resend`, { method: "POST", headers: ownerHeaders });
    expect(resentResponse.status).toBe(200);
    const resent = await resentResponse.json() as { token: string; invitation: { id: string; tokenHash?: string; message?: string } };
    expect(resent.token).not.toBe(invitation.token);
    expect(resent.invitation.id).not.toBe(invitation.invitation.id);
    expect(resent.invitation.tokenHash).toBeUndefined();
    expect(resent.invitation.message).toBe("Please review the methods section.");
    const revoked = await request(`/api/invitations/${invitation.token}/accept`, { method: "POST", headers: { authorization: `Bearer ${editor.token}` } });
    expect(revoked.status).toBe(404);
    const accepted = await request(`/api/invitations/${resent.token}/accept`, { method: "POST", headers: { authorization: `Bearer ${editor.token}` } });
    expect(accepted.status).toBe(200);
    const members = await request(`/api/projects/${project.id}/members`, { headers: ownerHeaders });
    expect(await members.json()).toMatchObject({ canManage: true, members: expect.arrayContaining([expect.objectContaining({ userId: editor.user.id, role: "editor", user: expect.objectContaining({ emailNormalized: "editor@example.test" }) })]) });
    expect((await request(`/api/projects/${project.id}/members/${editor.user.id}`, { method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ role: "commenter" }) })).status).toBe(200);
    expect((await request(`/api/projects/${project.id}/members/${editor.user.id}`, { method: "DELETE", headers: ownerHeaders })).status).toBe(204);
    const withdrawn = await (await request(`/api/projects/${project.id}/invitations`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ email: "withdrawn@example.test", role: "viewer" }) })).json() as { invitation: { id: string } };
    expect((await request(`/api/invitations/${withdrawn.invitation.id}`, { method: "DELETE", headers: ownerHeaders })).status).toBe(204);
    expect((await request(`/api/invitations/${withdrawn.invitation.id}/resend`, { method: "POST", headers: ownerHeaders })).status).toBe(409);
    for (let count = 0; count < 3; count += 1) expect((await request(`/api/projects/${project.id}/invitations`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ email: "rate-limit@example.test", role: "viewer" }) })).status).toBe(201);
    expect((await request(`/api/projects/${project.id}/invitations`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ email: "rate-limit@example.test", role: "viewer" }) })).status).toBe(429);
    const refreshed = await request("/api/auth/refresh", { method: "POST", headers: { cookie: originalRefreshCookie! } });
    expect(refreshed.status).toBe(200);
    const rotated = await refreshed.json() as { token: string };
    expect((await request("/api/auth/refresh", { method: "POST", headers: { cookie: originalRefreshCookie! } })).status).toBe(401);
    expect((await request("/api/auth/me", { headers: { authorization: `Bearer ${rotated.token}` } })).status).toBe(401);
  });

  test("creates and reuses an account through the configured OIDC identity port", async () => {
    const provider: IdentityProvider = {
      beginLogin: async () => ({ kind: "redirect", url: "https://idp.example.test/authorize?state=opaque", binding: "opaque" }),
      finishLogin: async () => ({ issuer: "https://idp.example.test", subject: "stable-subject-42", email: "oidc.user@example.test", displayName: "OIDC User", groups: ["researchers"], emailVerified: true }),
      loginReturnTo: (state) => state === "opaque" ? "/projects?view=recent" : "/",
      logout: async () => undefined
    };
    const request = await testApplication(undefined, { serverAuth: true }, provider);
    expect(await (await request("/api/auth/providers")).json()).toEqual({ local: true, oidc: true, cas: false });
    const start = await request("/api/auth/oidc/login?returnTo=/projects?view=recent");
    expect(start.status).toBe(302);
    expect(start.headers.get("location")).toBe("https://idp.example.test/authorize?state=opaque");
    const loginCookie = start.headers.get("set-cookie")?.split(";", 1)[0];
    expect((await request("/api/auth/oidc/callback?code=code&state=opaque")).status).toBe(403);
    const callback = await request("/api/auth/oidc/callback?code=code&state=opaque", { headers: { cookie: loginCookie! } });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/projects?view=recent&oidc=complete");
    const refreshCookie = callback.headers.get("set-cookie")?.split(";", 1)[0];
    expect(refreshCookie).toContain("fastwrite.refresh=");
    const refreshed = await request("/api/auth/refresh", { method: "POST", headers: { cookie: refreshCookie! } });
    const session = await refreshed.json() as { user: { id: string; emailNormalized: string }; token: string };
    expect(session.user.emailNormalized).toBe("oidc.user@example.test");
    expect((await request("/api/auth/me", { headers: { authorization: `Bearer ${session.token}` } })).status).toBe(200);
    const secondStart = await request("/api/auth/oidc/login");
    const secondLoginCookie = secondStart.headers.get("set-cookie")?.split(";", 1)[0];
    const secondCallback = await request("/api/auth/oidc/callback?code=second&state=opaque", { headers: { cookie: secondLoginCookie! } });
    const secondCookie = secondCallback.headers.get("set-cookie")?.split(";", 1)[0];
    const second = await (await request("/api/auth/refresh", { method: "POST", headers: { cookie: secondCookie! } })).json() as { user: { id: string } };
    expect(second.user.id).toBe(session.user.id);
  });

  test("applies issuer-qualified IdP group ACL rules to refreshed external sessions", async () => {
    const provider: IdentityProvider = {
      beginLogin: async () => ({ kind: "redirect", url: "https://idp.example.test/authorize?state=group-state", binding: "group-state" }),
      finishLogin: async () => ({ issuer: "https://idp.example.test/", subject: "group-user", email: "group.user@example.test", groups: ["researchers", "researchers", ""], emailVerified: true }),
      logout: async () => undefined
    };
    const request = await testApplication(undefined, { serverAuth: true }, provider);
    const bootstrap = await (await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "group-owner@example.test", password: "correct-horse-battery-staple" }) })).json() as { token: string };
    const ownerHeaders = { authorization: `Bearer ${bootstrap.token}`, "content-type": "application/json" };
    const project = await (await request("/api/projects", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "Group ACL" }) })).json() as PaperProject;
    const start = await request("/api/auth/oidc/login");
    const loginCookie = start.headers.get("set-cookie")?.split(";", 1)[0];
    const callback = await request("/api/auth/oidc/callback?code=code&state=group-state", { headers: { cookie: loginCookie! } });
    const externalRefreshCookie = callback.headers.get("set-cookie")?.split(";", 1)[0];
    const externalRefresh = await request("/api/auth/refresh", { method: "POST", headers: { cookie: externalRefreshCookie! } });
    const rotatedRefreshCookie = externalRefresh.headers.get("set-cookie")?.split(";", 1)[0];
    const external = await externalRefresh.json() as { token: string; user: { id: string } };
    const externalHeaders = { authorization: `Bearer ${external.token}`, "content-type": "application/json" };
    const invitation = await (await request(`/api/projects/${project.id}/invitations`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ email: "group.user@example.test", role: "viewer" }) })).json() as { token: string };
    expect((await request(`/api/invitations/${invitation.token}/accept`, { method: "POST", headers: externalHeaders })).status).toBe(200);
    expect((await request(`/api/projects/${project.id}/files`, { method: "POST", headers: externalHeaders, body: JSON.stringify({ path: "team/notes.tex", content: "before allow" }) })).status).toBe(403);
    expect((await request(`/api/projects/${project.id}/acl/new`, { method: "PUT", headers: ownerHeaders, body: JSON.stringify({ pathPrefix: "team", subjectType: "idp_group", subjectId: "https://idp.example.test:researchers", action: "edit", effect: "allow" }) })).status).toBe(200);
    expect((await request(`/api/projects/${project.id}/files`, { method: "POST", headers: externalHeaders, body: JSON.stringify({ path: "team/notes.tex", content: "group allow" }) })).status).toBe(201);
    expect((await request(`/api/projects/${project.id}/acl/new`, { method: "PUT", headers: ownerHeaders, body: JSON.stringify({ pathPrefix: "team", subjectType: "idp_group", subjectId: "https://idp.example.test:researchers", action: "read", effect: "deny" }) })).status).toBe(200);
    expect((await request(`/api/projects/${project.id}/file?path=team/notes.tex`, { headers: externalHeaders })).status).toBe(403);
    const refreshed = await request("/api/auth/refresh", { method: "POST", headers: { cookie: rotatedRefreshCookie! } });
    expect(refreshed.status).toBe(200);
    const rotated = await refreshed.json() as { token: string };
    expect((await request(`/api/projects/${project.id}/file?path=team/notes.tex`, { headers: { authorization: `Bearer ${rotated.token}` } })).status).toBe(403);
  });

  test("syncs an external identity group into an owner-configured team binding", async () => {
    const provider: IdentityProvider = { beginLogin: async () => ({ kind: "redirect", url: "https://idp.example.test/authorize", binding: "team-group-state" }), finishLogin: async () => ({ issuer: "https://idp.example.test", subject: "team-group-user", email: "team-group@example.test", groups: ["lab-members", "lab-admin"], emailVerified: true }), logout: async () => undefined };
    const request = await testApplication(undefined, { serverAuth: true }, provider);
    const owner = await (await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "team-group-owner@example.test", password: "correct-horse-battery-staple" }) })).json() as { token: string };
    const ownerHeaders = { authorization: `Bearer ${owner.token}`, "content-type": "application/json" };
    const team = await (await request("/api/teams", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "Mapped Lab" }) })).json() as { id: string };
    expect((await request(`/api/teams/${team.id}/group-bindings/new`, { method: "PUT", headers: ownerHeaders, body: JSON.stringify({ idpGroup: "https://idp.example.test:lab-members", role: "member" }) })).status).toBe(200);
    const adminBinding = await (await request(`/api/teams/${team.id}/group-bindings/new`, { method: "PUT", headers: ownerHeaders, body: JSON.stringify({ idpGroup: "https://idp.example.test:lab-admin", role: "admin" }) })).json() as { id: string };
    expect(await (await request(`/api/teams/${team.id}/group-bindings/preview`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ groups: ["https://idp.example.test:lab-members", "https://idp.example.test:other"] }) })).json()).toEqual([expect.objectContaining({ idpGroup: "https://idp.example.test:lab-members", role: "member" })]);
    const project = await (await request("/api/projects", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "Mapped Project", teamId: team.id }) })).json() as PaperProject;
    const start = await request("/api/auth/oidc/login"); const cookie = start.headers.get("set-cookie")?.split(";", 1)[0];
    const callback = await request("/api/auth/oidc/callback?code=code&state=team-group-state", { headers: { cookie: cookie! } });
    const refreshCookie = callback.headers.get("set-cookie")?.split(";", 1)[0];
    const member = await (await request("/api/auth/refresh", { method: "POST", headers: { cookie: refreshCookie! } })).json() as { token: string };
    const memberHeaders = { authorization: `Bearer ${member.token}` };
    expect(await (await request("/api/teams", { headers: memberHeaders })).json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: team.id })]));
    expect((await request(`/api/projects/${project.id}`, { headers: memberHeaders })).status).toBe(200);
    const memberIdentity = await (await request("/api/auth/me", { headers: memberHeaders })).json() as { id: string };
    expect(await (await request(`/api/teams/${team.id}/members`, { headers: ownerHeaders })).json()).toMatchObject({ members: expect.arrayContaining([expect.objectContaining({ userId: memberIdentity.id, role: "admin" })]) });
    expect((await request(`/api/teams/${team.id}/group-bindings/${adminBinding.id}`, { method: "DELETE", headers: ownerHeaders })).status).toBe(204);
    expect(await (await request(`/api/teams/${team.id}/members`, { headers: ownerHeaders })).json()).toMatchObject({ members: expect.arrayContaining([expect.objectContaining({ userId: memberIdentity.id, role: "member" })]) });
    expect((await request(`/api/teams/${team.id}/members/${memberIdentity.id}`, { method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ role: "admin" }) })).status).toBe(200);
    const roster = await (await request(`/api/teams/${team.id}/members`, { headers: ownerHeaders })).json() as { members: Array<{ userId: string; role: string; idpGroupBindingIds?: string[] }> };
    const converted = roster.members.find((item) => item.userId === memberIdentity.id);
    expect(converted).toMatchObject({ userId: memberIdentity.id, role: "admin" });
    expect(converted?.idpGroupBindingIds).toBeUndefined();
  });

  test("searches only readable project files without exposing denied paths", async () => {
    const request = await testApplication(undefined, { serverAuth: true });
    const owner = await (await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "search-owner@example.test", password: "correct-horse-battery-staple" }) })).json() as { token: string };
    const editor = await (await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "search-editor@example.test", password: "correct-horse-battery-staple" }) })).json() as { token: string; user: { id: string } };
    const ownerHeaders = { authorization: `Bearer ${owner.token}`, "content-type": "application/json" };
    const editorHeaders = { authorization: `Bearer ${editor.token}`, "content-type": "application/json" };
    const project = await (await request("/api/projects", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "Search ACL" }) })).json() as PaperProject;
    const invitation = await (await request(`/api/projects/${project.id}/invitations`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ email: "search-editor@example.test", role: "editor" }) })).json() as { token: string };
    expect((await request(`/api/invitations/${invitation.token}/accept`, { method: "POST", headers: editorHeaders })).status).toBe(200);
    expect((await request(`/api/projects/${project.id}/files`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ path: "public/notes.tex", content: "First line\nunique needle appears here" }) })).status).toBe(201);
    expect((await request(`/api/projects/${project.id}/files`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ path: "restricted/results.tex", content: "unique needle must remain private" }) })).status).toBe(201);
    expect((await request(`/api/projects/${project.id}/acl/new`, { method: "PUT", headers: ownerHeaders, body: JSON.stringify({ pathPrefix: "restricted", subjectType: "user", subjectId: editor.user.id, action: "read", effect: "deny" }) })).status).toBe(200);
    expect(await (await request(`/api/projects/${project.id}/access-decision?path=restricted/results.tex&action=project%3Aread`, { headers: editorHeaders })).json()).toMatchObject({ allowed: false, reasonCode: "acl_deny", policyVersion: 1, role: "editor" });
    expect(await (await request(`/api/projects/${project.id}/access-decision?path=public/notes.tex&action=project%3Aread`, { headers: editorHeaders })).json()).toMatchObject({ allowed: true, reasonCode: "project_role", policyVersion: 1, role: "editor" });
    const search = await request(`/api/projects/${project.id}/search?query=${encodeURIComponent("unique needle")}`, { headers: editorHeaders });
    expect(search.status).toBe(200);
    expect(await search.json()).toEqual({ query: "unique needle", matches: [{ path: "public/notes.tex", line: 2, excerpt: "unique needle appears here" }], truncated: false });
    expect((await request(`/api/projects/${project.id}/search?query=`, { headers: editorHeaders })).status).toBe(400);
  });

  test("creates an account through the configured CAS identity port", async () => {
    const provider: IdentityProvider = {
      beginLogin: async () => ({ kind: "redirect", url: "https://cas.example.test/login?service=https%3A%2F%2Ffastwrite.example.test%2Fapi%2Fauth%2Fcas%2Fcallback", binding: "cas-state" }),
      finishLogin: async ({ ticket }) => { if (ticket !== "ST-123") throw new Error("unexpected CAS ticket"); return { issuer: "https://cas.example.test", subject: "campus-1001", email: "campus.user@example.test", username: "campus-user", groups: ["physics"], emailVerified: true }; },
      logout: async () => undefined
    };
    const request = await testApplication(undefined, { serverAuth: true }, undefined, provider);
    const start = await request("/api/auth/cas/login");
    expect(start.status).toBe(302);
    expect(start.headers.get("location")).toContain("cas.example.test/login");
    const loginCookie = start.headers.get("set-cookie")?.split(";", 1)[0];
    const callback = await request("/api/auth/cas/callback?ticket=ST-123&state=cas-state", { headers: { cookie: loginCookie! } });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/?cas=complete");
    const refreshCookie = callback.headers.get("set-cookie")?.split(";", 1)[0];
    const session = await (await request("/api/auth/refresh", { method: "POST", headers: { cookie: refreshCookie! } })).json() as { user: { emailNormalized: string } };
    expect(session.user.emailNormalized).toBe("campus.user@example.test");
  });

  test("limits administrator account controls to audited metadata and revokes sessions", async () => {
    const request = await testApplication(undefined, { serverAuth: true });
    const admin = await (await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "platform-admin@example.test", password: "correct-horse-battery-staple" }) })).json() as { token: string; user: { id: string } };
    const user = await (await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "managed-user@example.test", password: "correct-horse-battery-staple" }) })).json() as { token: string; user: { id: string } };
    const adminHeaders = { authorization: `Bearer ${admin.token}`, "content-type": "application/json" };
    const userHeaders = { authorization: `Bearer ${user.token}`, "content-type": "application/json" };
    expect((await request("/api/admin/users", { headers: userHeaders })).status).toBe(403);
    const health = await request("/api/admin/health", { headers: adminHeaders });
    expect(await health.json()).toMatchObject({ users: 2, activeSessions: 2 });
    const users = await request("/api/admin/users", { headers: adminHeaders });
    const listedUsers = await users.json() as Array<{ id: string; activeSessionCount: number }>;
    expect(listedUsers).toEqual(expect.arrayContaining([expect.objectContaining({ id: user.user.id, activeSessionCount: 1 })]));
    expect(JSON.stringify(listedUsers)).not.toContain("password");
    expect((await request(`/api/admin/users/${user.user.id}/platform-role`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ role: "support_auditor", reason: "Grant read-only operations audit access." }) })).status).toBe(200);
    expect((await request("/api/admin/health", { headers: userHeaders })).status).toBe(200);
    expect((await request("/api/admin/users", { headers: userHeaders })).status).toBe(200);
    expect((await request("/api/admin/audit-events", { headers: userHeaders })).status).toBe(200);
    expect(await (await request("/api/admin/identity-providers", { headers: userHeaders })).json()).toEqual({ oidc: { configured: false }, cas: { configured: false }, local: { configured: true } });
    expect((await request(`/api/admin/users/${admin.user.id}/sessions/revoke`, { method: "POST", headers: userHeaders, body: JSON.stringify({ reason: "Support auditors must remain read-only." }) })).status).toBe(403);
    expect((await request(`/api/admin/users/${user.user.id}/platform-role`, { method: "PATCH", headers: userHeaders, body: JSON.stringify({ role: "user", reason: "Support auditors must remain read-only." }) })).status).toBe(403);
    expect((await request(`/api/admin/users/${admin.user.id}/platform-role`, { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ role: "user", reason: "Verify the final administrator protection." }) })).status).toBe(409);
    expect((await request(`/api/admin/users/${user.user.id}/disable`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ reason: "short" }) })).status).toBe(400);
    expect((await request(`/api/admin/users/${admin.user.id}/disable`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ reason: "Prevent accidental administrator lockout." }) })).status).toBe(409);
    expect((await request(`/api/admin/users/${user.user.id}/disable`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ reason: "Account requested closure through the research office." }) })).status).toBe(204);
    expect((await request("/api/auth/me", { headers: userHeaders })).status).toBe(401);
    const audits = await request("/api/admin/audit-events?limit=10", { headers: adminHeaders });
    expect(await audits.json()).toEqual(expect.arrayContaining([expect.objectContaining({ action: "user.disable", resourceId: user.user.id, metadata: { reason: "Account requested closure through the research office." } })]));
  });

  test("enforces commenter permissions when server authentication is enabled", async () => {
    const sentMail: Array<{ to: string; subject: string; text: string }> = [];
    const request = await testApplication(undefined, { serverAuth: true }, undefined, undefined, { send: async (message) => { sentMail.push(message); } });
    const owner = await (await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "strict-owner@example.test", password: "correct-horse-battery-staple" }) })).json() as { token: string; user: { id: string } };
    const ownerHeaders = { authorization: `Bearer ${owner.token}`, "content-type": "application/json" };
    const project = await (await request("/api/projects", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "Strict permissions" }) })).json() as PaperProject;
    const created = await request(`/api/projects/${project.id}/files`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ path: "paper.tex", content: "Hello world" }) });
    expect(created.status).toBe(201);
    const editorInvitation = await (await request(`/api/projects/${project.id}/invitations`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ email: "strict-editor@example.test", role: "editor" }) })).json() as { token: string };
    const editor = await (await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "strict-editor@example.test", password: "correct-horse-battery-staple" }) })).json() as { token: string; user: { id: string } };
    expect((await request(`/api/invitations/${editorInvitation.token}/accept`, { method: "POST", headers: { authorization: `Bearer ${editor.token}` } })).status).toBe(200);
    const editorHeaders = { authorization: `Bearer ${editor.token}`, "content-type": "application/json" };
    expect((await request(`/api/projects/${project.id}/files`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ path: "restricted/raw-results.tex", content: "\\section{Secret Results}\nOur restricted method improves accuracy by ten percent." }) })).status).toBe(201);
    const existingRoom = await (await request("/api/collaboration/tokens", { method: "POST", headers: editorHeaders, body: JSON.stringify({ projectId: project.id, path: "restricted/raw-results.tex" }) })).json() as { token: string };
    const aclRule = await request(`/api/projects/${project.id}/acl/new`, { method: "PUT", headers: ownerHeaders, body: JSON.stringify({ pathPrefix: "restricted", subjectType: "user", subjectId: editor.user.id, action: "read", effect: "deny" }) });
    expect(aclRule.status).toBe(200);
    const restrictedClaims = await (await request(`/api/projects/${project.id}/claim-scans`, { method: "POST", headers: ownerHeaders })).json() as PaperClaim[];
    expect(restrictedClaims).toHaveLength(1);
    expect((await request(`/api/projects/${project.id}/file?path=restricted/raw-results.tex`, { headers: editorHeaders })).status).toBe(403);
    expect((await request(`/api/projects/${project.id}/collaboration?path=restricted/raw-results.tex`, { headers: editorHeaders })).status).toBe(403);
    expect((await request(`/api/projects/${project.id}/collaboration`, { method: "POST", headers: editorHeaders, body: JSON.stringify({ path: "restricted/raw-results.tex", update: "AA==", baseVersion: 1 }) })).status).toBe(403);
    expect((await request(`/api/projects/${project.id}/collaboration/persist`, { method: "POST", headers: editorHeaders, body: JSON.stringify({ path: "restricted/raw-results.tex", documentId: "denied", update: "AA==" }) })).status).toBe(403);
    expect((await request(`/api/projects/${project.id}/collaboration/presence`, { method: "POST", headers: editorHeaders, body: JSON.stringify({ clientId: "denied-editor", path: "restricted/raw-results.tex" }) })).status).toBe(403);
    expect((await request(`/api/collaboration/room-access?token=${encodeURIComponent(existingRoom.token)}`)).status).toBe(403);
    expect((await request("/api/collaboration/tokens", { method: "POST", headers: editorHeaders, body: JSON.stringify({ projectId: project.id, path: "restricted/raw-results.tex" }) })).status).toBe(403);
    const editorTree = await request(`/api/projects/${project.id}/files`, { headers: editorHeaders });
    expect(JSON.stringify(await editorTree.json())).not.toContain("restricted");
    expect(JSON.stringify(await (await request(`/api/projects/${project.id}/outline`, { headers: editorHeaders })).json())).not.toContain("Secret Results");
    expect(JSON.stringify(await (await request(`/api/projects/${project.id}/claims`, { headers: editorHeaders })).json())).not.toContain("restricted method");
    expect((await request(`/api/projects/${project.id}/claims/${restrictedClaims[0]!.id}`, { method: "PATCH", headers: editorHeaders, body: JSON.stringify({ reviewStatus: "unsupported" }) })).status).toBe(403);
    expect((await request(`/api/projects/${project.id}/comments`, { method: "POST", headers: editorHeaders, body: JSON.stringify({ path: "restricted/raw-results.tex", from: 0, to: 9, body: "Cannot discuss this restricted result." }) })).status).toBe(403);
    expect((await request(`/api/projects/${project.id}/file?path=restricted/raw-results.tex`, { headers: ownerHeaders })).status).toBe(200);
    expect((await request(`/api/projects/${project.id}`, { method: "DELETE", headers: { authorization: `Bearer ${editor.token}` } })).status).toBe(403);
    expect((await request(`/api/projects/${project.id}`, { method: "PATCH", headers: { authorization: `Bearer ${editor.token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Editor rename" }) })).status).toBe(403);
    expect((await request(`/api/projects/${project.id}/shares`, { method: "POST", headers: { authorization: `Bearer ${editor.token}`, "content-type": "application/json" }, body: JSON.stringify({ permission: "read" }) })).status).toBe(403);
    expect((await request(`/api/projects/${project.id}/audit`, { headers: { authorization: `Bearer ${editor.token}` } })).status).toBe(403);
    const audit = await request(`/api/projects/${project.id}/audit`, { headers: ownerHeaders });
    expect((await audit.json() as Array<{ action: string }>).some((event) => event.action === "project.create")).toBe(true);
    const invitation = await (await request(`/api/projects/${project.id}/invitations`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ email: "commenter@example.test", role: "commenter" }) })).json() as { token: string };
    const commenter = await (await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "commenter@example.test", password: "correct-horse-battery-staple" }) })).json() as { token: string; user: { id: string } };
    expect((await request(`/api/invitations/${invitation.token}/accept`, { method: "POST", headers: { authorization: `Bearer ${commenter.token}` } })).status).toBe(200);
    const commenterHeaders = { authorization: `Bearer ${commenter.token}`, "content-type": "application/json" };
    expect((await request(`/api/projects/${project.id}/files`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ path: "reviews/reviewer-notes.tex", content: "Initial reviewer notes" }) })).status).toBe(201);
    expect((await request(`/api/projects/${project.id}/acl/new`, { method: "PUT", headers: ownerHeaders, body: JSON.stringify({ pathPrefix: "reviews/reviewer-notes.tex", subjectType: "user", subjectId: commenter.user.id, action: "edit", effect: "allow" }) })).status).toBe(200);
    const reviewerNotes = await (await request(`/api/projects/${project.id}/file?path=reviews/reviewer-notes.tex`, { headers: ownerHeaders })).json() as FileContentResponse;
    expect((await request(`/api/projects/${project.id}/file?path=reviews/reviewer-notes.tex`, { method: "PUT", headers: commenterHeaders, body: JSON.stringify({ content: "Reviewer edits this delegated note", baseVersion: reviewerNotes.file.version }) })).status).toBe(200);
    const comment = await request(`/api/projects/${project.id}/comments`, { method: "POST", headers: commenterHeaders, body: JSON.stringify({ path: "paper.tex", from: 0, to: 5, body: `Please clarify this opening. @[Owner](${owner.user.id})` }) });
    expect(comment.status).toBe(201);
    const commentResult = await comment.json() as { id: string; messages: Array<{ mentionedUserIds?: string[] }> };
    expect(commentResult).toMatchObject({ messages: [expect.objectContaining({ mentionedUserIds: [owner.user.id] })] });
    const notifications = await request("/api/notifications", { headers: ownerHeaders });
    expect(await notifications.json()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "mention", projectId: project.id })]));
    const preferences = await request("/api/notification-preferences", { headers: ownerHeaders });
    expect(await preferences.json()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "mention", inApp: true, email: false })]));
    expect((await request("/api/notification-preferences/mention", { method: "PUT", headers: ownerHeaders, body: JSON.stringify({ inApp: false, email: true }) })).status).toBe(200);
    expect((await request(`/api/projects/${project.id}/comments/${commentResult.id}/messages`, { method: "POST", headers: commenterHeaders, body: JSON.stringify({ body: `A further note for @[Owner](${owner.user.id})` }) })).status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sentMail).toEqual([{ to: "strict-owner@example.test", subject: "FastWrite: You were mentioned in a comment", text: "You have a new FastWrite notification. Sign in to view it." }]);
    const afterPreference = await request("/api/notifications", { headers: ownerHeaders });
    expect((await afterPreference.json() as Array<{ type: string }>).filter((item) => item.type === "mention")).toHaveLength(1);
    expect((await request(`/api/projects/${project.id}/files`, { method: "POST", headers: commenterHeaders, body: JSON.stringify({ path: "blocked.tex", content: "No permission" }) })).status).toBe(403);
  });

  test("filters denied paths from Review context and rejects Revise selections before provider access", async () => {
    let reviewedPaths: string[] = [];
    let reviseCalls = 0;
    let planCalls = 0;
    const provider: AgentProvider = {
      async revise(input) { reviseCalls += 1; return { replacement: input.selection.text, rationale: "unused" }; },
      async planAgentTask() { planCalls += 1; return { steps: ["Inspect manuscript"], affectedFiles: ["main.tex"], risks: [], validation: [] }; },
      async review(input) {
        reviewedPaths = input.documents.map((document) => document.path);
        const evidencePath = input.documents.find((document) => document.path === "restricted/findings.tex")?.path ?? "main.tex";
        return { overallAssessment: "No concerns.", recommendation: "accept", strengths: [], weaknesses: [], nextSteps: [], issues: [{ category: "clarity", severity: "minor", title: "Clarify scope", rationale: "The current wording needs context.", impact: "Readers may misinterpret the scope.", suggestion: "Clarify the scope.", evidence: [{ path: evidencePath, section: null, line: null, excerpt: "finding", inferred: false }] }] };
      }
    };
    const request = await testApplication(provider, { serverAuth: true });
    await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "review-acl-bootstrap@example.test", password: "correct-horse-battery-staple" }) });
    const owner = await (await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "review-acl-owner@example.test", password: "correct-horse-battery-staple" }) })).json() as { token: string; user: { id: string } };
    const reviewer = await (await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "review-acl-editor@example.test", password: "correct-horse-battery-staple" }) })).json() as { token: string; user: { id: string } };
    const ownerHeaders = { authorization: `Bearer ${owner.token}`, "content-type": "application/json" };
    const reviewerHeaders = { authorization: `Bearer ${reviewer.token}`, "content-type": "application/json" };
    const project = await (await request("/api/projects", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "Review ACL" }) })).json() as PaperProject;
    const invitation = await (await request(`/api/projects/${project.id}/invitations`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ email: "review-acl-editor@example.test", role: "editor" }) })).json() as { token: string };
    expect((await request(`/api/invitations/${invitation.token}/accept`, { method: "POST", headers: { authorization: `Bearer ${reviewer.token}` } })).status).toBe(200);
    expect((await request(`/api/projects/${project.id}/files`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ path: "restricted/findings.tex", content: "Restricted finding" }) })).status).toBe(201);
    await request(`/api/projects/${project.id}/history/checkpoint`, { method: "POST", headers: ownerHeaders });
    const checkpoint = (await (await request(`/api/projects/${project.id}/history?limit=1`, { headers: ownerHeaders })).json() as Array<{ oid: string }>)[0]!;
    expect((await request(`/api/projects/${project.id}/acl/new`, { method: "PUT", headers: ownerHeaders, body: JSON.stringify({ pathPrefix: "restricted", subjectType: "user", subjectId: reviewer.user.id, action: "run_ai", effect: "deny" }) })).status).toBe(200);
    expect((await request(`/api/projects/${project.id}/acl/new`, { method: "PUT", headers: ownerHeaders, body: JSON.stringify({ pathPrefix: "restricted", subjectType: "user", subjectId: reviewer.user.id, action: "read", effect: "deny" }) })).status).toBe(200);

    expect((await request(`/api/projects/${project.id}/reviews`, { method: "POST", headers: reviewerHeaders, body: JSON.stringify({ sourceOnly: true }) })).status).toBe(201);
    expect(reviewedPaths).toContain("main.tex");
    expect(reviewedPaths).not.toContain("restricted/findings.tex");
    const ownerReview = await (await request(`/api/projects/${project.id}/reviews`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ sourceOnly: true }) })).json() as { report: { issues: Array<{ id: string }> } };
    const reviewerReports = await (await request(`/api/projects/${project.id}/reviews`, { headers: reviewerHeaders })).json() as Array<{ snapshotId: string }>;
    expect(reviewerReports).toHaveLength(1);
    expect((await request(`/api/projects/${project.id}/review-issues/${ownerReview.report.issues[0]!.id}`, { method: "PATCH", headers: reviewerHeaders, body: JSON.stringify({ status: "dismissed" }) })).status).toBe(403);

    const restricted = await (await request(`/api/projects/${project.id}/file?path=restricted/findings.tex`, { headers: ownerHeaders })).json() as FileContentResponse;
    const revise = await request(`/api/projects/${project.id}/revisions`, { method: "POST", headers: reviewerHeaders, body: JSON.stringify({ command: "academic-polish", selection: { path: "restricted/findings.tex", text: restricted.content, from: 0, to: restricted.content.length, startLine: 1, endLine: 1, fileVersion: restricted.file.version } }) });
    expect(revise.status).toBe(403);
    expect(reviseCalls).toBe(0);
    expect((await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: reviewerHeaders, body: JSON.stringify({ objective: "Check the manuscript", scope: { type: "project" } }) })).status).toBe(403);
    expect(planCalls).toBe(0);
    expect((await request(`/api/projects/${project.id}/compile`, { method: "POST", headers: reviewerHeaders })).status).toBe(403);
    expect((await request(`/api/projects/${project.id}/export`, { headers: reviewerHeaders })).status).toBe(403);
    expect((await request(`/api/projects/${project.id}/history/${checkpoint.oid}/file?path=restricted/findings.tex`, { headers: reviewerHeaders })).status).toBe(403);
    expect((await request(`/api/projects/${project.id}/history/${checkpoint.oid}/side?path=restricted/findings.tex`, { headers: reviewerHeaders })).status).toBe(403);
    expect((await request(`/api/projects/${project.id}/history/${checkpoint.oid}/tree`, { headers: reviewerHeaders })).status).toBe(403);
    expect((await request(`/api/projects/${project.id}/history/${checkpoint.oid}`, { headers: reviewerHeaders })).status).toBe(403);
    expect((await request(`/api/projects/${project.id}/history-compare?baseRef=empty&targetRef=${checkpoint.oid}&path=restricted/findings.tex`, { headers: reviewerHeaders })).status).toBe(403);
    expect((await request(`/api/projects/${project.id}/history-page?path=restricted/findings.tex`, { headers: reviewerHeaders })).status).toBe(403);
    expect((await request(`/api/projects/${project.id}/completions`, { method: "POST", headers: reviewerHeaders, body: JSON.stringify({ path: "restricted/findings.tex", cursor: 0, fileVersion: 1, kind: "auto" }) })).status).toBe(403);
    expect((await request(`/api/projects/${project.id}/mcp/call`, { method: "POST", headers: reviewerHeaders, body: JSON.stringify({ name: "workspace.search", input: { query: "finding" } }) })).status).toBe(403);
    expect((await request(`/api/projects/${project.id}/mcp/call`, { method: "POST", headers: reviewerHeaders, body: JSON.stringify({ name: "latex.compile", input: {} }) })).status).toBe(403);
    expect((await request(`/api/projects/${project.id}/acl/new`, { method: "PUT", headers: ownerHeaders, body: JSON.stringify({ pathPrefix: "restricted", subjectType: "user", subjectId: owner.user.id, action: "read", effect: "deny" }) })).status).toBe(200);
    expect((await request(`/api/projects/${project.id}/github-sync`, { method: "POST", headers: ownerHeaders })).status).toBe(403);
  });

  test("routes authenticated project access requests to an owner for approval", async () => {
    const request = await testApplication(undefined, { serverAuth: true });
    const owner = await (await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "access-owner@example.test", password: "correct-horse-battery-staple" }) })).json() as { token: string };
    const requester = await (await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "access-requester@example.test", password: "correct-horse-battery-staple", displayName: "External reviewer" }) })).json() as { token: string; user: { id: string } };
    const ownerHeaders = { authorization: `Bearer ${owner.token}`, "content-type": "application/json" };
    const requesterHeaders = { authorization: `Bearer ${requester.token}`, "content-type": "application/json" };
    const project = await (await request("/api/projects", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "Access request paper" }) })).json() as PaperProject;
    const accessInfo = await request(`/api/access-requests/${project.id}`, { headers: requesterHeaders });
    expect(await accessInfo.json()).toEqual({ id: project.id, name: "Access request paper" });
    const created = await request(`/api/projects/${project.id}/access-requests`, { method: "POST", headers: requesterHeaders, body: JSON.stringify({ role: "editor", message: "I will check the experimental section." }) });
    expect(created.status).toBe(201);
    const accessRequest = await created.json() as { id: string; requestedRole: string };
    expect(accessRequest.requestedRole).toBe("editor");
    const pending = await request(`/api/projects/${project.id}/access-requests`, { headers: ownerHeaders });
    expect((await pending.json() as Array<{ requester: { id: string; displayName: string; emailNormalized: string } }>)[0]?.requester).toEqual({ id: requester.user.id, displayName: "External reviewer", emailNormalized: "access-requester@example.test" });
    const notifications = await request("/api/notifications", { headers: ownerHeaders });
    expect(await notifications.json()).toEqual(expect.arrayContaining([expect.objectContaining({ type: "access_request", projectId: project.id, accessRequestId: accessRequest.id })]));
    expect((await request(`/api/projects/${project.id}/access-requests/${accessRequest.id}/decision`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ approved: true }) })).status).toBe(200);
    const members = await request(`/api/projects/${project.id}/members`, { headers: requesterHeaders });
    expect(await members.json()).toMatchObject({ members: expect.arrayContaining([expect.objectContaining({ userId: requester.user.id, role: "editor" })]) });
  });

  test("creates a team-owned project and records an audited ownership transfer", async () => {
    const request = await testApplication();
    const owner = await (await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "team-owner@example.test", password: "correct-horse-battery-staple" }) })).json() as { token: string; user: { id: string } };
    const headers = { authorization: `Bearer ${owner.token}`, "content-type": "application/json" };
    const team = await (await request("/api/teams", { method: "POST", headers, body: JSON.stringify({ name: "Paper lab" }) })).json() as { id: string };
    const project = await (await request("/api/projects", { method: "POST", headers, body: JSON.stringify({ name: "Team paper", teamId: team.id }) })).json() as PaperProject;
    expect(project.id).toEqual(expect.any(String));
    const transferred = await request(`/api/projects/${project.id}/transfer`, { method: "POST", headers, body: JSON.stringify({ personalOwnerUserId: owner.user.id }) });
    expect(transferred.status).toBe(200);
    expect(await transferred.json()).toMatchObject({ personalOwnerUserId: owner.user.id, visibility: "private" });
  });

  test("lets a team owner manage members and pending invitations", async () => {
    const request = await testApplication(undefined, { serverAuth: true });
    const owner = await (await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "team-governance-owner@example.test", password: "correct-horse-battery-staple" }) })).json() as { token: string };
    const member = await (await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "team-governance-member@example.test", password: "correct-horse-battery-staple", displayName: "Lab member" }) })).json() as { token: string; user: { id: string } };
    const ownerHeaders = { authorization: `Bearer ${owner.token}`, "content-type": "application/json" };
    const team = await (await request("/api/teams", { method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "Governance lab" }) })).json() as { id: string };
    const expiry = new Date(Date.now() + 3 * 86400_000).toISOString();
    const invitationResponse = await request(`/api/teams/${team.id}/invitations`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        email: "team-governance-member@example.test",
        role: "member",
        expiresAt: expiry,
        message: "Please coordinate the reproducibility appendix.",
      }),
    });
    expect(invitationResponse.status).toBe(201);
    const invitation = await invitationResponse.json() as { token: string; invitation: { expiresAt: string; message?: string; tokenHash?: string } };
    expect(invitation.invitation.message).toBe("Please coordinate the reproducibility appendix.");
    expect(invitation.invitation.tokenHash).toBeUndefined();
    expect(Date.parse(invitation.invitation.expiresAt)).toBeGreaterThan(Date.now() + 71 * 3_600_000);
    expect((await request(`/api/teams/${team.id}/invitations`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ email: "bad-team-expiry@example.test", role: "member", expiresAt: new Date(Date.now() + 5_000).toISOString() }) })).status).toBe(400);
    const pendingInvitations = await request(`/api/teams/${team.id}/invitations`, { headers: ownerHeaders });
    const pendingInvitationsBody = await pendingInvitations.json() as Array<{ message?: string; tokenHash?: string }>;
    expect(pendingInvitationsBody).toEqual(expect.arrayContaining([expect.objectContaining({ message: "Please coordinate the reproducibility appendix." })]));
    expect(JSON.stringify(pendingInvitationsBody)).not.toContain("tokenHash");
    expect((await request(`/api/invitations/${invitation.token}/accept`, { method: "POST", headers: { authorization: `Bearer ${member.token}` } })).status).toBe(200);
    const roster = await request(`/api/teams/${team.id}/members`, { headers: ownerHeaders });
    const rosterBody = await roster.json() as { canManage: boolean; members: Array<{ userId: string; role: string; user: { displayName: string } }> };
    expect(rosterBody.canManage).toBe(true);
    expect(rosterBody.members.some((item) => item.userId === member.user.id && item.role === "member" && item.user.displayName === "Lab member")).toBe(true);
    expect((await request(`/api/teams/${team.id}/members/${member.user.id}`, { method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ role: "admin" }) })).status).toBe(200);
    const adminRoster = await request(`/api/teams/${team.id}/members`, { headers: { authorization: `Bearer ${member.token}` } });
    expect(await adminRoster.json()).toMatchObject({ canManage: false, canManageInvitations: true });
    expect((await request(`/api/teams/${team.id}/members/${member.user.id}`, { method: "DELETE", headers: ownerHeaders })).status).toBe(204);
    const pending = await (await request(`/api/teams/${team.id}/invitations`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ email: "pending-team@example.test", role: "member" }) })).json() as { invitation: { id: string } };
    expect((await request(`/api/invitations/${pending.invitation.id}`, { method: "DELETE", headers: ownerHeaders })).status).toBe(204);
  });

  test("stores scoped Harness secrets without returning them and resolves a versioned profile", async () => {
    const request = await testApplication();
    const registered = await (await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@example.test", password: "correct-horse-battery-staple" }) })).json() as { token: string };
    const headers = { authorization: `Bearer ${registered.token}`, "content-type": "application/json" };
    const response = await request("/api/harness/profiles", { method: "POST", headers, body: JSON.stringify({ scope: "system", name: "System Codex", provider: "codex", model: "gpt-test", wireApi: "responses", allowedTools: ["workspace.read"], maxConcurrentRuns: 2, apiKey: "secret-never-returned" }) });
    expect(response.status).toBe(201);
    expect(JSON.stringify(await response.json())).not.toContain("secret-never-returned");
    const effective = await request("/api/harness/effective", { headers });
    expect(effective.status).toBe(200);
    const resolved = await effective.json() as { fingerprint: string; hasSecret: boolean; sourceChain: unknown[] };
    expect(resolved).toMatchObject({ hasSecret: true, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(resolved.sourceChain).toHaveLength(1);
  });

  test("applies team Harness policy before allowing a personal profile for a team project", async () => {
    const request = await testApplication();
    const registered = await (await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "policy@example.test", password: "correct-horse-battery-staple" }) })).json() as { token: string };
    const headers = { authorization: `Bearer ${registered.token}`, "content-type": "application/json" };
    const team = await (await request("/api/teams", { method: "POST", headers, body: JSON.stringify({ name: "Policy lab" }) })).json() as { id: string };
    const project = await (await request("/api/projects", { method: "POST", headers, body: JSON.stringify({ name: "Policy paper", teamId: team.id }) })).json() as PaperProject;
    const teamProfile = await (await request("/api/harness/profiles", { method: "POST", headers, body: JSON.stringify({ scope: "team", teamId: team.id, name: "Team profile", provider: "codex", wireApi: "responses", allowedTools: ["workspace.read"], maxConcurrentRuns: 1 }) })).json() as { id: string };
    const personalProfile = await (await request("/api/harness/profiles", { method: "POST", headers, body: JSON.stringify({ scope: "user", name: "Personal profile", provider: "codex", wireApi: "responses", allowedTools: ["workspace.read"], maxConcurrentRuns: 1 }) })).json() as { id: string };
    const defaultResolved = await (await request(`/api/harness/effective?projectId=${project.id}`, { headers })).json() as { profileId: string };
    expect(defaultResolved.profileId).toBe(teamProfile.id);
    const policy = await request(`/api/teams/${team.id}/harness-policy`, { method: "PATCH", headers, body: JSON.stringify({ personalHarness: true, allowedProviders: ["codex"] }) });
    expect(policy.status).toBe(200);
    const personalResolved = await (await request(`/api/harness/effective?projectId=${project.id}`, { headers })).json() as { profileId: string };
    expect(personalResolved.profileId).toBe(personalProfile.id);
  });

  test("reports configured Harness capabilities and rejects unknown Harnesses", async () => {
    const request = await testApplication();
    const response = await request("/api/harnesses");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: expect.objectContaining({ kind: "codex", state: expect.stringMatching(/^(ready|degraded|unavailable)$/) }), capabilities: expect.objectContaining({ streaming: true, sessions: true, skills: true, mcp: true }) }),
      expect.objectContaining({ status: expect.objectContaining({ kind: "claude", state: expect.stringMatching(/^(ready|degraded|unavailable)$/) }) })
    ]));
    const invalid = await request("/api/harnesses/unknown/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "/tmp" }) });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "harness_invalid" } });
  });

  test("returns a structured error for an unknown Harness run", async () => {
    const request = await testApplication();
    const response = await request("/api/harness-runs/run_missing");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "harness_run_not_found" } });
  });

  test("executes MCP workspace tools only when explicitly allowed", async () => {
    const request = await testApplication();
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "MCP tools" }) })).json() as PaperProject;
    const denied = await request(`/api/projects/${project.id}/mcp/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "workspace.read", input: { path: "main.tex" }, allow: [] }) });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "mcp_tool_denied" } });
    const allowed = await request(`/api/projects/${project.id}/mcp/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "workspace.read", input: { path: "main.tex" }, allow: ["workspace.read"] }) });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ path: "main.tex", content: expect.stringContaining("\\documentclass") });
    const audit = await request(`/api/mcp/audit?projectId=${encodeURIComponent(project.id)}`);
    expect(audit.status).toBe(200);
    expect(await audit.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectId: project.id, tool: "workspace.read", status: "denied" }),
      expect.objectContaining({ projectId: project.id, tool: "workspace.read", status: "completed" })
    ]));
  });

  test("serves module workers with a browser-safe MIME type", () => {
    expect(mimeType(".mjs")).toBe("text/javascript; charset=utf-8");
    expect(mimeType(".wasm")).toBe("application/wasm");
  });

  test("accepts a runtime Agent key without exposing it", async () => {
    const request = await testApplication();
    const before = await request("/api/harness-settings");
    expect(before.status).toBe(200);
    const configured = await request("/api/harness-settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-test-private-key", baseURL: "https://api.example.test/v1", model: "test-model", wireAPI: "responses" })
    });
    expect(configured.status).toBe(200);
    expect(await configured.json()).toMatchObject({ configured: true, source: "runtime", baseURL: "https://api.example.test/v1", model: "test-model", wireAPI: "responses" });
    const status = await request("/api/harness-settings");
    expect(JSON.stringify(await status.json())).not.toContain("sk-test-private-key");
  });

  test("exports a bounded provenance dossier without manuscript or secret content", async () => {
    const request = await testApplication();
    const created = await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Provenance paper", mainDocument: "main.tex", venue: "sp" }) });
    const project = await created.json() as { id: string };
    const response = await request(`/api/projects/${project.id}/provenance`);
    expect(response.status).toBe(200);
    const dossier = await response.json() as { project: { id: string }; runs: unknown[]; changeSets: unknown[]; disclosureDraft: string };
    expect(dossier.project.id).toBe(project.id);
    expect(dossier.runs).toEqual([]);
    expect(dossier.changeSets).toEqual([]);
    expect(dossier.disclosureDraft).toContain("No AI-assisted");
    expect(dossier.disclosureDraft).not.toContain("main.tex");
    expect(JSON.stringify(dossier)).not.toContain("documentclass");
  });

  test("queues compile jobs and exposes bounded job lifecycle", async () => {
    const request = await testApplication();
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Queued compile" }) })).json() as { id: string };
    const queued = await request(`/api/projects/${project.id}/compile`, { method: "POST" });
    expect(queued.status).toBe(202);
    const job = await queued.json() as { id: string; kind: string; status: string };
    expect(job).toMatchObject({ kind: "latex.compile", status: expect.stringMatching(/queued|running|completed|failed/) });
    const state = await request(`/api/jobs/${job.id}`);
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({ id: job.id, kind: "latex.compile" });
  });

  test("does not expose an authenticated compile job to another user", async () => {
    const request = await testApplication(undefined, { serverAuth: true });
    const first = await (await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `job-a-${crypto.randomUUID()}@example.test`, password: "job-password-123" }) })).json() as { token: string };
    const second = await (await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `job-b-${crypto.randomUUID()}@example.test`, password: "job-password-123" }) })).json() as { token: string };
    const project = await (await request("/api/projects", { method: "POST", headers: { authorization: `Bearer ${first.token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Private queued compile" }) })).json() as { id: string };
    const queued = await request(`/api/projects/${project.id}/compile`, { method: "POST", headers: { authorization: `Bearer ${first.token}` } });
    const job = await queued.json() as { id: string };
    expect((await request(`/api/jobs/${job.id}`, { headers: { authorization: `Bearer ${second.token}` } })).status).toBe(403);
  });

  test("lists bounded internal history checkpoints", async () => {
    const request = await testApplication();
    const created = await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "History paper", mainDocument: "main.tex", venue: "sp" }) });
    const project = await created.json() as { id: string };
    await request(`/api/projects/${project.id}/history/checkpoint`, { method: "POST" });
    const response = await request(`/api/projects/${project.id}/history?limit=1`);
    expect(response.status).toBe(200);
    const history = await response.json() as Array<{ oid: string; message: string; createdAt: string }>;
    expect(history.length).toBeLessThanOrEqual(1);
    expect(history[0]).toMatchObject({ oid: expect.any(String), message: expect.any(String), createdAt: expect.any(String) });
  });

  test("history endpoints expose real changes, immutable identities, trees and missing-file metadata", async () => {
    const request = await testApplication();
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "History API", mainDocument: "main.tex" }) })).json() as PaperProject;
    const root = `/api/projects/${project.id}`;
    const history = await (await request(`${root}/history`)).json() as Array<{ oid: string }>;
    const initial = history[0]!.oid;
    const opened = await (await request(`${root}/file?path=main.tex`)).json() as FileContentResponse;
    await request(`${root}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "new content\n", baseVersion: opened.file.version }) });
    await request(`${root}/history/checkpoint`, { method: "POST" });
    const page = await (await request(`${root}/history-page?limit=1`)).json() as { commits: Array<{ oid: string; parentOids: string[] }>; nextCursor: string };
    const latest = page.commits[0]!.oid;
    expect(page.commits[0]!.parentOids).toEqual([initial]);
    const summary = await (await request(`${root}/history/${latest}`)).json() as { paths: string[]; files: Array<{ path: string; status: string }> };
    expect(summary.paths).toEqual(["main.tex"]);
    expect(summary.files[0]).toMatchObject({ path: "main.tex", status: "M" });
    const tree = await (await request(`${root}/history/${initial}/tree`)).json() as Array<{ path: string }>;
    expect(tree.map(file => file.path)).toContain("main.tex");
    const missing = await request(`${root}/history/${initial}/side?path=not-there.tex`);
    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({ ref: initial, path: "not-there.tex", exists: false });
    expect((await request(`${root}/history/${initial}/file?path=not-there.tex`)).status).toBe(404);
    expect((await request(`${root}/history/${"0".repeat(40)}`)).status).toBe(404);
    const comparison = await (await request(`${root}/history-compare?baseRef=${initial}&targetRef=${latest}&path=main.tex`)).json();
    expect(comparison).toMatchObject({ original: { ref: initial, content: opened.content }, modified: { ref: latest, content: "new content\n" } });
    const next = await (await request(`${root}/history-page?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`)).json() as { commits: Array<{ oid: string }> };
    expect(next.commits[0]!.oid).toBe(initial);
    const current = await (await request(root)).json() as PaperProject;
    const restore = (expectedVersion: number) => request(`${root}/history/${initial}/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths: ["main.tex"], expectedVersion }) });
    expect((await restore(current.version - 1)).status).toBe(409);
    expect(((await (await request(`${root}/file?path=main.tex`)).json()) as FileContentResponse).content).toBe("new content\n");
    const restored = await restore(current.version);
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ oid: expect.any(String), restored: ["main.tex"] });
    expect(((await (await request(`${root}/file?path=main.tex`)).json()) as FileContentResponse).content).toBe(opened.content);
  });

  test("creates revocable read-only and comment share links without exposing stored tokens", async () => {
    const request = await testApplication();
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Shared paper", mainDocument: "main.tex", venue: "sp" }) })).json() as PaperProject;
    const readShare = await (await request(`/api/projects/${project.id}/shares`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ permission: "read" }) })).json() as { id: string; token: string };
    expect((await request(`/api/shared/${readShare.token}`)).status).toBe(200);
    expect((await request(`/api/shared/${readShare.token}/file?path=main.tex`)).status).toBe(200);
    const denied = await request(`/api/shared/${readShare.token}/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "main.tex", author: "Reviewer", body: "Comment" }) });
    expect(denied.status).toBe(403);
    const commentShare = await (await request(`/api/projects/${project.id}/shares`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ permission: "comment" }) })).json() as { id: string; token: string };
    expect((await request(`/api/shared/${commentShare.token}/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "main.tex", line: 2, author: "Reviewer", body: "Please clarify." }) })).status).toBe(201);
    const listed = JSON.stringify(await (await request(`/api/projects/${project.id}/shares`)).json());
    expect(listed).not.toContain(readShare.token);
    await request(`/api/projects/${project.id}/shares/${readShare.id}`, { method: "DELETE" });
    expect((await request(`/api/shared/${readShare.token}`)).status).toBe(404);
  });

  test("merges Yjs collaboration updates through PaperFile versions", async () => {
    const request = await testApplication();
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Collaborative paper", mainDocument: "main.tex", venue: "sp" }) })).json() as PaperProject;
    const initial = await (await request(`/api/projects/${project.id}/collaboration?path=main.tex`)).json() as { fileVersion: number; update: string };
    const document = new Y.Doc(); Y.applyUpdate(document, Buffer.from(initial.update, "base64")); document.getText("content").insert(document.getText("content").length, "\n% collaborative edit");
    const response = await request(`/api/projects/${project.id}/collaboration`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "main.tex", baseVersion: initial.fileVersion, update: Buffer.from(Y.encodeStateAsUpdate(document)).toString("base64"), clientId: "client-a", name: "Author", line: 2 }) });
    expect(response.status).toBe(200);
    const merged = await response.json() as { fileVersion: number; presence: Array<{ name: string }> };
    expect(merged.fileVersion).toBeGreaterThan(initial.fileVersion);
    expect(merged.presence).toContainEqual(expect.objectContaining({ name: "Author" }));
    const file = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    expect(file.content).toContain("collaborative edit");
  });

  test("persists the requested CRDT snapshot before acknowledging despite delayed or duplicate transport", async () => {
    const request = await testApplication();
    const headers = { "content-type": "application/json" };
    const project = await (await request("/api/projects", { method: "POST", headers, body: JSON.stringify({ name: "CRDT persistence barrier" }) })).json() as PaperProject;
    const initial = await (await request(`/api/projects/${project.id}/collaboration?path=main.tex`)).json() as { documentId: string; update: string };
    const left = new Y.Doc(), right = new Y.Doc();
    for (const doc of [left, right]) Y.applyUpdate(doc, Buffer.from(initial.update, "base64"));
    left.getText("content").insert(0, "% left edit\n");
    right.getText("content").insert(0, "% right edit\n");
    const persist = (doc: Y.Doc, documentId = initial.documentId) => request(`/api/projects/${project.id}/collaboration/persist`, { method: "POST", headers, body: JSON.stringify({ path: "main.tex", documentId, update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64") }) });
    // Neither edit has arrived over WS. Each HTTP request must carry its own barrier.
    const results = await Promise.all([persist(left), persist(right)]);
    expect(results.map(result => result.status)).toEqual([200, 200]);
    const last = await results[1]!.json() as { update: string; content: string; fileVersion: number };
    Y.applyUpdate(left, Buffer.from(last.update, "base64"));
    expect(left.getText("content").toString()).toContain("% left edit");
    expect(left.getText("content").toString()).toContain("% right edit");
    const file = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    expect(file.content).toBe(last.content);
    expect(file.file.version).toBe(last.fileVersion);
    // A delayed duplicate from either transport must not insert the text twice.
    const duplicate = await (await persist(left)).json() as { content: string; fileVersion: number };
    expect(duplicate.content).toBe(file.content);
    expect(duplicate.fileVersion).toBe(file.file.version);
    left.getText("content").delete(0, 1);
    const deleted = await (await persist(left)).json() as { content: string };
    expect(deleted.content).toBe(left.getText("content").toString());
    expect((await persist(right, "replaced-document")).status).toBe(409);
    expect((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse).content).toBe(deleted.content);
    const incomplete = new Y.Doc();
    incomplete.getText("content").insert(0, "dependency");
    const vector = Y.encodeStateVector(incomplete);
    incomplete.getText("content").insert(10, "late");
    const invalid = await request(`/api/projects/${project.id}/collaboration/persist`, { method: "POST", headers, body: JSON.stringify({ path: "main.tex", documentId: initial.documentId, update: Buffer.from(Y.encodeStateAsUpdate(incomplete, vector)).toString("base64") }) });
    expect(invalid.status).toBe(409);
    expect((await invalid.json() as { error: { code: string } }).error.code).toBe("collaboration_update_incomplete");
    expect((await request(`/api/projects/${project.id}/collaboration/persist`, { method: "POST", headers, body: JSON.stringify({ path: "main.tex", documentId: initial.documentId, update: "not-an-update" }) })).status).toBe(400);
    expect((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse).content).toBe(deleted.content);
    incomplete.destroy();
    left.destroy(); right.destroy();
  });

  test("restores persisted Yjs updates after an application restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fastwrite-collaboration-restart-"));
    temporaryDirectories.push(directory);
    const first = await createApplication(directory);
    const request = (app: Awaited<ReturnType<typeof createApplication>>, path: string, init?: RequestInit) => app(new Request(`http://fastwrite.test${path}`, init));
    const project = await (await request(first, "/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Persistent CRDT" }) })).json() as PaperProject;
    const initial = await (await request(first, `/api/projects/${project.id}/collaboration?path=main.tex`)).json() as { fileVersion: number; update: string; documentId: string };
    const ydoc = new Y.Doc(); Y.applyUpdate(ydoc, Buffer.from(initial.update, "base64")); ydoc.getText("content").insert(ydoc.getText("content").length, "\n% survives restart");
    expect((await request(first, `/api/projects/${project.id}/collaboration`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "main.tex", baseVersion: initial.fileVersion, update: Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString("base64") }) })).status).toBe(200);
    ydoc.getText("content").insert(0, "% barrier survives restart\n");
    expect((await request(first, `/api/projects/${project.id}/collaboration/persist`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "main.tex", documentId: initial.documentId, update: Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString("base64") }) })).status).toBe(200);
    const second = await createApplication(directory);
    const restored = await (await request(second, `/api/projects/${project.id}/collaboration?path=main.tex`)).json() as { documentId: string; update: string };
    const rehydrated = new Y.Doc(); Y.applyUpdate(rehydrated, Buffer.from(restored.update, "base64"));
    expect(restored.documentId).toBe(initial.documentId);
    expect(rehydrated.getText("content").toString()).toContain("survives restart");
    expect(rehydrated.getText("content").toString()).toContain("% barrier survives restart");
    const disk = await (await request(second, `/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    expect(disk.content).toBe(rehydrated.getText("content").toString());
  });

  test("anchors account comments with Yjs relative positions across edits", async () => {
    const request = await testApplication();
    const account = await (await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "comments@example.test", password: "correct-horse-battery-staple" }) })).json() as { token: string };
    const headers = { authorization: `Bearer ${account.token}`, "content-type": "application/json" };
    const project = await (await request("/api/projects", { method: "POST", headers, body: JSON.stringify({ name: "Comment anchors" }) })).json() as PaperProject;
    const opened = await (await request(`/api/projects/${project.id}/collaboration?path=main.tex`, { headers })).json() as { fileVersion: number; update: string };
    const original = new Y.Doc(); Y.applyUpdate(original, Buffer.from(opened.update, "base64")); const marker = original.getText("content").toString().indexOf("Introduction");
    const created = await request(`/api/projects/${project.id}/comments`, { method: "POST", headers, body: JSON.stringify({ path: "main.tex", from: marker, to: marker + "Introduction".length, body: "Clarify this section." }) });
    expect(created.status).toBe(201);
    const modified = new Y.Doc(); Y.applyUpdate(modified, Buffer.from(opened.update, "base64")); modified.getText("content").insert(0, "% earlier text\n");
    expect((await request(`/api/projects/${project.id}/collaboration`, { method: "POST", headers, body: JSON.stringify({ path: "main.tex", baseVersion: opened.fileVersion, update: Buffer.from(Y.encodeStateAsUpdate(modified)).toString("base64") }) })).status).toBe(200);
    const threads = await (await request(`/api/projects/${project.id}/comments`, { headers })).json() as Array<{ anchorStatus: string; from: number; to: number; quote: string; messages: unknown[] }>;
    expect(threads).toEqual([expect.objectContaining({ anchorStatus: "attached", quote: "Introduction", from: marker + "% earlier text\n".length, messages: expect.arrayContaining([expect.objectContaining({ body: "Clarify this section." })]) })]);
  });

  test("issues collaboration access only to an authenticated project editor", async () => {
    const request = await testApplication();
    const account = await (await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "collaboration-access@example.test", password: "correct-horse-battery-staple", displayName: "Trusted editor" }) })).json() as { token: string; user: { id: string } };
    const headers = { authorization: `Bearer ${account.token}`, "content-type": "application/json" };
    const project = await (await request("/api/projects", { method: "POST", headers, body: JSON.stringify({ name: "Access-controlled room" }) })).json() as PaperProject;
    expect((await request(`/api/collaboration/access?projectId=${project.id}&path=main.tex`)).status).toBe(401);
    const granted = await request(`/api/collaboration/access?projectId=${project.id}&path=main.tex`, { headers });
    expect(granted.status).toBe(200);
    expect(await granted.json()).toMatchObject({ projectId: project.id, path: "main.tex", displayName: "Trusted editor", color: expect.stringMatching(/^#/) });
    const room = await request("/api/collaboration/tokens", { method: "POST", headers, body: JSON.stringify({ projectId: project.id, path: "main.tex" }) });
    expect(room.status).toBe(200);
    const grant = await room.json() as { token: string; expiresAt: string; scope: string };
    expect(grant.token).toEqual(expect.any(String));
    expect(grant.scope).toBe("write");
    expect(Date.parse(grant.expiresAt)).toBeGreaterThan(Date.now() + 4 * 60_000);
    const roomAccess = await request(`/api/collaboration/room-access?token=${encodeURIComponent(grant.token)}`);
    expect(roomAccess.status).toBe(200);
    expect(await roomAccess.json()).toMatchObject({ projectId: project.id, path: "main.tex", scope: "write", userId: account.user.id });
    const roomState = await request("/api/collaboration/room-state", { headers: { "x-fastwrite-room-token": grant.token } });
    expect(roomState.status).toBe(200);
    const state = await roomState.json() as { update: string };
    const ydoc = new Y.Doc(); Y.applyUpdate(ydoc, Buffer.from(state.update, "base64")); ydoc.getText("content").insert(ydoc.getText("content").length, "\n% room update");
    const roomUpdate = await request("/api/collaboration/room-update", { method: "POST", headers: { "content-type": "application/json", "x-fastwrite-room-token": grant.token }, body: JSON.stringify({ update: Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString("base64") }) });
    expect(roomUpdate.status).toBe(200);
    const persisted = await request(`/api/projects/${project.id}/collaboration?path=main.tex`, { headers });
    const restored = new Y.Doc(); Y.applyUpdate(restored, Buffer.from((await persisted.json() as { update: string }).update, "base64"));
    expect(restored.getText("content").toString()).toContain("% room update");
    expect((await request("/api/collaboration/room-access?token=not-a-room-token")).status).toBe(401);
  });

  test("enforces two-person, scoped, one-time support access grants", async () => {
    const request = await testApplication(undefined, { serverAuth: true });
    const register = async (email: string) => await (await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "correct-horse-battery-staple" }) })).json() as { token: string; user: { id: string } };
    const requester = await register("support-requester@example.test");
    const approver = await register("support-approver@example.test");
    const requesterHeaders = { authorization: `Bearer ${requester.token}`, "content-type": "application/json" };
    const approverHeaders = { authorization: `Bearer ${approver.token}`, "content-type": "application/json" };
    const project = await (await request("/api/projects", { method: "POST", headers: requesterHeaders, body: JSON.stringify({ name: "Support scoped paper" }) })).json() as PaperProject;
    await request(`/api/admin/users/${approver.user.id}/platform-role`, { method: "PATCH", headers: requesterHeaders, body: JSON.stringify({ role: "platform_admin", reason: "Grant temporary support approval role." }) });
    await request(`/api/admin/users/${requester.user.id}/platform-role`, { method: "PATCH", headers: approverHeaders, body: JSON.stringify({ role: "support_auditor", reason: "Allow audited support requests." }) });
    const created = await request("/api/admin/support-access", { method: "POST", headers: requesterHeaders, body: JSON.stringify({ projectId: project.id, pathPrefix: "sections", ticketId: "SUP-42", reason: "Investigate a reported rendering issue." }) });
    expect(created.status).toBe(201);
    const pending = await created.json() as { id: string };
    expect((await request(`/api/admin/support-access/${pending.id}/decision`, { method: "POST", headers: requesterHeaders, body: JSON.stringify({ approved: true }) })).status).toBe(403);
    const approved = await (await request(`/api/admin/support-access/${pending.id}/decision`, { method: "POST", headers: approverHeaders, body: JSON.stringify({ approved: true }) })).json() as { token: string };
    expect(approved.token).toEqual(expect.any(String));
    const outside = await request(`/api/admin/support-access/${pending.id}/redeem`, { method: "POST", headers: requesterHeaders, body: JSON.stringify({ token: approved.token, path: "main.tex" }) });
    expect(outside.status).toBe(403);
    const redeemed = await (await request(`/api/admin/support-access/${pending.id}/redeem`, { method: "POST", headers: approverHeaders, body: JSON.stringify({ token: approved.token, path: "sections/method.tex" }) })).json() as { userId: string; sessionId: string; scope: string; oneTime: boolean };
    expect(redeemed).toMatchObject({ userId: approver.user.id, scope: "read", oneTime: true });
    expect((await request(`/api/admin/support-access/${pending.id}/redeem`, { method: "POST", headers: approverHeaders, body: JSON.stringify({ token: approved.token, path: "sections/method.tex" }) })).status).toBe(403);
    expect((await request(`/api/admin/support-access/${pending.id}/revoke`, { method: "POST", headers: approverHeaders })).status).toBe(200);
  });

  test("rejects an unsupported runtime Agent wire API", async () => {
    const request = await testApplication();
    const response = await request("/api/harness-settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-test", wireAPI: "websocket" })
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "agent_wire_api_invalid" } });
  });

  test("creates, reads and version-checks an empty project", async () => {
    const request = await testApplication();
    const createdResponse = await request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Legacy conference values are intentionally normalized to the matching research domain.
      body: JSON.stringify({ name: "Test Paper", mainDocument: "main.tex", venue: "sp", publicationTarget: { venueId: "sp", stage: "submission" } })
    });
    expect(createdResponse.status).toBe(201);
    const project = (await createdResponse.json()) as PaperProject;
    expect(project.skill).toMatchObject({ id: "network-information-security", venue: "network-information-security" });
    expect(project.publicationTarget).toEqual({ domain: "network-information-security", venueId: "sp", stage: "submission" });

    const tree = (await (await request(`/api/projects/${project.id}/files`)).json()) as WorkspaceTreeNode[];
    expect(tree[0]?.path).toBe("main.tex");

    const opened = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    expect(opened.content).toContain("\\documentclass");

    const savedResponse = await request(`/api/projects/${project.id}/file?path=main.tex`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: `${opened.content}\n% saved`, baseVersion: opened.file.version })
    });
    expect(savedResponse.status).toBe(200);

    const conflict = await request(`/api/projects/${project.id}/file?path=main.tex`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "stale", baseVersion: opened.file.version })
    });
    expect(conflict.status).toBe(409);
  });

  test("copies a browser directory upload into a managed workspace", async () => {
    const request = await testApplication();
    const main = new TextEncoder().encode("\\documentclass{article}\n\\begin{document}Hi\\end{document}");
    const bib = new TextEncoder().encode("@article{fastwrite, title={FastWrite}}");
    const sessionResponse = await request("/api/upload-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectName: "Uploaded Paper",
        mainDocument: "main.tex",
        venue: "network-information-security",
        sourceName: "paper-folder",
        entries: [
          { path: "main.tex", kind: "file", size: main.byteLength },
          { path: "refs/library.bib", kind: "file", size: bib.byteLength },
          { path: "figures/empty", kind: "directory", size: 0 },
          { path: ".writeagent/backups/main.tex/old.tex", kind: "file", size: 999 }
        ]
      })
    });
    expect(sessionResponse.status).toBe(201);
    const session = (await sessionResponse.json()) as UploadSession;
    expect(session.entries.some((entry) => entry.path.startsWith(".writeagent"))).toBe(false);
    for (const [path, bytes] of [["main.tex", main], ["refs/library.bib", bib]] as const) {
      const response = await request(`/api/upload-sessions/${session.id}/files?path=${encodeURIComponent(path)}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: bytes
      });
      expect(response.status).toBe(200);
    }
    const completed = await request(`/api/upload-sessions/${session.id}/complete`, { method: "POST" });
    expect(completed.status).toBe(201);
    const project = (await completed.json()) as PaperProject;
    expect(project.source).toEqual({ type: "local", displayName: "paper-folder" });
    const file = (await (await request(`/api/projects/${project.id}/file?path=${encodeURIComponent("refs/library.bib")}`)).json()) as FileContentResponse;
    expect(file.content).toContain("fastwrite");
  });

  test("renames, configures, trashes and exports workspace files", async () => {
    const request = await testApplication();
    const created = await request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Lifecycle Paper", mainDocument: "main.tex", venue: "network-information-security" })
    });
    const project = (await created.json()) as PaperProject;

    expect((await request(`/api/projects/${project.id}/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: ".writeagent/backups/main.tex/old.tex", content: "old copy" })
    })).status).toBe(400);

    expect((await request(`/api/projects/${project.id}/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "sections/evaluation.tex", content: "Evaluation" })
    })).status).toBe(201);
    const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const addedAsset = await request(`/api/projects/${project.id}/assets?path=${encodeURIComponent("figures/plot.png")}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: imageBytes
    });
    expect(addedAsset.status).toBe(201);
    const openedAsset = await request(`/api/projects/${project.id}/asset?path=${encodeURIComponent("figures/plot.png")}`);
    expect(new Uint8Array(await openedAsset.arrayBuffer())).toEqual(imageBytes);
    expect((await request(`/api/projects/${project.id}/files`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "sections/evaluation.tex", to: "sections/results.tex" })
    })).status).toBe(204);

    const updatedResponse = await request(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Updated Paper", mainDocument: "sections/results.tex", venue: "artificial-intelligence" })
    });
    const updated = (await updatedResponse.json()) as PaperProject;
    expect(updated).toMatchObject({ name: "Updated Paper", mainDocument: "sections/results.tex" });
    expect(updated.skill).toMatchObject({ id: "artificial-intelligence", venue: "artificial-intelligence" });

    const protectedDelete = await request(`/api/projects/${project.id}/files?path=${encodeURIComponent("sections/results.tex")}`, { method: "DELETE" });
    expect(protectedDelete.status).toBe(409);
    const oldMainDelete = await request(`/api/projects/${project.id}/files?path=main.tex`, { method: "DELETE" });
    expect(oldMainDelete.status).toBe(204);
    expect((await request(`/api/projects/${project.id}/file?path=main.tex`)).status).toBe(404);

    const archive = await request(`/api/projects/${project.id}/export`);
    expect(archive.status).toBe(200);
    expect(archive.headers.get("content-type")).toBe("application/gzip");
    expect(archive.headers.get("content-disposition")).toContain("Updated-Paper.tar.gz");
    const tar = Bun.gunzipSync(new Uint8Array(await archive.arrayBuffer()));
    const archiveText = new TextDecoder().decode(tar);
    expect(archiveText).toContain("sections/results.tex");
    expect(archiveText).toContain("Evaluation");
  });

  test("preserves the collaboration document identity across a file rename", async () => {
    const request = await testApplication();
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Rename collaboration" }) })).json() as PaperProject;
    const opened = await (await request(`/api/projects/${project.id}/collaboration?path=main.tex`)).json() as { documentId: string; update: string; fileVersion: number };
    const ydoc = new Y.Doc(); Y.applyUpdate(ydoc, Buffer.from(opened.update, "base64")); ydoc.getText("content").insert(0, "% identity survives\n");
    expect((await request(`/api/projects/${project.id}/collaboration`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "main.tex", baseVersion: opened.fileVersion, update: Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString("base64") }) })).status).toBe(200);
    expect((await request(`/api/projects/${project.id}/files`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "main.tex", to: "paper.tex" }) })).status).toBe(204);
    const renamed = await (await request(`/api/projects/${project.id}/collaboration?path=paper.tex`)).json() as { documentId: string; update: string };
    expect(renamed.documentId).toBe(opened.documentId);
    const restored = new Y.Doc(); Y.applyUpdate(restored, Buffer.from(renamed.update, "base64"));
    expect(restored.getText("content").toString()).toContain("identity survives");
    expect((await request(`/api/projects/${project.id}/collaboration?path=main.tex`)).status).toBe(404);
  });

  test("builds a document-order outline across included TeX files", async () => {
    const request = await testApplication();
    const created = await request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Outline Paper" })
    });
    const project = (await created.json()) as PaperProject;
    for (const [path, content] of [
      ["sections/introduction.tex", "\\section{Introduction}\n\\subsection{Motivation}"],
      ["sections/evaluation.tex", "\\section{Evaluation}"]
    ] as const) {
      expect((await request(`/api/projects/${project.id}/files`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, content })
      })).status).toBe(201);
    }
    const opened = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    await request(`/api/projects/${project.id}/file?path=main.tex`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "\\input{sections/introduction}\n\\input{sections/evaluation.tex}", baseVersion: opened.file.version })
    });
    const outline = (await (await request(`/api/projects/${project.id}/outline`)).json()) as Array<{ title: string; path: string; children: Array<{ title: string }> }>;
    expect(outline).toMatchObject([
      { title: "Introduction", path: "sections/introduction.tex", children: [{ title: "Motivation" }] },
      { title: "Evaluation", path: "sections/evaluation.tex", children: [] }
    ]);
  });

  test("proposes, approves, rolls back and conflict-checks a Skill-driven revision", async () => {
    let received: ReviseAgentInput | undefined;
    const provider: AgentProvider = {
      async revise(input) {
        received = input;
        return { replacement: "We build a system that improves security.", rationale: "Corrects subject–verb agreement." };
      }
    };
    const request = await testApplication(provider);
    const project = (await (await request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Revision Paper", venue: "network-information-security" })
    })).json()) as PaperProject;
    const initial = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    const selectedText = "We build a system that improve security.";
    const content = `\\section{Introduction}\n${selectedText}\n`;
    await request(`/api/projects/${project.id}/file?path=main.tex`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, baseVersion: initial.file.version })
    });
    const opened = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    const from = opened.content.indexOf(selectedText);
    const selection = { path: "main.tex", text: selectedText, from, to: from + selectedText.length, startLine: 2, endLine: 2, fileVersion: opened.file.version };

    const proposedResponse = await request(`/api/projects/${project.id}/revisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection, command: "grammar" })
    });
    expect(proposedResponse.status).toBe(201);
    const proposed = (await proposedResponse.json()) as ReviseResponse;
    expect(proposed.run).toMatchObject({ status: "waiting-approval", skill: { id: "network-information-security", venue: "network-information-security" } });
    expect(proposed.changeSet).toMatchObject({ status: "proposed", summary: "Grammar" });
    expect(received?.sectionTitle).toBe("Introduction");
    expect(received?.selectionKind).toBe("sentence");
    expect(received?.skillInstructions).toContain("# Network and information security");
    expect(received?.venueInstructions).toContain("# Network and information security");
    expect((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse).content).toContain(selectedText);

    const accepted = (await (await request(`/api/projects/${project.id}/change-sets/${proposed.changeSet.id}/accept`, { method: "POST" })).json()) as ChangeSet;
    expect(accepted.status).toBe("accepted");
    expect((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse).content).toContain("improves security");

    const rolledBack = (await (await request(`/api/projects/${project.id}/change-sets/${proposed.changeSet.id}/rollback`, { method: "POST" })).json()) as ChangeSet;
    expect(rolledBack.status).toBe("rolled-back");
    const restored = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    expect(restored.content).toContain(selectedText);

    const staleSelection = { ...selection, fileVersion: restored.file.version };
    const second = (await (await request(`/api/projects/${project.id}/revisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: staleSelection, instruction: "Make this clearer" })
    })).json()) as ReviseResponse;
    await request(`/api/projects/${project.id}/file?path=main.tex`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: `${restored.content}% concurrent edit`, baseVersion: restored.file.version })
    });
    expect((await request(`/api/projects/${project.id}/change-sets/${second.changeSet.id}/accept`, { method: "POST" })).status).toBe(409);
  });

  test("edits a proposed ChangeSet without writing until the edited text is accepted", async () => {
    const request = await testApplication({
      async revise() { return { replacement: "The generated revision.", rationale: "Generated wording." }; }
    });
    const project = (await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Editable Proposal", venue: "network-information-security" }) })).json()) as PaperProject;
    const initial = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    const selectedText = "Original sentence.";
    const content = `${initial.content}\n${selectedText}`;
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, baseVersion: initial.file.version }) });
    const opened = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    const from = opened.content.indexOf(selectedText);
    const proposed = (await (await request(`/api/projects/${project.id}/revisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction: "Improve this", selection: { path: "main.tex", text: selectedText, from, to: from + selectedText.length, startLine: 2, endLine: 2, fileVersion: opened.file.version } }) })).json()) as ReviseResponse;

    const manuallyEdited = "The author-edited revision.";
    const editedResponse = await request(`/api/projects/${project.id}/change-sets/${proposed.changeSet.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ changes: [{ path: "main.tex", after: manuallyEdited }] }) });
    expect(editedResponse.status).toBe(200);
    const edited = (await editedResponse.json()) as ChangeSet;
    expect(edited.changes[0]?.after).toBe(manuallyEdited);
    expect(edited.changes[0]?.hunks?.every((hunk) => hunk.status === "pending")).toBe(true);
    expect((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse).content).toContain(selectedText);

    const runs = (await (await request(`/api/projects/${project.id}/agent-runs`)).json()) as Array<{ auditTrail?: Array<{ action: string; summary: string }> }>;
    expect(runs[0]?.auditTrail?.at(-1)).toMatchObject({ action: "proposal-edited", summary: "Edited 1 proposed file before approval" });
    await request(`/api/projects/${project.id}/change-sets/${proposed.changeSet.id}/accept`, { method: "POST" });
    const accepted = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    expect(accepted.content).toContain(manuallyEdited);
    expect(accepted.content).not.toContain("The generated revision.");
  });

  test("returns editable three-way rollback conflicts and applies an explicit resolution", async () => {
    const request = await testApplication({ async revise() { return { replacement: "AI replacement.", rationale: "Rewrite." }; } });
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Rollback conflict", venue: "sp" }) })).json() as PaperProject;
    const initial = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    const content = `${initial.content}\nOriginal sentence.`; await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, baseVersion: initial.file.version }) });
    const opened = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse; const from = opened.content.indexOf("Original sentence.");
    const proposed = await (await request(`/api/projects/${project.id}/revisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction: "Rewrite", selection: { path: "main.tex", text: "Original sentence.", from, to: from + 18, startLine: 2, endLine: 2, fileVersion: opened.file.version } }) })).json() as ReviseResponse;
    await request(`/api/projects/${project.id}/change-sets/${proposed.changeSet.id}/accept`, { method: "POST" }); const applied = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: applied.content.replace("AI replacement.", "Human follow-up."), baseVersion: applied.file.version }) });
    const conflict = await request(`/api/projects/${project.id}/change-sets/${proposed.changeSet.id}/rollback`, { method: "POST" }); expect(conflict.status).toBe(409); const details = await conflict.json() as { error: { code: string; details: { conflicts: Array<{ path: string; currentVersion: number }> } } }; expect(details.error.code).toBe("rollback_conflict_review_required");
    const item = details.error.details.conflicts[0]!; const resolved = await request(`/api/projects/${project.id}/change-sets/${proposed.changeSet.id}/rollback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resolutions: [{ path: item.path, currentVersion: item.currentVersion, content: `${content}\n% retained human intent` }] }) }); expect(resolved.status).toBe(200); expect((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse).content).toContain("retained human intent");
  });

  test("continues a Revise conversation from the latest unaccepted candidate", async () => {
    let received: ReviseAgentInput | undefined;
    const request = await testApplication({
      async revise(input) {
        received = input;
        return { replacement: "The second, tighter candidate.", rationale: "Followed the user's second instruction." };
      }
    });
    const project = (await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Continuous Revise" }) })).json()) as PaperProject;
    const opened = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    const selectedText = "A sentence to improve.";
    const content = `${opened.content}\n${selectedText}`;
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, baseVersion: opened.file.version }) });
    const current = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    const from = current.content.indexOf(selectedText);
    const selection = { path: "main.tex", text: selectedText, from, to: from + selectedText.length, startLine: 2, endLine: 2, fileVersion: current.file.version };
    const response = await request(`/api/projects/${project.id}/revisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection, instruction: "Make it tighter", workingText: "The first candidate.", history: [{ role: "user", content: "Make it clearer" }, { role: "assistant", content: "The first candidate." }] })
    });
    expect(response.status).toBe(201);
    const proposed = (await response.json()) as ReviseResponse;
    expect(received?.workingText).toBe("The first candidate.");
    expect(received?.history).toEqual([{ role: "user", content: "Make it clearer" }, { role: "assistant", content: "The first candidate." }]);
    expect(proposed.changeSet).toMatchObject({ summary: "Follow-up revision", changes: [{ before: selectedText, after: "The second, tighter candidate." }] });
    expect(((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse).content).toContain(selectedText);
  });

  test("plans a Skill-driven draft before proposing an atomic multi-file ChangeSet", async () => {
    const outline = [
      { path: "sections/abstract.tex", title: "Abstract", purpose: "Summarize the problem, method, and evidence." },
      { path: "sections/introduction.tex", title: "Introduction", purpose: "Motivate the security problem and contributions." },
      { path: "sections/method.tex", title: "Method", purpose: "Describe the design and threat model." },
      { path: "sections/evaluation.tex", title: "Evaluation", purpose: "Define research questions and experiments." },
      { path: "sections/conclusion.tex", title: "Conclusion", purpose: "Summarize findings and limitations." }
    ];
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async planDraft(input) {
        expect(input.skill.venue).toBe("network-information-security");
        expect(input.skillInstructions).toContain("## Workflow");
        return { outline };
      },
      async generateDraft(input) {
        expect(input.outline).toEqual(outline);
        const includes = outline.map((section) => `\\input{${section.path.replace(/\.tex$/, "")}}`).join("\n");
        return {
          files: [
            { path: input.mainDocument, content: `\\documentclass{article}\n\\begin{document}\n${includes}\n\\end{document}\n`, rationale: "Wire the confirmed sections." },
            ...outline.map((section) => ({ path: section.path, content: `% ${section.title}\n\\section{${section.title}}\nThis section develops ${section.purpose.toLowerCase()} It connects the stated research question to the proposed private telemetry protocol while preserving the evidence limits supplied in the research brief.\n`, rationale: section.purpose }))
          ]
        };
      }
    };
    const request = await testApplication(provider);
    const project = (await (await request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Draft Paper", venue: "network-information-security" })
    })).json()) as PaperProject;
    const original = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    const plannedResponse = await request(`/api/projects/${project.id}/drafts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "Secure telemetry", researchQuestion: "Can endpoints attest telemetry privately?", contributions: ["A protocol", "An evaluation"] })
    });
    expect(plannedResponse.status).toBe(201);
    const planned = await plannedResponse.json() as { plan: { id: string; status: string; outline: typeof outline }; run: { status: string } };
    expect(planned).toMatchObject({ plan: { status: "proposed", outline }, run: { status: "waiting-approval" } });
    expect((await request(`/api/projects/${project.id}/file?path=${encodeURIComponent(outline[0]!.path)}`)).status).toBe(404);

    const generatedResponse = await request(`/api/projects/${project.id}/drafts/${planned.plan.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outline })
    });
    expect(generatedResponse.status).toBe(201);
    const generated = await generatedResponse.json() as ReviseResponse & { changeSet: ChangeSet };
    expect(generated.changeSet.changes).toHaveLength(6);
    expect((await request(`/api/projects/${project.id}/file?path=${encodeURIComponent(outline[0]!.path)}`)).status).toBe(404);

    const accepted = await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/accept`, { method: "POST" });
    expect(accepted.status).toBe(200);
    expect(((await (await request(`/api/projects/${project.id}/file?path=${encodeURIComponent(outline[2]!.path)}`)).json()) as FileContentResponse).content).toContain("\\section{Method}");
    expect(((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse).content).toContain("sections/introduction");

    const rolledBack = await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/rollback`, { method: "POST" });
    expect(rolledBack.status).toBe(200);
    expect((await request(`/api/projects/${project.id}/file?path=${encodeURIComponent(outline[0]!.path)}`)).status).toBe(404);
    expect(((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse).content).toBe(original.content);
  });

  test("freezes a source snapshot and stores an evidence-linked Review without editing files", async () => {
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async review(input) {
        expect(input.skill.venue).toBe("network-information-security");
        expect(input.venueInstructions).toContain("# Network and information security");
        expect(input.documents[0]?.content).toContain("honest endpoints");
        return {
          overallAssessment: "The mechanism is promising, but its attacker model is incomplete.",
          recommendation: "borderline",
          strengths: ["The security goal is concrete."],
          weaknesses: ["The threat model excludes a central attacker without justification."],
          nextSteps: ["Justify or remove the honest-endpoint assumption."],
          issues: [{
            category: "threat-model",
            severity: "major",
            title: "Unjustified honest-endpoint assumption",
            rationale: "The adversary cannot compromise endpoints, but the deployment argument relies on endpoint trust.",
            impact: "The claimed protection may not hold in the target environment.",
            suggestion: "State the trust boundary and evaluate compromise consequences.",
            evidence: [
              { path: "main.tex", section: "Threat Model", line: null, excerpt: "We assume honest endpoints.", inferred: false },
              { path: "missing.tex", section: null, line: null, excerpt: "No recovery analysis is provided.", inferred: false }
            ]
          }]
        };
      }
    };
    const request = await testApplication(provider);
    const project = (await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Review Paper", venue: "network-information-security" }) })).json()) as PaperProject;
    const opened = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    const content = "\\section{Threat Model}\nWe assume honest endpoints.\n";
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, baseVersion: opened.file.version }) });
    const before = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;

    const response = await request(`/api/projects/${project.id}/reviews`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceOnly: true }) });
    expect(response.status).toBe(201);
    const reviewed = await response.json() as { snapshot: { projectVersion: number; files: unknown[] }; report: { issues: Array<{ id: string; status: string; evidence: Array<{ path: string; line?: number; inferred: boolean }> }> }; run: { status: string; skill: { venue: string } } };
    expect(reviewed.run).toMatchObject({ status: "completed", skill: { venue: "network-information-security" } });
    expect(reviewed.snapshot.files).toHaveLength(1);
    expect(reviewed.report.issues[0]?.evidence[0]).toMatchObject({ path: "main.tex", line: 2, inferred: false });
    expect(reviewed.report.issues[0]?.evidence[1]).toMatchObject({ path: "main.tex", inferred: true });
    const manualResponse = await request(`/api/projects/${project.id}/review-issues`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ category: "soundness", severity: "minor", title: "Manual duplicate", rationale: "This overlaps the threat-model issue.", impact: "Duplicate triage work.", suggestion: "Merge it." }) });
    expect(manualResponse.status).toBe(201);
    const manual = await manualResponse.json() as { id: string; source: string };
    expect(manual.source).toBe("manual");
    const merged = await (await request(`/api/projects/${project.id}/review-issues/${reviewed.report.issues[0]!.id}/merge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ duplicateIds: [manual.id], reason: "Same root cause" }) })).json() as { history: Array<{ action: string }> };
    expect(merged.history.some((entry) => entry.action === "merged")).toBe(true);
    const issueUpdate = await request(`/api/projects/${project.id}/review-issues/${reviewed.report.issues[0]!.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "dismissed", priority: 42 }) });
    expect(await issueUpdate.json()).toMatchObject({ status: "dismissed", priority: 42, history: expect.arrayContaining([expect.objectContaining({ action: "status" }), expect.objectContaining({ action: "priority" })]) });
    const after = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    expect(after).toEqual(before);
    expect((await (await request(`/api/projects/${project.id}/reviews`)).json() as unknown[])).toHaveLength(1);
  });

  test("cancels an in-flight Review without persisting a partial report", async () => {
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async review() { return await new Promise<never>(() => undefined); }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Cancelled Review" }) })).json() as PaperProject;
    const controller = new AbortController();
    const pending = request(`/api/projects/${project.id}/reviews`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceOnly: true }),
      signal: controller.signal
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    expect((await pending).status).toBe(499);
    expect(await (await request(`/api/projects/${project.id}/reviews`)).json()).toEqual([]);
    const runs = await (await request(`/api/projects/${project.id}/agent-runs`)).json() as Array<{ status: string; error?: string }>;
    expect(runs[0]).toMatchObject({ status: "cancelled", error: "Review cancelled; no report was created" });
  });

  test("keeps the main document inside the bounded large-paper Review snapshot", async () => {
    let reviewedPaths: string[] = [];
    let reviewedBytes = 0;
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async review(input) {
        reviewedPaths = input.documents.map((document) => document.path);
        reviewedBytes = input.documents.reduce((total, document) => total + Buffer.byteLength(document.content), 0);
        return { overallAssessment: "Bounded snapshot.", recommendation: "borderline", strengths: [], weaknesses: [], nextSteps: [], issues: [] };
      }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Large Review" }) })).json() as PaperProject;
    await request(`/api/projects/${project.id}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "appendix/a.tex", content: "a".repeat(499_000) }) });
    await request(`/api/projects/${project.id}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "appendix/b.tex", content: "b".repeat(50_000) }) });
    expect((await request(`/api/projects/${project.id}/reviews`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceOnly: true }) })).status).toBe(201);
    expect(reviewedPaths[0]).toBe("main.tex");
    expect(reviewedPaths).toContain("appendix/a.tex");
    expect(reviewedPaths).not.toContain("appendix/b.tex");
    expect(reviewedBytes).toBeLessThanOrEqual(500_000);
  });

  test("plans against a selected venue and returns its page budget and compliance checks", async () => {
    let venueGuidance = "";
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async planAgentTask(input) {
        venueGuidance = input.venueInstructions;
        return {
          steps: ["Fit the argument to the main-track budget"], affectedFiles: ["main.tex"], risks: ["Rendered page count is not yet verified"], validation: ["Compile and count content pages"],
          sectionBudget: [{ section: "Introduction", targetPages: 1, purpose: "Motivate the contribution" }],
          venueChecks: [{ requirement: "Use the NeurIPS 2026 template", status: "uncertain", evidencePaths: ["main.tex"], action: "Verify the rendered PDF" }]
        };
      }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Venue Plan", venue: "artificial-intelligence", publicationTarget: { domain: "artificial-intelligence", venueId: "neurips", stage: "submission" } }) })).json() as PaperProject;
    const response = await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Prepare this manuscript for submission", scope: { type: "project" } }) });
    expect(response.status).toBe(201);
    const result = await response.json() as { run: AgentRun; plan: AgentTaskPlan };
    expect(result.run.publicationTarget).toEqual({ domain: "artificial-intelligence", venueId: "neurips", stage: "submission" });
    expect(result.plan.sectionBudget?.[0]?.targetPages).toBe(1);
    expect(result.plan.venueChecks?.[0]?.status).toBe("uncertain");
    expect(venueGuidance).toContain("# NeurIPS 2026 Main Track");
  });

  test("enforces page, template, anonymity, comment, reference, and citation-authenticity checks", async () => {
    const request = await testApplication();
    const project = await (await request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Compliance Paper", venue: "network-information-security", publicationTarget: { domain: "network-information-security", venueId: "sp", stage: "submission" } })
    })).json() as PaperProject;
    const opened = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    const content = String.raw`\documentclass{article}
\author{Alice Example}
\begin{document}
% TODO verify the reviewer-facing claim
\section{Introduction}\cite{real,fake,missing}
\section{Ethics considerations}
\bibliography{references}
\end{document}`;
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, baseVersion: opened.file.version }) });
    await request(`/api/projects/${project.id}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "references.bib", content: "@article{real,\n author={A},\n title={Verified Work},\n year={2024},\n doi={10.1000/real}\n}\n@article{fake,\n author={B},\n title={Invented Work},\n year={2025},\n doi={10.1000/fake}\n}" }) });

    const nativeFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async (input: string | URL | Request) => String(input).includes("10.1000%2Freal")
      ? new Response(JSON.stringify({ message: { title: ["Verified Work"] } }), { status: 200, headers: { "content-type": "application/json" } })
      : new Response("not found", { status: 404 }), { preconnect: nativeFetch.preconnect });
    try {
      const response = await request(`/api/projects/${project.id}/compliance-checks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ renderedPages: 19, verifyCitationsOnline: true }) });
      expect(response.status).toBe(201);
      const report = await response.json() as ComplianceReport;
      expect(report.submissionBlocked).toBe(true);
      expect(report.findings.some((finding) => finding.category === "pages" && finding.status === "error")).toBe(true);
      expect(report.findings.some((finding) => finding.category === "template" && finding.status === "error")).toBe(true);
      expect(report.findings.some((finding) => finding.category === "anonymity" && finding.status === "error")).toBe(true);
      expect(report.findings.some((finding) => finding.category === "comments" && finding.status === "error")).toBe(true);
      expect(report.findings.some((finding) => finding.id === "reference:missing:missing")).toBe(true);
      expect(report.citations.find((citation) => citation.key === "real")?.status).toBe("verified");
      expect(report.citations.find((citation) => citation.key === "fake")?.status).toBe("mismatch");
      expect(report.citations.find((citation) => citation.key === "missing")?.status).toBe("missing");
    } finally {
      globalThis.fetch = nativeFetch;
    }
  });

  test("cancels and safely retries Agent planning without duplicate plans or changes", async () => {
    let attempts = 0;
    let generationAttempts = 0;
    let markPlanningStarted!: () => void;
    let markGenerationStarted!: () => void;
    const planningStarted = new Promise<void>((resolve) => { markPlanningStarted = resolve; });
    const generationStarted = new Promise<void>((resolve) => { markGenerationStarted = resolve; });
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async planAgentTask(_input, signal) {
        attempts += 1;
        if (attempts === 1) {
          markPlanningStarted();
          return await new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
        }
        return { steps: ["Inspect the claim"], affectedFiles: ["main.tex"], risks: [], validation: ["Compile"] };
      },
      async generateAgentTask(input, signal) {
        generationAttempts += 1;
        if (generationAttempts === 1) {
          markGenerationStarted();
          return await new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
        }
        const main = input.documents.find((document) => document.path === "main.tex")!;
        return { files: [{ path: "main.tex", content: `${main.content}\n% inspected`, rationale: "Records the bounded inspection." }] };
      }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Retry Agent" }) })).json() as PaperProject;
    const before = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    const controller = new AbortController();
    const cancelled = request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Inspect the main claim", scope: { type: "project" } }), signal: controller.signal });
    await planningStarted;
    controller.abort();
    expect((await cancelled).status).toBe(499);
    expect(await (await request(`/api/projects/${project.id}/agent-tasks`)).json()).toEqual([]);
    expect(await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()).toEqual(before);

    const retried = await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Inspect the main claim", scope: { type: "project" } }) });
    expect(retried.status).toBe(201);
    const retriedPlan = await retried.json() as { plan: { id: string } };
    expect(await (await request(`/api/projects/${project.id}/agent-tasks`)).json()).toHaveLength(1);

    const generationController = new AbortController();
    const cancelledGeneration = request(`/api/projects/${project.id}/agent-tasks/${retriedPlan.plan.id}/confirm`, { method: "POST", signal: generationController.signal });
    await generationStarted;
    generationController.abort();
    expect((await cancelledGeneration).status).toBe(499);
    expect((await (await request(`/api/projects/${project.id}/agent-tasks`)).json() as Array<{ status: string }>)[0]?.status).toBe("proposed");
    expect(await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()).toEqual(before);
    const generated = await request(`/api/projects/${project.id}/agent-tasks/${retriedPlan.plan.id}/confirm`, { method: "POST" });
    expect(generated.status).toBe(201);
    expect(await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()).toEqual(before);
    const runs = await (await request(`/api/projects/${project.id}/agent-runs`)).json() as Array<{ status: string; error?: string }>;
    expect(runs.map((run) => run.status).sort()).toEqual(["cancelled", "waiting-approval"]);
    expect(runs.find((run) => run.status === "waiting-approval")?.error).toBeUndefined();
  });

  test("routes a unified Agent draft command through a reviewed plan that may create source files", async () => {
    let seenIntent = "";
    const generatedTargets: string[] = [];
    const visiblePlanDocuments: string[] = [];
    const visibleGenerationDocuments: string[] = [];
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async planAgentTask(input) { seenIntent = input.intent; visiblePlanDocuments.push(...input.documents.map((document) => document.content)); return { steps: ["Create the editable outline"], affectedFiles: ["main.tex", "sections/introduction.tex", "references.bib"], risks: [], validation: ["Compile"] }; },
      async generateAgentTask(input) {
        const target = input.targetPath;
        expect(input.affectedFiles).toEqual([target]);
        generatedTargets.push(target);
        visibleGenerationDocuments.push(...input.documents.map((document) => document.content));
        const generated: Record<string, DraftGeneratedFile> = {
          "main.tex": { path: "main.tex", content: "\\documentclass{article}\\begin{document}\\input{sections/introduction}\\end{document}", rationale: "Sets up the paper." },
          "sections/introduction.tex": { path: "sections/introduction.tex", content: "\\section{Introduction}\nThis paper studies robust authentication under the bounded assumptions supplied in the research brief.", rationale: "Creates an editable introduction section." },
          "references.bib": { path: "references.bib", content: "% Bibliography intentionally contains no unverified entries.", rationale: "Creates the bibliography file without invented citations." }
        };
        return { files: [generated[target]!] };
      }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Unified Agent" }) })).json() as PaperProject;
    const originalMain = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `${originalMain.content}% Keep this user instruction.\n`, baseVersion: originalMain.file.version }) });
    const planned = await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "/draft Plan a paper about robust authentication", scope: { type: "project" } }) });
    expect(planned.status).toBe(201);
    const body = await planned.json() as { plan: { id: string; intent: string; affectedFiles: string[] } };
    expect(seenIntent).toBe("draft");
    expect(visiblePlanDocuments.every((content) => !content.includes("Keep this user instruction"))).toBe(true);
    expect(body.plan).toMatchObject({ intent: "draft", affectedFiles: ["main.tex", "sections/introduction.tex", "references.bib"] });
    const generated = await request(`/api/projects/${project.id}/agent-tasks/${body.plan.id}/confirm`, { method: "POST" });
    expect(generated.status).toBe(201);
    expect(generatedTargets).toEqual(["main.tex", "sections/introduction.tex", "references.bib"]);
    const changeSet = await generated.json() as { changeSet: ChangeSet; run: { steps: Array<{ id: string; label: string; status: string }>; auditTrail: Array<{ action: string }> } };
    expect(changeSet.changeSet).toMatchObject({ approvalMode: "explicit-finish", status: "proposed" });
    expect(changeSet.run.steps).toEqual([
      { id: "generate-file-1", label: "Process main.tex", status: "completed" },
      { id: "generate-file-2", label: "Process sections/introduction.tex", status: "completed" },
      { id: "generate-file-3", label: "Process references.bib", status: "completed" }
    ]);
    expect(visibleGenerationDocuments.every((content) => !content.includes("Keep this user instruction"))).toBe(true);
    expect(changeSet.run.auditTrail.filter((event) => event.action === "generation-progress")).toHaveLength(3);
    expect(changeSet.changeSet.changes.find((change) => change.path === "main.tex")?.after).toContain("% Keep this user instruction.");
    expect((await request(`/api/projects/${project.id}/file?path=sections%2Fintroduction.tex`)).status).toBe(404);
    const mainChange = changeSet.changeSet.changes.find((change) => change.path === "main.tex")!;
    expect((await request(`/api/projects/${project.id}/change-sets/${changeSet.changeSet.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions: [{ path: mainChange.path, hunkIds: mainChange.hunks!.map((hunk) => hunk.id), status: "accepted" }] }) })).status).toBe(200);
    const editedIntroduction = "\\section{Introduction}\nTODO: Add bounded authentication evidence.";
    const edited = await request(`/api/projects/${project.id}/change-sets/${changeSet.changeSet.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ changes: [{ path: "sections/introduction.tex", after: editedIntroduction }] }) });
    expect(edited.status).toBe(200);
    const editedChangeSet = await edited.json() as ChangeSet;
    const introductionChange = editedChangeSet.changes.find((change) => change.path === "sections/introduction.tex")!;
    expect((await request(`/api/projects/${project.id}/change-sets/${changeSet.changeSet.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions: [{ path: introductionChange.path, hunkIds: introductionChange.hunks!.map((hunk) => hunk.id), status: "accepted" }] }) })).status).toBe(200);
    expect(await (await request(`/api/projects/${project.id}/file?path=sections%2Fintroduction.tex`)).json()).toMatchObject({ content: editedIntroduction });
    expect((await request(`/api/projects/${project.id}/change-sets/${changeSet.changeSet.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions: [{ path: introductionChange.path, hunkIds: introductionChange.hunks!.map((hunk) => hunk.id), status: "rejected" }] }) })).status).toBe(200);
    expect((await request(`/api/projects/${project.id}/file?path=sections%2Fintroduction.tex`)).status).toBe(404);
    const accepted = await request(`/api/projects/${project.id}/change-sets/${changeSet.changeSet.id}/accept`, { method: "POST" });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ status: "accepted", reviewFinishedAt: expect.any(String), changes: expect.arrayContaining([expect.objectContaining({ path: "sections/introduction.tex", hunks: expect.arrayContaining([expect.objectContaining({ status: "rejected" })]) })]) });
    expect((await request(`/api/projects/${project.id}/file?path=sections%2Fintroduction.tex`)).status).toBe(404);
  });

  test("splits a main document into planned chapter files without rejecting bundled Agent output", async () => {
    const generatedTargets: string[] = [];
    let activeGenerations = 0;
    let maxConcurrentGenerations = 0;
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async planAgentTask(input) {
        expect(input.intent).toBe("revise");
        return {
          steps: ["Split main.tex into included chapter files"],
          affectedFiles: ["main.tex", "sections/introduction.tex", "sections/method.tex"],
          risks: ["Preserve section order"],
          validation: ["Compile"]
        };
      },
      async generateAgentTask(input) {
        generatedTargets.push(input.targetPath);
        expect(input.affectedFiles).toEqual([input.targetPath]);
        activeGenerations += 1;
        maxConcurrentGenerations = Math.max(maxConcurrentGenerations, activeGenerations);
        await Bun.sleep(30);
        activeGenerations -= 1;
        const generated: Record<string, DraftGeneratedFile> = {
          "main.tex": { path: "main.tex", content: "\\documentclass{article}\n\\begin{document}\n\\input{sections/introduction}\n\\input{sections/method}\n\\end{document}", rationale: "Keeps main as the root document." },
          "sections/introduction.tex": { path: "sections/introduction.tex", content: "\\section{Introduction}\nThe system has a bounded goal.", rationale: "Moves the introduction out of main.tex." },
          "sections/method.tex": { path: "sections/method.tex", content: "\\section{Method}\nThe method remains unchanged.", rationale: "Moves the method out of main.tex." }
        };
        return input.targetPath === "main.tex"
          ? { files: [generated["main.tex"]!, generated["sections/introduction.tex"]!, generated["sections/method.tex"]!] }
          : { files: [generated[input.targetPath]!] };
      }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Split Main" }) })).json() as PaperProject;
    const original = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    const monolith = "\\documentclass{article}\n\\begin{document}\n\\section{Introduction}\nThe system has a bounded goal.\n\\section{Method}\nThe method remains unchanged.\n\\end{document}";
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: monolith, baseVersion: original.file.version }) });
    const planned = await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "/revise 将main.tex拆分章节", scope: { type: "project" } }) });
    expect(planned.status).toBe(201);
    const body = await planned.json() as { plan: { id: string; affectedFiles: string[] } };
    expect(body.plan.affectedFiles).toEqual(["main.tex", "sections/introduction.tex", "sections/method.tex"]);
    const generated = await request(`/api/projects/${project.id}/agent-tasks/${body.plan.id}/confirm`, { method: "POST" });
    expect(generated.status).toBe(201);
    expect(new Set(generatedTargets)).toEqual(new Set(["main.tex", "sections/introduction.tex", "sections/method.tex"]));
    expect(maxConcurrentGenerations).toBeGreaterThan(1);
    const response = await generated.json() as { changeSet: ChangeSet; run: { auditTrail: Array<{ action: string; summary: string }> } };
    expect(response.changeSet.changes.map((change) => change.path).sort()).toEqual(["main.tex", "sections/introduction.tex", "sections/method.tex"]);
    expect(response.run.auditTrail.find((event) => event.action === "execution-started")?.summary).toContain("in parallel");
  });

  test("routes every explicit Agent command and repairs an incomplete compatible-model plan", async () => {
    const seenIntents: string[] = [];
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async planAgentTask(input) {
        seenIntents.push(input.intent);
        if (input.intent === "draft") return { steps: ["Draft the paper"] } as AgentTaskPlanOutput;
        return { steps: [`Run the ${input.intent} task`], affectedFiles: ["main.tex"], risks: [], validation: ["Compile"] };
      }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Agent commands" }) })).json() as PaperProject;
    const objectives = [
      "/draft Write a complete initial paper",
      "/continue Finish every TODO section",
      "/revise Improve the paper-wide argument"
    ];
    const plans: Array<{ intent: string; request: { objective: string }; affectedFiles: string[]; validation: string[] }> = [];
    for (const objective of objectives) {
      const response = await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective, scope: { type: "project" } }) });
      expect(response.status).toBe(201);
      plans.push(((await response.json()) as { plan: typeof plans[number] }).plan);
    }
    expect(seenIntents).toEqual(["draft", "continue", "revise"]);
    expect(plans.map((plan) => plan.intent)).toEqual(["draft", "continue", "revise"]);
    expect(plans.map((plan) => plan.request.objective)).toEqual(["Write a complete initial paper", "Finish every TODO section", "Improve the paper-wide argument"]);
    expect(plans[0]?.affectedFiles).toEqual(["main.tex"]);
    expect(plans[0]?.validation).toEqual(["Compile the resulting paper", "Review every proposed file before accepting"]);
  });

  test("returns a structured error when Agent execution omits generated files", async () => {
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async planAgentTask() { return { steps: ["Inspect the paper"], affectedFiles: ["main.tex"], risks: [], validation: ["Compile"] }; },
      async generateAgentTask() { return {} as { files: never[] }; }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Agent output validation" }) })).json() as PaperProject;
    const planned = await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "/draft Make a paper", scope: { type: "project" } }) });
    const plan = ((await planned.json()) as { plan: { id: string } }).plan;
    const generated = await request(`/api/projects/${project.id}/agent-tasks/${plan.id}/confirm`, { method: "POST" });
    expect(generated.status).toBe(502);
    expect(await generated.json()).toMatchObject({ error: { code: "agent_files_invalid" } });
  });

  test("rejects placeholder content generated by the /draft command", async () => {
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async planAgentTask() { return { steps: ["Draft the paper"], affectedFiles: ["main.tex"], risks: [], validation: ["Compile"] }; },
      async generateAgentTask(input) { return { files: [{ path: input.targetPath, content: "\\section{Introduction}\nTODO: Add evidence.", rationale: "Drafts the paper." }] }; }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "No placeholder drafts" }) })).json() as PaperProject;
    const planned = await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "/draft Write a complete paper", scope: { type: "project" } }) });
    const plan = ((await planned.json()) as { plan: { id: string } }).plan;
    const generated = await request(`/api/projects/${project.id}/agent-tasks/${plan.id}/confirm`, { method: "POST" });
    expect(generated.status).toBe(502);
    expect(await generated.json()).toMatchObject({ error: { code: "agent_draft_placeholder" } });
  });

  test("restores Review and IssueResolution state after a server restart", async () => {
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async review() { return { overallAssessment: "Boundary needs clarification.", recommendation: "borderline", strengths: [], weaknesses: ["Boundary unclear"], nextSteps: ["Clarify it"], issues: [{ category: "threat-model", severity: "major", title: "Boundary unclear", rationale: "The boundary is ambiguous.", impact: "Claims cannot be audited.", suggestion: "State trusted components.", evidence: [{ path: "main.tex", section: "Introduction", line: 1, excerpt: "", inferred: true }] }] }; },
      async planAgentTask() { return { steps: ["Clarify boundary"], affectedFiles: ["main.tex"], risks: [], validation: ["Compile"] }; }
    };
    const directory = await mkdtemp(join(tmpdir(), "fastwrite-restart-"));
    temporaryDirectories.push(directory);
    const firstApp = await createApplication(directory, { agentProvider: provider });
    const first = (path: string, init?: RequestInit) => firstApp(new Request(`http://fastwrite.test${path}`, init));
    const project = await (await first("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Restart Paper" }) })).json() as PaperProject;
    const reviewed = await (await first(`/api/projects/${project.id}/reviews`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceOnly: true }) })).json() as { report: { issues: Array<{ id: string }> } };
    await first(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Resolve boundary issue", scope: { type: "project" }, issueIds: [reviewed.report.issues[0]!.id] }) });

    const restartedApp = await createApplication(directory, { agentProvider: provider });
    const restarted = (path: string, init?: RequestInit) => restartedApp(new Request(`http://fastwrite.test${path}`, init));
    const reports = await (await restarted(`/api/projects/${project.id}/reviews`)).json() as Array<{ issues: Array<{ status: string }> }>;
    const resolutions = await (await restarted(`/api/projects/${project.id}/issue-resolutions`)).json() as Array<{ status: string }>;
    expect(reports[0]?.issues[0]?.status).toBe("planned");
    expect(resolutions[0]?.status).toBe("planned");
  });

  test("supplies confirmed Paper Memory only to workflows that need its full or file-scoped context", async () => {
    const seen = { revise: "", reviseMemory: "", draft: "", review: "", agent: "" };
    const outline = [
      { path: "sections/abstract.tex", title: "Abstract", purpose: "Summary" },
      { path: "sections/introduction.tex", title: "Introduction", purpose: "Motivation" },
      { path: "sections/method.tex", title: "Method", purpose: "Design and threat model" },
      { path: "sections/evaluation.tex", title: "Evaluation", purpose: "Experiments" },
      { path: "sections/conclusion.tex", title: "Conclusion", purpose: "Findings" }
    ];
    const provider: AgentProvider = {
      async extractMemory(input) {
        expect(input.documents.find((document) => document.path === "main.tex")?.version).toBe(2);
        expect(input.documents.find((document) => document.path === "sections/method.tex")?.version).toBe(1);
        return { items: [{ category: "contribution", label: "Core contribution", content: "The paper introduces a privacy-preserving telemetry protocol.", sources: [{ path: "sections/method.tex", excerpt: "We introduce a privacy-preserving telemetry protocol.", section: "Method", line: null }] }] };
      },
      async revise(input) { seen.revise = input.skillInstructions; seen.reviseMemory = input.paperContext ?? ""; return { replacement: "We present a privacy-preserving telemetry protocol.", rationale: "Concise phrasing." }; },
      async planDraft(input) { seen.draft = input.skillInstructions; return { outline }; },
      async review(input) { seen.review = input.skillInstructions; return { overallAssessment: "Early draft.", recommendation: "borderline", strengths: [], weaknesses: [], nextSteps: [], issues: [] }; },
      async planAgentTask(input) { seen.agent = input.skillInstructions; return { steps: ["Inspect the argument"], affectedFiles: ["main.tex"], risks: [], validation: ["Compile"] }; }
    };
    const request = await testApplication(provider);
    const project = (await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Memory Paper" }) })).json()) as PaperProject;
    const opened = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    const sentence = "We introduce a privacy-preserving telemetry protocol.";
    const content = `\\section{Introduction}\n${sentence}\n`;
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, baseVersion: opened.file.version }) });
    await request(`/api/projects/${project.id}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "sections/method.tex", content: `\\section{Method}\n${sentence}\n` }) });
    const memory = await (await request(`/api/projects/${project.id}/memory/extract`, { method: "POST" })).json() as { version: number; items: Array<{ id: string; status: string }> };
    expect(memory).toMatchObject({ version: 1, items: [{ status: "suggested" }] });
    const confirmed = await (await request(`/api/projects/${project.id}/memory/items/${memory.items[0]!.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "confirmed" }) })).json() as { version: number };
    expect(confirmed.version).toBe(2);
    const partiallyReviewedFile = await (await request(`/api/projects/${project.id}/file?path=memory.md`)).json() as FileContentResponse;
    expect(partiallyReviewedFile.content).toContain("## Reviewed Context");
    expect(partiallyReviewedFile.content).toContain("Core contribution");
    expect(partiallyReviewedFile.content).not.toContain("### Overview");
    expect(partiallyReviewedFile.content).not.toContain("### Method (sections/method.tex)");

    const current = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    const from = current.content.indexOf(sentence);
    const revised = await request(`/api/projects/${project.id}/revisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "academic-polish", selection: { path: "main.tex", text: sentence, from, to: from + sentence.length, startLine: 2, endLine: 2, fileVersion: current.file.version } }) });
    expect((await revised.json() as { run: { memoryVersion?: number } }).run.memoryVersion).toBe(2);
    await request(`/api/projects/${project.id}/drafts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: "Telemetry", researchQuestion: "Can telemetry remain private?", contributions: ["A protocol"] }) });
    await request(`/api/projects/${project.id}/reviews`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceOnly: true }) });
    await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Inspect the paper argument", scope: { type: "project" } }) });
    expect(seen.revise).not.toContain("[contribution] Core contribution: The paper introduces a privacy-preserving telemetry protocol.");
    expect(seen.reviseMemory).toContain("[paper-overview] Core contribution: The paper introduces a privacy-preserving telemetry protocol.");
    expect(seen.reviseMemory).not.toContain("[contribution] Core contribution: The paper introduces a privacy-preserving telemetry protocol.");
    expect(seen.draft).not.toContain("Paper Memory");
    expect(seen.agent).toContain("[contribution] Core contribution: The paper introduces a privacy-preserving telemetry protocol.");
    expect(seen.review).not.toContain("Confirmed Paper Memory");

    const method = (await (await request(`/api/projects/${project.id}/file?path=sections%2Fmethod.tex`)).json()) as FileContentResponse;
    await request(`/api/projects/${project.id}/file?path=sections%2Fmethod.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `${method.content}% changed`, baseVersion: method.file.version }) });
    const stale = await (await request(`/api/projects/${project.id}/memory`)).json() as { items: Array<{ status: string; freshness?: string }> };
    expect(stale.items[0]).toMatchObject({ status: "confirmed", freshness: "stale" });
  });

  test("drafts a sparse Conclusion from reviewed local Memory and adjacent manuscript evidence", async () => {
    let received: ReviseAgentInput | undefined;
    const provider: AgentProvider = {
      async extractMemory() {
        return {
          items: [
            { category: "contribution", label: "Core method", content: "The paper introduces calibrated private aggregation.", sources: [{ path: "sections/evaluation.tex", excerpt: "Calibrated private aggregation reduces error by 18 percent.", section: "Evaluation", line: null }] },
            { category: "experiment", label: "Primary result", content: "The evaluation reports an 18 percent error reduction.", sources: [{ path: "sections/evaluation.tex", excerpt: "Calibrated private aggregation reduces error by 18 percent.", section: "Evaluation", line: null }] }
          ]
        };
      },
      async summarizeMemory() {
        return {
          overview: "The paper introduces calibrated private aggregation and reports an 18 percent error reduction.",
          sections: [
            { path: "sections/evaluation.tex", title: "Evaluation", content: "Reports an 18 percent error reduction." },
            { path: "sections/conclusion.tex", title: "Conclusion", content: "Conclude with the calibrated aggregation method, 18 percent result, and evidence limits." }
          ]
        };
      },
      async revise(input) {
        received = input;
        return { replacement: "\\section{Conclusion}\nCalibrated private aggregation reduces error by 18 percent under the evaluated setting.", rationale: "Uses reviewed paper evidence." };
      }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Sparse Conclusion" }) })).json() as PaperProject;
    const main = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    const mainContent = "\\documentclass{article}\n\\begin{document}\n\\input{sections/evaluation}\n\\input{sections/conclusion}\n\\end{document}\n";
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: mainContent, baseVersion: main.file.version }) });
    await request(`/api/projects/${project.id}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "sections/evaluation.tex", content: "\\section{Evaluation}\nCalibrated private aggregation reduces error by 18 percent.\n" }) });
    const conclusionContent = "\\section{Conclusion}\nTODO: Summarize the supported findings and limitations.\n";
    await request(`/api/projects/${project.id}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "sections/conclusion.tex", content: conclusionContent }) });
    expect((await request(`/api/projects/${project.id}/memory/extract`, { method: "POST" })).status).toBe(201);
    expect((await request(`/api/projects/${project.id}/memory/apply`, { method: "POST" })).status).toBe(200);

    const conclusion = await (await request(`/api/projects/${project.id}/file?path=sections%2Fconclusion.tex`)).json() as FileContentResponse;
    const response = await request(`/api/projects/${project.id}/revisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instruction: "Write a concrete conclusion from the available paper evidence.",
        selection: { path: conclusion.file.path, text: conclusion.content, from: 0, to: conclusion.content.length, startLine: 1, endLine: 2, fileVersion: conclusion.file.version }
      })
    });
    expect(response.status).toBe(201);
    expect(received?.selectionIsSectionScaffold).toBe(true);
    expect(received?.sectionTitle).toBe("Conclusion");
    expect(received?.contextBefore).toContain("[Adjacent paper section: Evaluation (sections/evaluation.tex)]");
    expect(received?.contextBefore).toContain("reduces error by 18 percent");
    expect(received?.paperContext).toContain("[paper-overview]");
    expect(received?.paperContext).toContain("[current-section:Conclusion]");
    expect(received?.paperContext).not.toContain("[current-section:Evaluation]");
  });

  test("keeps human-locked hierarchical Memory content and presents regenerated differences as candidates", async () => {
    let extraction = 0;
    const polishCalls: Array<{ kind: string; content: string }> = [];
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async extractMemory() {
        extraction += 1;
        return {
          items: [{
            category: "contribution",
            label: "Core contribution",
            content: extraction === 1 ? "The protocol protects telemetry metadata." : "The protocol protects telemetry and endpoint metadata.",
            sources: [{ path: "main.tex", excerpt: "The protocol protects telemetry metadata.", section: "Introduction", line: null }]
          }]
        };
      },
      async summarizeMemory() {
        return {
          overview: extraction === 1 ? "The paper proposes a telemetry protocol." : "The paper proposes an expanded telemetry protocol.",
          sections: [{ path: "main.tex", title: "Introduction", content: extraction === 1 ? "Introduces telemetry protection." : "Introduces expanded telemetry protection." }]
        };
      },
      async polishMemory(input) {
        polishCalls.push({ kind: input.kind, content: input.content });
        return { content: input.content === "用户确认 telemetry-only claim." ? "The user confirms the telemetry-only claim." : input.content };
      }
    };
    const request = await testApplication(provider);
    const project = (await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Hierarchical Memory" }) })).json()) as PaperProject;
    const opened = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `${opened.content}\nThe protocol protects telemetry metadata.`, baseVersion: opened.file.version }) });

    const first = (await (await request(`/api/projects/${project.id}/memory/extract`, { method: "POST" })).json()) as PaperMemory;
    expect(first.overview?.content).toBe("The paper proposes a telemetry protocol.");
    expect(first.sections?.some((section) => section.title === "Introduction")).toBe(true);
    const fact = first.items[0]!;
    const section = first.sections?.find((item) => item.title === "Introduction")!;

    const confirmed = (await (await request(`/api/projects/${project.id}/memory/items/${fact.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "confirmed", content: "用户确认 telemetry-only claim." }) })).json()) as PaperMemory;
    const overview = (await (await request(`/api/projects/${project.id}/memory/overview`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Human-authored paper overview." }) })).json()) as PaperMemory;
    const updatedSection = (await (await request(`/api/projects/${project.id}/memory/sections/${section.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Human-authored introduction summary." }) })).json()) as PaperMemory;
    expect(confirmed.items[0]?.locked).toBe(true);
    expect(overview.overview?.locked).toBe(true);
    expect(updatedSection.sections?.find((item) => item.id === section.id)?.locked).toBe(true);
    expect(polishCalls).toEqual([
      { kind: "fact", content: "用户确认 telemetry-only claim." },
      { kind: "overview", content: "Human-authored paper overview." },
      { kind: "section", content: "Human-authored introduction summary." }
    ]);

    const regenerated = (await (await request(`/api/projects/${project.id}/memory/extract`, { method: "POST" })).json()) as PaperMemory;
    const preserved = regenerated.items.find((item) => item.id === fact.id)!;
    expect(regenerated.items).toHaveLength(1);
    expect(preserved).toMatchObject({ content: "The user confirms the telemetry-only claim.", locked: true, humanEdited: true });
    expect(preserved.candidate?.content).toBe("The protocol protects telemetry and endpoint metadata.");
    expect(regenerated.overview?.content).toBe("Human-authored paper overview.");
    expect(regenerated.overview?.candidate?.content).toBe("The paper proposes an expanded telemetry protocol.");
    expect(regenerated.sections?.find((item) => item.id === section.id)?.content).toBe("Human-authored introduction summary.");
    expect(regenerated.sections?.find((item) => item.id === section.id)?.candidate?.content).toBe("Introduces expanded telemetry protection.");

    const acceptedOverview = (await (await request(`/api/projects/${project.id}/memory/overview/accept`, { method: "POST" })).json()) as PaperMemory;
    expect(acceptedOverview.overview).toMatchObject({ content: "The paper proposes an expanded telemetry protocol.", locked: true, humanEdited: false });
    expect(acceptedOverview.overview?.candidate).toBeUndefined();
    const acceptedSection = (await (await request(`/api/projects/${project.id}/memory/sections/${section.id}/accept`, { method: "POST" })).json()) as PaperMemory;
    expect(acceptedSection.sections?.find((item) => item.id === section.id)).toMatchObject({ content: "Introduces expanded telemetry protection.", locked: true, humanEdited: false });
    const acceptedFact = (await (await request(`/api/projects/${project.id}/memory/items/${fact.id}/accept`, { method: "POST" })).json()) as PaperMemory;
    expect(acceptedFact.items.find((item) => item.id === fact.id)).toMatchObject({ content: "The protocol protects telemetry and endpoint metadata.", status: "confirmed", locked: true, humanEdited: false });
    expect(polishCalls).toHaveLength(3);
  });

  test("writes a reviewable root memory.md and supplies its user instructions without re-ingesting the file", async () => {
    let agentInstructions = "";
    let agentPaths: string[] = [];
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async extractMemory() {
        return { items: [{ category: "contribution", label: "Core result", content: "The system protects telemetry metadata.", sources: [{ path: "main.tex", excerpt: "The system protects telemetry metadata.", section: "Introduction", line: null }] }] };
      },
      async summarizeMemory() { return { overview: "A telemetry privacy system.", sections: [{ path: "main.tex", title: "Introduction", content: "Introduces the telemetry privacy result." }] }; },
      async planAgentTask(input) { agentInstructions = input.skillInstructions; agentPaths = input.documents.map((document) => document.path); return { steps: ["Inspect the argument"], affectedFiles: ["main.tex"], risks: [], validation: ["Compile"] }; }
    };
    const request = await testApplication(provider);
    const project = (await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Durable Memory" }) })).json()) as PaperProject;
    const main = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `${main.content}\n\\section{Introduction}\nThe system protects telemetry metadata.`, baseVersion: main.file.version }) });

    const extracted = await request(`/api/projects/${project.id}/memory/extract`, { method: "POST" });
    expect(extracted.status).toBe(201);
    const candidateFile = (await (await request(`/api/projects/${project.id}/file?path=memory.md`)).json()) as FileContentResponse;
    expect(candidateFile.content).toContain("## Candidate Context");
    expect(candidateFile.content).toContain("## User Instructions");
    const instructions = candidateFile.content.replace(/<!-- Add durable [^]*?-->/, "Never broaden the threat model or invent evaluation results.");
    await request(`/api/projects/${project.id}/file?path=memory.md`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: instructions, baseVersion: candidateFile.file.version }) });

    const applied = await request(`/api/projects/${project.id}/memory/apply`, { method: "POST" });
    expect(applied.status).toBe(200);
    expect((await applied.json() as PaperMemory).items[0]).toMatchObject({ status: "confirmed", locked: true });
    const reviewedFile = (await (await request(`/api/projects/${project.id}/file?path=memory.md`)).json()) as FileContentResponse;
    expect(reviewedFile.content).toContain("## Reviewed Context");
    expect(reviewedFile.content).toContain("Never broaden the threat model");

    await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Inspect the paper argument", scope: { type: "project" } }) });
    expect(agentInstructions).toContain("[user-instructions]");
    expect(agentInstructions).toContain("Never broaden the threat model or invent evaluation results.");
    expect(agentPaths).not.toContain("memory.md");
  });

  test("runs Review Issue through plan, multi-file approval, targeted re-review and rollback", async () => {
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async review(input) { return { overallAssessment: "Threat model incomplete.", recommendation: "reject", strengths: [], weaknesses: ["Missing compromise analysis."], nextSteps: ["Clarify endpoint compromise."], issues: [{ category: "threat-model", severity: "major", title: "Endpoint compromise omitted", rationale: "The current threat model does not cover endpoint compromise.", impact: "The guarantee is ambiguous.", suggestion: "Add explicit endpoint compromise behavior.", evidence: [{ path: "main.tex", section: "Threat Model", line: null, excerpt: "Threat model placeholder.", inferred: false }] }] }; },
      async planAgentTask(input) { expect(input.issues[0]?.title).toBe("Endpoint compromise omitted"); return { steps: ["Clarify the trust boundary", "Add compromise behavior"], affectedFiles: ["main.tex"], risks: ["Do not overstate guarantees"], validation: ["Recompile", "Targeted re-review"] }; },
      async generateAgentTask(input) { const main = input.documents.find((document) => document.path === "main.tex")!; return { files: [{ path: "main.tex", content: `${main.content}Compromised endpoints are outside the trust boundary.\n`, rationale: "Makes endpoint compromise explicit." }] }; },
      async rereviewIssues(input) { expect(input.documents.find((document) => document.path === "main.tex")?.content).toContain("outside the trust boundary"); return { assessments: input.issues.map((issue) => ({ issueId: issue.id, resolved: true, assessment: "The trust boundary is now explicit." })), regressions: [] }; }
    };
    const request = await testApplication(provider);
    const project = (await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Resolution Paper", venue: "network-information-security" }) })).json()) as PaperProject;
    const opened = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    const content = "\\section{Threat Model}\nThreat model placeholder.\n";
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, baseVersion: opened.file.version }) });
    const review = await (await request(`/api/projects/${project.id}/reviews`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceOnly: true }) })).json() as { report: { issues: Array<{ id: string }> } };
    const issueId = review.report.issues[0]!.id;
    const planned = await (await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Resolve the endpoint-compromise review issue", scope: { type: "project" }, issueIds: [issueId] }) })).json() as { plan: { id: string }; resolution: { id: string; status: string; reviewSnapshotIds: string[]; baseProjectVersion: number; skill: { venue: string } } };
    expect(planned.resolution.status).toBe("planned");
    expect(planned.resolution).toMatchObject({ reviewSnapshotIds: [expect.stringContaining("snapshot_")], skill: { venue: "network-information-security" } });
    const reportsAfterPlan = await (await request(`/api/projects/${project.id}/reviews`)).json() as Array<{ issues: Array<{ id: string; status: string }> }>;
    expect(reportsAfterPlan[0]!.issues.find((issue) => issue.id === issueId)?.status).toBe("planned");

    const generated = await (await request(`/api/projects/${project.id}/agent-tasks/${planned.plan.id}/confirm`, { method: "POST" })).json() as { changeSet: ChangeSet; resolution: { status: string } };
    expect(generated.resolution.status).toBe("in-revision");
    expect(generated.changeSet.changes[0]?.hunks?.[0]).toMatchObject({
      rationale: "Makes endpoint compromise explicit.",
      evidence: [{ issueId, issueTitle: "Endpoint compromise omitted", path: "main.tex", excerpt: "Threat model placeholder.", inferred: false }]
    });
    expect((await (await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}`)).json() as ChangeSet).id).toBe(generated.changeSet.id);
    expect(((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse).content).toBe(content);
    await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/accept`, { method: "POST" });
    const resolutions = await (await request(`/api/projects/${project.id}/issue-resolutions`)).json() as Array<{ id: string; status: string }>;
    expect(resolutions[0]?.status).toBe("in-revision");
    expect((await request(`/api/projects/${project.id}/issue-resolutions/${planned.resolution.id}/rereview`, { method: "POST" })).status).toBe(409);
    const revisedProject = await (await request(`/api/projects/${project.id}`)).json() as PaperProject;
    expect((await request(`/api/projects/${project.id}/compile-results`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectVersion: revisedProject.version, status: "error", summary: "Missing package" }) })).status).toBe(201);
    expect((await (await request(`/api/projects/${project.id}/issue-resolutions`)).json() as Array<{ status: string }>)[0]?.status).toBe("in-revision");
    expect((await request(`/api/projects/${project.id}/compile-results`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectVersion: revisedProject.version, status: "success", summary: "WASM fixture compiled" }) })).status).toBe(201);
    expect((await (await request(`/api/projects/${project.id}/issue-resolutions`)).json() as Array<{ status: string }>)[0]?.status).toBe("needs-review");
    const rereviewed = await (await request(`/api/projects/${project.id}/issue-resolutions/${planned.resolution.id}/rereview`, { method: "POST" })).json() as { status: string; rereviewAssessment: string; compileRecordId: string };
    expect(rereviewed).toMatchObject({ status: "resolved", rereviewAssessment: expect.stringContaining("The trust boundary is now explicit.") });
    expect(rereviewed.compileRecordId).toStartWith("compile_");
    const reportsResolved = await (await request(`/api/projects/${project.id}/reviews`)).json() as Array<{ issues: Array<{ id: string; status: string }> }>;
    expect(reportsResolved[0]!.issues.find((issue) => issue.id === issueId)?.status).toBe("resolved");

    const reopened = await (await request(`/api/projects/${project.id}/issue-resolutions/${planned.resolution.id}/reopen`, { method: "POST" })).json() as { status: string };
    expect(reopened.status).toBe("reopened");
    const reportsReopened = await (await request(`/api/projects/${project.id}/reviews`)).json() as Array<{ issues: Array<{ id: string; status: string }> }>;
    expect(reportsReopened[0]!.issues.find((issue) => issue.id === issueId)?.status).toBe("open");

    await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/rollback`, { method: "POST" });
    expect(((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse).content).toBe(content);
    const reportsRolledBack = await (await request(`/api/projects/${project.id}/reviews`)).json() as Array<{ issues: Array<{ id: string; status: string }> }>;
    expect(reportsRolledBack[0]!.issues.find((issue) => issue.id === issueId)?.status).toBe("open");
  });

  test("generates bounded Skill-guided completion without writing and rejects stale cursors", async () => {
    let received: CompletionAgentInput | undefined;
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async extractMemory() {
        return { items: [{ category: "contribution", label: "Telemetry", content: "The design protects aggregate telemetry.", sources: [{ path: "main.tex", excerpt: "The design protects aggregate telemetry.", section: "Introduction", line: null }] }] };
      },
      async complete(input) {
        received = input;
        return { suggestion: " It remains robust under the stated threat model." };
      }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Completion Paper", venue: "artificial-intelligence" }) })).json() as PaperProject;
    const opened = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    const sentence = "The design protects aggregate telemetry.";
    const content = `\\section{Introduction}\n${"context ".repeat(500)}${sentence}`;
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, baseVersion: opened.file.version }) });
    await request(`/api/projects/${project.id}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "references.bib", content: "@inproceedings{telemetry, title={Private Telemetry}}" }) });
    const memory = await (await request(`/api/projects/${project.id}/memory/extract`, { method: "POST" })).json() as { items: Array<{ id: string }> };
    await request(`/api/projects/${project.id}/memory/items/${memory.items[0]!.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "confirmed" }) });
    const current = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;

    const completionResponse = await request(`/api/projects/${project.id}/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "main.tex", cursor: current.content.length, fileVersion: current.file.version, kind: "auto" })
    });
    expect(completionResponse.status).toBe(201);
    const completion = await completionResponse.json() as CompletionResponse;
    expect(completion).toMatchObject({ path: "main.tex", cursor: current.content.length, fileVersion: current.file.version, kind: "auto" });
    expect(received?.contextBefore.length).toBeLessThanOrEqual(2_500);
    expect(received?.contextBefore).toEndWith(sentence);
    expect(received?.skillInstructions).toContain("[paper-overview] Telemetry: The design protects aggregate telemetry.");
    expect(received?.skillInstructions).not.toContain("[contribution] Telemetry: The design protects aggregate telemetry.");
    expect(received?.paperContext).toContain("[paper-overview] Telemetry: The design protects aggregate telemetry.");
    expect(received?.skill.id).toBe("artificial-intelligence");
    expect(received?.venueInstructions).toContain("# Artificial intelligence");
    expect(received?.bibliography).toContain("Private Telemetry");
    expect((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse).content).toBe(content);

    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `${content}\nNew edit.`, baseVersion: current.file.version }) });
    expect((await request(`/api/projects/${project.id}/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "main.tex", cursor: current.content.length, fileVersion: current.file.version, kind: "auto" }) })).status).toBe(409);
  });

  test("accepts and rejects independent hunks while revalidating each intermediate file version", async () => {
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async planAgentTask() { return { steps: ["Revise two claims"], affectedFiles: ["main.tex"], risks: [], validation: ["Compile"] }; },
      async generateAgentTask(input) {
        const document = input.documents.find((candidate) => candidate.path === "main.tex")!;
        return { files: [{ path: "main.tex", content: document.content.replace("old method", "new method").replace("old result", "new result"), rationale: "Updates two independent claims." }] };
      }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Partial Approval" }) })).json() as PaperProject;
    const initial = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    const original = "title\nkeep alpha\nold method\nkeep beta\nold result\nend\n";
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: original, baseVersion: initial.file.version }) });
    const planned = await (await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Update method and result claims", scope: { type: "project" } }) })).json() as { plan: { id: string } };
    const generated = await (await request(`/api/projects/${project.id}/agent-tasks/${planned.plan.id}/confirm`, { method: "POST" })).json() as { changeSet: ChangeSet };
    const change = generated.changeSet.changes[0]!;
    expect(change.hunks).toHaveLength(2);

    const first = await (await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions: [{ path: "main.tex", hunkIds: [change.hunks![0]!.id], status: "accepted" }] }) })).json() as ChangeSet;
    expect(first.status).toBe("partially-accepted");
    const intermediate = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    expect(intermediate.content).toContain("new method");
    expect(intermediate.content).toContain("old result");

    const final = await (await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions: [{ path: "main.tex", hunkIds: [change.hunks![1]!.id], status: "rejected" }] }) })).json() as ChangeSet;
    expect(final.status).toBe("partially-accepted");
    expect(final.changes[0]!.hunks?.map((hunk) => hunk.status)).toEqual(["accepted", "rejected"]);
    const partiallyApplied = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    expect(partiallyApplied.content).toBe(intermediate.content);

    const reversed = await (await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions: [{ path: "main.tex", hunkIds: [change.hunks![0]!.id], status: "rejected" }] }) })).json() as ChangeSet;
    expect(reversed.changes[0]!.hunks?.map((hunk) => hunk.status)).toEqual(["rejected", "rejected"]);
    expect((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse).content).toBe(original);

    const reconsidered = await (await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions: [{ path: "main.tex", hunkIds: [change.hunks![1]!.id], status: "accepted" }] }) })).json() as ChangeSet;
    expect(reconsidered.changes[0]!.hunks?.map((hunk) => hunk.status)).toEqual(["rejected", "accepted"]);
    const beforeFinish = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    expect(beforeFinish.content).toContain("old method");
    expect(beforeFinish.content).toContain("new result");
    const finished = await (await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/finish`, { method: "POST" })).json() as ChangeSet;
    expect(finished).toMatchObject({ status: "accepted", approvalMode: "explicit-finish", reviewFinishedAt: expect.any(String) });

    const appliedProject = await (await request(`/api/projects/${project.id}`)).json() as PaperProject;
    await request(`/api/projects/${project.id}/compile-results`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectVersion: appliedProject.version, status: "success", summary: "Partial hunk fixture compiled" }) });
    const audited = await (await request(`/api/projects/${project.id}/agent-runs`)).json() as Array<{ auditTrail: Array<{ action: string; summary: string }> }>;
    expect(audited[0]!.auditTrail.map((event) => event.action)).toEqual(expect.arrayContaining(["context-read", "context-search", "plan-created", "execution-started", "changes-proposed", "hunk-decision", "compile"]));
    expect(audited[0]!.auditTrail.every((event) => !event.summary.includes("old method"))).toBe(true);

    expect((await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/rollback`, { method: "POST" })).status).toBe(200);
    expect((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse).content).toBe(original);
    const rolledBackAudit = await (await request(`/api/projects/${project.id}/agent-runs`)).json() as Array<{ auditTrail: Array<{ action: string }> }>;
    expect(rolledBackAudit[0]!.auditTrail.some((event) => event.action === "rollback")).toBe(true);
  });

  test("edits one Agent hunk without resetting decisions in the same file", async () => {
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async planAgentTask() { return { steps: ["Revise two claims"], affectedFiles: ["main.tex"], risks: [], validation: ["Compile"] }; },
      async generateAgentTask(input) {
        const document = input.documents.find((candidate) => candidate.path === "main.tex")!;
        return { files: [{ path: "main.tex", content: document.content.replace("old method", "new method").replace("old result", "new result"), rationale: "Updates two independent claims." }] };
      }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Hunk editing" }) })).json() as PaperProject;
    const opened = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    const original = "title\nkeep alpha\nold method\nkeep beta\nold result\nend\n";
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: original, baseVersion: opened.file.version }) });
    const planned = await (await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Update both claims", scope: { type: "project" } }) })).json() as { plan: { id: string } };
    const generated = await (await request(`/api/projects/${project.id}/agent-tasks/${planned.plan.id}/confirm`, { method: "POST" })).json() as { changeSet: ChangeSet };
    const change = generated.changeSet.changes[0]!;
    const methodHunk = change.hunks!.find((hunk) => hunk.before.includes("old method"))!;
    const resultHunk = change.hunks!.find((hunk) => hunk.before.includes("old result"))!;
    await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions: [{ path: change.path, hunkIds: [methodHunk.id], status: "accepted" }] }) });

    const editedAfter = resultHunk.after.replace("new result", "author-refined result");
    const editedResponse = await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ hunks: [{ path: change.path, hunkId: resultHunk.id, after: editedAfter }] }) });
    expect(editedResponse.status).toBe(200);
    const edited = await editedResponse.json() as ChangeSet;
    expect(edited.changes[0]!.hunks?.map((hunk) => ({ id: hunk.id, status: hunk.status }))).toEqual([{ id: methodHunk.id, status: "accepted" }, { id: resultHunk.id, status: "pending" }]);
    expect(edited.changes[0]!.after).toContain("author-refined result");
    const beforeSecondAccept = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    expect(beforeSecondAccept.content).toContain("new method");
    expect(beforeSecondAccept.content).toContain("old result");

    await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions: [{ path: change.path, hunkIds: [resultHunk.id], status: "accepted" }] }) });
    expect((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse).content).toContain("author-refined result");
    const runs = await (await request(`/api/projects/${project.id}/agent-runs`)).json() as Array<{ auditTrail: Array<{ action: string }> }>;
    expect(runs[0]!.auditTrail.some((event) => event.action === "hunk-edited")).toBe(true);
  });

  test("recomputes blocking citation findings after a reviewed hunk is edited", async () => {
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async planAgentTask() { return { steps: ["Revise the claim"], affectedFiles: ["main.tex"], risks: [], validation: ["Compile"] }; },
      async generateAgentTask(input) {
        const document = input.documents.find((candidate) => candidate.path === "main.tex")!;
        return { files: [{ path: "main.tex", content: document.content.replace("old claim", "new claim \\cite{unknown}"), rationale: "Adds a citation-dependent claim." }] };
      }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Citation finding edit" }) })).json() as PaperProject;
    const opened = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "old claim\n", baseVersion: opened.file.version }) });
    const planned = await (await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Revise the claim", scope: { type: "project" } }) })).json() as { plan: { id: string } };
    const generated = await (await request(`/api/projects/${project.id}/agent-tasks/${planned.plan.id}/confirm`, { method: "POST" })).json() as { changeSet: ChangeSet };
    const hunk = generated.changeSet.changes[0]!.hunks![0]!;
    expect(hunk.findings?.[0]?.status).toBe("blocking");
    expect((await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions: [{ path: "main.tex", hunkIds: [hunk.id], status: "accepted" }] }) })).status).toBe(409);

    const edited = await (await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ hunks: [{ path: "main.tex", hunkId: hunk.id, after: "new claim; TODO: add a verified citation" }] }) })).json() as ChangeSet;
    expect(edited.changes[0]!.hunks![0]!.findings).toBeUndefined();
    expect((await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions: [{ path: "main.tex", hunkIds: [hunk.id], status: "accepted" }] }) })).status).toBe(200);
  });

  test("previews external Agent conflicts and requires the latest version token before overwrite", async () => {
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async planAgentTask() { return { steps: ["Revise the method"], affectedFiles: ["main.tex"], risks: [], validation: ["Compile"] }; },
      async generateAgentTask(input) {
        const document = input.documents.find((candidate) => candidate.path === "main.tex")!;
        return { files: [{ path: "main.tex", content: document.content.replace("old method", "reviewed method"), rationale: "Updates the method claim." }] };
      }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Conflict overwrite" }) })).json() as PaperProject;
    const opened = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    const original = "title\nold method\nend\n";
    const savedOriginal = await (await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: original, baseVersion: opened.file.version }) })).json() as SaveFileResponse;
    const planned = await (await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Update the method", scope: { type: "project" } }) })).json() as { plan: { id: string } };
    const generated = await (await request(`/api/projects/${project.id}/agent-tasks/${planned.plan.id}/confirm`, { method: "POST" })).json() as { changeSet: ChangeSet };
    const change = generated.changeSet.changes[0]!;
    const externalContent = original.replace("end", "external edit\nend");
    const external = await (await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: externalContent, baseVersion: savedOriginal.file.version }) })).json() as SaveFileResponse;
    const decisions = [{ path: change.path, hunkIds: change.hunks!.map((hunk) => hunk.id), status: "accepted" as const }];

    const firstConflictResponse = await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions }) });
    expect(firstConflictResponse.status).toBe(409);
    const firstConflictBody = await firstConflictResponse.json() as { error: { code: string; details: ChangeSetConflictDetails } };
    expect(firstConflictBody.error.code).toBe("changeset_conflict_review_required");
    expect(firstConflictBody.error.details.conflicts[0]).toMatchObject({ path: "main.tex", currentContent: externalContent, currentVersion: external.file.version });
    expect(firstConflictBody.error.details.conflicts[0]!.reviewedContent).toContain("reviewed method");
    expect((await (await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}`)).json() as ChangeSet).status).toBe("proposed");
    expect((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse).content).toBe(externalContent);

    const changedAgainContent = externalContent.replace("end", "second external edit\nend");
    const changedAgain = await (await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: changedAgainContent, baseVersion: external.file.version }) })).json() as SaveFileResponse;
    const staleOverwriteResponse = await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions, overwriteConflicts: [{ path: "main.tex", currentVersion: external.file.version }] }) });
    expect(staleOverwriteResponse.status).toBe(409);
    const latestConflict = await staleOverwriteResponse.json() as { error: { details: ChangeSetConflictDetails } };
    expect(latestConflict.error.details.conflicts[0]!.currentVersion).toBe(changedAgain.file.version);
    expect((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse).content).toBe(changedAgainContent);

    const overwrittenResponse = await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions, overwriteConflicts: [{ path: "main.tex", currentVersion: changedAgain.file.version }] }) });
    expect(overwrittenResponse.status).toBe(200);
    const overwritten = await overwrittenResponse.json() as ChangeSet;
    expect(overwritten.status).toBe("partially-accepted");
    const finalFile = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    expect(finalFile.content).toBe(latestConflict.error.details.conflicts[0]!.reviewedContent);
    expect(finalFile.content).not.toContain("external edit");
  });

  test("imports a manifest-last FastRead bundle into visible research, evidence, claims and BibTeX", async () => {
    const request = await testApplication();
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "FastRead handoff" }) })).json() as PaperProject;
    const bundleId = "0123456789abcdef01234567";
    const root = `references/fastread/${bundleId}`;
    const evidenceMarkdown = "# Evidence\n\n- exact quote\n";
    const citationsJson = JSON.stringify({
      version: 1,
      bundle_id: bundleId,
      selector: { task_id: "paper-task", topic_id: "" },
      papers: [{ id: "paper-task", title: "FastRead paper", authors: ["Ada Lovelace"], year: 2026, doi: "10.1000/fastread", content_hash: "source-hash" }],
      citations: [{ task_id: "paper-task", page: 7, exact_quote: "The evaluated method improves accuracy by ten percent.", role: "report", note: "key result", source_hash: "source-hash" }]
    }, null, 2) + "\n";
    const referencesBib = "@article{Lovelace2026_1,\n  title = {FastRead paper},\n  author = {Ada Lovelace},\n  year = {2026}\n}\n";
    const files = { "evidence.md": evidenceMarkdown, "citations.json": citationsJson, "references.bib": referencesBib };
    for (const [name, content] of Object.entries(files)) expect((await request(`/api/projects/${project.id}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: `${root}/${name}`, content }) })).status).toBe(201);
    const manifest = JSON.stringify({
      version: 1,
      bundle_id: bundleId,
      immutable: true,
      files: Object.entries(files).map(([name, content]) => ({ name, sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"), bytes: Buffer.byteLength(content) }))
    }, null, 2) + "\n";
    expect((await request(`/api/projects/${project.id}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: `${root}/manifest.json`, content: manifest }) })).status).toBe(201);

    const bundles = await (await request(`/api/projects/${project.id}/fastread-bundles`)).json() as FastReadBundleReceipt[];
    expect(bundles).toHaveLength(1);
    expect(bundles[0]).toMatchObject({ bundleId, status: "imported", workIds: [expect.any(String)], evidenceIds: [expect.any(String)] });
    const works = await (await request(`/api/projects/${project.id}/research-works`)).json() as Array<ResearchWork & { project: { status: string; citationKey?: string } }>;
    expect(works).toHaveLength(1);
    expect(works[0]).toMatchObject({ title: "FastRead paper", project: { status: "saved", citationKey: "Lovelace2026_1" } });
    const importedEvidence = await (await request(`/api/projects/${project.id}/evidence`)).json() as SourceEvidence[];
    expect(importedEvidence).toHaveLength(1);
    expect(importedEvidence[0]).toMatchObject({ status: "approved", representation: "verbatim", locator: "7", sourceHash: "source-hash", fastReadBundleId: bundleId });

    const opened = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "\\documentclass{article}\n\\begin{document}\nOur method improves accuracy by ten percent.\n\\end{document}\n", baseVersion: opened.file.version }) });
    const firstScan = await (await request(`/api/projects/${project.id}/claim-scans`, { method: "POST" })).json() as PaperClaim[];
    expect(firstScan).toHaveLength(1);
    const linked = await (await request(`/api/projects/${project.id}/claims/${firstScan[0]!.id}/links`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "literature", evidenceId: importedEvidence[0]!.id, citationKey: "Lovelace2026_1" }) })).json() as ClaimEvidenceLink;
    expect(linked.kind).toBe("literature");
    expect((await request(`/api/projects/${project.id}/claims/${firstScan[0]!.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewStatus: "supported" }) })).status).toBe(200);
    const secondScan = await (await request(`/api/projects/${project.id}/claim-scans`, { method: "POST" })).json() as PaperClaim[];
    expect(secondScan[0]!.id).toBe(firstScan[0]!.id);
    expect(secondScan[0]!.reviewStatus).toBe("supported");
    expect(await (await request(`/api/projects/${project.id}/claim-links`)).json()).toHaveLength(1);

    const proposed = await (await request(`/api/projects/${project.id}/research-works/${works[0]!.id}/bibtex-changes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetBibPath: "references.bib" }) })).json() as ChangeSet;
    expect(proposed.changes[0]).toMatchObject({ operation: "create", path: "references.bib" });
    expect((await request(`/api/projects/${project.id}/change-sets/${proposed.id}/accept`, { method: "POST" })).status).toBe(200);
    expect((await (await request(`/api/projects/${project.id}/file?path=references.bib`)).json() as FileContentResponse).content).toContain("FastRead paper");

    const repeated = await (await request(`/api/projects/${project.id}/fastread-bundles/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manifestPath: `${root}/manifest.json` }) })).json() as FastReadBundleReceipt[];
    expect(repeated[0]!.status).toBe("imported");
    expect(await (await request(`/api/projects/${project.id}/research-works`)).json()).toHaveLength(1);
    expect(await (await request(`/api/projects/${project.id}/evidence`)).json()).toHaveLength(1);
  });

  test("keeps Claim identity anchored across edits and revokes unsupported status when support changes", async () => {
    const request = await testApplication();
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Claim lifecycle" }) })).json() as PaperProject;
    const source = await (await request(`/api/projects/${project.id}/research-works/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Verified result", authors: ["Ada Lovelace"], year: 2026, doi: "10.1000/claim-life", citationKey: "lovelace2026life" }) })).json() as ResearchWork;
    const evidence = await (await request(`/api/projects/${project.id}/evidence`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workId: source.id, kind: "result", content: "The evaluated method improves accuracy by ten percent.", locatorType: "page", locator: "7", origin: "source-text", representation: "verbatim" }) })).json() as SourceEvidence;
    await request(`/api/projects/${project.id}/evidence/${evidence.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "approved" }) });
    const opened = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    const original = "\\documentclass{article}\n\\begin{document}\nThe deployment setting is fixed.\nOur method improves accuracy by ten percent.\nThe evaluation ends here.\n\\end{document}\n";
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: original, baseVersion: opened.file.version }) });
    const scanned = await (await request(`/api/projects/${project.id}/claim-scans`, { method: "POST" })).json() as PaperClaim[];
    const claim = scanned.find((item) => item.anchor.exactText === "Our method improves accuracy by ten percent.")!;
    const linked = await (await request(`/api/projects/${project.id}/claims/${claim.id}/links`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "literature", evidenceId: evidence.id, citationKey: "lovelace2026life" }) })).json() as ClaimEvidenceLink;
    expect((await request(`/api/projects/${project.id}/claims/${claim.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewStatus: "supported" }) })).status).toBe(200);

    const current = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    const shifted = `% context shift\n${original}`;
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: shifted, baseVersion: current.file.version }) });
    const shiftedClaim = (await (await request(`/api/projects/${project.id}/claims`)).json() as PaperClaim[]).find((item) => item.id === claim.id)!;
    expect(shiftedClaim).toMatchObject({ id: claim.id, reviewStatus: "supported", anchorStatus: "reanchored" });
    expect(shiftedClaim.anchor.startOffset).toBeGreaterThan(claim.anchor.startOffset);

    const shiftedFile = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    const revised = shifted.replace("improves accuracy by ten percent", "improves accuracy by eleven percent");
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: revised, baseVersion: shiftedFile.file.version }) });
    const revisedClaim = (await (await request(`/api/projects/${project.id}/claims`)).json() as PaperClaim[]).find((item) => item.id === claim.id)!;
    expect(revisedClaim).toMatchObject({ id: claim.id, reviewStatus: "needs-review", anchorStatus: "reanchored" });
    expect(revisedClaim.anchor.exactText).toBe("Our method improves accuracy by eleven percent.");
    expect((await (await request(`/api/projects/${project.id}/claim-links`)).json() as ClaimEvidenceLink[]).some((item) => item.id === linked.id)).toBe(true);
    expect((await request(`/api/projects/${project.id}/claims/${claim.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewStatus: "supported" }) })).status).toBe(200);
    await request(`/api/projects/${project.id}/evidence/${evidence.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "rejected" }) });
    expect((await (await request(`/api/projects/${project.id}/claims`)).json() as PaperClaim[]).find((item) => item.id === claim.id)?.reviewStatus).toBe("needs-review");
    await request(`/api/projects/${project.id}/evidence/${evidence.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "approved" }) });
    await request(`/api/projects/${project.id}/claims/${claim.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewStatus: "supported" }) });
    await request(`/api/projects/${project.id}/claims/${claim.id}/links/${linked.id}`, { method: "DELETE" });
    expect((await (await request(`/api/projects/${project.id}/claims`)).json() as PaperClaim[]).find((item) => item.id === claim.id)?.reviewStatus).toBe("needs-review");
  });

  test("aggregates the evidence cockpit with support and anchor counts", async () => {
    const request = await testApplication();
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Evidence cockpit" }) })).json() as PaperProject;
    const opened = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    const content = "\\documentclass{article}\n\\begin{document}\nOur method improves accuracy by ten percent.\nThe deployment setting is fixed.\n\\end{document}\n";
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, baseVersion: opened.file.version }) });
    const claims = await (await request(`/api/projects/${project.id}/claim-scans`, { method: "POST" })).json() as PaperClaim[];
    expect(claims.length).toBeGreaterThanOrEqual(1);
    const cockpit = await (await request(`/api/projects/${project.id}/evidence-cockpit`)).json() as { counts: { total: number; supported: number; unresolved: number }; claims: Array<{ support: string }> };
    expect(cockpit.counts.total).toBe(cockpit.claims.length);
    expect(cockpit.counts.unresolved).toBeGreaterThanOrEqual(1);
    expect(cockpit.claims.every((item) => item.support === "unresolved" || item.support === "unsupported" || item.support === "partial" || item.support === "supported")).toBe(true);
  });

  test("separates citation presence, metadata verification, and claim support", async () => {
    const request = await testApplication();
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Citation reviewer" }) })).json() as PaperProject;
    const source = await (await request(`/api/projects/${project.id}/research-works/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Metadata only", authors: ["Ada Lovelace"], year: 2026, citationKey: "lovelace2026meta" }) })).json() as ResearchWork;
    const opened = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    const content = "\\documentclass{article}\n\\begin{document}\nPrior work is cited \\cite{lovelace2026meta}.\nOur method improves accuracy by ten percent.\n\\end{document}\n";
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, baseVersion: opened.file.version }) });
    const claims = await (await request(`/api/projects/${project.id}/claim-scans`, { method: "POST" })).json() as PaperClaim[];
    const reviewer = await (await request(`/api/projects/${project.id}/citation-reviewer`)).json() as { items: Array<{ claim: PaperClaim; citationStatus: string; evidenceStatus: string; metadataVerifiedCount: number; approvedEvidenceCount: number }>; counts: { total: number; missing: number } };
    expect(reviewer.counts.total).toBe(claims.length);
    const cited = reviewer.items.find((item) => item.claim.anchor.exactText.includes("Prior work"));
    expect(cited).toMatchObject({ citationStatus: "cited", evidenceStatus: "unresolved", approvedEvidenceCount: 0 });
    const unsupported = reviewer.items.find((item) => item.claim.anchor.exactText.includes("improves accuracy"));
    expect(unsupported?.citationStatus).toBe("missing");
    expect(reviewer.counts.missing).toBeGreaterThanOrEqual(1);
    expect(source.id).toBeTruthy();
  });

  test("keeps citation stance independent from evidence approval", async () => {
    const request = await testApplication();
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Citation stance" }) })).json() as PaperProject;
    const work = await (await request(`/api/projects/${project.id}/research-works/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Contrary study", authors: ["Ada Lovelace"], citationKey: "contrary2026" }) })).json() as ResearchWork;
    const created = await (await request(`/api/projects/${project.id}/evidence`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workId: work.id, content: "The source reports a contrary result.", locatorType: "page", locator: "4", stance: "contradicts" }) })).json() as SourceEvidence;
    expect(created).toMatchObject({ stance: "contradicts", status: "candidate" });
    const updated = await (await request(`/api/projects/${project.id}/evidence/${created.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "approved" }) })).json() as SourceEvidence;
    expect(updated).toMatchObject({ id: created.id, stance: "contradicts", status: "approved" });
    const restated = await (await request(`/api/projects/${project.id}/evidence/${created.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ stance: "mentions" }) })).json() as SourceEvidence;
    expect(restated).toMatchObject({ id: created.id, stance: "mentions", status: "approved" });
    expect((await (await request(`/api/projects/${project.id}/evidence`)).json() as SourceEvidence[])).toHaveLength(1);
  });

  test("deduplicates manual sources and exposes provenance, identifiers and citation context", async () => {
    const request = await testApplication();
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Source provenance" }) })).json() as PaperProject;
    const body = { title: "A Traceable Source", authors: ["Ada Lovelace"], year: 2026, venue: "TestConf", doi: "https://doi.org/10.1000/TRACE", citationKey: "lovelace2026trace" };
    const first = await (await request(`/api/projects/${project.id}/research-works/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as ResearchWork;
    const second = await (await request(`/api/projects/${project.id}/research-works/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, doi: "10.1000/trace" }) })).json() as ResearchWork;
    expect(second.id).toBe(first.id);
    const works = await (await request(`/api/projects/${project.id}/research-works`)).json() as ProjectResearchWorkDetails[];
    expect(works).toHaveLength(1);
    expect(works[0]).toMatchObject({ id: first.id, project: { status: "saved", citationKey: "lovelace2026trace" }, identifiers: [{ scheme: "doi", value: "10.1000/trace" }] });
    expect(works[0]!.metadataObservations.map((item) => item.provider)).toEqual(["user"]);
    const opened = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "\\documentclass{article}\n\\begin{document}\nPrior work is traceable \\cite{lovelace2026trace}.\n\\end{document}\n", baseVersion: opened.file.version }) });
    const context = await (await request(`/api/projects/${project.id}/research-citations/lovelace2026trace`)).json() as { contexts: Array<{ path: string; line: number; excerpt: string }> };
    expect(context.contexts[0]).toMatchObject({ path: "main.tex", line: 3 });
    expect(context.contexts[0]!.excerpt).toContain("lovelace2026trace");
  });

  test("persists a research protocol on a completed run", async () => {
    const fetcher = (async (input: string | URL | Request) => String(input).includes("api.crossref.org") ? Response.json({ message: { items: [{ title: ["Protocol fixture"], author: [{ given: "Ada", family: "Lovelace" }], issued: { "date-parts": [[2026]] }, DOI: "10.1000/protocol" }] } }) : new Response("<feed></feed>", { status: 200 })) as unknown as typeof fetch;
    const request = await testApplication(undefined, undefined, undefined, undefined, undefined, fetcher);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Research protocol" }) })).json() as PaperProject;
    const created = await (await request(`/api/projects/${project.id}/research-runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "protocol fixture" }) })).json() as { run: { id: string } };
    const response = await request(`/api/projects/${project.id}/research-runs/${created.run.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ steps: ["Search indexed literature", "Screen titles"], rationale: "Reproducible review", inclusionCriteria: ["Peer reviewed"], exclusionCriteria: ["Retracted"], extractionFields: ["outcome"] }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ queryPlan: { steps: ["Search indexed literature", "Screen titles"], inclusionCriteria: ["Peer reviewed"], exclusionCriteria: ["Retracted"], extractionFields: ["outcome"] } });
  });

  test("audits research screening decisions and extraction notes", async () => {
    const fetcher = (async () => Response.json({ message: { items: [{ title: ["Screen fixture"], author: [{ given: "Ada", family: "Lovelace" }], issued: { "date-parts": [[2026]] } }] } })) as unknown as typeof fetch;
    const request = await testApplication(undefined, undefined, undefined, undefined, undefined, fetcher);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Screening audit" }) })).json() as PaperProject;
    const result = await (await request(`/api/projects/${project.id}/research-runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "screen fixture" }) })).json() as { run: ResearchRun; works: ResearchWork[] };
    const work = result.works[0]!;
    const response = await request(`/api/projects/${project.id}/research-runs/${result.run.id}/screening/${work.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "included", reason: "Matches population", extracted: { outcome: "accuracy" } }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ runId: result.run.id, workId: work.id, decision: "included", reason: "Matches population", extracted: { outcome: "accuracy" } });
    expect(await (await request(`/api/projects/${project.id}/research-runs/${result.run.id}/screening`)).json()).toHaveLength(1);
  });

  test("proposes bounded table and equation ChangeSets without writing files", async () => {
    const request = await testApplication();
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Structured candidates" }) })).json() as PaperProject;
    const table = await (await request(`/api/projects/${project.id}/table-equation-candidates`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "table", targetPath: "sections/results.tex", sourceFormat: "csv", source: "Method,Accuracy\nA,0.9\nB,0.8", caption: "Results" }) })).json() as { schema: { columns: string[]; rows: number }; preview: string; changeSet: ChangeSet; compileCheck: { status: string } };
    expect(table.schema).toMatchObject({ columns: ["Method", "Accuracy"], rows: 2 });
    expect(table.preview).toContain("\\begin{table}");
    expect(table.changeSet.status).toBe("proposed");
    expect(table.compileCheck.status).toBe("not-run");
    expect((await request(`/api/projects/${project.id}/file?path=sections/results.tex`)).status).toBe(404);
    const equation = await (await request(`/api/projects/${project.id}/table-equation-candidates`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "equation", targetPath: "sections/math.tex", sourceFormat: "latex", source: "x = y + 1", label: "eq:offset" }) })).json() as { preview: string; schema: { variables: string[] } };
    expect(equation.preview).toContain("\\label{eq:offset}");
    expect(equation.schema.variables).toContain("x");
    const check = await (await request(`/api/projects/${project.id}/table-equation-candidates/${table.changeSet.id}/compile-check`, { method: "POST" })).json() as { status: string; message: string };
    expect(check).toMatchObject({ status: "passed" });
  });


  test("keeps a failed FastRead hash receipt visible and retryable", async () => {
    const request = await testApplication();
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Broken handoff" }) })).json() as PaperProject;
    const bundleId = "fedcba987654321001234567";
    const root = `references/fastread/${bundleId}`;
    for (const [name, content] of [["evidence.md", "evidence"], ["citations.json", JSON.stringify({ version: 1, bundle_id: bundleId, papers: [], citations: [] })], ["references.bib", ""]] as const) await request(`/api/projects/${project.id}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: `${root}/${name}`, content }) });
    const manifest = JSON.stringify({ version: 1, bundle_id: bundleId, immutable: true, files: [{ name: "evidence.md", sha256: "0".repeat(64), bytes: 8 }, { name: "citations.json", sha256: "0".repeat(64), bytes: 2 }, { name: "references.bib", sha256: new Bun.CryptoHasher("sha256").update("").digest("hex"), bytes: 0 }] });
    expect((await request(`/api/projects/${project.id}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: `${root}/manifest.json`, content: manifest }) })).status).toBe(201);
    const receipts = await (await request(`/api/projects/${project.id}/fastread-bundles`)).json() as FastReadBundleReceipt[];
    expect(receipts[0]).toMatchObject({ bundleId, status: "failed" });
    expect(receipts[0]!.error).toContain("SHA-256");
    expect(await (await request(`/api/projects/${project.id}/research-works`)).json()).toHaveLength(0);
  });

  test("working status, stage, unstage and commit move a file through the index", async () => {
    const request = await testApplication();
    const registered = await request("/api/auth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "git-owner@example.test", password: "correct-horse-battery-staple", displayName: "Owner" })
    });
    const owner = await registered.json() as { token: string };
    const ownerHeaders = { authorization: `Bearer ${owner.token}`, "content-type": "application/json" };
    const project = await (await request("/api/projects", {
      method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "Index integration" })
    })).json() as PaperProject;
    const base = `/api/projects/${project.id}`;

    // Commit a baseline, then change the file again so there is something unstaged.
    const opened = await (await request(`${base}/file?path=main.tex`, { headers: ownerHeaders })).json() as FileContentResponse;
    await request(`${base}/file?path=main.tex`, {
      method: "PUT", headers: ownerHeaders,
      body: JSON.stringify({ content: "% first\n", baseVersion: opened.file.version })
    });
    await request(`${base}/history/checkpoint`, { method: "POST", headers: ownerHeaders });

    const after = await (await request(`${base}/file?path=main.tex`, { headers: ownerHeaders })).json() as FileContentResponse;
    await request(`${base}/file?path=main.tex`, {
      method: "PUT", headers: ownerHeaders,
      body: JSON.stringify({ content: "% second\n", baseVersion: after.file.version })
    });

    const before = await (await request(`${base}/history/working-status`, { headers: ownerHeaders })).json() as WorkingStatus;
    expect(before.files.find((file) => file.path === "main.tex")).toMatchObject({ unstaged: "M", staged: null });

    expect((await request(`${base}/history/stage`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ paths: ["main.tex"] }) })).status).toBe(204);
    const staged = await (await request(`${base}/history/working-status`, { headers: ownerHeaders })).json() as WorkingStatus;
    expect(staged.files.find((file) => file.path === "main.tex")).toMatchObject({ staged: "M", unstaged: null });

    expect((await request(`${base}/history/unstage`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ paths: ["main.tex"] }) })).status).toBe(204);
    expect((await request(`${base}/history/stage`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ paths: ["main.tex"] }) })).status).toBe(204);
    expect((await request(`${base}/history/commit`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ message: "Edit main" }) })).status).toBe(201);

    const cleared = await (await request(`${base}/history/working-status`, { headers: ownerHeaders })).json() as WorkingStatus;
    expect(cleared.files.find((file) => file.path === "main.tex")).toBeUndefined();
  });

  test("stage refuses an empty path list and commit refuses an empty message", async () => {
    const request = await testApplication();
    const registered = await request("/api/auth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "empty-guard@example.test", password: "correct-horse-battery-staple", displayName: "Owner" })
    });
    const owner = await registered.json() as { token: string };
    const ownerHeaders = { authorization: `Bearer ${owner.token}`, "content-type": "application/json" };
    const project = await (await request("/api/projects", {
      method: "POST", headers: ownerHeaders, body: JSON.stringify({ name: "Guards" })
    })).json() as PaperProject;
    const base = `/api/projects/${project.id}`;

    expect((await request(`${base}/history/stage`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ paths: [] }) })).status).toBe(400);
    expect((await request(`${base}/history/commit`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ message: "  " }) })).status).toBe(400);
    // A body without the JSON content-type must be rejected before it reaches git.
    expect((await request(`${base}/history/stage`, { method: "POST", headers: { authorization: ownerHeaders.authorization }, body: "{}" })).status).toBe(415);
  });
});
