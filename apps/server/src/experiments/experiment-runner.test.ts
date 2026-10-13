import { expect, test } from "bun:test";
import { ExperimentRunner } from "./experiment-runner";
import type { WorkspaceService } from "../workspace/workspace-service";

test("invalid resource limits are rejected before snapshot creation or process execution", async () => {
  let copied = false;
  const workspaces = { copySnapshot: async () => { copied = true; throw new Error("must not copy"); } } as unknown as WorkspaceService;
  const runner = new ExperimentRunner("unused-fixture", workspaces);
  for (const key of ["cpuSeconds", "memoryLimitMb", "timeoutMs"]) for (const value of [NaN, Infinity, "512", null]) {
    await expect(runner.run({ projectId: "fixture", scriptPath: "scripts/check.sh", authorization: "user-approved", [key]: value } as any)).rejects.toMatchObject({ code: "experiment_limit_invalid" });
  }
  expect(copied).toBe(false);
});
