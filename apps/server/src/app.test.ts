import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentRun, AgentTaskPlan, ChangeSet, ChangeSetConflictDetails, ClaimEvidenceLink, CompletionResponse, ComplianceReport, FastReadBundleReceipt, FileContentResponse, PaperClaim, PaperMemory, PaperProject, ProjectResearchWorkDetails, ResearchWork, ReviseResponse, SaveFileResponse, SourceEvidence, UploadSession, WorkspaceTreeNode } from "@fastwrite/shared";
import type { AgentProvider, AgentTaskPlanOutput, CompletionAgentInput, DraftGeneratedFile, ReviseAgentInput } from "./agent/provider";
import { createApplication, mimeType } from "./app";
import * as Y from "yjs";

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
  test("reports configured Harness capabilities and rejects unknown Harnesses", async () => {
    const request = await testApplication();
    const response = await request("/api/harnesses");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: expect.objectContaining({ kind: "codex", state: "ready" }), capabilities: expect.objectContaining({ streaming: true, sessions: true, skills: true, mcp: true }) }),
      expect.objectContaining({ status: expect.objectContaining({ kind: "claude", state: "ready" }) })
    ]));
    const invalid = await request("/api/harnesses/unknown/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "/tmp" }) });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: "harness_invalid" } });
  });

  test("returns a structured error for an unknown Harness run", async () => {
    const request = await testApplication();
    const response = await request("/api/harness-runs/run_missing");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "harness_run_not_found" } });
  });

  test("executes MCP workspace tools only when explicitly allowed", async () => {
    const request = await testApplication();
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "MCP tools" }) })).json() as PaperProject;
    const denied = await request(`/api/projects/${project.id}/mcp/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "workspace.read", input: { path: "main.tex" }, allow: [] }) });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "mcp_tool_denied" } });
    const allowed = await request(`/api/projects/${project.id}/mcp/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "workspace.read", input: { path: "main.tex" }, allow: ["workspace.read"] }) });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ path: "main.tex", content: expect.stringContaining("\\documentclass") });
    const audit = await request(`/api/mcp/audit?projectId=${encodeURIComponent(project.id)}`);
    expect(audit.status).toBe(200);
    expect(await audit.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectId: project.id, tool: "workspace.read", status: "denied" }),
      expect.objectContaining({ projectId: project.id, tool: "workspace.read", status: "completed" })
    ]));
  });

  test("serves module workers with a browser-safe MIME type", () => {
    expect(mimeType(".mjs")).toBe("text/javascript; charset=utf-8");
    expect(mimeType(".wasm")).toBe("application/wasm");
  });

  test("accepts a runtime Agent key without exposing it", async () => {
    const request = await testApplication();
    const before = await request("/api/agent-settings");
    expect(before.status).toBe(200);
    const configured = await request("/api/agent-settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-test-private-key", baseURL: "https://api.example.test/v1", model: "test-model", wireAPI: "responses" })
    });
    expect(configured.status).toBe(200);
    expect(await configured.json()).toMatchObject({ configured: true, source: "runtime", baseURL: "https://api.example.test/v1", model: "test-model", wireAPI: "responses" });
    const status = await request("/api/agent-settings");
    expect(JSON.stringify(await status.json())).not.toContain("sk-test-private-key");
  });

  test("returns a structured configuration error when Revise has no provider", async () => {
    const request = await testApplication();
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Unconfigured Revise", mainDocument: "main.tex", venue: "artificial-intelligence" }) })).json() as PaperProject;
    const opened = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    const text = "Introduction";
    const from = opened.content.indexOf(text);
    const response = await request(`/api/projects/${project.id}/revisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selection: { path: "main.tex", text, from, to: from + text.length, startLine: 6, endLine: 6, fileVersion: opened.file.version }, instruction: "Clarify this heading" })
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "agent_not_configured" } });
  });

  test("exports a bounded provenance dossier without manuscript or secret content", async () => {
    const request = await testApplication();
    const created = await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Provenance paper", mainDocument: "main.tex", venue: "sp" }) });
    const project = await created.json() as { id: string };
    const response = await request(`/api/projects/${project.id}/provenance`);
    expect(response.status).toBe(200);
    const dossier = await response.json() as { project: { id: string }; runs: unknown[]; changeSets: unknown[]; disclosureDraft: string };
    expect(dossier.project.id).toBe(project.id);
    expect(dossier.runs).toEqual([]);
    expect(dossier.changeSets).toEqual([]);
    expect(dossier.disclosureDraft).toContain("No AI-assisted");
    expect(dossier.disclosureDraft).not.toContain("main.tex");
    expect(JSON.stringify(dossier)).not.toContain("documentclass");
  });

  test("lists bounded internal history checkpoints", async () => {
    const request = await testApplication();
    const created = await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "History paper", mainDocument: "main.tex", venue: "sp" }) });
    const project = await created.json() as { id: string };
    await request(`/api/projects/${project.id}/history/checkpoint`, { method: "POST" });
    const response = await request(`/api/projects/${project.id}/history?limit=1`);
    expect(response.status).toBe(200);
    const history = await response.json() as Array<{ oid: string; message: string; createdAt: string }>;
    expect(history.length).toBeLessThanOrEqual(1);
    expect(history[0]).toMatchObject({ oid: expect.any(String), message: expect.any(String), createdAt: expect.any(String) });
  });

  test("creates revocable read-only and comment share links without exposing stored tokens", async () => {
    const request = await testApplication();
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Shared paper", mainDocument: "main.tex", venue: "sp" }) })).json() as PaperProject;
    const readShare = await (await request(`/api/projects/${project.id}/shares`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ permission: "read" }) })).json() as { id: string; token: string };
    expect((await request(`/api/shared/${readShare.token}`)).status).toBe(200);
    expect((await request(`/api/shared/${readShare.token}/file?path=main.tex`)).status).toBe(200);
    const denied = await request(`/api/shared/${readShare.token}/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "main.tex", author: "Reviewer", body: "Comment" }) });
    expect(denied.status).toBe(403);
    const commentShare = await (await request(`/api/projects/${project.id}/shares`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ permission: "comment" }) })).json() as { id: string; token: string };
    expect((await request(`/api/shared/${commentShare.token}/comments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "main.tex", line: 2, author: "Reviewer", body: "Please clarify." }) })).status).toBe(201);
    const listed = JSON.stringify(await (await request(`/api/projects/${project.id}/shares`)).json());
    expect(listed).not.toContain(readShare.token);
    await request(`/api/projects/${project.id}/shares/${readShare.id}`, { method: "DELETE" });
    expect((await request(`/api/shared/${readShare.token}`)).status).toBe(404);
  });

  test("merges Yjs collaboration updates through PaperFile versions", async () => {
    const request = await testApplication();
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Collaborative paper", mainDocument: "main.tex", venue: "sp" }) })).json() as PaperProject;
    const initial = await (await request(`/api/projects/${project.id}/collaboration?path=main.tex`)).json() as { fileVersion: number; update: string };
    const document = new Y.Doc(); Y.applyUpdate(document, Buffer.from(initial.update, "base64")); document.getText("content").insert(document.getText("content").length, "\n% collaborative edit");
    const response = await request(`/api/projects/${project.id}/collaboration`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "main.tex", baseVersion: initial.fileVersion, update: Buffer.from(Y.encodeStateAsUpdate(document)).toString("base64"), clientId: "client-a", name: "Author", line: 2 }) });
    expect(response.status).toBe(200);
    const merged = await response.json() as { fileVersion: number; presence: Array<{ name: string }> };
    expect(merged.fileVersion).toBeGreaterThan(initial.fileVersion);
    expect(merged.presence).toContainEqual(expect.objectContaining({ name: "Author" }));
    const file = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    expect(file.content).toContain("collaborative edit");
  });

  test("rejects an unsupported runtime Agent wire API", async () => {
    const request = await testApplication();
    const response = await request("/api/agent-settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "sk-test", wireAPI: "websocket" })
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "agent_wire_api_invalid" } });
  });

  test("creates, reads and version-checks an empty project", async () => {
    const request = await testApplication();
    const createdResponse = await request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Legacy conference values are intentionally normalized to the matching research domain.
      body: JSON.stringify({ name: "Test Paper", mainDocument: "main.tex", venue: "sp", publicationTarget: { venueId: "sp", stage: "submission" } })
    });
    expect(createdResponse.status).toBe(201);
    const project = (await createdResponse.json()) as PaperProject;
    expect(project.skill).toMatchObject({ id: "network-information-security", venue: "network-information-security" });
    expect(project.publicationTarget).toEqual({ domain: "network-information-security", venueId: "sp", stage: "submission" });

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
        venue: "network-information-security",
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
      body: JSON.stringify({ name: "Lifecycle Paper", mainDocument: "main.tex", venue: "network-information-security" })
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
      body: JSON.stringify({ name: "Updated Paper", mainDocument: "sections/results.tex", venue: "artificial-intelligence" })
    });
    const updated = (await updatedResponse.json()) as PaperProject;
    expect(updated).toMatchObject({ name: "Updated Paper", mainDocument: "sections/results.tex" });
    expect(updated.skill).toMatchObject({ id: "artificial-intelligence", venue: "artificial-intelligence" });

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
      body: JSON.stringify({ name: "Revision Paper", venue: "network-information-security" })
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
    expect(proposed.run).toMatchObject({ status: "waiting-approval", skill: { id: "network-information-security", venue: "network-information-security" } });
    expect(proposed.changeSet).toMatchObject({ status: "proposed", summary: "Grammar" });
    expect(received?.sectionTitle).toBe("Introduction");
    expect(received?.selectionKind).toBe("sentence");
    expect(received?.skillInstructions).toContain("# Network and information security");
    expect(received?.venueInstructions).toContain("# Network and information security");
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
    const project = (await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Editable Proposal", venue: "network-information-security" }) })).json()) as PaperProject;
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

  test("returns editable three-way rollback conflicts and applies an explicit resolution", async () => {
    const request = await testApplication({ async revise() { return { replacement: "AI replacement.", rationale: "Rewrite." }; } });
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Rollback conflict", venue: "sp" }) })).json() as PaperProject;
    const initial = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    const content = `${initial.content}\nOriginal sentence.`; await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, baseVersion: initial.file.version }) });
    const opened = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse; const from = opened.content.indexOf("Original sentence.");
    const proposed = await (await request(`/api/projects/${project.id}/revisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction: "Rewrite", selection: { path: "main.tex", text: "Original sentence.", from, to: from + 18, startLine: 2, endLine: 2, fileVersion: opened.file.version } }) })).json() as ReviseResponse;
    await request(`/api/projects/${project.id}/change-sets/${proposed.changeSet.id}/accept`, { method: "POST" }); const applied = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: applied.content.replace("AI replacement.", "Human follow-up."), baseVersion: applied.file.version }) });
    const conflict = await request(`/api/projects/${project.id}/change-sets/${proposed.changeSet.id}/rollback`, { method: "POST" }); expect(conflict.status).toBe(409); const details = await conflict.json() as { error: { code: string; details: { conflicts: Array<{ path: string; currentVersion: number }> } } }; expect(details.error.code).toBe("rollback_conflict_review_required");
    const item = details.error.details.conflicts[0]!; const resolved = await request(`/api/projects/${project.id}/change-sets/${proposed.changeSet.id}/rollback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resolutions: [{ path: item.path, currentVersion: item.currentVersion, content: `${content}\n% retained human intent` }] }) }); expect(resolved.status).toBe(200); expect((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse).content).toContain("retained human intent");
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
        expect(input.skill.venue).toBe("network-information-security");
        expect(input.skillInstructions).toContain("## Workflow");
        return { outline };
      },
      async generateDraft(input) {
        expect(input.outline).toEqual(outline);
        const includes = outline.map((section) => `\\input{${section.path.replace(/\.tex$/, "")}}`).join("\n");
        return {
          files: [
            { path: input.mainDocument, content: `\\documentclass{article}\n\\begin{document}\n${includes}\n\\end{document}\n`, rationale: "Wire the confirmed sections." },
            ...outline.map((section) => ({ path: section.path, content: `% ${section.title}\n\\section{${section.title}}\nThis section develops ${section.purpose.toLowerCase()} It connects the stated research question to the proposed private telemetry protocol while preserving the evidence limits supplied in the research brief.\n`, rationale: section.purpose }))
          ]
        };
      }
    };
    const request = await testApplication(provider);
    const project = (await (await request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Draft Paper", venue: "network-information-security" })
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
    expect(generated.changeSet.changes).toHaveLength(6);
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
        expect(input.skill.venue).toBe("network-information-security");
        expect(input.venueInstructions).toContain("# Network and information security");
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
    const project = (await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Review Paper", venue: "network-information-security" }) })).json()) as PaperProject;
    const opened = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    const content = "\\section{Threat Model}\nWe assume honest endpoints.\n";
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, baseVersion: opened.file.version }) });
    const before = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;

    const response = await request(`/api/projects/${project.id}/reviews`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceOnly: true }) });
    expect(response.status).toBe(201);
    const reviewed = await response.json() as { snapshot: { projectVersion: number; files: unknown[] }; report: { issues: Array<{ id: string; status: string; evidence: Array<{ path: string; line?: number; inferred: boolean }> }> }; run: { status: string; skill: { venue: string } } };
    expect(reviewed.run).toMatchObject({ status: "completed", skill: { venue: "network-information-security" } });
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

  test("plans against a selected venue and returns its page budget and compliance checks", async () => {
    let venueGuidance = "";
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async planAgentTask(input) {
        venueGuidance = input.venueInstructions;
        return {
          steps: ["Fit the argument to the main-track budget"], affectedFiles: ["main.tex"], risks: ["Rendered page count is not yet verified"], validation: ["Compile and count content pages"],
          sectionBudget: [{ section: "Introduction", targetPages: 1, purpose: "Motivate the contribution" }],
          venueChecks: [{ requirement: "Use the NeurIPS 2026 template", status: "uncertain", evidencePaths: ["main.tex"], action: "Verify the rendered PDF" }]
        };
      }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Venue Plan", venue: "artificial-intelligence", publicationTarget: { domain: "artificial-intelligence", venueId: "neurips", stage: "submission" } }) })).json() as PaperProject;
    const response = await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Prepare this manuscript for submission", scope: { type: "project" } }) });
    expect(response.status).toBe(201);
    const result = await response.json() as { run: AgentRun; plan: AgentTaskPlan };
    expect(result.run.publicationTarget).toEqual({ domain: "artificial-intelligence", venueId: "neurips", stage: "submission" });
    expect(result.plan.sectionBudget?.[0]?.targetPages).toBe(1);
    expect(result.plan.venueChecks?.[0]?.status).toBe("uncertain");
    expect(venueGuidance).toContain("# NeurIPS 2026 Main Track");
  });

  test("enforces page, template, anonymity, comment, reference, and citation-authenticity checks", async () => {
    const request = await testApplication();
    const project = await (await request("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Compliance Paper", venue: "network-information-security", publicationTarget: { domain: "network-information-security", venueId: "sp", stage: "submission" } })
    })).json() as PaperProject;
    const opened = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    const content = String.raw`\documentclass{article}
\author{Alice Example}
\begin{document}
% TODO verify the reviewer-facing claim
\section{Introduction}\cite{real,fake,missing}
\section{Ethics considerations}
\bibliography{references}
\end{document}`;
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, baseVersion: opened.file.version }) });
    await request(`/api/projects/${project.id}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "references.bib", content: "@article{real,\n author={A},\n title={Verified Work},\n year={2024},\n doi={10.1000/real}\n}\n@article{fake,\n author={B},\n title={Invented Work},\n year={2025},\n doi={10.1000/fake}\n}" }) });

    const nativeFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async (input: string | URL | Request) => String(input).includes("10.1000%2Freal")
      ? new Response(JSON.stringify({ message: { title: ["Verified Work"] } }), { status: 200, headers: { "content-type": "application/json" } })
      : new Response("not found", { status: 404 }), { preconnect: nativeFetch.preconnect });
    try {
      const response = await request(`/api/projects/${project.id}/compliance-checks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ renderedPages: 19, verifyCitationsOnline: true }) });
      expect(response.status).toBe(201);
      const report = await response.json() as ComplianceReport;
      expect(report.submissionBlocked).toBe(true);
      expect(report.findings.some((finding) => finding.category === "pages" && finding.status === "error")).toBe(true);
      expect(report.findings.some((finding) => finding.category === "template" && finding.status === "error")).toBe(true);
      expect(report.findings.some((finding) => finding.category === "anonymity" && finding.status === "error")).toBe(true);
      expect(report.findings.some((finding) => finding.category === "comments" && finding.status === "error")).toBe(true);
      expect(report.findings.some((finding) => finding.id === "reference:missing:missing")).toBe(true);
      expect(report.citations.find((citation) => citation.key === "real")?.status).toBe("verified");
      expect(report.citations.find((citation) => citation.key === "fake")?.status).toBe("mismatch");
      expect(report.citations.find((citation) => citation.key === "missing")?.status).toBe("missing");
    } finally {
      globalThis.fetch = nativeFetch;
    }
  });

  test("cancels and safely retries Agent planning without duplicate plans or changes", async () => {
    let attempts = 0;
    let generationAttempts = 0;
    let markPlanningStarted!: () => void;
    let markGenerationStarted!: () => void;
    const planningStarted = new Promise<void>((resolve) => { markPlanningStarted = resolve; });
    const generationStarted = new Promise<void>((resolve) => { markGenerationStarted = resolve; });
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async planAgentTask(_input, signal) {
        attempts += 1;
        if (attempts === 1) {
          markPlanningStarted();
          return await new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
        }
        return { steps: ["Inspect the claim"], affectedFiles: ["main.tex"], risks: [], validation: ["Compile"] };
      },
      async generateAgentTask(input, signal) {
        generationAttempts += 1;
        if (generationAttempts === 1) {
          markGenerationStarted();
          return await new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
        }
        const main = input.documents.find((document) => document.path === "main.tex")!;
        return { files: [{ path: "main.tex", content: `${main.content}\n% inspected`, rationale: "Records the bounded inspection." }] };
      }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Retry Agent" }) })).json() as PaperProject;
    const before = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    const controller = new AbortController();
    const cancelled = request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Inspect the main claim", scope: { type: "project" } }), signal: controller.signal });
    await planningStarted;
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
    await generationStarted;
    generationController.abort();
    expect((await cancelledGeneration).status).toBe(499);
    expect((await (await request(`/api/projects/${project.id}/agent-tasks`)).json() as Array<{ status: string }>)[0]?.status).toBe("proposed");
    expect(await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()).toEqual(before);
    const generated = await request(`/api/projects/${project.id}/agent-tasks/${retriedPlan.plan.id}/confirm`, { method: "POST" });
    expect(generated.status).toBe(201);
    expect(await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()).toEqual(before);
    const runs = await (await request(`/api/projects/${project.id}/agent-runs`)).json() as Array<{ status: string; error?: string }>;
    expect(runs.map((run) => run.status).sort()).toEqual(["cancelled", "waiting-approval"]);
    expect(runs.find((run) => run.status === "waiting-approval")?.error).toBeUndefined();
  });

  test("routes a unified Agent draft command through a reviewed plan that may create source files", async () => {
    let seenIntent = "";
    const generatedTargets: string[] = [];
    const visiblePlanDocuments: string[] = [];
    const visibleGenerationDocuments: string[] = [];
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async planAgentTask(input) { seenIntent = input.intent; visiblePlanDocuments.push(...input.documents.map((document) => document.content)); return { steps: ["Create the editable outline"], affectedFiles: ["main.tex", "sections/introduction.tex", "references.bib"], risks: [], validation: ["Compile"] }; },
      async generateAgentTask(input) {
        const target = input.targetPath;
        expect(input.affectedFiles).toEqual([target]);
        generatedTargets.push(target);
        visibleGenerationDocuments.push(...input.documents.map((document) => document.content));
        const generated: Record<string, DraftGeneratedFile> = {
          "main.tex": { path: "main.tex", content: "\\documentclass{article}\\begin{document}\\input{sections/introduction}\\end{document}", rationale: "Sets up the paper." },
          "sections/introduction.tex": { path: "sections/introduction.tex", content: "\\section{Introduction}\nThis paper studies robust authentication under the bounded assumptions supplied in the research brief.", rationale: "Creates an editable introduction section." },
          "references.bib": { path: "references.bib", content: "% Bibliography intentionally contains no unverified entries.", rationale: "Creates the bibliography file without invented citations." }
        };
        return { files: [generated[target]!] };
      }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Unified Agent" }) })).json() as PaperProject;
    const originalMain = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `${originalMain.content}% Keep this user instruction.\n`, baseVersion: originalMain.file.version }) });
    const planned = await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "/draft Plan a paper about robust authentication", scope: { type: "project" } }) });
    expect(planned.status).toBe(201);
    const body = await planned.json() as { plan: { id: string; intent: string; affectedFiles: string[] } };
    expect(seenIntent).toBe("draft");
    expect(visiblePlanDocuments.every((content) => !content.includes("Keep this user instruction"))).toBe(true);
    expect(body.plan).toMatchObject({ intent: "draft", affectedFiles: ["main.tex", "sections/introduction.tex", "references.bib"] });
    const generated = await request(`/api/projects/${project.id}/agent-tasks/${body.plan.id}/confirm`, { method: "POST" });
    expect(generated.status).toBe(201);
    expect(generatedTargets).toEqual(["main.tex", "sections/introduction.tex", "references.bib"]);
    const changeSet = await generated.json() as { changeSet: ChangeSet; run: { steps: Array<{ id: string; label: string; status: string }>; auditTrail: Array<{ action: string }> } };
    expect(changeSet.changeSet).toMatchObject({ approvalMode: "explicit-finish", status: "proposed" });
    expect(changeSet.run.steps).toEqual([
      { id: "generate-file-1", label: "Process main.tex", status: "completed" },
      { id: "generate-file-2", label: "Process sections/introduction.tex", status: "completed" },
      { id: "generate-file-3", label: "Process references.bib", status: "completed" }
    ]);
    expect(visibleGenerationDocuments.every((content) => !content.includes("Keep this user instruction"))).toBe(true);
    expect(changeSet.run.auditTrail.filter((event) => event.action === "generation-progress")).toHaveLength(3);
    expect(changeSet.changeSet.changes.find((change) => change.path === "main.tex")?.after).toContain("% Keep this user instruction.");
    expect((await request(`/api/projects/${project.id}/file?path=sections%2Fintroduction.tex`)).status).toBe(404);
    const mainChange = changeSet.changeSet.changes.find((change) => change.path === "main.tex")!;
    expect((await request(`/api/projects/${project.id}/change-sets/${changeSet.changeSet.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions: [{ path: mainChange.path, hunkIds: mainChange.hunks!.map((hunk) => hunk.id), status: "accepted" }] }) })).status).toBe(200);
    const editedIntroduction = "\\section{Introduction}\nTODO: Add bounded authentication evidence.";
    const edited = await request(`/api/projects/${project.id}/change-sets/${changeSet.changeSet.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ changes: [{ path: "sections/introduction.tex", after: editedIntroduction }] }) });
    expect(edited.status).toBe(200);
    const editedChangeSet = await edited.json() as ChangeSet;
    const introductionChange = editedChangeSet.changes.find((change) => change.path === "sections/introduction.tex")!;
    expect((await request(`/api/projects/${project.id}/change-sets/${changeSet.changeSet.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions: [{ path: introductionChange.path, hunkIds: introductionChange.hunks!.map((hunk) => hunk.id), status: "accepted" }] }) })).status).toBe(200);
    expect(await (await request(`/api/projects/${project.id}/file?path=sections%2Fintroduction.tex`)).json()).toMatchObject({ content: editedIntroduction });
    expect((await request(`/api/projects/${project.id}/change-sets/${changeSet.changeSet.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions: [{ path: introductionChange.path, hunkIds: introductionChange.hunks!.map((hunk) => hunk.id), status: "rejected" }] }) })).status).toBe(200);
    expect((await request(`/api/projects/${project.id}/file?path=sections%2Fintroduction.tex`)).status).toBe(404);
    const accepted = await request(`/api/projects/${project.id}/change-sets/${changeSet.changeSet.id}/accept`, { method: "POST" });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ status: "accepted", reviewFinishedAt: expect.any(String), changes: expect.arrayContaining([expect.objectContaining({ path: "sections/introduction.tex", hunks: expect.arrayContaining([expect.objectContaining({ status: "rejected" })]) })]) });
    expect((await request(`/api/projects/${project.id}/file?path=sections%2Fintroduction.tex`)).status).toBe(404);
  });

  test("splits a main document into planned chapter files without rejecting bundled Agent output", async () => {
    const generatedTargets: string[] = [];
    let activeGenerations = 0;
    let maxConcurrentGenerations = 0;
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async planAgentTask(input) {
        expect(input.intent).toBe("revise");
        return {
          steps: ["Split main.tex into included chapter files"],
          affectedFiles: ["main.tex", "sections/introduction.tex", "sections/method.tex"],
          risks: ["Preserve section order"],
          validation: ["Compile"]
        };
      },
      async generateAgentTask(input) {
        generatedTargets.push(input.targetPath);
        expect(input.affectedFiles).toEqual([input.targetPath]);
        activeGenerations += 1;
        maxConcurrentGenerations = Math.max(maxConcurrentGenerations, activeGenerations);
        await Bun.sleep(30);
        activeGenerations -= 1;
        const generated: Record<string, DraftGeneratedFile> = {
          "main.tex": { path: "main.tex", content: "\\documentclass{article}\n\\begin{document}\n\\input{sections/introduction}\n\\input{sections/method}\n\\end{document}", rationale: "Keeps main as the root document." },
          "sections/introduction.tex": { path: "sections/introduction.tex", content: "\\section{Introduction}\nThe system has a bounded goal.", rationale: "Moves the introduction out of main.tex." },
          "sections/method.tex": { path: "sections/method.tex", content: "\\section{Method}\nThe method remains unchanged.", rationale: "Moves the method out of main.tex." }
        };
        return input.targetPath === "main.tex"
          ? { files: [generated["main.tex"]!, generated["sections/introduction.tex"]!, generated["sections/method.tex"]!] }
          : { files: [generated[input.targetPath]!] };
      }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Split Main" }) })).json() as PaperProject;
    const original = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    const monolith = "\\documentclass{article}\n\\begin{document}\n\\section{Introduction}\nThe system has a bounded goal.\n\\section{Method}\nThe method remains unchanged.\n\\end{document}";
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: monolith, baseVersion: original.file.version }) });
    const planned = await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "/revise 将main.tex拆分章节", scope: { type: "project" } }) });
    expect(planned.status).toBe(201);
    const body = await planned.json() as { plan: { id: string; affectedFiles: string[] } };
    expect(body.plan.affectedFiles).toEqual(["main.tex", "sections/introduction.tex", "sections/method.tex"]);
    const generated = await request(`/api/projects/${project.id}/agent-tasks/${body.plan.id}/confirm`, { method: "POST" });
    expect(generated.status).toBe(201);
    expect(new Set(generatedTargets)).toEqual(new Set(["main.tex", "sections/introduction.tex", "sections/method.tex"]));
    expect(maxConcurrentGenerations).toBeGreaterThan(1);
    const response = await generated.json() as { changeSet: ChangeSet; run: { auditTrail: Array<{ action: string; summary: string }> } };
    expect(response.changeSet.changes.map((change) => change.path).sort()).toEqual(["main.tex", "sections/introduction.tex", "sections/method.tex"]);
    expect(response.run.auditTrail.find((event) => event.action === "execution-started")?.summary).toContain("in parallel");
  });

  test("routes every explicit Agent command and repairs an incomplete compatible-model plan", async () => {
    const seenIntents: string[] = [];
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async planAgentTask(input) {
        seenIntents.push(input.intent);
        if (input.intent === "draft") return { steps: ["Draft the paper"] } as AgentTaskPlanOutput;
        return { steps: [`Run the ${input.intent} task`], affectedFiles: ["main.tex"], risks: [], validation: ["Compile"] };
      }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Agent commands" }) })).json() as PaperProject;
    const objectives = [
      "/draft Write a complete initial paper",
      "/continue Finish every TODO section",
      "/revise Improve the paper-wide argument"
    ];
    const plans: Array<{ intent: string; request: { objective: string }; affectedFiles: string[]; validation: string[] }> = [];
    for (const objective of objectives) {
      const response = await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective, scope: { type: "project" } }) });
      expect(response.status).toBe(201);
      plans.push(((await response.json()) as { plan: typeof plans[number] }).plan);
    }
    expect(seenIntents).toEqual(["draft", "continue", "revise"]);
    expect(plans.map((plan) => plan.intent)).toEqual(["draft", "continue", "revise"]);
    expect(plans.map((plan) => plan.request.objective)).toEqual(["Write a complete initial paper", "Finish every TODO section", "Improve the paper-wide argument"]);
    expect(plans[0]?.affectedFiles).toEqual(["main.tex"]);
    expect(plans[0]?.validation).toEqual(["Compile the resulting paper", "Review every proposed file before accepting"]);
  });

  test("returns a structured error when Agent execution omits generated files", async () => {
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async planAgentTask() { return { steps: ["Inspect the paper"], affectedFiles: ["main.tex"], risks: [], validation: ["Compile"] }; },
      async generateAgentTask() { return {} as { files: never[] }; }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Agent output validation" }) })).json() as PaperProject;
    const planned = await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "/draft Make a paper", scope: { type: "project" } }) });
    const plan = ((await planned.json()) as { plan: { id: string } }).plan;
    const generated = await request(`/api/projects/${project.id}/agent-tasks/${plan.id}/confirm`, { method: "POST" });
    expect(generated.status).toBe(502);
    expect(await generated.json()).toMatchObject({ error: { code: "agent_files_invalid" } });
  });

  test("rejects placeholder content generated by the /draft command", async () => {
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async planAgentTask() { return { steps: ["Draft the paper"], affectedFiles: ["main.tex"], risks: [], validation: ["Compile"] }; },
      async generateAgentTask(input) { return { files: [{ path: input.targetPath, content: "\\section{Introduction}\nTODO: Add evidence.", rationale: "Drafts the paper." }] }; }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "No placeholder drafts" }) })).json() as PaperProject;
    const planned = await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "/draft Write a complete paper", scope: { type: "project" } }) });
    const plan = ((await planned.json()) as { plan: { id: string } }).plan;
    const generated = await request(`/api/projects/${project.id}/agent-tasks/${plan.id}/confirm`, { method: "POST" });
    expect(generated.status).toBe(502);
    expect(await generated.json()).toMatchObject({ error: { code: "agent_draft_placeholder" } });
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

  test("supplies confirmed Paper Memory only to workflows that need its full or file-scoped context", async () => {
    const seen = { revise: "", reviseMemory: "", draft: "", review: "", agent: "" };
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
      async revise(input) { seen.revise = input.skillInstructions; seen.reviseMemory = input.paperContext ?? ""; return { replacement: "We present a privacy-preserving telemetry protocol.", rationale: "Concise phrasing." }; },
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
    const partiallyReviewedFile = await (await request(`/api/projects/${project.id}/file?path=memory.md`)).json() as FileContentResponse;
    expect(partiallyReviewedFile.content).toContain("## Reviewed Context");
    expect(partiallyReviewedFile.content).toContain("Core contribution");
    expect(partiallyReviewedFile.content).not.toContain("### Overview");
    expect(partiallyReviewedFile.content).not.toContain("### Method (sections/method.tex)");

    const current = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    const from = current.content.indexOf(sentence);
    const revised = await request(`/api/projects/${project.id}/revisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ command: "academic-polish", selection: { path: "main.tex", text: sentence, from, to: from + sentence.length, startLine: 2, endLine: 2, fileVersion: current.file.version } }) });
    expect((await revised.json() as { run: { memoryVersion?: number } }).run.memoryVersion).toBe(2);
    await request(`/api/projects/${project.id}/drafts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: "Telemetry", researchQuestion: "Can telemetry remain private?", contributions: ["A protocol"] }) });
    await request(`/api/projects/${project.id}/reviews`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceOnly: true }) });
    await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Inspect the paper argument", scope: { type: "project" } }) });
    expect(seen.revise).not.toContain("[contribution] Core contribution: The paper introduces a privacy-preserving telemetry protocol.");
    expect(seen.reviseMemory).toContain("[paper-overview] Core contribution: The paper introduces a privacy-preserving telemetry protocol.");
    expect(seen.reviseMemory).not.toContain("[contribution] Core contribution: The paper introduces a privacy-preserving telemetry protocol.");
    expect(seen.draft).not.toContain("Paper Memory");
    expect(seen.agent).toContain("[contribution] Core contribution: The paper introduces a privacy-preserving telemetry protocol.");
    expect(seen.review).not.toContain("Confirmed Paper Memory");

    const method = (await (await request(`/api/projects/${project.id}/file?path=sections%2Fmethod.tex`)).json()) as FileContentResponse;
    await request(`/api/projects/${project.id}/file?path=sections%2Fmethod.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `${method.content}% changed`, baseVersion: method.file.version }) });
    const stale = await (await request(`/api/projects/${project.id}/memory`)).json() as { items: Array<{ status: string; freshness?: string }> };
    expect(stale.items[0]).toMatchObject({ status: "confirmed", freshness: "stale" });
  });

  test("drafts a sparse Conclusion from reviewed local Memory and adjacent manuscript evidence", async () => {
    let received: ReviseAgentInput | undefined;
    const provider: AgentProvider = {
      async extractMemory() {
        return {
          items: [
            { category: "contribution", label: "Core method", content: "The paper introduces calibrated private aggregation.", sources: [{ path: "sections/evaluation.tex", excerpt: "Calibrated private aggregation reduces error by 18 percent.", section: "Evaluation", line: null }] },
            { category: "experiment", label: "Primary result", content: "The evaluation reports an 18 percent error reduction.", sources: [{ path: "sections/evaluation.tex", excerpt: "Calibrated private aggregation reduces error by 18 percent.", section: "Evaluation", line: null }] }
          ]
        };
      },
      async summarizeMemory() {
        return {
          overview: "The paper introduces calibrated private aggregation and reports an 18 percent error reduction.",
          sections: [
            { path: "sections/evaluation.tex", title: "Evaluation", content: "Reports an 18 percent error reduction." },
            { path: "sections/conclusion.tex", title: "Conclusion", content: "Conclude with the calibrated aggregation method, 18 percent result, and evidence limits." }
          ]
        };
      },
      async revise(input) {
        received = input;
        return { replacement: "\\section{Conclusion}\nCalibrated private aggregation reduces error by 18 percent under the evaluated setting.", rationale: "Uses reviewed paper evidence." };
      }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Sparse Conclusion" }) })).json() as PaperProject;
    const main = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    const mainContent = "\\documentclass{article}\n\\begin{document}\n\\input{sections/evaluation}\n\\input{sections/conclusion}\n\\end{document}\n";
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: mainContent, baseVersion: main.file.version }) });
    await request(`/api/projects/${project.id}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "sections/evaluation.tex", content: "\\section{Evaluation}\nCalibrated private aggregation reduces error by 18 percent.\n" }) });
    const conclusionContent = "\\section{Conclusion}\nTODO: Summarize the supported findings and limitations.\n";
    await request(`/api/projects/${project.id}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "sections/conclusion.tex", content: conclusionContent }) });
    expect((await request(`/api/projects/${project.id}/memory/extract`, { method: "POST" })).status).toBe(201);
    expect((await request(`/api/projects/${project.id}/memory/apply`, { method: "POST" })).status).toBe(200);

    const conclusion = await (await request(`/api/projects/${project.id}/file?path=sections%2Fconclusion.tex`)).json() as FileContentResponse;
    const response = await request(`/api/projects/${project.id}/revisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instruction: "Write a concrete conclusion from the available paper evidence.",
        selection: { path: conclusion.file.path, text: conclusion.content, from: 0, to: conclusion.content.length, startLine: 1, endLine: 2, fileVersion: conclusion.file.version }
      })
    });
    expect(response.status).toBe(201);
    expect(received?.selectionIsSectionScaffold).toBe(true);
    expect(received?.sectionTitle).toBe("Conclusion");
    expect(received?.contextBefore).toContain("[Adjacent paper section: Evaluation (sections/evaluation.tex)]");
    expect(received?.contextBefore).toContain("reduces error by 18 percent");
    expect(received?.paperContext).toContain("[paper-overview]");
    expect(received?.paperContext).toContain("[current-section:Conclusion]");
    expect(received?.paperContext).not.toContain("[current-section:Evaluation]");
  });

  test("keeps human-locked hierarchical Memory content and presents regenerated differences as candidates", async () => {
    let extraction = 0;
    const polishCalls: Array<{ kind: string; content: string }> = [];
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async extractMemory() {
        extraction += 1;
        return {
          items: [{
            category: "contribution",
            label: "Core contribution",
            content: extraction === 1 ? "The protocol protects telemetry metadata." : "The protocol protects telemetry and endpoint metadata.",
            sources: [{ path: "main.tex", excerpt: "The protocol protects telemetry metadata.", section: "Introduction", line: null }]
          }]
        };
      },
      async summarizeMemory() {
        return {
          overview: extraction === 1 ? "The paper proposes a telemetry protocol." : "The paper proposes an expanded telemetry protocol.",
          sections: [{ path: "main.tex", title: "Introduction", content: extraction === 1 ? "Introduces telemetry protection." : "Introduces expanded telemetry protection." }]
        };
      },
      async polishMemory(input) {
        polishCalls.push({ kind: input.kind, content: input.content });
        return { content: input.content === "用户确认 telemetry-only claim." ? "The user confirms the telemetry-only claim." : input.content };
      }
    };
    const request = await testApplication(provider);
    const project = (await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Hierarchical Memory" }) })).json()) as PaperProject;
    const opened = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `${opened.content}\nThe protocol protects telemetry metadata.`, baseVersion: opened.file.version }) });

    const first = (await (await request(`/api/projects/${project.id}/memory/extract`, { method: "POST" })).json()) as PaperMemory;
    expect(first.overview?.content).toBe("The paper proposes a telemetry protocol.");
    expect(first.sections?.some((section) => section.title === "Introduction")).toBe(true);
    const fact = first.items[0]!;
    const section = first.sections?.find((item) => item.title === "Introduction")!;

    const confirmed = (await (await request(`/api/projects/${project.id}/memory/items/${fact.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "confirmed", content: "用户确认 telemetry-only claim." }) })).json()) as PaperMemory;
    const overview = (await (await request(`/api/projects/${project.id}/memory/overview`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Human-authored paper overview." }) })).json()) as PaperMemory;
    const updatedSection = (await (await request(`/api/projects/${project.id}/memory/sections/${section.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "Human-authored introduction summary." }) })).json()) as PaperMemory;
    expect(confirmed.items[0]?.locked).toBe(true);
    expect(overview.overview?.locked).toBe(true);
    expect(updatedSection.sections?.find((item) => item.id === section.id)?.locked).toBe(true);
    expect(polishCalls).toEqual([
      { kind: "fact", content: "用户确认 telemetry-only claim." },
      { kind: "overview", content: "Human-authored paper overview." },
      { kind: "section", content: "Human-authored introduction summary." }
    ]);

    const regenerated = (await (await request(`/api/projects/${project.id}/memory/extract`, { method: "POST" })).json()) as PaperMemory;
    const preserved = regenerated.items.find((item) => item.id === fact.id)!;
    expect(regenerated.items).toHaveLength(1);
    expect(preserved).toMatchObject({ content: "The user confirms the telemetry-only claim.", locked: true, humanEdited: true });
    expect(preserved.candidate?.content).toBe("The protocol protects telemetry and endpoint metadata.");
    expect(regenerated.overview?.content).toBe("Human-authored paper overview.");
    expect(regenerated.overview?.candidate?.content).toBe("The paper proposes an expanded telemetry protocol.");
    expect(regenerated.sections?.find((item) => item.id === section.id)?.content).toBe("Human-authored introduction summary.");
    expect(regenerated.sections?.find((item) => item.id === section.id)?.candidate?.content).toBe("Introduces expanded telemetry protection.");

    const acceptedOverview = (await (await request(`/api/projects/${project.id}/memory/overview/accept`, { method: "POST" })).json()) as PaperMemory;
    expect(acceptedOverview.overview).toMatchObject({ content: "The paper proposes an expanded telemetry protocol.", locked: true, humanEdited: false });
    expect(acceptedOverview.overview?.candidate).toBeUndefined();
    const acceptedSection = (await (await request(`/api/projects/${project.id}/memory/sections/${section.id}/accept`, { method: "POST" })).json()) as PaperMemory;
    expect(acceptedSection.sections?.find((item) => item.id === section.id)).toMatchObject({ content: "Introduces expanded telemetry protection.", locked: true, humanEdited: false });
    const acceptedFact = (await (await request(`/api/projects/${project.id}/memory/items/${fact.id}/accept`, { method: "POST" })).json()) as PaperMemory;
    expect(acceptedFact.items.find((item) => item.id === fact.id)).toMatchObject({ content: "The protocol protects telemetry and endpoint metadata.", status: "confirmed", locked: true, humanEdited: false });
    expect(polishCalls).toHaveLength(3);
  });

  test("writes a reviewable root memory.md and supplies its user instructions without re-ingesting the file", async () => {
    let agentInstructions = "";
    let agentPaths: string[] = [];
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async extractMemory() {
        return { items: [{ category: "contribution", label: "Core result", content: "The system protects telemetry metadata.", sources: [{ path: "main.tex", excerpt: "The system protects telemetry metadata.", section: "Introduction", line: null }] }] };
      },
      async summarizeMemory() { return { overview: "A telemetry privacy system.", sections: [{ path: "main.tex", title: "Introduction", content: "Introduces the telemetry privacy result." }] }; },
      async planAgentTask(input) { agentInstructions = input.skillInstructions; agentPaths = input.documents.map((document) => document.path); return { steps: ["Inspect the argument"], affectedFiles: ["main.tex"], risks: [], validation: ["Compile"] }; }
    };
    const request = await testApplication(provider);
    const project = (await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Durable Memory" }) })).json()) as PaperProject;
    const main = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `${main.content}\n\\section{Introduction}\nThe system protects telemetry metadata.`, baseVersion: main.file.version }) });

    const extracted = await request(`/api/projects/${project.id}/memory/extract`, { method: "POST" });
    expect(extracted.status).toBe(201);
    const candidateFile = (await (await request(`/api/projects/${project.id}/file?path=memory.md`)).json()) as FileContentResponse;
    expect(candidateFile.content).toContain("## Candidate Context");
    expect(candidateFile.content).toContain("## User Instructions");
    const instructions = candidateFile.content.replace(/<!-- Add durable [^]*?-->/, "Never broaden the threat model or invent evaluation results.");
    await request(`/api/projects/${project.id}/file?path=memory.md`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: instructions, baseVersion: candidateFile.file.version }) });

    const applied = await request(`/api/projects/${project.id}/memory/apply`, { method: "POST" });
    expect(applied.status).toBe(200);
    expect((await applied.json() as PaperMemory).items[0]).toMatchObject({ status: "confirmed", locked: true });
    const reviewedFile = (await (await request(`/api/projects/${project.id}/file?path=memory.md`)).json()) as FileContentResponse;
    expect(reviewedFile.content).toContain("## Reviewed Context");
    expect(reviewedFile.content).toContain("Never broaden the threat model");

    await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Inspect the paper argument", scope: { type: "project" } }) });
    expect(agentInstructions).toContain("[user-instructions]");
    expect(agentInstructions).toContain("Never broaden the threat model or invent evaluation results.");
    expect(agentPaths).not.toContain("memory.md");
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
    const project = (await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Resolution Paper", venue: "network-information-security" }) })).json()) as PaperProject;
    const opened = (await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json()) as FileContentResponse;
    const content = "\\section{Threat Model}\nThreat model placeholder.\n";
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, baseVersion: opened.file.version }) });
    const review = await (await request(`/api/projects/${project.id}/reviews`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceOnly: true }) })).json() as { report: { issues: Array<{ id: string }> } };
    const issueId = review.report.issues[0]!.id;
    const planned = await (await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Resolve the endpoint-compromise review issue", scope: { type: "project" }, issueIds: [issueId] }) })).json() as { plan: { id: string }; resolution: { id: string; status: string; reviewSnapshotIds: string[]; baseProjectVersion: number; skill: { venue: string } } };
    expect(planned.resolution.status).toBe("planned");
    expect(planned.resolution).toMatchObject({ reviewSnapshotIds: [expect.stringContaining("snapshot_")], skill: { venue: "network-information-security" } });
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
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Completion Paper", venue: "artificial-intelligence" }) })).json() as PaperProject;
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
    expect(received?.skillInstructions).toContain("[paper-overview] Telemetry: The design protects aggregate telemetry.");
    expect(received?.skillInstructions).not.toContain("[contribution] Telemetry: The design protects aggregate telemetry.");
    expect(received?.paperContext).toContain("[paper-overview] Telemetry: The design protects aggregate telemetry.");
    expect(received?.skill.id).toBe("artificial-intelligence");
    expect(received?.venueInstructions).toContain("# Artificial intelligence");
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
    expect(final.status).toBe("partially-accepted");
    expect(final.changes[0]!.hunks?.map((hunk) => hunk.status)).toEqual(["accepted", "rejected"]);
    const partiallyApplied = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    expect(partiallyApplied.content).toBe(intermediate.content);

    const reversed = await (await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions: [{ path: "main.tex", hunkIds: [change.hunks![0]!.id], status: "rejected" }] }) })).json() as ChangeSet;
    expect(reversed.changes[0]!.hunks?.map((hunk) => hunk.status)).toEqual(["rejected", "rejected"]);
    expect((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse).content).toBe(original);

    const reconsidered = await (await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions: [{ path: "main.tex", hunkIds: [change.hunks![1]!.id], status: "accepted" }] }) })).json() as ChangeSet;
    expect(reconsidered.changes[0]!.hunks?.map((hunk) => hunk.status)).toEqual(["rejected", "accepted"]);
    const beforeFinish = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    expect(beforeFinish.content).toContain("old method");
    expect(beforeFinish.content).toContain("new result");
    const finished = await (await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/finish`, { method: "POST" })).json() as ChangeSet;
    expect(finished).toMatchObject({ status: "accepted", approvalMode: "explicit-finish", reviewFinishedAt: expect.any(String) });

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

  test("edits one Agent hunk without resetting decisions in the same file", async () => {
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async planAgentTask() { return { steps: ["Revise two claims"], affectedFiles: ["main.tex"], risks: [], validation: ["Compile"] }; },
      async generateAgentTask(input) {
        const document = input.documents.find((candidate) => candidate.path === "main.tex")!;
        return { files: [{ path: "main.tex", content: document.content.replace("old method", "new method").replace("old result", "new result"), rationale: "Updates two independent claims." }] };
      }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Hunk editing" }) })).json() as PaperProject;
    const opened = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    const original = "title\nkeep alpha\nold method\nkeep beta\nold result\nend\n";
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: original, baseVersion: opened.file.version }) });
    const planned = await (await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Update both claims", scope: { type: "project" } }) })).json() as { plan: { id: string } };
    const generated = await (await request(`/api/projects/${project.id}/agent-tasks/${planned.plan.id}/confirm`, { method: "POST" })).json() as { changeSet: ChangeSet };
    const change = generated.changeSet.changes[0]!;
    const methodHunk = change.hunks!.find((hunk) => hunk.before.includes("old method"))!;
    const resultHunk = change.hunks!.find((hunk) => hunk.before.includes("old result"))!;
    await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions: [{ path: change.path, hunkIds: [methodHunk.id], status: "accepted" }] }) });

    const editedAfter = resultHunk.after.replace("new result", "author-refined result");
    const editedResponse = await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ hunks: [{ path: change.path, hunkId: resultHunk.id, after: editedAfter }] }) });
    expect(editedResponse.status).toBe(200);
    const edited = await editedResponse.json() as ChangeSet;
    expect(edited.changes[0]!.hunks?.map((hunk) => ({ id: hunk.id, status: hunk.status }))).toEqual([{ id: methodHunk.id, status: "accepted" }, { id: resultHunk.id, status: "pending" }]);
    expect(edited.changes[0]!.after).toContain("author-refined result");
    const beforeSecondAccept = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    expect(beforeSecondAccept.content).toContain("new method");
    expect(beforeSecondAccept.content).toContain("old result");

    await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions: [{ path: change.path, hunkIds: [resultHunk.id], status: "accepted" }] }) });
    expect((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse).content).toContain("author-refined result");
    const runs = await (await request(`/api/projects/${project.id}/agent-runs`)).json() as Array<{ auditTrail: Array<{ action: string }> }>;
    expect(runs[0]!.auditTrail.some((event) => event.action === "hunk-edited")).toBe(true);
  });

  test("recomputes blocking citation findings after a reviewed hunk is edited", async () => {
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async planAgentTask() { return { steps: ["Revise the claim"], affectedFiles: ["main.tex"], risks: [], validation: ["Compile"] }; },
      async generateAgentTask(input) {
        const document = input.documents.find((candidate) => candidate.path === "main.tex")!;
        return { files: [{ path: "main.tex", content: document.content.replace("old claim", "new claim \\cite{unknown}"), rationale: "Adds a citation-dependent claim." }] };
      }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Citation finding edit" }) })).json() as PaperProject;
    const opened = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "old claim\n", baseVersion: opened.file.version }) });
    const planned = await (await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Revise the claim", scope: { type: "project" } }) })).json() as { plan: { id: string } };
    const generated = await (await request(`/api/projects/${project.id}/agent-tasks/${planned.plan.id}/confirm`, { method: "POST" })).json() as { changeSet: ChangeSet };
    const hunk = generated.changeSet.changes[0]!.hunks![0]!;
    expect(hunk.findings?.[0]?.status).toBe("blocking");
    expect((await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions: [{ path: "main.tex", hunkIds: [hunk.id], status: "accepted" }] }) })).status).toBe(409);

    const edited = await (await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ hunks: [{ path: "main.tex", hunkId: hunk.id, after: "new claim; TODO: add a verified citation" }] }) })).json() as ChangeSet;
    expect(edited.changes[0]!.hunks![0]!.findings).toBeUndefined();
    expect((await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions: [{ path: "main.tex", hunkIds: [hunk.id], status: "accepted" }] }) })).status).toBe(200);
  });

  test("previews external Agent conflicts and requires the latest version token before overwrite", async () => {
    const provider: AgentProvider = {
      async revise(input) { return { replacement: input.selection.text, rationale: "unused" }; },
      async planAgentTask() { return { steps: ["Revise the method"], affectedFiles: ["main.tex"], risks: [], validation: ["Compile"] }; },
      async generateAgentTask(input) {
        const document = input.documents.find((candidate) => candidate.path === "main.tex")!;
        return { files: [{ path: "main.tex", content: document.content.replace("old method", "reviewed method"), rationale: "Updates the method claim." }] };
      }
    };
    const request = await testApplication(provider);
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Conflict overwrite" }) })).json() as PaperProject;
    const opened = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    const original = "title\nold method\nend\n";
    const savedOriginal = await (await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: original, baseVersion: opened.file.version }) })).json() as SaveFileResponse;
    const planned = await (await request(`/api/projects/${project.id}/agent-tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective: "Update the method", scope: { type: "project" } }) })).json() as { plan: { id: string } };
    const generated = await (await request(`/api/projects/${project.id}/agent-tasks/${planned.plan.id}/confirm`, { method: "POST" })).json() as { changeSet: ChangeSet };
    const change = generated.changeSet.changes[0]!;
    const externalContent = original.replace("end", "external edit\nend");
    const external = await (await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: externalContent, baseVersion: savedOriginal.file.version }) })).json() as SaveFileResponse;
    const decisions = [{ path: change.path, hunkIds: change.hunks!.map((hunk) => hunk.id), status: "accepted" as const }];

    const firstConflictResponse = await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions }) });
    expect(firstConflictResponse.status).toBe(409);
    const firstConflictBody = await firstConflictResponse.json() as { error: { code: string; details: ChangeSetConflictDetails } };
    expect(firstConflictBody.error.code).toBe("changeset_conflict_review_required");
    expect(firstConflictBody.error.details.conflicts[0]).toMatchObject({ path: "main.tex", currentContent: externalContent, currentVersion: external.file.version });
    expect(firstConflictBody.error.details.conflicts[0]!.reviewedContent).toContain("reviewed method");
    expect((await (await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}`)).json() as ChangeSet).status).toBe("proposed");
    expect((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse).content).toBe(externalContent);

    const changedAgainContent = externalContent.replace("end", "second external edit\nend");
    const changedAgain = await (await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: changedAgainContent, baseVersion: external.file.version }) })).json() as SaveFileResponse;
    const staleOverwriteResponse = await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions, overwriteConflicts: [{ path: "main.tex", currentVersion: external.file.version }] }) });
    expect(staleOverwriteResponse.status).toBe(409);
    const latestConflict = await staleOverwriteResponse.json() as { error: { details: ChangeSetConflictDetails } };
    expect(latestConflict.error.details.conflicts[0]!.currentVersion).toBe(changedAgain.file.version);
    expect((await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse).content).toBe(changedAgainContent);

    const overwrittenResponse = await request(`/api/projects/${project.id}/change-sets/${generated.changeSet.id}/decide`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decisions, overwriteConflicts: [{ path: "main.tex", currentVersion: changedAgain.file.version }] }) });
    expect(overwrittenResponse.status).toBe(200);
    const overwritten = await overwrittenResponse.json() as ChangeSet;
    expect(overwritten.status).toBe("partially-accepted");
    const finalFile = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    expect(finalFile.content).toBe(latestConflict.error.details.conflicts[0]!.reviewedContent);
    expect(finalFile.content).not.toContain("external edit");
  });

  test("imports a manifest-last FastRead bundle into visible research, evidence, claims and BibTeX", async () => {
    const request = await testApplication();
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "FastRead handoff" }) })).json() as PaperProject;
    const bundleId = "0123456789abcdef01234567";
    const root = `references/fastread/${bundleId}`;
    const evidenceMarkdown = "# Evidence\n\n- exact quote\n";
    const citationsJson = JSON.stringify({
      version: 1,
      bundle_id: bundleId,
      selector: { task_id: "paper-task", topic_id: "" },
      papers: [{ id: "paper-task", title: "FastRead paper", authors: ["Ada Lovelace"], year: 2026, doi: "10.1000/fastread", content_hash: "source-hash" }],
      citations: [{ task_id: "paper-task", page: 7, exact_quote: "The evaluated method improves accuracy by ten percent.", role: "report", note: "key result", source_hash: "source-hash" }]
    }, null, 2) + "\n";
    const referencesBib = "@article{Lovelace2026_1,\n  title = {FastRead paper},\n  author = {Ada Lovelace},\n  year = {2026}\n}\n";
    const files = { "evidence.md": evidenceMarkdown, "citations.json": citationsJson, "references.bib": referencesBib };
    for (const [name, content] of Object.entries(files)) expect((await request(`/api/projects/${project.id}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: `${root}/${name}`, content }) })).status).toBe(201);
    const manifest = JSON.stringify({
      version: 1,
      bundle_id: bundleId,
      immutable: true,
      files: Object.entries(files).map(([name, content]) => ({ name, sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"), bytes: Buffer.byteLength(content) }))
    }, null, 2) + "\n";
    expect((await request(`/api/projects/${project.id}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: `${root}/manifest.json`, content: manifest }) })).status).toBe(201);

    const bundles = await (await request(`/api/projects/${project.id}/fastread-bundles`)).json() as FastReadBundleReceipt[];
    expect(bundles).toHaveLength(1);
    expect(bundles[0]).toMatchObject({ bundleId, status: "imported", workIds: [expect.any(String)], evidenceIds: [expect.any(String)] });
    const works = await (await request(`/api/projects/${project.id}/research-works`)).json() as Array<ResearchWork & { project: { status: string; citationKey?: string } }>;
    expect(works).toHaveLength(1);
    expect(works[0]).toMatchObject({ title: "FastRead paper", project: { status: "saved", citationKey: "Lovelace2026_1" } });
    const importedEvidence = await (await request(`/api/projects/${project.id}/evidence`)).json() as SourceEvidence[];
    expect(importedEvidence).toHaveLength(1);
    expect(importedEvidence[0]).toMatchObject({ status: "approved", representation: "verbatim", locator: "7", sourceHash: "source-hash", fastReadBundleId: bundleId });

    const opened = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "\\documentclass{article}\n\\begin{document}\nOur method improves accuracy by ten percent.\n\\end{document}\n", baseVersion: opened.file.version }) });
    const firstScan = await (await request(`/api/projects/${project.id}/claim-scans`, { method: "POST" })).json() as PaperClaim[];
    expect(firstScan).toHaveLength(1);
    const linked = await (await request(`/api/projects/${project.id}/claims/${firstScan[0]!.id}/links`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "literature", evidenceId: importedEvidence[0]!.id, citationKey: "Lovelace2026_1" }) })).json() as ClaimEvidenceLink;
    expect(linked.kind).toBe("literature");
    expect((await request(`/api/projects/${project.id}/claims/${firstScan[0]!.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewStatus: "supported" }) })).status).toBe(200);
    const secondScan = await (await request(`/api/projects/${project.id}/claim-scans`, { method: "POST" })).json() as PaperClaim[];
    expect(secondScan[0]!.id).toBe(firstScan[0]!.id);
    expect(secondScan[0]!.reviewStatus).toBe("supported");
    expect(await (await request(`/api/projects/${project.id}/claim-links`)).json()).toHaveLength(1);

    const proposed = await (await request(`/api/projects/${project.id}/research-works/${works[0]!.id}/bibtex-changes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetBibPath: "references.bib" }) })).json() as ChangeSet;
    expect(proposed.changes[0]).toMatchObject({ operation: "create", path: "references.bib" });
    expect((await request(`/api/projects/${project.id}/change-sets/${proposed.id}/accept`, { method: "POST" })).status).toBe(200);
    expect((await (await request(`/api/projects/${project.id}/file?path=references.bib`)).json() as FileContentResponse).content).toContain("FastRead paper");

    const repeated = await (await request(`/api/projects/${project.id}/fastread-bundles/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manifestPath: `${root}/manifest.json` }) })).json() as FastReadBundleReceipt[];
    expect(repeated[0]!.status).toBe("imported");
    expect(await (await request(`/api/projects/${project.id}/research-works`)).json()).toHaveLength(1);
    expect(await (await request(`/api/projects/${project.id}/evidence`)).json()).toHaveLength(1);
  });

  test("keeps Claim identity anchored across edits and revokes unsupported status when support changes", async () => {
    const request = await testApplication();
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Claim lifecycle" }) })).json() as PaperProject;
    const source = await (await request(`/api/projects/${project.id}/research-works/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Verified result", authors: ["Ada Lovelace"], year: 2026, doi: "10.1000/claim-life", citationKey: "lovelace2026life" }) })).json() as ResearchWork;
    const evidence = await (await request(`/api/projects/${project.id}/evidence`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workId: source.id, kind: "result", content: "The evaluated method improves accuracy by ten percent.", locatorType: "page", locator: "7", origin: "source-text", representation: "verbatim" }) })).json() as SourceEvidence;
    await request(`/api/projects/${project.id}/evidence/${evidence.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "approved" }) });
    const opened = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    const original = "\\documentclass{article}\n\\begin{document}\nThe deployment setting is fixed.\nOur method improves accuracy by ten percent.\nThe evaluation ends here.\n\\end{document}\n";
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: original, baseVersion: opened.file.version }) });
    const scanned = await (await request(`/api/projects/${project.id}/claim-scans`, { method: "POST" })).json() as PaperClaim[];
    const claim = scanned.find((item) => item.anchor.exactText === "Our method improves accuracy by ten percent.")!;
    const linked = await (await request(`/api/projects/${project.id}/claims/${claim.id}/links`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "literature", evidenceId: evidence.id, citationKey: "lovelace2026life" }) })).json() as ClaimEvidenceLink;
    expect((await request(`/api/projects/${project.id}/claims/${claim.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewStatus: "supported" }) })).status).toBe(200);

    const current = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    const shifted = `% context shift\n${original}`;
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: shifted, baseVersion: current.file.version }) });
    const shiftedClaim = (await (await request(`/api/projects/${project.id}/claims`)).json() as PaperClaim[]).find((item) => item.id === claim.id)!;
    expect(shiftedClaim).toMatchObject({ id: claim.id, reviewStatus: "supported", anchorStatus: "reanchored" });
    expect(shiftedClaim.anchor.startOffset).toBeGreaterThan(claim.anchor.startOffset);

    const shiftedFile = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    const revised = shifted.replace("improves accuracy by ten percent", "improves accuracy by eleven percent");
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: revised, baseVersion: shiftedFile.file.version }) });
    const revisedClaim = (await (await request(`/api/projects/${project.id}/claims`)).json() as PaperClaim[]).find((item) => item.id === claim.id)!;
    expect(revisedClaim).toMatchObject({ id: claim.id, reviewStatus: "needs-review", anchorStatus: "reanchored" });
    expect(revisedClaim.anchor.exactText).toBe("Our method improves accuracy by eleven percent.");
    expect((await (await request(`/api/projects/${project.id}/claim-links`)).json() as ClaimEvidenceLink[]).some((item) => item.id === linked.id)).toBe(true);
    expect((await request(`/api/projects/${project.id}/claims/${claim.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewStatus: "supported" }) })).status).toBe(200);
    await request(`/api/projects/${project.id}/evidence/${evidence.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "rejected" }) });
    expect((await (await request(`/api/projects/${project.id}/claims`)).json() as PaperClaim[]).find((item) => item.id === claim.id)?.reviewStatus).toBe("needs-review");
    await request(`/api/projects/${project.id}/evidence/${evidence.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "approved" }) });
    await request(`/api/projects/${project.id}/claims/${claim.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ reviewStatus: "supported" }) });
    await request(`/api/projects/${project.id}/claims/${claim.id}/links/${linked.id}`, { method: "DELETE" });
    expect((await (await request(`/api/projects/${project.id}/claims`)).json() as PaperClaim[]).find((item) => item.id === claim.id)?.reviewStatus).toBe("needs-review");
  });

  test("deduplicates manual sources and exposes provenance, identifiers and citation context", async () => {
    const request = await testApplication();
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Source provenance" }) })).json() as PaperProject;
    const body = { title: "A Traceable Source", authors: ["Ada Lovelace"], year: 2026, venue: "TestConf", doi: "https://doi.org/10.1000/TRACE", citationKey: "lovelace2026trace" };
    const first = await (await request(`/api/projects/${project.id}/research-works/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as ResearchWork;
    const second = await (await request(`/api/projects/${project.id}/research-works/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, doi: "10.1000/trace" }) })).json() as ResearchWork;
    expect(second.id).toBe(first.id);
    const works = await (await request(`/api/projects/${project.id}/research-works`)).json() as ProjectResearchWorkDetails[];
    expect(works).toHaveLength(1);
    expect(works[0]).toMatchObject({ id: first.id, project: { status: "saved", citationKey: "lovelace2026trace" }, identifiers: [{ scheme: "doi", value: "10.1000/trace" }] });
    expect(works[0]!.metadataObservations.map((item) => item.provider)).toEqual(["user"]);
    const opened = await (await request(`/api/projects/${project.id}/file?path=main.tex`)).json() as FileContentResponse;
    await request(`/api/projects/${project.id}/file?path=main.tex`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "\\documentclass{article}\n\\begin{document}\nPrior work is traceable \\cite{lovelace2026trace}.\n\\end{document}\n", baseVersion: opened.file.version }) });
    const context = await (await request(`/api/projects/${project.id}/research-citations/lovelace2026trace`)).json() as { contexts: Array<{ path: string; line: number; excerpt: string }> };
    expect(context.contexts[0]).toMatchObject({ path: "main.tex", line: 3 });
    expect(context.contexts[0]!.excerpt).toContain("lovelace2026trace");
  });

  test("keeps a failed FastRead hash receipt visible and retryable", async () => {
    const request = await testApplication();
    const project = await (await request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Broken handoff" }) })).json() as PaperProject;
    const bundleId = "fedcba987654321001234567";
    const root = `references/fastread/${bundleId}`;
    for (const [name, content] of [["evidence.md", "evidence"], ["citations.json", JSON.stringify({ version: 1, bundle_id: bundleId, papers: [], citations: [] })], ["references.bib", ""]] as const) await request(`/api/projects/${project.id}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: `${root}/${name}`, content }) });
    const manifest = JSON.stringify({ version: 1, bundle_id: bundleId, immutable: true, files: [{ name: "evidence.md", sha256: "0".repeat(64), bytes: 8 }, { name: "citations.json", sha256: "0".repeat(64), bytes: 2 }, { name: "references.bib", sha256: new Bun.CryptoHasher("sha256").update("").digest("hex"), bytes: 0 }] });
    expect((await request(`/api/projects/${project.id}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: `${root}/manifest.json`, content: manifest }) })).status).toBe(201);
    const receipts = await (await request(`/api/projects/${project.id}/fastread-bundles`)).json() as FastReadBundleReceipt[];
    expect(receipts[0]).toMatchObject({ bundleId, status: "failed" });
    expect(receipts[0]!.error).toContain("SHA-256");
    expect(await (await request(`/api/projects/${project.id}/research-works`)).json()).toHaveLength(0);
  });
});
