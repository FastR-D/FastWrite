import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApplication } from "../app";
import { AuthService } from "../auth/auth-service";
import { JsonDatabase } from "../storage/database";
import { WorkspaceService } from "../workspace/workspace-service";

test("sync conflict resolution and publication enforce current read, edit and sync permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "fastwrite-sync-access-"));
  const remote = join(root, "remote.git"), seed = join(root, "seed"), data = join(root, "data");
  try {
    await mkdir(seed);
    await git(["init", "--bare", "--initial-branch=main", remote]);
    await git(["-C", seed, "init", "--initial-branch=main"]);
    await git(["-C", seed, "config", "user.name", "Fixture"]);
    await git(["-C", seed, "config", "user.email", "fixture@example.test"]);
    await writeFile(join(seed, "main.tex"), "\\documentclass{article}\n\\begin{document}Test\\end{document}\n");
    await writeFile(join(seed, "private.tex"), "Baseline\n");
    await git(["-C", seed, "add", "-A"]); await git(["-C", seed, "commit", "-m", "Baseline"]);
    await git(["-C", seed, "remote", "add", "origin", remote]); await git(["-C", seed, "push", "origin", "main"]);
    const commit = await git(["-C", seed, "rev-parse", "HEAD"]);
    const database = new JsonDatabase(data); await database.initialize();
    const auth = new AuthService(database);
    const owner = await auth.register({ email: "owner@example.test", password: "fixture-password-long-enough" });
    const member = await auth.register({ email: "member@example.test", password: "fixture-password-long-enough" });
    const workspaces = new WorkspaceService(data, database); await workspaces.initialize();
    const project = await workspaces.copyExternalDirectory({ sourceDirectory: seed, name: "Sync permissions", mainDocument: "main.tex", venue: "network-information-security", source: { type: "github", repository: "https://github.com/example/fixture", ref: "main", commit }, owner: { userId: owner.user.id } });
    // From this point only the application's database instance performs writes.
    const app = await createApplication(data, { features: { serverAuth: true }, bootstrapAdmin: { email: "admin@example.test", password: "fixture-password-long-enough" }, githubRemoteResolver: repository => { expect(repository).toBe("https://github.com/example/fixture"); return remote; } });
    const request = (path: string, token: string, method = "GET", body?: unknown) => app(new Request("http://test" + path, { method, headers: { "content-type": "application/json", authorization: "Bearer " + token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const json = async (path: string, token: string, method = "GET", body?: unknown) => { const response = await request(path, token, method, body); expect(response.status).toBeLessThan(300); return await response.json() as any; };
    const base = "/api/projects/" + project.id;
    const invite = await json(base + "/invitations", owner.token, "POST", { email: member.user.emailNormalized, role: "maintainer" });
    await json("/api/invitations/" + invite.token + "/accept", member.token, "POST");
    await json(base + "/file?path=private.tex", owner.token, "PUT", { baseVersion: 1, content: "Local edit\n" });
    await writeFile(join(seed, "private.tex"), "Remote edit\n");
    await git(["-C", seed, "add", "-A"]); await git(["-C", seed, "commit", "-m", "Remote edit"]); await git(["-C", seed, "push", "origin", "main"]);
    const conflicted = await json(base + "/github-sync", owner.token, "POST");
    expect(conflicted.status).toBe("conflicts");
    const syncBase = base + "/github-sync/" + conflicted.id;
    const resolution = { resolutions: [{ path: "private.tex", choice: "edited", content: "Authorized resolution\n" }] };
    for (const action of ["read", "edit", "sync_github"]) {
      const rule = await json(base + "/acl/new", owner.token, "PUT", { pathPrefix: "private.tex", subjectType: "user", subjectId: member.user.id, action, effect: "deny" });
      expect((await request(syncBase + "/resolve", member.token, "POST", resolution)).status).toBe(403);
      expect((await json(base + "/file?path=private.tex", owner.token)).content).toBe("Local edit\n");
      expect((await request(base + "/acl/" + rule.id, owner.token, "DELETE")).status).toBe(204);
    }
    const ready = await json(syncBase + "/resolve", member.token, "POST", resolution);
    expect(ready.status).toBe("ready-to-compile");
    await json(base + "/compile-results", owner.token, "POST", { projectVersion: ready.projectVersion, status: "success", summary: "Isolated fixture" });
    for (const action of ["read", "edit", "sync_github"]) {
      const rule = await json(base + "/acl/new", owner.token, "PUT", { pathPrefix: "private.tex", subjectType: "user", subjectId: member.user.id, action, effect: "deny" });
      expect((await request(syncBase + "/finalize", member.token, "POST")).status).toBe(403);
      expect(await git(["--git-dir", remote, "show", "main:private.tex"])).toBe("Remote edit");
      expect((await request(base + "/acl/" + rule.id, owner.token, "DELETE")).status).toBe(204);
    }
    expect((await json(syncBase + "/finalize", member.token, "POST")).status).toBe("completed");
    expect(await git(["--git-dir", remote, "show", "main:private.tex"])).toBe("Authorized resolution");
    await json(base + "/acl/new", owner.token, "PUT", { pathPrefix: "retired.tex", subjectType: "user", subjectId: member.user.id, action: "sync_github", effect: "deny" });
    expect((await request(base + "/github-sync", member.token, "POST")).status).toBe(403);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

async function git(args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exit !== 0) throw new Error(stderr);
  return stdout.trim();
}
