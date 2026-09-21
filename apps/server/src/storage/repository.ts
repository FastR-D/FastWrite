import type { DatabaseState, JsonDatabase } from "./database";

export interface FastWriteRepository {
  snapshot(): DatabaseState;
  mutate<T>(mutation: (state: DatabaseState) => T): Promise<T>;
}

/** A repository transaction with an explicit expected state version. */
export interface VersionedRepository extends FastWriteRepository {
  version(): number;
  compareAndMutate<T>(expectedVersion: number, mutation: (state: DatabaseState) => T): Promise<{ result: T; version: number }>;
}

/** Serializes repository reads/writes behind the same interface used by the server.
 * This lets deployments switch the persistence backend without changing services. */
export class RepositoryDatabaseAdapter implements FastWriteRepository {
  constructor(private readonly repository: FastWriteRepository) {}
  snapshot(): DatabaseState { return this.repository.snapshot(); }
  mutate<T>(mutation: (state: DatabaseState) => T): Promise<T> { return this.repository.mutate(mutation); }
}

export class JsonRepository implements VersionedRepository {
  constructor(private readonly database: JsonDatabase) {}
  snapshot(): DatabaseState { return this.database.snapshot(); }
  version(): number { return this.database.version(); }
  async compareAndMutate<T>(expectedVersion: number, mutation: (state: DatabaseState) => T): Promise<{ result: T; version: number }> {
    const current = this.database.snapshot();
    if (current.schemaVersion !== expectedVersion) throw new Error("repository_version_conflict");
    const result = await this.database.mutate((state) => mutation(state));
    return { result, version: this.database.version() };
  }
  mutate<T>(mutation: (state: DatabaseState) => T): Promise<T> { return this.database.mutate(mutation); }
}

/** The server-mode boundary for the future PostgreSQL implementation. */
export interface PostgresRepository extends FastWriteRepository {
  transaction<T>(operation: (repository: PostgresRepository) => Promise<T>): Promise<T>;
  loadPersistedState(): Promise<DatabaseState | undefined>;
  cutoverFromPersisted(): Promise<{ switched: boolean; hash?: string }>;
  rollbackTo(snapshot: DatabaseState): Promise<{ restored: boolean; hash: string }>;
  close(): Promise<void>;
}
