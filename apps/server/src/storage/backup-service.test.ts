import { expect, test } from "bun:test";
import { JsonDatabase } from "./database";
import { BackupService } from "./backup-service";
import { LocalObjectStore } from "./object-storage";

test("creates and verifies local and object-store backups before restore", async () => {
  const dataDirectory = `/tmp/fastwrite-backup-${crypto.randomUUID()}`;
  const database = new JsonDatabase(dataDirectory); await database.initialize();
  await database.mutate((state) => { state.schemaVersion = 17; });
  const service = new BackupService(database, dataDirectory, new LocalObjectStore(`${dataDirectory}/objects`));
  const created = await service.createAndVerify();
  expect(created.valid).toBe(true);
  const key = `backups/${created.path.split("/backups/")[1]}`;
  expect((await service.verifyObject(key)).valid).toBe(true);
  await expect(service.restoreObject(key, { confirm: "replace-database" })).resolves.toMatchObject({ schemaVersion: 17 });
});
