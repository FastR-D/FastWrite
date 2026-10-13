import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApplication } from "../app";

test("authenticated lazy trees retain expandable directories while enforcing path ACLs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-tree-access-"));
  try {
    const app = await createApplication(directory, { features: { serverAuth: true }, bootstrapAdmin: { email: "admin@example.test", password: "test-password-long-enough" } });
    const request = (path: string, token?: string, method = "GET", body?: unknown) => app(new Request("http://test" + path, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }));
    const json = async (path: string, token?: string, method = "GET", body?: unknown) => {
      const response = await request(path, token, method, body);
      expect(response.status).toBeLessThan(300);
      return await response.json() as any;
    };
    const owner = await json("/api/auth/register", undefined, "POST", { email: "owner@example.test", password: "test-password-long-enough" });
    const editor = await json("/api/auth/register", undefined, "POST", { email: "editor@example.test", password: "test-password-long-enough" });
    const project = await json("/api/projects", owner.token, "POST", { name: "Lazy tree" });
    const base = "/api/projects/" + project.id;
    const invite = await json(base + "/invitations", owner.token, "POST", { email: "editor@example.test", role: "editor" });
    await json("/api/invitations/" + invite.token + "/accept", editor.token, "POST");
    for (const path of ["sections/nested/method.tex", "restricted/secret.tex"])
      await json(base + "/files", owner.token, "POST", { path, content: "Test source" });
    await json(base + "/acl/new", owner.token, "PUT", { pathPrefix: "restricted", subjectType: "user", subjectId: editor.user.id, action: "read", effect: "deny" });
    const root = await json(base + "/files?directory=", editor.token);
    expect(root.find((node: any) => node.path === "sections")).toMatchObject({ type: "directory", loaded: false, children: [] });
    expect(root.some((node: any) => node.path === "restricted")).toBe(false);
    const sections = await json(base + "/files?directory=sections", editor.token);
    expect(sections[0]).toMatchObject({ path: "sections/nested", loaded: false, children: [] });
    expect((await json(base + "/files?directory=sections/nested", editor.token))[0].path).toBe("sections/nested/method.tex");
    expect((await request(base + "/files?directory=restricted", editor.token)).status).toBe(403);
    expect((await json(base + "/files?directory=", owner.token)).some((node: any) => node.path === "restricted")).toBe(true);
    expect((await request(base + "/files?directory=")).status).toBe(401);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
