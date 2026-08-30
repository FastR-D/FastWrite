import { describe, expect, test } from "bun:test";
import { agentSettingsSaveDecision, parseCodexProviderConfig } from "./projectSettingsAgent";

const chat = { wireAPI: "chat" as const };

describe("Project settings Agent save decision", () => {
  test("leaves an existing provider unchanged when the secret field is blank", () => {
    expect(agentSettingsSaveDecision(
      { apiKey: "", baseURL: "https://api.example.test/v1", model: "paper-model", ...chat },
      { configured: true, baseURL: "https://api.example.test/v1", model: "paper-model", ...chat }
    )).toEqual({ kind: "unchanged" });
  });

  test("automatically saves a newly entered API key with optional settings", () => {
    expect(agentSettingsSaveDecision(
      { apiKey: " sk-test ", baseURL: " https://api.example.test/v1 ", model: " paper-model ", wireAPI: "responses" },
      { configured: false, baseURL: "", model: "", ...chat }
    )).toEqual({ kind: "save", body: { apiKey: "sk-test", baseURL: "https://api.example.test/v1", model: "paper-model", wireAPI: "responses" } });
  });

  test("blocks a partial provider configuration without an API key", () => {
    expect(agentSettingsSaveDecision(
      { apiKey: "", baseURL: "https://api.example.test/v1", model: "", ...chat },
      { configured: false, baseURL: "", model: "", ...chat }
    )).toEqual({ kind: "invalid", message: "Enter an API key to save the Agent provider settings." });
  });

  test("blocks changing existing provider options without a replacement key", () => {
    expect(agentSettingsSaveDecision(
      { apiKey: "", baseURL: "https://new.example.test/v1", model: "paper-model", ...chat },
      { configured: true, baseURL: "https://api.example.test/v1", model: "paper-model", ...chat }
    ).kind).toBe("invalid");
  });

  test("blocks a malformed Base URL before either save request runs", () => {
    expect(agentSettingsSaveDecision(
      { apiKey: "sk-test", baseURL: "not-a-url", model: "", ...chat },
      { configured: false, baseURL: "", model: "", ...chat }
    )).toEqual({ kind: "invalid", message: "Base URL must be a valid HTTP or HTTPS URL." });
  });
});

describe("Codex-style provider config", () => {
  test("parses the Codex TOML provider subset", () => {
    expect(parseCodexProviderConfig(`
model = "gpt-5.5"
model_provider = "mirror"

[model_providers.mirror]
name = "mirror"
base_url = "https://app.soruxgpt.com/api/codex"
wire_api = "responses"
requires_openai_auth = true
`)).toEqual({ ok: true, value: {
      providerName: "mirror",
      model: "gpt-5.5",
      baseURL: "https://app.soruxgpt.com/api/codex",
      wireAPI: "responses",
      requiresOpenAIAuth: true
    } });
  });

  test("parses the equivalent YAML shape", () => {
    expect(parseCodexProviderConfig(`
model: gpt-5.5
model_provider: mirror
model_providers:
  mirror:
    name: mirror
    base_url: https://app.soruxgpt.com/api/codex
    wire_api: responses
    requires_openai_auth: true
`)).toMatchObject({ ok: true, value: { providerName: "mirror", model: "gpt-5.5", wireAPI: "responses" } });
  });

  test("rejects an incomplete or unsupported provider section", () => {
    expect(parseCodexProviderConfig(`model = "gpt-5.5"\nmodel_provider = "mirror"`)).toEqual({ ok: false, message: "Provider config is missing model_providers.mirror." });
    expect(parseCodexProviderConfig(`model = "gpt-5.5"\nmodel_provider = "mirror"\n[model_providers.mirror]\nbase_url = "https://example.test"\nwire_api = "websocket"`)).toEqual({ ok: false, message: "Unsupported wire_api 'websocket'. Use 'responses' or 'chat'." });
  });
});
