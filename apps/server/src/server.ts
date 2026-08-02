import { createApplication } from "./app";
import { config } from "./config";

const fetch = await createApplication();

if (import.meta.main) {
  Bun.serve({
    port: config.port,
    fetch,
    maxRequestBodySize: config.maxFileBytes + 1024 * 1024
  });
  console.log(`FastWrite server: http://localhost:${config.port}`);
  console.log(`Workspace data: ${config.dataDirectory}`);
}

export { fetch };
