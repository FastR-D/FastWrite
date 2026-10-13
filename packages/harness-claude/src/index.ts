import { AsyncEventQueue, type HarnessAdapter, type HarnessCapabilities, type HarnessEvent, type HarnessStatus, type SendMessageInput, type SessionReference } from "@fastwrite/harness-core";
import { ClaudeCliBridge } from "./cli-bridge";
export { ClaudeCliBridge, type ClaudeCliOptions } from "./cli-bridge";

export interface ClaudeSdkBridge {
  createSession(input: { cwd: string; title?: string }): Promise<string>;
  resumeSession(input: { sessionId: string; cwd: string }): Promise<void>;
  send(input: { runId?: string; cwd?: string; sessionId: string; content: string; model?: string; skills?: SendMessageInput["skills"]; onEvent: (event: HarnessEvent) => void; signal?: AbortSignal }): Promise<unknown>;
  cancel(input: { sessionId: string; runId?: string }): Promise<void>;
  resolveApproval?(input: { approvalId: string; decision: "approved" | "denied" }): Promise<void>;
  dispose(): Promise<void>;
}

export class ClaudeHarnessAdapter implements HarnessAdapter {
  readonly kind = "claude" as const;
  constructor(private readonly sdk: ClaudeSdkBridge = new ClaudeCliBridge()) {}
  async getStatus(): Promise<HarnessStatus> {
    return this.sdk instanceof ClaudeCliBridge ? this.sdk.getStatus() : { kind: "claude", state: "ready", message: "Claude SDK bridge available" };
  }
  async getCapabilities(): Promise<HarnessCapabilities> { const cli = this.sdk instanceof ClaudeCliBridge; return { streaming: true, sessions: true, resume: true, approvals: !cli && Boolean(this.sdk.resolveApproval), skills: !cli, mcp: !cli, images: !cli }; }
  async createSession(input: { cwd: string; title?: string }): Promise<SessionReference> { if (!this.sdk) throw new Error("Claude Agent SDK is unavailable"); return { harness: "claude", sessionId: await this.sdk.createSession(input), cwd: input.cwd }; }
  async resumeSession(session: SessionReference): Promise<SessionReference> { if (!this.sdk) throw new Error("Claude Agent SDK is unavailable"); await this.sdk.resumeSession({ sessionId: session.sessionId, cwd: session.cwd }); return session; }
  sendMessage(input: SendMessageInput): AsyncIterable<HarnessEvent> {
    const queue = new AsyncEventQueue<HarnessEvent>(); const runId = `run_${crypto.randomUUID()}`; let terminal = false;
    queue.push({ type: "run.started", runId });
    const emit = (event: HarnessEvent) => {
      if (terminal || event.type === "run.started") return;
      terminal = ["run.completed", "run.failed", "run.cancelled"].includes(event.type);
      queue.push({ ...event, runId });
    };
    if (input.signal?.aborted) { emit({ type: "run.cancelled", runId }); queue.close(); return queue; }
    void this.sdk.send({ runId, cwd: input.session.cwd, sessionId: input.session.sessionId, content: input.content, ...(input.model ? { model: input.model } : {}), ...(input.skills ? { skills: input.skills } : {}), ...(input.signal ? { signal: input.signal } : {}), onEvent: emit })
      .then(result => emit({ type: "run.completed", runId, result }), error => emit(input.signal?.aborted ? { type: "run.cancelled", runId } : { type: "run.failed", runId, error: error instanceof Error ? error.message : String(error) }))
      .finally(() => queue.close());
    return queue;
  }
  async cancelRun(input: { session: SessionReference; runId?: string }): Promise<void> { if (!this.sdk) throw new Error("Claude Agent SDK is unavailable"); await this.sdk.cancel({ sessionId: input.session.sessionId, ...(input.runId ? { runId: input.runId } : {}) }); }
  async resolveApproval(input: { approvalId: string; decision: "approved" | "denied" }): Promise<void> { if (!this.sdk?.resolveApproval) throw new Error("Claude approval bridge is unavailable"); await this.sdk.resolveApproval(input); }
  async dispose(): Promise<void> { await this.sdk?.dispose(); }
}

export { ClaudeHarnessAdapter as ClaudeAdapter };
