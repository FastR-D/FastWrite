import { expect, test } from "bun:test";
import { InProcessJobQueue } from "./job-queue";

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
