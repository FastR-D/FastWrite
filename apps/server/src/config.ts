import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadProjectEnvironment } from "./environment";
import type { AgentWireApi } from "@fastwrite/shared";

export const loadedEnvironmentFile = loadProjectEnvironment();

const configuredDataDirectory = process.env.FASTWRITE_DATA_DIR;
const harnessApiKey = process.env.FASTWRITE_HARNESS_API_KEY;
const harnessBaseURL = process.env.FASTWRITE_HARNESS_BASE_URL;
const harnessModel = process.env.FASTWRITE_HARNESS_MODEL;
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
    apiKey: configured(environment, "FASTWRITE_HARNESS_API_KEY"),
    baseURL: configured(environment, "FASTWRITE_HARNESS_BASE_URL"),
    model: configured(environment, "FASTWRITE_HARNESS_MODEL"),
    wireAPI: configuredWireAPI(configured(environment, "FASTWRITE_HARNESS_WIRE_API"))
  };
  const forWorkflow = (workflow: Uppercase<AgentWorkflow>): AgentProviderConfiguration => ({
    apiKey: global.apiKey,
    baseURL: global.baseURL,
    model: global.model,
    wireAPI: global.wireAPI
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

export function configuredHarness(value?: string): "claude" | "codex" {
  const normalized = value?.trim().toLowerCase();
  return normalized === "claude" || normalized === "codex" ? normalized : "codex";
}

export interface HarnessDiscoveredConfiguration { harness: "claude" | "codex"; configured: boolean; source: "runtime" | "environment" | "user-config" | "none"; model?: string; baseURL?: string; configPath?: string }

function discoveredCodex(): HarnessDiscoveredConfiguration {
  const path = join(process.env.HOME ?? ".", ".codex", "config.toml");
  try {
    const text = readFileSync(path, "utf8");
    const model = /^model\s*=\s*["']([^"']+)["']/m.exec(text)?.[1];
    const baseURL = /base_url\s*=\s*["']([^"']+)["']/m.exec(text)?.[1];
    return { harness: "codex", configured: true, source: "user-config", ...(model ? { model } : {}), ...(baseURL ? { baseURL } : {}), configPath: path };
  } catch { return { harness: "codex", configured: false, source: "none", configPath: path }; }
}

export function discoverHarnessConfiguration(harness: "claude" | "codex"): HarnessDiscoveredConfiguration {
  if (harness === "codex") return discoveredCodex();
  const path = join(process.env.HOME ?? ".", ".claude", "settings.json");
  try { readFileSync(path, "utf8"); return { harness, configured: true, source: "user-config", configPath: path }; } catch { return { harness, configured: false, source: "none", configPath: path }; }
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
  harnessApiKey,
  harnessBaseURL,
  harnessModel,
  agentProviders: agentProviderConfigurations()
};
