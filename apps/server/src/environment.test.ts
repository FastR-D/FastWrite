import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadEnvironmentFile } from "./environment";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("environment loading", () => {
  test("loads quoted root env values without overriding the launch environment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fastwrite-env-"));
    temporaryDirectories.push(directory);
    const path = join(directory, ".env");
    await writeFile(path, "# FastWrite\nOPENAI_KEY='from root'\nOPENAI_API_BASE=https://example.test/v1 # comment\nEXISTING=file\n", "utf8");
    const target: NodeJS.ProcessEnv = { EXISTING: "launch" };
    expect(loadEnvironmentFile(path, target)).toBe(true);
    expect(target).toEqual({ OPENAI_KEY: "from root", OPENAI_API_BASE: "https://example.test/v1", EXISTING: "launch" });
  });
});
