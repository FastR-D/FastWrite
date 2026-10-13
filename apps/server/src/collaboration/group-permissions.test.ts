import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApplication } from "../app";
import * as Y from "yjs";

test("room reads and writes retain IdP group grants and honor subsequent group denial", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-room-groups-"));
  try {
    const app = await createApplication(directory, {
      features: { serverAuth: true }, bootstrapAdmin: { email: "admin@example.test", password: "fixture-password-long-enough" },
      oidcProvider: {
        beginLogin: async () => ({ kind: "redirect", url: "https://idp.example.test/login", binding: "group-state" }),
        finishLogin: async () => ({ issuer: "https://idp.example.test", subject: "group-member", email: "member@example.test", groups: ["researchers"], emailVerified: true }),
        logout: async () => undefined
      }
    });
    const request = (path: string, token?: string, method = "GET", body?: unknown, headers?: Record<string, string>) => app(new Request("http://test" + path, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }));
    const json = async (path: string, token?: string, method = "GET", body?: unknown, headers?: Record<string, string>) => {
      const response = await request(path, token, method, body, headers); expect(response.status).toBeLessThan(300); return await response.json() as any;
    };
    const owner = await json("/api/auth/register", undefined, "POST", { email: "owner@example.test", password: "fixture-password-long-enough" });
    const project = await json("/api/projects", owner.token, "POST", { name: "Room groups" });
    const base = "/api/projects/" + project.id;
    const start = await request("/api/auth/oidc/login");
    const callback = await request("/api/auth/oidc/callback?code=fixture&state=group-state", undefined, "GET", undefined, { cookie: start.headers.get("set-cookie")!.split(";", 1)[0]! });
    const member = await json("/api/auth/refresh", undefined, "POST", undefined, { cookie: callback.headers.get("set-cookie")!.split(";", 1)[0]! });
    const invite = await json(base + "/invitations", owner.token, "POST", { email: "member@example.test", role: "viewer" });
    await json("/api/invitations/" + invite.token + "/accept", member.token, "POST");
    await json(base + "/acl/new", owner.token, "PUT", { pathPrefix: "main.tex", subjectType: "idp_group", subjectId: "https://idp.example.test:researchers", action: "edit", effect: "allow" });
    const room = await json("/api/collaboration/tokens", member.token, "POST", { projectId: project.id, path: "main.tex" });
    expect(room.scope).toBe("write");
    expect((await request("/api/collaboration/room-access?token=" + encodeURIComponent(room.token))).status).toBe(200);
    const headers = { "x-fastwrite-room-token": room.token };
    const initial = await json("/api/collaboration/room-state", undefined, "GET", undefined, headers);
    const document = new Y.Doc();
    Y.applyUpdate(document, Buffer.from(initial.update, "base64"));
    document.getText("content").insert(0, "% allowed group update\n");
    const update = Buffer.from(Y.encodeStateAsUpdate(document)).toString("base64");
    expect((await request("/api/collaboration/room-update", undefined, "POST", { update }, headers)).status).toBe(200);
    // Upgrade role so denial must come from group ACL, rather than role fallback.
    await json(base + "/members/" + member.user.id, owner.token, "PATCH", { role: "editor" });
    await json(base + "/acl/new", owner.token, "PUT", { pathPrefix: "main.tex", subjectType: "idp_group", subjectId: "https://idp.example.test:researchers", action: "read", effect: "deny" });
    expect((await request(base + "/file?path=main.tex", member.token)).status).toBe(403);
    expect((await request("/api/collaboration/room-access?token=" + encodeURIComponent(room.token))).status).toBe(403);
    expect((await request("/api/collaboration/room-state", undefined, "GET", undefined, headers)).status).toBe(403);
    expect((await request("/api/collaboration/room-update", undefined, "POST", { update }, headers)).status).toBe(403);
    document.destroy();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
