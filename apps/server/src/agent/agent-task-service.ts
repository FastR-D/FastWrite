import type { AgentRun, AgentTaskIntent, AgentTaskPlan, AgentTaskPlanResponse, AgentTaskRequest, ChangeSet, ComplianceFinding, IssueResolution, PaperClaim, ReviewIssue, TextChange, WorkspaceTreeNode } from "@fastwrite/shared";
import { isTextFile, normalizeWorkspacePath } from "@fastwrite/shared";
import { ApiError } from "../http";
import type { JsonDatabase } from "../storage/database";
import type { WorkspaceService } from "../workspace/workspace-service";
import type { AgentProvider, AgentTaskInput, AgentTaskIssue, AgentTaskPlanOutput, DraftGeneratedFile } from "./provider";
import type { MemoryService } from "./memory-service";
import type { SkillRegistry } from "./skill-registry";
import { createFileChange, replaceFileChange } from "./change-set";
import { preserveLatexComments, stripLatexComments } from "./latex-comments";
import { isAgentCancellation, runAgentOperation } from "./agent-operation";
import type { ComplianceService } from "../compliance/compliance-service";
import { citationFindings } from "./citation-findings";
import { writingGuard } from "../writing/writing-guard";

function now() { return new Date().toISOString(); }
function prioritizeContinueFiles(paths: string[], documents: Array<{ path: string; content: string }>, claims: PaperClaim[], issues: ReviewIssue[]): string[] {
  const scores = new Map(paths.map((path) => [path, 0]));
  for (const claim of claims) if (claim.reviewStatus !== "supported" || claim.anchorStatus !== "current") scores.set(claim.anchor.path, (scores.get(claim.anchor.path) ?? 0) + (claim.reviewStatus === "unsupported" ? 30 : 20));
  for (const issue of issues) for (const evidence of issue.evidence) if (evidence.path) scores.set(evidence.path, (scores.get(evidence.path) ?? 0) + 15);
  for (const document of documents) if (/\b(?:TODO|TBD|FIXME|to be completed)\b/i.test(document.content)) scores.set(document.path, (scores.get(document.path) ?? 0) + 25);
  return [...paths].sort((left, right) => (scores.get(right) ?? 0) - (scores.get(left) ?? 0));
}
function textPaths(nodes: WorkspaceTreeNode[]): string[] { return nodes.flatMap((node) => node.type === "directory" ? textPaths(node.children) : node.kind === "text" ? [node.path] : []); }

export class AgentTaskService {
  constructor(private readonly database: JsonDatabase, private readonly workspaces: WorkspaceService, private readonly skills: SkillRegistry, private readonly provider?: AgentProvider, private readonly memories?: MemoryService, private readonly reviewProvider?: AgentProvider, private readonly compliance?: ComplianceService) {}

