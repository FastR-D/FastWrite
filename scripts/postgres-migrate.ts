import { readFile } from "node:fs/promises";
import { JsonDatabase } from "../apps/server/src/storage/database";
import { SqlPostgresRepository } from "../apps/server/src/storage/postgres-repository";
import { config } from "../apps/server/src/config";

const dataDirectory = process.env.FASTWRITE_DATA_DIR || config.dataDirectory;
const database = new JsonDatabase(dataDirectory);
await database.initialize();
const url = process.env.FASTWRITE_POSTGRES_URL;
if (!url) throw new Error("FASTWRITE_POSTGRES_URL is required");
let pg: any;
try { pg = await import("pg"); } catch { throw new Error("Install the pg package to run PostgreSQL migration"); }
const client = new pg.Client({ connectionString: url });
await client.connect();
const repository = await SqlPostgresRepository.connect(client, database.snapshot());
const commit = process.argv.includes("--commit");
const report = await repository.importLegacy(database.snapshot(), { commit });
console.log(JSON.stringify(report, null, 2));
await repository.close();
