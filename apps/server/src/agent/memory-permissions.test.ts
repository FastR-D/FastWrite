import { expect, test } from "bun:test";
import { projectAccessFixture } from "../test-support/project-access";

test("Memory reads and every mutation honor source and memory file permissions, including deleted sources", async () => {
  let agentCalls = 0;
  const { json, request, owner, member, base, deny, cleanup } = await projectAccessFixture({ agentProvider: {
    async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
    async extractMemory() { agentCalls++; return { items: [{ category: "contribution", label: "Private fact", content: "PRIVATE_MEMORY_MARKER", sources: [{ path: "private.tex", excerpt: "PRIVATE_MEMORY_MARKER", section: null, line: null }] }] }; },
    async summarizeMemory() { agentCalls++; return { overview: "PRIVATE_MEMORY_MARKER", sections: [] }; },
    async polishMemory(input) { agentCalls++; return { content: input.content }; }
  } });
  try {
    await json(base + "/files", owner.token, "POST", { path: "private.tex", content: "PRIVATE_MEMORY_MARKER" });
    await json(base + "/files", owner.token, "POST", { path: "memory.md", content: "# Memory\n## Reviewed Context\nPRIVATE_MEMORY_MARKER\n" });
    const rule = await deny("memory.md");
    expect((await request(base + "/memory", member.token)).status).toBe(403);
    expect(JSON.stringify(await json(base + "/memory", owner.token))).toContain("PRIVATE_MEMORY_MARKER");
    expect((await request(base + "/acl/" + rule.id, owner.token, "DELETE")).status).toBe(204);
    const memory = await json(base + "/memory/extract", owner.token, "POST");
    expect(memory.items).toHaveLength(1);
    const sourceRule = await deny("private.tex");
    const callsBefore = agentCalls;
    const operations = [
      ["GET", "/memory", undefined], ["POST", "/memory/extract", undefined], ["POST", "/memory/apply", undefined],
      ["PATCH", "/memory/overview", { content: "Edited" }], ["POST", "/memory/overview/accept", undefined],
      ["PATCH", "/memory/sections/section-fixture", { content: "Edited" }], ["POST", "/memory/sections/section-fixture/accept", undefined],
      ["PATCH", "/memory/items/" + memory.items[0].id, { content: "Edited" }], ["POST", "/memory/items/" + memory.items[0].id + "/accept", undefined], ["POST", "/memory/rollback", undefined]
    ] as const;
    for (const [method, path, body] of operations) expect((await request(base + path, member.token, method, body)).status).toBe(403);
    expect(agentCalls).toBe(callsBefore);
    expect((await request(base + "/files?path=private.tex", owner.token, "DELETE")).status).toBe(204);
    expect((await request(base + "/memory", member.token)).status).toBe(403);
    expect((await request(base + "/memory/rollback", member.token, "POST")).status).toBe(403);
    expect((await request(base + "/acl/" + sourceRule.id, owner.token, "DELETE")).status).toBe(204);
    expect(JSON.stringify(await json(base + "/memory", member.token))).toContain("PRIVATE_MEMORY_MARKER");
    for (const action of ["edit", "run_ai"]) {
      const denied = await deny("memory.md", action);
      expect((await request(base + "/memory/extract", member.token, "POST")).status).toBe(403);
      expect((await request(base + "/memory/overview", member.token, "PATCH", { content: "Edited" })).status).toBe(403);
      expect(agentCalls).toBe(callsBefore);
      expect((await request(base + "/acl/" + denied.id, owner.token, "DELETE")).status).toBe(204);
    }
    expect((await json(base + "/memory/overview", member.token, "PATCH", { content: "Authorized edit" })).overview.content).toBe("Authorized edit");
  } finally { await cleanup(); }
});
