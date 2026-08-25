import type { AgentRun, OutlineItem, ReviewIssue, ReviewIssueStatus, ReviewReport, ReviewResponse, ReviewSnapshot, WorkspaceTreeNode } from "@fastwrite/shared";
import { ApiError } from "../http";
import type { JsonDatabase } from "../storage/database";
import type { WorkspaceService } from "../workspace/workspace-service";
import type { AgentProvider, ReviewAgentOutput } from "./provider";
import type { SkillRegistry } from "./skill-registry";
import { isAgentCancellation, runAgentOperation } from "./agent-operation";

function now() { return new Date().toISOString(); }
function textPaths(nodes: WorkspaceTreeNode[]): string[] { return nodes.flatMap((node) => node.type === "directory" ? textPaths(node.children) : node.kind === "text" ? [node.path] : []); }
function flattenOutline(items: OutlineItem[]): OutlineItem[] { return items.flatMap((item) => [item, ...flattenOutline(item.children)]); }

export class ReviewService {
  constructor(private readonly database: JsonDatabase, private readonly workspaces: WorkspaceService, private readonly skills: SkillRegistry, private readonly provider?: AgentProvider) {}

  async run(projectId: string, sourceOnly = false, requestSignal?: AbortSignal): Promise<ReviewResponse> {
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
        { id: "snapshot", label: "Freeze paper snapshot", status: "completed" },
        { id: "evidence", label: "Collect section evidence", status: "running" },
        { id: "synthesis", label: "Synthesize and deduplicate issues", status: "pending" }
      ],
    };
    await this.database.mutate((state) => { state.reviewSnapshots.push(snapshot); state.agentRuns.push(run); });
    try {
      const [outline, skill] = await Promise.all([this.workspaces.outline(projectId), this.skills.load(project.skill, project.publicationTarget)]);
      const result = await runAgentOperation<ReviewAgentOutput>(
        (signal) => this.provider!.review!({ documents: documents.map(({ path, content }) => ({ path, content })), outline: flattenOutline(outline).map(({ path, title, line }) => ({ path, title, line })), skill: project.skill, skillInstructions: skill.instructions, venueInstructions: skill.venueInstructions }, signal),
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
            path: available.has(evidence.path) ? evidence.path : project.mainDocument,
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
      const report: ReviewReport = { id: reportId, projectId, agentRunId: run.id, snapshotId: snapshot.id, overallAssessment: result.overallAssessment, recommendation: result.recommendation, strengths: result.strengths, weaknesses: result.weaknesses, nextSteps: result.nextSteps, issues, createdAt: now() };
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

  list(projectId: string): ReviewReport[] { return this.database.snapshot().reviewReports.filter((report) => report.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }

  updateIssue(projectId: string, issueId: string, updates: { status?: ReviewIssueStatus; priority?: number; reason?: string }): Promise<ReviewIssue> {
    if (updates.priority !== undefined && (!Number.isInteger(updates.priority) || updates.priority < 0 || updates.priority > 10_000)) throw new ApiError(400, "invalid_priority", "Issue priority must be an integer between 0 and 10,000");
    return this.database.mutate((state) => {
      const report = state.reviewReports.find((candidate) => candidate.projectId === projectId && candidate.issues.some((issue) => issue.id === issueId));
      const issue = report?.issues.find((candidate) => candidate.id === issueId);
      if (!issue) throw new ApiError(404, "review_issue_not_found", "Review issue not found");
      const timestamp = now();
      issue.history ??= [];
      if (updates.status && updates.status !== issue.status) { issue.status = updates.status; issue.history.push({ id: `history_${crypto.randomUUID()}`, action: "status", reason: updates.reason?.trim() || `Status changed to ${updates.status}`, actor: "user", createdAt: timestamp }); }
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
