import type { HarnessEvent, HarnessRegistry, HarnessRun, SessionReference, SkillInvocation } from "@fastwrite/harness-core";
import type { JsonDatabase } from "../storage/database";
import { harnessEventBus, type HarnessEventBus } from "./harness-event-bus";
import { createHash } from "node:crypto";

export class HarnessRunService {
  constructor(private readonly registry: HarnessRegistry, private readonly database: JsonDatabase, private readonly events: HarnessEventBus = harnessEventBus) {}
  list(): HarnessRun[] { return structuredClone(this.database.snapshot().harnessRuns); }
  get(runId: string): HarnessRun | undefined { const run = this.database.snapshot().harnessRuns.find((item) => item.id === runId); return run ? structuredClone(run) : undefined; }
  async start(input: { kind: "claude" | "codex" | "legacy"; session: SessionReference; skills?: SkillInvocation[] }): Promise<string> {
    const runId = `run_${crypto.randomUUID()}`;
    const skills = (input.skills ?? []).map((skill) => ({ ...skill, digest: skill.digest ?? createHash("sha256").update(`${skill.id}:${skill.version}:${skill.path}`).digest("hex") }));
    const now = new Date().toISOString();
    await this.database.mutate((state) => state.harnessRuns.push({ id: runId, session: input.session, status: "queued", skills: structuredClone(skills), events: [], approvals: [], createdAt: now, updatedAt: now }));
    return runId;
  }
  async *send(input: { kind: "claude" | "codex" | "legacy"; session: SessionReference; content: string; skills?: SkillInvocation[]; signal?: AbortSignal }): AsyncIterable<HarnessEvent> {
    const adapter = this.registry.get(input.kind);
    if (!adapter) throw new Error(`Harness '${input.kind}' is unavailable`);
    let runId: string | undefined;
    const skills = (input.skills ?? []).map((skill) => ({ ...skill, digest: skill.digest ?? createHash("sha256").update(`${skill.id}:${skill.version}:${skill.path}`).digest("hex") }));
    const queuedId = `run_${crypto.randomUUID()}`;
    const queuedAt = new Date().toISOString();
    await this.database.mutate((state) => state.harnessRuns.push({ id: queuedId, session: input.session, status: "queued", skills: structuredClone(skills), events: [], approvals: [], createdAt: queuedAt, updatedAt: queuedAt }));
    try { for await (const event of adapter.sendMessage(input)) {
      runId ??= event.runId;
      await this.database.mutate((state) => {
        let run = state.harnessRuns.find((item) => item.id === runId) ?? state.harnessRuns.find((item) => item.id === queuedId);
        if (run && run.id !== runId) run.id = runId!;
        if (!run) { const now = new Date().toISOString(); run = { id: runId!, session: input.session, status: "running", skills: structuredClone(skills), events: [], approvals: [], createdAt: now, updatedAt: now }; state.harnessRuns.push(run); }
        run.events.push(structuredClone(event));
        if (run.events.length > 2000) run.events.splice(0, run.events.length - 2000);
        run.updatedAt = new Date().toISOString();
        if (event.type === "run.completed") run.status = "completed";
        if (event.type === "run.failed") run.status = "failed";
        if (event.type === "run.cancelled") run.status = "cancelled";
        if (event.type === "approval.requested" && !run.approvals.some((item) => item.id === event.approvalId)) {
          const createdAt = new Date().toISOString();
          run.approvals.push({ id: event.approvalId, runId: event.runId, status: "pending", reason: event.reason, createdAt, updatedAt: createdAt });
        }
      });
      this.events.publish(event);
      yield event;
    } } catch (error) { await this.database.mutate((state) => { const run = state.harnessRuns.find((item) => item.id === (runId ?? queuedId)); if (run) { run.status = input.signal?.aborted ? "cancelled" : "failed"; run.updatedAt = new Date().toISOString(); } }); throw error; }
  }
  listApprovals(runId?: string) { return this.database.snapshot().harnessRuns.flatMap((run) => run.approvals ?? []).filter((item) => !runId || item.runId === runId).map((item) => structuredClone(item)); }
  async decideApproval(approvalId: string, decision: "approved" | "denied") {
    return this.database.mutate((state) => {
      const approval = state.harnessRuns.flatMap((run) => run.approvals ?? []).find((item) => item.id === approvalId);
      if (!approval) return undefined;
      if (approval.status !== "pending") throw new Error("approval_already_decided");
      approval.status = decision; approval.updatedAt = new Date().toISOString();
      return approval;
    });
  }

  async resolveApproval(approvalId: string, decision: "approved" | "denied") {
    const approval = this.listApprovals().find((item) => item.id === approvalId);
    if (!approval) return undefined;
    const adapter = this.registry.get((this.get(approval.runId)?.session.harness) ?? "legacy");
    if (adapter?.resolveApproval) await adapter.resolveApproval({ approvalId, decision });
    return this.decideApproval(approvalId, decision);
  }
}
