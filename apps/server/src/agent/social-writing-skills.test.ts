import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { SkillRegistry } from "./skill-registry";

const skillsDirectory = join(import.meta.dir, "../skills");
const evaluation = resolve(import.meta.dir, "../../../../evaluation/social-research-skills");
const integrations = JSON.parse(await readFile(join(evaluation, "integrations.json"), "utf8")) as Array<{ id: string; version: string; sources: string[]; rules: string[] }>;
const reviews = JSON.parse(await readFile(join(evaluation, "reviews.json"), "utf8")) as Array<{ id: string; url: string; access: string; usedForRules: boolean }>;
const rules = JSON.parse(await readFile(join(evaluation, "rules.json"), "utf8")) as Array<{ id: string; skill: string; fixture: string; sources: string[] }>;
const cases = JSON.parse(await readFile(join(evaluation, "cases.json"), "utf8")) as Array<{ id: string; skill: string; language: string }>;
const registry = new SkillRegistry(skillsDirectory);
const summary = JSON.parse(await readFile(join(evaluation, "codex-summary.json"), "utf8"));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

describe("social research methods integrated into manuscript writing", () => {
  for (const skill of integrations) {
    test(`${skill.id}: runtime instructions and traceable, tested editorial rules`, async () => {
      const loaded = await registry.loadTask(skill.id);
      expect(loaded.descriptor).toMatchObject({ version: skill.version, supportedIntents: ["draft", "continue", "revise"], allowedScope: "project", allowNewFiles: false, requiresReview: true });
      expect(loaded.descriptor.requiredEvidence.length).toBeGreaterThan(1);
      expect(loaded.instructions.length).toBeLessThan(6000);
      expect(loaded.instructions).not.toMatch(/(?:scripts|assets|references)\/[\w.-]+/);
      const provenance = JSON.parse(await readFile(join(skillsDirectory, `task-${skill.id}`, "provenance.json"), "utf8"));
      expect(provenance.sources.map((s: { id: string }) => s.id)).toEqual(skill.sources);
      expect(provenance.ruleIds).toEqual(skill.rules);
      for (const source of provenance.sources) {
        const reviewed = reviews.find(s => s.id === source.id);
        expect(reviewed?.usedForRules).toBe(true);
        expect(reviewed?.access).toMatch(/^body/);
        expect(source.url).toBe(reviewed?.url);
        expect(source.url).not.toMatch(/xsec_|user\/profile|collection\//);
      }
      for (const ruleId of skill.rules) {
        const rule = rules.find(r => r.id === ruleId);
        expect(rule?.skill).toBe(skill.id);
        expect(rule?.sources.every(s => skill.sources.includes(s))).toBe(true);
        expect(cases.some(c => c.id === rule?.fixture && c.skill === skill.id)).toBe(true);
      }
      expect(cases.filter(c => c.skill === skill.id).map(c => c.language)).toEqual(["中文", "English"]);
      // A stale acceptance report must not certify a changed runtime Skill or fixture.
      const accepted = summary.selectedResults.find((r: { id: string }) => r.id === skill.id);
      expect(accepted.version).toBe(skill.version);
      expect(accepted.instructionSha256).toBe(hash(loaded.instructions));
      expect(accepted.fixtureSha256).toBe(hash(JSON.stringify(cases.filter(c => c.skill === skill.id))));
      expect(accepted.checksPassed).toBe(accepted.checksTotal);
      expect(accepted.toolCalls).toBe(0);
    });
  }
});
