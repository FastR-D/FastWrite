import { describe, expect, test } from "bun:test";
import { agentProviderConfigurations, configuredHarness } from "./config";

describe("agentProviderConfigurations", () => {
  test("uses global settings unless a workflow overrides an individual field", () => {
    const providers = agentProviderConfigurations({
      OPENAI_API_KEY: "global-key",
      OPENAI_API_BASE: "https://global.example/v1",
      FASTWRITE_OPENAI_MODEL: "global-model",
      FASTWRITE_OPENAI_WIRE_API: "responses",
      FASTWRITE_COMPLETION_API_KEY: "completion-key",
      FASTWRITE_COMPLETION_MODEL: "fast-model",
      FASTWRITE_REVIEW_BASE_URL: "https://review.example/v1"
    });
    expect(providers.completion).toEqual({ apiKey: "completion-key", baseURL: "https://global.example/v1", model: "fast-model", wireAPI: "responses" });
    expect(providers.review).toEqual({ apiKey: "global-key", baseURL: "https://review.example/v1", model: "global-model", wireAPI: "responses" });
    expect(providers.memory).toEqual({ apiKey: "global-key", baseURL: "https://global.example/v1", model: "global-model", wireAPI: "responses" });
  });

  test("supports explicit OpenAI-compatible workflow aliases without a global provider", () => {
    const providers = agentProviderConfigurations({ FASTWRITE_MEMORY_OPENAI_API_KEY: "memory-key", FASTWRITE_MEMORY_OPENAI_BASE_URL: "https://memory.example/v1", FASTWRITE_MEMORY_OPENAI_MODEL: "memory-model", FASTWRITE_MEMORY_OPENAI_WIRE_API: "chat-completions" });
    expect(providers.memory).toEqual({ apiKey: "memory-key", baseURL: "https://memory.example/v1", model: "memory-model", wireAPI: "chat" });
    expect(providers.agent.apiKey).toBeUndefined();
  });
});

describe("configuredHarness", () => {
  test("normalizes supported modes and falls back safely", () => {
    expect(configuredHarness(" CODEX ")).toBe("codex");
    expect(configuredHarness("claude")).toBe("claude");
    expect(configuredHarness("unsupported")).toBe("legacy");
    expect(configuredHarness()).toBe("legacy");
  });
});
