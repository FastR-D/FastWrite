export type HarnessKind = "claude" | "codex";
export type HarnessRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface HarnessCapabilities {
  streaming: boolean;
  sessions: boolean;
  resume: boolean;
  approvals: boolean;
  skills: boolean;
  mcp: boolean;
}

export interface HarnessStatus {
  kind: HarnessKind;
  state: "ready" | "degraded" | "unavailable";
  version?: string;
  message?: string;
}

export interface SessionReference { harness: HarnessKind; sessionId: string; cwd: string }
export interface HarnessSession extends SessionReference { title?: string; createdAt: string; updatedAt: string; resumedAt?: string }
export interface SkillInvocation { id: string; name: string; path: string; version: string; digest?: string }
export interface HarnessApproval { id: string; runId: string; status: "pending" | "approved" | "denied"; reason: string; createdAt: string; updatedAt: string }
export interface HarnessRun { id: string; session: SessionReference; status: HarnessRunStatus; skills: SkillInvocation[]; events: HarnessEvent[]; approvals: HarnessApproval[]; createdAt: string; updatedAt: string }

export type HarnessEvent =
  | { type: "run.started"; runId: string }
  | { type: "assistant.delta"; runId: string; text: string }
  | { type: "tool.requested"; runId: string; tool: string; input: unknown }
  | { type: "approval.requested"; runId: string; approvalId: string; reason: string }
  | { type: "run.completed"; runId: string; result?: unknown }
  | { type: "run.failed"; runId: string; error: string }
  | { type: "run.cancelled"; runId: string };

export interface SendMessageInput { session: SessionReference; content: string; model?: string; skills?: SkillInvocation[]; signal?: AbortSignal }
export interface HarnessAdapter {
  readonly kind: HarnessKind;
  getStatus(): Promise<HarnessStatus>;
  getCapabilities(): Promise<HarnessCapabilities>;
  createSession(input: { cwd: string; title?: string }): Promise<SessionReference>;
  resumeSession(session: SessionReference): Promise<SessionReference>;
  sendMessage(input: SendMessageInput): AsyncIterable<HarnessEvent>;
  cancelRun(input: { session: SessionReference; runId?: string }): Promise<void>;
  resolveApproval?(input: { approvalId: string; decision: "approved" | "denied" }): Promise<void>;
  dispose(): Promise<void>;
}

export class HarnessRegistry {
  readonly #adapters = new Map<HarnessKind, HarnessAdapter>();
  register(adapter: HarnessAdapter): void { this.#adapters.set(adapter.kind, adapter); }
  get(kind: HarnessKind): HarnessAdapter | undefined { return this.#adapters.get(kind); }
  list(): HarnessAdapter[] { return [...this.#adapters.values()]; }
  async status(): Promise<HarnessStatus[]> { return Promise.all(this.list().map((adapter) => adapter.getStatus())); }
}

export class AsyncEventQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #closed = false;
  push(value: T): void { if (this.#closed) return; const waiter = this.#waiters.shift(); waiter ? waiter({ done: false, value }) : this.#values.push(value); }
  close(): void { if (this.#closed) return; this.#closed = true; for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined }); }
  [Symbol.asyncIterator](): AsyncIterator<T> { return { next: async () => { const value = this.#values.shift(); if (value !== undefined) return { done: false, value }; if (this.#closed) return { done: true, value: undefined }; return await new Promise<IteratorResult<T>>((resolve) => this.#waiters.push(resolve)); } }; }
}

export * from "./mcp";
