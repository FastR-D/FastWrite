import { afterEach, describe, expect, test } from "bun:test";
import { runAgentOperation } from "./agent-operation";

const originalTimeout = process.env.FASTWRITE_AGENT_TIMEOUT_MS;

afterEach(() => {
  if (originalTimeout === undefined) delete process.env.FASTWRITE_AGENT_TIMEOUT_MS;
  else process.env.FASTWRITE_AGENT_TIMEOUT_MS = originalTimeout;
});

describe("Agent operation boundary", () => {
  test("rejects an already-cancelled request before accepting late output", async () => {
    const controller = new AbortController();
    controller.abort();
    let completed = false;
    const result = runAgentOperation(async () => { completed = true; return "late"; }, { signal: controller.signal, label: "Agent test" });
    await expect(result).rejects.toMatchObject({ status: 499, code: "agent_cancelled" });
    expect(completed).toBe(false);
  });

  test("enforces the configured deadline", async () => {
    process.env.FASTWRITE_AGENT_TIMEOUT_MS = "1000";
    const started = performance.now();
    await expect(runAgentOperation(() => new Promise<never>(() => undefined), { label: "Agent test" })).rejects.toMatchObject({ status: 504, code: "agent_timeout" });
    expect(performance.now() - started).toBeGreaterThanOrEqual(900);
  });
});
