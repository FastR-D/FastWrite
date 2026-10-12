import { resolve } from "node:path";
import { restoreBackupOffline } from "../apps/server/src/storage/backup-service";
import { createS3ObjectStore } from "../apps/server/src/storage/object-storage";

const args = process.argv.slice(2);
const argument = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const directory = argument("--data-dir");
const file = argument("--file");
const objectKey = argument("--object-key");
if (!directory) throw new Error("Specify --data-dir explicitly; stop FastWrite before restoring.");
const requiredEnvironment = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`${name} is required for object-store restore`); return value; };
const objectStore = objectKey ? await createS3ObjectStore({ endpoint: requiredEnvironment("FASTWRITE_OBJECT_STORE_ENDPOINT"), region: process.env.FASTWRITE_OBJECT_STORE_REGION ?? "us-east-1", bucket: requiredEnvironment("FASTWRITE_OBJECT_STORE_BUCKET"), accessKey: requiredEnvironment("FASTWRITE_OBJECT_STORE_ACCESS_KEY"), secretKey: requiredEnvironment("FASTWRITE_OBJECT_STORE_SECRET_KEY"), prefix: process.env.FASTWRITE_OBJECT_STORE_PREFIX ?? "" }) : undefined;
const result = await restoreBackupOffline(resolve(directory), { ...(file ? { file: resolve(file) } : {}), ...(objectKey ? { objectKey } : {}), confirm: argument("--confirm") ?? "" }, objectStore);
console.log(JSON.stringify({ ...result, message: "Database restored. Restart FastWrite to load the restored state." }));
