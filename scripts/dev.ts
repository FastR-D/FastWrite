import { createServer } from "node:net";

const apiPort = numberEnvironment("FASTWRITE_PORT", 3003);
const children: Bun.Subprocess[] = [];
let shuttingDown = false;
let shutdownPromise: Promise<never> | undefined;

await assertPortAvailable(apiPort);

const shared = start(["bun", "run", "--filter", "@fastwrite/shared", "dev"]);
const server = start(["bun", "run", "--filter", "@fastwrite/server", "dev"]);
const web = start(["bun", "run", "--filter", "@fastwrite/web", "dev"]);

for (const child of children) void child.exited.then((code) => {
  if (shuttingDown) return;
  console.error(`A development process exited unexpectedly (status ${code}).`);
  void shutdown(code || 1);
});

try {
  await waitFor(`http://127.0.0.1:${apiPort}/api/health`);
  console.log(`\nFastWrite Dev: http://localhost:3002`);
  console.log(`FastWrite API: http://localhost:${apiPort}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Development services did not become ready.");
  await shutdown(1);
}

await new Promise<void>((resolve) => {
  // `on`, not `once`: shutdown() sends SIGTERM synchronously, but a second
  // Ctrl-C would terminate this process before the SIGKILL fallback below,
  // stranding any child that ignores SIGTERM. Repeats are harmless because
  // shutdown() is idempotent.
  process.on("SIGINT", () => { void shutdown(0); resolve(); });
  process.on("SIGTERM", () => { void shutdown(0); resolve(); });
  // Keep Bun's event loop alive while the three watcher subprocesses run.
  setInterval(() => undefined, 60_000);
});

function start(command: string[]): Bun.Subprocess {
  // `bun run --filter` only wraps the real watcher, so signalling the wrapper
  // orphans whatever it started (tsc --watch, vite). Detaching each child into
  // its own process group lets shutdown signal the whole tree instead.
  const child = Bun.spawn(command, { cwd: process.cwd(), stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env, detached: true });
  children.push(child);
  return child;
}

async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Port ${port} is already in use. Stop the existing service or set FASTWRITE_PORT to another port.`)));
    server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolve()));
  });
}

async function waitFor(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError = "not reachable";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for ${url} (${lastError}).`);
}

function shutdown(code: number): Promise<never> {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    for (const child of children) signalGroup(child, "SIGTERM");
    await Promise.race([
      Promise.allSettled(children.map((child) => child.exited)),
      Bun.sleep(2_000)
    ]);
    for (const child of children) signalGroup(child, "SIGKILL");
    process.exit(code);
  })();
  return shutdownPromise;
}

// The group outlives its leader, so signalling -pid still reaps descendants
// after the `bun run --filter` wrapper has exited.
function signalGroup(child: Bun.Subprocess, signal: NodeJS.Signals): void {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

function numberEnvironment(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(value) && value > 0 && value < 65_536 ? value : fallback;
}
