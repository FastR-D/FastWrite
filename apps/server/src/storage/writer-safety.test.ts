import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonDatabase } from "./database";
import { runJobWorker } from "../jobs/job-worker";
import { runMailWorker } from "../notifications/mail-worker";

test("a stale database instance cannot overwrite committed jobs", async () => {
  const root = await mkdtemp(join(tmpdir(), "fastwrite-writer-"));
  try {
    const api = new JsonDatabase(root); await api.initialize();
    const stale = new JsonDatabase(root); await stale.initialize();
    await api.mutate(state => { state.jobs.push({ id: "new-job", kind: "test", status: "queued", attempts: 0, maxAttempts: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); });
    await expect(stale.mutate(state => { state.jobs = []; })).rejects.toThrow("Stale state was not saved");
    expect(JSON.parse(await readFile(join(root, "database.json"), "utf8")).jobs[0].id).toBe("new-job");
    await expect(runJobWorker({ dataDirectory: root })).rejects.toThrow("Standalone workers are unsupported");
    await expect(runMailWorker()).rejects.toThrow("Standalone workers are unsupported");
    expect(JSON.parse(await readFile(join(root, "database.json"), "utf8")).jobs[0].id).toBe("new-job");
  } finally { await rm(root, { recursive: true, force: true }); }
});
