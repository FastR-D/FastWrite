import { describe, expect, test } from "bun:test";
import { agentProviderConfigurations, bootstrapAdminConfiguration, configuredHarness } from "./config";

describe("bootstrap administrator configuration", () => {
  test("has no default credentials", () => {
    expect(bootstrapAdminConfiguration({})).toBeUndefined();
  });
  test("requires both settings and a sufficiently long password", () => {
    expect(() => bootstrapAdminConfiguration({ FASTWRITE_BOOTSTRAP_ADMIN_EMAIL: "admin@example.test" })).toThrow("Set both");
    expect(() => bootstrapAdminConfiguration({ FASTWRITE_BOOTSTRAP_ADMIN_PASSWORD: "test-password-unique" })).toThrow("Set both");
    expect(() => bootstrapAdminConfiguration({ FASTWRITE_BOOTSTRAP_ADMIN_EMAIL: "admin@example.test", FASTWRITE_BOOTSTRAP_ADMIN_PASSWORD: "            " })).toThrow("12");
  });
  test("preserves the explicitly chosen password", () => {
    expect(bootstrapAdminConfiguration({ FASTWRITE_BOOTSTRAP_ADMIN_EMAIL: " admin@example.test ", FASTWRITE_BOOTSTRAP_ADMIN_PASSWORD: " unique-test-password " })).toEqual({ email: "admin@example.test", password: " unique-test-password " });
  });
});

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
