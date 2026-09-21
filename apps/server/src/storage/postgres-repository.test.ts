import { expect, test } from "bun:test";
import { SqlPostgresRepository } from "./postgres-repository";
import { JsonDatabase } from "./database";

test("postgres repository creates schema and supports dry-run legacy import", async () => {
  const queries: string[] = [];
  const client = { query: async (sql: string) => { queries.push(sql); return { rows: [] }; } };
  const database = new JsonDatabase(`/tmp/fastwrite-pg-${crypto.randomUUID()}`); await database.initialize();
  const repository = await SqlPostgresRepository.connect(client, database.snapshot());
  const report = await repository.importLegacy(database.snapshot());
  expect(report.imported).toBe(false);
  expect(report.legacyHash).toMatch(/^[a-f0-9]{64}$/);
  expect(queries.some((query) => query.includes("CREATE TABLE IF NOT EXISTS users"))).toBe(true);
  await repository.close();
});

test("postgres repository mirrors entity rows and collaboration indexes on commit", async () => {
  const queries: Array<{ sql: string; parameters?: unknown[] }> = [];
  const client = { query: async (sql: string, parameters?: unknown[]) => { queries.push(parameters === undefined ? { sql } : { sql, parameters }); return { rows: [] }; } };
  const database = new JsonDatabase(`/tmp/fastwrite-pg-${crypto.randomUUID()}`); await database.initialize();
  const repository = await SqlPostgresRepository.connect(client, database.snapshot());
  await repository.mutate((state) => {
    state.projects.push({ id: "project_1", name: "Research", mainDocument: "main.tex", version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), skill: { id: "generic", name: "Generic", venue: "generic" } } as any);
    state.yDocumentUpdates.push({ documentId: "doc_1", sequence: 1, update: "AQ==", bytes: 1, createdAt: new Date().toISOString() });
  });
  expect(queries.some((item) => item.sql.includes("INSERT INTO projects"))).toBe(true);
  expect(queries.some((item) => item.sql.includes("INSERT INTO collaboration_updates"))).toBe(true);
  expect(queries.some((item) => item.sql.includes("collaboration_updates_document_sequence_idx"))).toBe(true);
  await repository.close();
});

test("postgres repository can verify and cut over to the persisted snapshot", async () => {
  const rows = new Map<string, unknown>();
  const client = { query: async (sql: string, parameters?: unknown[]) => {
    if (sql.startsWith("INSERT INTO fastwrite_state")) rows.set(String(parameters?.[0]), JSON.parse(String(parameters?.[1])));
    if (sql.startsWith("SELECT payload FROM fastwrite_state")) return { rows: rows.has("singleton") ? [{ payload: rows.get("singleton") }] : [] };
    return { rows: [] };
  } };
  const database = new JsonDatabase(`/tmp/fastwrite-pg-${crypto.randomUUID()}`); await database.initialize();
  const repository = await SqlPostgresRepository.connect(client, database.snapshot());
  await repository.importLegacy({ ...database.snapshot(), schemaVersion: 99 }, { commit: true });
  const comparison = await repository.dualReadCompare();
  expect(comparison.equal).toBe(true);
  const switched = await repository.cutoverFromPersisted();
  expect(switched.switched).toBe(true);
  expect(repository.snapshot().schemaVersion).toBe(99);
  await repository.close();
});

test("postgres repository can restore a known snapshot after a failed cutover", async () => {
  const rows = new Map<string, unknown>();
  const client = { query: async (sql: string, parameters?: unknown[]) => {
    if (sql.startsWith("INSERT INTO fastwrite_state")) rows.set(String(parameters?.[0]), JSON.parse(String(parameters?.[1])));
    if (sql.startsWith("SELECT payload FROM fastwrite_state")) return { rows: rows.has("singleton") ? [{ payload: rows.get("singleton") }] : [] };
    return { rows: [] };
  } };
  const database = new JsonDatabase(`/tmp/fastwrite-pg-${crypto.randomUUID()}`); await database.initialize();
  const repository = await SqlPostgresRepository.connect(client, database.snapshot());
  const known = repository.snapshot();
  await repository.mutate((state) => { state.schemaVersion = 99; });
  const restored = await repository.rollbackTo(known);
  expect(restored.restored).toBe(true);
  expect(repository.snapshot().schemaVersion).toBe(known.schemaVersion);
  await repository.close();
});

