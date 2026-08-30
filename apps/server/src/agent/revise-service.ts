import type {
  AgentRun,
  ChangeSetConflictFile,
  ChangeSetEditRequest,
  ChangeSetDecisionRequest,
  ChangeSet,
  OutlineItem,
  ReviseCommandId,
  ReviseRequest,
  ReviseResponse,
  TextChange,
  TextHunk
} from "@fastwrite/shared";
import { buildTextHunks, materializeTextHunks } from "@fastwrite/shared";
import { ApiError } from "../http";
import type { JsonDatabase } from "../storage/database";
import type { WorkspaceService } from "../workspace/workspace-service";
import type { AgentProvider, ReviseAgentInput } from "./provider";
import type { SkillRegistry } from "./skill-registry";
import type { MemoryService } from "./memory-service";
import { replaceSelectionChange } from "./change-set";
import { citationFindings, normalizePlaceholderFindings } from "./citation-findings";

const COMMANDS: Record<ReviseCommandId, string> = {
  "academic-polish": "Polish this selection into precise, fluent academic prose without strengthening its claims.",
  "logic-check": "Repair local logical gaps and make the reasoning explicit while preserving the evidence and claim scope.",
  condense: "Make this selection substantially more concise without losing technical meaning.",
  "expand-argument": "Expand the argument only with implications supported by the supplied context; do not invent evidence.",
  reorganize: "Reorganize this selection for a clearer argumentative flow.",
  grammar: "Correct grammar, punctuation, and awkward phrasing with minimal rewriting.",
  "citation-suggestion": "Improve how the selection signals where evidence or citations are needed. Do not invent citation keys."
};

function timestamp(): string {
  return new Date().toISOString();
}

interface PreparedWorkspaceMutation {
  path: string;
  nextContent: string;
  currentVersion: number;
  action: "none" | "create" | "save" | "delete";
  resolvedVersion?: number | null;
}

function flattenOutline(items: OutlineItem[]): OutlineItem[] {
  return items.flatMap((item) => [item, ...flattenOutline(item.children)]);
}

function compactHistory(turns: Array<{ role: "user" | "assistant"; content: string }>): Array<{ role: "user" | "assistant"; content: string }> {
  const recent = turns.slice(-8);
  const older = turns.slice(0, -8);
  if (!older.length) return recent;
  const summary = older.map((turn) => `${turn.role}: ${turn.content.replace(/\s+/g, " ").slice(0, 180)}`).join(" | ");
  return [{ role: "assistant", content: `Earlier conversation summary: ${summary.slice(0, 1_600)}` }, ...recent];
}

export class ReviseService {
  constructor(
    private readonly database: JsonDatabase,
    private readonly workspaces: WorkspaceService,
    private readonly skills: SkillRegistry,
    private readonly provider?: AgentProvider,
    private readonly memories?: MemoryService
  ) {}

