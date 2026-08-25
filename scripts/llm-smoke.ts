import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  AgentTaskPlanResponse,
  ChangeSet,
  CompletionResponse,
  DraftPlanResponse,
  FileContentResponse,
  IssueResolution,
  PaperMemory,
  PaperProject,
  ReviewIssue,
  ReviewResponse,
  ReviseResponse
} from "@fastwrite/shared";
import { createApplication } from "../apps/server/src/app";
import { config } from "../apps/server/src/config";

if (!config.openAIKey) throw new Error(".env must define OPENAI_API_KEY or OPENAI_KEY");
if (!config.openAIBaseURL) throw new Error(".env must define OPENAI_BASE_URL or OPENAI_API_BASE for this smoke test");

const dataDirectory = await mkdtemp(join(tmpdir(), "fastwrite-real-llm-"));
const fetchApp = await createApplication(dataDirectory);
const completed: string[] = [];

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetchApp(new Request(`http://fastwrite.test${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  }));
  const payload = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
  if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}, ${payload.error?.code ?? "unknown"}): ${payload.error?.message ?? "no message"}`);
  return payload as T;
}

async function stage<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await operation();
  completed.push(name);
  console.log(`PASS ${name} (${Math.round(performance.now() - started)} ms)`);
  return result;
}

try {
  console.log(`LLM endpoint configured; model=${config.agentModel ?? "auto-discovered"}`);
  const project = await api<PaperProject>("/api/projects", "POST", { name: "Real LLM Smoke", venue: "network-information-security" });
  const initial = await api<FileContentResponse>(`/api/projects/${project.id}/file?path=main.tex`);
  const source = String.raw`\documentclass{article}
\begin{document}
\section{Introduction}
We study a network monitor that detects malicious traffic. The trusted gateway is not compromised. Our contribution is a bounded detection method; measured accuracy remains an open evaluation item.
\section{Threat Model}
The attacker controls network inputs but cannot modify the trusted gateway.
\section{Evaluation}
TODO: measure detection accuracy and runtime on public traces.
\end{document}`;
  await api(`/api/projects/${project.id}/file?path=main.tex`, "PUT", { content: source, baseVersion: initial.file.version });

  const opened = await api<FileContentResponse>(`/api/projects/${project.id}/file?path=main.tex`);
  const selectedText = "We study a network monitor that detects malicious traffic.";
  const from = opened.content.indexOf(selectedText);
  const revision = await stage("revise", () => api<ReviseResponse>(`/api/projects/${project.id}/revisions`, "POST", {
    command: "academic-polish",
    selection: { path: "main.tex", text: selectedText, from, to: from + selectedText.length, startLine: 4, endLine: 4, fileVersion: opened.file.version }
  }));
  if (!revision.changeSet.changes[0]?.after.trim()) throw new Error("Revise returned no replacement");
  await api(`/api/projects/${project.id}/change-sets/${revision.changeSet.id}/reject`, "POST");

  const memory = await stage("paper-memory", () => api<PaperMemory>(`/api/projects/${project.id}/memory/extract`, "POST"));
  if (!memory.items.length) throw new Error("Paper Memory returned no source-grounded items");
  await api(`/api/projects/${project.id}/memory/items/${memory.items[0]!.id}`, "PATCH", { status: "confirmed" });

  const draft = await stage("draft-plan", () => api<DraftPlanResponse>(`/api/projects/${project.id}/drafts`, "POST", {
    topic: "A bounded malicious-traffic detector",
    researchQuestion: "Can a trusted gateway detect malicious traffic under the stated attacker boundary?",
    contributions: ["A bounded threat model", "A deployable detector design", "An explicit evaluation plan"],
    materials: "No measured results are available; retain TODO markers."
  }));
  const generatedDraft = await stage("draft-generate", () => api<{ changeSet: ChangeSet }>(`/api/projects/${project.id}/drafts/${draft.plan.id}/confirm`, "POST", { outline: draft.plan.outline }));
  if (generatedDraft.changeSet.changes.length < 2) throw new Error("Draft generation did not produce a multi-file ChangeSet");
  await api(`/api/projects/${project.id}/change-sets/${generatedDraft.changeSet.id}/reject`, "POST");

  const review = await stage("review", () => api<ReviewResponse>(`/api/projects/${project.id}/reviews`, "POST", { sourceOnly: true }));
  let issue: ReviewIssue | undefined = review.report.issues[0];
  if (!issue) issue = await api<ReviewIssue>(`/api/projects/${project.id}/review-issues`, "POST", {
    reportId: review.report.id,
    category: "evaluation",
    severity: "major",
    title: "Evaluation evidence is incomplete",
    rationale: "The manuscript explicitly marks accuracy and runtime measurements as TODO.",
    impact: "The main security claim lacks empirical support.",
    suggestion: "Clarify the evaluation plan without inventing results."
  });

  const agentPlan = await stage("agent-plan", () => api<AgentTaskPlanResponse & { resolution?: IssueResolution }>(`/api/projects/${project.id}/agent-tasks`, "POST", {
    objective: "Revise main.tex to clarify the planned accuracy and runtime evaluation without inventing results or citations.",
    scope: { type: "project" },
    issueIds: [issue!.id]
  }));
  const agentResult = await stage("agent-generate", () => api<{ changeSet: ChangeSet; resolution?: IssueResolution }>(`/api/projects/${project.id}/agent-tasks/${agentPlan.plan.id}/confirm`, "POST"));
  if (!agentResult.changeSet.changes.length) throw new Error("Agent generation returned no proposed files");
  await api(`/api/projects/${project.id}/change-sets/${agentResult.changeSet.id}/accept`, "POST");

  const currentProject = await api<PaperProject>(`/api/projects/${project.id}`);
  await api(`/api/projects/${project.id}/compile-results`, "POST", { projectVersion: currentProject.version, status: "success", summary: "Real-LLM smoke compile gate" });
  const resolutions = await api<IssueResolution[]>(`/api/projects/${project.id}/issue-resolutions`);
  const resolution = resolutions.find((candidate) => candidate.issueIds.includes(issue!.id));
  if (!resolution) throw new Error("Agent task did not create an IssueResolution");
  await stage("targeted-rereview", () => api<IssueResolution>(`/api/projects/${project.id}/issue-resolutions/${resolution.id}/rereview`, "POST"));

  const completionFile = await api<FileContentResponse>(`/api/projects/${project.id}/file?path=main.tex`);
  const completion = await stage("completion", () => api<CompletionResponse>(`/api/projects/${project.id}/completions`, "POST", {
    path: "main.tex",
    cursor: completionFile.content.indexOf("\\end{document}"),
    fileVersion: completionFile.file.version,
    kind: "auto"
  }));
  if (typeof completion.suggestion !== "string") throw new Error("Completion response has an invalid suggestion");

  console.log(`REAL_LLM_SMOKE_OK ${completed.length}/9`);
} finally {
  await rm(dataDirectory, { recursive: true, force: true });
}
