import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { SkillRegistry } from "./skill-registry";

const directory = join(import.meta.dir, "../skills");
const evaluation = resolve(import.meta.dir, "../../../../evaluation/agent-writing-skills");
const integrations: Array<{ id: string; version: string; sources: string[] }> = JSON.parse(await readFile(join(evaluation, "integrations.json"), "utf8"));
const lock = JSON.parse(await readFile(join(evaluation, "sources.lock.json"), "utf8"));
const registry = new SkillRegistry(directory);
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

describe("curated writing Skill integrations", () => {
  for (const skill of integrations) {
    test(`${skill.id}: discoverable, self-contained, attributed and bounded`, async () => {
      const loaded = await registry.loadTask(skill.id);
      expect(loaded.descriptor).toMatchObject({ id: skill.id, version: skill.version, supportedIntents: ["draft", "continue", "revise"], allowedScope: "project", allowNewFiles: false, requiresReview: true });
      expect(loaded.descriptor.requiredEvidence.length).toBeGreaterThan(0);
      expect(loaded.instructions.length).toBeLessThan(6000);
      // The runtime loads only SKILL.md; instructions must not depend on omitted utilities/assets.
      expect(loaded.instructions).not.toMatch(/(?:scripts|assets|references)\/[\w.-]+/);
      const provenance = JSON.parse(await readFile(join(directory, `task-${skill.id}`, "provenance.json"), "utf8"));
      expect(provenance.sources.map((source: { id: string }) => source.id)).toEqual(skill.sources);
      for (const source of provenance.sources) {
        const pinned = lock.sources.find((item: { id: string }) => item.id === source.id);
        expect(source.commit).toMatch(/^[0-9a-f]{40}$/);
        expect(source.sha256).toBe(pinned.sha256);
        expect(source.url).toBe(pinned.url);
        expect(source.license).toBe(pinned.license);
        const snapshot = await readFile(join(evaluation, pinned.snapshot), "utf8");
        expect(digest(snapshot)).toBe(source.sha256);
        const license = await readFile(join(directory, `task-${skill.id}`, source.licenseFile), "utf8");
        expect(digest(license)).toBe(pinned.licenseSha256);
      }
    });
  }
});
