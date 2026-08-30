import type { AgentWireApi } from "@fastwrite/shared";

export interface AgentSettingsDraft {
  apiKey: string;
  baseURL: string;
  model: string;
  wireAPI: AgentWireApi;
}

export interface AgentSettingsBaseline {
  configured: boolean | null;
  baseURL: string;
  model: string;
  wireAPI: AgentWireApi;
}

export type AgentSettingsSaveDecision =
  | { kind: "unchanged" }
  | { kind: "invalid"; message: string }
  | { kind: "save"; body: { apiKey: string; baseURL?: string; model?: string; wireAPI: AgentWireApi } };

export function agentSettingsSaveDecision(draft: AgentSettingsDraft, baseline: AgentSettingsBaseline): AgentSettingsSaveDecision {
  const apiKey = draft.apiKey.trim();
  const baseURL = draft.baseURL.trim();
  const model = draft.model.trim();
  const optionsChanged = baseURL !== baseline.baseURL.trim() || model !== baseline.model.trim() || draft.wireAPI !== baseline.wireAPI;
  const started = Boolean(apiKey) || optionsChanged || (baseline.configured === false && Boolean(baseURL || model));
  if (!started) return { kind: "unchanged" };
  if (!apiKey) return { kind: "invalid", message: "Enter an API key to save the Agent provider settings." };
  if (baseURL) {
    try {
      const parsed = new URL(baseURL);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
    } catch {
      return { kind: "invalid", message: "Base URL must be a valid HTTP or HTTPS URL." };
    }
  }
  return { kind: "save", body: { apiKey, ...(baseURL ? { baseURL } : {}), ...(model ? { model } : {}), wireAPI: draft.wireAPI } };
}

export interface ParsedCodexProviderConfig {
  providerName: string;
  model: string;
  baseURL: string;
  wireAPI: AgentWireApi;
  requiresOpenAIAuth: boolean;
}

export type ProviderConfigParseResult =
  | { ok: true; value: ParsedCodexProviderConfig }
  | { ok: false; message: string };

/** Parses the Codex provider subset from either config.toml syntax or equivalent YAML. */
export function parseCodexProviderConfig(source: string): ProviderConfigParseResult {
  const content = source.trim();
  if (!content) return { ok: false, message: "Paste a Codex-style TOML or YAML provider configuration." };
  try {
    const parsed = /^\s*(?:\[|[A-Za-z_][\w-]*\s*=)/m.test(content) ? parseTomlProvider(content) : parseYamlProvider(content);
    const providerName = stringValue(parsed.root.get("model_provider"));
    const model = stringValue(parsed.root.get("model"));
    if (!providerName) return { ok: false, message: "Provider config is missing model_provider." };
    if (!model) return { ok: false, message: "Provider config is missing model." };
    const provider = parsed.providers.get(providerName);
    if (!provider) return { ok: false, message: `Provider config is missing model_providers.${providerName}.` };
    const baseURL = stringValue(provider.get("base_url"));
    if (!baseURL) return { ok: false, message: `Provider '${providerName}' is missing base_url.` };
    const wireValue = stringValue(provider.get("wire_api"));
    if (!wireValue) return { ok: false, message: `Provider '${providerName}' is missing wire_api.` };
    const normalizedWire = wireValue.toLowerCase().replace(/-/g, "_");
    const wireAPI: AgentWireApi | undefined = normalizedWire === "responses" ? "responses" : normalizedWire === "chat" || normalizedWire === "chat_completions" ? "chat" : undefined;
    if (!wireAPI) return { ok: false, message: `Unsupported wire_api '${wireValue}'. Use 'responses' or 'chat'.` };
    const authValue = provider.get("requires_openai_auth");
    const requiresOpenAIAuth = authValue === undefined ? true : booleanValue(authValue);
    return { ok: true, value: { providerName, model, baseURL, wireAPI, requiresOpenAIAuth } };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Provider config could not be parsed." };
  }
}

interface ParsedProviderDocument {
  root: Map<string, unknown>;
  providers: Map<string, Map<string, unknown>>;
}

function parseTomlProvider(content: string): ParsedProviderDocument {
  const root = new Map<string, unknown>();
  const providers = new Map<string, Map<string, unknown>>();
  let current: Map<string, unknown> | undefined;
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    if (line.startsWith("[")) {
      const section = /^\[\s*model_providers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*\]$/.exec(line);
      if (!section) throw new Error(`Unsupported TOML section on line ${index + 1}.`);
      const name = section[1] ?? section[2] ?? section[3]!;
      current = providers.get(name) ?? new Map<string, unknown>();
      providers.set(name, current);
      continue;
    }
    const assignment = /^([A-Za-z_][\w-]*)\s*=\s*(.+)$/.exec(line);
    if (!assignment) throw new Error(`Invalid TOML assignment on line ${index + 1}.`);
    (current ?? root).set(assignment[1]!, scalarValue(assignment[2]!.trim()));
  }
  return { root, providers };
}

function parseYamlProvider(content: string): ParsedProviderDocument {
  const root = new Map<string, unknown>();
  const providers = new Map<string, Map<string, unknown>>();
  let inProviders = false;
  let current: Map<string, unknown> | undefined;
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    if (/\t/.test(rawLine)) throw new Error(`YAML indentation must use spaces (line ${index + 1}).`);
    const uncommented = stripComment(rawLine);
    if (!uncommented.trim()) continue;
    const indent = uncommented.length - uncommented.trimStart().length;
    const line = uncommented.trim();
    const pair = /^([A-Za-z_][\w-]*):(?:\s*(.*))?$/.exec(line);
    if (!pair) throw new Error(`Invalid YAML entry on line ${index + 1}.`);
    const key = pair[1]!;
    const rawValue = pair[2]?.trim() ?? "";
    if (indent === 0) {
      current = undefined;
      inProviders = key === "model_providers" && !rawValue;
      if (!inProviders) root.set(key, scalarValue(rawValue));
      continue;
    }
    if (inProviders && indent >= 2 && indent < 4 && !rawValue) {
      current = providers.get(key) ?? new Map<string, unknown>();
      providers.set(key, current);
      continue;
    }
    if (inProviders && current && indent >= 4) {
      current.set(key, scalarValue(rawValue));
      continue;
    }
    throw new Error(`Unsupported YAML structure on line ${index + 1}.`);
  }
  return { root, providers };
}

function stripComment(line: string): string {
  let quote = "";
  for (let index = 0; index < line.length; index++) {
    const character = line[index]!;
    if ((character === '"' || character === "'") && line[index - 1] !== "\\") quote = quote === character ? "" : quote || character;
    if (character === "#" && !quote) return line.slice(0, index);
  }
  return line;
}

function scalarValue(raw: string): unknown {
  if (!raw) return "";
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try { return JSON.parse(raw); } catch { throw new Error(`Invalid quoted value ${raw}.`); }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return raw;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("requires_openai_auth must be true or false.");
}
