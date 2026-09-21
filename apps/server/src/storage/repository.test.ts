import { expect, test } from "bun:test";
import { JsonRepository } from "./repository";
import { JsonDatabase } from "./database";

test("repository adapter preserves transactional mutation semantics", async () => {
  const database = new JsonDatabase(`/tmp/fastwrite-repository-${crypto.randomUUID()}`); await database.initialize();
  const repository = new JsonRepository(database);
  await repository.mutate((state) => { state.jobs.push({ id: "job", kind: "test", status: "queued", attempts: 0, maxAttempts: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); });
  expect(repository.snapshot().jobs).toHaveLength(1);
});

test("repository compare-and-mutate rejects a stale expected version", async () => {
  const database = new JsonDatabase(`/tmp/fastwrite-repository-${crypto.randomUUID()}`); await database.initialize();
  const repository = new JsonRepository(database);
  const version = repository.version();
  await expect(repository.compareAndMutate(version + 1, (state) => state.jobs.push({ id: "stale", kind: "test", status: "queued", attempts: 0, maxAttempts: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }))).rejects.toThrow("repository_version_conflict");
  expect(repository.snapshot().jobs).toHaveLength(0);
});
