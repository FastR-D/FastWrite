import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { GithubSyncConflict, GithubSyncResolution, GithubSyncRun, PaperProject } from "@fastwrite/shared";
import { isIgnoredWorkspacePath } from "@fastwrite/shared";
import { ApiError } from "../http";
import { cleanGitError, githubGitEnvironment, parseGithubRepository } from "../imports/github-service";
import type { JsonDatabase } from "../storage/database";
import type { WorkspaceService } from "../workspace/workspace-service";

const MAX_EDITABLE_CONFLICT_BYTES = 400_000;

type RemoteResolver = (repository: string) => string;

export class GithubSyncService {
  private readonly syncRoot: string;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    dataDirectory: string,
    private readonly database: JsonDatabase,
    private readonly workspaces: WorkspaceService,
    private readonly remoteResolver: RemoteResolver = (repository) => parseGithubRepository(repository).cloneUrl
  ) {
    this.syncRoot = join(dataDirectory, "github-sync");
  }

  async start(projectId: string): Promise<GithubSyncRun> {
    return this.serialized(projectId, () => this.startNow(projectId));
  }

  async resolve(projectId: string, runId: string, resolutions: GithubSyncResolution[]): Promise<GithubSyncRun> {
    return this.serialized(projectId, () => this.resolveNow(projectId, runId, resolutions));
  }

  async finalize(projectId: string, runId: string): Promise<GithubSyncRun> {
    return this.serialized(projectId, () => this.finalizeNow(projectId, runId));
  }

  private async startNow(projectId: string): Promise<GithubSyncRun> {
    const project = this.githubProject(projectId);
    await this.workspaces.createSyncCheckpoint(projectId);
    await this.discardOpenRuns(projectId);
    const id = `sync_${crypto.randomUUID()}`;
    const timestamp = now();
    let run: GithubSyncRun = {
      id,
      projectId,
      status: "failed",
      repository: project.source.repository,
      branch: project.source.ref,
      baseCommit: project.source.commit,
      remoteCommit: project.source.commit,
      hasChangesToPush: false,
      conflicts: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.saveRun(run);

    try {
      const runDirectory = this.runDirectory(id);
      const repositoryDirectory = this.repositoryDirectory(id);
      await rm(runDirectory, { recursive: true, force: true });
      await mkdir(runDirectory, { recursive: true });
      const remote = this.remoteResolver(project.source.repository);
      await git(["clone", "--no-checkout", "--origin", "origin", "--", remote, repositoryDirectory]);
      await configureIdentity(repositoryDirectory);

      const branch = await resolveBranch(repositoryDirectory, project.source.ref);
      const remoteCommit = await revision(repositoryDirectory, `refs/remotes/origin/${branch}`);
      await ensureRevision(repositoryDirectory, project.source.commit);
      run = { ...run, branch, remoteCommit, updatedAt: now() };
      await this.saveRun(run);

      await git(["-C", repositoryDirectory, "checkout", "--quiet", "--detach", project.source.commit]);
      await clearWorkingTree(repositoryDirectory);
      await copyManagedTree(this.workspaces.workspaceRoot(projectId), repositoryDirectory, repositoryDirectory);
      await git(["-C", repositoryDirectory, "add", "-A", "--", "."]);
      const localChanged = (await git(["-C", repositoryDirectory, "diff", "--cached", "--quiet", project.source.commit], [0, 1])).exitCode === 1;
      let localCommit = project.source.commit;
      if (localChanged) {
        await git(["-C", repositoryDirectory, "commit", "--quiet", "-m", "FastWrite local sync snapshot"]);
        localCommit = await revision(repositoryDirectory, "HEAD");
      }

      if (localCommit === project.source.commit && remoteCommit !== project.source.commit) {
        await git(["-C", repositoryDirectory, "reset", "--quiet", "--hard", remoteCommit]);
      } else if (localCommit !== project.source.commit && remoteCommit !== project.source.commit) {
        const merge = await git(["-C", repositoryDirectory, "merge", "--no-commit", "--no-ff", remoteCommit], [0, 1]);
        if (merge.exitCode === 1) {
          const conflicts = await readConflicts(repositoryDirectory);
          if (conflicts.length === 0) throw new ApiError(409, "github_sync_merge_failed", cleanGitError(merge.stderr));
          run = { ...run, status: "conflicts", conflicts, updatedAt: now() };
          await this.saveRun(run);
          return run;
        }
      }

      return this.prepareMergedRun(run);
    } catch (error) {
      run = { ...run, status: "failed", error: errorMessage(error), updatedAt: now() };
      await this.saveRun(run);
      await rm(this.runDirectory(run.id), { recursive: true, force: true }).catch(() => undefined);
      throw error instanceof ApiError ? error : new ApiError(502, "github_sync_failed", run.error ?? "GitHub sync failed");
    }
  }

  private async resolveNow(projectId: string, runId: string, resolutions: GithubSyncResolution[]): Promise<GithubSyncRun> {
    let run = this.getRun(projectId, runId);
    if (run.status !== "conflicts") throw new ApiError(409, "github_sync_not_waiting", "This Sync is not waiting for conflict resolution");
    const byPath = new Map(resolutions.map((resolution) => [resolution.path, resolution]));
    if (byPath.size !== run.conflicts.length || run.conflicts.some((conflict) => !byPath.has(conflict.path))) {
      throw new ApiError(400, "github_sync_incomplete_resolution", "Resolve every conflict before continuing Sync");
    }
    if (resolutions.some((resolution) => !["fastwrite", "github", "edited"].includes(resolution.choice))) {
      throw new ApiError(400, "github_sync_invalid_resolution", "Choose an explicit conflict resolution before continuing Sync");
    }

    const repositoryDirectory = this.repositoryDirectory(runId);
    for (const conflict of run.conflicts) {
      const resolution = byPath.get(conflict.path)!;
      if (!run.conflicts.some((candidate) => candidate.path === resolution.path)) throw new ApiError(400, "github_sync_unknown_conflict", "A conflict path is not part of this Sync");
      if (resolution.choice === "edited") {
        if (conflict.kind !== "text" || typeof resolution.content !== "string") throw new ApiError(400, "github_sync_invalid_edit", "Only text conflicts can use an edited result");
        const destination = join(repositoryDirectory, conflict.path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, resolution.content, "utf8");
      } else {
        const stage = resolution.choice === "fastwrite" ? 2 : 3;
        const content = await indexBlob(repositoryDirectory, stage, conflict.path);
        const destination = join(repositoryDirectory, conflict.path);
        if (content === null) await rm(destination, { recursive: true, force: true });
        else {
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, content);
        }
      }
      await git(["-C", repositoryDirectory, "add", "-A", "--", conflict.path]);
    }
    const remaining = (await git(["-C", repositoryDirectory, "diff", "--name-only", "--diff-filter=U"])).stdout.trim();
    if (remaining) throw new ApiError(409, "github_sync_unresolved", "Some GitHub conflicts are still unresolved");
    run = { ...run, conflicts: [], updatedAt: now() };
    await this.saveRun(run);
    return this.prepareMergedRun(run);
  }

  private async prepareMergedRun(run: GithubSyncRun): Promise<GithubSyncRun> {
    const repositoryDirectory = this.repositoryDirectory(run.id);
    await git(["-C", repositoryDirectory, "add", "-A", "--", "."]);
    const mergedTree = (await git(["-C", repositoryDirectory, "write-tree"])).stdout.trim();
    const remoteTree = await revision(repositoryDirectory, `${run.remoteCommit}^{tree}`);
    const before = this.workspaces.getProject(run.projectId);
    const project = await this.workspaces.applyGithubSyncTree(run.projectId, repositoryDirectory);
    const hasChangesToPush = mergedTree !== remoteTree;
    if (project.version === before.version && !hasChangesToPush) {
      await this.workspaces.updateGithubSyncSource(run.projectId, run.branch, run.remoteCommit);
      const completed = { ...run, status: "completed" as const, projectVersion: project.version, hasChangesToPush: false, conflicts: [], updatedAt: now() };
      await this.saveRun(completed);
      await rm(this.runDirectory(run.id), { recursive: true, force: true }).catch(() => undefined);
      return completed;
    }
    const ready = { ...run, status: "ready-to-compile" as const, projectVersion: project.version, hasChangesToPush, conflicts: [], updatedAt: now() };
    await this.saveRun(ready);
    return ready;
  }

  private async finalizeNow(projectId: string, runId: string): Promise<GithubSyncRun> {
    let run = this.getRun(projectId, runId);
    if (run.status !== "ready-to-compile" || run.projectVersion === undefined) throw new ApiError(409, "github_sync_not_ready", "Compile the merged paper before finishing Sync");
    if (this.workspaces.getProject(projectId).version !== run.projectVersion) throw new ApiError(409, "github_sync_workspace_changed", "The paper changed during Sync. Run Sync again so the new edits are included");
    const compiled = this.database.snapshot().compileRecords.some((record) => record.projectId === projectId && record.projectVersion === run.projectVersion && record.status === "success" && record.createdAt >= run.updatedAt);
    if (!compiled) throw new ApiError(409, "github_sync_compile_required", "A successful compile of the merged paper is required before Sync can continue");

    const project = this.githubProject(projectId);
    const remote = this.remoteResolver(project.source.repository);
    const observedRemote = await remoteHead(remote, run.branch);
    if (observedRemote !== run.remoteCommit) {
      run = { ...run, status: "remote-changed", error: "GitHub changed during Sync. Run Sync again to merge the new commit.", updatedAt: now() };
      await this.saveRun(run);
      await rm(this.runDirectory(run.id), { recursive: true, force: true }).catch(() => undefined);
      return run;
    }

    const repositoryDirectory = this.repositoryDirectory(runId);
    const mergedTree = (await git(["-C", repositoryDirectory, "write-tree"])).stdout.trim();
    const remoteTree = await revision(repositoryDirectory, `${run.remoteCommit}^{tree}`);
    let syncedCommit = run.remoteCommit;
    if (mergedTree !== remoteTree) {
      syncedCommit = (await git(["-C", repositoryDirectory, "commit-tree", mergedTree, "-p", run.remoteCommit, "-m", "Sync from FastWrite"])).stdout.trim();
      try {
        await git(["-C", repositoryDirectory, "push", "--porcelain", "origin", `${syncedCommit}:refs/heads/${run.branch}`]);
      } catch (error) {
        const message = errorMessage(error);
        if (!/non-fast-forward|fetch first|rejected/i.test(message)) {
          run = { ...run, status: "failed", error: message, updatedAt: now() };
          await this.saveRun(run);
          await rm(this.runDirectory(run.id), { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
        run = { ...run, status: "remote-changed", error: "GitHub changed before FastWrite could finish. Run Sync again; no force-push was attempted.", updatedAt: now() };
        await this.saveRun(run);
        await rm(this.runDirectory(run.id), { recursive: true, force: true }).catch(() => undefined);
        return run;
      }
    }
    await this.workspaces.updateGithubSyncSource(projectId, run.branch, syncedCommit);
    await this.workspaces.createSyncCheckpoint(projectId);
    const { error: _error, pushedCommit: _previousCommit, ...completedRun } = run;
    run = { ...completedRun, status: "completed", ...(mergedTree === remoteTree ? {} : { pushedCommit: syncedCommit }), updatedAt: now() };
    await this.saveRun(run);
    await rm(this.runDirectory(run.id), { recursive: true, force: true }).catch(() => undefined);
    return run;
  }

  private githubProject(projectId: string): PaperProject & { source: Extract<PaperProject["source"], { type: "github" }> } {
    const project = this.workspaces.getProject(projectId);
    if (project.source.type !== "github") throw new ApiError(409, "github_sync_unavailable", "Only papers imported from GitHub can use Sync");
    return project as PaperProject & { source: Extract<PaperProject["source"], { type: "github" }> };
  }

  private getRun(projectId: string, runId: string): GithubSyncRun {
    const run = this.database.snapshot().githubSyncRuns.find((candidate) => candidate.id === runId && candidate.projectId === projectId);
    if (!run) throw new ApiError(404, "github_sync_not_found", "Sync run not found");
    return run;
  }

  private async saveRun(run: GithubSyncRun): Promise<void> {
    await this.database.mutate((state) => {
      const index = state.githubSyncRuns.findIndex((candidate) => candidate.id === run.id);
      if (index >= 0) state.githubSyncRuns[index] = run;
      else state.githubSyncRuns.push(run);
    });
  }

  private async discardOpenRuns(projectId: string): Promise<void> {
    const openStatuses = new Set<GithubSyncRun["status"]>(["conflicts", "ready-to-compile"]);
    const openRuns = this.database.snapshot().githubSyncRuns.filter((run) => run.projectId === projectId && openStatuses.has(run.status));
    if (openRuns.length === 0) return;
    const timestamp = now();
    await this.database.mutate((state) => {
      for (const run of state.githubSyncRuns) {
        if (run.projectId === projectId && openStatuses.has(run.status)) {
          run.status = "failed";
          run.error = "Superseded by a newer Sync";
          run.updatedAt = timestamp;
        }
      }
    });
    await Promise.all(openRuns.map((run) => rm(this.runDirectory(run.id), { recursive: true, force: true }).catch(() => undefined)));
  }

  private runDirectory(runId: string): string { return join(this.syncRoot, runId); }
  private repositoryDirectory(runId: string): string { return join(this.runDirectory(runId), "repository"); }

  private async serialized<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.queues.set(projectId, next);
    try { return await next; }
    finally { if (this.queues.get(projectId) === next) this.queues.delete(projectId); }
  }
}

interface GitResult { exitCode: number; stdout: string; stderr: string }

async function git(args: string[], allowedExitCodes = [0]): Promise<GitResult> {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe", env: githubGitEnvironment() });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (!allowedExitCodes.includes(exitCode)) throw new ApiError(502, "github_git_failed", cleanGitError(stderr));
  return { exitCode, stdout, stderr };
}

async function gitBytes(args: string[], allowedExitCodes = [0]): Promise<{ exitCode: number; bytes: Uint8Array; stderr: string }> {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe", env: githubGitEnvironment() });
  const [buffer, stderr, exitCode] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
  if (!allowedExitCodes.includes(exitCode)) throw new ApiError(502, "github_git_failed", cleanGitError(stderr));
  return { exitCode, bytes: new Uint8Array(buffer), stderr };
}

async function configureIdentity(repositoryDirectory: string): Promise<void> {
  await git(["-C", repositoryDirectory, "config", "user.name", "FastWrite"]);
  await git(["-C", repositoryDirectory, "config", "user.email", "sync@fastwrite.local"]);
}

async function resolveBranch(repositoryDirectory: string, requestedRef: string): Promise<string> {
  if (requestedRef !== "HEAD" && /^[\w./-]{1,200}$/.test(requestedRef) && !requestedRef.startsWith("-") && !requestedRef.includes("..") && !requestedRef.includes("@{")) {
    const exists = await git(["-C", repositoryDirectory, "rev-parse", "--verify", `refs/remotes/origin/${requestedRef}`], [0, 128]);
    if (exists.exitCode === 0) return requestedRef;
  }
  if (requestedRef !== "HEAD") throw new ApiError(409, "github_sync_branch_required", "Sync requires a GitHub branch; the imported ref is a tag or commit");
  const symbolic = await git(["-C", repositoryDirectory, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], [0, 1]);
  const prefix = "refs/remotes/origin/";
  const value = symbolic.stdout.trim();
  if (symbolic.exitCode !== 0 || !value.startsWith(prefix)) throw new ApiError(409, "github_sync_branch_required", "Could not determine the GitHub default branch");
  return value.slice(prefix.length);
}

async function revision(repositoryDirectory: string, ref: string): Promise<string> {
  const value = (await git(["-C", repositoryDirectory, "rev-parse", ref])).stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new ApiError(502, "github_revision_failed", "GitHub returned an invalid Git revision");
  return value;
}

async function ensureRevision(repositoryDirectory: string, commit: string): Promise<void> {
  const result = await git(["-C", repositoryDirectory, "cat-file", "-e", `${commit}^{commit}`], [0, 128]);
  if (result.exitCode !== 0) throw new ApiError(409, "github_sync_base_missing", "The last synced GitHub commit is no longer available; re-import the paper before syncing");
}

async function remoteHead(remote: string, branch: string): Promise<string> {
  const result = await git(["ls-remote", "--exit-code", "--heads", "--", remote, `refs/heads/${branch}`]);
  const commit = result.stdout.trim().split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new ApiError(502, "github_revision_failed", "GitHub returned an invalid branch revision");
  return commit;
}

async function clearWorkingTree(repositoryDirectory: string): Promise<void> {
  for (const entry of await readdir(repositoryDirectory, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    await rm(join(repositoryDirectory, entry.name), { recursive: true, force: true });
  }
}

async function copyManagedTree(source: string, destination: string, destinationRoot: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    const path = relative(destinationRoot, to).replaceAll("\\", "/");
    if (isIgnoredWorkspacePath(path) || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await copyManagedTree(from, to, destinationRoot);
    else if (entry.isFile()) await cp(from, to, { force: true });
  }
}

async function readConflicts(repositoryDirectory: string): Promise<GithubSyncConflict[]> {
  const result = await git(["-C", repositoryDirectory, "ls-files", "-u", "-z"]);
  const stages = new Map<string, Set<number>>();
  for (const record of result.stdout.split("\0").filter(Boolean)) {
    const match = record.match(/^\d+ [0-9a-f]+ ([123])\t([\s\S]+)$/);
    if (!match) continue;
    const path = match[2]!;
    const values = stages.get(path) ?? new Set<number>();
    values.add(Number(match[1]));
    stages.set(path, values);
  }
  const conflicts: GithubSyncConflict[] = [];
  for (const [path, available] of stages) {
    const [base, fastwrite, github] = await Promise.all([indexBlob(repositoryDirectory, 1, path), indexBlob(repositoryDirectory, 2, path), indexBlob(repositoryDirectory, 3, path)]);
    const deleted = !available.has(2) || !available.has(3);
    const binary = [base, fastwrite, github].some((value) => value && (!isUtf8Text(value) || value.byteLength > MAX_EDITABLE_CONFLICT_BYTES));
    const conflict: GithubSyncConflict = { path, kind: deleted ? "delete-modify" : binary ? "binary" : "text" };
    if (conflict.kind === "text") {
      if (base) conflict.baseContent = new TextDecoder().decode(base);
      if (fastwrite) conflict.fastwriteContent = new TextDecoder().decode(fastwrite);
      if (github) conflict.githubContent = new TextDecoder().decode(github);
    }
    conflicts.push(conflict);
  }
  return conflicts.sort((a, b) => a.path.localeCompare(b.path));
}

async function indexBlob(repositoryDirectory: string, stage: number, path: string): Promise<Uint8Array | null> {
  const result = await gitBytes(["-C", repositoryDirectory, "show", `:${stage}:${path}`], [0, 128]);
  return result.exitCode === 0 ? result.bytes : null;
}

function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; }
  catch { return false; }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "GitHub sync failed";
}

function now(): string { return new Date().toISOString(); }
