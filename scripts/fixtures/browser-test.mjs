import { chromium, firefox, webkit } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";

export async function startTestServer() {
  const child = spawn(process.env.FASTWRITE_E2E_BUN || "bun", ["scripts/fixtures/authenticated-server.ts"], { stdio: ["pipe", "pipe", "pipe"] });
  let setup, log = "";
  child.stderr.on("data", data => { log += data; });
  try {
    setup = await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error(`Server startup timed out\n${log}`)), 20_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`Server exited ${code}\n${log}`)); });
      child.stdout.on("data", data => {
        output += data;
        const line = output.split("\n").find(value => value.startsWith('{"origin":'));
        if (line) { clearTimeout(timer); resolve(JSON.parse(line)); }
      });
    });
  } catch (error) {
    child.kill();
    throw error;
  }
  return { ...setup, async close() {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.stdin.end("stop\n");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    await rm(setup.directory, { recursive: true, force: true });
  } };
}

export async function launchTestBrowser() {
  const name = process.env.FASTWRITE_E2E_BROWSER || "chromium";
  const engine = { chrome: chromium, chromium, firefox, webkit }[name];
  if (!engine) throw new Error(`Unsupported test browser: ${name}`);
  return engine.launch({ headless: true,
    ...(name === "chrome" ? { channel: "chrome" } : {}),
    ...(process.env.FASTWRITE_E2E_BROWSER_PATH ? { executablePath: process.env.FASTWRITE_E2E_BROWSER_PATH } : {}),
  });
}
