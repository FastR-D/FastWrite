import { expect, test } from "bun:test";
import type { HarnessEvent, HarnessSession } from "./index";

test("protocol exports shared session and event contracts", () => {
  const session: HarnessSession = { harness: "legacy", sessionId: "session-1", cwd: "/tmp", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const event: HarnessEvent = { type: "run.started", runId: "run-1" };
  expect(session.sessionId).toBe("session-1");
  expect(event.type).toBe("run.started");
});
