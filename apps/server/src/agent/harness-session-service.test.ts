import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessSessionService } from "./harness-session-service";
import type { HarnessAdapter } from "@fastwrite/harness-core";
import { JsonDatabase } from "../storage/database";

describe("HarnessSessionService", () => {
  test("persists created and resumed sessions", async () => {
    const database = new JsonDatabase(await mkdtemp(join(tmpdir(), "fastwrite-session-")));
    await database.initialize();
    const adapter = { kind: "codex", async createSession(input: { cwd: string }) { return { harness: "codex" as const, sessionId: "thread-1", cwd: input.cwd }; }, async resumeSession(session: { harness: "codex"; sessionId: string; cwd: string }) { return session; } } as unknown as HarnessAdapter;
    const service = new HarnessSessionService(database);
    const created = await service.create(adapter, { cwd: "/tmp/paper", title: "Paper" });
    expect(created.sessionId).toBe("thread-1");
    const resumed = await service.resume(adapter, created);
    expect(resumed.resumedAt).toBeString();
    expect(service.list()).toHaveLength(1);
  });
});
