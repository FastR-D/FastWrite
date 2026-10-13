import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { JsonDatabase, CURRENT_SCHEMA_VERSION, type DatabaseState } from "./database";
import { ApiError } from "../http";
import { lockDataDirectory } from "./data-directory-lock";
import type { ObjectStore } from "./object-storage";

export class BackupService {
  constructor(private readonly database: JsonDatabase, private readonly dataDirectory: string, private readonly objectStore?: ObjectStore) {}
  async create(): Promise<{ path: string; bytes: number; createdAt: string }> {
    const createdAt = new Date().toISOString(); const name = `backup-${createdAt.replace(/[:.]/g, "-")}.json`; const path = join(this.dataDirectory, "backups", name); await mkdir(join(this.dataDirectory, "backups"), { recursive: true }); const payload = JSON.stringify({ format: "fastwrite-json-backup", version: 1, createdAt, state: this.database.snapshot() }); const bytes = Buffer.byteLength(payload); await writeFile(path, payload, "utf8"); if (this.objectStore) await this.objectStore.put(`backups/${name}`, new TextEncoder().encode(payload), "application/json"); return { path, bytes, createdAt };
  }
  async createAndVerify(): Promise<{ path: string; bytes: number; createdAt: string; valid: boolean }> {
    const backup = await this.create();
    const verified = await this.verify(backup.path);
    return { ...backup, valid: verified.valid };
  }
  async verify(path: string): Promise<{ valid: boolean; schemaVersion?: number; bytes: number; stateCounts?: { projects: number; jobs: number; users: number } }> {
    const payload = JSON.parse(await readFile(path, "utf8")) as { format?: string; version?: number; state?: { schemaVersion?: number; projects?: unknown[]; jobs?: unknown[]; users?: unknown[] } };
    const bytes = (await stat(path)).size;
    const valid = payload.format === "fastwrite-json-backup" && payload.version === 1 && Boolean(payload.state) && Number.isInteger(payload.state?.schemaVersion) && Array.isArray(payload.state?.projects) && Array.isArray(payload.state?.jobs) && Array.isArray(payload.state?.users);
    return { valid, ...(payload.state?.schemaVersion ? { schemaVersion: payload.state.schemaVersion } : {}), bytes, ...(payload.state ? { stateCounts: { projects: payload.state.projects?.length ?? 0, jobs: payload.state.jobs?.length ?? 0, users: payload.state.users?.length ?? 0 } } : {}) };
  }
  async verifyObject(key: string): Promise<{ valid: boolean; bytes: number }> {
    if (!this.objectStore) throw new Error("Object store is not configured");
    const object = await this.objectStore.get(key); const payload = JSON.parse(new TextDecoder().decode(object.body)) as { format?: string; version?: number; state?: { schemaVersion?: number; projects?: unknown[]; jobs?: unknown[]; users?: unknown[] } };
    return { valid: payload.format === "fastwrite-json-backup" && payload.version === 1 && Boolean(payload.state) && Number.isInteger(payload.state?.schemaVersion) && Array.isArray(payload.state?.projects) && Array.isArray(payload.state?.jobs) && Array.isArray(payload.state?.users), bytes: object.body.byteLength };
  }
  async restoreObject(_key: string, _options: { confirm: "replace-database" }): Promise<{ schemaVersion: number; projects: number }> {
    throw new ApiError(409, "offline_restore_required", "Stop FastWrite and run bun run backup:restore -- --data-dir <directory> --object-key <key> --confirm replace-database.");
  }
  async restore(_path: string, _options: { confirm: "replace-database" }): Promise<{ schemaVersion: number; projects: number }> {
    throw new ApiError(409, "offline_restore_required", "Stop FastWrite and run bun run backup:restore -- --data-dir <directory> --file <backup> --confirm replace-database.");
  }
}

export async function restoreBackupOffline(directory: string, input: { file?: string; objectKey?: string; confirm: string }, objectStore?: ObjectStore) {
  if (input.confirm !== "replace-database") throw new Error("Explicit restore confirmation is required");
  if (Boolean(input.file) === Boolean(input.objectKey)) throw new Error("Specify exactly one backup file or object key");
  const release = lockDataDirectory(directory);
  try {
    const payload = JSON.parse(input.file ? await readFile(input.file, "utf8") : new TextDecoder().decode((await objectStore!.get(input.objectKey!)).body));
    const database = new JsonDatabase(directory);
    const shape = database.snapshot();
    if (payload.format !== "fastwrite-json-backup" || payload.version !== 1 || !payload.state || !Number.isInteger(payload.state.schemaVersion) || payload.state.schemaVersion !== CURRENT_SCHEMA_VERSION) throw new Error("Invalid or incompatible FastWrite backup");
    for (const [key, value] of Object.entries(shape)) {
      const restored = payload.state[key];
      if (Array.isArray(value) ? !Array.isArray(restored) : typeof restored !== typeof value || restored === null) throw new Error("Invalid backup field: " + key);
    }
    await database.initialize();
    const safetyCopy = await new BackupService(database, directory).create();
    await database.replaceState(payload.state as DatabaseState);
    return { schemaVersion: database.version(), projects: database.snapshot().projects.length, safetyCopy: safetyCopy.path };
  } finally { release(); }
}
