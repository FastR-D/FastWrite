import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApplication } from "../app";

test("completion and revision use only authorized adjacent sources and bibliography", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-ai-context-"));
  const inputs: unknown[] = [];
  try {
    const app = await createApplication(directory, {
      features: { serverAuth: true }, bootstrapAdmin: { email: "admin@example.test", password: "fixture-password-long-enough" },
      agentProvider: {
        revise: async input => { inputs.push(input); return { replacement: "Improved sentence.", rationale: "Fixture" }; },
        complete: async input => { inputs.push(input); return { suggestion: "Safe completion." }; }
      }
    });
    const request = (path: string, token?: string, method = "GET", body?: unknown) => app(new Request("http://test" + path, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }));
    const json = async (path: string, token?: string, method = "GET", body?: unknown) => {
      const response = await request(path, token, method, body); expect(response.status).toBeLessThan(300); return await response.json() as any;
    };
    const owner = await json("/api/auth/register", undefined, "POST", { email: "owner@example.test", password: "fixture-password-long-enough" });
    const member = await json("/api/auth/register", undefined, "POST", { email: "member@example.test", password: "fixture-password-long-enough" });
    const project = await json("/api/projects", owner.token, "POST", { name: "AI context permissions" });
    const base = "/api/projects/" + project.id;
    const invite = await json(base + "/invitations", owner.token, "POST", { email: "member@example.test", role: "editor" });
    await json("/api/invitations/" + invite.token + "/accept", member.token, "POST");
    const source = "\\section{Public}\nOriginal sentence.\n\\input{private/secret}\n";
    await json(base + "/file?path=main.tex", owner.token, "PUT", { content: source, baseVersion: 1 });
    for (const [path, content] of [
      ["private/secret.tex", "\\section{SECRET_HEADING}\nSECRET_ADJACENT_SOURCE"],
      ["private/secret.bib", "@misc{secret, title={SECRET_BIBLIOGRAPHY}}"],
      ["public.bib", "@misc{public, title={PUBLIC_BIBLIOGRAPHY}}"]
    ]) await json(base + "/files", owner.token, "POST", { path, content });
    const from = source.indexOf("Original sentence.");
    const revise = { instruction: "Improve this", selection: { path: "main.tex", text: "Original sentence.", from, to: from + 18, startLine: 2, endLine: 2, fileVersion: 2 } };
    const complete = { path: "main.tex", cursor: from, fileVersion: 2, kind: "auto" };
    for (const action of ["read", "run_ai"]) {
      const rule = await json(base + "/acl/new", owner.token, "PUT", { pathPrefix: "private", subjectType: "user", subjectId: member.user.id, action, effect: "deny" });
      await json(base + "/completions", member.token, "POST", complete);
      expect(JSON.stringify(inputs.at(-1))).toContain("PUBLIC_BIBLIOGRAPHY");
      expect(JSON.stringify(inputs.at(-1))).not.toContain("SECRET_");
      expect((inputs.at(-1) as any).paperContext).toBeUndefined();
      await json(base + "/revisions", member.token, "POST", revise);
      expect(JSON.stringify(inputs.at(-1))).not.toContain("SECRET_");
      expect((inputs.at(-1) as any).paperContext).toBeUndefined();
      expect((await request(base + "/acl/" + rule.id, owner.token, "DELETE")).status).toBe(204);
    }
    await json(base + "/completions", owner.token, "POST", complete);
    expect(JSON.stringify(inputs.at(-1))).toContain("SECRET_BIBLIOGRAPHY");
    await json(base + "/revisions", owner.token, "POST", revise);
    expect(JSON.stringify(inputs.at(-1))).toContain("SECRET_ADJACENT_SOURCE");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
