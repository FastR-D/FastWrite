import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExperimentRunner } from "../apps/server/src/experiments/experiment-runner";
import type { WorkspaceService } from "../apps/server/src/workspace/workspace-service";

const root = await mkdtemp(join(tmpdir(), "fastwrite-experiment-sandbox-"));
try {
  const marker = join(root, "outside-marker");
  await writeFile(marker, "synthetic host-only fixture");
  const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
  const workspaces = {
    async copySnapshot(_id: string, source: string) {
      await mkdir(join(source, "scripts"), { recursive: true });
      await writeFile(join(source, "scripts/check.sh"), `#!/bin/sh
set -eu
# Probe visibility only; never signal or modify a host process.
if test -e ${quote(`/proc/${process.pid}/root${marker}`)}; then echo host-root-visible; exit 91; fi
if test -e ${quote(marker)}; then echo host-file-visible; exit 92; fi
if (echo forbidden > /workspace/changed-source) 2>/dev/null; then exit 93; fi
echo isolated > "$FASTWRITE_EXPERIMENT_OUTPUT/result.txt"
ln -s ${quote(marker)} "$FASTWRITE_EXPERIMENT_OUTPUT/host-link"
mkfifo "$FASTWRITE_EXPERIMENT_OUTPUT/pipe"
`);
      return { mainDocument: "main.tex", projectVersion: 1 };
    }
  } as unknown as WorkspaceService;
  const result = await new ExperimentRunner(root, workspaces).run({ projectId: "fixture", scriptPath: "scripts/check.sh", authorization: "user-approved", timeoutMs: 10_000 });
  assert.ok(result.success, result.log);
  assert.deepEqual(result.artifactPaths, [".fastwrite-experiment-output/result.txt"]);
  assert.equal(await readFile(join(root, "experiments", result.runId, "source", result.artifactPaths[0]!), "utf8"), "isolated\n");
  console.log("PASS: experiment sandbox isolates host processes, protects inputs, and rejects unsafe artifacts");
} finally { await rm(root, { recursive: true, force: true }); }
