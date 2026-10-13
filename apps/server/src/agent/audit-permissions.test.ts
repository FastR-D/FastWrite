import { expect, test } from "bun:test";
import { projectAccessFixture } from "../test-support/project-access";

test("project-wide AI records do not disclose restricted prompts or rationales, even after source deletion", async () => {
  const { json, request, owner, member, base, deny, cleanup } = await projectAccessFixture({ agentProvider: {
    async revise() { return { replacement: "Private replacement", rationale: "PRIVATE_RATIONALE_MARKER" }; },
    async planAgentTask() { return { steps: ["PRIVATE_PLAN_MARKER"], affectedFiles: ["private.tex"], risks: [], validation: ["Review"] }; }
  } });
  try {
    await json(base + "/files", owner.token, "POST", { path: "private.tex", content: "Private sentence" });
    const opened = await json(base + "/file?path=private.tex", owner.token);
    const revision = await json(base + "/revisions", owner.token, "POST", { instruction: "PRIVATE_OBJECTIVE_MARKER", selection: { path: "private.tex", from: 0, to: opened.content.length, text: opened.content, fileVersion: opened.file.version } });
    const plan = await json(base + "/agent-tasks", owner.token, "POST", { objective: "PRIVATE_TASK_MARKER", scope: { type: "project" } });
    const endpoints = ["/agent-runs", "/agent-tasks", "/provenance", "/provenance/export", "/issue-resolutions", "/compile-results/latest", "/experiments"];
    for (const endpoint of endpoints) expect((await request(base + endpoint, member.token)).status).toBe(200);
    const rule = await deny("private.tex");
    expect((await request(base + "/change-sets/" + revision.changeSet.id, member.token)).status).toBe(403);
    for (const endpoint of endpoints) {
      const response = await request(base + endpoint, member.token);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("PRIVATE_");
      expect((await request(base + endpoint, owner.token)).status).toBe(200);
    }
    expect((await request(base + "/agent-tasks/" + plan.plan.id + "/cancel", member.token, "POST")).status).toBe(403);
    expect((await request(base + "/files?path=private.tex", owner.token, "DELETE")).status).toBe(204);
    expect((await request(base + "/provenance/export", member.token)).status).toBe(403);
    expect((await request(base + "/acl/" + rule.id, owner.token, "DELETE")).status).toBe(204);
    expect(JSON.stringify(await json(base + "/provenance", member.token))).toContain("PRIVATE_RATIONALE_MARKER");
    expect(JSON.stringify(await json(base + "/agent-runs", member.token))).toContain("PRIVATE_OBJECTIVE_MARKER");
  } finally { await cleanup(); }
});
