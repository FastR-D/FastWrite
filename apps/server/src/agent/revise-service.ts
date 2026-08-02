import type {
  AgentRun,
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

function flattenOutline(items: OutlineItem[]): OutlineItem[] {
  return items.flatMap((item) => [item, ...flattenOutline(item.children)]);
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
    const memory = this.memories?.confirmedContext(projectId) ?? { content: "" };
    const opened = await this.workspaces.readTextFile(projectId, request.selection.path);
    this.validateSelection(request, opened.content, opened.file.version);
    const workingText = request.workingText?.trim() ? request.workingText : request.selection.text;
    if (workingText.length > 12_000) throw new ApiError(413, "revision_candidate_too_large", "Keep the current revision under 12,000 characters");
    const history = (request.history ?? [])
      .filter((turn) => (turn.role === "user" || turn.role === "assistant") && turn.content?.trim())
      .slice(-12)
      .map((turn) => ({ role: turn.role, content: turn.content.trim().slice(0, 4_000) }));

    const runId = `run_${crypto.randomUUID()}`;
    const createdAt = timestamp();
    const run: AgentRun = {
      id: runId,
      projectId,
      type: "revise",
      status: "running",
      objective: instruction,
      skill: structuredClone(project.skill),
      createdAt,
      updatedAt: createdAt,
      ...(memory.version ? { memoryVersion: memory.version } : {})
    };
    await this.database.mutate((state) => state.agentRuns.push(run));

    try {
      const context = await this.contextFor(projectId, request, opened.content);
      const loadedSkill = await this.skills.load(project.skill);
      const output = await this.provider.revise({
        instruction,
        selection: request.selection,
        workingText,
        history,
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
      const updatedRun = await this.database.mutate((state) => {
        state.changeSets.push(changeSet);
        const stored = state.agentRuns.find((candidate) => candidate.id === runId)!;
        stored.status = "waiting-approval";
        stored.changeSetId = changeSetId;
        stored.updatedAt = timestamp();
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
    return this.decide(projectId, changeSetId, { decisions: changeSet.changes.map((change) => ({ path: change.path, hunkIds: change.hunks?.filter((hunk) => hunk.status === "pending").map((hunk) => hunk.id) ?? [], status: "accepted" })) });
  }

  async reject(projectId: string, changeSetId: string): Promise<ChangeSet> {
    const changeSet = this.getChangeSet(projectId, changeSetId);
    if (changeSet.changes.some((change) => !change.hunks?.length)) return this.rejectLegacy(projectId, changeSetId);
    return this.decide(projectId, changeSetId, { decisions: changeSet.changes.map((change) => ({ path: change.path, hunkIds: change.hunks?.filter((hunk) => hunk.status === "pending").map((hunk) => hunk.id) ?? [], status: "rejected" })) });
  }

  async editProposal(projectId: string, changeSetId: string, request: ChangeSetEditRequest): Promise<ChangeSet> {
    const changeSet = this.getChangeSet(projectId, changeSetId);
    if (changeSet.status !== "proposed") throw new ApiError(409, "changeset_not_editable", "Only an untouched proposal can be edited");
    if (!request.changes.length) throw new ApiError(400, "changeset_edit_empty", "Edit at least one proposed file");
    const edits = new Map<string, string>();
    for (const edit of request.changes) {
      if (edits.has(edit.path)) throw new ApiError(400, "changeset_edit_duplicate", `Duplicate edit for '${edit.path}'`);
      if (new TextEncoder().encode(edit.after).byteLength > 2_000_000) throw new ApiError(413, "changeset_edit_too_large", `Edited proposal for '${edit.path}' exceeds 2 MB`);
      edits.set(edit.path, edit.after);
    }
    const targets = changeSet.changes.filter((change) => edits.has(change.path));
    if (targets.length !== edits.size) throw new ApiError(400, "changeset_edit_path_invalid", "Every edited path must belong to this ChangeSet");
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
        if (!hunk || hunk.status !== "pending") throw new ApiError(409, "changeset_hunk_decided", `Hunk '${id}' is missing or already decided`);
        hunk.status = decision.status;
      }
    }

    const prepared: Array<{ path: string; nextContent: string; currentVersion: number; operation: "replace" | "create"; changed: boolean }> = [];
    for (const change of changeSet.changes.filter((candidate) => touched.has(candidate.path))) {
      const currentHunks = change.hunks!;
      const updatedHunks = nextHunks.get(change.path)!;
      const currentContent = materializeChange(change, currentHunks);
      const nextContent = materializeChange(change, updatedHunks);
      if (change.operation === "create") {
        if (await this.workspaces.fileExists(projectId, change.path)) return this.markConflict(changeSetId);
        prepared.push({ path: change.path, nextContent, currentVersion: 0, operation: "create", changed: currentContent !== nextContent });
        continue;
      }
      const opened = await this.workspaces.readTextFile(projectId, change.path);
      if (opened.file.version !== (change.currentVersion ?? change.baseVersion) || opened.content !== currentContent) return this.markConflict(changeSetId);
      prepared.push({ path: change.path, nextContent, currentVersion: opened.file.version, operation: "replace", changed: currentContent !== nextContent });
    }

    const appliedVersions = new Map<string, number>();
    for (const item of prepared.filter((candidate) => candidate.changed)) {
      if (item.operation === "create") {
        if (!item.nextContent) continue;
        appliedVersions.set(item.path, (await this.workspaces.createFile(projectId, item.path, item.nextContent)).version);
      } else {
        appliedVersions.set(item.path, (await this.workspaces.saveTextFile(projectId, item.path, { content: item.nextContent, baseVersion: item.currentVersion })).file.version);
      }
    }
    const projectVersion = this.workspaces.getProject(projectId).version;
    return this.database.mutate((state) => {
      const stored = state.changeSets.find((candidate) => candidate.id === changeSetId)!;
      for (const change of stored.changes) {
        change.hunks = nextHunks.get(change.path)!;
        const version = appliedVersions.get(change.path);
        if (version !== undefined) { change.currentVersion = version; change.appliedVersion = version; }
      }
      const hunks = stored.changes.flatMap((change) => change.hunks ?? []);
      const pending = hunks.some((hunk) => hunk.status === "pending");
      const accepted = hunks.some((hunk) => hunk.status === "accepted");
      stored.status = pending ? "partially-accepted" : accepted ? "accepted" : "rejected";
      if (stored.changes.length === 1 && stored.changes[0]!.appliedVersion !== undefined) stored.appliedFileVersion = stored.changes[0]!.appliedVersion;
      stored.updatedAt = timestamp();
      const run = state.agentRuns.find((candidate) => candidate.id === stored.agentRunId);
      if (run) { run.status = pending ? "waiting-approval" : "completed"; if (!pending) run.steps?.forEach((step) => { if (step.status === "running" || step.status === "pending") step.status = "completed"; }); run.auditTrail ??= []; run.auditTrail.push({ id: `audit_${crypto.randomUUID()}`, action: "hunk-decision", summary: `${request.decisions.reduce((total, decision) => total + decision.hunkIds.length, 0)} hunks decided; ${hunks.filter((hunk) => hunk.status === "pending").length} remain pending`, paths: [...touched], createdAt: timestamp() }); run.updatedAt = timestamp(); }
      const draft = state.draftPlans.find((candidate) => candidate.changeSetId === stored.id);
      if (draft) { draft.status = pending ? "waiting-approval" : accepted ? "accepted" : "cancelled"; draft.updatedAt = timestamp(); }
      const agentPlan = state.agentTaskPlans.find((candidate) => candidate.changeSetId === stored.id);
      if (agentPlan) { agentPlan.status = pending ? "waiting-approval" : accepted ? "accepted" : "cancelled"; if (!pending && accepted) agentPlan.acceptedProjectVersion = projectVersion; agentPlan.updatedAt = timestamp(); }
      const resolution = state.issueResolutions.find((candidate) => candidate.changeSetId === stored.id);
      if (resolution) {
        resolution.status = accepted ? "in-revision" : pending ? "in-revision" : "reopened";
        if (!pending && accepted) resolution.acceptedProjectVersion = projectVersion;
        resolution.updatedAt = timestamp();
        if (!pending && !accepted) for (const report of state.reviewReports) for (const issue of report.issues) if (resolution.issueIds.includes(issue.id)) { issue.status = "open"; issue.updatedAt = timestamp(); }
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
    return changeSet;
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
    return {
      contextBefore: content.slice(Math.max(0, selection.from - 1_500), selection.from),
      contextAfter: content.slice(selection.to, selection.to + 1_500),
      ...(section ? { sectionTitle: section.title } : {})
    };
  }
}

function withMemory(skill: string, memory: string): string { return memory ? `${skill}\n\nConfirmed Paper Memory (treat as project facts):\n${memory}` : skill; }

function materializeChange(change: TextChange, hunks: TextHunk[]): string {
  const segment = materializeTextHunks(change.before, hunks);
  if (change.operation === "create") return segment;
  if (change.baseContent === undefined) throw new ApiError(409, "changeset_hunks_unavailable", "This ChangeSet does not contain a complete base snapshot");
  return change.baseContent.slice(0, change.from) + segment + change.baseContent.slice(change.to);
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