  async plan(projectId: string, request: AgentTaskRequest, requestSignal?: AbortSignal): Promise<AgentTaskPlanResponse & { resolution?: IssueResolution }> {
    if (!this.provider?.planAgentTask) throw new ApiError(503, "agent_not_configured", "Set OPENAI_API_KEY to enable Agent tasks");
    if (!request.objective?.trim()) throw new ApiError(400, "agent_objective_missing", "Describe the revision objective");
    if (request.scope.type !== "project" && !request.scope.path) throw new ApiError(400, "agent_scope_missing", "File and section scopes require a path");
    const project = this.workspaces.getProject(projectId);
    if (request.scope.path && !await this.workspaces.fileExists(projectId, request.scope.path)) throw new ApiError(404, "agent_scope_not_found", "The scoped file does not exist");
    const documents = await this.documents(projectId);
    const visibleDocuments = agentVisibleDocuments(documents);
    const commandIntent = parseIntentCommand(request.objective);
    const objective = stripIntentCommand(request.objective);
    if (!objective) throw new ApiError(400, "agent_objective_missing", "Describe the drafting or revision objective after the command");
    const intent = request.intent ?? commandIntent ?? classifyAgentIntent(objective, visibleDocuments);
    const normalizedRequest: AgentTaskRequest = { ...request, objective, intent };
    const issues = this.issues(projectId, request.issueIds ?? []);
    const skill = await this.skills.load(project.skill, project.publicationTarget);
    const memory = this.memories ? await this.memories.fullAgentContext(projectId) : { content: "" };
    const complianceFindings = project.publicationTarget && this.compliance ? (await this.compliance.check(projectId, { verifyCitationsOnline: false })).findings : [];
    const input = this.input(normalizedRequest, visibleDocuments, issues, project.skill, withMemory(skill.instructions, memory.content), skill.venueInstructions, complianceFindings);
    const createdAt = now();
    const searchMatches = searchDocumentPaths(visibleDocuments, objective);
    const run: AgentRun = { id: `run_${crypto.randomUUID()}`, projectId, type: "agent", status: "running", objective, skill: structuredClone(project.skill), ...(project.publicationTarget ? { publicationTarget: structuredClone(project.publicationTarget) } : {}), createdAt, updatedAt: createdAt, auditTrail: [
      { id: `audit_${crypto.randomUUID()}`, action: "context-read", summary: `Read ${documents.length} project source files within the context budget; LaTeX comments were omitted from Agent context`, paths: documents.map((document) => document.path), createdAt },
      { id: `audit_${crypto.randomUUID()}`, action: "context-search", summary: `Searched indexed source context; ${searchMatches.length} files matched objective terms`, ...(searchMatches.length ? { paths: searchMatches } : {}), createdAt }
    ], ...(memory.version ? { memoryVersion: memory.version } : {}) };
    await this.database.mutate((state) => state.agentRuns.push(run));
    try {
      const rawOutput: unknown = await runAgentOperation((signal) => this.provider!.planAgentTask!(input, signal), { signal: requestSignal, label: "Agent planning" });
      const available = new Set(documents.map((document) => document.path));
      const permitsNewFiles = intent === "draft" || intent === "continue" || isStructuralFileOrganizationObjective(objective);
      const allowedPath = (path: string) => (request.scope.type !== "project" || isProjectWritingSource(path)) && (available.has(path) || (permitsNewFiles && request.scope.type === "project" && isNewDraftPath(path)));
      const output = normalizeAgentPlanOutput(rawOutput, request.scope.path ?? project.mainDocument, allowedPath, intent);
      output.venueChecks = mergeComplianceChecks(output.venueChecks ?? [], complianceFindings);
      const affectedFiles = intent === "continue" ? prioritizeContinueFiles(output.affectedFiles, documents, this.database.snapshot().paperClaims.filter((claim) => claim.projectId === projectId), this.database.snapshot().reviewReports.filter((report) => report.projectId === projectId).flatMap((report) => report.issues.filter((issue) => issue.status !== "resolved" && issue.status !== "dismissed"))) : output.affectedFiles;
      if (!affectedFiles.length || affectedFiles.some((path) => !allowedPath(path)) || (request.scope.type === "file" && affectedFiles.some((path) => path !== request.scope.path))) throw new ApiError(502, "agent_plan_invalid", "Agent returned files outside the requested scope");
      const sectionContracts = request.scope.path ? [{ path: request.scope.path, purpose: objective, requiredClaimIds: (output.evidenceDependencies ?? []).flatMap((item) => item.requiredClaimIds), allowedEvidenceIds: [], requiredTablesOrFigures: [], terminology: [], openQuestions: output.missingEvidence ?? [] }] : undefined;
      const plan: AgentTaskPlan = { id: `agent_plan_${crypto.randomUUID()}`, projectId, agentRunId: run.id, status: "proposed", request: { objective, scope: request.scope, intent, ...(issues.length ? { issueIds: issues.map((issue) => issue.id) } : {}) }, intent, steps: output.steps, affectedFiles, risks: output.risks, validation: output.validation, ...(sectionContracts ? { sectionContracts } : {}), ...(output.sectionBudget ? { sectionBudget: output.sectionBudget } : {}), ...(output.venueChecks ? { venueChecks: output.venueChecks } : {}), ...(output.evidenceDependencies ? { evidenceDependencies: output.evidenceDependencies } : {}), ...(output.missingEvidence ? { missingEvidence: output.missingEvidence } : {}), createdAt, updatedAt: now() };
      const reports = this.database.snapshot().reviewReports.filter((report) => report.projectId === projectId);
      const reviewSnapshotIds = [...new Set(issues.flatMap((issue) => reports.find((report) => report.issues.some((candidate) => candidate.id === issue.id))?.snapshotId ?? []))];
      const resolution: IssueResolution | undefined = issues.length ? {
        id: `resolution_${crypto.randomUUID()}`,
        projectId,
        issueIds: issues.map((issue) => issue.id),
        reviewSnapshotIds,
        agentRunId: run.id,
        baseProjectVersion: project.version,
        ...(memory.version ? { memoryVersion: memory.version } : {}),
        skill: structuredClone(project.skill),
        ...(project.publicationTarget ? { publicationTarget: structuredClone(project.publicationTarget) } : {}),
        status: "planned",
        createdAt,
        updatedAt: now()
      } : undefined;
      const updatedRun = await this.database.mutate((state) => {
        state.agentTaskPlans.push(plan);
        if (resolution) state.issueResolutions.push(resolution);
        for (const issue of issues) this.mutateIssue(state.reviewReports.flatMap((report) => report.issues), issue.id, "planned");
        const stored = state.agentRuns.find((item) => item.id === run.id)!; stored.status = "waiting-approval"; stored.steps = output.steps.map((label, index) => ({ id: `step-${index + 1}`, label, status: "pending" })); stored.auditTrail?.push({ id: `audit_${crypto.randomUUID()}`, action: "plan-created", summary: `Planned ${output.steps.length} steps affecting ${affectedFiles.length} files`, paths: affectedFiles, createdAt: now() }); stored.updatedAt = now(); return stored;
      });
      return { run: updatedRun, plan, ...(resolution ? { resolution } : {}) };
    } catch (error) { await this.fail(run.id, error); throw error instanceof ApiError ? error : new ApiError(502, "agent_failed", error instanceof Error ? error.message : "Agent planning failed"); }
  }

