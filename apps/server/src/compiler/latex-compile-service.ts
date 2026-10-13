import { mkdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, posix } from "node:path";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { normalizeWorkspacePath } from "@fastwrite/shared";
import { ApiError } from "../http";
import { runCompilerProcess } from "./run-compiler-process";
import type { WorkspaceService } from "../workspace/workspace-service";

export interface ServerCompileResult {
  success: boolean;
  projectVersion: number;
  snapshotId: string;
  engine: "server";
  log: string;
  error?: string;
  pdfBase64?: string;
  syncTexData?: string;
  workspacePaths: string[];
}

export type CompileSandboxMode = "host" | "bubblewrap";

export interface CompileSandboxPolicy {
  mode: CompileSandboxMode;
  network: "disabled";
  timeoutMs: number;
  memoryMb: number;
  pids: number;
}

/** Runs a bounded local compile. Production deployments must use the sandbox worker boundary. */
export class LatexCompileService {
  private readonly policy: CompileSandboxPolicy;
  constructor(private readonly dataDirectory: string, private readonly workspaces: WorkspaceService, policy: Partial<CompileSandboxPolicy> = {}) {
    const mode = policy.mode ?? (process.env.FASTWRITE_COMPILE_SANDBOX === "bubblewrap" ? "bubblewrap" : "host");
    if (mode === "host" && process.env.FASTWRITE_COMPILE_PRODUCTION === "true") throw new ApiError(503, "compile_sandbox_required", "Production compilation requires FASTWRITE_COMPILE_SANDBOX=bubblewrap.");
    this.policy = { mode, network: "disabled", timeoutMs: Math.min(Math.max(policy.timeoutMs ?? Number(process.env.FASTWRITE_COMPILE_TIMEOUT_MS ?? 120_000), 5_000), 300_000), memoryMb: Math.min(Math.max(policy.memoryMb ?? Number(process.env.FASTWRITE_COMPILE_MEMORY_MB ?? 1024), 128), 4096), pids: Math.min(Math.max(policy.pids ?? Number(process.env.FASTWRITE_COMPILE_MAX_PIDS ?? 256), 32), 4096) };
  }

