/** JSON-backed queues are owned by the API process. A separate worker would use stale state. */
export async function runJobWorker(_options: { dataDirectory?: string; workerId?: string; pollMs?: number } = {}): Promise<void> {
  throw new Error("Standalone workers are unsupported by the JSON-backed runtime (including PostgreSQL mirror mode). Run bun run start with FASTWRITE_JOB_WORKER_MODE unset; jobs and mail are processed in the server.");
}

if (import.meta.main) await runJobWorker();
