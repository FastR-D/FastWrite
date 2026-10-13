import type { HarnessAdapter, HarnessCapabilities, HarnessSession, SessionReference } from "@fastwrite/harness-core";
import { ApiError } from "../http";
import type { JsonDatabase } from "../storage/database";

export interface HarnessSessionBinding {
  projectId: string;
  actorUserId: string;
  executionSnapshotId: string;
}

export class HarnessSessionService {
  constructor(private readonly database: JsonDatabase) {}
  list(): HarnessSession[] { return structuredClone(this.database.snapshot().harnessSessions); }
  get(harness: SessionReference["harness"], sessionId: string): HarnessSession | undefined {
    return this.list().find(session => session.harness === harness && session.sessionId === sessionId);
  }

  async create(adapter: HarnessAdapter, input: { cwd: string; title?: string }, binding?: HarnessSessionBinding, validateAccess: () => void = () => {}): Promise<HarnessSession> {
    validateAccess();
    const session = await adapter.createSession(input);
    this.validateIdentity(session, adapter.kind, input.cwd);
    const capabilities = await this.capabilities(adapter);
    const timestamp = new Date().toISOString();
    const stored: HarnessSession = { harness: session.harness, sessionId: session.sessionId, cwd: session.cwd, ...(input.title ? { title: input.title } : {}), ...(binding ?? {}), createdAt: timestamp, updatedAt: timestamp, capabilities, capabilitiesVerifiedAt: timestamp };
    return this.database.mutate(state => {
      validateAccess();
      if (state.harnessSessions.some(item => item.harness === stored.harness && item.sessionId === stored.sessionId)) throw new ApiError(409, "harness_session_exists", "The adapter returned an existing session identity");
      state.harnessSessions.push(stored);
      return stored;
    });
  }

  async resume(adapter: HarnessAdapter, session: SessionReference, validateAccess: () => void = () => {}): Promise<HarnessSession> {
    validateAccess();
    this.validateIdentity(session, adapter.kind, session.cwd);
    const existing = this.get(session.harness, session.sessionId);
    if (existing && existing.cwd !== session.cwd) throw new ApiError(409, "harness_session_workspace_mismatch", "A session cannot be moved to another workspace");
    const resumed = await adapter.resumeSession(session);
    this.validateIdentity(resumed, session.harness, session.cwd, session.sessionId);
    const capabilities = await this.capabilities(adapter);
    const timestamp = new Date().toISOString();
    return this.database.mutate(state => {
      validateAccess();
      const stored = state.harnessSessions.find(item => item.harness === session.harness && item.sessionId === session.sessionId);
      if (existing && !stored) throw new ApiError(409, "harness_session_removed", "Session was removed while resuming");
      if (stored) {
        if (!existing || stored.createdAt !== existing.createdAt || stored.projectId !== existing.projectId || stored.actorUserId !== existing.actorUserId || stored.executionSnapshotId !== existing.executionSnapshotId) throw new ApiError(409, "harness_session_binding_changed", "Session binding changed while resuming");
        if (stored.cwd !== session.cwd) throw new ApiError(409, "harness_session_workspace_mismatch", "Session workspace changed while resuming");
        stored.capabilities = capabilities; stored.capabilitiesVerifiedAt = timestamp;
        stored.updatedAt = timestamp; stored.resumedAt = timestamp; return stored;
      }
      const created: HarnessSession = { harness: resumed.harness, sessionId: resumed.sessionId, cwd: resumed.cwd, createdAt: timestamp, updatedAt: timestamp, resumedAt: timestamp, capabilities, capabilitiesVerifiedAt: timestamp };
      state.harnessSessions.push(created); return created;
    });
  }

  private async capabilities(adapter: HarnessAdapter): Promise<HarnessCapabilities> {
    const supplied = await adapter.getCapabilities();
    const result = {} as HarnessCapabilities;
    for (const key of ["streaming", "sessions", "resume", "approvals", "skills", "mcp"] as const) {
      if (typeof supplied?.[key] !== "boolean") throw new ApiError(502, "harness_capabilities_invalid", "Adapter returned invalid capabilities");
      result[key] = supplied[key];
    }
    if (supplied.images !== undefined) {
      if (typeof supplied.images !== "boolean") throw new ApiError(502,"harness_capabilities_invalid","Adapter returned invalid image capabilities");
      result.images = supplied.images;
    }
    return result;
  }

  private validateIdentity(session: SessionReference, harness: SessionReference["harness"], cwd: string, sessionId?: string): void {
    if (!session || session.harness !== harness || session.cwd !== cwd || typeof session.sessionId !== "string" || !session.sessionId.trim() || (sessionId !== undefined && session.sessionId !== sessionId)) throw new ApiError(502, "harness_session_identity_mismatch", "Adapter returned an invalid session identity");
  }
}
