import type { AgentRun, OutlineItem, ReviewIssue, ReviewIssueStatus, ReviewReport, ReviewResponse, ReviewSnapshot, WorkspaceTreeNode } from "@fastwrite/shared";
import { ApiError } from "../http";
import type { JsonDatabase } from "../storage/database";
import type { WorkspaceService } from "../workspace/workspace-service";
import type { AgentProvider, ReviewAgentOutput } from "./provider";
import type { SkillRegistry } from "./skill-registry";
import { isAgentCancellation, runAgentOperation } from "./agent-operation";
import { writingGuardMany } from "../writing/writing-guard";
import { deriveArgumentGraph } from "../claims/argument-graph";
import { buildAdversarialMemo } from "../claims/adversarial-memo";

function now() { return new Date().toISOString(); }
function textPaths(nodes: WorkspaceTreeNode[]): string[] { return nodes.flatMap((node) => node.type === "directory" ? textPaths(node.children) : node.kind === "text" ? [node.path] : []); }
function flattenOutline(items: OutlineItem[]): OutlineItem[] { return items.flatMap((item) => [item, ...flattenOutline(item.children)]); }

export class ReviewService {
  constructor(private readonly database: JsonDatabase, private readonly workspaces: WorkspaceService, private readonly skills: SkillRegistry, private readonly provider?: AgentProvider) {}

  async run(projectId: string, sourceOnly = false, requestSignal?: AbortSignal, pdfPageText: string[] = []): Promise<ReviewResponse> {
    if (!this.provider?.review) throw new ApiError(503, "agent_not_configured", "Set OPENAI_API_KEY to enable Review Agent");
    const project = this.workspaces.getProject(projectId);
    const compileRecord = this.database.snapshot().compileRecords.filter((record) => record.projectId === projectId && record.projectVersion === project.version && record.status === "success").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!compileRecord && !sourceOnly) throw new ApiError(409, "compile_required", "Compile the current project version or explicitly continue with a source-only review");
    const discoveredPaths = textPaths(await this.workspaces.tree(projectId)).filter((path) => path !== "memory.md");
    const paths = [project.mainDocument, ...discoveredPaths.filter((path) => path !== project.mainDocument)];
    const documents: Array<{ path: string; content: string; version: number }> = [];
    let contextBytes = 0;
    for (const path of paths) {
      const opened = await this.workspaces.readTextFile(projectId, path);
      const bytes = Buffer.byteLength(opened.content);
      if (contextBytes + bytes > 500_000) continue;
      contextBytes += bytes;
      documents.push({ path, content: opened.content, version: opened.file.version });
    }
    if (!documents.some((document) => document.path === project.mainDocument)) throw new ApiError(400, "review_main_missing", "The main document could not be included in the review snapshot");

