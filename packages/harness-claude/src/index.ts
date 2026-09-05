import { AsyncEventQueue, type HarnessAdapter, type HarnessCapabilities, type HarnessEvent, type HarnessStatus, type SendMessageInput, type SessionReference } from "@fastwrite/harness-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface ClaudeSdkBridge {
  createSession(input: { cwd: string; title?: string }): Promise<string>;
  resumeSession(input: { sessionId: string; cwd: string }): Promise<void>;
  send(input: { sessionId: string; content: string; model?: string; skills?: SendMessageInput["skills"]; onEvent: (event: HarnessEvent) => void; signal?: AbortSignal }): Promise<unknown>;
  cancel(input: { sessionId: string; runId?: string }): Promise<void>;
  resolveApproval?(input: { approvalId: string; decision: "approved" | "denied" }): Promise<void>;
  dispose(): Promise<void>;
}

export class ClaudeHarnessAdapter implements HarnessAdapter {
  readonly kind = "claude" as const;
  constructor(private readonly sdk?: ClaudeSdkBridge) {}
  async getStatus(): Promise<HarnessStatus> {
    if (this.sdk) return { kind: "claude", state: "ready", message: "Claude Agent SDK available" };
    try {
      const result = await promisify(execFile)("claude", ["--version"], { timeout: 5_000 });
      const version = result.stdout.trim();
      return { kind: "claude", state: "ready", ...(version ? { version } : {}), message: "Claude CLI available" };
    } catch { return { kind: "claude", state: "unavailable", message: "Claude CLI is not installed or not executable" }; }
  }
  async getCapabilities(): Promise<HarnessCapabilities> { return { streaming: true, sessions: true, resume: true, approvals: true, skills: true, mcp: true }; }
  async createSession(input: { cwd: string; title?: string }): Promise<SessionReference> { if (!this.sdk) throw new Error("Claude Agent SDK is unavailable"); return { harness: "claude", sessionId: await this.sdk.createSession(input), cwd: input.cwd }; }
  async resumeSession(session: SessionReference): Promise<SessionReference> { if (!this.sdk) throw new Error("Claude Agent SDK is unavailable"); await this.sdk.resumeSession({ sessionId: session.sessionId, cwd: session.cwd }); return session; }
  sendMessage(input: SendMessageInput): AsyncIterable<HarnessEvent> { const queue = new AsyncEventQueue<HarnessEvent>(); if (!this.sdk) { queue.push({ type: "run.failed", runId: "unavailable", error: "Claude Agent SDK is unavailable" }); queue.close(); return queue; } void this.sdk.send({ sessionId: input.session.sessionId, content: input.content, ...(input.model ? { model: input.model } : {}), ...(input.skills ? { skills: input.skills } : {}), ...(input.signal ? { signal: input.signal } : {}), onEvent: (event) => queue.push(event) }).then(() => queue.close(), (error) => { queue.push({ type: "run.failed", runId: "unknown", error: error instanceof Error ? error.message : String(error) }); queue.close(); }); return queue; }
  async cancelRun(input: { session: SessionReference; runId?: string }): Promise<void> { if (!this.sdk) throw new Error("Claude Agent SDK is unavailable"); await this.sdk.cancel({ sessionId: input.session.sessionId, ...(input.runId ? { runId: input.runId } : {}) }); }
  async resolveApproval(input: { approvalId: string; decision: "approved" | "denied" }): Promise<void> { if (!this.sdk?.resolveApproval) throw new Error("Claude approval bridge is unavailable"); await this.sdk.resolveApproval(input); }
  async dispose(): Promise<void> { await this.sdk?.dispose(); }
}

export { ClaudeHarnessAdapter as ClaudeAdapter };
