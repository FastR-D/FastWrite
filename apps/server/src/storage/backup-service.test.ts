import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { JsonDatabase } from "./database";
import { BackupService } from "./backup-service";
import { LocalObjectStore } from "./object-storage";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("creates and verifies local and object-store backups before restore", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "fastwrite-backup-"));
  roots.push(dataDirectory);
  const database = new JsonDatabase(dataDirectory); await database.initialize();
  await database.mutate((state) => { state.schemaVersion = 17; });
  const service = new BackupService(database, dataDirectory, new LocalObjectStore(join(dataDirectory, "objects")));
  const created = await service.createAndVerify();
  expect(created.valid).toBe(true);
  const key = `backups/${basename(created.path)}`;
  expect((await service.verifyObject(key)).valid).toBe(true);
  await expect(service.restoreObject(key, { confirm: "replace-database" })).resolves.toMatchObject({ schemaVersion: 17 });
});
