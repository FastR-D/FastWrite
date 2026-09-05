import { describe, expect, test } from "bun:test";
import { agentProviderConfigurations, configuredHarness } from "./config";

describe("harness configuration", () => {
  test("uses one shared Harness configuration for every workflow", () => {
    const providers = agentProviderConfigurations({
      FASTWRITE_HARNESS_API_KEY: "harness-key",
      FASTWRITE_HARNESS_BASE_URL: "https://global.example/v1",
      FASTWRITE_HARNESS_MODEL: "harness-model",
      FASTWRITE_HARNESS_WIRE_API: "responses"
    });
    expect(providers.completion).toEqual({ apiKey: "harness-key", baseURL: "https://global.example/v1", model: "harness-model", wireAPI: "responses" });
    expect(providers.review).toEqual(providers.completion);
    expect(providers.memory).toEqual(providers.completion);
  });

  test("does not read legacy OpenAI workflow aliases", () => {
    const providers = agentProviderConfigurations({ FASTWRITE_MEMORY_OPENAI_API_KEY: "memory-key" });
    expect(providers.memory.apiKey).toBeUndefined();
  });
});

describe("configuredHarness", () => {
  test("normalizes supported modes and falls back safely", () => {
    expect(configuredHarness(" CODEX ")).toBe("codex");
    expect(configuredHarness("claude")).toBe("claude");
    expect(configuredHarness("unsupported")).toBe("codex");
    expect(configuredHarness()).toBe("codex");
    expect(configuredHarness(" ")).toBe("codex");
  });
});
