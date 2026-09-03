import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadProjectEnvironment } from "./environment";
import type { AgentWireApi } from "@fastwrite/shared";

export const loadedEnvironmentFile = loadProjectEnvironment();

const configuredDataDirectory = process.env.FASTWRITE_DATA_DIR;
const openAIKey = process.env.OPENAI_API_KEY ?? process.env.OPENAI_KEY;
const openAIBaseURL = process.env.OPENAI_BASE_URL ?? process.env.OPENAI_API_BASE;
const agentModel = process.env.FASTWRITE_OPENAI_MODEL;
const packagedWebDirectory = resolve(import.meta.dir, "web");
const embeddedWebDirectory = resolve(import.meta.dir, "../../web/dist");
const releaseDirectory = dirname(process.execPath);
const isStandaloneExecutable = (Bun as unknown as { isStandaloneExecutable?: boolean }).isStandaloneExecutable === true || import.meta.dir.startsWith("/$bunfs/");
const defaultDataDirectory = isStandaloneExecutable ? join(releaseDirectory, "paperdata") : ".fastwrite-data";
const defaultSkillsDirectory = isStandaloneExecutable ? join(releaseDirectory, "skills") : resolve(import.meta.dir, "skills");
const defaultTemplateDirectory = isStandaloneExecutable ? join(releaseDirectory, "bundled") : resolve(import.meta.dir, "templates", "bundled");

export type AgentWorkflow = "completion" | "agent" | "revise" | "review" | "memory" | "research";
export interface AgentProviderConfiguration {
  apiKey?: string | undefined;
  baseURL?: string | undefined;
  model?: string | undefined;
  wireAPI?: AgentWireApi | undefined;
}

function configured(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  return environment[key]?.trim() || undefined;
}

function configuredWireAPI(value?: string): AgentWireApi | undefined {
  const normalized = value?.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "responses") return "responses";
  if (normalized === "chat" || normalized === "chat_completions") return "chat";
  return undefined;
}

export function agentProviderConfigurations(environment: NodeJS.ProcessEnv = process.env): Record<AgentWorkflow, AgentProviderConfiguration> {
  const global = {
    apiKey: configured(environment, "OPENAI_API_KEY") ?? configured(environment, "OPENAI_KEY"),
    baseURL: configured(environment, "OPENAI_BASE_URL") ?? configured(environment, "OPENAI_API_BASE"),
    model: configured(environment, "FASTWRITE_OPENAI_MODEL"),
    wireAPI: configuredWireAPI(configured(environment, "FASTWRITE_OPENAI_WIRE_API") ?? configured(environment, "OPENAI_WIRE_API"))
  };
  const forWorkflow = (workflow: Uppercase<AgentWorkflow>): AgentProviderConfiguration => ({
    apiKey: configured(environment, `FASTWRITE_${workflow}_API_KEY`) ?? configured(environment, `FASTWRITE_${workflow}_OPENAI_API_KEY`) ?? global.apiKey,
    baseURL: configured(environment, `FASTWRITE_${workflow}_BASE_URL`) ?? configured(environment, `FASTWRITE_${workflow}_OPENAI_BASE_URL`) ?? global.baseURL,
    model: configured(environment, `FASTWRITE_${workflow}_MODEL`) ?? configured(environment, `FASTWRITE_${workflow}_OPENAI_MODEL`) ?? global.model,
    wireAPI: configuredWireAPI(configured(environment, `FASTWRITE_${workflow}_WIRE_API`) ?? configured(environment, `FASTWRITE_${workflow}_OPENAI_WIRE_API`)) ?? global.wireAPI
  });
  return {
    completion: forWorkflow("COMPLETION"),
    agent: forWorkflow("AGENT"),
    revise: forWorkflow("REVISE"),
    review: forWorkflow("REVIEW"),
    memory: forWorkflow("MEMORY"),
    research: forWorkflow("RESEARCH")
  };
}

export function configuredHarness(value?: string): "claude" | "codex" | "legacy" {
  const normalized = value?.trim().toLowerCase();
  return normalized === "claude" || normalized === "codex" || normalized === "legacy" ? normalized : "legacy";
}

export const config = {
  harness: configuredHarness(process.env.FASTWRITE_HARNESS),
  port: Number.parseInt(process.env.FASTWRITE_PORT ?? "3003", 10),
  dataDirectory: resolve(configuredDataDirectory || defaultDataDirectory),
  webDirectory: resolve(process.env.FASTWRITE_WEB_DIR || (existsSync(packagedWebDirectory) ? packagedWebDirectory : embeddedWebDirectory)),
  maxFileBytes: 200 * 1024 * 1024,
  maxUploadBytes: 1024 * 1024 * 1024,
  maxEntries: 10_000,
  uploadTtlMs: 24 * 60 * 60 * 1000,
  skillsDirectory: resolve(process.env.FASTWRITE_SKILLS_DIR || defaultSkillsDirectory),
  templateDirectory: resolve(process.env.FASTWRITE_TEMPLATE_DIR || defaultTemplateDirectory),
  agentModel,
  openAIKey,
  openAIBaseURL,
  agentProviders: agentProviderConfigurations()
};
