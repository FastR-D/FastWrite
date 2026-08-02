import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChangeSet, CompletionResponse, FileContentResponse, PaperProject, ReviseResponse, UploadSession, WorkspaceTreeNode } from "@fastwrite/shared";
import type { AgentProvider, CompletionAgentInput, ReviseAgentInput } from "./agent/provider";
import { createApplication, mimeType } from "./app";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function testApplication(agentProvider?: AgentProvider) {
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-test-"));
  temporaryDirectories.push(directory);
  const app = await createApplication(directory, { ...(agentProvider ? { agentProvider } : {}) });
  return (path: string, init?: RequestInit) => app(new Request(`http://fastwrite.test${path}`, init));
}

describe("workspace API", () => {
  test("serves module workers with a browser-safe MIME type", () => {
    expect(mimeType(".mjs")).toBe("text/javascript; charset=utf-8");
    expect(mimeType(".wasm")).toBe("application/wasm");
  });

  test("creates, reads and version-checks an empty project", async () => {
    const request = await testApplication();
    const createdResponse = await request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Legacy conference values are intentionally normalized to the shared Security Top-4 profile.
      body: JSON.stringify({ name: "Test Paper", mainDocument: "main.tex", venue: "sp" })
    });
    expect(createdResponse.status).toBe(201);
    const project = (await createdResponse.json()) as PaperProject;
    expect(project.skill).toMatchObject({ id: "security-top4", name: "Security Top-4", venue: "security-top4" });

    const tree = (await (await request(`/api/projects/${project.id}/files`)).json()) as WorkspaceTreeNode[];
    expect(tree[0]?.path).toBe("main.tex");

    const opened = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    expect(opened.content).toContain("\\documentclass");

    const savedResponse = await request(`/api/projects/${project.id}/file?path=main.tex`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: `${opened.content}\n% saved`, baseVersion: opened.file.version })
    });
    expect(savedResponse.status).toBe(200);

    const conflict = await request(`/api/projects/${project.id}/file?path=main.tex`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "stale", baseVersion: opened.file.version })
    });
    expect(conflict.status).toBe(409);
  });

  test("copies a browser directory upload into a managed workspace", async () => {
    const request = await testApplication();
    const main = new TextEncoder().encode("\\documentclass{article}\n\\begin{document}Hi\\end{document}");
    const bib = new TextEncoder().encode("@article{fastwrite, title={FastWrite}}");
    const sessionResponse = await request("/api/upload-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectName: "Uploaded Paper",
        mainDocument: "main.tex",
        venue: "security-top4",
        sourceName: "paper-folder",
        entries: [
          { path: "main.tex", kind: "file", size: main.byteLength },
          { path: "refs/library.bib", kind: "file", size: bib.byteLength },
          { path: "figures/empty", kind: "directory", size: 0 },
          { path: ".writeagent/backups/main.tex/old.tex", kind: "file", size: 999 }
        ]
      })
    });
    expect(sessionResponse.status).toBe(201);
    const session = (await sessionResponse.json()) as UploadSession;
    expect(session.entries.some((entry) => entry.path.startsWith(".writeagent"))).toBe(false);
    for (const [path, bytes] of [["main.tex", main], ["refs/library.bib", bib]] as const) {
      const response = await request(`/api/upload-sessions/${session.id}/files?path=${encodeURIComponent(path)}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: bytes
      });
      expect(response.status).toBe(200);
    }
    const completed = await request(`/api/upload-sessions/${session.id}/complete`, { method: "POST" });
    expect(completed.status).toBe(201);
    const project = (await completed.json()) as PaperProject;
    expect(project.source).toEqual({ type: "local", displayName: "paper-folder" });
    const file = (await (await request(`/api/projects/${project.id}/file?path=${encodeURIComponent("refs/library.bib")}`)).json()) as FileContentResponse;
    expect(file.content).toContain("fastwrite");
  });

  test("renames, configures, trashes and exports workspace files", async () => {
    const request = await testApplication();
    const created = await request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Lifecycle Paper", mainDocument: "main.tex", venue: "security-top4" })
    });
    const project = (await created.json()) as PaperProject;

    expect((await request(`/api/projects/${project.id}/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: ".writeagent/backups/main.tex/old.tex", content: "old copy" })
    })).status).toBe(400);

    expect((await request(`/api/projects/${project.id}/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "sections/evaluation.tex", content: "Evaluation" })
    })).status).toBe(201);
    const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const addedAsset = await request(`/api/projects/${project.id}/assets?path=${encodeURIComponent("figures/plot.png")}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: imageBytes
    });
    expect(addedAsset.status).toBe(201);
    const openedAsset = await request(`/api/projects/${project.id}/asset?path=${encodeURIComponent("figures/plot.png")}`);
    expect(new Uint8Array(await openedAsset.arrayBuffer())).toEqual(imageBytes);
    expect((await request(`/api/projects/${project.id}/files`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "sections/evaluation.tex", to: "sections/results.tex" })
    })).status).toBe(204);

    const updatedResponse = await request(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Updated Paper", mainDocument: "sections/results.tex", venue: "ai-top-tier" })
    });
    const updated = (await updatedResponse.json()) as PaperProject;
    expect(updated).toMatchObject({ name: "Updated Paper", mainDocument: "sections/results.tex" });
    expect(updated.skill).toMatchObject({ id: "ai-top-tier", name: "AI Top-Tier", venue: "ai-top-tier" });

    const protectedDelete = await request(`/api/projects/${project.id}/files?path=${encodeURIComponent("sections/results.tex")}`, { method: "DELETE" });
    expect(protectedDelete.status).toBe(409);
    const oldMainDelete = await request(`/api/projects/${project.id}/files?path=main.tex`, { method: "DELETE" });
    expect(oldMainDelete.status).toBe(204);
    expect((await request(`/api/projects/${project.id}/file?path=main.tex`)).status).toBe(404);

    const archive = await request(`/api/projects/${project.id}/export`);
    expect(archive.status).toBe(200);
    expect(archive.headers.get("content-type")).toBe("application/gzip");
    expect(archive.headers.get("content-disposition")).toContain("Updated-Paper.tar.gz");
    const tar = Bun.gunzipSync(new Uint8Array(await archive.arrayBuffer()));
    const archiveText = new TextDecoder().decode(tar);
    expect(archiveText).toContain("sections/results.tex");
    expect(archiveText).toContain("Evaluation");
  });

  test("builds a document-order outline across included TeX files", async () => {
    const request = await testApplication();
    const created = await request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Outline Paper" })
    });
    const project = (await created.json()) as PaperProject;
    for (const [path, content] of [
      ["sections/introduction.tex", "\\section{Introduction}\n\\subsection{Motivation}"],
      ["sections/evaluation.tex", "\\section{Evaluation}"]
    ] as const) {
      expect((await request(`/api/projects/${project.id}/files`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, content })
      })).status).toBe(201);
    }
    const opened = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    await request(`/api/projects/${project.id}/file?path=main.tex`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "\\input{sections/introduction}\n\\input{sections/evaluation.tex}", baseVersion: opened.file.version })
    });
    const outline = (await (await request(`/api/projects/${project.id}/outline`)).json()) as Array<{ title: string; path: string; children: Array<{ title: string }> }>;
    expect(outline).toMatchObject([
      { title: "Introduction", path: "sections/introduction.tex", children: [{ title: "Motivation" }] },
      { title: "Evaluation", path: "sections/evaluation.tex", children: [] }
    ]);
  });

  test("proposes, approves, rolls back and conflict-checks a Skill-driven revision", async () => {
    let received: ReviseAgentInput | undefined;
    const provider: AgentProvider = {
      async revise(input) {
        received = input;
        return { replacement: "We build a system that improves security.", rationale: "Corrects subject–verb agreement." };
      }
    };
    const request = await testApplication(provider);
    const project = (await (await request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Revision Paper", venue: "security-top4" })
    })).json()) as PaperProject;
    const initial = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    const selectedText = "We build a system that improve security.";
    const content = `\\section{Introduction}\n${selectedText}\n`;
    await request(`/api/projects/${project.id}/file?path=main.tex`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, baseVersion: initial.file.version })
    });
    const opened = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    const from = opened.content.indexOf(selectedText);
    const selection = { path: "main.tex", text: selectedText, from, to: from + selectedText.length, startLine: 2, endLine: 2, fileVersion: opened.file.version };

    const proposedResponse = await request(`/api/projects/${project.id}/revisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection, command: "grammar" })
    });
    expect(proposedResponse.status).toBe(201);
    const proposed = (await proposedResponse.json()) as ReviseResponse;
    expect(proposed.run).toMatchObject({ status: "waiting-approval", skill: { id: "security-top4", venue: "security-top4" } });
    expect(proposed.changeSet).toMatchObject({ status: "proposed", summary: "Grammar" });
    expect(received?.sectionTitle).toBe("Introduction");
    expect(received?.skillInstructions).toContain("# Security Top-4");
    expect(received?.venueInstructions).toContain("# Security Top-4");
    expect((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse).content).toContain(selectedText);

    const accepted = (await (await request(`/api/projects/${project.id}/change-sets/${proposed.changeSet.id}/accept`, { method: "POST" })).json()) as ChangeSet;
    expect(accepted.status).toBe("accepted");
    expect((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse).content).toContain("improves security");

    const rolledBack = (await (await request(`/api/projects/${project.id}/change-sets/${proposed.changeSet.id}/rollback`, { method: "POST" })).json()) as ChangeSet;
    expect(rolledBack.status).toBe("rolled-back");
    const restored = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    expect(restored.content).toContain(selectedText);

    const staleSelection = { ...selection, fileVersion: restored.file.version };
    const second = (await (await request(`/api/projects/${project.id}/revisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: staleSelection, instruction: "Make this clearer" })
    })).json()) as ReviseResponse;
    await request(`/api/projects/${project.id}/file?path=main.tex`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: `${restored.content}% concurrent edit`, baseVersion: restored.file.version })
    });
    expect((await request(`/api/projects/${project.id}/change-sets/${second.changeSet.id}/accept`, { method: "POST" })).status).toBe(409);
  });

  test("edits a proposed ChangeSet without writing until the edited text is accepted", async () => {
    const request = await testApplication({
      async revise() { return { replacement: "The generated revision.", rationale: "Generated wording." }; }
    });
    const project = (await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Editable Proposal", venue: "security-top4" }) })).json()) as PaperProject;
    const initial = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    const selectedText = "Original sentence.";
    const content = `${initial.content}\n${selectedText}`;
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, baseVersion: initial.file.version }) });
    const opened = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    const from = opened.content.indexOf(selectedText);
    const proposed = (await (await request(`/api/projects/${project.id}/revisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction: "Improve this", selection: { path: "main.tex", text: selectedText, from, to: from + selectedText.length, startLine: 2, endLine: 2, fileVersion: opened.file.version } }) })).json()) as ReviseResponse;

    const manuallyEdited = "The author-edited revision.";
    const editedResponse = await request(`/api/projects/${project.id}/change-sets/${proposed.changeSet.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ changes: [{ path: "main.tex", after: manuallyEdited }] }) });
    expect(editedResponse.status).toBe(200);
    const edited = (await editedResponse.json()) as ChangeSet;
    expect(edited.changes[0]?.after).toBe(manuallyEdited);
    expect(edited.changes[0]?.hunks?.every((hunk) => hunk.status === "pending")).toBe(true);
    expect((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse).content).toContain(selectedText);

    const runs = (await (await request(`/api/projects/${project.id}/agent-runs`)).json()) as Array<{ auditTrail?: Array<{ action: string; summary: string }> }>;
    expect(runs[0]?.auditTrail?.at(-1)).toMatchObject({ action: "proposal-edited", summary: "Edited 1 proposed file before approval" });
    await request(`/api/projects/${project.id}/change-sets/${proposed.changeSet.id}/accept`, { method: "POST" });
    const accepted = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    expect(accepted.content).toContain(manuallyEdited);
    expect(accepted.content).not.toContain("The generated revision.");
  });

  test("continues a Revise conversation from the latest unaccepted candidate", async () => {
    let received: ReviseAgentInput | undefined;
    const request = await testApplication({
      async revise(input) {
        received = input;
        return { replacement: "The second, tighter candidate.", rationale: "Followed the user's second instruction." };
      }
    });
    const project = (await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Continuous Revise" }) })).json()) as PaperProject;
    const opened = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    const selectedText = "A sentence to improve.";
    const content = `${opened.content}\n${selectedText}`;
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, baseVersion: opened.file.version }) });
    const current = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    const from = current.content.indexOf(selectedText);
    const selection = { path: "main.tex", text: selectedText, from, to: from + selectedText.length, startLine: 2, endLine: 2, fileVersion: current.file.version };
    const response = await request(`/api/projects/${project.id}/revisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection, instruction: "Make it tighter", workingText: "The first candidate.", history: [{ role: "user", content: "Make it clearer" }, { role: "assistant", content: "The first candidate." }] })
    });
    expect(response.status).toBe(201);
    const proposed = (await response.json()) as ReviseResponse;
    expect(received?.workingText).toBe("The first candidate.");
    expect(received?.history).toEqual([{ role: "user", content: "Make it clearer" }, { role: "assistant", content: "The first candidate." }]);
    expect(proposed.changeSet).toMatchObject({ summary: "Follow-up revision", changes: [{ before: selectedText, after: "The second, tighter candidate." }] });
    expect(((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse).content).toContain(selectedText);
  });

  test("plans a Skill-driven draft before proposing an atomic multi-file ChangeSet", async () => {
    const outline = [
      { path: "sections/abstract.tex", title: "Abstract", purpose: "Summarize the problem, method, and evidence." },
      { path: "sections/introduction.tex", title: "Introduction", purpose: "Motivate the security problem and contributions." },
      { path: "sections/method.tex", title: "Method", purpose: "Describe the design and threat model." },
      { path: "sections/evaluation.tex", title: "Evaluation", purpose: "Define research questions and experiments." },
      { path: "sections/conclusion.tex", title: "Conclusion", purpose: "Summarize findings and limitations." }
    ];
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async planDraft(input) {
        expect(input.skill.venue).toBe("security-top4");
        expect(input.skillInstructions).toContain("## Plan and draft");
        return { outline };
      },
      async generateDraft(input) {
        expect(input.outline).toEqual(outline);
        const includes = outline.map((section) => `\\input{${section.path.replace(/\.tex$/, "")}}`).join("\n");
        return {
          files: [
            { path: input.mainDocument, content: `\\documentclass{article}\n\\begin{document}\n${includes}\n\\end{document}\n`, rationale: "Wire the confirmed sections." },
            ...outline.map((section) => ({ path: section.path, content: `% ${section.title}\n\\section{${section.title}}\nTODO: ${section.purpose}\n`, rationale: section.purpose }))
          ]
        };
      }
    };
    const request = await testApplication(provider);
    const project = (await (await request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Draft Paper", venue: "security-top4" })
    })).json()) as PaperProject;
    const original = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    const plannedResponse = await request(`/api/projects/${project.id}/drafts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "Secure telemetry", researchQuestion: "Can endpoints attest telemetry privately?", contributions: ["A protocol", "An evaluation"] })
    });
    expect(plannedResponse.status).toBe(201);
    const planned = await plannedResponse.json() as { plan: { id: string; status: string; outline: typeof outline }; run: { status: string } };
    expect(planned).toMatchObject({ plan: { status: "proposed", outline }, run: { status: "waiting-approval" } });
    expect((await request(`/api/projects/${project.id}/file?path=${encodeURIComponent(outline[0]!.path)}`)).status).toBe(404);

    const generatedResponse = await request(`/api/projects/${project.id}/drafts/${planned.plan.id}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outline })
    });
    expect(generatedResponse.status).toBe(201);
    const generated = await generatedResponse.json() as ReviseResponse & { changeSet: ChangeSet };
    expect(generated.changeSet.changes).toHaveLength(7);
    expect(generated.changeSet.changes.some((change) => change.path === "references.bib" && change.operation === "create")).toBe(true);
    expect((await request(`/api/projects/${project.id}/file?path=${encodeURIComponent(outline[0]!.path)}`)).status).toBe(404);

    const accepted = await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/accept`, { method: "POST" });
    expect(accepted.status).toBe(200);
    expect(((await (await request(`/api/projects/${project.id}/file?path=${encodeURIComponent(outline[2]!.path)}`)).json()) as FileContentResponse).content).toContain("\\section{Method}");
    expect(((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse).content).toContain("sections/introduction");

    const rolledBack = await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/rollback`, { method: "POST" });
    expect(rolledBack.status).toBe(200);
    expect((await request(`/api/projects/${project.id}/file?path=${encodeURIComponent(outline[0]!.path)}`)).status).toBe(404);
    expect(((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse).content).toBe(original.content);
  });

  test("freezes a source snapshot and stores an evidence-linked Review without editing files", async () => {
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async review(input) {
        expect(input.skill.venue).toBe("security-top4");
        expect(input.venueInstructions).toContain("# Security Top-4");
        expect(input.documents[0]?.content).toContain("honest endpoints");
        return {
          overallAssessment: "The mechanism is promising, but its attacker model is incomplete.",
          recommendation: "borderline",
          strengths: ["The security goal is concrete."],
          weaknesses: ["The threat model excludes a central attacker without justification."],
          nextSteps: ["Justify or remove the honest-endpoint assumption."],
          issues: [{
            category: "threat-model",
            severity: "major",
            title: "Unjustified honest-endpoint assumption",
            rationale: "The adversary cannot compromise endpoints, but the deployment argument relies on endpoint trust.",
            impact: "The claimed protection may not hold in the target environment.",
            suggestion: "State the trust boundary and evaluate compromise consequences.",
            evidence: [
              { path: "main.tex", section: "Threat Model", line: null, excerpt: "We assume honest endpoints.", inferred: false },
              { path: "missing.tex", section: null, line: null, excerpt: "No recovery analysis is provided.", inferred: false }
            ]
          }]
        };
      }
    };
    const request = await testApplication(provider);
    const project = (await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Review Paper", venue: "security-top4" }) })).json()) as PaperProject;
    const opened = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    const content = "\\section{Threat Model}\nWe assume honest endpoints.\n";
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, baseVersion: opened.file.version }) });
    const before = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;

    const response = await request(`/api/projects/${project.id}/reviews`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceOnly: true }) });
    expect(response.status).toBe(201);
    const reviewed = await response.json() as { snapshot: { projectVersion: number; files: unknown[] }; report: { issues: Array<{ id: string; status: string; evidence: Array<{ path: string; line?: number; inferred: boolean }> }> }; run: { status: string; skill: { venue: string } } };
    expect(reviewed.run).toMatchObject({ status: "completed", skill: { venue: "security-top4" } });
    expect(reviewed.snapshot.files).toHaveLength(1);
    expect(reviewed.report.issues[0]?.evidence[0]).toMatchObject({ path: "main.tex", line: 2, inferred: false });
    expect(reviewed.report.issues[0]?.evidence[1]).toMatchObject({ path: "main.tex", inferred: true });
    const manualResponse = await request(`/api/projects/${project.id}/review-issues`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ category: "soundness", severity: "minor", title: "Manual duplicate", rationale: "This overlaps the threat-model issue.", impact: "Duplicate triage work.", suggestion: "Merge it." }) });
    expect(manualResponse.status).toBe(201);
    const manual = await manualResponse.json() as { id: string; source: string };
    expect(manual.source).toBe("manual");
    const merged = await (await request(`/api/projects/${project.id}/review-issues/${reviewed.report.issues[0]!.id}/merge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ duplicateIds: [manual.id], reason: "Same root cause" }) })).json() as { history: Array<{ action: string }> };
    expect(merged.history.some((entry) => entry.action === "merged")).toBe(true);
    const issueUpdate = await request(`/api/projects/${project.id}/review-issues/${reviewed.report.issues[0]!.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "dismissed", priority: 42 }) });
    expect(await issueUpdate.json()).toMatchObject({ status: "dismissed", priority: 42, history: expect.arrayContaining([expect.objectContaining({ action: "status" }), expect.objectContaining({ action: "priority" })]) });
    const after = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    expect(after).toEqual(before);
    expect((await (await request(`/api/projects/${project.id}/reviews`)).json() as unknown[])).toHaveLength(1);
  });

  test("cancels an in-flight Review without persisting a partial report", async () => {
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async review() { return await new Promise<never>(() => undefined); }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Cancelled Review" }) })).json() as PaperProject;
    const controller = new AbortController();
    const pending = request(`/api/projects/${project.id}/reviews`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceOnly: true }),
      signal: controller.signal
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    expect((await pending).status).toBe(499);
    expect(await (await request(`/api/projects/${project.id}/reviews`)).json()).toEqual([]);
    const runs = await (await request(`/api/projects/${project.id}/agent-runs`)).json() as Array<{ status: string; error?: string }>;
    expect(runs[0]).toMatchObject({ status: "cancelled", error: "Review cancelled; no report was created" });
  });

  test("keeps the main document inside the bounded large-paper Review snapshot", async () => {
    let reviewedPaths: string[] = [];
    let reviewedBytes = 0;
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async review(input) {
        reviewedPaths = input.documents.map((document) => document.path);
        reviewedBytes = input.documents.reduce((total, document) => total + Buffer.byteLength(document.content), 0);
        return { overallAssessment: "Bounded snapshot.", recommendation: "borderline", strengths: [], weaknesses: [], nextSteps: [], issues: [] };
      }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Large Review" }) })).json() as PaperProject;
    await request(`/api/projects/${project.id}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "appendix/a.tex", content: "a".repeat(499_000) }) });
    await request(`/api/projects/${project.id}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "appendix/b.tex", content: "b".repeat(50_000) }) });
    expect((await request(`/api/projects/${project.id}/reviews`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceOnly: true }) })).status).toBe(201);
    expect(reviewedPaths[0]).toBe("main.tex");
    expect(reviewedPaths).toContain("appendix/a.tex");
    expect(reviewedPaths).not.toContain("appendix/b.tex");
    expect(reviewedBytes).toBeLessThanOrEqual(500_000);
  });

  test("cancels and safely retries Agent planning without duplicate plans or changes", async () => {
    let attempts = 0;
    let generationAttempts = 0;
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async planAgentTask(_input, signal) {
        attempts += 1;
        if (attempts === 1) return await new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
        return { steps: ["Inspect the claim"], affectedFiles: ["main.tex"], risks: [], validation: ["Compile"] };
      },
      async generateAgentTask(input, signal) {
        generationAttempts += 1;
        if (generationAttempts === 1) return await new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
        const main = input.documents.find((document) => document.path === "main.tex")!;
        return { files: [{ path: "main.tex", content: `${main.content}\n% inspected`, rationale: "Records the bounded inspection." }] };
      }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Retry Agent" }) })).json() as PaperProject;
    const before = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    const controller = new AbortController();
    const cancelled = request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Inspect the main claim", scope: { type: "project" } }), signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    expect((await cancelled).status).toBe(499);
    expect(await (await request(`/api/projects/${project.id}/agent-tasks`)).json()).toEqual([]);
    expect(await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()).toEqual(before);

    const retried = await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Inspect the main claim", scope: { type: "project" } }) });
    expect(retried.status).toBe(201);
    const retriedPlan = await retried.json() as { plan: { id: string } };
    expect(await (await request(`/api/projects/${project.id}/agent-tasks`)).json()).toHaveLength(1);

    const generationController = new AbortController();
    const cancelledGeneration = request(`/api/projects/${project.id}/agent-tasks/${retriedPlan.plan.id}/confirm`, { method: "POST", signal: generationController.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    generationController.abort();
    expect((await cancelledGeneration).status).toBe(499);
    expect((await (await request(`/api/projects/${project.id}/agent-tasks`)).json() as Array<{ status: string }>)[0]?.status).toBe("proposed");
    expect(await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()).toEqual(before);
    const generated = await request(`/api/projects/${project.id}/agent-tasks/${retriedPlan.plan.id}/confirm`, { method: "POST" });
    expect(generated.status).toBe(201);
    expect(await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()).toEqual(before);
    const runs = await (await request(`/api/projects/${project.id}/agent-runs`)).json() as Array<{ status: string }>;
    expect(runs.map((run) => run.status).sort()).toEqual(["cancelled", "waiting-approval"]);
  });

  test("restores Review and IssueResolution state after a server restart", async () => {
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async review() { return { overallAssessment: "Boundary needs clarification.", recommendation: "borderline", strengths: [], weaknesses: ["Boundary unclear"], nextSteps: ["Clarify it"], issues: [{ category: "threat-model", severity: "major", title: "Boundary unclear", rationale: "The boundary is ambiguous.", impact: "Claims cannot be audited.", suggestion: "State trusted components.", evidence: [{ path: "main.tex", section: "Introduction", line: 1, excerpt: "", inferred: true }] }] }; },
      async planAgentTask() { return { steps: ["Clarify boundary"], affectedFiles: ["main.tex"], risks: [], validation: ["Compile"] }; }
    };
    const directory = await mkdtemp(join(tmpdir(), "fastwrite-restart-"));
    temporaryDirectories.push(directory);
    const firstApp = await createApplication(directory, { agentProvider: provider });
    const first = (path: string, init?: RequestInit) => firstApp(new Request(`http://fastwrite.test${path}`, init));
    const project = await (await first("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Restart Paper" }) })).json() as PaperProject;
    const reviewed = await (await first(`/api/projects/${project.id}/reviews`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceOnly: true }) })).json() as { report: { issues: Array<{ id: string }> } };
    await first(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Resolve boundary issue", scope: { type: "project" }, issueIds: [reviewed.report.issues[0]!.id] }) });

    const restartedApp = await createApplication(directory, { agentProvider: provider });
    const restarted = (path: string, init?: RequestInit) => restartedApp(new Request(`http://fastwrite.test${path}`, init));
    const reports = await (await restarted(`/api/projects/${project.id}/reviews`)).json() as Array<{ issues: Array<{ status: string }> }>;
    const resolutions = await (await restarted(`/api/projects/${project.id}/issue-resolutions`)).json() as Array<{ status: string }>;
    expect(reports[0]?.issues[0]?.status).toBe("planned");
    expect(resolutions[0]?.status).toBe("planned");
  });

  test("versions evidence-backed Paper Memory and supplies only confirmed items to every Skill workflow", async () => {
    const seen = { revise: "", draft: "", review: "", agent: "" };
    const outline = [
      { path: "sections/abstract.tex", title: "Abstract", purpose: "Summary" },
      { path: "sections/introduction.tex", title: "Introduction", purpose: "Motivation" },
      { path: "sections/method.tex", title: "Method", purpose: "Design and threat model" },
      { path: "sections/evaluation.tex", title: "Evaluation", purpose: "Experiments" },
      { path: "sections/conclusion.tex", title: "Conclusion", purpose: "Findings" }
    ];
    const provider: AgentProvider = {
      async extractMemory(input) {
        expect(input.documents.find((document) => document.path === "main.tex")?.version).toBe(2);
        expect(input.documents.find((document) => document.path === "sections/method.tex")?.version).toBe(1);
        return { items: [{ category: "contribution", label: "Core contribution", content: "The paper introduces a privacy-preserving telemetry protocol.", sources: [{ path: "sections/method.tex", excerpt: "We introduce a privacy-preserving telemetry protocol.", section: "Method", line: null }] }] };
      },
      async revise(input) { seen.revise = input.skillInstructions; return { replacement: "We present a privacy-preserving telemetry protocol.", rationale: "Concise phrasing." }; },
      async planDraft(input) { seen.draft = input.skillInstructions; return { outline }; },
      async review(input) { seen.review = input.skillInstructions; return { overallAssessment: "Early draft.", recommendation: "borderline", strengths: [], weaknesses: [], nextSteps: [], issues: [] }; },
      async planAgentTask(input) { seen.agent = input.skillInstructions; return { steps: ["Inspect the argument"], affectedFiles: ["main.tex"], risks: [], validation: ["Compile"] }; }
    };
    const request = await testApplication(provider);
    const project = (await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Memory Paper" }) })).json()) as PaperProject;
    const opened = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    const sentence = "We introduce a privacy-preserving telemetry protocol.";
    const content = `\\section{Introduction}\n${sentence}\n`;
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, baseVersion: opened.file.version }) });
    await request(`/api/projects/${project.id}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "sections/method.tex", content: `\\section{Method}\n${sentence}\n` }) });
    const memory = await (await request(`/api/projects/${project.id}/memory/extract`, { method: "POST" })).json() as { version: number; items: Array<{ id: string; status: string }> };
    expect(memory).toMatchObject({ version: 1, items: [{ status: "suggested" }] });
    const confirmed = await (await request(`/api/projects/${project.id}/memory/items/${memory.items[0]!.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "confirmed" }) })).json() as { version: number };
    expect(confirmed.version).toBe(2);

    const current = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    const from = current.content.indexOf(sentence);
    const revised = await request(`/api/projects/${project.id}/revisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "academic-polish", selection: { path: "main.tex", text: sentence, from, to: from + sentence.length, startLine: 2, endLine: 2, fileVersion: current.file.version } }) });
    expect((await revised.json() as { run: { memoryVersion: number } }).run.memoryVersion).toBe(2);
    await request(`/api/projects/${project.id}/drafts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: "Telemetry", researchQuestion: "Can telemetry remain private?", contributions: ["A protocol"] }) });
    await request(`/api/projects/${project.id}/reviews`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceOnly: true }) });
    await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Inspect the paper argument", scope: { type: "project" } }) });
    for (const value of Object.values(seen)) expect(value).toContain("[contribution] Core contribution: The paper introduces a privacy-preserving telemetry protocol.");

    const method = (await (await request(`/api/projects/${project.id}/file?path=sections%2Fmethod.tex`)).json()) as FileContentResponse;
    await request(`/api/projects/${project.id}/file?path=sections%2Fmethod.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `${method.content}% changed`, baseVersion: method.file.version }) });
    const stale = await (await request(`/api/projects/${project.id}/memory`)).json() as { items: Array<{ status: string }> };
    expect(stale.items[0]?.status).toBe("stale");
  });

  test("runs Review Issue through plan, multi-file approval, targeted re-review and rollback", async () => {
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async review(input) { return { overallAssessment: "Threat model incomplete.", recommendation: "reject", strengths: [], weaknesses: ["Missing compromise analysis."], nextSteps: ["Clarify endpoint compromise."], issues: [{ category: "threat-model", severity: "major", title: "Endpoint compromise omitted", rationale: "The current threat model does not cover endpoint compromise.", impact: "The guarantee is ambiguous.", suggestion: "Add explicit endpoint compromise behavior.", evidence: [{ path: "main.tex", section: "Threat Model", line: null, excerpt: "Threat model placeholder.", inferred: false }] }] }; },
      async planAgentTask(input) { expect(input.issues[0]?.title).toBe("Endpoint compromise omitted"); return { steps: ["Clarify the trust boundary", "Add compromise behavior"], affectedFiles: ["main.tex"], risks: ["Do not overstate guarantees"], validation: ["Recompile", "Targeted re-review"] }; },
      async generateAgentTask(input) { const main = input.documents.find((document) => document.path === "main.tex")!; return { files: [{ path: "main.tex", content: `${main.content}Compromised endpoints are outside the trust boundary.\n`, rationale: "Makes endpoint compromise explicit." }] }; },
      async rereviewIssues(input) { expect(input.documents.find((document) => document.path === "main.tex")?.content).toContain("outside the trust boundary"); return { assessments: input.issues.map((issue) => ({ issueId: issue.id, resolved: true, assessment: "The trust boundary is now explicit." })), regressions: [] }; }
    };
    const request = await testApplication(provider);
    const project = (await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Resolution Paper", venue: "security-top4" }) })).json()) as PaperProject;
    const opened = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    const content = "\\section{Threat Model}\nThreat model placeholder.\n";
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, baseVersion: opened.file.version }) });
    const review = await (await request(`/api/projects/${project.id}/reviews`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceOnly: true }) })).json() as { report: { issues: Array<{ id: string }> } };
    const issueId = review.report.issues[0]!.id;
    const planned = await (await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Resolve the endpoint-compromise review issue", scope: { type: "project" }, issueIds: [issueId] }) })).json() as { plan: { id: string }; resolution: { id: string; status: string; reviewSnapshotIds: string[]; baseProjectVersion: number; skill: { venue: string } } };
    expect(planned.resolution.status).toBe("planned");
    expect(planned.resolution).toMatchObject({ reviewSnapshotIds: [expect.stringContaining("snapshot_")], skill: { venue: "security-top4" } });
    const reportsAfterPlan = await (await request(`/api/projects/${project.id}/reviews`)).json() as Array<{ issues: Array<{ id: string; status: string }> }>;
    expect(reportsAfterPlan[0]!.issues.find((issue) => issue.id === issueId)?.status).toBe("planned");

    const generated = await (await request(`/api/projects/${project.id}/agent-tasks/${planned.plan.id}/confirm`, { method: "POST" })).json() as { changeSet: ChangeSet; resolution: { status: string } };
    expect(generated.resolution.status).toBe("in-revision");
    expect(generated.changeSet.changes[0]?.hunks?.[0]).toMatchObject({
      rationale: "Makes endpoint compromise explicit.",
      evidence: [{ issueId, issueTitle: "Endpoint compromise omitted", path: "main.tex", excerpt: "Threat model placeholder.", inferred: false }]
    });
    expect((await (await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}`)).json() as ChangeSet).id).toBe(generated.changeSet.id);
    expect(((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse).content).toBe(content);
    await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/accept`, { method: "POST" });
    const resolutions = await (await request(`/api/projects/${project.id}/issue-resolutions`)).json() as Array<{ id: string; status: string }>;
    expect(resolutions[0]?.status).toBe("in-revision");
    expect((await request(`/api/projects/${project.id}/issue-resolutions/${planned.resolution.id}/rereview`, { method: "POST" })).status).toBe(409);
    const revisedProject = await (await request(`/api/projects/${project.id}`)).json() as PaperProject;
    expect((await request(`/api/projects/${project.id}/compile-results`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectVersion: revisedProject.version, status: "error", summary: "Missing package" }) })).status).toBe(201);
    expect((await (await request(`/api/projects/${project.id}/issue-resolutions`)).json() as Array<{ status: string }>)[0]?.status).toBe("in-revision");
    expect((await request(`/api/projects/${project.id}/compile-results`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectVersion: revisedProject.version, status: "success", summary: "WASM fixture compiled" }) })).status).toBe(201);
    expect((await (await request(`/api/projects/${project.id}/issue-resolutions`)).json() as Array<{ status: string }>)[0]?.status).toBe("needs-review");
    const rereviewed = await (await request(`/api/projects/${project.id}/issue-resolutions/${planned.resolution.id}/rereview`, { method: "POST" })).json() as { status: string; rereviewAssessment: string; compileRecordId: string };
    expect(rereviewed).toMatchObject({ status: "resolved", rereviewAssessment: expect.stringContaining("The trust boundary is now explicit.") });
    expect(rereviewed.compileRecordId).toStartWith("compile_");
    const reportsResolved = await (await request(`/api/projects/${project.id}/reviews`)).json() as Array<{ issues: Array<{ id: string; status: string }> }>;
    expect(reportsResolved[0]!.issues.find((issue) => issue.id === issueId)?.status).toBe("resolved");

    const reopened = await (await request(`/api/projects/${project.id}/issue-resolutions/${planned.resolution.id}/reopen`, { method: "POST" })).json() as { status: string };
    expect(reopened.status).toBe("reopened");
    const reportsReopened = await (await request(`/api/projects/${project.id}/reviews`)).json() as Array<{ issues: Array<{ id: string; status: string }> }>;
    expect(reportsReopened[0]!.issues.find((issue) => issue.id === issueId)?.status).toBe("open");

    await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/rollback`, { method: "POST" });
    expect(((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse).content).toBe(content);
    const reportsRolledBack = await (await request(`/api/projects/${project.id}/reviews`)).json() as Array<{ issues: Array<{ id: string; status: string }> }>;
    expect(reportsRolledBack[0]!.issues.find((issue) => issue.id === issueId)?.status).toBe("open");
  });

  test("generates bounded Skill-guided completion without writing and rejects stale cursors", async () => {
    let received: CompletionAgentInput | undefined;
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async extractMemory() {
        return { items: [{ category: "contribution", label: "Telemetry", content: "The design protects aggregate telemetry.", sources: [{ path: "main.tex", excerpt: "The design protects aggregate telemetry.", section: "Introduction", line: null }] }] };
      },
      async complete(input) {
        received = input;
        return { suggestion: " It remains robust under the stated threat model." };
      }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Completion Paper", venue: "ai-top-tier" }) })).json() as PaperProject;
    const opened = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    const sentence = "The design protects aggregate telemetry.";
    const content = `\\section{Introduction}\n${"context ".repeat(500)}${sentence}`;
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, baseVersion: opened.file.version }) });
    await request(`/api/projects/${project.id}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "references.bib", content: "@inproceedings{telemetry, title={Private Telemetry}}" }) });
    const memory = await (await request(`/api/projects/${project.id}/memory/extract`, { method: "POST" })).json() as { items: Array<{ id: string }> };
    await request(`/api/projects/${project.id}/memory/items/${memory.items[0]!.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "confirmed" }) });
    const current = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;

    const completionResponse = await request(`/api/projects/${project.id}/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "main.tex", cursor: current.content.length, fileVersion: current.file.version, kind: "auto" })
    });
    expect(completionResponse.status).toBe(201);
    const completion = await completionResponse.json() as CompletionResponse;
    expect(completion).toMatchObject({ path: "main.tex", cursor: current.content.length, fileVersion: current.file.version, kind: "auto" });
    expect(received?.contextBefore.length).toBeLessThanOrEqual(2_500);
    expect(received?.contextBefore).toEndWith(sentence);
    expect(received?.skillInstructions).toContain("[contribution] Telemetry: The design protects aggregate telemetry.");
    expect(received?.skill.id).toBe("ai-top-tier");
    expect(received?.venueInstructions).toContain("# AI Top-Tier");
    expect(received?.bibliography).toContain("Private Telemetry");
    expect((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse).content).toBe(content);

    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `${content}\nNew edit.`, baseVersion: current.file.version }) });
    expect((await request(`/api/projects/${project.id}/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "main.tex", cursor: current.content.length, fileVersion: current.file.version, kind: "auto" }) })).status).toBe(409);
  });

  test("accepts and rejects independent hunks while revalidating each intermediate file version", async () => {
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async planAgentTask() { return { steps: ["Revise two claims"], affectedFiles: ["main.tex"], risks: [], validation: ["Compile"] }; },
      async generateAgentTask(input) {
        const document = input.documents.find((candidate) => candidate.path === "main.tex")!;
        return { files: [{ path: "main.tex", content: document.content.replace("old method", "new method").replace("old result", "new result"), rationale: "Updates two independent claims." }] };
      }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Partial Approval" }) })).json() as PaperProject;
    const initial = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    const original = "title\nkeep alpha\nold method\nkeep beta\nold result\nend\n";
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: original, baseVersion: initial.file.version }) });
    const planned = await (await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Update method and result claims", scope: { type: "project" } }) })).json() as { plan: { id: string } };
    const generated = await (await request(`/api/projects/${project.id}/agent-tasks/${planned.plan.id}/confirm`, { method: "POST" })).json() as { changeSet: ChangeSet };
    const change = generated.changeSet.changes[0]!;
    expect(change.hunks).toHaveLength(2);

    const first = await (await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions: [{ path: "main.tex", hunkIds: [change.hunks![0]!.id], status: "accepted" }] }) })).json() as ChangeSet;
    expect(first.status).toBe("partially-accepted");
    const intermediate = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    expect(intermediate.content).toContain("new method");
    expect(intermediate.content).toContain("old result");

    const final = await (await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions: [{ path: "main.tex", hunkIds: [change.hunks![1]!.id], status: "rejected" }] }) })).json() as ChangeSet;
    expect(final.status).toBe("accepted");
    expect(final.changes[0]!.hunks?.map((hunk) => hunk.status)).toEqual(["accepted", "rejected"]);
    const partiallyApplied = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    expect(partiallyApplied.content).toBe(intermediate.content);

    const appliedProject = await (await request(`/api/projects/${project.id}`)).json() as PaperProject;
    await request(`/api/projects/${project.id}/compile-results`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectVersion: appliedProject.version, status: "success", summary: "Partial hunk fixture compiled" }) });
    const audited = await (await request(`/api/projects/${project.id}/agent-runs`)).json() as Array<{ auditTrail: Array<{ action: string; summary: string }> }>;
    expect(audited[0]!.auditTrail.map((event) => event.action)).toEqual(expect.arrayContaining(["context-read", "context-search", "plan-created", "execution-started", "changes-proposed", "hunk-decision", "compile"]));
    expect(audited[0]!.auditTrail.every((event) => !event.summary.includes("old method"))).toBe(true);

    expect((await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/rollback`, { method: "POST" })).status).toBe(200);
    expect((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse).content).toBe(original);
    const rolledBackAudit = await (await request(`/api/projects/${project.id}/agent-runs`)).json() as Array<{ auditTrail: Array<{ action: string }> }>;
    expect(rolledBackAudit[0]!.auditTrail.some((event) => event.action === "rollback")).toBe(true);
  });
});
