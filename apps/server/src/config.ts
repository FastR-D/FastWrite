import { resolve } from "node:path";
import { loadProjectEnvironment } from "./environment";

export const loadedEnvironmentFile = loadProjectEnvironment();

const configuredDataDirectory = process.env.FASTWRITE_DATA_DIR;
const openAIKey = process.env.OPENAI_API_KEY ?? process.env.OPENAI_KEY;
const openAIBaseURL = process.env.OPENAI_BASE_URL ?? process.env.OPENAI_API_BASE;

export const config = {
  port: Number.parseInt(process.env.FASTWRITE_PORT ?? "3003", 10),
  dataDirectory: resolve(configuredDataDirectory || ".fastwrite-data"),
  webDirectory: resolve(import.meta.dir, "../../web/dist"),
  maxFileBytes: 200 * 1024 * 1024,
  maxUploadBytes: 1024 * 1024 * 1024,
  maxEntries: 10_000,
  uploadTtlMs: 24 * 60 * 60 * 1000,
  skillsDirectory: resolve(import.meta.dir, "skills"),
  agentModel: process.env.FASTWRITE_OPENAI_MODEL,
  openAIKey,
  openAIBaseURL
};