  async confirm(projectId: string, planId: string, requestSignal?: AbortSignal): Promise<AgentTaskPlanResponse & { changeSet: ChangeSet; resolution?: IssueResolution }> {
    if (!this.provider?.generateAgentTask) throw new ApiError(503, "agent_not_configured", "Set OPENAI_API_KEY to enable Agent tasks");
    const plan = this.getPlan(projectId, planId);
    if (plan.status !== "proposed") throw new ApiError(409, "agent_plan_not_proposed", "This plan is no longer awaiting confirmation");
    if (plan.request.scope.type === "project") plan.affectedFiles = plan.affectedFiles.filter(isProjectWritingSource);
    if (!plan.affectedFiles.length) throw new ApiError(502, "agent_plan_invalid", "Agent plan does not contain any writable paper source files");
    const project = this.workspaces.getProject(projectId);
    const documents = await this.documents(projectId);
    for (const path of plan.affectedFiles) {
      if (documents.some((document) => document.path === path) || !await this.workspaces.fileExists(projectId, path)) continue;
      const opened = await this.workspaces.readTextFile(projectId, path);
      documents.push({ path, content: opened.content, version: opened.file.version });
    }
    const issues = this.issues(projectId, plan.request.issueIds ?? []);
    const plannedRun = this.database.snapshot().agentRuns.find((run) => run.id === plan.agentRunId);
    const plannedSkill = plannedRun?.skill ?? project.skill;
    const plannedTarget = plannedRun?.publicationTarget;
    const skill = await this.skills.load(plannedSkill, plannedTarget);
    const memory = this.memories ? await this.memories.fullAgentContext(projectId) : { content: "" };
    const visibleDocuments = agentVisibleDocuments(documents);
    const input = this.input(plan.request, visibleDocuments, issues, plannedSkill, withMemory(skill.instructions, memory.content), skill.venueInstructions);
    const generationConcurrency = this.provider.fileGenerationConcurrency?.() ?? plan.affectedFiles.length;
    const generationMode = generationConcurrency <= 1 ? "sequentially" : "in parallel";
    await this.database.mutate((state) => { const stored = state.agentTaskPlans.find((item) => item.id === planId)!; stored.status = "generating"; stored.affectedFiles = [...plan.affectedFiles]; stored.updatedAt = now(); const run = state.agentRuns.find((item) => item.id === plan.agentRunId)!; run.status = "running"; delete run.error; run.steps = plan.affectedFiles.map((path, index) => ({ id: `generate-file-${index + 1}`, label: executionStepLabel(path), status: "running" })); run.auditTrail ??= []; run.auditTrail.push({ id: `audit_${crypto.randomUUID()}`, action: "execution-started", summary: `Started checking scoped context and updating ${plan.affectedFiles.length} planned files ${generationMode}`, paths: plan.affectedFiles, createdAt: now() }); for (const issue of issues) this.mutateIssue(state.reviewReports.flatMap((report) => report.issues), issue.id, "in_revision"); const resolution = state.issueResolutions.find((item) => item.agentRunId === run.id); if (resolution) { resolution.status = "in-revision"; resolution.updatedAt = now(); } });
    try {
      const generated = await mapWithConcurrency(plan.affectedFiles, generationConcurrency, async (path, index) => {
        const scopedDocuments = generationDocuments(visibleDocuments, path, project.mainDocument, issues, plan.request.objective);
        const output = await runAgentOperation<{ files?: DraftGeneratedFile[] }>((signal) => this.provider!.generateAgentTask!({ ...input, documents: scopedDocuments, steps: plan.steps, affectedFiles: [path], targetPath: path, risks: plan.risks, validation: plan.validation, sectionBudget: plan.sectionBudget ?? [], venueChecks: plan.venueChecks ?? [], evidenceDependencies: plan.evidenceDependencies ?? [], missingEvidence: plan.missingEvidence ?? [] }, signal), { signal: requestSignal, defaultTimeoutMs: 300_000, label: `Agent execution for ${path}` });
        const files = this.validateGeneratedFiles(Array.isArray(output?.files) ? output.files : [], path);
        await this.database.mutate((state) => {
          const run = state.agentRuns.find((item) => item.id === plan.agentRunId)!;
          const current = run.steps?.[index];
          if (current) current.status = "completed";
          run.auditTrail ??= [];
          run.auditTrail.push({ id: `audit_${crypto.randomUUID()}`, action: "generation-progress", summary: `Checked scoped context and updated file ${index + 1} of ${plan.affectedFiles.length}: ${path}`, paths: [path], createdAt: now() });
          run.updatedAt = now();
        });
        return { targetPath: path, files };
      });
      const files = mergeGeneratedFiles(generated, plan.affectedFiles);
      const changes: TextChange[] = [];
      for (const file of files) {
        const snapshot = documents.find((document) => document.path === file.path);
        if (snapshot) {
          const opened = await this.workspaces.readTextFile(projectId, file.path);
          if (opened.file.version !== snapshot.version || opened.content !== snapshot.content) throw new ApiError(409, "agent_workspace_changed", `The workspace file '${file.path}' changed during generation; create a fresh plan before applying Agent output`);
          file.content = preserveLatexComments(snapshot.content, file.content);
          changes.push(replaceFileChange(file.path, opened, file.content));
        } else {
          if (await this.workspaces.fileExists(projectId, file.path)) throw new ApiError(409, "agent_workspace_changed", `The planned new file '${file.path}' was created during generation; create a fresh plan before applying Agent output`);
          changes.push(createFileChange(file.path, file.content));
        }
      }
      for (const change of changes) {
        const file = files.find((candidate) => candidate.path === change.path);
        const sameFileIssues = issues.filter((issue) => issue.evidence.some((evidence) => evidence.path === change.path));
        const linkedIssues = sameFileIssues.length ? sameFileIssues : issues;
        for (const hunk of change.hunks ?? []) {
          if (file?.rationale) hunk.rationale = file.rationale;
          const evidence = linkedIssues.flatMap((issue) => issue.evidence.map((item) => ({
            issueId: issue.id,
            issueTitle: issue.title,
            path: item.path ?? project.mainDocument,
            ...(item.line ? { line: item.line } : {}),
            excerpt: item.excerpt,
            inferred: item.inferred
          })));
          if (evidence.length) hunk.evidence = evidence;
          const approved = new Set(this.database.snapshot().projectResearchWorks.filter((item) => item.projectId === projectId && item.status === "saved" && item.citationKey).map((item) => item.citationKey!));
          const findings = citationFindings(hunk.after, approved);
          const qualityFindings = writingGuard({ path: change.path, content: hunk.after, approvedCitationKeys: approved });
          if (findings.length || qualityFindings.length) hunk.findings = [...findings, ...qualityFindings];
        }
      }
      const claimById = new Map(this.database.snapshot().paperClaims.filter((claim) => claim.projectId === projectId).map((claim) => [claim.id, claim]));
      const generatedText = files.map((file) => file.content).join("\n");
      for (const dependency of plan.evidenceDependencies ?? []) for (const claimId of dependency.requiredClaimIds ?? []) {
        const claim = claimById.get(claimId);
        if (!claim || !generatedText.includes(claim.anchor.exactText)) {
          const target = changes.flatMap((change) => change.hunks ?? [])[0];
          if (target) { target.findings ??= []; target.findings.push({ id: `evidence_dependency_${claimId}`, source: "claim", status: "unresolved", referenceId: claimId, message: `Required claim '${claim?.anchor.exactText.slice(0, 80) ?? claimId}' was not verified in generated output.` }); }
        }
      }
      const effectiveChanges = changes.filter((change) => change.hunks?.length);
      if (!effectiveChanges.length) throw new ApiError(502, "agent_no_changes", "Agent did not propose any file changes");
      const changeSet: ChangeSet = { id: `change_${crypto.randomUUID()}`, projectId, agentRunId: plan.agentRunId, status: "proposed", approvalMode: "explicit-finish", summary: plan.request.objective, rationale: files.map((file) => `${file.path}: ${file.rationale}`).join("\n"), changes: effectiveChanges, createdAt: now(), updatedAt: now() };
      const result = await this.database.mutate((state) => { state.changeSets.push(changeSet); const stored = state.agentTaskPlans.find((item) => item.id === planId)!; stored.status = "waiting-approval"; stored.changeSetId = changeSet.id; stored.updatedAt = now(); const run = state.agentRuns.find((item) => item.id === plan.agentRunId)!; run.status = "waiting-approval"; run.changeSetId = changeSet.id; run.steps?.forEach((step) => { step.status = "completed"; }); run.auditTrail ??= []; run.auditTrail.push({ id: `audit_${crypto.randomUUID()}`, action: "changes-proposed", summary: `Proposed ${effectiveChanges.flatMap((change) => change.hunks ?? []).length} hunks across ${effectiveChanges.length} files`, paths: effectiveChanges.map((change) => change.path), createdAt: now() }); run.updatedAt = now(); const resolution = state.issueResolutions.find((item) => item.agentRunId === run.id); if (resolution) { resolution.changeSetId = changeSet.id; resolution.updatedAt = now(); } return { run, plan: stored, resolution }; });
      return { run: result.run, plan: result.plan, changeSet, ...(result.resolution ? { resolution: result.resolution } : {}) };
    } catch (error) { await this.fail(plan.agentRunId, error); throw error instanceof ApiError ? error : new ApiError(502, "agent_failed", error instanceof Error ? error.message : "Agent generation failed"); }
  }

