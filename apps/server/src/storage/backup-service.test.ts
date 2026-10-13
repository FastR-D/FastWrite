import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { JsonDatabase, CURRENT_SCHEMA_VERSION } from "./database";
import { BackupService, restoreBackupOffline } from "./backup-service";
import { lockDataDirectory } from "./data-directory-lock";
import { LocalObjectStore } from "./object-storage";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("creates and verifies local and object-store backups before restore", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "fastwrite-backup-"));
  roots.push(dataDirectory);
  const database = new JsonDatabase(dataDirectory); await database.initialize();
  await database.mutate((state) => { state.jobs = []; });
  const service = new BackupService(database, dataDirectory, new LocalObjectStore(join(dataDirectory, "objects")));
  const created = await service.createAndVerify();
  expect(created.valid).toBe(true);
  const key = `backups/${basename(created.path)}`;
  expect((await service.verifyObject(key)).valid).toBe(true);
  await database.mutate(state => { state.auditEvents.push({ id: "after-backup", action: "test", resourceType: "test", resourceId: "test", createdAt: new Date().toISOString() }); });
  await expect(service.restoreObject(key, { confirm: "replace-database" })).rejects.toMatchObject({ status: 409, code: "offline_restore_required" });
  await expect(service.restore(created.path, { confirm: "replace-database" })).rejects.toMatchObject({ status: 409 });
  const release = lockDataDirectory(dataDirectory);
  try { await expect(restoreBackupOffline(dataDirectory, { file: created.path, confirm: "replace-database" })).rejects.toThrow("Data directory is locked"); }
  finally { release(); }
  expect(database.snapshot().auditEvents).toHaveLength(1);
  await expect(restoreBackupOffline(dataDirectory, { objectKey: key, confirm: "replace-database" }, new LocalObjectStore(join(dataDirectory, "objects")))).resolves.toMatchObject({ schemaVersion: CURRENT_SCHEMA_VERSION });
  const restarted = new JsonDatabase(dataDirectory); await restarted.initialize();
  expect(restarted.snapshot().auditEvents).toHaveLength(0);
  await restarted.mutate(state => { state.auditEvents.push({ id: "after-restore", action: "test", resourceType: "test", resourceId: "test", createdAt: new Date().toISOString() }); });
  const reloaded = new JsonDatabase(dataDirectory); await reloaded.initialize();
  expect(reloaded.snapshot().auditEvents.map(event => event.id)).toEqual(["after-restore"]);
});
