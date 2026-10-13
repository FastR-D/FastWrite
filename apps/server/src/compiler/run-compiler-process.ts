import { processResult } from "../jobs/process-result";

export interface RunCompilerOptions {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs: number;
  env: Record<string, string>;
}

export interface RunCompilerResult {
  exitCode: number;
  log: string;
}

export async function runCompilerProcess(command: string[], options: RunCompilerOptions): Promise<RunCompilerResult> {
  const { cwd, signal, timeoutMs, env } = options;

  signal?.throwIfAborted();
  const child = Bun.spawn(command, {
    cwd,
    detached: true,
    windowsHide: true,
    stdout: "pipe",
    stderr: "pipe",
    env
  });

  const { exitCode, stdout, stderr } = await processResult(child, timeoutMs, signal);
  const log = [stdout, stderr].filter(Boolean).join("\n").slice(-1_000_000);
  return { exitCode, log };
}
