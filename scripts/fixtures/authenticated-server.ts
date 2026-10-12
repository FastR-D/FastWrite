import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApplication } from "../../apps/server/src/app";
import { createServerOptions } from "../../apps/server/src/server";

const directory = await mkdtemp(join(tmpdir(), "fastwrite-auth-e2e-"));
const app = await createApplication(directory, {
  features: { serverAuth: true },
  bootstrapAdmin: { email: "e2e-admin@example.test", password: "fastwrite-e2e-only-password" },
  agentProvider: { async revise() { throw new Error("Live AI is disabled in this fixture"); } }
});
const server = Bun.serve({ ...createServerOptions(app), hostname: "127.0.0.1", port: 0 });
console.log(JSON.stringify({ origin: `http://127.0.0.1:${server.port}`, directory }));
process.stdin.on("data", () => { server.stop(true); process.exit(0); });