    const boundedPageText = pdfPageText.slice(0, 20).map((text) => String(text).slice(0, 20_000));
    const createdAt = now();
    const snapshot: ReviewSnapshot = {
      id: `snapshot_${crypto.randomUUID()}`,
      projectId,
      projectVersion: project.version,
      mainDocument: project.mainDocument,
      skill: structuredClone(project.skill),
      ...(project.publicationTarget ? { publicationTarget: structuredClone(project.publicationTarget) } : {}),
      files: documents.map((document) => ({ path: document.path, version: document.version, digest: new Bun.CryptoHasher("sha256").update(document.content).digest("hex") })),
      sourceOnly: !compileRecord,
      createdAt,
      ...(compileRecord ? { compileRecordId: compileRecord.id } : {})
    };
    const run: AgentRun = {
      id: `run_${crypto.randomUUID()}`,
      projectId,
      type: "review",
      status: "running",
      objective: `Review project version ${project.version} for the ${project.skill.name} research domain and selected publication target`,
      skill: structuredClone(project.skill),
      ...(project.publicationTarget ? { publicationTarget: structuredClone(project.publicationTarget) } : {}),
      createdAt,
      updatedAt: createdAt,
      steps: [
        { id: "snapshot", label: "Read current workspace", status: "completed" },
        { id: "evidence", label: "Collect section evidence", status: "running" },
        { id: "synthesis", label: "Synthesize and deduplicate issues", status: "pending" }
      ],
    };
    await this.database.mutate((state) => { state.agentRuns.push(run); });
    const providerPasses: Record<string, { status: "completed" | "failed"; error?: string }> = {};
    try {
      const [outline, skill] = await Promise.all([this.workspaces.outline(projectId), this.skills.load(project.skill, project.publicationTarget)]);
      const result = await runAgentOperation<ReviewAgentOutput>(
        async (signal) => {
          const input = { documents: documents.map(({ path, content }) => ({ path, content })), outline: flattenOutline(outline).map(({ path, title, line }) => ({ path, title, line })), skill: project.skill, skillInstructions: skill.instructions, venueInstructions: skill.venueInstructions, ...(boundedPageText.length ? { pdfPageText: boundedPageText } : {}) };
          if (!this.provider!.reviewPass) { providerPasses.domain = { status: "completed" }; providerPasses.venue = { status: "completed" }; return this.provider!.review!(input, signal); }
          const results = await Promise.allSettled([this.provider!.reviewPass({ ...input, pass: "domain" }, signal), this.provider!.reviewPass({ ...input, pass: "venue" }, signal)]);
          providerPasses.domain = results[0]?.status === "fulfilled" ? { status: "completed" } : { status: "failed", error: results[0]?.reason instanceof Error ? results[0].reason.message : "Domain pass failed" };
          providerPasses.venue = results[1]?.status === "fulfilled" ? { status: "completed" } : { status: "failed", error: results[1]?.reason instanceof Error ? results[1].reason.message : "Venue pass failed" };
          const successful = results.filter((item): item is PromiseFulfilledResult<ReviewAgentOutput> => item.status === "fulfilled").map((item) => item.value);
          if (!successful.length) throw new Error("All Review provider passes failed");
          return { ...successful[0]!, issues: successful.flatMap((item) => item.issues), weaknesses: successful.flatMap((item) => item.weaknesses), nextSteps: successful.flatMap((item) => item.nextSteps) };
        },
        { signal: requestSignal, timeoutEnv: "FASTWRITE_REVIEW_TIMEOUT_MS", label: "Review", codePrefix: "review", cancelledMessage: "Review cancelled; no report was created", timeoutMessage: "Review timed out before a report was created" }
      );
      const reportId = `review_${crypto.randomUUID()}`;
      const available = new Map(documents.map((document) => [document.path, document.content]));
      const issues: ReviewIssue[] = result.issues.map((issue, index) => ({
        id: `issue_${crypto.randomUUID()}`,
        reportId,
        category: issue.category,
        severity: issue.severity,
        priority: severityPriority(issue.severity) * 100 + index,
        title: issue.title.trim(), rationale: issue.rationale.trim(), impact: issue.impact.trim(), suggestion: issue.suggestion.trim(),
        evidence: issue.evidence.map((evidence) => {
          const content = available.get(evidence.path);
          const excerpt = evidence.excerpt.trim().slice(0, 1_000);
          const offset = content?.indexOf(excerpt) ?? -1;
          return {
            ...(available.has(evidence.path) || !boundedPageText.length ? { path: available.has(evidence.path) ? evidence.path : project.mainDocument } : {}),
            ...(evidence.section ? { section: evidence.section } : {}),
            ...(offset >= 0 && content ? { line: content.slice(0, offset).split("\n").length } : evidence.line ? { line: evidence.line } : {}),
            excerpt,
            inferred: evidence.inferred || !content || (Boolean(excerpt) && offset < 0)
          };
        }),
        status: "open",
        createdAt: now(), updatedAt: now(), source: "agent",
        history: [{ id: `history_${crypto.randomUUID()}`, action: "created", reason: `Created by ${project.skill.name} Review Agent`, actor: "agent", createdAt: now() }]
      }));
      const evidenceIssues = citationEvidenceIssues(documents, reportId);
      const guardFindings = writingGuardMany(documents);
      const guardIssues: ReviewIssue[] = guardFindings.map((finding) => ({ id: `issue_${crypto.randomUUID()}`, reportId, category: "clarity" as const, severity: finding.status === "blocking" ? "blocking" as const : "minor" as const, priority: finding.status === "blocking" ? 100 : 300, title: finding.message, rationale: "Deterministic writing guard finding.", impact: "The manuscript may contain unverifiable or unresolved content.", suggestion: "Resolve the finding and rerun review.", evidence: [{ path: project.mainDocument, excerpt: finding.message, inferred: false }], status: "open" as const, createdAt: now(), updatedAt: now(), source: "agent" as const, history: [{ id: `history_${crypto.randomUUID()}`, action: "created" as const, reason: "Detected by deterministic writing guard", actor: "system" as const, createdAt: now() }] }));
      const ledger = this.database.snapshot().paperClaims.filter((claim) => claim.projectId === projectId);
      const memo = buildAdversarialMemo(projectId, ledger, deriveArgumentGraph(projectId, ledger));
      const adversarialIssues: ReviewIssue[] = memo.objections.map((objection) => ({ id: `issue_${crypto.randomUUID()}`, reportId, category: "clarity", severity: "minor", priority: 350, title: `Adversarial: ${objection.message}`, rationale: "Advisory objection generated from the current claim argument graph.", impact: "A reviewer may challenge this claim or relation.", suggestion: "Confirm the relation, add supporting evidence, or narrow the claim.", evidence: objection.anchorPaths.map((path) => ({ path, excerpt: "Claim anchor", inferred: false })), status: "open", createdAt: now(), updatedAt: now(), source: "agent", history: [{ id: `history_${crypto.randomUUID()}`, action: "created", reason: "Generated by adversarial preflight", actor: "system", createdAt: now() }] }));
      const synthesizedIssues = dedupeIssues([...evidenceIssues, ...guardIssues, ...adversarialIssues, ...issues]);
      const boundary = `${documents.length} files/${contextBytes} bytes${boundedPageText.length ? "+pdf-preview" : ""}`;
      const passCoverageIncomplete = Object.values(providerPasses).some((pass) => pass.status !== "completed");
      const report: ReviewReport = { id: reportId, projectId, agentRunId: run.id, snapshotId: snapshot.id, overallAssessment: passCoverageIncomplete ? `${result.overallAssessment.trim()} Review coverage is incomplete; inspect failed passes before treating this report as clean.` : result.overallAssessment, recommendation: passCoverageIncomplete ? "borderline" : result.recommendation, strengths: result.strengths, weaknesses: result.weaknesses, nextSteps: result.nextSteps, issues: synthesizedIssues, passes: [
        { id: "mechanical", status: "completed", issues: guardIssues.map((issue) => issue.id), provider: "writing-guard", inputBoundary: boundary },
        { id: "evidence", status: "completed", issues: evidenceIssues.map((issue) => issue.id), provider: "evidence-check", inputBoundary: boundary },
        { id: "argument", status: "completed", issues: [], provider: "argument-check", inputBoundary: boundary },
        { id: "domain", status: providerPasses.domain?.status ?? "failed", issues: issues.map((issue) => issue.id), provider: "review-agent", inputBoundary: boundary, ...(providerPasses.domain?.error ? { error: providerPasses.domain.error } : {}) },
        { id: "venue", status: providerPasses.venue?.status ?? "failed", issues: [], provider: "review-agent", inputBoundary: boundary, ...(providerPasses.venue?.error ? { error: providerPasses.venue.error } : {}) },
        { id: "adversarial", status: "completed", issues: adversarialIssues.map((issue) => issue.id), provider: "claim-adversary", inputBoundary: boundary },
        { id: "synthesis", status: "completed", issues: synthesizedIssues.map((issue) => issue.id), provider: "review-synthesis", inputBoundary: boundary }
      ], inputType: boundedPageText.length ? "pdf-preview" : "source", createdFromProjectVersion: project.version, createdAt: now() };
      const updatedRun = await this.database.mutate((state) => {
        state.reviewReports.push(report);
        const stored = state.agentRuns.find((item) => item.id === run.id)!;
        stored.status = "completed";
        stored.steps?.forEach((step) => { step.status = "completed"; });
        stored.updatedAt = now();
        return stored;
      });
      return { run: updatedRun, snapshot, report };
    } catch (error) {
      await this.database.mutate((state) => {
        const stored = state.agentRuns.find((item) => item.id === run.id);
        if (stored) { stored.status = isAgentCancellation(error) ? "cancelled" : "failed"; stored.error = error instanceof Error ? error.message : "Review failed"; stored.steps?.forEach((step) => { if (step.status === "running") step.status = "failed"; }); stored.updatedAt = now(); }
      });
      throw error instanceof ApiError ? error : new ApiError(502, "agent_failed", error instanceof Error ? error.message : "Review Agent failed");
    }
  }

  list(projectId: string): ReviewReport[] { const project = this.workspaces.getProject(projectId); return this.database.snapshot().reviewReports.filter((report) => report.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((report) => ({ ...report, stale: report.createdFromProjectVersion !== undefined ? report.createdFromProjectVersion !== project.version : false })); }

  updateIssue(projectId: string, issueId: string, updates: { status?: ReviewIssueStatus; priority?: number; reason?: string }): Promise<ReviewIssue> {
    if (updates.priority !== undefined && (!Number.isInteger(updates.priority) || updates.priority < 0 || updates.priority > 10_000)) throw new ApiError(400, "invalid_priority", "Issue priority must be an integer between 0 and 10,000");
    return this.database.mutate((state) => {
      const report = state.reviewReports.find((candidate) => candidate.projectId === projectId && candidate.issues.some((issue) => issue.id === issueId));
      const issue = report?.issues.find((candidate) => candidate.id === issueId);
      if (!issue) throw new ApiError(404, "review_issue_not_found", "Review issue not found");
      const timestamp = now();
      issue.history ??= [];
      if (updates.status && updates.status !== issue.status) {
        const allowed: Record<ReviewIssueStatus, ReviewIssueStatus[]> = { open: ["planned", "in_revision", "dismissed"], planned: ["in_revision", "dismissed"], in_revision: ["needs_review", "open"], needs_review: ["resolved", "open"], resolved: ["open"], dismissed: ["open"] };
        if (!allowed[issue.status].includes(updates.status)) throw new ApiError(409, "review_issue_transition_invalid", "Issue status requires a valid workflow transition");
        issue.status = updates.status; issue.history.push({ id: `history_${crypto.randomUUID()}`, action: "status", reason: updates.reason?.trim() || (updates.status === "dismissed" ? "Dismissed by user" : `Status changed to ${updates.status}`), actor: "user", createdAt: timestamp });
      }
      if (updates.priority !== undefined && updates.priority !== issue.priority) { issue.priority = updates.priority; issue.history.push({ id: `history_${crypto.randomUUID()}`, action: "priority", reason: updates.reason?.trim() || `Priority changed to ${updates.priority}`, actor: "user", createdAt: timestamp }); }
      issue.updatedAt = now();
      return issue;
    });
  }

  createIssue(projectId: string, input: Pick<ReviewIssue, "category" | "severity" | "title" | "rationale" | "impact" | "suggestion"> & { reportId?: string }): Promise<ReviewIssue> {
    const report = input.reportId ? this.database.snapshot().reviewReports.find((item) => item.id === input.reportId && item.projectId === projectId) : this.list(projectId)[0];
    if (!report) throw new ApiError(404, "review_report_not_found", "Run a Review before adding a manual issue");
    if (!input.title.trim() || !input.rationale.trim()) throw new ApiError(400, "review_issue_incomplete", "Issue title and rationale are required");
    const timestamp = now();
    const issue: ReviewIssue = { id: `issue_${crypto.randomUUID()}`, reportId: report.id, category: input.category, severity: input.severity, priority: severityPriority(input.severity) * 100 + report.issues.length, title: input.title.trim(), rationale: input.rationale.trim(), impact: input.impact.trim(), suggestion: input.suggestion.trim(), evidence: [], status: "open", source: "manual", createdAt: timestamp, updatedAt: timestamp, history: [{ id: `history_${crypto.randomUUID()}`, action: "created", reason: "Created manually", actor: "user", createdAt: timestamp }] };
    return this.database.mutate((state) => { state.reviewReports.find((item) => item.id === report.id)!.issues.push(issue); return issue; });
  }

  mergeIssues(projectId: string, masterId: string, duplicateIds: string[], reason = "Merged duplicate issues"): Promise<ReviewIssue> {
    return this.database.mutate((state) => {
      const issues = state.reviewReports.filter((report) => report.projectId === projectId).flatMap((report) => report.issues);
      const master = issues.find((issue) => issue.id === masterId);
      const duplicates = [...new Set(duplicateIds)].filter((id) => id !== masterId).map((id) => issues.find((issue) => issue.id === id));
      if (!master || duplicates.some((issue) => !issue)) throw new ApiError(404, "review_issue_not_found", "One or more issues were not found");
      const timestamp = now(); master.history ??= [];
      for (const duplicate of duplicates as ReviewIssue[]) { master.evidence.push(...duplicate.evidence.filter((evidence) => !master.evidence.some((current) => current.path === evidence.path && current.excerpt === evidence.excerpt))); duplicate.status = "dismissed"; duplicate.mergedIntoId = master.id; duplicate.updatedAt = timestamp; duplicate.history ??= []; duplicate.history.push({ id: `history_${crypto.randomUUID()}`, action: "merged", reason, actor: "user", createdAt: timestamp }); }
      master.history.push({ id: `history_${crypto.randomUUID()}`, action: "merged", reason: `${reason}: ${duplicates.length} duplicate(s)`, actor: "user", createdAt: timestamp }); master.updatedAt = timestamp; return master;
    });
  }
}