  async rereview(projectId: string, resolutionId: string, requestSignal?: AbortSignal): Promise<IssueResolution> {
    const provider = this.reviewProvider ?? this.provider;
    if (!provider?.rereviewIssues) throw new ApiError(503, "agent_not_configured", "Set OPENAI_API_KEY to enable targeted re-review");
    const resolution = this.database.snapshot().issueResolutions.find((item) => item.id === resolutionId && item.projectId === projectId);
    if (!resolution) throw new ApiError(404, "resolution_not_found", "Issue resolution not found");
    if (resolution.status !== "needs-review" && resolution.status !== "reopened") throw new ApiError(409, "resolution_not_reviewable", "Accept the revision before targeted re-review");
    const project = this.workspaces.getProject(projectId); const documents = await this.documents(projectId); const issues = this.issues(projectId, resolution.issueIds); const skill = await this.skills.load(resolution.skill, resolution.publicationTarget);
    const compileRecord = this.database.snapshot().compileRecords.filter((record) => record.projectId === projectId && record.projectVersion === project.version && record.status === "success").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!compileRecord) throw new ApiError(409, "compile_required", "Compile the current project version successfully before targeted re-review");
    const input = { ...this.input({ objective: "Verify selected review issues", scope: { type: "project" }, issueIds: resolution.issueIds }, documents, issues, resolution.skill, skill.instructions, skill.venueInstructions), issues: issues.map(toAgentIssue) };
    const output = await runAgentOperation<{ assessments: Array<{ issueId: string; resolved: boolean; assessment: string }>; regressions: string[] }>((signal) => provider.rereviewIssues!(input, signal), { signal: requestSignal, label: "Targeted re-review" });
    const byIssue = new Map(output.assessments.map((assessment) => [assessment.issueId, assessment]));
    if (byIssue.size !== issues.length || issues.some((issue) => !byIssue.has(issue.id))) throw new ApiError(502, "rereview_output_invalid", "Targeted re-review must return one conclusion for every issue");
    const allResolved = issues.every((issue) => byIssue.get(issue.id)!.resolved) && !output.regressions.length;
    return this.database.mutate((state) => {
      const stored = state.issueResolutions.find((item) => item.id === resolutionId)!;
      stored.status = allResolved ? "resolved" : "reopened";
      stored.compileRecordId = compileRecord.id;
      stored.issueAssessments = issues.map((issue) => byIssue.get(issue.id)!);
      stored.rereviewAssessment = stored.issueAssessments.map((assessment) => `${assessment.resolved ? "Resolved" : "Open"} · ${assessment.assessment}`).join("\n");
      stored.regressions = output.regressions;
      stored.updatedAt = now();
      for (const issue of issues) this.mutateIssue(state.reviewReports.flatMap((report) => report.issues), issue.id, !output.regressions.length && byIssue.get(issue.id)!.resolved ? "resolved" : "open");
      return stored;
    });
  }

  reopen(projectId: string, resolutionId: string): Promise<IssueResolution> {
    const resolution = this.database.snapshot().issueResolutions.find((item) => item.id === resolutionId && item.projectId === projectId);
    if (!resolution) throw new ApiError(404, "resolution_not_found", "Issue resolution not found");
    if (resolution.status !== "resolved") throw new ApiError(409, "resolution_not_resolved", "Only a resolved issue can be reopened");
    return this.database.mutate((state) => {
      const stored = state.issueResolutions.find((item) => item.id === resolutionId)!;
      stored.status = "reopened";
      stored.updatedAt = now();
      for (const issue of state.reviewReports.flatMap((report) => report.issues)) if (stored.issueIds.includes(issue.id)) this.mutateIssue(state.reviewReports.flatMap((report) => report.issues), issue.id, "open");
      return stored;
    });
  }

  cancel(projectId: string, planId: string): Promise<AgentTaskPlan> {
    const plan = this.getPlan(projectId, planId);
    if (plan.status !== "proposed") throw new ApiError(409, "agent_plan_not_cancellable", "Only a plan awaiting confirmation can be cancelled");
    return this.database.mutate((state) => {
      const stored = state.agentTaskPlans.find((item) => item.id === planId)!;
      stored.status = "cancelled";
      stored.updatedAt = now();
      const run = state.agentRuns.find((item) => item.id === stored.agentRunId);
      if (run) { run.status = "cancelled"; run.updatedAt = now(); }
      const resolution = state.issueResolutions.find((item) => item.agentRunId === stored.agentRunId);
      if (resolution) {
        resolution.status = "reopened";
        resolution.updatedAt = now();
        for (const issue of state.reviewReports.flatMap((report) => report.issues)) if (resolution.issueIds.includes(issue.id)) { issue.status = "open"; issue.updatedAt = now(); }
      }
      return stored;
    });
  }

  list(projectId: string) { return this.database.snapshot().agentTaskPlans.filter((plan) => plan.projectId === projectId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  resolutions(projectId: string) { return this.database.snapshot().issueResolutions.filter((resolution) => resolution.projectId === projectId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }

  private async documents(projectId: string) { const paths = textPaths(await this.workspaces.tree(projectId)).filter((path) => path !== "memory.md"); const documents: Array<{ path: string; content: string; version: number }> = []; let bytes = 0; for (const path of paths) { const opened = await this.workspaces.readTextFile(projectId, path); const size = Buffer.byteLength(opened.content); if (bytes + size > 500_000) continue; bytes += size; documents.push({ path, content: opened.content, version: opened.file.version }); } return documents; }
  private issues(projectId: string, ids: string[]): ReviewIssue[] { const all = this.database.snapshot().reviewReports.filter((report) => report.projectId === projectId).flatMap((report) => report.issues); const issues = ids.map((id) => all.find((issue) => issue.id === id)).filter((issue): issue is ReviewIssue => Boolean(issue)); if (issues.length !== new Set(ids).size) throw new ApiError(404, "review_issue_not_found", "One or more review issues were not found"); return issues; }
  private input(request: AgentTaskRequest, documents: Array<{ path: string; content: string; version: number }>, issues: ReviewIssue[], skill: AgentTaskInput["skill"], skillInstructions: string, venueInstructions: string, complianceFindings: ComplianceFinding[] = []): AgentTaskInput { return { objective: request.objective.trim(), intent: request.intent ?? "revise", scope: request.scope, issues: issues.map(toAgentIssue), documents, skill, skillInstructions, venueInstructions, ...(complianceFindings.length ? { complianceFindings } : {}) }; }
  private getPlan(projectId: string, id: string) { const plan = this.database.snapshot().agentTaskPlans.find((item) => item.id === id && item.projectId === projectId); if (!plan) throw new ApiError(404, "agent_plan_not_found", "Agent plan not found"); return plan; }
  private validateGeneratedFiles(files: DraftGeneratedFile[], targetPath: string) {
    const normalized = files.flatMap((file) => {
      try {
        const path = normalizeWorkspacePath(file.path);
        return path === targetPath && isTextFile(path) && file.content.trim() ? [{ ...file, path }] : [];
      } catch {
        return [];
      }
    });
    if (normalized.length !== 1) throw new ApiError(502, "agent_files_invalid", `Agent must return exactly one non-empty file for '${targetPath}'`);
    return normalized;
  }
  private mutateIssue(issues: ReviewIssue[], id: string, status: ReviewIssue["status"]) { const issue = issues.find((item) => item.id === id); if (issue) { issue.status = status; issue.updatedAt = now(); } }
  private fail(runId: string, error: unknown) { return this.database.mutate((state) => {
    const run = state.agentRuns.find((item) => item.id === runId);
    const cancelled = isAgentCancellation(error);
    if (run) { run.status = cancelled ? "cancelled" : "failed"; run.error = error instanceof Error ? error.message : "Agent failed"; run.steps?.forEach((step) => { if (step.status === "running") step.status = "failed"; }); run.updatedAt = now(); }
    const plan = state.agentTaskPlans.find((item) => item.agentRunId === runId && item.status === "generating");
    if (plan) {
      plan.status = "proposed";
      plan.updatedAt = now();
      const resolution = state.issueResolutions.find((item) => item.agentRunId === runId);
      if (resolution) {
        resolution.status = "planned";
        resolution.updatedAt = now();
        for (const issueId of resolution.issueIds) this.mutateIssue(state.reviewReports.flatMap((report) => report.issues), issueId, "planned");
      }
    }
  }); }
}

function toAgentIssue(issue: ReviewIssue): AgentTaskIssue { return { id: issue.id, title: issue.title, rationale: issue.rationale, suggestion: issue.suggestion, evidence: issue.evidence.filter((evidence) => evidence.path).map((evidence) => ({ path: evidence.path!, excerpt: evidence.excerpt })) }; }
function withMemory(skill: string, memory: string) { return memory ? `${skill}\n\nConfirmed Paper Memory (treat as project facts):\n${memory}` : skill; }

function agentVisibleDocuments<T extends { path: string; content: string }>(documents: T[]): T[] {
  return documents.map((document) => /\.(?:tex|bib|sty|cls)$/i.test(document.path) ? { ...document, content: stripLatexComments(document.content) } : document);
}

function executionStepLabel(path: string): string {
  return `Process ${path}`;
}

async function mapWithConcurrency<T, R>(items: T[], requestedConcurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!items.length) return [];
  const concurrency = Math.max(1, Math.min(items.length, Number.isFinite(requestedConcurrency) ? Math.floor(requestedConcurrency) : 1));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]!, index);
    }
  }));
  return results;
}

