import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { JsonDatabase } from "../storage/database";
import { WorkspaceService } from "../workspace/workspace-service";
import { InProcessJobQueue } from "../jobs/job-queue";
import type { AgentProvider } from "../agent/provider";
import type { ReferenceSelection } from "@fastwrite/shared";
import { ReferencePaperService } from "./service";
import { referencePdf } from "./fixtures";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture(provider?: AgentProvider) {
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-reference-")); directories.push(directory);
  const database = new JsonDatabase(directory); await database.initialize();
  const workspaces = new WorkspaceService(directory, database); await workspaces.initialize(); const project = await workspaces.createEmpty("Writing");
  const inputs: string[] = [];
  const agent: AgentProvider = provider ?? { revise: async input => ({ replacement: input.workingText, rationale: "fixture" }), analyzeReferenceStyle: async input => { inputs.push(input.text); return { features: [input.text.includes("INTRO_ONLY") ? "Introduce the problem before describing the approach." : "Close paragraphs with a scoped interpretation."] }; } };
  const store = { load: () => database.snapshot().jobs, save: async (job: import("../jobs/job-queue").JobRecord) => { await database.mutate(state => { state.jobs = state.jobs.filter(item => item.id !== job.id); state.jobs.push(job); }); } };
  const jobs = new InProcessJobQueue({ store }); const service = new ReferencePaperService(directory, database, workspaces, jobs, agent);
  return { directory, database, workspaces, project, inputs, jobs, service, agent, store };
}
const texZip = (body = "INTRO_ONLY. Intro prose.", methodHeading = "section") => zipSync({ "main.tex": strToU8(`\\documentclass{article}\n\\begin{document}\n\\section{Introduction}\n${body}\n\\input{method}\n\\section{Conclusion}\nEND_ONLY. Concluding prose.\n\\end{document}`), "method.tex": strToU8(`\\${methodHeading}{Method}\nMETHOD_ONLY. Method prose.`) });
const choice = (id: string, revision: number, scope: ReferenceSelection["scope"] = { type: "full" }): ReferenceSelection => ({ referenceId: id, parseRevision: revision, scope, aspects: ["structure", "expression"] });
async function importTex(f: Awaited<ReturnType<typeof fixture>>, bytes = texZip()) {
  const paper = await f.service.upload(f.project.id, "Example.zip", bytes); await f.jobs.settled(paper.jobId!); return f.service.get(f.project.id, paper.id);
}

