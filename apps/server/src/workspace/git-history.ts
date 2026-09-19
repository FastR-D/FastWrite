import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HistoryCommit, HistorySummary, HistoryPage, HistoryTreeEntry, HistoryFileSide, HistoryComparison, HistoryChangedFile, HistoryChanges, WorkingStatus } from "@fastwrite/shared";
import { ApiError } from "../http";
import { resolveWorkspacePath } from "./path";
import { parseWorkingStatus } from "./working-status";

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

  /**
   * The persistent index, created from HEAD the first time it is needed.
   *
   * `read-tree` OVERWRITES the index, so this must run only when the file is
   * absent — running it against a populated index would silently discard
   * everything the user had staged. The index's own existence is the flag; no
   * separate marker is stored, because a marker could drift out of step with the
   * file it describes.
   *
   * A repository with no commits yet has no HEAD to read, so an unborn HEAD
   * falls back to an empty tree.
   */
  private async ensureIndex(projectDirectory: string, workspaceRoot: string): Promise<void> {
    await this.ensureRepository(projectDirectory);
    const context = [`--git-dir=${join(projectDirectory, "history.git")}`, `--work-tree=${workspaceRoot}`];
    if (await exists(join(projectDirectory, "history.git", "index"))) return;
    if ((await runGit([...context, "rev-parse", "--verify", "--quiet", "HEAD"], [0, 1])) === 0) {
      await runGit([...context, "read-tree", "HEAD"]);
    } else {
      await runGit([...context, "read-tree", "--empty"]);
    }
  }

  /**
   * Everything the sidebar shows, from one `git status`.
   *
   * Porcelain v2's XY is exactly the split the UI needs — X is index-vs-HEAD,
   * Y is worktree-vs-index — so the two groups cost one invocation rather than
   * two diffs. `--branch` adds HEAD to the same output.
   */
  async workingStatus(projectDirectory: string, workspaceRoot: string): Promise<WorkingStatus> {
    await this.ensureIndex(projectDirectory, workspaceRoot);
    const context = [`--git-dir=${join(projectDirectory, "history.git")}`, `--work-tree=${workspaceRoot}`];
    const output = await runGitOutput([...context, "status", "--porcelain=v2", "--branch", "-z"]);
    return parseWorkingStatus(output);
  }

  /**
   * Rejects a path list that is empty or escapes the workspace.
   *
   * Empty is not a trivial case: `git add` with no pathspec stages the whole
   * tree, and the equivalent discard would delete it. A frontend bug passing
   * `[]` instead of `[path]` must fail loudly here rather than quietly
   * destroying work.
   */
  private safePaths(workspaceRoot: string, paths: string[]): string[] {
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new ApiError(400, "history_paths_required", "At least one path is required");
    }
    return paths.map((path) => resolveWorkspacePath(workspaceRoot, path).relativePath);
  }

  /** Records worktree content in the index, so the next commit includes it. */
  async stage(projectDirectory: string, workspaceRoot: string, paths: string[]): Promise<void> {
    const safe = this.safePaths(workspaceRoot, paths);
    await this.ensureIndex(projectDirectory, workspaceRoot);
    const context = [`--git-dir=${join(projectDirectory, "history.git")}`, `--work-tree=${workspaceRoot}`, "--literal-pathspecs"];
    await runGit([...context, "add", "--", ...safe]);
  }

  /**
   * Stages a file's removal — the `git rm` that a discard of a staged deletion
   * has to undo. Kept separate from `stage` because `git add` on a deleted path
   * stages the deletion only with `-A`, and relying on that flag would make
   * `stage` do something surprising for a path the caller expects to exist.
   */
  async stageRemoval(projectDirectory: string, workspaceRoot: string, paths: string[]): Promise<void> {
    const safe = this.safePaths(workspaceRoot, paths);
    await this.ensureIndex(projectDirectory, workspaceRoot);
    const context = [`--git-dir=${join(projectDirectory, "history.git")}`, `--work-tree=${workspaceRoot}`, "--literal-pathspecs"];
    await runGit([...context, "rm", "--quiet", "--", ...safe]);
  }

  /**
   * Removes files from the index without touching the working tree.
   *
   * `git restore --staged` needs a HEAD to restore from, and a repository whose
   * first commit has not happened yet has none. There `rm --cached` is the
   * equivalent — the file returns to being untracked, which is what unstaging
   * means before any commit exists.
   */
  async unstage(projectDirectory: string, workspaceRoot: string, paths: string[]): Promise<void> {
    const safe = this.safePaths(workspaceRoot, paths);
    await this.ensureIndex(projectDirectory, workspaceRoot);
    const context = [`--git-dir=${join(projectDirectory, "history.git")}`, `--work-tree=${workspaceRoot}`, "--literal-pathspecs"];
    const hasHead = (await runGit([...context, "rev-parse", "--verify", "--quiet", "HEAD"], [0, 1])) === 0;
    if (hasHead) await runGit([...context, "restore", "--staged", "--", ...safe]);
    else await runGit([...context, "rm", "--cached", "-r", "--quiet", "--", ...safe]);
  }

  /**
   * Discards worktree changes. THE ONLY DESTRUCTIVE OPERATION HERE.
   *
   * Tracked files are restored from the index, so a mistake is recoverable by
   * re-running the edit. Untracked files are DELETED and cannot be recovered —
   * callers must confirm before reaching this for one.
   *
   * A conflicted file is refused: `restore` has no meaningful answer for an
   * unmerged path, and silently picking a side is worse than saying no.
   */
  async discard(projectDirectory: string, workspaceRoot: string, paths: string[]): Promise<void> {
    const safe = this.safePaths(workspaceRoot, paths);
    await this.ensureIndex(projectDirectory, workspaceRoot);
    const status = await this.workingStatus(projectDirectory, workspaceRoot);
    const byPath = new Map(status.files.map((file) => [file.path, file]));

    const conflicted = safe.filter((path) => byPath.get(path)?.conflicted);
    if (conflicted.length) {
      throw new ApiError(409, "history_file_conflicted", `Resolve the conflict before discarding: ${conflicted.join(", ")}`);
    }

    const context = [`--git-dir=${join(projectDirectory, "history.git")}`, `--work-tree=${workspaceRoot}`, "--literal-pathspecs"];
    const untracked = safe.filter((path) => byPath.get(path)?.untracked);
    const tracked = safe.filter((path) => !byPath.get(path)?.untracked);

    /*
     * A staged deletion has to be restored from HEAD, not from the index: the
     * index no longer holds the entry, so `restore --worktree` matches no
     * pathspec and fails with "pathspec did not match any file(s) known to git".
     * The file is not recovered. Every other tracked file restores from the
     * index, which is what makes a discard undo the worktree edit while keeping
     * what the user staged.
     *
     * The two groups go in SEPARATE invocations. Measured: one non-matching path
     * aborts the whole `restore`, so a mixed call restores none of them — the
     * ordinary files would silently keep their modifications while the caller
     * reported the discard as done.
     */
    const stagedDeletions = tracked.filter((path) => byPath.get(path)?.staged === "D");
    const rest = tracked.filter((path) => byPath.get(path)?.staged !== "D");
    if (rest.length) await runGit([...context, "restore", "--worktree", "--", ...rest]);
    if (stagedDeletions.length) await runGit([...context, "restore", "--source=HEAD", "--worktree", "--", ...stagedDeletions]);
    /*
     * `clean -f` without `-x`, so an ignored file is left alone — that is the
     * safe default. Measured: it also exits 0 with no output when the path is
     * ignored, tracked, or an untracked nested repository, so a clean exit is
     * never proof the file went. Callers re-read status rather than trust it.
     */
    if (untracked.length) await runGit([...context, "clean", "-f", "--", ...untracked]);
  }

  /**
   * Commits the index as it stands.
   *
   * Deliberately does NOT `add -A` first. The whole point of the index is that
   * the user chose what goes in; a commit that stages everything would make
   * their choice meaningless. Callers that want the old snapshot-everything
   * behaviour call `snapshot`, which stages the whole tree first.
   *
   * Refuses an empty commit rather than creating one, because the sidebar's
   * enabled/disabled state is derived from the same status the user sees — a
   * commit that succeeds with nothing staged means those two disagree.
   */
  async commit(projectDirectory: string, workspaceRoot: string, message: string): Promise<string> {
    await this.ensureIndex(projectDirectory, workspaceRoot);
    const context = [`--git-dir=${join(projectDirectory, "history.git")}`, `--work-tree=${workspaceRoot}`];
    if ((await runGit([...context, "diff", "--cached", "--quiet"], [0, 1])) === 0) {
      throw new ApiError(409, "history_nothing_staged", "Nothing is staged to commit");
    }
    await runGit([...context, "commit", "--quiet", "-m", message]);
    return (await runGitOutput([...context, "rev-parse", "HEAD"])).trim();
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

  /**
   * Creates the managed repository if it is not there yet.
   *
   * Every entry point needs this, not just `snapshot`: a project created since
   * the server started has no `history.git` until something writes one, and
   * `git status` against a missing directory fails with a locale-dependent
   * "not a git repository" that the route cannot turn into anything useful.
   *
   * The `info/exclude` file matters as much as the init: it is what keeps
   * engine artifacts out of the status. Without it the sidebar shows build
   * output as untracked, which is not a failure anything would notice.
   */
  private async ensureRepository(projectDirectory: string): Promise<string> {
    const gitDirectory = join(projectDirectory, "history.git");
    if (await exists(gitDirectory)) return gitDirectory;
    await mkdir(projectDirectory, { recursive: true });
    await runGit(["init", "--bare", "--quiet", gitDirectory]);
    await runGit([`--git-dir=${gitDirectory}`, "config", "core.bare", "false"]);
    await runGit([`--git-dir=${gitDirectory}`, "config", "user.name", "FastWrite"]);
    await runGit([`--git-dir=${gitDirectory}`, "config", "user.email", "history@fastwrite.local"]);
    await mkdir(join(gitDirectory, "info"), { recursive: true });
    await writeFile(join(gitDirectory, "info", "exclude"), `${EXCLUDES.join("\n")}\n`, "utf8");
    return gitDirectory;
  }

  private async snapshotNow(projectDirectory: string, workspaceRoot: string, message: string, allowEmpty: boolean): Promise<string | undefined> {
    const gitDirectory = await this.ensureRepository(projectDirectory);

    const context = [`--git-dir=${gitDirectory}`, `--work-tree=${workspaceRoot}`];
    await this.ensureIndex(projectDirectory, workspaceRoot);
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
