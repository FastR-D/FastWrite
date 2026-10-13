import { expect, test } from "bun:test";
import { ClaudeHarnessAdapter, ClaudeCliBridge, type ClaudeSdkBridge } from "./index";
import { fileURLToPath } from "node:url";
import type { HarnessEvent } from "@fastwrite/harness-core";

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
  expect(events).toHaveLength(3);
  expect(events.at(-1)?.type).toBe("run.completed");
  await adapter.cancelRun({ session, runId: "run-1" });
  expect(cancelled).toBe(true);
});

function cli() { return new ClaudeHarnessAdapter(new ClaudeCliBridge({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/claude-cli.mjs", import.meta.url))] })); }
async function collect(events: AsyncIterable<HarnessEvent>) { const values: HarnessEvent[] = []; for await (const event of events) values.push(event); return values; }
const text = (events: HarnessEvent[]) => events.flatMap(event => event.type === "assistant.delta" ? [event.text] : []).join("");

test("CLI bridge creates, resumes and isolates concurrent sessions without duplicate streamed text", async () => {
  const adapter = cli();
  try {
    expect((await adapter.getStatus()).state).toBe("ready");
    expect(await adapter.getCapabilities()).toMatchObject({ approvals: false, mcp: false, skills: false });
    const a = await adapter.createSession({ cwd: process.cwd() }); const b = await adapter.createSession({ cwd: process.cwd() });
    const [first, second] = await Promise.all([collect(adapter.sendMessage({ session: a, content: "A" })), collect(adapter.sendMessage({ session: b, content: "B" }))]);
    expect(text(first)).toBe("new:A"); expect(text(second)).toBe("new:B");
    expect(first[0]?.runId).not.toBe(second[0]?.runId);
    for (const events of [first, second]) { expect(new Set(events.map(event => event.runId)).size).toBe(1); expect(events.at(-1)?.type).toBe("run.completed"); }
    await adapter.resumeSession(a);
    expect(text(await collect(adapter.sendMessage({ session: a, content: "A2" })))).toBe("resume:A2");
    await expect(adapter.resumeSession({ ...a, cwd: "/missing-working-directory" })).rejects.toThrow();
  } finally { await adapter.dispose(); }
});

test.each(["failure", "malformed"])("CLI failures terminate one run with its own identifier: %s", async content => {
  const adapter = cli();
  try {
    const session = await adapter.createSession({ cwd: process.cwd() });
    const events = await collect(adapter.sendMessage({ session, content }));
    expect(events[0]?.type).toBe("run.started"); expect(events.at(-1)?.type).toBe("run.failed");
    expect(new Set(events.map(event => event.runId)).size).toBe(1);
    expect(events.filter(event => event.type === "run.failed")).toHaveLength(1);
  } finally { await adapter.dispose(); }
});

test("CLI cancellation stops the selected process and closes its event stream", async () => {
  const adapter = cli(); const controller = new AbortController();
  try {
    const session = await adapter.createSession({ cwd: process.cwd() }); const events: HarnessEvent[] = [];
    for await (const event of adapter.sendMessage({ session, content: "wait", signal: controller.signal })) { events.push(event); if (event.type === "assistant.delta") controller.abort(); }
    expect(events.at(-1)?.type).toBe("run.cancelled");
    expect(events.filter(event => event.type === "run.completed")).toHaveLength(0);
  } finally { await adapter.dispose(); }
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
