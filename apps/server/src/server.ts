import { createApplication } from "./app";
import { config } from "./config";

export async function startServer() {
  const fetch = await createApplication();
  const server = Bun.serve(createServerOptions(fetch));
  console.log(`FastWrite server: http://localhost:${config.port}`);
  console.log(`Workspace data: ${config.dataDirectory}`);
  return server;
}

export function createServerOptions(fetch: Awaited<ReturnType<typeof createApplication>>) {
  return {
    hostname: "127.0.0.1",
    port: config.port,
    fetch,
    maxRequestBodySize: config.maxFileBytes + 1024 * 1024,
    // Agent operations enforce their own workflow-specific deadlines.
    idleTimeout: 0
  };
}

if (import.meta.main) void startServer();

export { createApplication };
