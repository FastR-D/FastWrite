import type { HarnessAdapter, HarnessSession, SessionReference } from "@fastwrite/harness-core";
import type { JsonDatabase } from "../storage/database";

export class HarnessSessionService {
  constructor(private readonly database: JsonDatabase) {}
  list(): HarnessSession[] { return structuredClone(this.database.snapshot().harnessSessions); }
  async create(adapter: HarnessAdapter, input: { cwd: string; title?: string }): Promise<HarnessSession> {
    const session = await adapter.createSession(input);
    const now = new Date().toISOString();
    const stored = { ...session, ...(input.title ? { title: input.title } : {}), createdAt: now, updatedAt: now };
    await this.database.mutate((state) => state.harnessSessions.push(stored));
    return stored;
  }
  async resume(adapter: HarnessAdapter, session: SessionReference): Promise<HarnessSession> {
    const resumed = await adapter.resumeSession(session);
    const now = new Date().toISOString();
    return this.database.mutate((state) => {
      const stored = state.harnessSessions.find((item) => item.harness === resumed.harness && item.sessionId === resumed.sessionId);
      if (stored) { stored.cwd = resumed.cwd; stored.updatedAt = now; stored.resumedAt = now; return stored; }
      const created = { ...resumed, createdAt: now, updatedAt: now, resumedAt: now }; state.harnessSessions.push(created); return created;
    });
  }
}