  async propose(projectId: string, request: ReviseRequest): Promise<ReviseResponse> {
    if (!this.provider) {
      throw new ApiError(503, "agent_not_configured", "Set OPENAI_API_KEY to enable AI revision");
    }
    const instruction = this.resolveInstruction(request);
    const project = this.workspaces.getProject(projectId);
    const opened = await this.workspaces.readTextFile(projectId, request.selection.path);
    this.validateSelection(request, opened.content, opened.file.version);
    const workingText = request.workingText?.trim() ? request.workingText : request.selection.text;
    if (workingText.length > 12_000) throw new ApiError(413, "revision_candidate_too_large", "Keep the current revision under 12,000 characters");
    const history = compactHistory((request.history ?? [])
      .filter((turn) => (turn.role === "user" || turn.role === "assistant") && turn.content?.trim())
      .map((turn) => ({ role: turn.role, content: turn.content.trim().slice(0, 4_000) })));
    const context = await this.contextFor(projectId, request, opened.content);
    const memory = this.memories ? await this.memories.focusedWriterContext(projectId, opened.file.path, context.sectionTitle) : { content: "" };

    const runId = `run_${crypto.randomUUID()}`;
    const createdAt = timestamp();
    const run: AgentRun = {
      id: runId,
      projectId,
      type: "revise",
      status: "running",
      objective: instruction,
      skill: structuredClone(project.skill),
      ...(project.publicationTarget ? { publicationTarget: structuredClone(project.publicationTarget) } : {}),
      createdAt,
      updatedAt: createdAt,
      ...(memory.version ? { memoryVersion: memory.version } : {})
    };
    await this.database.mutate((state) => state.agentRuns.push(run));

    try {
      const loadedSkill = await this.skills.load(project.skill, project.publicationTarget);
      const output = await this.provider.revise({
        instruction,
        selection: request.selection,
        workingText,
        history,
        selectionIsSectionScaffold: isSectionScaffold(workingText, Boolean(context.sectionTitle)),
        ...(memory.content ? { paperContext: memory.content } : {}),
        skill: project.skill,
        skillInstructions: withMemory(loadedSkill.instructions, memory.content),
        venueInstructions: loadedSkill.venueInstructions,
        ...context
      });
      if (!output.replacement.trim()) throw new Error("The agent returned an empty revision");
      if (output.replacement === workingText) throw new Error("The agent did not propose a textual change");

      const changeSetId = `change_${crypto.randomUUID()}`;
      const changeSet: ChangeSet = {
        id: changeSetId,
        projectId,
        agentRunId: runId,
        status: "proposed",
        summary: history.length ? "Follow-up revision" : request.command ? commandLabel(request.command) : "Custom revision",
        rationale: output.rationale.trim(),
        changes: [replaceSelectionChange(request.selection.path, opened, request.selection.from, request.selection.to, output.replacement)],
        createdAt,
        updatedAt: timestamp()
      };
      const approved = new Set(this.database.snapshot().projectResearchWorks.filter((item) => item.projectId === projectId && item.status === "saved" && item.citationKey).map((item) => item.citationKey!));
      for (const hunk of changeSet.changes[0]?.hunks ?? []) {
        const findings = citationFindings(hunk.after, approved);
        if (findings.length) hunk.findings = findings;
      }
      const updatedRun = await this.database.mutate((state) => {
        state.changeSets.push(changeSet);
        const stored = state.agentRuns.find((candidate) => candidate.id === runId)!;
        stored.status = "waiting-approval";
        stored.changeSetId = changeSetId;
        stored.updatedAt = timestamp();
        const issueIds = [...new Set((request.issueIds ?? []).filter((id) => state.reviewReports.some((report) => report.projectId === projectId && report.issues.some((issue) => issue.id === id))))];
        if (issueIds.length) {
          const snapshotIds = [...new Set(state.reviewReports.filter((report) => report.projectId === projectId && issueIds.some((id) => report.issues.some((issue) => issue.id === id))).map((report) => report.snapshotId))];
          state.issueResolutions.push({ id: `resolution_${crypto.randomUUID()}`, projectId, issueIds, reviewSnapshotIds: snapshotIds, agentRunId: runId, baseProjectVersion: project.version, skill: structuredClone(project.skill), ...(project.publicationTarget ? { publicationTarget: structuredClone(project.publicationTarget) } : {}), changeSetId, status: "planned", createdAt: createdAt, updatedAt: timestamp() });
        }
        return stored;
      });
      return { run: updatedRun, changeSet };
    } catch (error) {
      await this.database.mutate((state) => {
        const stored = state.agentRuns.find((candidate) => candidate.id === runId);
        if (stored) {
          stored.status = "failed";
          stored.error = error instanceof Error ? error.message : "Revision failed";
          stored.updatedAt = timestamp();
        }
      });
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, "agent_failed", error instanceof Error ? error.message : "The revision agent failed");
    }
  }

  async accept(projectId: string, changeSetId: string): Promise<ChangeSet> {
    const changeSet = this.getChangeSet(projectId, changeSetId);
    if (changeSet.changes.some((change) => !change.hunks?.length)) return this.acceptLegacy(projectId, changeSetId);
    const decisions = changeSet.changes.map((change) => ({ path: change.path, hunkIds: change.hunks?.filter((hunk) => hunk.status === "pending").map((hunk) => hunk.id) ?? [], status: "accepted" as const })).filter((decision) => decision.hunkIds.length);
    const decided = decisions.length ? await this.decide(projectId, changeSetId, { decisions }) : changeSet;
    return decided.approvalMode === "explicit-finish" ? this.finishReview(projectId, changeSetId) : decided;
  }

  async reject(projectId: string, changeSetId: string): Promise<ChangeSet> {
    const changeSet = this.getChangeSet(projectId, changeSetId);
    if (changeSet.changes.some((change) => !change.hunks?.length)) return this.rejectLegacy(projectId, changeSetId);
    const decisions = changeSet.changes.map((change) => ({ path: change.path, hunkIds: change.hunks?.filter((hunk) => hunk.status === "pending").map((hunk) => hunk.id) ?? [], status: "rejected" as const })).filter((decision) => decision.hunkIds.length);
    const decided = decisions.length ? await this.decide(projectId, changeSetId, { decisions }) : changeSet;
    return decided.approvalMode === "explicit-finish" ? this.finishReview(projectId, changeSetId) : decided;
  }

  async editProposal(projectId: string, changeSetId: string, request: ChangeSetEditRequest): Promise<ChangeSet> {
    const changeSet = this.getChangeSet(projectId, changeSetId);
    if (changeSet.status !== "proposed" && !(changeSet.approvalMode === "explicit-finish" && changeSet.status === "partially-accepted")) throw new ApiError(409, "changeset_not_editable", "Only a proposal still under review can be edited");
    const requestedFiles = request.changes ?? [];
    const requestedHunks = request.hunks ?? [];
    const approvedCitationKeys = new Set(this.database.snapshot().projectResearchWorks.filter((item) => item.projectId === projectId && item.status === "saved" && item.citationKey).map((item) => item.citationKey!));
    if (!requestedFiles.length && !requestedHunks.length) throw new ApiError(400, "changeset_edit_empty", "Edit at least one proposed file or hunk");
    if (requestedFiles.length && requestedHunks.length) throw new ApiError(400, "changeset_edit_mixed", "Edit files or hunks in one request, not both");

    if (requestedHunks.length) {
      const edits = new Map<string, { path: string; hunkId: string; after: string }>();
      for (const edit of requestedHunks) {
        const key = `${edit.path}\u0000${edit.hunkId}`;
        if (edits.has(key)) throw new ApiError(400, "changeset_edit_duplicate", `Duplicate edit for hunk '${edit.hunkId}'`);
        if (new TextEncoder().encode(edit.after).byteLength > 2_000_000) throw new ApiError(413, "changeset_edit_too_large", `Edited hunk '${edit.hunkId}' exceeds 2 MB`);
        const change = changeSet.changes.find((candidate) => candidate.path === edit.path);
        const hunk = change?.hunks?.find((candidate) => candidate.id === edit.hunkId);
        if (!change || !hunk) throw new ApiError(400, "changeset_hunk_invalid", `Hunk '${edit.hunkId}' does not belong to '${edit.path}'`);
        if (hunk.status === "accepted") throw new ApiError(409, "changeset_hunk_edit_accepted", `Change hunk '${edit.hunkId}' to reject before editing it`);
        if (edit.after === hunk.after) throw new ApiError(400, "changeset_edit_unchanged", `Edited hunk '${edit.hunkId}' did not change`);
        if (edit.after === hunk.before) throw new ApiError(400, "changeset_edit_matches_original", `Reject hunk '${edit.hunkId}' instead of editing it back to the original text`);
        edits.set(key, edit);
      }
      return this.database.mutate((state) => {
        const stored = state.changeSets.find((candidate) => candidate.id === changeSetId)!;
        for (const edit of edits.values()) {
          const change = stored.changes.find((candidate) => candidate.path === edit.path)!;
          const hunk = change.hunks!.find((candidate) => candidate.id === edit.hunkId)!;
          hunk.after = edit.after;
          const findings = citationFindings(edit.after, approvedCitationKeys);
          if (findings.length) hunk.findings = findings; else delete hunk.findings;
          change.after = materializeProposedText(change.before, change.hunks!);
        }
        stored.updatedAt = timestamp();
        const paths = [...new Set([...edits.values()].map((edit) => edit.path))];
        const run = state.agentRuns.find((candidate) => candidate.id === stored.agentRunId);
        if (run) {
          run.auditTrail ??= [];
          run.auditTrail.push({ id: `audit_${crypto.randomUUID()}`, action: "hunk-edited", summary: `Edited ${edits.size} proposed hunk${edits.size === 1 ? "" : "s"} during review`, paths, createdAt: timestamp() });
          run.updatedAt = timestamp();
        }
        return stored;
      });
    }

    const edits = new Map<string, string>();
    for (const edit of requestedFiles) {
      if (edits.has(edit.path)) throw new ApiError(400, "changeset_edit_duplicate", `Duplicate edit for '${edit.path}'`);
      if (new TextEncoder().encode(edit.after).byteLength > 2_000_000) throw new ApiError(413, "changeset_edit_too_large", `Edited proposal for '${edit.path}' exceeds 2 MB`);
      edits.set(edit.path, edit.after);
    }
    const targets = changeSet.changes.filter((change) => edits.has(change.path));
    if (targets.length !== edits.size) throw new ApiError(400, "changeset_edit_path_invalid", "Every edited path must belong to this ChangeSet");
    if (targets.some((change) => change.hunks?.some((hunk) => hunk.status !== "pending"))) throw new ApiError(409, "changeset_edit_decided", "Only files whose hunks are still pending can be edited");
    for (const change of targets) {
      const after = edits.get(change.path)!;
      if (after === change.before) throw new ApiError(400, "changeset_edit_unchanged", `Edited proposal for '${change.path}' must differ from its original text`);
      if (change.operation === "create") {
        if (await this.workspaces.fileExists(projectId, change.path)) return this.markConflict(changeSetId);
      } else {
        const opened = await this.workspaces.readTextFile(projectId, change.path);
        if (opened.file.version !== change.baseVersion || opened.content !== change.baseContent) return this.markConflict(changeSetId);
      }
    }
    return this.database.mutate((state) => {
      const stored = state.changeSets.find((candidate) => candidate.id === changeSetId)!;
      for (const change of stored.changes) {
        const after = edits.get(change.path);
        if (after === undefined) continue;
        change.after = after;
        change.hunks = buildTextHunks(change.before, after);
        for (const hunk of change.hunks) {
          const findings = citationFindings(hunk.after, approvedCitationKeys);
          if (findings.length) hunk.findings = findings;
        }
      }
      stored.updatedAt = timestamp();
      const run = state.agentRuns.find((candidate) => candidate.id === stored.agentRunId);
      if (run) {
        run.auditTrail ??= [];
        run.auditTrail.push({ id: `audit_${crypto.randomUUID()}`, action: "proposal-edited", summary: `Edited ${targets.length} proposed file${targets.length === 1 ? "" : "s"} before approval`, paths: targets.map((change) => change.path), createdAt: timestamp() });
        run.updatedAt = timestamp();
      }
      return stored;
    });
  }

  async decide(projectId: string, changeSetId: string, request: ChangeSetDecisionRequest): Promise<ChangeSet> {
    const changeSet = this.getChangeSet(projectId, changeSetId);
    if (!new Set(["proposed", "partially-accepted"]).has(changeSet.status)) throw new ApiError(409, "changeset_not_proposed", "This change is no longer awaiting approval");
    if (!request.decisions.length) throw new ApiError(400, "changeset_decision_empty", "Choose at least one pending hunk");
    if (changeSet.changes.some((change) => !change.baseContent && change.operation !== "create" || !change.hunks?.length)) throw new ApiError(409, "changeset_hunks_unavailable", "This legacy ChangeSet can only be accepted or rejected as a whole");
    const explicitFinish = changeSet.approvalMode === "explicit-finish";
    const overwriteVersions = new Map<string, number | null>();
    for (const resolution of request.overwriteConflicts ?? []) {
      if (overwriteVersions.has(resolution.path)) throw new ApiError(400, "changeset_conflict_duplicate", `Duplicate overwrite confirmation for '${resolution.path}'`);
      overwriteVersions.set(resolution.path, resolution.currentVersion);
    }

    const nextHunks = new Map<string, TextHunk[]>();
    for (const change of changeSet.changes) nextHunks.set(change.path, structuredClone(change.hunks!));
    const touched = new Set<string>();
    for (const decision of request.decisions) {
      if (touched.has(decision.path)) throw new ApiError(400, "changeset_decision_duplicate", `Decisions for '${decision.path}' must be grouped`);
      touched.add(decision.path);
      const hunks = nextHunks.get(decision.path);
      if (!hunks || !decision.hunkIds.length) throw new ApiError(400, "changeset_hunk_invalid", `No hunks selected for '${decision.path}'`);
      const ids = new Set(decision.hunkIds);
      if (ids.size !== decision.hunkIds.length) throw new ApiError(400, "changeset_hunk_invalid", "Duplicate hunk decision");
      for (const id of ids) {
        const hunk = hunks.find((candidate) => candidate.id === id);
        if (!hunk) throw new ApiError(409, "changeset_hunk_decided", `Hunk '${id}' is missing`);
        if (decision.status === "accepted" && hunk.findings?.some((finding) => finding.status === "blocking")) throw new ApiError(409, "changeset_blocked", "This hunk has blocking evidence findings");
        if (hunk.status === decision.status) throw new ApiError(409, "changeset_hunk_unchanged", `Hunk '${id}' is already ${decision.status}`);
        if (!explicitFinish && hunk.status !== "pending") throw new ApiError(409, "changeset_hunk_decided", `Hunk '${id}' is already decided`);
        hunk.status = decision.status;
      }
    }
    for (const path of overwriteVersions.keys()) if (!touched.has(path)) throw new ApiError(400, "changeset_conflict_path_invalid", `Overwrite confirmation for '${path}' does not match this decision`);

    const prepared: PreparedWorkspaceMutation[] = [];
    const conflicts: ChangeSetConflictFile[] = [];
    for (const change of changeSet.changes.filter((candidate) => touched.has(candidate.path))) {
      const currentHunks = change.hunks!;
      const updatedHunks = nextHunks.get(change.path)!;
      const result = await this.prepareWorkspaceMutation(projectId, change, currentHunks, updatedHunks, overwriteVersions);
      if ("conflict" in result) conflicts.push(result.conflict);
      else prepared.push(result.prepared);
    }
    if (conflicts.length) throw new ApiError(409, "changeset_conflict_review_required", "The workspace changed during review. Compare the current files with the reviewed result before overwriting.", { changeSetId, conflicts });

    const appliedVersions = new Map<string, number | null>();
    for (const item of prepared) {
      if (item.action === "create") appliedVersions.set(item.path, (await this.workspaces.createFile(projectId, item.path, item.nextContent)).version);
      else if (item.action === "save") appliedVersions.set(item.path, (await this.workspaces.saveTextFile(projectId, item.path, { content: item.nextContent, baseVersion: item.currentVersion })).file.version);
      else if (item.action === "delete") { await this.workspaces.deletePath(projectId, item.path); appliedVersions.set(item.path, null); }
      else if (item.resolvedVersion !== undefined) appliedVersions.set(item.path, item.resolvedVersion);
    }
    const projectVersion = this.workspaces.getProject(projectId).version;
    return this.database.mutate((state) => {
      const stored = state.changeSets.find((candidate) => candidate.id === changeSetId)!;
      for (const change of stored.changes) {
        change.hunks = nextHunks.get(change.path)!;
        const version = appliedVersions.get(change.path);
        if (version === null) { delete change.currentVersion; delete change.appliedVersion; }
        else if (version !== undefined) { change.currentVersion = version; if (change.hunks.some((hunk) => hunk.status === "accepted")) change.appliedVersion = version; }
        if (!change.hunks.some((hunk) => hunk.status === "accepted")) delete change.appliedVersion;
      }
      const hunks = stored.changes.flatMap((change) => change.hunks ?? []);
      const pending = hunks.some((hunk) => hunk.status === "pending");
      const accepted = hunks.some((hunk) => hunk.status === "accepted");
      const hasDecision = hunks.some((hunk) => hunk.status !== "pending");
      stored.status = explicitFinish ? hasDecision ? "partially-accepted" : "proposed" : pending ? "partially-accepted" : accepted ? "accepted" : "rejected";
      if (stored.changes.length === 1 && stored.changes[0]!.appliedVersion !== undefined) stored.appliedFileVersion = stored.changes[0]!.appliedVersion;
      else delete stored.appliedFileVersion;
      stored.updatedAt = timestamp();
      const run = state.agentRuns.find((candidate) => candidate.id === stored.agentRunId);
      if (run) { run.status = pending || explicitFinish ? "waiting-approval" : "completed"; if (!pending && !explicitFinish) run.steps?.forEach((step) => { if (step.status === "running" || step.status === "pending") step.status = "completed"; }); run.auditTrail ??= []; run.auditTrail.push({ id: `audit_${crypto.randomUUID()}`, action: "hunk-decision", summary: `${request.decisions.reduce((total, decision) => total + decision.hunkIds.length, 0)} hunk choices updated; ${hunks.filter((hunk) => hunk.status === "pending").length} remain pending`, paths: [...touched], createdAt: timestamp() }); run.updatedAt = timestamp(); }
      const draft = state.draftPlans.find((candidate) => candidate.changeSetId === stored.id);
      if (draft) { draft.status = pending ? "waiting-approval" : accepted ? "accepted" : "cancelled"; draft.updatedAt = timestamp(); }
      const agentPlan = state.agentTaskPlans.find((candidate) => candidate.changeSetId === stored.id);
      if (agentPlan) { agentPlan.status = pending || explicitFinish ? "waiting-approval" : accepted ? "accepted" : "cancelled"; if (!pending && accepted && !explicitFinish) agentPlan.acceptedProjectVersion = projectVersion; agentPlan.updatedAt = timestamp(); }
      const resolution = state.issueResolutions.find((candidate) => candidate.changeSetId === stored.id);
      if (resolution) {
        resolution.status = accepted ? "in-revision" : pending ? "in-revision" : "reopened";
        if (!pending && accepted && !explicitFinish) resolution.acceptedProjectVersion = projectVersion;
        resolution.updatedAt = timestamp();
        if (!pending && !accepted && !explicitFinish) for (const report of state.reviewReports) for (const issue of report.issues) if (resolution.issueIds.includes(issue.id)) { issue.status = "open"; issue.updatedAt = timestamp(); }
      }
      return stored;
    });
  }

  private async prepareWorkspaceMutation(
    projectId: string,
    change: TextChange,
    currentHunks: TextHunk[],
    nextHunks: TextHunk[],
    overwriteVersions: Map<string, number | null>
  ): Promise<{ prepared: PreparedWorkspaceMutation } | { conflict: ChangeSetConflictFile }> {
    const currentContent = materializeChange(change, currentHunks);
    const nextContent = materializeChange(change, nextHunks);
    if (currentContent === nextContent) return { prepared: { path: change.path, nextContent, currentVersion: 0, action: "none" } };

    const exists = await this.workspaces.fileExists(projectId, change.path);
    const opened = exists ? await this.workspaces.readTextFile(projectId, change.path) : null;
    const expectedExists = change.operation !== "create" || Boolean(currentContent);
    const expectedVersion = change.currentVersion ?? change.baseVersion;
    const matchesExpected = expectedExists
      ? Boolean(opened && opened.file.version === expectedVersion && opened.content === currentContent)
      : !opened;
    const currentVersion = opened?.file.version ?? null;
    if (!matchesExpected && (!overwriteVersions.has(change.path) || overwriteVersions.get(change.path) !== currentVersion)) {
      return { conflict: { path: change.path, currentContent: opened?.content ?? null, reviewedContent: nextContent, currentVersion } };
    }

    if (opened) {
      if (change.operation === "create" && !nextContent) return { prepared: { path: change.path, nextContent, currentVersion: opened.file.version, action: "delete" } };
      if (opened.content === nextContent) return { prepared: { path: change.path, nextContent, currentVersion: opened.file.version, action: "none", resolvedVersion: opened.file.version } };
      return { prepared: { path: change.path, nextContent, currentVersion: opened.file.version, action: "save" } };
    }
    if (change.operation === "create" && !nextContent) return { prepared: { path: change.path, nextContent, currentVersion: 0, action: "none", resolvedVersion: null } };
    return { prepared: { path: change.path, nextContent, currentVersion: 0, action: "create" } };
  }

  async finishReview(projectId: string, changeSetId: string): Promise<ChangeSet> {
    const changeSet = this.getChangeSet(projectId, changeSetId);
    if (changeSet.approvalMode !== "explicit-finish") throw new ApiError(409, "changeset_finish_unavailable", "This ChangeSet does not use explicit review completion");
    if (changeSet.status === "accepted" || changeSet.status === "rejected") return changeSet;
    if (!new Set(["proposed", "partially-accepted"]).has(changeSet.status)) throw new ApiError(409, "changeset_not_proposed", "This change is no longer awaiting approval");
    const hunks = changeSet.changes.flatMap((change) => change.hunks ?? []);
    if (!hunks.length || hunks.some((hunk) => hunk.status === "pending")) throw new ApiError(409, "changeset_review_incomplete", "Accept or reject every hunk before finishing the review");
    if (hunks.some((hunk) => hunk.status === "accepted" && hunk.findings?.some((finding) => finding.status === "blocking"))) throw new ApiError(409, "changeset_blocked", "Resolve blocking evidence findings or explicitly override them before accepting this ChangeSet");
    const accepted = hunks.some((hunk) => hunk.status === "accepted");
    const projectVersion = this.workspaces.getProject(projectId).version;
    const finishedAt = timestamp();
    return this.database.mutate((state) => {
      const stored = state.changeSets.find((candidate) => candidate.id === changeSetId)!;
      stored.status = accepted ? "accepted" : "rejected";
      stored.reviewFinishedAt = finishedAt;
      stored.updatedAt = finishedAt;
      const run = state.agentRuns.find((candidate) => candidate.id === stored.agentRunId);
      if (run) { run.status = "completed"; run.auditTrail ??= []; run.auditTrail.push({ id: `audit_${crypto.randomUUID()}`, action: "review-finished", summary: `Finished ChangeSet review with ${hunks.filter((hunk) => hunk.status === "accepted").length} accepted and ${hunks.filter((hunk) => hunk.status === "rejected").length} rejected hunks`, paths: stored.changes.map((change) => change.path), createdAt: finishedAt }); run.updatedAt = finishedAt; }
      const agentPlan = state.agentTaskPlans.find((candidate) => candidate.changeSetId === stored.id);
      if (agentPlan) { agentPlan.status = accepted ? "accepted" : "cancelled"; if (accepted) agentPlan.acceptedProjectVersion = projectVersion; agentPlan.updatedAt = finishedAt; }
      const resolution = state.issueResolutions.find((candidate) => candidate.changeSetId === stored.id);
      if (resolution) {
        resolution.status = accepted ? "in-revision" : "reopened";
        if (accepted) resolution.acceptedProjectVersion = projectVersion;
        else { delete resolution.acceptedProjectVersion; for (const report of state.reviewReports) for (const issue of report.issues) if (resolution.issueIds.includes(issue.id)) { issue.status = "open"; issue.updatedAt = finishedAt; } }
        resolution.updatedAt = finishedAt;
      }
      return stored;
    });
  }

  async rollback(projectId: string, changeSetId: string): Promise<ChangeSet> {
    const changeSet = this.getChangeSet(projectId, changeSetId);
    if (changeSet.changes.some((change) => !change.hunks?.length)) return this.rollbackLegacy(projectId, changeSetId);
    if (changeSet.status !== "accepted" || !changeSet.changes.some((change) => change.hunks?.some((hunk) => hunk.status === "accepted"))) {
      throw new ApiError(409, "changeset_not_rollbackable", "Only an accepted change can be rolled back once");
    }
    const openedFiles = new Map<string, Awaited<ReturnType<WorkspaceService["readTextFile"]>>>();
    for (const change of changeSet.changes) {
      if (!change.hunks?.some((hunk) => hunk.status === "accepted")) continue;
      const opened = await this.workspaces.readTextFile(projectId, change.path);
      openedFiles.set(change.path, opened);
      const matches = opened.file.version === change.currentVersion && opened.content === materializeChange(change, change.hunks);
      if (!matches) throw new ApiError(409, "version_conflict", "A file changed after this revision; rollback is no longer safe");
    }
    for (const change of [...changeSet.changes].reverse()) {
      const opened = openedFiles.get(change.path);
      if (!opened) continue;
      if (change.operation === "create") {
        await this.workspaces.deletePath(projectId, change.path);
      } else {
        await this.workspaces.saveTextFile(projectId, change.path, { content: change.baseContent!, baseVersion: opened.file.version });
      }
    }
    return this.database.mutate((state) => {
      const stored = state.changeSets.find((candidate) => candidate.id === changeSetId)!;
      stored.status = "rolled-back";
      stored.updatedAt = timestamp();
      const run = state.agentRuns.find((candidate) => candidate.id === stored.agentRunId);
      if (run) { run.auditTrail ??= []; run.auditTrail.push({ id: `audit_${crypto.randomUUID()}`, action: "rollback", summary: `Rolled back accepted changes in ${openedFiles.size} files`, paths: [...openedFiles.keys()], createdAt: timestamp() }); run.updatedAt = timestamp(); }
      const draft = state.draftPlans.find((candidate) => candidate.changeSetId === stored.id);
      if (draft) { draft.status = "cancelled"; draft.updatedAt = timestamp(); }
      const agentPlan = state.agentTaskPlans.find((candidate) => candidate.changeSetId === stored.id);
      if (agentPlan) { agentPlan.status = "cancelled"; agentPlan.updatedAt = timestamp(); }
      const resolution = state.issueResolutions.find((candidate) => candidate.changeSetId === stored.id);
      if (resolution) {
        resolution.status = "rolled-back"; resolution.updatedAt = timestamp();
        for (const report of state.reviewReports) for (const issue of report.issues) if (resolution.issueIds.includes(issue.id)) { issue.status = "open"; issue.updatedAt = timestamp(); }
      }
      return stored;
    });
  }

  private async acceptLegacy(projectId: string, changeSetId: string): Promise<ChangeSet> {
    const changeSet = this.getChangeSet(projectId, changeSetId);
    if (changeSet.status !== "proposed") throw new ApiError(409, "changeset_not_proposed", "This change is no longer awaiting approval");
    const openedFiles = new Map<string, Awaited<ReturnType<WorkspaceService["readTextFile"]>>>();
    for (const change of changeSet.changes) {
      if (change.operation === "create") { if (await this.workspaces.fileExists(projectId, change.path)) return this.markConflict(changeSetId); continue; }
      const opened = await this.workspaces.readTextFile(projectId, change.path); openedFiles.set(change.path, opened);
      if (opened.file.version !== change.baseVersion || opened.content.slice(change.from, change.to) !== change.before) return this.markConflict(changeSetId);
    }
    const appliedVersions: number[] = [];
    for (const change of changeSet.changes) {
      if (change.operation === "create") appliedVersions.push((await this.workspaces.createFile(projectId, change.path, change.after)).version);
      else { const opened = openedFiles.get(change.path)!; appliedVersions.push((await this.workspaces.saveTextFile(projectId, change.path, { content: opened.content.slice(0, change.from) + change.after + opened.content.slice(change.to), baseVersion: change.baseVersion })).file.version); }
    }
    const projectVersion = this.workspaces.getProject(projectId).version;
    return this.database.mutate((state) => {
      const stored = state.changeSets.find((candidate) => candidate.id === changeSetId)!; stored.status = "accepted"; stored.changes.forEach((change, index) => { change.appliedVersion = appliedVersions[index]!; }); stored.updatedAt = timestamp();
      const run = state.agentRuns.find((candidate) => candidate.id === stored.agentRunId); if (run) { run.status = "completed"; run.updatedAt = timestamp(); }
      const draft = state.draftPlans.find((candidate) => candidate.changeSetId === stored.id); if (draft) { draft.status = "accepted"; draft.updatedAt = timestamp(); }
      const plan = state.agentTaskPlans.find((candidate) => candidate.changeSetId === stored.id); if (plan) { plan.status = "accepted"; plan.acceptedProjectVersion = projectVersion; plan.updatedAt = timestamp(); }
      const resolution = state.issueResolutions.find((candidate) => candidate.changeSetId === stored.id); if (resolution) { resolution.status = "in-revision"; resolution.acceptedProjectVersion = projectVersion; resolution.updatedAt = timestamp(); }
      return stored;
    });
  }

  private rejectLegacy(projectId: string, changeSetId: string): Promise<ChangeSet> {
    const changeSet = this.getChangeSet(projectId, changeSetId);
    if (changeSet.status !== "proposed") throw new ApiError(409, "changeset_not_proposed", "This change is no longer awaiting approval");
    return this.database.mutate((state) => {
      const stored = state.changeSets.find((candidate) => candidate.id === changeSetId)!; stored.status = "rejected"; stored.updatedAt = timestamp();
      const run = state.agentRuns.find((candidate) => candidate.id === stored.agentRunId); if (run) { run.status = "completed"; run.updatedAt = timestamp(); }
      const draft = state.draftPlans.find((candidate) => candidate.changeSetId === stored.id); if (draft) { draft.status = "cancelled"; draft.updatedAt = timestamp(); }
      const plan = state.agentTaskPlans.find((candidate) => candidate.changeSetId === stored.id); if (plan) { plan.status = "cancelled"; plan.updatedAt = timestamp(); }
      const resolution = state.issueResolutions.find((candidate) => candidate.changeSetId === stored.id); if (resolution) { resolution.status = "reopened"; resolution.updatedAt = timestamp(); for (const issue of state.reviewReports.flatMap((report) => report.issues)) if (resolution.issueIds.includes(issue.id)) { issue.status = "open"; issue.updatedAt = timestamp(); } }
      return stored;
    });
  }

  private async rollbackLegacy(projectId: string, changeSetId: string): Promise<ChangeSet> {
    const changeSet = this.getChangeSet(projectId, changeSetId);
    if (changeSet.status !== "accepted" || changeSet.changes.some((change) => !change.appliedVersion)) throw new ApiError(409, "changeset_not_rollbackable", "Only an accepted change can be rolled back once");
    const openedFiles = new Map<string, Awaited<ReturnType<WorkspaceService["readTextFile"]>>>();
    for (const change of changeSet.changes) { const opened = await this.workspaces.readTextFile(projectId, change.path); openedFiles.set(change.path, opened); const appliedTo = change.from + change.after.length; if (opened.file.version !== change.appliedVersion || (change.operation === "create" ? opened.content !== change.after : opened.content.slice(change.from, appliedTo) !== change.after)) throw new ApiError(409, "version_conflict", "A file changed after this revision; rollback is no longer safe"); }
    for (const change of [...changeSet.changes].reverse()) { const opened = openedFiles.get(change.path)!; if (change.operation === "create") await this.workspaces.deletePath(projectId, change.path); else { const appliedTo = change.from + change.after.length; await this.workspaces.saveTextFile(projectId, change.path, { content: opened.content.slice(0, change.from) + change.before + opened.content.slice(appliedTo), baseVersion: opened.file.version }); } }
    return this.database.mutate((state) => {
      const stored = state.changeSets.find((candidate) => candidate.id === changeSetId)!;
      stored.status = "rolled-back";
      stored.updatedAt = timestamp();
      const run = state.agentRuns.find((candidate) => candidate.id === stored.agentRunId);
      if (run) { run.auditTrail ??= []; run.auditTrail.push({ id: `audit_${crypto.randomUUID()}`, action: "rollback", summary: `Rolled back accepted changes in ${openedFiles.size} files`, paths: [...openedFiles.keys()], createdAt: timestamp() }); run.updatedAt = timestamp(); }
      const draft = state.draftPlans.find((candidate) => candidate.changeSetId === stored.id);
      if (draft) { draft.status = "cancelled"; draft.updatedAt = timestamp(); }
      const plan = state.agentTaskPlans.find((candidate) => candidate.changeSetId === stored.id);
      if (plan) { plan.status = "cancelled"; plan.updatedAt = timestamp(); }
      const resolution = state.issueResolutions.find((candidate) => candidate.changeSetId === stored.id);
      if (resolution) {
        resolution.status = "rolled-back";
        resolution.updatedAt = timestamp();
        for (const issue of state.reviewReports.flatMap((report) => report.issues)) if (resolution.issueIds.includes(issue.id)) { issue.status = "open"; issue.updatedAt = timestamp(); }
      }
      return stored;
    });
  }

  private getChangeSet(projectId: string, id: string): ChangeSet {
    const changeSet = this.database.snapshot().changeSets.find((candidate) => candidate.id === id && candidate.projectId === projectId);
    if (!changeSet) throw new ApiError(404, "changeset_not_found", "Change set not found");
    return normalizePlaceholderFindings(changeSet);
  }

  private async markConflict(id: string): Promise<ChangeSet> {
    const conflicted = await this.database.mutate((state) => {
      const stored = state.changeSets.find((candidate) => candidate.id === id)!;
      stored.status = "conflict";
      stored.updatedAt = timestamp();
      return stored;
    });
    throw new ApiError(409, "version_conflict", "The selection changed after this revision was generated", conflicted);
  }

  private resolveInstruction(request: ReviseRequest): string {
    const custom = request.instruction?.trim();
    if (custom) return custom.slice(0, 2_000);
    if (request.command && COMMANDS[request.command]) return COMMANDS[request.command];
    throw new ApiError(400, "revision_instruction_missing", "Choose a revision shortcut or enter an instruction");
  }

  private validateSelection(request: ReviseRequest, content: string, currentVersion: number): void {
    const { selection } = request;
    if (!selection.text.trim() || selection.from < 0 || selection.to <= selection.from || selection.to > content.length) {
      throw new ApiError(400, "invalid_selection", "Select a non-empty sentence or paragraph");
    }
    if (selection.text.length > 12_000) throw new ApiError(413, "selection_too_large", "Select at most 12,000 characters");
    if (selection.fileVersion !== currentVersion || content.slice(selection.from, selection.to) !== selection.text) {
      throw new ApiError(409, "version_conflict", "The selection is stale; select the text again");
    }
  }

  private async contextFor(projectId: string, request: ReviseRequest, content: string): Promise<Pick<ReviseAgentInput, "contextBefore" | "contextAfter" | "sectionTitle">> {
    const { selection } = request;
    const outline = flattenOutline(await this.workspaces.outline(projectId));
    const section = outline
      .filter((item) => item.path === selection.path && item.line <= selection.startLine)
      .sort((a, b) => b.line - a.line)[0];
    const sectionIndex = section ? outline.findIndex((item) => item.id === section.id) : -1;
    const previous = sectionIndex > 0 ? outline.slice(0, sectionIndex).reverse().find((item) => item.path !== selection.path) : undefined;
    const next = sectionIndex >= 0 ? outline.slice(sectionIndex + 1).find((item) => item.path !== selection.path) : undefined;
    const [previousContext, nextContext] = await Promise.all([
      previous ? this.adjacentContext(projectId, previous, "before") : "",
      next ? this.adjacentContext(projectId, next, "after") : ""
    ]);
    const localBefore = content.slice(Math.max(0, selection.from - 1_500), selection.from);
    const localAfter = content.slice(selection.to, selection.to + 1_500);
    return {
      contextBefore: [previousContext, localBefore].filter(Boolean).join("\n\n"),
      contextAfter: [localAfter, nextContext].filter(Boolean).join("\n\n"),
      ...(section ? { sectionTitle: section.title } : {})
    };
  }

  private async adjacentContext(projectId: string, section: OutlineItem, side: "before" | "after"): Promise<string> {
    try {
      const opened = await this.workspaces.readTextFile(projectId, section.path);
      const excerpt = side === "before" ? opened.content.slice(-1_500) : opened.content.slice(0, 1_500);
      return excerpt.trim() ? `[Adjacent paper section: ${section.title} (${section.path})]\n${excerpt}` : "";
    } catch {
      return "";
    }
  }
}