describe("reference writing resources", () => {
  test("task quota rejection preserves uploaded source so parsing can be retried", async () => {
    const f = await fixture();
    const jobs = new InProcessJobQueue({ limits: { total: 1 } });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const blocker = jobs.enqueue("fixture.blocker", {}, async () => gate);
    const service = new ReferencePaperService(f.directory, f.database, f.workspaces, jobs, f.agent);
    const paper = await service.upload(f.project.id, "Retry.zip", texZip());
    expect(paper.status).toBe("failed");
    await access(join(f.directory, "projects", f.project.id, "reference-papers", paper.id, "source"));
    release(); await jobs.settled(blocker.id);
    const retry = await service.startParse(f.project.id, paper.id); await jobs.settled(retry.jobId!);
    expect(service.get(f.project.id, paper.id).status).toBe("ready");
    expect((await service.parsed(f.project.id, paper.id)).text).toContain("END_ONLY");
  });
  test("stores papers separately, deduplicates uploads, and preserves manuscript version and tree", async () => {
    const f = await fixture(); const before = await f.workspaces.tree(f.project.id), version = f.workspaces.getProject(f.project.id).version;
    const paper = await importTex(f); expect(paper.status).toBe("ready");
    expect((await f.service.upload(f.project.id, "Duplicate.zip", texZip())).id).toBe(paper.id);
    expect(await f.workspaces.tree(f.project.id)).toEqual(before); expect(f.workspaces.getProject(f.project.id).version).toBe(version);
    expect(f.database.snapshot().sourceEvidence).toHaveLength(0); expect(f.database.snapshot().paperMemories).toHaveLength(0);
  });
  test("full reference covers every chunk while section and excerpt scopes are exact", async () => {
    const f = await fixture(); const paper = await importTex(f, texZip("INTRO_ONLY. " + "Careful transition. ".repeat(1600), "subsection"));
    const parsed = await f.service.parsed(f.project.id, paper.id);
    const full = await f.service.resolve(f.project.id, [choice(paper.id, 1)]);
    expect(full?.references[0]?.coverage.characters).toBe(parsed.text.length);
    expect(full?.references[0]?.coverage.chunks).toBeGreaterThan(2);
    expect(f.inputs.join("")).toBe(parsed.text); expect(f.inputs.at(-1)).toContain("END_ONLY");
    f.inputs.length = 0;
    const method = paper.sections.find(section => section.title === "Method")!;
    const partial = await f.service.resolve(f.project.id, [choice(paper.id, 1, { type: "sections", sectionIds: [method.id] })]);
    expect(f.inputs.join("")).toContain("METHOD_ONLY"); expect(f.inputs.join("")).not.toContain("INTRO_ONLY"); expect(f.inputs.join("")).not.toContain("END_ONLY");
    expect(partial?.digest).not.toBe(full?.digest);
    expect(partial?.references[0]?.coverage.sections).toEqual(["Method"]);
    f.inputs.length = 0;
    const from = parsed.text.indexOf("INTRO_ONLY"), to = from + "INTRO_ONLY".length;
    await f.service.resolve(f.project.id, [choice(paper.id, 1, { type: "excerpt", from, to })]); expect(f.inputs).toEqual(["INTRO_ONLY"]);
  });
  test("page scope reads only selected PDF pages and uses source positions", async () => {
    const f = await fixture(); const paper = await f.service.upload(f.project.id, "Example.pdf", referencePdf([["Introduction", "FIRST_PAGE_ONLY"], ["Conclusion", "SECOND_PAGE_ONLY"]])); await f.jobs.settled(paper.jobId!);
    const context = await f.service.resolve(f.project.id, [choice(paper.id, 1, { type: "pages", from: 2, to: 2 })]);
    expect(f.inputs.join("")).toContain("SECOND_PAGE_ONLY"); expect(f.inputs.join("")).not.toContain("FIRST_PAGE_ONLY"); expect(context?.references[0]?.examples[0]?.locator.page).toBe(2);
  });
  test("completion reads only prepared cache, never launches an analysis call", async () => {
    const f = await fixture(); const paper = await importTex(f); const selected = [choice(paper.id, 1)];
    await f.service.saveSettings(f.project.id, selected, 0);
    expect(await f.service.resolve(f.project.id, undefined, undefined, true)).toBeUndefined(); expect(f.inputs).toHaveLength(0);
    await f.service.resolve(f.project.id); const calls = f.inputs.length;
    const context = await f.service.resolve(f.project.id, undefined, undefined, true);
    expect(context?.references[0]?.features.length).toBeGreaterThan(0); expect(context?.references[0]?.examples).toHaveLength(0); expect(f.inputs.length).toBe(calls);
  });
  test("model changes during analysis cannot publish patterns under the old model cache key", async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture({ revise: async input => ({ replacement: input.workingText, rationale: "fixture" }), analyzeReferenceStyle: async () => { entered(); await gate; return { features: ["Use a bounded transition"] }; } });
    let model = "first";
    const service = new ReferencePaperService(f.directory, f.database, f.workspaces, f.jobs, f.agent, () => model);
    const paper = await importTex(f); await service.saveSettings(f.project.id, [choice(paper.id, 1)], 0);
    const statuses = await service.prepare(f.project.id); await started;
    model = "second"; release(); await f.jobs.settled(statuses[0]!.jobId!);
    expect(f.jobs.get(statuses[0]!.jobId!)?.status).toBe("failed");
    expect(f.jobs.get(statuses[0]!.jobId!)?.error).toContain("configuration changed");
    expect(await service.resolve(f.project.id, undefined, undefined, true)).toBeUndefined();
    const retry = await service.resolve(f.project.id);
    expect(retry?.references[0]?.features).toContain("Use a bounded transition");
  });
  test("selection versions, project ownership and optimistic settings writes are enforced", async () => {
    const f = await fixture(); const paper = await importTex(f); const other = await f.workspaces.createEmpty("Other");
    expect(f.service.resolve(other.id, [choice(paper.id, 1)])).rejects.toMatchObject({ status: 404 });
    expect(f.service.saveSettings(f.project.id, [choice(paper.id, 2)], 0)).rejects.toMatchObject({ status: 409 });
    await f.service.saveSettings(f.project.id, [choice(paper.id, 1)], 0);
    expect(f.service.saveSettings(f.project.id, [], 0)).rejects.toMatchObject({ code: "reference_settings_changed" });
    const reparsed = await f.service.startParse(f.project.id, paper.id); await f.jobs.settled(reparsed.jobId!);
    expect(f.service.settings(f.project.id).selections).toHaveLength(0);
    expect(f.service.resolve(f.project.id, [choice(paper.id, 1)])).rejects.toMatchObject({ code: "reference_selection_stale" });
  });
  test("multiple entry files require selection; no silent first-file choice", async () => {
    const f = await fixture(); const bytes = zipSync({ "a.tex": strToU8("\\documentclass{article}\n\\begin{document}\\section{A}Alpha\\end{document}"), "b.tex": strToU8("\\documentclass{article}\n\\begin{document}\\section{B}Beta\\end{document}") });
    const paper = await f.service.upload(f.project.id, "Multiple.zip", bytes); expect(paper.status).toBe("needs-input"); expect(paper.jobId).toBeUndefined();
    const selected = await f.service.startParse(f.project.id, paper.id, "b.tex"); await f.jobs.settled(selected.jobId!);
    expect((await f.service.parsed(f.project.id, paper.id)).text).toContain("Beta"); expect((await f.service.parsed(f.project.id, paper.id)).text).not.toContain("Alpha");
  });
  test("restores a persisted unfinished parse task after restart", async () => {
    const f = await fixture(); const paper = await importTex(f);
    const persisted = f.jobs.get(paper.jobId!)!;
    await f.database.mutate(state => { state.jobs = [{ ...persisted, status: "running", attempts: 0 }]; state.referencePapers[0]!.status = "parsing"; });
    const jobs = new InProcessJobQueue({ store: f.store }); const restored = new ReferencePaperService(f.directory, f.database, f.workspaces, jobs, f.agent);
    await restored.initialize(); await jobs.settled(persisted.id);
    expect(restored.get(f.project.id, paper.id).status).toBe("ready"); expect(jobs.get(persisted.id)?.status).toBe("completed");
  });
  test("deleting during profile generation cancels publication and removes active settings", async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture({ revise: async input => ({ replacement: input.workingText, rationale: "fixture" }), analyzeReferenceStyle: async () => { entered(); await gate; return { features: ["A transition pattern"] }; } });
    const paper = await importTex(f); await f.service.saveSettings(f.project.id, [choice(paper.id, 1)], 0);
    const statuses = await f.service.prepare(f.project.id); await started;
    await f.service.remove(f.project.id, paper.id); release(); await f.jobs.settled(statuses[0]!.jobId!);
    expect(f.service.list(f.project.id)).toHaveLength(0); expect(f.service.settings(f.project.id).selections).toHaveLength(0);
    expect(access(join(f.directory, "projects", f.project.id, "reference-papers", paper.id))).rejects.toThrow();
  });
});
