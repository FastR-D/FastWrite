import { createServer } from "node:net";

const webPort = numberEnvironment("FASTWRITE_WEB_PORT", 3002);
const apiPort = numberEnvironment("FASTWRITE_PORT", 3003);
const children: Bun.Subprocess[] = [];
let shuttingDown = false;

await Promise.all([assertPortAvailable(webPort), assertPortAvailable(apiPort)]);

const shared = start(["bun", "run", "--filter", "@fastwrite/shared", "dev"]);
const server = start(["bun", "run", "--filter", "@fastwrite/server", "dev"]);
const web = start(["bun", "run", "--filter", "@fastwrite/web", "dev"]);

for (const child of children) void child.exited.then((code) => {
  if (shuttingDown) return;
  console.error(`A development process exited unexpectedly (status ${code}).`);
  shutdown(code || 1);
});

try {
  await Promise.all([
    waitFor(`http://127.0.0.1:${apiPort}/api/health`),
    waitFor(`http://127.0.0.1:${webPort}/`)
  ]);
  console.log(`\nFastWrite Web: http://localhost:${webPort}`);
  console.log(`FastWrite API: http://localhost:${apiPort}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Development services did not become ready.");
  shutdown(1);
}

await new Promise<void>((resolve) => {
  process.once("SIGINT", () => { shutdown(0); resolve(); });
  process.once("SIGTERM", () => { shutdown(0); resolve(); });
  // Keep Bun's event loop alive while the three watcher subprocesses run.
  setInterval(() => undefined, 60_000);
});

function start(command: string[]): Bun.Subprocess {
  const child = Bun.spawn(command, { cwd: process.cwd(), stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });
  children.push(child);
  return child;
}

async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Port ${port} is already in use. Stop the existing service or set ${port === webPort ? "FASTWRITE_WEB_PORT" : "FASTWRITE_PORT"} to another port.`)));
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

function shutdown(code: number): never {
  if (shuttingDown) process.exit(code);
  shuttingDown = true;
  for (const child of children) child.kill();
  process.exit(code);
}

function numberEnvironment(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(value) && value > 0 && value < 65_536 ? value : fallback;
}
