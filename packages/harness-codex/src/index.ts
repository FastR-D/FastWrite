import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { AsyncEventQueue, type HarnessAdapter, type HarnessCapabilities, type HarnessEvent, type HarnessStatus, type SendMessageInput, type SessionReference } from "@fastwrite/harness-core";

export interface CodexAdapterOptions { command?: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv; model?: string }
interface PendingRequest { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; }
interface CodexNotification { method?: string; params?: unknown }
interface ActiveRun {
  threadId: string;
  turnId?: string;
  cancelRequested: boolean;
  fail: (error: Error) => void;
}

export class CodexHarnessAdapter implements HarnessAdapter {
  readonly kind = "codex" as const;
  readonly #options: CodexAdapterOptions;
  #process: ChildProcessWithoutNullStreams | undefined = undefined;
  #initializing: Promise<void> | undefined = undefined;
  #nextId = 1;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #eventHandlers = new Set<(event: CodexNotification) => void>();
  readonly #runs = new Map<string, ActiveRun>();

  constructor(options: CodexAdapterOptions = {}) { this.#options = options; }
  async getStatus(): Promise<HarnessStatus> {
    if (this.#process) return { kind: "codex", state: "ready" };
    try {
      const result = await promisify(execFile)(this.#options.command ?? "codex", ["--version"], { timeout: 5_000 });
      const version = result.stdout.trim();
      return { kind: "codex", state: "ready", ...(version ? { version } : {}), message: "Codex CLI available" };
    } catch { return { kind: "codex", state: "unavailable", message: "Codex CLI is not installed or not executable" }; }
  }
  async getCapabilities(): Promise<HarnessCapabilities> { return { streaming: true, sessions: true, resume: true, approvals: true, skills: true, mcp: true }; }
  async createSession(input: { cwd: string; title?: string }): Promise<SessionReference> { await this.#ensureProcess(input.cwd); const result = await this.#request("thread/start", { cwd: input.cwd, ...(input.title ? { title: input.title } : {}) }) as { thread?: { id?: string } }; if (!result.thread?.id) throw new Error("Codex app-server did not return a thread id"); return { harness: "codex", sessionId: result.thread.id, cwd: input.cwd }; }
  async resumeSession(session: SessionReference): Promise<SessionReference> { await this.#ensureProcess(session.cwd); await this.#request("thread/resume", { threadId: session.sessionId }); return session; }
  sendMessage(input: SendMessageInput): AsyncIterable<HarnessEvent> {
    const queue = new AsyncEventQueue<HarnessEvent>();
    const runId = `run_${crypto.randomUUID()}`;
    queue.push({ type: "run.started", runId });
    void this.#run(input, runId, queue)
      .catch((error) => { queue.push({ type: "run.failed", runId, error: error instanceof Error ? error.message : String(error) }); })
      .finally(() => queue.close());
    return queue;
  }
  async cancelRun(input: { session: SessionReference; runId?: string }): Promise<void> {
    const run = input.runId ? this.#runs.get(input.runId) : undefined;
    if (!run || run.threadId !== input.session.sessionId) return;
    run.cancelRequested = true;
    if (run.turnId) await this.#request("turn/interrupt", { threadId: run.threadId, turnId: run.turnId });
  }
  async resolveApproval(input: { approvalId: string; decision: "approved" | "denied" }): Promise<void> {
    await this.#request("approval/resolve", { approvalId: input.approvalId, decision: input.decision });
  }
  async dispose(): Promise<void> {
    const child = this.#process;
    if (child) {
      this.#disconnect(child, new Error("Codex app-server disposed"));
      child.kill("SIGTERM");
    }
  }

  async #run(input: SendMessageInput, runId: string, queue: AsyncEventQueue<HarnessEvent>): Promise<void> {
    if (input.signal?.aborted) { queue.push({ type: "run.cancelled", runId }); return; }
    let finished = false;
    let finishTurn!: (event: HarnessEvent) => void;
    const turnFinished = new Promise<HarnessEvent>((resolve) => { finishTurn = resolve; });
    const settle = (event: HarnessEvent) => {
      if (finished) return;
      finished = true;
      finishTurn(event);
    };
    const run: ActiveRun = {
      threadId: input.session.sessionId,
      cancelRequested: false,
      fail: (error) => settle({ type: "run.failed", runId, error: error.message }),
    };
    const earlyEvents: CodexNotification[] = [];
    const handler = (event: CodexNotification) => {
      const params = asRecord(event.params);
      if (finished || params?.threadId !== run.threadId) return;
      const turn = asRecord(params.turn);
      const turnId = params.turnId ?? turn?.id;
      // Never broadcast events without a complete scope, including terminal events.
      if (typeof turnId !== "string" || !turnId) return;
      if (!run.turnId) {
        // Notifications may arrive before the turn/start response identifies our turn.
        earlyEvents.push(event);
        return;
      }
      if (turnId !== run.turnId) return;
      if (event.method === "item/agentMessage/delta") {
        if (typeof params.delta === "string" && params.delta) queue.push({ type: "assistant.delta", runId, text: params.delta });
      }
      if (event.method === "item/agentMessage" || event.method === "item/agentMessage/completed" || event.method === "item/completed") {
        const text = extractText(event.params);
        if (text) queue.push({ type: "assistant.delta", runId, text });
      }
      if (event.method === "item/toolCall" && typeof params.name === "string") {
        queue.push({ type: "tool.requested", runId, tool: params.name, input: params.input });
        if (params.requiresApproval === true || typeof params.approvalId === "string") queue.push({ type: "approval.requested", runId, approvalId: typeof params.approvalId === "string" ? params.approvalId : `approval_${crypto.randomUUID()}`, reason: `Approval required for Codex tool '${params.name}'` });
      }
      if (event.method === "error" && params.willRetry === false) {
        run.fail(new Error(extractText(params.error) || "Codex turn failed"));
      }
      if (event.method && /turn\/(completed|complete|failed|error|cancelled)$/.test(event.method)) {
        if (turn?.status === "failed" || /failed|error/.test(event.method)) {
          run.fail(new Error(extractText(turn?.error ?? params.error ?? params) || "Codex turn failed"));
        } else if (turn?.status === "interrupted" || event.method === "turn/cancelled") {
          settle({ type: "run.cancelled", runId });
        } else settle({ type: "run.completed", runId, result: event.params });
      }
    };
    const abort = () => { void this.cancelRun({ session: input.session, runId }).catch((error) => run.fail(error)); };
    const timer = setTimeout(() => run.fail(new Error("Codex turn timed out")), 120_000);
    this.#runs.set(runId, run);
    this.#eventHandlers.add(handler);
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      // Keep waiting for the response after an abort so we can interrupt the actual turn.
      const started = await this.#request("turn/start", { threadId: run.threadId, input: [{ type: "text", text: input.content }], ...((input.model ?? this.#options.model) ? { model: input.model ?? this.#options.model } : {}), ...(input.skills ? { skills: input.skills } : {}) });
      const turnId = asRecord(asRecord(started)?.turn)?.id;
      if (typeof turnId !== "string" || !turnId) throw new Error("Codex app-server did not return a turn id");
      run.turnId = turnId;
      for (const event of earlyEvents) handler(event);
      earlyEvents.length = 0;
      if (run.cancelRequested && !finished) await this.cancelRun({ session: input.session, runId });
      queue.push(await turnFinished);
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      this.#eventHandlers.delete(handler);
      this.#runs.delete(runId);
    }
  }

  async #ensureProcess(cwd: string): Promise<void> {
    if (this.#initializing) return this.#initializing;
    if (this.#process) return;
    const child = spawn(this.#options.command ?? "codex", this.#options.args ?? ["app-server"], { cwd: this.#options.cwd ?? cwd, env: { ...process.env, ...this.#options.env } });
    this.#process = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (this.#process !== child) return;
      let message: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } };
      try { message = JSON.parse(line); } catch { return; }
      if (!message || typeof message !== "object") return;
      if (typeof message.method === "string") {
        for (const handler of this.#eventHandlers) handler(message);
      } else if (typeof message.id === "number") {
        const pending = this.#pending.get(message.id);
        if (pending) {
          this.#pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(`Codex ${message.error.code ?? "RPC"}: ${message.error.message ?? "request failed"}`));
          else pending.resolve(message.result);
        }
      }
    });
    child.once("exit", () => this.#disconnect(child, new Error("Codex app-server exited")));
    child.once("error", (error) => this.#disconnect(child, error));
    child.stdin.on("error", (error) => this.#disconnect(child, error));
    const initializing = this.#request("initialize", { clientInfo: { name: "fastwrite", version: "0.1.0" } }).then(() => {
      if (this.#process !== child) throw new Error("Codex app-server exited during initialization");
      child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    });
    this.#initializing = initializing;
    try { await initializing; }
    catch (error) {
      this.#disconnect(child, error instanceof Error ? error : new Error(String(error)));
      child.kill("SIGTERM");
      throw error;
    } finally { if (this.#initializing === initializing) this.#initializing = undefined; }
  }

  #disconnect(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.#process !== child) return;
    this.#process = undefined;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const run of this.#runs.values()) run.fail(error);
  }

  #request(method: string, params: unknown): Promise<unknown> {
    const child = this.#process;
    if (!child) return Promise.reject(new Error("Codex app-server is unavailable"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, 120_000);
      this.#pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error || !this.#pending.delete(id)) return;
        clearTimeout(timer);
        reject(error);
      });
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(extractText).join("");
  const record = value as Record<string, unknown>;
  for (const key of ["text", "content", "output_text", "message", "item", "result"]) {
    const text = extractText(record[key]);
    if (text) return text;
  }
  return "";
}

export { CodexHarnessAdapter as CodexAdapter };
