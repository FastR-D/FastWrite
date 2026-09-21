import { createHash } from "node:crypto";
import type { DatabaseState } from "./database";
import type { PostgresRepository, VersionedRepository } from "./repository";
import type { CollaborationPersistence } from "../collaboration/collaboration-bus";

export type SqlClient = { query(sql: string, parameters?: unknown[]): Promise<{ rows?: any[] }>; end?: () => Promise<void> };

export class SqlPostgresRepository implements PostgresRepository, VersionedRepository, CollaborationPersistence {
  private constructor(private readonly client: SqlClient, private state: DatabaseState) {}
  static async connect(client: SqlClient, initialState: DatabaseState): Promise<SqlPostgresRepository> { const repository = new SqlPostgresRepository(client, structuredClone(initialState)); await repository.ensureSchema(); return repository; }
  snapshot(): DatabaseState { return structuredClone(this.state); }
  version(): number { return this.state.schemaVersion; }
  async compareAndMutate<T>(expectedVersion: number, mutation: (state: DatabaseState) => T): Promise<{ result: T; version: number }> {
    if (this.state.schemaVersion !== expectedVersion) throw new Error("repository_version_conflict");
    const result = await this.mutate(mutation);
    return { result, version: this.state.schemaVersion };
  }
  async mutate<T>(mutation: (state: DatabaseState) => T): Promise<T> { const next = structuredClone(this.state); const result = mutation(next); await this.writeState(next); this.state = next; return structuredClone(result); }
  async transaction<T>(operation: (repository: PostgresRepository) => Promise<T>): Promise<T> { await this.client.query("BEGIN"); try { const result = await operation(this); await this.client.query("COMMIT"); return result; } catch (error) { await this.client.query("ROLLBACK"); throw error; } }
  async close(): Promise<void> { await this.client.end?.(); }
  async importLegacy(state: DatabaseState, options: { commit?: boolean } = {}) { const legacyHash = hashState(state); if (options.commit) { await this.writeState(state); this.state = structuredClone(state); } return { imported: Boolean(options.commit), legacyHash, importedHash: hashState(state), counts: { users: state.users.length, teams: state.teams.length, projects: state.projects.length, jobs: state.jobs.length }, mismatches: [] as string[] }; }
  async dualReadCompare() { const rows = await this.client.query("SELECT payload FROM fastwrite_state WHERE id = $1", ["singleton"]); const payload = rows.rows?.[0]?.payload as DatabaseState | undefined; if (!payload) return { equal: false, legacyHash: hashState(this.state), normalizedHash: "", mismatches: ["normalized_state_missing"] }; const legacyHash = hashState(this.state); const normalizedHash = hashState(payload); return { equal: legacyHash === normalizedHash, legacyHash, normalizedHash, mismatches: legacyHash === normalizedHash ? [] : ["state_hash_mismatch"] }; }
  async loadPersistedState(): Promise<DatabaseState | undefined> { const rows = await this.client.query("SELECT payload FROM fastwrite_state WHERE id = $1", ["singleton"]); const payload = rows.rows?.[0]?.payload as DatabaseState | undefined; return payload ? structuredClone(payload) : undefined; }
  async cutoverFromPersisted(): Promise<{ switched: boolean; hash?: string }> { const persisted = await this.loadPersistedState(); if (!persisted) return { switched: false }; this.state = persisted; return { switched: true, hash: hashState(persisted) }; }
  async rollbackTo(snapshot: DatabaseState): Promise<{ restored: boolean; hash: string }> { await this.writeState(snapshot); this.state = structuredClone(snapshot); return { restored: true, hash: hashState(snapshot) }; }
  async appendUpdate(input: { documentId: string; sequence: number; update: string; bytes: number; createdAt: string }): Promise<void> { await this.client.query("INSERT INTO collaboration_updates (id, document_id, sequence, payload) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (id) DO NOTHING", [`${input.documentId}:${input.sequence}`, input.documentId, input.sequence, JSON.stringify(input)]); }
  async saveSnapshot(input: { documentId: string; sequence: number; update: string; createdAt: string }): Promise<void> { await this.client.query("INSERT INTO collaboration_snapshots (id, document_id, sequence, payload) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, sequence = EXCLUDED.sequence, updated_at = now()", [`${input.documentId}:${input.sequence}`, input.documentId, input.sequence, JSON.stringify(input)]); await this.client.query("DELETE FROM collaboration_updates WHERE document_id = $1 AND sequence <= $2", [input.documentId, input.sequence]); }
  async load(documentId: string): Promise<{ snapshots: Array<{ sequence: number; update: string }>; updates: Array<{ sequence: number; update: string }> }> { const snapshots = await this.client.query("SELECT sequence, payload FROM collaboration_snapshots WHERE document_id = $1 ORDER BY sequence DESC", [documentId]); const updates = await this.client.query("SELECT sequence, payload FROM collaboration_updates WHERE document_id = $1 ORDER BY sequence ASC", [documentId]); return { snapshots: (snapshots.rows ?? []).map((row) => ({ sequence: Number(row.sequence), update: String(row.payload.update) })), updates: (updates.rows ?? []).map((row) => ({ sequence: Number(row.sequence), update: String(row.payload.update) })) }; }
  private async ensureSchema(): Promise<void> {
    await this.client.query("CREATE TABLE IF NOT EXISTS fastwrite_state (id text PRIMARY KEY, payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())");
    for (const [table, columns] of [["users", "id text PRIMARY KEY, payload jsonb NOT NULL"], ["teams", "id text PRIMARY KEY, payload jsonb NOT NULL"], ["projects", "id text PRIMARY KEY, payload jsonb NOT NULL"], ["jobs", "id text PRIMARY KEY, payload jsonb NOT NULL, status text NOT NULL"], ["experiment_runs", "id text PRIMARY KEY, payload jsonb NOT NULL, status text NOT NULL"], ["audit_events", "id text PRIMARY KEY, payload jsonb NOT NULL, created_at timestamptz"], ["collaboration_updates", "id text PRIMARY KEY, document_id text NOT NULL, sequence bigint NOT NULL, payload jsonb NOT NULL"], ["collaboration_snapshots", "id text PRIMARY KEY, document_id text NOT NULL, sequence bigint NOT NULL, payload jsonb NOT NULL"]] as const) await this.client.query(`CREATE TABLE IF NOT EXISTS ${table} (${columns}, updated_at timestamptz NOT NULL DEFAULT now())`);
    await this.client.query("CREATE INDEX IF NOT EXISTS collaboration_updates_document_sequence_idx ON collaboration_updates (document_id, sequence)");
    await this.client.query("CREATE INDEX IF NOT EXISTS collaboration_snapshots_document_sequence_idx ON collaboration_snapshots (document_id, sequence DESC)");
  }
  private async writeState(state: DatabaseState): Promise<void> {
    await this.client.query("BEGIN");
    try {
      await this.client.query("INSERT INTO fastwrite_state (id, payload, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()", ["singleton", JSON.stringify(state)]);
      await this.replaceRows("users", state.users.map((payload) => [payload.id, payload]));
      await this.replaceRows("teams", state.teams.map((payload) => [payload.id, payload]));
      await this.replaceRows("projects", state.projects.map((payload) => [payload.id, payload]));
      await this.replaceRows("jobs", state.jobs.map((payload) => [payload.id, payload, payload.status]));
      await this.replaceRows("experiment_runs", state.experimentRuns.map((payload) => [payload.id, payload, payload.status]));
      await this.replaceRows("audit_events", state.auditEvents.map((payload) => [payload.id, payload, payload.createdAt]));
      await this.replaceRows("collaboration_updates", state.yDocumentUpdates.map((payload, index) => [`${payload.documentId}:${payload.sequence}:${index}`, payload.documentId, payload.sequence, payload]));
      await this.replaceRows("collaboration_snapshots", state.yDocumentSnapshots.map((payload, index) => [`${payload.documentId}:${payload.sequence}:${index}`, payload.documentId, payload.sequence, payload]));
      await this.client.query("COMMIT");
    } catch (error) { await this.client.query("ROLLBACK"); throw error; }
  }

  private async replaceRows(table: string, rows: unknown[][]): Promise<void> {
    await this.client.query(`DELETE FROM ${table}`);
    for (const row of rows) {
      if (table === "jobs" || table === "experiment_runs") await this.client.query(`INSERT INTO ${table} (id, payload, status) VALUES ($1, $2::jsonb, $3)`, [row[0], JSON.stringify(row[1]), row[2]]);
      else if (table === "audit_events") await this.client.query(`INSERT INTO ${table} (id, payload, created_at) VALUES ($1, $2::jsonb, $3)`, [row[0], JSON.stringify(row[1]), row[2]]);
      else if (table === "collaboration_updates" || table === "collaboration_snapshots") await this.client.query(`INSERT INTO ${table} (id, document_id, sequence, payload) VALUES ($1, $2, $3, $4::jsonb)`, [row[0], row[1], row[2], JSON.stringify(row[3])]);
      else await this.client.query(`INSERT INTO ${table} (id, payload) VALUES ($1, $2::jsonb)`, [row[0], JSON.stringify(row[1])]);
    }
  }
}

export function hashState(state: DatabaseState): string { return createHash("sha256").update(JSON.stringify(state)).digest("hex"); }
