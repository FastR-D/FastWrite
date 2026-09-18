import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HistoryCommit, HistorySummary, HistoryPage, HistoryTreeEntry, HistoryFileSide, HistoryComparison, HistoryChangedFile, HistoryChanges } from "@fastwrite/shared";
import { ApiError } from "../http";
import { resolveWorkspacePath } from "./path";

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

  async snapshot(projectDirectory: string, workspaceRoot: string, message: string, allowEmpty = false): Promise<string | undefined> {
    const key = projectDirectory;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.snapshotNow(projectDirectory, workspaceRoot, message, allowEmpty));
    this.queues.set(key, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(key) === next) this.queues.delete(key);
    }
  }

  async list(projectDirectory: string, limit = 50): Promise<HistoryCommit[]> {
    return (await this.page(projectDirectory, { limit })).commits;
  }

  async resolveCommit(projectDirectory: string, ref: string): Promise<string> {
    if (!/^[0-9a-f]{7,64}$/i.test(ref)) throw new ApiError(404, "history_checkpoint_not_found", "History checkpoint not found");
    const context = [`--git-dir=${join(projectDirectory, "history.git")}`];
    let oid: string;
    try { oid = (await runGitOutput([...context, "rev-parse", "--verify", `${ref}^{commit}`])).trim(); }
    catch { throw new ApiError(404, "history_checkpoint_not_found", "History checkpoint not found"); }
    if (await runGit([...context, "merge-base", "--is-ancestor", oid, "HEAD"], [0, 1]) !== 0)
      throw new ApiError(404, "history_checkpoint_not_found", "History checkpoint is not reachable from managed history");
    return oid;
  }

  async page(projectDirectory: string, options: { limit?: number; cursor?: string; path?: string } = {}): Promise<HistoryPage> {
    const context = [`--git-dir=${join(projectDirectory, "history.git")}`];
    if (!await exists(join(projectDirectory, "history.git"))) return { commits: [], nextCursor: null };
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50) || 50));
    const path = options.path ? historyPath(options.path) : undefined;
    let head: string;
    let skip = 0;
    if (options.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
        if (typeof cursor.head !== "string" || !Number.isSafeInteger(cursor.skip) || cursor.skip < 0 || cursor.path !== (path ?? null)) throw new Error();
        head = await this.resolveCommit(projectDirectory, cursor.head);
        skip = cursor.skip;
      } catch { throw new ApiError(400, "history_cursor_invalid", "Invalid history pagination cursor"); }
    } else {
      const hasHead = await runGit([...context, "rev-parse", "--verify", "HEAD"], [0, 128]);
      if (hasHead !== 0) return { commits: [], nextCursor: null };
      head = (await runGitOutput([...context, "rev-parse", "HEAD"])).trim();
    }
    const output = await runGitOutput([...context, "--literal-pathspecs", "log", head, `--max-count=${limit + 1}`, `--skip=${skip}`, "-z", "--format=%H%x00%P%x00%cI%x00%s", ...(path ? ["--", path] : [])]);
    const commits = parseCommits(output);
    return { commits: commits.slice(0, limit), nextCursor: commits.length > limit ? Buffer.from(JSON.stringify({ head, skip: skip + limit, path: path ?? null })).toString("base64url") : null };
  }

  async summary(projectDirectory: string, ref: string): Promise<HistorySummary> {
    const oid = await this.resolveCommit(projectDirectory, ref);
    const context = [`--git-dir=${join(projectDirectory, "history.git")}`];
    const entry = parseCommits(await runGitOutput([...context, "show", "-s", "-z", "--format=%H%x00%P%x00%cI%x00%s", oid]))[0]!;
    const files = await this.changedFiles(context, entry.parentOids[0] ? [entry.parentOids[0], oid] : [oid]);
    return { ...entry, paths: files.map(file => file.path), files };
  }

  async changes(projectDirectory: string, baseRef: string, targetRef: string): Promise<HistoryChanges> {
    const [base, target] = await Promise.all([this.resolveCommit(projectDirectory, baseRef), this.resolveCommit(projectDirectory, targetRef)]);
    const files = await this.changedFiles([`--git-dir=${join(projectDirectory, "history.git")}`], [base, target]);
    return { baseRef: base, targetRef: target, files };
  }

  /** Builds an isolated index. Reading changes never rewrites managed history's index or HEAD. */
  async workingChanges(projectDirectory: string, workspaceRoot: string, baseRef: string) {
    const base = await this.resolveCommit(projectDirectory, baseRef);
    const snapshotId = await this.workingTree(projectDirectory, workspaceRoot);
    const files = await this.changedFiles([`--git-dir=${join(projectDirectory, "history.git")}`], [base, snapshotId]);
    return { baseRef: base, snapshotId, files };
  }

  async workingComparison(projectDirectory: string, workspaceRoot: string, baseRef: string, requestedPath: string, oldPath?: string) {
    const path = historyPath(requestedPath);
    const original = await this.side(projectDirectory, baseRef, oldPath ?? path);
    const snapshotId = await this.workingTree(projectDirectory, workspaceRoot);
    const context = [`--git-dir=${join(projectDirectory, "history.git")}`, "--literal-pathspecs"];
    const output = await runGitOutput([...context, "ls-tree", "-r", "-l", "-z", snapshotId, "--", path]);
    const record = output.split("\0").find(record => record.slice(record.indexOf("\t") + 1) === path);
    let modified: HistoryFileSide = { ref: "working-tree", path, exists: false, binary: false, size: 0 };
    if (record) {
      const [, type, blob, size] = record.slice(0, record.indexOf("\t")).trim().split(/\s+/);
      if (type === "blob") {
        const bytes = await runGitBytes([...context, "cat-file", "blob", blob!]);
        let content: string | undefined;
        try { if (!bytes.includes(0)) content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { /* Keep binary metadata. */ }
        modified = { ref: "working-tree", path, exists: true, binary: content === undefined, size: Number(size), ...(content === undefined ? {} : { content }) };
      }
    }
    return { original, modified, snapshotId };
  }

  private async workingTree(projectDirectory: string, workspaceRoot: string) {
    const directory = await mkdtemp(join(tmpdir(), "fastwrite-history-index-"));
    try {
      const environment = { ...process.env, GIT_INDEX_FILE: join(directory, "index") };
      const context = [`--git-dir=${join(projectDirectory, "history.git")}`, `--work-tree=${workspaceRoot}`];
      await runGitOutput([...context, "read-tree", "HEAD"], environment);
      await runGitOutput([...context, "add", "-A", "--", "."], environment);
      return (await runGitOutput([...context, "write-tree"], environment)).trim();
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  private async changedFiles(context: string[], refs: string[]): Promise<HistoryChangedFile[]> {
    const args = [...context, "diff-tree", "--root", "--no-commit-id", "-r", "-M", "--no-ext-diff", "--no-textconv"];
    const [names, stats] = await Promise.all([
      runGitOutput([...args, "--name-status", "-z", ...refs, "--"]),
      runGitOutput([...args, "--numstat", "-z", ...refs, "--"]),
    ]);
    const statistics = new Map<string, { binary: boolean; additions: number | null; deletions: number | null }>();
    const counts = stats.split("\0");
    for (let index = 0; index < counts.length && counts[index]; index++) {
      const record = counts[index]!;
      const first = record.indexOf("\t"), second = record.indexOf("\t", first + 1);
      const added = record.slice(0, first), removed = record.slice(first + 1, second);
      let path = record.slice(second + 1);
      if (!path) { index++; path = counts[++index]!; }
      statistics.set(path, { binary: added === "-", additions: added === "-" ? null : Number(added), deletions: removed === "-" ? null : Number(removed) });
    }
    const tokens = names.split("\0");
    const files: HistoryChangedFile[] = [];
    for (let index = 0; index < tokens.length && tokens[index];) {
      const status = tokens[index++]!.charAt(0) as HistoryChangedFile["status"];
      const firstPath = tokens[index++]!;
      const path = status === "R" ? tokens[index++]! : firstPath;
      files.push({ path, ...(status === "R" ? { oldPath: firstPath } : {}), status, ...(statistics.get(path) ?? { binary: false, additions: null, deletions: null }) });
    }
    return files;
  }

  async tree(projectDirectory: string, ref: string): Promise<HistoryTreeEntry[]> {
    const oid = await this.resolveCommit(projectDirectory, ref);
    const output = await runGitOutput([`--git-dir=${join(projectDirectory, "history.git")}`, "ls-tree", "-r", "-l", "-z", oid]);
    return output.split("\0").filter(Boolean).flatMap(record => {
      const boundary = record.indexOf("\t");
      const [mode, type, blobOid, size] = record.slice(0, boundary).trim().split(/\s+/);
      return type === "blob" ? [{ path: record.slice(boundary + 1), oid: blobOid!, mode: mode!, size: Number(size) }] : [];
    });
  }

  async side(projectDirectory: string, ref: string, requestedPath: string): Promise<HistoryFileSide> {
    const path = historyPath(requestedPath);
    if (ref === "empty") return { ref: "empty", path, exists: false, binary: false, size: 0 };
    const oid = await this.resolveCommit(projectDirectory, ref);
    const entry = (await this.tree(projectDirectory, oid)).find(item => item.path === path);
    if (!entry) return { ref: oid, path, exists: false, binary: false, size: 0 };
    const bytes = await runGitBytes([`--git-dir=${join(projectDirectory, "history.git")}`, "cat-file", "blob", entry.oid]);
    let content: string | undefined;
    try { if (!bytes.includes(0)) content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { /* Binary is represented by metadata. */ }
    return { ref: oid, path, exists: true, binary: content === undefined, size: bytes.length, ...(content !== undefined ? { content } : {}) };
  }

  async compare(projectDirectory: string, baseRef: string, targetRef: string, path: string, oldPath = path): Promise<HistoryComparison> {
    const [original, modified] = await Promise.all([this.side(projectDirectory, baseRef, oldPath), this.side(projectDirectory, targetRef, path)]);
    return { original, modified };
  }

  async fileAt(projectDirectory: string, oid: string, path: string): Promise<string> {
    const side = await this.side(projectDirectory, oid, path);
    if (!side.exists) throw new ApiError(404, "history_file_not_found", "File does not exist at this checkpoint");
    if (side.binary) throw new ApiError(415, "history_binary_file", "This history file is binary");
    return side.content!;
  }

  private async snapshotNow(projectDirectory: string, workspaceRoot: string, message: string, allowEmpty: boolean): Promise<string | undefined> {
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
    if (changed === 0 && !allowEmpty) return undefined;
    await runGit([...context, "commit", "--quiet", ...(allowEmpty ? ["--allow-empty"] : []), "-m", message]);
    return (await runGitOutput([...context, "rev-parse", "HEAD"])).trim();
  }
}

async function runGitOutput(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe", ...(env ? { env } : {}) });
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

function historyPath(path: string): string {
  return resolveWorkspacePath("/history", path).relativePath;
}
function parseCommits(output: string): HistoryCommit[] {
  const tokens = output.split("\0");
  const commits: HistoryCommit[] = [];
  for (let index = 0; index + 3 < tokens.length; index += 4) {
    const oid = tokens[index]!.trim();
    if (!oid) continue;
    const message = tokens[index + 3]!;
    commits.push({ oid, parentOids: tokens[index + 1]!.split(" ").filter(Boolean), createdAt: tokens[index + 2]!, message,
      source: message === "Manual checkpoint" ? "manual" : /^Auto|^Save /.test(message) ? "automatic" : "system" });
  }
  return commits;
}
async function runGitBytes(args: string[]): Promise<Uint8Array> {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [output, error, status] = await Promise.all([new Response(child.stdout).arrayBuffer().then(buffer => new Uint8Array(buffer)), new Response(child.stderr).text(), child.exited]);
  if (status !== 0) throw new Error(error || "Git command failed");
  return output;
}