function mergeGeneratedFiles(generated: Array<{ targetPath: string; files: DraftGeneratedFile[] }>, affectedFiles: string[]): DraftGeneratedFile[] {
  const byTarget = new Map(generated.map((result) => [result.targetPath, result.files]));
  const allFiles = generated.flatMap((result) => result.files);
  return affectedFiles.map((path) => byTarget.get(path)?.find((file) => file.path === path) ?? allFiles.find((file) => file.path === path)).filter((file): file is DraftGeneratedFile => Boolean(file));
}

function generationDocuments(
  documents: Array<{ path: string; content: string; version: number }>,
  targetPath: string,
  mainDocument: string,
  issues: ReviewIssue[],
  objective: string
): Array<{ path: string; content: string; version: number }> {
  const priority = [
    targetPath,
    mainDocument,
    ...issues.flatMap((issue) => issue.evidence.map((evidence) => evidence.path).filter((path): path is string => Boolean(path))),
    ...searchDocumentPaths(documents, objective)
  ];
  const selected: Array<{ path: string; content: string; version: number }> = [];
  const seen = new Set<string>();
  let supportingBytes = 0;
  for (const path of priority) {
    if (seen.has(path)) continue;
    seen.add(path);
    const document = documents.find((candidate) => candidate.path === path);
    if (!document) continue;
    if (path === targetPath) {
      selected.push(document);
      continue;
    }
    const bytes = Buffer.byteLength(document.content);
    if (supportingBytes + bytes > 120_000) continue;
    supportingBytes += bytes;
    selected.push(document);
  }
  return selected;
}

