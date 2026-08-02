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
  private readonly queues = new Map<string, Promise<void>>();

  async snapshot(projectDirectory: string, workspaceRoot: string, message: string): Promise<void> {
    const key = projectDirectory;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.snapshotNow(projectDirectory, workspaceRoot, message));
    this.queues.set(key, next);
    try {
      await next;
    } finally {
      if (this.queues.get(key) === next) this.queues.delete(key);
    }
  }

  private async snapshotNow(projectDirectory: string, workspaceRoot: string, message: string): Promise<void> {
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
    if (changed === 0) return;
    await runGit([...context, "commit", "--quiet", "-m", message]);
  }
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
