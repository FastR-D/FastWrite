import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { AsyncEventQueue, type HarnessAdapter, type HarnessCapabilities, type HarnessEvent, type HarnessStatus, type SendMessageInput, type SessionReference } from "@fastwrite/harness-core";

export interface CodexAdapterOptions { command?: string; args?: string[]; cwd?: string; env?: NodeJS.ProcessEnv; model?: string }
interface PendingRequest { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; }

export class CodexHarnessAdapter implements HarnessAdapter {
  readonly kind = "codex" as const;
  readonly #options: CodexAdapterOptions;
  #process: ChildProcessWithoutNullStreams | undefined = undefined;
  #nextId = 1;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #eventHandlers = new Set<(event: { method?: string; params?: unknown }) => void>();

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
    void this.#run(input, queue).catch((error) => { queue.push({ type: "run.failed", runId: "unknown", error: error instanceof Error ? error.message : String(error) }); queue.close(); });
    return queue;
  }
  async cancelRun(input: { session: SessionReference; runId?: string }): Promise<void> { if (input.runId) await this.#request("turn/interrupt", { threadId: input.session.sessionId, turnId: input.runId }); }
  async resolveApproval(input: { approvalId: string; decision: "approved" | "denied" }): Promise<void> {
    await this.#request("approval/resolve", { approvalId: input.approvalId, decision: input.decision });
  }
  async dispose(): Promise<void> {
    this.#process?.kill("SIGTERM");
    this.#process = undefined;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex app-server disposed"));
    }
    this.#pending.clear();
  }

  async #run(input: SendMessageInput, queue: AsyncEventQueue<HarnessEvent>): Promise<void> {
    const runId = `run_${crypto.randomUUID()}`; queue.push({ type: "run.started", runId });
    let finishTurn: ((value: unknown) => void) | undefined;
    let failTurn: ((error: Error) => void) | undefined;
    const turnFinished = new Promise<unknown>((resolve, reject) => { finishTurn = resolve; failTurn = reject; });
    const handler = (event: { method?: string; params?: unknown }) => {
      if (event.method === "item/agentMessage/delta") { const text = typeof (event.params as { delta?: unknown })?.delta === "string" ? (event.params as { delta: string }).delta : ""; if (text) queue.push({ type: "assistant.delta", runId, text }); }
      if (event.method === "item/agentMessage" || event.method === "item/agentMessage/completed" || event.method === "item/completed") {
        const text = extractText(event.params);
        if (text) queue.push({ type: "assistant.delta", runId, text });
      }
      if (event.method === "item/toolCall") { const params = event.params as { name?: unknown; input?: unknown; approvalId?: unknown; requiresApproval?: unknown } | undefined; if (typeof params?.name === "string") { queue.push({ type: "tool.requested", runId, tool: params.name, input: params.input }); if (params.requiresApproval === true || typeof params.approvalId === "string") queue.push({ type: "approval.requested", runId, approvalId: typeof params.approvalId === "string" ? params.approvalId : `approval_${crypto.randomUUID()}`, reason: `Approval required for Codex tool '${params.name}'` }); } }
      if (event.method && /turn\/(completed|complete|failed|error|cancelled)$/.test(event.method)) {
        if (/failed|error/.test(event.method)) failTurn?.(new Error(extractText(event.params) || "Codex turn failed"));
        else finishTurn?.(event.params);
      }
    };
    this.#eventHandlers.add(handler);
    try {
      const started = await this.#request("turn/start", { threadId: input.session.sessionId, input: [{ type: "text", text: input.content }], ...((input.model ?? this.#options.model) ? { model: input.model ?? this.#options.model } : {}), ...(input.skills ? { skills: input.skills } : {}) }, input.signal);
      const result = await Promise.race([turnFinished, new Promise((_, reject) => setTimeout(() => reject(new Error("Codex turn timed out")), 120_000))]);
      queue.push({ type: "run.completed", runId, result: result ?? started }); queue.close();
    } finally { this.#eventHandlers.delete(handler); }
  }
  async #ensureProcess(cwd: string): Promise<void> { if (this.#process) return; const child = spawn(this.#options.command ?? "codex", this.#options.args ?? ["app-server"], { cwd: this.#options.cwd ?? cwd, env: { ...process.env, ...this.#options.env } }); this.#process = child; const lines = createInterface({ input: child.stdout }); lines.on("line", (line) => { try { const message = JSON.parse(line) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } }; if (typeof message.method === "string") for (const handler of this.#eventHandlers) handler(message); if (typeof message.id === "number") { const pending = this.#pending.get(message.id); if (pending) { this.#pending.delete(message.id); clearTimeout(pending.timer); if (message.error) pending.reject(new Error(`Codex ${message.error.code ?? "RPC"}: ${message.error.message ?? "request failed"}`)); else pending.resolve(message.result); } } } catch {} }); child.once("exit", () => { for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Codex app-server exited")); } this.#pending.clear(); this.#process = undefined; }); await this.#request("initialize", { clientInfo: { name: "fastwrite", version: "0.1.0" } }); }
  #request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> { const child = this.#process; if (!child) return Promise.reject(new Error("Codex app-server is unavailable")); const id = this.#nextId++; child.stdin.write(`${JSON.stringify({ id, method, params })}\n`); return new Promise((resolve, reject) => { let settled = false; const finish = (callback: () => void) => { if (settled) return; settled = true; signal?.removeEventListener("abort", abort); callback(); }; const abort = () => { const pending = this.#pending.get(id); if (!pending) return; clearTimeout(pending.timer); this.#pending.delete(id); finish(() => reject(new DOMException("Operation cancelled", "AbortError"))); }; if (signal?.aborted) return abort(); const timer = setTimeout(() => { this.#pending.delete(id); finish(() => reject(new Error(`Codex request timed out: ${method}`))); }, 120_000); signal?.addEventListener("abort", abort, { once: true }); this.#pending.set(id, { resolve: (value) => finish(() => resolve(value)), reject: (error) => finish(() => reject(error)), timer }); }); }
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