function severityPriority(severity: ReviewIssue["severity"]): number { return ({ blocking: 1, major: 2, minor: 3, suggestion: 4 })[severity]; }

function citationEvidenceIssues(documents: Array<{ path: string; content: string }>, reportId: string): ReviewIssue[] {
  const cited = new Set<string>();
  for (const document of documents) for (const match of document.content.matchAll(/\\(?:cite|citep|citet|parencite|textcite|autocite)\*?(?:\[[^\]]*\]){0,2}\{([^}]+)\}/g)) for (const key of (match[1] ?? "").split(",")) if (key.trim()) cited.add(key.trim());
  if (!cited.size) return [];
  const bibliography = new Set<string>();
  for (const document of documents) for (const match of document.content.matchAll(/@\w+\s*\{\s*([^,\s]+)/g)) bibliography.add(match[1]!);
  return [...cited].filter((key) => !bibliography.has(key)).map((key, index) => ({ id: `issue_${crypto.randomUUID()}`, reportId, category: "related-work", severity: "major", priority: 200 + index, title: `Citation '${key}' has no bibliography entry`, rationale: "The manuscript cites a key that cannot be resolved to a bibliography record.", impact: "Readers and automated checks cannot verify the cited source.", suggestion: `Add an approved bibliography entry for '${key}' or remove the citation.`, evidence: [], status: "open", createdAt: now(), updatedAt: now(), source: "agent", history: [{ id: `history_${crypto.randomUUID()}`, action: "created", reason: "Detected by deterministic evidence pass", actor: "system", createdAt: now() }] }));
}

function dedupeIssues(issues: ReviewIssue[]): ReviewIssue[] {
  const byKey = new Map<string, ReviewIssue>();
  for (const issue of issues) {
    const key = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const existing = byKey.get(key);
    if (!existing) byKey.set(key, issue);
    else { existing.evidence.push(...issue.evidence.filter((evidence) => !existing.evidence.some((item) => item.path === evidence.path && item.excerpt === evidence.excerpt))); existing.rationale = `${existing.rationale}\n${issue.rationale}`.trim(); }
  }
  return [...byKey.values()];
}
