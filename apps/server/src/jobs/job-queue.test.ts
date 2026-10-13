import { expect, test } from "bun:test";
import { InProcessJobQueue } from "./job-queue";
import { processResult } from "./process-result";

test.each([false, true])("cancelled running jobs stay cancelled after handler settles (failure=%s)", async (fails) => {
  const queue = new InProcessJobQueue();
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let finish!: () => void; const barrier = new Promise<void>(resolve => { finish = resolve; });
  let signal: AbortSignal | undefined;
  const job = queue.enqueue("test", {}, async (_input, _job, cancellation) => { signal = cancellation; entered(); await barrier; if (fails) throw new Error("late failure"); return "late result"; });
  await started;
  queue.cancel(job.id); expect(signal!.aborted).toBe(true); finish();
  await queue.settled(job.id);
  expect(queue.get(job.id)).toMatchObject({ status: "cancelled", attempts: 1 });
  expect(queue.get(job.id)?.output).toBeUndefined();
});

test("cancel prevents queued execution and invalidates outstanding claims", async () => {
  const queue = new InProcessJobQueue(); let calls = 0;
  const job = queue.enqueue("test", {}, async () => { calls++; }, { start: false });
  queue.cancel(job.id); queue.start(job.id, async () => { calls++; }); await queue.settled(job.id);
  expect(calls).toBe(0);
  const claimed = queue.enqueue("test", {}, async () => undefined, { start: false }); queue.claim("worker"); queue.cancel(claimed.id);
  await expect(queue.finishClaim(claimed.id, "worker", { output: "late" })).rejects.toThrow();
  expect(queue.get(claimed.id)?.status).toBe("cancelled");
});

test("cancellation terminates a running child process", async () => {
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { detached: true, windowsHide: true, stdout: "pipe", stderr: "pipe" });
  const controller = new AbortController();
  const result = processResult(child, 10_000, controller.signal);
  controller.abort();
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(await child.exited).not.toBe(0);
});

test("retries bounded jobs and records terminal state", async () => {
  const queue = new InProcessJobQueue(); let attempts = 0;
  const job = queue.enqueue("compile", { projectId: "p" }, async () => { attempts++; if (attempts < 2) throw new Error("transient"); return { success: true }; });
  for (let i = 0; i < 20 && queue.get(job.id)?.status !== "completed"; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(queue.get(job.id)).toMatchObject({ status: "completed", attempts: 2, output: { success: true } });
});

test("cancels queued work", () => {
  const queue = new InProcessJobQueue();
  const job = queue.enqueue("compile", {}, async () => ({}));
  expect(queue.cancel(job.id)).toMatchObject({ status: "cancelled" });
});

test("restores persisted running jobs as queued", () => {
  const store = {
    load: () => [{ id: "job_restart", kind: "compile", status: "running" as const, attempts: 1, maxAttempts: 2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    save: async () => {}
  };
  const queue = new InProcessJobQueue({ store });
  expect(queue.get("job_restart")?.status).toBe("queued");
});

test("marks exhausted worker claims as dead letters", async () => {
  const queue = new InProcessJobQueue();
  const job = queue.enqueue("test", {}, async () => undefined, { start: false, maxAttempts: 1 });
  const claimed = queue.claim("worker");
  expect(claimed?.id).toBe(job.id);
  const failed = await queue.finishClaim(job.id, "worker", { error: "sandbox_failed" });
  expect(failed).toMatchObject({ status: "failed", deadLetter: true, error: "sandbox_failed" });
  expect(queue.deadLetters()).toHaveLength(1);
});

test("enforces active quotas and records bounded progress", () => {
  const queue = new InProcessJobQueue({ limits: { total: 1 } });
  const job = queue.enqueue("compile", {}, async () => ({}), { start: false });
  expect(() => queue.enqueue("compile", {}, async () => ({}), { start: false })).toThrow("job_quota_exceeded");
  expect(queue.updateProgress(job.id, { completed: 2, total: 5, message: "running" })).toMatchObject({ progress: { completed: 2, total: 5, message: "running" } });
});

test("requeues expired worker leases and dead-letters exhausted attempts", () => {
  const queue = new InProcessJobQueue();
  const first = queue.enqueue("compile", {}, async () => ({}), { start: false, maxAttempts: 2 });
  queue.claim("worker", 1);
  expect(queue.requeueExpiredLeases(Date.now() + 2_000)).toBe(1);
  expect(queue.get(first.id)).toMatchObject({ status: "queued", attempts: 1, error: "worker_lease_expired" });
  queue.claim("worker", 1);
  expect(queue.requeueExpiredLeases(Date.now() + 2_000)).toBe(1);
  expect(queue.get(first.id)).toMatchObject({ status: "failed", deadLetter: true, attempts: 2 });
});
