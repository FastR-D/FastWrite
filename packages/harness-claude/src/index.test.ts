import { expect, test } from "bun:test";
import { ClaudeHarnessAdapter, type ClaudeSdkBridge } from "./index";

test("Claude adapter forwards skills and streams SDK events", async () => {
  let receivedSkills = 0;
  let cancelled = false;
  const bridge: ClaudeSdkBridge = {
    async createSession() { return "session-1"; },
    async resumeSession() {},
    async send(input) { receivedSkills = input.skills?.length ?? 0; input.onEvent({ type: "run.started", runId: "run-1" }); input.onEvent({ type: "assistant.delta", runId: "run-1", text: "draft" }); },
    async cancel() { cancelled = true; },
    async dispose() {}
  };
  const adapter = new ClaudeHarnessAdapter(bridge);
  const session = await adapter.createSession({ cwd: "/tmp" });
  const events = [];
  for await (const event of adapter.sendMessage({ session, content: "Write", skills: [{ id: "draft", name: "draft", path: "/skills/draft", version: "1" }] })) events.push(event);
  expect(receivedSkills).toBe(1);
  expect(events).toHaveLength(2);
  await adapter.cancelRun({ session, runId: "run-1" });
  expect(cancelled).toBe(true);
});

test("Claude adapter forwards approval decisions", async () => {
  let decision = "";
  const bridge: ClaudeSdkBridge = {
    async createSession() { return "session-1"; }, async resumeSession() {}, async send() {}, async cancel() {},
    async resolveApproval(input) { decision = `${input.approvalId}:${input.decision}`; }, async dispose() {}
  };
  const adapter = new ClaudeHarnessAdapter(bridge);
  await adapter.resolveApproval({ approvalId: "approval-1", decision: "approved" });
  expect(decision).toBe("approval-1:approved");
});
