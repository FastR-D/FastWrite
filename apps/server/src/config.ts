import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadProjectEnvironment } from "./environment";
import type { AgentWireApi } from "@fastwrite/shared";

export const loadedEnvironmentFile = loadProjectEnvironment();

const configuredDataDirectory = process.env.FASTWRITE_DATA_DIR;
const harnessApiKey = process.env.FASTWRITE_HARNESS_API_KEY;
const harnessBaseURL = process.env.FASTWRITE_HARNESS_BASE_URL;
const harnessModel = process.env.FASTWRITE_HARNESS_MODEL;
const collaborationRoomTokenSecret = process.env.FASTWRITE_COLLABORATION_ROOM_TOKEN_SECRET;
const redisUrl = process.env.FASTWRITE_REDIS_URL?.trim();
const postgresUrl = process.env.FASTWRITE_POSTGRES_URL?.trim();
const oidcIssuer = process.env.FASTWRITE_OIDC_ISSUER?.trim();
const oidcClientId = process.env.FASTWRITE_OIDC_CLIENT_ID?.trim();
const oidcRedirectUri = process.env.FASTWRITE_OIDC_REDIRECT_URI?.trim();
const oidcClientSecret = process.env.FASTWRITE_OIDC_CLIENT_SECRET?.trim();
const casServerUrl = process.env.FASTWRITE_CAS_SERVER_URL?.trim();
const casServiceUrl = process.env.FASTWRITE_CAS_SERVICE_URL?.trim();
const smtpUrl = process.env.FASTWRITE_SMTP_URL?.trim();
const mailFrom = process.env.FASTWRITE_MAIL_FROM?.trim();
const mailWebhookSecret = process.env.FASTWRITE_MAIL_WEBHOOK_SECRET?.trim();
const objectStoreBucket = process.env.FASTWRITE_OBJECT_STORE_BUCKET?.trim();
const objectStoreEndpoint = process.env.FASTWRITE_OBJECT_STORE_ENDPOINT?.trim();
const objectStoreRegion = process.env.FASTWRITE_OBJECT_STORE_REGION?.trim() || "us-east-1";
const objectStoreAccessKey = process.env.FASTWRITE_OBJECT_STORE_ACCESS_KEY?.trim();
const objectStoreSecretKey = process.env.FASTWRITE_OBJECT_STORE_SECRET_KEY?.trim();
const bootstrapAdminEmail = process.env.FASTWRITE_BOOTSTRAP_ADMIN_EMAIL?.trim() || "admin@qq.com";
const bootstrapAdminPassword = process.env.FASTWRITE_BOOTSTRAP_ADMIN_PASSWORD?.trim() || "admin123456789";
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

export interface OidcConfiguration { issuer: string; clientId: string; redirectUri: string; clientSecret?: string; }
export interface CasConfiguration { serverUrl: string; serviceUrl: string; }
export interface MailConfiguration { smtpUrl: string; from: string; webhookSecret?: string; }

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
  collaborationRoomTokenSecret,
  redisUrl,
  postgresUrl,
  oidc: oidcIssuer && oidcClientId && oidcRedirectUri ? { issuer: oidcIssuer, clientId: oidcClientId, redirectUri: oidcRedirectUri, ...(oidcClientSecret ? { clientSecret: oidcClientSecret } : {}) } satisfies OidcConfiguration : undefined,
  cas: casServerUrl && casServiceUrl ? { serverUrl: casServerUrl, serviceUrl: casServiceUrl } satisfies CasConfiguration : undefined,
  mail: smtpUrl && mailFrom ? { smtpUrl, from: mailFrom, ...(mailWebhookSecret ? { webhookSecret: mailWebhookSecret } : {}) } satisfies MailConfiguration : undefined,
  objectStore: objectStoreBucket && objectStoreEndpoint && objectStoreAccessKey && objectStoreSecretKey ? { bucket: objectStoreBucket, endpoint: objectStoreEndpoint, region: objectStoreRegion, accessKey: objectStoreAccessKey, secretKey: objectStoreSecretKey } : undefined,
  bootstrapAdmin: { email: bootstrapAdminEmail, password: bootstrapAdminPassword },
  agentProviders: agentProviderConfigurations(),
  features: {
    serverAuth: process.env.FASTWRITE_SERVER_AUTH === "true",
    teams: process.env.FASTWRITE_TEAMS === "true",
    scopedHarness: process.env.FASTWRITE_SCOPED_HARNESS === "true",
    realtimeV2: process.env.FASTWRITE_REALTIME_V2 === "true",
    commentsV2: process.env.FASTWRITE_COMMENTS_V2 === "true",
    pwaOffline: process.env.FASTWRITE_PWA_OFFLINE === "true"
    ,multiNodeCollaboration: process.env.FASTWRITE_MULTI_NODE_COLLABORATION === "true"
  }
};
