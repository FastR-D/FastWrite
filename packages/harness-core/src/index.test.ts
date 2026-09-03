import { describe, expect, test } from "bun:test";
import { AsyncEventQueue, HarnessRegistry, type HarnessAdapter } from "./index";

describe("harness core", () => {
  test("queues events for async consumers", async () => {
    const queue = new AsyncEventQueue<number>();
    queue.push(1);
    queue.close();
    const values: number[] = [];
    for await (const value of queue) values.push(value);
    expect(values).toEqual([1]);
  });

  test("registers adapters and reports status", async () => {
    const adapter: HarnessAdapter = {
      kind: "legacy",
      async getStatus() { return { kind: "legacy", state: "ready" }; },
      async getCapabilities() { return { streaming: false, sessions: false, resume: false, approvals: false, skills: false, mcp: false }; },
      async createSession() { return { harness: "legacy", sessionId: "test", cwd: "/tmp" }; },
      async resumeSession(session) { return session; },
      async *sendMessage() { yield { type: "run.completed", runId: "run" }; },
      async cancelRun() {},
      async dispose() {}
    };
    const registry = new HarnessRegistry();
    registry.register(adapter);
    expect(await registry.status()).toEqual([{ kind: "legacy", state: "ready" }]);
  });
});
