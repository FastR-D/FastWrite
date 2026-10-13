import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { HarnessStatus } from "@fastwrite/harness-core";
import type { ClaudeSdkBridge } from "./index";

export interface ClaudeCliOptions { command?: string; args?: string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number; }

/** Protocol: https://code.claude.com/docs/en/headless#stream-responses */
export class ClaudeCliBridge implements ClaudeSdkBridge {
  private readonly sessions = new Map<string, { cwd: string; started: boolean }>();
  private readonly active = new Map<string, { runId: string; cancel: () => void; done: Promise<void> }>();
  constructor(private readonly options: ClaudeCliOptions = {}) {}

  async getStatus(): Promise<HarnessStatus> {
    try {
      const { stdout } = await promisify(execFile)(this.options.command ?? "claude", [...(this.options.args ?? []), "--version"], { timeout: 5000, windowsHide: true, env: { ...process.env, ...this.options.env }, maxBuffer: 128_000 });
      const version = stdout.trim(); const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)/.exec(version);
      if (!match || Number(match[1]) < 2 || Number(match[1]) === 2 && (Number(match[2]) < 1 || Number(match[2]) === 1 && Number(match[3]) < 286)) return { kind: "claude", state: "degraded", version, message: "Claude CLI 2.1.286 or newer is required for isolated bare-mode execution" };
      return { kind: "claude", state: "ready", version, message: "Claude CLI bridge available (bare mode; provider credentials required)" };
    } catch { return { kind: "claude", state: "unavailable", message: "Claude CLI is not installed or not executable" }; }
  }

  async createSession(input: { cwd: string }): Promise<string> {
    const status = await this.getStatus(); if (status.state !== "ready") throw new Error(status.message);
    const cwd = resolve(input.cwd); if (!(await stat(cwd)).isDirectory()) throw new Error("Claude working directory is not a directory");
    const id = crypto.randomUUID(); this.sessions.set(id, { cwd, started: false }); return id;
  }
  async resumeSession(input: { sessionId: string; cwd: string }): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.sessionId)) throw new Error("Invalid Claude session ID");
    const cwd = resolve(input.cwd); if (!(await stat(cwd)).isDirectory()) throw new Error("Claude working directory is not a directory");
    const existing = this.sessions.get(input.sessionId);
    if (existing && existing.cwd !== cwd) throw new Error("Claude session belongs to another working directory");
    if (!existing) this.sessions.set(input.sessionId, { cwd, started: true });
  }

  async send(input: Parameters<ClaudeSdkBridge["send"]>[0]): Promise<unknown> {
    if (input.skills?.length) throw new Error("CLI bridge does not load skills; include reviewed instructions in the prompt or configure an SDK bridge");
    if (!this.sessions.has(input.sessionId) && input.cwd) await this.resumeSession({ sessionId: input.sessionId, cwd: input.cwd });
    const session = this.sessions.get(input.sessionId);
    if (!session) throw new Error("Create or resume the Claude session before sending");
    if (input.cwd && session.cwd !== resolve(input.cwd)) throw new Error("Claude session belongs to another working directory");
    if (this.active.has(input.sessionId)) throw new Error("A Claude turn is already running in this session");
    input.signal?.throwIfAborted();
    const runId = input.runId ?? `run_${crypto.randomUUID()}`;
    const args = [...(this.options.args ?? []), "--bare", "--print", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--tools", "", "--disallowedTools", "mcp__*", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--permission-mode", "dontAsk", session.started ? "--resume" : "--session-id", input.sessionId, ...(input.model ? ["--model", input.model] : [])];
    const child: ChildProcessWithoutNullStreams = spawn(this.options.command ?? "claude", args, { cwd: session.cwd, env: { ...process.env, ...this.options.env }, windowsHide: true, stdio: "pipe" });
    let cancelled = false; let timedOut = false; let killTimer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => { if (cancelled) return; cancelled = true; child.kill("SIGTERM"); killTimer = setTimeout(() => child.kill("SIGKILL"), 1000); };
    const timeout = setTimeout(() => { timedOut = true; cancel(); }, this.options.timeoutMs ?? 300_000);
    input.signal?.addEventListener("abort", cancel, { once: true });
    if (input.signal?.aborted) cancel();
    let pending = ""; let stderr = ""; let textEmitted = false; let partial = false;
    let result: { is_error?: boolean; result?: string; subtype?: string; errors?: string[] } | undefined;
    let protocolError: Error | undefined;
    const parse = (line: string) => {
      if (!line.trim()) return;
      try {
        const message = JSON.parse(line);
        if (message.session_id && message.session_id !== input.sessionId) throw new Error("Claude returned a different session ID");
        if (message.parent_tool_use_id) return;
        if (message.type === "system" && message.subtype === "init") session.started = true;
        if (message.type === "stream_event" && message.event?.delta?.type === "text_delta") { partial = true; textEmitted = true; input.onEvent({ type: "assistant.delta", runId, text: message.event.delta.text }); }
        if (message.type === "assistant" && !partial) for (const block of message.message?.content ?? []) if (block.type === "text") { textEmitted = true; input.onEvent({ type: "assistant.delta", runId, text: block.text }); }
        if (message.type === "result") result = message;
      } catch (error) { protocolError = error instanceof Error ? error : new Error("Invalid Claude stream"); cancel(); }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      if (pending.length > 2_000_000) { protocolError = new Error("Claude stream record exceeded size limit"); cancel(); return; }
      let newline: number; while ((newline = pending.indexOf("\n")) >= 0) { const line = pending.slice(0, newline); pending = pending.slice(newline + 1); parse(line); }
    });
    child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    child.stdin.on("error", () => undefined);
    const finished = new Promise<void>((resolveFinished, reject) => {
      child.once("error", reject);
      child.once("close", code => {
        if (pending.trim()) parse(pending);
        if (protocolError) return reject(protocolError);
        if (timedOut) return reject(new Error("Claude CLI timed out"));
        if (cancelled) { input.onEvent({ type: "run.cancelled", runId }); resolveFinished(); return; }
        if (code !== 0 || !result || result.is_error) return reject(new Error(result?.result || result?.errors?.join("; ") || stderr || `Claude CLI exited without a successful result (${code})`));
        session.started = true;
        if (!textEmitted && result.result) input.onEvent({ type: "assistant.delta", runId, text: result.result });
        input.onEvent({ type: "run.completed", runId, result: result.result }); resolveFinished();
      });
    });
    this.active.set(input.sessionId, { runId, cancel, done: finished.catch(() => undefined) });
    child.stdin.end(input.content);
    try { await finished; return result?.result; }
    finally { clearTimeout(timeout); clearTimeout(killTimer); input.signal?.removeEventListener("abort", cancel); this.active.delete(input.sessionId); }
  }
  async cancel(input: { sessionId: string; runId?: string }): Promise<void> {
    const active = this.active.get(input.sessionId); if (!active || input.runId && active.runId !== input.runId) return;
    active.cancel(); await active.done;
  }
  async dispose(): Promise<void> { await Promise.all([...this.active.values()].map(async run => { run.cancel(); await run.done; })); this.sessions.clear(); }
}