  async compile(projectId: string, signal?: AbortSignal): Promise<ServerCompileResult> {
    signal?.throwIfAborted();
    this.workspaces.getProject(projectId);
    const executable = Bun.which("latexmk") ?? Bun.which("pdflatex");
    if (!executable) throw new ApiError(503, "latex_unavailable", "Local LaTeX compilation is unavailable: install latexmk or pdflatex on this machine.");

    const snapshotId = crypto.randomUUID();
    const temporary = join(this.dataDirectory, "compile", snapshotId);
    const source = join(temporary, "source");
    const output = join(temporary, "output");
    try {
      await mkdir(dirname(source), { recursive: true });
      const snapshot = await this.workspaces.copySnapshot(projectId, source);
      const mainDocument = normalizeWorkspacePath(snapshot.mainDocument);
      const identity = { projectVersion: snapshot.projectVersion, snapshotId };
      await mkdir(output, { recursive: true });
      const compilerOutput = this.policy.mode === "bubblewrap" ? "/workspace/output" : output;
      const argumentsList = executable.endsWith("latexmk") || executable.includes("latexmk")
        ? [executable, "-norc", "-pdf", "-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-synctex=1", `-outdir=${compilerOutput}`, `-auxdir=${compilerOutput}`, `./${mainDocument}`]
        : [executable, "-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-synctex=1", `-output-directory=${compilerOutput}`, `./${mainDocument}`];
      const command = this.policy.mode === "bubblewrap" ? this.bubblewrapCommand(argumentsList, source, output) : argumentsList;
      const { exitCode, log } = await runCompilerProcess(command, { cwd: source, ...(signal ? { signal } : {}), timeoutMs: this.policy.timeoutMs, env: compileEnvironment(compilerOutput) });
      const stem = basename(mainDocument, ".tex");
      const pdfPath = await findOutputFile(output, `${stem}.pdf`);
      const syncPath = await findOutputFile(output, `${stem}.synctex.gz`);
      if (exitCode !== 0) return { ...identity, success: false, engine: "server", log, error: describeLatexFailure(exitCode, log), workspacePaths: await listWorkspacePaths(source) };
      const pdf = pdfPath ? await readFile(pdfPath).catch(() => null) : null;
      if (!pdf) return { ...identity, success: false, engine: "server", log, error: "LaTeX completed without producing a PDF.", workspacePaths: await listWorkspacePaths(source) };
      const syncTexData = syncPath ? await readFile(syncPath).then((data) => promisify(gunzip)(data).then((value) => value.toString("utf8"))).catch(() => undefined) : undefined;
      if (signal?.aborted) throw new ApiError(409, "compile_cancelled", "Compilation cancelled");
      return { ...identity, success: true, engine: "server", log, pdfBase64: pdf.toString("base64"), ...(syncTexData ? { syncTexData } : {}), workspacePaths: await listWorkspacePaths(source) };
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private bubblewrapCommand(command: string[], source: string, output: string): string[] {
    const bwrap = Bun.which("bwrap");
    if (!bwrap) throw new ApiError(503, "compile_sandbox_unavailable", "Bubblewrap is required for sandboxed server compilation.");
    const cpuSeconds = Math.max(1, Math.ceil(this.policy.timeoutMs / 1000));
    const memoryKb = this.policy.memoryMb * 1024;
    return [bwrap, "--die-with-parent", "--unshare-all", "--new-session", "--cap-drop", "ALL", "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin", "--ro-bind", "/lib", "/lib", "--ro-bind-try", "/lib64", "/lib64", "--ro-bind-try", "/etc/texmf", "/etc/texmf", "--ro-bind-try", "/var/lib/texmf", "/var/lib/texmf", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--ro-bind", source, "/workspace/source", "--bind", output, "/workspace/output", "--chdir", "/workspace/source", "--", "/bin/bash", "-ec", `ulimit -t ${cpuSeconds}; ulimit -v ${memoryKb}; ulimit -u ${this.policy.pids}; exec "$@"`, "fastwrite-compile", ...command];
  }
}

export function compileEnvironment(output: string): Record<string, string> {
  // Do not expose provider credentials, database URLs, or user TeX overrides to documents.
  const env: Record<string, string> = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "PATHEXT", "LANG", "LC_ALL"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return { ...env, HOME: output, USERPROFILE: output, TMPDIR: output, TEMP: output, TMP: output,
    TEXMFOUTPUT: output, openin_any: "p", openout_any: "p", shell_escape: "f", SOURCE_DATE_EPOCH: "0",
    TEXMFCONFIG: (output === "/workspace/output" ? posix : { join }).join(output, "texmf-config"), TEXMFVAR: (output === "/workspace/output" ? posix : { join }).join(output, "texmf-var") };
}

async function findOutputFile(root: string, filename: string): Promise<string | null> {
  const glob = new Bun.Glob(`**/${filename}`);
  for await (const path of glob.scan({ cwd: root, onlyFiles: true })) return join(root, path);
  return null;
}

function describeLatexFailure(exitCode: number, log: string): string {
  const missingPackage = /File [`']([^`']+\.sty)[`'] not found\./.exec(log)?.[1];
  if (missingPackage) return `Local LaTeX is missing ${missingPackage}. Install that TeX package on this machine, then recompile.`;
  return `Local LaTeX exited with status ${exitCode}. See the compiler log for details.`;
}

async function listWorkspacePaths(root: string, relative = ""): Promise<string[]> {
  const directory = join(root, relative);
  const glob = new Bun.Glob("**/*");
  const paths: string[] = [];
  for await (const path of glob.scan({ cwd: directory, onlyFiles: true })) paths.push(relative ? `${relative}/${path}` : path);
  return paths.sort();
}
