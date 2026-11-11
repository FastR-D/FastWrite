import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SkillRegistry } from "./skill-registry";

const directory = join(import.meta.dir, "../skills");
const registry = new SkillRegistry(directory);
// Runtime contracts belong here; upstream research snapshots and model quality
// evaluations remain in the explicit skills:eval commands.
const integratedTasks = [
  "scientific-writing",
  "literature-synthesis",
  "citation-verification",
  "structured-peer-review",
  "academic-prose-polish",
  "reviewer-response",
  "research-content-writing",
  "paper-reading-notes",
  "evidence-storyline",
  "experiment-reporting",
  "results-discussion",
  "figure-caption-audit",
  "manuscript-consistency"
];

test.each(integratedTasks)("%s is discoverable, self-contained, attributed and review-bounded", async id => {
  const { descriptor, instructions } = await registry.loadTask(id);
  const root = join(directory, `task-${id}`);
  const provenance = JSON.parse(await readFile(join(root, "provenance.json"), "utf8"));
  expect(descriptor).toMatchObject({ id, version: provenance.version, supportedIntents: ["draft", "continue", "revise"], allowedScope: "project", allowNewFiles: false, requiresReview: true });
  expect(descriptor.requiredEvidence.length).toBeGreaterThan(0);
  expect(instructions.length).toBeGreaterThan(0);
  expect(instructions.length).toBeLessThan(6000);
  expect(instructions).not.toMatch(/(?:scripts|assets|references)\/[\w.-]+/);
  expect(provenance.id).toBe(id);
  expect(provenance.sources.length).toBeGreaterThan(0);
  expect(new Set(provenance.sources.map((source: { id: string }) => source.id)).size).toBe(provenance.sources.length);
  for (const source of provenance.sources) {
    expect(new URL(source.url).protocol).toBe("https:");
    if (source.commit) {
      expect(source.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(source.url).toContain(source.commit);
      expect(source.license).toBeTruthy();
      expect(source.licenseFile).toMatch(/^LICENSE[\w.-]*$/);
      expect((await readFile(join(root, source.licenseFile), "utf8")).length).toBeGreaterThan(100);
    } else {
      expect(source.access).toMatch(/^body/);
      expect(source.url).not.toMatch(/xsec_|user\/profile|collection\//);
    }
  }
  if (provenance.ruleIds) {
    expect(provenance.ruleIds.length).toBeGreaterThan(0);
    expect(new Set(provenance.ruleIds).size).toBe(provenance.ruleIds.length);
  }
});
