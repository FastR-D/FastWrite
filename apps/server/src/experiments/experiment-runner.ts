import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiError } from "../http";
import type { WorkspaceService } from "../workspace/workspace-service";

export interface ExperimentRequest { projectId: string; scriptPath: string; authorization: "user-approved"; timeoutMs?: number; memoryLimitMb?: number; cpuSeconds?: number; }
export interface ExperimentResult { success: boolean; exitCode: number; log: string; artifactPaths: string[]; inputSnapshotHash: string; runId: string; }

export class ExperimentRunner {
  constructor(private readonly dataDirectory: string, private readonly workspaces: WorkspaceService) {}
  async run(request: ExperimentRequest): Promise<ExperimentResult> {
    if (request.authorization !== "user-approved") throw new ApiError(403, "experiment_authorization_required", "Experiment execution requires explicit user authorization.");
    if (!/^(?:scripts|experiments)\/[A-Za-z0-9._/-]+\.(?:sh|py|js|mjs)$/.test(request.scriptPath) || request.scriptPath.includes("..")) throw new ApiError(400, "experiment_script_invalid", "Only project-local scripts under scripts/ or experiments/ may run.");
    const runId = crypto.randomUUID();
    const root = join(this.dataDirectory, "experiments", runId, "source");
    const snapshot = await this.workspaces.copySnapshot(request.projectId, root);
    const inputSnapshotHash = await this.hashSnapshot(root);
    const script = join(root, request.scriptPath);
    const timeoutMs = Math.min(Math.max(request.timeoutMs ?? 60_000, 1_000), 300_000);
    const memoryLimitMb = Math.min(Math.max(request.memoryLimitMb ?? 512, 64), 2_048);
    const cpuSeconds = Math.min(Math.max(request.cpuSeconds ?? Math.ceil(timeoutMs / 1000), 1), 300);
    const command = this.commandFor(script);
    const bwrap = Bun.which("bwrap");
    if (!bwrap) throw new ApiError(503, "experiment_sandbox_unavailable", "Bubblewrap is required for experiment execution.");
    const output = join(root, ".fastwrite-experiment-output");
    await mkdir(output, { recursive: true });
    const child = Bun.spawn([bwrap, "--die-with-parent", "--unshare-net", "--new-session", "--cap-drop", "ALL", "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--bind", root, "/workspace", "--chdir", "/workspace", "--", "sh", "-c", `ulimit -t ${cpuSeconds}; ulimit -v ${memoryLimitMb * 1024}; exec "$@"`, "fastwrite-experiment", ...command.map((part) => part.replace(root, "/workspace"))], { cwd: root, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/tmp", FASTWRITE_EXPERIMENT_OUTPUT: "/workspace/.fastwrite-experiment-output" } });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    clearTimeout(timer);
    const log = `${stdout}\n${stderr}`.slice(-500_000);
    const artifactPaths = await this.listArtifacts(output, root);
    return { success: exitCode === 0, exitCode, log, artifactPaths, inputSnapshotHash, runId };
  }
  private commandFor(script: string): string[] { if (script.endsWith(".py")) return ["python3", script]; if (script.endsWith(".js") || script.endsWith(".mjs")) return ["node", script]; return ["sh", script]; }
  private async listArtifacts(output: string, _root: string): Promise<string[]> { const glob = new Bun.Glob("**/*"); const paths: string[] = []; let totalBytes = 0; for await (const path of glob.scan({ cwd: output, onlyFiles: true })) { const bytes = await readFile(join(output, path)); if (bytes.byteLength <= 10_000_000 && totalBytes + bytes.byteLength <= 100_000_000) { totalBytes += bytes.byteLength; paths.push(join(".fastwrite-experiment-output", path)); } } return paths.slice(0, 100); }
  private async hashSnapshot(root: string): Promise<string> { const glob = new Bun.Glob("**/*"); const entries: string[] = []; for await (const path of glob.scan({ cwd: root, onlyFiles: true })) { if (!path.startsWith(".fastwrite-experiment-output/")) entries.push(`${path}\n${Buffer.from(await readFile(join(root, path))).toString("base64")}\n`); } return new Bun.CryptoHasher("sha256").update(entries.sort().join("")).digest("hex"); }
}