test("postgres repository compare-and-mutate rejects a stale expected version", async () => {
  const client = { query: async (_sql: string) => ({ rows: [] }) };
  const database = new JsonDatabase(`/tmp/fastwrite-pg-${crypto.randomUUID()}`); await database.initialize();
  const repository = await SqlPostgresRepository.connect(client, database.snapshot());
  await expect(repository.compareAndMutate(repository.version() + 1, (state) => { state.projects.push({ id: "stale", name: "Stale", mainDocument: "main.tex", version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), skill: { id: "generic", name: "Generic", venue: "generic" } } as any); })).rejects.toThrow("repository_version_conflict");
  expect(repository.snapshot().projects).toHaveLength(0);
  await repository.close();
});

test("postgres repository rolls back its SQL transaction when a row write fails", async () => {
  const statements: string[] = [];
  const client = { query: async (sql: string) => {
    statements.push(sql);
    if (sql.startsWith("INSERT INTO projects")) throw new Error("write_failed");
    return { rows: [] };
  } };
  const database = new JsonDatabase(`/tmp/fastwrite-pg-${crypto.randomUUID()}`); await database.initialize();
  const repository = await SqlPostgresRepository.connect(client, database.snapshot());
  await expect(repository.mutate((state) => { state.projects.push({ id: "project_failed", name: "Failure", mainDocument: "main.tex", version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), skill: { id: "generic", name: "Generic", venue: "generic" } } as any); })).rejects.toThrow("write_failed");
  expect(statements.at(-1)).toBe("ROLLBACK");
  expect(repository.snapshot().projects).toHaveLength(0);
  await repository.close();
});

test("postgres repository persists and loads collaboration updates independently", async () => {
  const rows = new Map<string, any>();
  const client = { query: async (sql: string, parameters?: unknown[]) => {
    if (sql.startsWith("INSERT INTO collaboration_updates")) rows.set(`u:${parameters?.[0]}`, { sequence: parameters?.[2], payload: JSON.parse(String(parameters?.[3])) });
    if (sql.startsWith("INSERT INTO collaboration_snapshots")) rows.set(`s:${parameters?.[0]}`, { sequence: parameters?.[2], payload: JSON.parse(String(parameters?.[3])) });
    if (sql.startsWith("SELECT sequence, payload FROM collaboration_updates")) return { rows: [] };
    if (sql.startsWith("SELECT sequence, payload FROM collaboration_snapshots")) return { rows: [...rows.values()].filter((row) => String(row.payload?.documentId) === String(parameters?.[0]) && row.payload?.createdAt && row.sequence > 1).map((row) => ({ sequence: row.sequence, payload: row.payload })) };
    return { rows: [] };
  } };
  const database = new JsonDatabase(`/tmp/fastwrite-pg-${crypto.randomUUID()}`); await database.initialize();
  const repository = await SqlPostgresRepository.connect(client, database.snapshot());
  await repository.appendUpdate({ documentId: "doc_1", sequence: 1, update: "AQ==", bytes: 1, createdAt: new Date().toISOString() });
  await repository.saveSnapshot({ documentId: "doc_1", sequence: 2, update: "Ag==", createdAt: new Date().toISOString() });
  const loaded = await repository.load("doc_1");
  expect(loaded.snapshots).toEqual([{ sequence: 2, update: "Ag==" }]);
  expect(loaded.updates).toEqual([]);
  await repository.close();
});
