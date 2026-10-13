import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import type { AgentTaskPlanResponse, DraftPlanResponse, FileContentResponse, PaperProject, ReferencePaper, ReferenceSettings, ReviseResponse, StyleReferenceContext } from "@fastwrite/shared";
import { createApplication } from "../app";
import { referenceTestOutline, referenceTestProvider } from "./test-provider";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const json = (method: string, body: unknown, token?: string): RequestInit => ({ method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
async function fixture(auth = false) {
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-reference-api-")); directories.push(directory);
  const calls: Array<{ operation: string; input: unknown }> = [];
  const app = await createApplication(directory, { agentProvider: referenceTestProvider(calls), features: { serverAuth: auth }, ...(auth ? { bootstrapAdmin: { email: "reference-admin@example.test", password: "reference-testing-password" } } : {}) });
  const request = (path: string, init?: RequestInit) => app(new Request(`http://fastwrite.test${path}`, init));
  return { request, calls };
}
async function ready(request: Awaited<ReturnType<typeof fixture>>["request"], root: string, token?: string) {
  const upload = await request(`${root}/reference-papers?name=Example.zip`, { method: "POST", ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}), body: zipSync({ "main.tex": strToU8("\\documentclass{article}\n\\begin{document}\n\\section{Introduction}\nREFERENCE_FACT_999. Problem before gap before response.\\section{Conclusion}\nEnd with a scoped interpretation.\\end{document}") }) });
  expect(upload.status).toBe(202); const paper = await upload.json() as ReferencePaper;
  for (let attempt = 0; attempt < 100; attempt++) {
    const list = await (await request(`${root}/reference-papers`, token ? { headers: { authorization: `Bearer ${token}` } } : undefined)).json() as ReferencePaper[];
    const found = list.find(item => item.id === paper.id)!; if (found.status === "ready") return found;
    if (found.status === "failed") throw new Error(found.error);
    await Bun.sleep(5);
  }
  throw new Error("Reference parsing did not complete");
}

