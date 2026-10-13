import { expect, test } from "bun:test";
import { projectAccessFixture } from "../test-support/project-access";

test("targeted re-review rechecks read and AI permissions before sending the project to its provider", async () => {
  let rereviews = 0;
  const { json, request, owner, member, base, deny, cleanup } = await projectAccessFixture({ agentProvider: {
    async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
    async review() { return { overallAssessment: "Clarify the boundary", recommendation: "reject", strengths: [], weaknesses: ["Missing boundary"], nextSteps: ["Clarify"], issues: [{ category: "threat-model", severity: "major", title: "Unclear boundary", rationale: "The boundary is unclear", impact: "Ambiguity", suggestion: "Clarify", evidence: [{ path: "private.tex", section: null, line: null, excerpt: "PRIVATE_REVIEW_INPUT", inferred: false }] }] }; },
    async planAgentTask() { return { steps: ["Clarify"], affectedFiles: ["private.tex"], risks: [], validation: ["Compile"] }; },
    async generateAgentTask(input) { return { files: [{ path: "private.tex", content: input.documents.find(item => item.path === "private.tex")!.content + "\nThe boundary is explicit.\n", rationale: "Clarifies the boundary" }] }; },
    async rereviewIssues(input) { rereviews++; expect(JSON.stringify(input)).toContain("PRIVATE_REVIEW_INPUT"); return { assessments: input.issues.map(issue => ({ issueId: issue.id, resolved: true, assessment: "Resolved" })), regressions: [] }; }
  } });
  try {
    await json(base + "/files", owner.token, "POST", { path: "private.tex", content: "PRIVATE_REVIEW_INPUT\n" });
    const review = await json(base + "/reviews", owner.token, "POST", { sourceOnly: true });
    const plan = await json(base + "/agent-tasks", owner.token, "POST", { objective: "Clarify the boundary", scope: { type: "project" }, issueIds: [review.report.issues[0].id] });
    const generated = await json(base + "/agent-tasks/" + plan.plan.id + "/confirm", owner.token, "POST");
    await json(base + "/change-sets/" + generated.changeSet.id + "/accept", owner.token, "POST");
    await json(base + "/compile-results", owner.token, "POST", { projectVersion: (await json(base, owner.token)).version, status: "success", summary: "Isolated test fixture" });
    const endpoint = base + "/issue-resolutions/" + plan.resolution.id + "/rereview";
    for (const action of ["read", "run_ai"]) {
      const rule = await deny("private.tex", action);
      expect((await request(endpoint, member.token, "POST")).status).toBe(403);
      expect(rereviews).toBe(0);
      expect((await request(base + "/acl/" + rule.id, owner.token, "DELETE")).status).toBe(204);
    }
    expect((await json(endpoint, member.token, "POST")).status).toBe("resolved");
    expect(rereviews).toBe(1);
  } finally { await cleanup(); }
});
