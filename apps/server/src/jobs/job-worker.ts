import { createApplication } from "../app";
import { config } from "../config";
import { InProcessJobQueue, type JobStore } from "./job-queue";
import { LatexCompileService } from "../compiler/latex-compile-service";
import { WorkspaceService } from "../workspace/workspace-service";
import { ExperimentRunner } from "../experiments/experiment-runner";
import { JsonDatabase } from "../storage/database";
import { AuthorizationService } from "../auth/authorization-service";

/**
 * Standalone job worker entrypoint. It intentionally handles only operations
 * whose authorization and filesystem boundaries can be reconstructed from the
 * persisted job record. The API process remains responsible for enqueueing.
 */
export async function runJobWorker(options: { dataDirectory?: string; workerId?: string; pollMs?: number } = {}): Promise<void> {
  const dataDirectory = options.dataDirectory ?? config.dataDirectory;
  const workerId = options.workerId ?? `worker_${process.pid}_${crypto.randomUUID()}`;
  const database = new JsonDatabase(dataDirectory);
  await database.initialize();
  const store: JobStore = {
    load: () => database.snapshot().jobs,
    save: async (job) => database.mutate((state) => {
      const index = state.jobs.findIndex((candidate) => candidate.id === job.id);
      if (index >= 0) state.jobs[index] = job; else state.jobs.push(job);
    }),
    remove: async (id) => database.mutate((state) => { state.jobs = state.jobs.filter((job) => job.id !== id); })
  };
  const queue = new InProcessJobQueue({ store });
  const workspaces = new WorkspaceService(dataDirectory, database);
  await workspaces.initialize();
  const authorization = new AuthorizationService(database);
  const compiler = new LatexCompileService(dataDirectory, workspaces, { mode: process.env.FASTWRITE_COMPILE_SANDBOX === "bubblewrap" ? "bubblewrap" : "host" });
  const experiments = new ExperimentRunner(dataDirectory, workspaces);
  const pollMs = Math.min(Math.max(options.pollMs ?? 500, 100), 10_000);
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  while (!stopped) {
    const job = queue.claim(workerId, Math.max(10_000, pollMs * 4));
    if (!job) { await new Promise((resolve) => setTimeout(resolve, pollMs)); continue; }
    try {
      const currentState = database.snapshot();
      const actor = job.policy?.actorUserId ? currentState.users.find((user) => user.id === job.policy!.actorUserId) : undefined;
      if (job.policy?.actorUserId && (!actor || actor.status !== "active")) throw new Error("job_actor_revoked");
      if (job.policy?.actorUserId && job.policy.authorizationVersion !== undefined && actor?.authzVersion !== job.policy.authorizationVersion) throw new Error("job_authorization_changed");
      if (job.policy?.actorUserId && job.policy.projectId && job.policy.action && actor) for (const path of job.policy.paths ?? [""]) authorization.requireProjectPath({ user: actor, sessionId: "job-worker", idpGroups: currentState.sessions.find((session) => session.userId === actor.id && !session.revokedAt)?.idpGroups ?? [] }, job.policy.projectId, path, job.policy.action as Parameters<AuthorizationService["requireProjectPath"]>[3]);
      if (job.policy?.projectId && job.policy.projectVersion !== undefined && job.kind === "latex.compile") {
        const project = currentState.projects.find((candidate) => candidate.id === job.policy!.projectId);
        if (!project) throw new Error("job_project_missing");
        if (project.version !== job.policy.projectVersion) throw new Error("job_project_version_changed");
      }
      let output: unknown;
      if (job.kind === "latex.compile") output = await compiler.compile((job.input as { projectId: string }).projectId);
      else if (job.kind === "experiment.run") {
        const input = job.input as Parameters<ExperimentRunner["run"]>[0] & { experimentId?: string };
        await database.mutate((state) => { const run = input.experimentId ? state.experimentRuns.find((item) => item.id === input.experimentId) : undefined; if (run) { run.status = "running"; run.updatedAt = new Date().toISOString(); } });
        try {
          output = await experiments.run(input);
          await database.mutate((state) => { const run = input.experimentId ? state.experimentRuns.find((item) => item.id === input.experimentId) : undefined; if (run) { const result = output as Awaited<ReturnType<ExperimentRunner["run"]>>; run.status = result.success ? "completed" : "failed"; run.inputSnapshotHash = result.inputSnapshotHash; run.result = result; run.updatedAt = new Date().toISOString(); } });
        } catch (error) {
          await database.mutate((state) => { const run = input.experimentId ? state.experimentRuns.find((item) => item.id === input.experimentId) : undefined; if (run) { run.status = "failed"; run.updatedAt = new Date().toISOString(); } });
          throw error;
        }
      } else throw new Error(`unsupported_job_kind:${job.kind}`);
      await queue.finishClaim(job.id, workerId, { output });
    } catch (error) {
      await queue.finishClaim(job.id, workerId, { error: error instanceof Error ? error.message : "job_failed" }).catch(() => undefined);
    }
  }
}

if (import.meta.main) await runJobWorker();
