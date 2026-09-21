import { mkdir, readFile, writeFile, stat, rename } from "node:fs/promises";
import { join } from "node:path";
import type { JsonDatabase } from "./database";
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
  async restoreObject(key: string, options: { confirm: "replace-database" }): Promise<{ schemaVersion: number; projects: number }> {
    if (options.confirm !== "replace-database") throw new Error("Explicit restore confirmation is required");
    if (!this.objectStore) throw new Error("Object store is not configured");
    const object = await this.objectStore.get(key); const payload = JSON.parse(new TextDecoder().decode(object.body)) as { format?: string; version?: number; state?: { schemaVersion?: number; projects?: unknown[] } };
    if (payload.format !== "fastwrite-json-backup" || payload.version !== 1 || !payload.state || !Number.isInteger(payload.state.schemaVersion) || !Array.isArray(payload.state.projects)) throw new Error("Invalid FastWrite backup");
    const target = join(this.dataDirectory, "database.json"); const temporary = `${target}.${process.pid}.restore.tmp`;
    await mkdir(this.dataDirectory, { recursive: true }); await writeFile(temporary, JSON.stringify(payload.state, null, 2), "utf8"); await rename(temporary, target);
    return { schemaVersion: payload.state.schemaVersion!, projects: payload.state.projects.length };
  }
  async restore(path: string, options: { confirm: "replace-database" }): Promise<{ schemaVersion: number; projects: number }> {
    if (options.confirm !== "replace-database") throw new Error("Explicit restore confirmation is required");
    const payload = JSON.parse(await readFile(path, "utf8")) as { format?: string; state?: { schemaVersion?: number; projects?: unknown[] } };
    if (payload.format !== "fastwrite-json-backup" || !payload.state || !Number.isInteger(payload.state.schemaVersion) || !Array.isArray(payload.state.projects)) throw new Error("Invalid FastWrite backup");
    const target = join(this.dataDirectory, "database.json"); const temporary = `${target}.${process.pid}.restore.tmp`;
    await mkdir(this.dataDirectory, { recursive: true });
    await writeFile(temporary, JSON.stringify(payload.state, null, 2), "utf8");
    await rename(temporary, target);
    return { schemaVersion: payload.state.schemaVersion!, projects: payload.state.projects.length };
  }
}