function withMemory(skill: string, memory: string): string { return memory ? `${skill}\n\nReviewed Local Paper Context (paper core and current section only):\n${memory}` : skill; }

function isSectionScaffold(value: string, hasSection: boolean): boolean {
  if (!hasSection) return false;
  const body = value
    .replace(/^.*\b(?:TODO|TBD|PLACEHOLDER)\b.*$/gimu, "")
    .replace(/%[^\n]*/g, "")
    .replace(/\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?(?:\[[^\]]*\])?\{[^}]*\}/g, "")
    .replace(/\\label\{[^}]*\}/g, "")
    .replace(/\\(?:begin|end)\{[^}]*\}/g, "")
    .trim();
  return body.length === 0;
}

function materializeChange(change: TextChange, hunks: TextHunk[]): string {
  const segment = materializeTextHunks(change.before, hunks);
  if (change.operation === "create") return segment;
  if (change.baseContent === undefined) throw new ApiError(409, "changeset_hunks_unavailable", "This ChangeSet does not contain a complete base snapshot");
  return change.baseContent.slice(0, change.from) + segment + change.baseContent.slice(change.to);
}

function materializeProposedText(before: string, hunks: TextHunk[]): string {
  return materializeTextHunks(before, hunks.map((hunk) => ({ ...hunk, status: "accepted" })));
}

function commandLabel(command: ReviseCommandId): string {
  return ({
    "academic-polish": "Academic polish",
    "logic-check": "Logic check",
    condense: "Condense",
    "expand-argument": "Expand argument",
    reorganize: "Reorganize",
    grammar: "Grammar",
    "citation-suggestion": "Citation suggestion"
  })[command];
}