function searchDocumentPaths(documents: Array<{ path: string; content: string }>, objective: string): string[] {
  const ignored = new Set(["about", "after", "before", "change", "paper", "revise", "section", "update", "with"]);
  const terms = [...new Set(objective.toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) ?? [])].filter((term) => !ignored.has(term)).slice(0, 12);
  if (!terms.length) return [];
  return documents.filter((document) => {
    const haystack = `${document.path}\n${document.content}`.toLowerCase();
    return terms.some((term) => haystack.includes(term));
  }).map((document) => document.path);
}

function stripIntentCommand(objective: string): string {
  return objective.trim().replace(/^\/(?:draft|continue|revise)\b\s*/i, "").trim();
}

function parseIntentCommand(objective: string): AgentTaskIntent | undefined {
  const intent = objective.trim().match(/^\/(draft|continue|revise)\b/i)?.[1]?.toLowerCase();
  return intent === "draft" || intent === "continue" || intent === "revise" ? intent : undefined;
}

function classifyAgentIntent(objective: string, documents: Array<{ path: string; content: string }>): AgentTaskIntent {
  const source = documents.map((document) => document.content).join("\n");
  const prose = source.replace(/\\(?:documentclass|usepackage|begin|end|input|include)\b[^\n]*/g, "").replace(/\s+/g, " ").trim();
  if (prose.length < 500) return "draft";
  if (/\b(?:TODO|TBD|FIXME|placeholder|to be completed)\b/i.test(source)) return "continue";
  return "revise";
}