describe("reference writing API", () => {
  test("references reach revise, completion, Agent and Draft; approved plans freeze their context", async () => {
    const { request, calls } = await fixture();
    const project = await (await request("/api/projects", json("POST", { name: "Own manuscript" }))).json() as PaperProject;
    const root = `/api/projects/${project.id}`;
    const original = await (await request(`${root}/file?path=main.tex`)).json() as FileContentResponse;
    const content = "\\documentclass{article}\n\\begin{document}\n\\section{Introduction}\nOriginal statement. Our protocol preserves 17 observations.\n\\section{Conclusion}\nUnrelated conclusion.\n\\end{document}\n";
    expect((await request(`${root}/file?path=main.tex`, json("PUT", { content, baseVersion: original.file.version }))).status).toBe(200);
    const opened = await (await request(`${root}/file?path=main.tex`)).json() as FileContentResponse;
    const paper = await ready(request, root);
    const selection = { referenceId: paper.id, parseRevision: paper.parseRevision, scope: { type: "sections", sectionIds: [paper.sections[0]!.id] }, aspects: ["paragraphs", "expression"] };
    expect((await request(`${root}/reference-selections`, json("PUT", { revision: 0, selections: [selection] }))).status).toBe(200);
    const from = content.indexOf("Original statement."), to = content.indexOf("\n\\section{Conclusion}");
    const revised = await request(`${root}/revisions`, json("POST", { instruction: "Use the reference paragraph pattern", selection: { path: "main.tex", text: content.slice(from, to), from, to, startLine: 4, endLine: 4, fileVersion: opened.file.version } }));
    expect(revised.status).toBe(201); const result = await revised.json() as ReviseResponse;
    expect(result.run.styleReferenceContext?.references[0]?.scope.type).toBe("sections");
    expect(result.changeSet.changes[0]!.after).toContain("17 observations"); expect(result.changeSet.changes[0]!.after).not.toContain("REFERENCE_FACT_999");
    const proposed = await (await request(`${root}/file?path=main.tex`)).json() as FileContentResponse; expect(proposed.content).toBe(content);
    expect((await request(`${root}/change-sets/${result.changeSet.id}/accept`, { method: "POST" })).status).toBe(200);
    const accepted = await (await request(`${root}/file?path=main.tex`)).json() as FileContentResponse;
    expect(accepted.content).toContain("Revised statement."); expect(accepted.content).toContain("Unrelated conclusion.");
    expect((await request(`${root}/change-sets/${result.changeSet.id}/rollback`, json("POST", {}))).status).toBe(200);
    const rolledBack = await (await request(`${root}/file?path=main.tex`)).json() as FileContentResponse; expect(rolledBack.content).toBe(content);
    expect((await request(`${root}/completions`, json("POST", { path: "main.tex", cursor: to, fileVersion: rolledBack.file.version, kind: "auto" }))).status).toBe(201);
    const completion = calls.find(call => call.operation === "complete")!.input as { styleReferenceContext: StyleReferenceContext }; expect(completion.styleReferenceContext.references[0]!.examples).toHaveLength(0);
    const planned = await request(`${root}/agent-tasks`, json("POST", { objective: "/revise improve the Introduction flow", scope: { type: "file", path: "main.tex" } })); expect(planned.status).toBe(201);
    const plan = await planned.json() as AgentTaskPlanResponse;
    const frozen = plan.plan.styleReferenceContext!.digest;
    const settings = await (await request(`${root}/reference-selections`)).json() as ReferenceSettings;
    await request(`${root}/reference-selections`, json("PUT", { revision: settings.revision, selections: [] }));
    const generated = await request(`${root}/agent-tasks/${plan.plan.id}/confirm`, { method: "POST" }); expect(generated.status).toBe(201);
    const generatedInput = calls.find(call => call.operation === "generate")!.input as { documents: Array<{ content: string }>; styleReferenceContext: StyleReferenceContext };
    expect(generatedInput.styleReferenceContext.digest).toBe(frozen); expect(generatedInput.documents.map(document => document.content).join("")).not.toContain("REFERENCE_FACT_999");
    const draftResponse = await request(`${root}/drafts`, json("POST", { brief: "Describe the protocol and its scope without inventing results.", references: [selection] })); expect(draftResponse.status).toBe(201);
    const draft = await draftResponse.json() as DraftPlanResponse;
    await request(`${root}/reference-papers/${paper.id}`, { method: "DELETE" });
    const draftGenerated = await request(`${root}/drafts/${draft.plan.id}/confirm`, json("POST", { outline: referenceTestOutline })); expect(draftGenerated.status).toBe(201);
    const draftInput = calls.find(call => call.operation === "draft-generate")!.input as { styleReferenceContext: StyleReferenceContext }; expect(draftInput.styleReferenceContext.digest).toBe(draft.plan.styleReferenceContext!.digest);
  });
  test("project authorization protects list, sources, settings and analysis", async () => {
    const { request } = await fixture(true);
    const owner = await (await request("/api/auth/register", json("POST", { email: "reference-owner@example.test", password: "reference-testing-password" }))).json() as { token: string };
    const other = await (await request("/api/auth/register", json("POST", { email: "reference-other@example.test", password: "reference-testing-password" }))).json() as { token: string };
    const project = await (await request("/api/projects", json("POST", { name: "Private references" }, owner.token))).json() as PaperProject;
    const root = `/api/projects/${project.id}`, paper = await ready(request, root, owner.token);
    for (const suffix of ["reference-papers", `reference-papers/${paper.id}/text`, `reference-papers/${paper.id}/source`, "reference-selections", "reference-profiles"]) expect((await request(`${root}/${suffix}`, { headers: { authorization: `Bearer ${other.token}` } })).status).toBe(403);
    expect((await request(`${root}/reference-profiles`, { method: "POST", headers: { authorization: `Bearer ${other.token}` } })).status).toBe(403);
    expect((await request(`${root}/reference-papers`)).status).toBe(401);
    const otherProject = await (await request("/api/projects", json("POST", { name: "Other" }, other.token))).json() as PaperProject;
    expect((await request(`/api/projects/${otherProject.id}/reference-papers/${paper.id}/text`, { headers: { authorization: `Bearer ${other.token}` } })).status).toBe(404);
    const selected = { referenceId: paper.id, parseRevision: 1, scope: { type: "full" }, aspects: ["structure"] };
    expect((await request(`${root}/reference-selections`, json("PUT", { revision: 0, selections: [selected] }, owner.token))).status).toBe(200);
    expect((await request(`${root}/reference-profiles`, { method: "POST", headers: { authorization: `Bearer ${owner.token}` } })).status).toBe(202);
    for (let attempt = 0; attempt < 100; attempt++) { const statuses = await (await request(`${root}/reference-profiles`, { headers: { authorization: `Bearer ${owner.token}` } })).json() as Array<{ status: string; error?: string }>; if (statuses[0]?.status === "completed") break; if (statuses[0]?.status === "failed") throw new Error(statuses[0].error); await Bun.sleep(5); }
    expect((await request(`${root}/reference-profiles`, { headers: { authorization: `Bearer ${owner.token}` } })).status).toBe(200);
  });
});
