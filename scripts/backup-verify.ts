import { readFile, stat } from "node:fs/promises";

const path = process.argv[2];
if (!path) throw new Error("Usage: bun scripts/backup-verify.ts <backup.json>");
const payload = JSON.parse(await readFile(path, "utf8")) as { format?: string; version?: number; state?: { schemaVersion?: number } };
if (payload.format !== "fastwrite-json-backup" || payload.version !== 1 || !payload.state || !Number.isInteger(payload.state.schemaVersion) || !Array.isArray(payload.state.projects) || !Array.isArray(payload.state.jobs) || !Array.isArray(payload.state.users)) throw new Error("Invalid FastWrite backup");
console.log(JSON.stringify({ valid: true, version: payload.version, schemaVersion: payload.state.schemaVersion, bytes: (await stat(path)).size, stateCounts: { projects: payload.state.projects.length, jobs: payload.state.jobs.length, users: payload.state.users.length } }));