function isNewDraftPath(path: string): boolean {
  return /^(?!\.)(?!.*(?:^|\/)\.\.\/)[a-zA-Z0-9_./-]+\.(?:tex|bib)$/.test(path);
}

function isProjectWritingSource(path: string): boolean {
  return /\.(?:tex|bib)$/i.test(path);
}

function isStructuralFileOrganizationObjective(objective: string): boolean {
  const normalized = objective.toLowerCase();
  return /拆分|分章节|分文件|拆成|章节|split|chapter|section files?|modulari[sz]e|extract.*(?:section|chapter|file)|move.*(?:section|chapter).*file/.test(normalized);
}

function normalizeAgentPlanOutput(raw: unknown, fallbackPath: string, allowedPath: (path: string) => boolean, intent: AgentTaskIntent): AgentTaskPlanOutput {
  const output = isRecord(raw) ? raw : {};
  const steps = stringList(output.steps);
  const risks = stringList(output.risks);
  const validation = stringList(output.validation);
  const sectionBudget = recordList(output.sectionBudget).flatMap((item) => {
    if (typeof item.section !== "string" || typeof item.purpose !== "string") return [];
    const targetPages = typeof item.targetPages === "number" && Number.isFinite(item.targetPages) && item.targetPages > 0 ? item.targetPages : undefined;
    return [{ section: item.section.trim(), purpose: item.purpose.trim(), ...(targetPages ? { targetPages } : {}) }];
  });
  const allowedStatuses = new Set(["satisfied", "missing", "uncertain", "not-applicable"]);
  const venueChecks = recordList(output.venueChecks).flatMap((item) => {
    if (typeof item.requirement !== "string" || typeof item.action !== "string" || typeof item.status !== "string" || !allowedStatuses.has(item.status)) return [];
    return [{ requirement: item.requirement.trim(), action: item.action.trim(), status: item.status as "satisfied" | "missing" | "uncertain" | "not-applicable", evidencePaths: stringList(item.evidencePaths) }];
  });
  const evidenceDependencies = recordList(output.evidenceDependencies).flatMap((item) => {
    if (typeof item.step !== "string") return [];
    return [{ step: item.step.trim(), requiredClaimIds: stringList(item.requiredClaimIds), missingEvidence: stringList(item.missingEvidence) }];
  });
  const missingEvidence = stringList(output.missingEvidence);
  const affectedFiles: string[] = [];
  for (const candidate of stringList(output.affectedFiles)) {
    try {
      const path = normalizeWorkspacePath(candidate);
      if (allowedPath(path) && !affectedFiles.includes(path)) affectedFiles.push(path);
    } catch {
      // Ignore malformed model paths and retain the bounded fallback below.
    }
  }
  if (!affectedFiles.length) affectedFiles.push(normalizeWorkspacePath(fallbackPath));
  return {
    steps: steps.length ? steps : [`Prepare the requested ${intent} changes in ${affectedFiles.join(", ")}`],
    affectedFiles,
    risks,
    validation: validation.length ? validation : ["Compile the resulting paper", "Review every proposed file before accepting"],
    sectionBudget,
    venueChecks,
    ...(evidenceDependencies.length ? { evidenceDependencies } : {}),
    ...(missingEvidence.length ? { missingEvidence } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [];
}

function mergeComplianceChecks(existing: NonNullable<AgentTaskPlanOutput["venueChecks"]>, findings: ComplianceFinding[]): NonNullable<AgentTaskPlanOutput["venueChecks"]> {
  const merged = [...existing];
  const requirements = new Set(merged.map((check) => check.requirement));
  for (const finding of findings) {
    const requirement = `[${finding.category}] ${finding.message}`;
    if (requirements.has(requirement)) continue;
    requirements.add(requirement);
    merged.push({
      requirement,
      status: finding.status === "pass" ? "satisfied" : finding.status === "error" ? "missing" : "uncertain",
      evidencePaths: finding.path ? [finding.path] : [],
      action: finding.status === "pass" ? "Keep this constraint satisfied." : finding.status === "error" ? "Resolve this blocking compliance finding before submission." : "Verify this item against the rendered PDF or live official author guide."
    });
  }
  return merged;
}

function recordList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
