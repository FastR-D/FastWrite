import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const EXCLUDES = [
  ".git/",
  ".writeagent/",
  ".fastwrite/",
  "node_modules/",
  "output/",
  "build/",
  "dist/",
  "backup/",
  "backups/",
  "_minted-*/",
  ".DS_Store"
];

export class GitHistory {
  private readonly queues = new Map<string, Promise<string | undefined>>();

  async snapshot(projectDirectory: string, workspaceRoot: string, message: string): Promise<string | undefined> {
    const key = projectDirectory;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.snapshotNow(projectDirectory, workspaceRoot, message));
    this.queues.set(key, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(key) === next) this.queues.delete(key);
    }
  }

  async list(projectDirectory: string, limit = 50): Promise<Array<{ oid: string; message: string; createdAt: string }>> {
    const gitDirectory = join(projectDirectory, "history.git");
    if (!await exists(gitDirectory)) return [];
    const format = "%H%x09%cI%x09%s";
    const output = await runGitOutput([`--git-dir=${gitDirectory}`, "log", `-${Math.max(1, Math.min(limit, 200))}`, `--format=${format}`]);
    return output.trim().split("\n").filter(Boolean).map((line) => {
      const [oid, createdAt, ...message] = line.split("\t");
      return { oid: oid ?? "", createdAt: createdAt ?? "", message: message.join("\t") };
    });
  }

  async summary(projectDirectory: string, oid: string): Promise<{ oid: string; message: string; createdAt: string; paths: string[] }> {
    if (!/^[0-9a-f]{7,64}$/i.test(oid)) throw new Error("Invalid history checkpoint");
    const known = await this.list(projectDirectory, 200);
    const entry = known.find((item) => item.oid === oid || item.oid.startsWith(oid));
    if (!entry) throw new Error("History checkpoint not found");
    return { ...entry, paths: [] };
  }

  async fileAt(projectDirectory: string, oid: string, path: string): Promise<string> {
    if (!/^[0-9a-f]{7,64}$/i.test(oid) || path.includes("..") || path.startsWith("/")) throw new Error("Invalid history file request");
    return runGitOutput([`--git-dir=${join(projectDirectory, "history.git")}`, "show", `${oid}:${path}`]);
  }

  private async snapshotNow(projectDirectory: string, workspaceRoot: string, message: string): Promise<string | undefined> {
    const gitDirectory = join(projectDirectory, "history.git");
    if (!await exists(gitDirectory)) {
      await mkdir(projectDirectory, { recursive: true });
      await runGit(["init", "--bare", "--quiet", gitDirectory]);
      await runGit([`--git-dir=${gitDirectory}`, "config", "core.bare", "false"]);
      await runGit([`--git-dir=${gitDirectory}`, "config", "user.name", "FastWrite"]);
      await runGit([`--git-dir=${gitDirectory}`, "config", "user.email", "history@fastwrite.local"]);
      await mkdir(join(gitDirectory, "info"), { recursive: true });
      await writeFile(join(gitDirectory, "info", "exclude"), `${EXCLUDES.join("\n")}\n`, "utf8");
    }

    const context = [`--git-dir=${gitDirectory}`, `--work-tree=${workspaceRoot}`];
    await runGit([...context, "add", "-A", "--", "."]);
    const changed = await runGit([...context, "diff", "--cached", "--quiet"], [0, 1]);
    if (changed === 0) return undefined;
    await runGit([...context, "commit", "--quiet", "-m", message]);
    return (await runGitOutput([...context, "rev-parse", "HEAD"])).trim();
  }
}

async function runGitOutput(args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  const error = (await new Response(child.stderr).text()).trim();
  if ((await child.exited) !== 0) throw new Error(error || "Git command failed");
  return output;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false);
}

async function runGit(args: string[], allowed = [0]): Promise<number> {
  const child = Bun.spawn(["git", ...args], { stdout: "ignore", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  const exitCode = await child.exited;
  const error = (await stderr).trim();
  if (!allowed.includes(exitCode)) throw Object.assign(new Error(error || `Git exited with status ${exitCode}`), { code: "GIT_HISTORY_FAILED" });
  return exitCode;
}
