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

  const child = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env
  });

  const timeout = setTimeout(() => child.kill(), timeoutMs);

  const abortHandler = () => child.kill();
  signal?.addEventListener("abort", abortHandler);

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ]);

    clearTimeout(timeout);

    const log = [stdout, stderr].filter(Boolean).join("\n").slice(-1_000_000);

    return { exitCode, log };
  } finally {
    signal?.removeEventListener("abort", abortHandler);
    clearTimeout(timeout);
  }
}
