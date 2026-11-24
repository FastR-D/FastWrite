import { JsonDatabase } from "../apps/server/src/storage/database";
import { postgresClient, SqlPostgresRepository } from "../apps/server/src/storage/postgres-repository";
import { config } from "../apps/server/src/config";

const dataDirectory = process.env.FASTWRITE_DATA_DIR || config.dataDirectory;
const database = new JsonDatabase(dataDirectory);
await database.initialize({ readOnly: true });
const url = process.env.FASTWRITE_POSTGRES_URL;
if (!url) throw new Error("FASTWRITE_POSTGRES_URL is required");
const client = postgresClient(url);
try {
  const state = database.snapshot();
  const repository = await SqlPostgresRepository.connect(client, state);
  const commit = process.argv.includes("--commit");
  const report = await repository.importLegacy(state, { commit });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await client.end?.();
}
