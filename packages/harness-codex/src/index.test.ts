import { afterEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import type { HarnessEvent, SessionReference } from "@fastwrite/harness-core";
import { CodexHarnessAdapter } from "./index";

const adapters: CodexHarnessAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose())); });

function createAdapter(scenario: string): CodexHarnessAdapter {
  const adapter = new CodexHarnessAdapter({
    command: process.execPath,
    args: [fileURLToPath(new URL("./fixtures/app-server.mjs", import.meta.url))],
    env: { CODEX_TEST_SCENARIO: scenario },
  });
  adapters.push(adapter);
  return adapter;
}

async function collect(events: AsyncIterable<HarnessEvent>): Promise<HarnessEvent[]> {
  const result: HarnessEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function text(events: HarnessEvent[]): string {
  return events.flatMap((event) => event.type === "assistant.delta" ? [event.text] : []).join("");
}

function expectTerminal(events: HarnessEvent[], type: HarnessEvent["type"]): void {
  expect(events[0]?.type).toBe("run.started");
  expect(events.at(-1)?.type).toBe(type);
  expect(events.filter((event) => ["run.completed", "run.failed", "run.cancelled"].includes(event.type))).toHaveLength(1);
  expect(new Set(events.map((event) => event.runId)).size).toBe(1);
}

async function pair(scenario: string, sameThread = false): Promise<[HarnessEvent[], HarnessEvent[]]> {
  const adapter = createAdapter(scenario);
  const a = await adapter.createSession({ cwd: process.cwd() });
  const b = sameThread ? a : await adapter.createSession({ cwd: process.cwd() });
  return await Promise.all([
    collect(adapter.sendMessage({ session: a, content: "A" })),
    collect(adapter.sendMessage({ session: b, content: "B" })),
  ]);
}

test("concurrent sessions isolate text, tools, approvals and completion", async () => {
  const [a, b] = await pair("interleaved");
  expect(text(a)).toBe("A1");
  expect(text(b)).toBe("B1B2B3");
  for (const [events, owner] of [[a, "A"], [b, "B"]] as const) {
    expect(events.filter((event) => event.type === "tool.requested").map((event) => event.tool)).toEqual([`tool-${owner}`]);
    expect(events.filter((event) => event.type === "approval.requested").map((event) => event.approvalId)).toEqual([`approval-${owner}`]);
    expectTerminal(events, "run.completed");
  }
  expect(a[0]?.runId).not.toBe(b[0]?.runId);
});

test("turn IDs isolate overlapping requests on the same thread", async () => {
  const [a, b] = await pair("interleaved", true);
  expect(text(a)).toBe("A1");
  expect(text(b)).toBe("B1B2B3");
  expectTerminal(a, "run.completed");
  expectTerminal(b, "run.completed");
});

test("old and unscoped events are ignored when a session is reused", async () => {
  const adapter = createAdapter("reuse");
  const session = await adapter.createSession({ cwd: process.cwd() });
  for (let turn = 1; turn <= 2; turn++) {
    const events = await collect(adapter.sendMessage({ session, content: "next" }));
    expect(text(events)).toBe(`TEXT-${turn}`);
    expectTerminal(events, "run.completed");
  }
});

test("one turn failing does not fail or finish another session", async () => {
  const [a, b] = await pair("failure");
  expectTerminal(a, "run.failed");
  expect(a.at(-1)).toMatchObject({ error: "A failed" });
  expect(text(b)).toBe("B1B2B3");
  expectTerminal(b, "run.completed");
});

test("one turn being interrupted does not cancel another session", async () => {
  const [a, b] = await pair("interrupted");
  expectTerminal(a, "run.cancelled");
  expect(text(b)).toBe("B1B2B3");
  expectTerminal(b, "run.completed");
});

test("a scoped fatal error does not affect another session or treat retries as failures", async () => {
  const [a, b] = await pair("error");
  expectTerminal(a, "run.failed");
  expect(a.at(-1)).toMatchObject({ error: "A failed" });
  expect(text(a)).toBe("A1");
  expect(text(b)).toBe("B1B2B3");
  expectTerminal(b, "run.completed");
});

test("a rejected start keeps the original run ID", async () => {
  const adapter = createAdapter("rpc-error");
  const session = await adapter.createSession({ cwd: process.cwd() });
  const events = await collect(adapter.sendMessage({ session, content: "start" }));
  expectTerminal(events, "run.failed");
  expect(events.at(-1)).toMatchObject({ error: "Codex RPC: Start rejected" });
});

test("a start response without a turn ID fails instead of accepting arbitrary events", async () => {
  const adapter = createAdapter("missing-turn");
  const session = await adapter.createSession({ cwd: process.cwd() });
  const events = await collect(adapter.sendMessage({ session, content: "start" }));
  expectTerminal(events, "run.failed");
  expect(events.at(-1)).toMatchObject({ error: "Codex app-server did not return a turn id" });
});

test("simultaneous session creation waits for initialization", async () => {
  const adapter = createAdapter("initialization");
  const sessions = await Promise.all([
    adapter.createSession({ cwd: process.cwd() }),
    adapter.createSession({ cwd: process.cwd() }),
  ]);
  expect(new Set(sessions.map((session) => session.sessionId)).size).toBe(2);
});

async function readyRun(adapter: CodexHarnessAdapter, session: SessionReference, signal?: AbortSignal) {
  const iterator = adapter.sendMessage({ session, content: "wait", ...(signal ? { signal } : {}) })[Symbol.asyncIterator]();
  const started = await iterator.next();
  const ready = await iterator.next();
  expect(ready.value?.type).toBe("assistant.delta");
  return { runId: (started.value as HarnessEvent).runId, remaining: collect({ [Symbol.asyncIterator]: () => iterator }) };
}

test("cancelling a local run interrupts only its corresponding upstream turn", async () => {
  const adapter = createAdapter("cancel");
  const a = await adapter.createSession({ cwd: process.cwd() });
  const b = await adapter.createSession({ cwd: process.cwd() });
  const runA = await readyRun(adapter, a);
  const runB = await readyRun(adapter, b);
  await adapter.cancelRun({ session: b, runId: runA.runId });
  await adapter.cancelRun({ session: a, runId: runA.runId });
  expect(await runA.remaining).toEqual([{ type: "run.cancelled", runId: runA.runId }]);
  const surviving = await runB.remaining;
  expect(text(surviving)).toBe("SURVIVED");
  expect(surviving.at(-1)?.type).toBe("run.completed");
});

test("an already aborted input never starts a turn", async () => {
  const adapter = createAdapter("rpc-error");
  const session = await adapter.createSession({ cwd: process.cwd() });
  const events = await collect(adapter.sendMessage({ session, content: "start", signal: AbortSignal.abort() }));
  expectTerminal(events, "run.cancelled");
  expect(events).toHaveLength(2);
});

test("abort before the start response interrupts the eventual turn", async () => {
  const adapter = createAdapter("cancel-early");
  const session = await adapter.createSession({ cwd: process.cwd() });
  const controller = new AbortController();
  const events = collect(adapter.sendMessage({ session, content: "start", signal: controller.signal }));
  controller.abort();
  expectTerminal(await events, "run.cancelled");
});

test("abort during streaming cancels only the corresponding session", async () => {
  const adapter = createAdapter("cancel");
  const a = await adapter.createSession({ cwd: process.cwd() });
  const b = await adapter.createSession({ cwd: process.cwd() });
  const controller = new AbortController();
  const runA = await readyRun(adapter, a, controller.signal);
  const runB = await readyRun(adapter, b);
  controller.abort();
  expect(await runA.remaining).toEqual([{ type: "run.cancelled", runId: runA.runId }]);
  expect(text(await runB.remaining)).toBe("SURVIVED");
});

test("process exit closes an active run with its original ID", async () => {
  const adapter = createAdapter("exit");
  const session = await adapter.createSession({ cwd: process.cwd() });
  const events = await collect(adapter.sendMessage({ session, content: "start" }));
  expectTerminal(events, "run.failed");
  expect(events.at(-1)).toMatchObject({ error: "Codex app-server exited" });
});

test("disposing the adapter closes all active streams", async () => {
  const adapter = createAdapter("dispose");
  const session = await adapter.createSession({ cwd: process.cwd() });
  const run = await readyRun(adapter, session);
  await adapter.dispose();
  expect(await run.remaining).toEqual([{ type: "run.failed", runId: run.runId, error: "Codex app-server disposed" }]);
});
