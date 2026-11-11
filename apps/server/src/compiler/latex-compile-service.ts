import { normalizeCompileSettings, parseLatexDiagnostics, type LatexDiagnostic } from "@fastwrite/shared";
import { TexEnvironmentService, engineFlag } from "./tex-environment-service";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  diagnostics?: LatexDiagnostic[];
  compiler?: string;
  environmentId?: string;
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
  private active = 0;
  private readonly results = new Map<string, Omit<ServerCompileResult, "pdfBase64" | "syncTexData">>();
  latest(projectId: string) { return this.results.get(projectId); }
  readonly environments = new TexEnvironmentService();
  private readonly policy: CompileSandboxPolicy;
  constructor(private readonly dataDirectory: string, private readonly workspaces: WorkspaceService, policy: Partial<CompileSandboxPolicy> = {}) {
    const mode = policy.mode ?? (process.env.FASTWRITE_COMPILE_SANDBOX === "bubblewrap" ? "bubblewrap" : "host");
    if (mode === "host" && process.env.FASTWRITE_COMPILE_PRODUCTION === "true") throw new ApiError(503, "compile_sandbox_required", "Production compilation requires FASTWRITE_COMPILE_SANDBOX=bubblewrap.");
    this.policy = { mode, network: "disabled", timeoutMs: Math.min(Math.max(policy.timeoutMs ?? Number(process.env.FASTWRITE_COMPILE_TIMEOUT_MS ?? 120_000), 5_000), 300_000), memoryMb: Math.min(Math.max(policy.memoryMb ?? Number(process.env.FASTWRITE_COMPILE_MEMORY_MB ?? 1024), 128), 4096), pids: Math.min(Math.max(policy.pids ?? Number(process.env.FASTWRITE_COMPILE_MAX_PIDS ?? 256), 32), 4096) };
  }

  async compile(projectId: string, signal?: AbortSignal, candidate?: { expectedVersion: number; files: Array<{ path: string; content: string }> }): Promise<ServerCompileResult> {
    signal?.throwIfAborted();
    const limit = Math.min(32, Math.max(1, Number(process.env.FASTWRITE_COMPILE_MAX_ACTIVE ?? 4) || 4));
    if (this.active >= limit) throw new ApiError(429, "compile_capacity", "编译服务繁忙，请稍后重试");
    this.workspaces.getProject(projectId);


    const snapshotId = crypto.randomUUID();
    const temporary = join(this.dataDirectory, "compile", snapshotId);
    const source = join(temporary, "source");
    const output = join(temporary, "output");
    let containerName: string | undefined;
    this.active++;
    try {
      await mkdir(dirname(source), { recursive: true });
      const snapshot = await this.workspaces.copySnapshot(projectId, source);
      if (candidate) {
        if (snapshot.projectVersion !== candidate.expectedVersion) throw new ApiError(409, "compile_candidate_stale", "项目已修改，请重新生成编译候选");
        for (const file of candidate.files) {
          const path = normalizeWorkspacePath(file.path);
          if (!/\.(?:tex|bib|sty|cls)$/.test(path) || file.content.length > 1_000_000) throw new ApiError(400, "compile_candidate_invalid", "无效的编译候选");
          await this.workspaces.readTextFile(projectId, path);
          await writeFile(join(source, path), file.content);
        }
      }
      const settings = normalizeCompileSettings(snapshot.compilation ?? { engine: "pdflatex", environmentId: "system" });
      await this.environments.validate(settings);
      const environment = this.environments.get(settings.environmentId);
      const executable = environment.image ? "latexmk" : this.environments.executable(settings.environmentId, "latexmk")!;
      const mainDocument = normalizeWorkspacePath(snapshot.mainDocument);
      const identity = { projectVersion: snapshot.projectVersion, snapshotId, compiler: settings.engine, environmentId: settings.environmentId };
      await mkdir(output, { recursive: true });
      const compilerOutput = environment.image || this.policy.mode === "bubblewrap" ? "/workspace/output" : output;
      const argumentsList = executable.endsWith("latexmk") || executable.includes("latexmk")
        ? [executable, "-norc", engineFlag(settings.engine), "-no-shell-escape", "-file-line-error", "-interaction=nonstopmode", "-halt-on-error", "-synctex=1", `-outdir=${compilerOutput}`, `-auxdir=${compilerOutput}`, `./${mainDocument}`]
        : [executable, "-no-shell-escape", "-file-line-error", "-interaction=nonstopmode", "-halt-on-error", "-synctex=1", `-output-directory=${compilerOutput}`, `./${mainDocument}`];
      if (environment.image) containerName = `fastwrite-compile-${snapshotId}`;
      const command = environment.image ? [Bun.which("docker")!, "run", "--rm", "--name", containerName!, "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", `${this.policy.memoryMb}m`, "--cpus", "2", "--pids-limit", String(this.policy.pids), "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, "--mount", `type=bind,src=${source},dst=/workspace/source,readonly`, "--mount", `type=bind,src=${output},dst=/workspace/output`, "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m", "--env", "HOME=/tmp", "--env", "openin_any=p", "--env", "openout_any=p", "--env", "shell_escape=f", "--workdir", "/workspace/source", "--entrypoint", "latexmk", environment.image, ...argumentsList.slice(1)] : this.policy.mode === "bubblewrap" ? this.bubblewrapCommand(argumentsList, source, output, await this.environments.roots(settings.environmentId)) : argumentsList;
      const { exitCode, log } = await runCompilerProcess(command, { cwd: source, ...(signal ? { signal } : {}), timeoutMs: this.policy.timeoutMs, env: { ...compileEnvironment(compilerOutput), PATH: this.environments.path(settings.environmentId) } });
      const workspacePaths = await listWorkspacePaths(source);
      const finalLogPath = await findOutputFile(output, `${basename(mainDocument, ".tex")}.log`);
      const finalLog = finalLogPath ? await readFile(finalLogPath, "utf8").catch(() => log) : log;
      const diagnostics = parseLatexDiagnostics(finalLog, workspacePaths, mainDocument);
      const record = (result: ServerCompileResult) => {
        if (!candidate) {
          const { pdfBase64, syncTexData, ...summary } = result;
          this.results.delete(projectId); this.results.set(projectId, summary);
          if (this.results.size > 100) this.results.delete(this.results.keys().next().value!);
        }
        return result;
      };
      const stem = basename(mainDocument, ".tex");
      const pdfPath = await findOutputFile(output, `${stem}.pdf`);
      const syncPath = await findOutputFile(output, `${stem}.synctex.gz`);
      if (exitCode !== 0) return record({ ...identity, diagnostics, success: false, engine: "server", log, error: describeLatexFailure(exitCode, log), workspacePaths });
      const pdf = pdfPath ? await readFile(pdfPath).catch(() => null) : null;
      if (!pdf) return record({ ...identity, diagnostics, success: false, engine: "server", log, error: "LaTeX 编译结束，但未生成 PDF。", workspacePaths });
      const syncTexData = syncPath ? await readFile(syncPath).then((data) => promisify(gunzip)(data).then((value) => value.toString("utf8"))).catch(() => undefined) : undefined;
      if (signal?.aborted) throw new ApiError(409, "compile_cancelled", "Compilation cancelled");
      return record({ ...identity, diagnostics, success: true, engine: "server", log, pdfBase64: pdf.toString("base64"), ...(syncTexData ? { syncTexData } : {}), workspacePaths });
    } finally {
      this.active--;
      if (containerName) await runCompilerProcess([Bun.which("docker")!, "rm", "-f", containerName], { cwd: "/tmp", timeoutMs: 5000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } }).catch(() => undefined);
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private bubblewrapCommand(command: string[], source: string, output: string, roots: string[] = []): string[] {
    const bwrap = Bun.which("bwrap");
    if (!bwrap) throw new ApiError(503, "compile_sandbox_unavailable", "Bubblewrap is required for sandboxed server compilation.");
    const cpuSeconds = Math.max(1, Math.ceil(this.policy.timeoutMs / 1000));
    const memoryKb = this.policy.memoryMb * 1024;
    return [bwrap, "--die-with-parent", "--unshare-all", "--new-session", "--cap-drop", "ALL", "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin", "--ro-bind", "/lib", "/lib", "--ro-bind-try", "/lib64", "/lib64", "--ro-bind-try", "/etc/texmf", "/etc/texmf", "--ro-bind-try", "/var/lib/texmf", "/var/lib/texmf", ...roots.flatMap(root => ["--ro-bind", root, root]), "--ro-bind-try", "/etc/fonts", "/etc/fonts", "--ro-bind-try", "/var/cache/fontconfig", "/var/cache/fontconfig", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--ro-bind", source, "/workspace/source", "--bind", output, "/workspace/output", "--chdir", "/workspace/source", "--", "/bin/bash", "-ec", `ulimit -t ${cpuSeconds}; ulimit -v ${memoryKb}; ulimit -u ${this.policy.pids}; exec "$@"`, "fastwrite-compile", ...command];
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
  if (missingPackage) return `本地 LaTeX 缺少 ${missingPackage}，请在此设备上安装对应的 TeX 包后重新编译。`;
  return `本地 LaTeX 编译失败（退出码 ${exitCode}），请查看编译日志。`;
}

async function listWorkspacePaths(root: string, relative = ""): Promise<string[]> {
  const directory = join(root, relative);
  const glob = new Bun.Glob("**/*");
  const paths: string[] = [];
  for await (const path of glob.scan({ cwd: directory, onlyFiles: true })) paths.push(relative ? `${relative}/${path}` : path);
  return paths.sort();
}
