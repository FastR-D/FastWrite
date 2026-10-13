import { execFile } from "node:child_process";

interface Child { pid?: number; exited: Promise<number>; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; kill(signal?: number | NodeJS.Signals): void; }

/** Children must be spawned detached so cancellation also stops their process group. */
export async function processResult(child: Child, timeoutMs: number, signal?: AbortSignal) {
  let killing: Promise<void> | undefined;
  const kill = () => {
    if (killing) return;
    killing = (async () => {
      if (child.pid && process.platform === "win32") {
        await new Promise<void>(resolve => execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => resolve()));
      } else if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* Child may already have exited. */ }
      }
      try { child.kill("SIGKILL"); } catch { /* Already exited. */ }
    })();
  };
  const timer = setTimeout(kill, timeoutMs);
  signal?.addEventListener("abort", kill, { once: true });
  if (signal?.aborted) kill();
  try {
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, tail(child.stdout), tail(child.stderr)]);
    signal?.throwIfAborted();
    return { exitCode, stdout, stderr };
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", kill); await killing; }
}

async function tail(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader(); const decoder = new TextDecoder(); let result = "";
  try { while (true) { const item = await reader.read(); if (item.done) break; result = (result + decoder.decode(item.value, { stream: true })).slice(-1_000_000); } return (result + decoder.decode()).slice(-1_000_000); }
  finally { reader.releaseLock(); }
}
