import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateReview } from "./review-metrics";

const directory = dirname(fileURLToPath(import.meta.url));

describe("Security Top-4 evaluation", () => {
  test("uses one shared profile for all four security conferences", async () => {
    const questions = JSON.parse(await readFile(join(directory, "questions.json"), "utf8")) as Array<{ profile: string; expectedSignals: string[] }>;
    expect(new Set(questions.map((item) => item.profile))).toEqual(new Set(["security-top4"]));
    const guidance = (await readFile(join(directory, "..", "references", "profile.md"), "utf8")).toLowerCase();
    for (const question of questions) {
      for (const signal of question.expectedSignals) expect(guidance).toContain(signal.toLowerCase());
    }
  });

  test("produces repeatable evidence, inference and duplicate metrics", () => {
    const expected = [{
      key: "threat-boundary",
      category: "threat-model",
      titleTerms: ["endpoint", "boundary"],
      evidence: [
        { path: "threat.tex", excerptFragment: "trusted endpoint", inferred: false },
        { path: "evaluation.tex", excerptFragment: "", inferred: true }
      ]
    }];
    const actual = [{
      category: "threat-model",
      title: "Endpoint boundary is underspecified",
      rationale: "The endpoint compromise boundary is unclear.",
      evidence: [
        { path: "threat.tex", excerpt: "The trusted endpoint processes reports.", inferred: false },
        { path: "evaluation.tex", excerpt: "No compromise experiment is supplied.", inferred: true }
      ]
    }];
    expect(evaluateReview(expected, actual)).toEqual({ issueRecall: 1, evidenceAccuracy: 1, inferenceMarkRate: 1, duplicateRate: 0 });
  });
});
