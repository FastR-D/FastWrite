import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApplication } from "../app";

test("proposal reads and every review mutation enforce current file permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-changeset-acl-"));
  try {
    const app = await createApplication(directory, { features: { serverAuth: true }, bootstrapAdmin: { email: "admin@example.test", password: "fixture-password-long-enough" } });
    const request = (path: string, token?: string, method = "GET", body?: unknown) => app(new Request("http://test" + path, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }));
    const json = async (path: string, token?: string, method = "GET", body?: unknown) => {
      const response = await request(path, token, method, body);
      expect(response.status).toBeLessThan(300);
      return await response.json() as any;
    };
    const owner = await json("/api/auth/register", undefined, "POST", { email: "owner@example.test", password: "fixture-password-long-enough" });
    const member = await json("/api/auth/register", undefined, "POST", { email: "member@example.test", password: "fixture-password-long-enough" });
    const project = await json("/api/projects", owner.token, "POST", { name: "Proposal permissions" });
    const base = "/api/projects/" + project.id;
    const invite = await json(base + "/invitations", owner.token, "POST", { email: "member@example.test", role: "maintainer" });
    await json("/api/invitations/" + invite.token + "/accept", member.token, "POST");
    await json(base + "/files", owner.token, "POST", { path: "private.tex", content: "Private source\n" });
    const candidate = await json(base + "/table-equation-candidates", owner.token, "POST", { kind: "equation", targetPath: "private.tex", sourceFormat: "latex", source: "x=1" });
    const proposalPath = base + "/change-sets/" + candidate.changeSet.id;
    for (const action of ["read", "edit", "run_ai"]) {
      // Permissions can be revoked after the owner generated a proposal.
      const rule = await json(base + "/acl/new", owner.token, "PUT", { pathPrefix: "private.tex", subjectType: "user", subjectId: member.user.id, action, effect: "deny" });
      expect((await request(proposalPath, member.token)).status).toBe(action === "read" ? 403 : 200);
      expect((await request(base + "/table-equation-candidates/" + candidate.changeSet.id + "/compile-check", member.token, "POST")).status).toBe(action === "read" ? 403 : 200);
      expect((await request(proposalPath, member.token, "PATCH", { changes: [{ path: "private.tex", content: "overwrite" }] })).status).toBe(403);
      for (const operation of ["accept", "decide", "finish", "reject", "rollback"])
        expect((await request(proposalPath + "/" + operation, member.token, "POST", { decisions: [] })).status).toBe(403);
      expect((await json(base + "/file?path=private.tex", owner.token)).content).toBe("Private source\n");
      expect((await json(proposalPath, owner.token)).status).toBe("proposed");
      expect((await request(base + "/acl/" + rule.id, owner.token, "DELETE")).status).toBe(204);
    }
    expect((await request(proposalPath)).status).toBe(401);
    expect((await json(proposalPath + "/accept", member.token, "POST")).status).toBe("accepted");
    expect((await json(base + "/file?path=private.tex", owner.token)).content).toContain("x=1");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
