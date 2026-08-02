import type { AgentRun, ChangeSet, DraftOutlineSection, DraftPlan, DraftPlanResponse, DraftRequest, TextChange } from "@fastwrite/shared";
import { isTextFile, normalizeWorkspacePath } from "@fastwrite/shared";
import { ApiError } from "../http";
import type { JsonDatabase } from "../storage/database";
import type { WorkspaceService } from "../workspace/workspace-service";
import type { AgentProvider, DraftGeneratedFile } from "./provider";
import type { SkillRegistry } from "./skill-registry";
import type { MemoryService } from "./memory-service";
import { createFileChange, replaceFileChange } from "./change-set";
import { isAgentCancellation, runAgentOperation } from "./agent-operation";

function now(): string { return new Date().toISOString(); }

export class DraftService {
  constructor(
    private readonly database: JsonDatabase,
    private readonly workspaces: WorkspaceService,
    private readonly skills: SkillRegistry,
    private readonly provider?: AgentProvider,
    private readonly memories?: MemoryService
  ) {}

  async plan(projectId: string, request: DraftRequest, requestSignal?: AbortSignal): Promise<DraftPlanResponse> {
    if (!this.provider?.planDraft) throw new ApiError(503, "agent_not_configured", "Set OPENAI_API_KEY to enable Draft Agent");
    this.validateRequest(request);
    const normalizedRequest = this.normalizeRequest(request);
    const project = this.workspaces.getProject(projectId);
    const memory = this.memories?.confirmedContext(projectId) ?? { content: "" };
    const loaded = await this.skills.load(project.skill);
    const createdAt = now();
    const run: AgentRun = {
      id: `run_${crypto.randomUUID()}`,
      projectId,
      type: "draft",
      status: "running",
      objective: `Plan a paper draft for: ${(normalizedRequest.brief ?? normalizedRequest.topic ?? "research brief").slice(0, 240)}`,
      skill: structuredClone(project.skill),
      createdAt,
      updatedAt: createdAt,
      steps: [
        { id: "outline", label: "Plan paper structure", status: "running" },
        { id: "draft", label: "Generate section drafts", status: "pending" },
        { id: "approval", label: "Review multi-file changes", status: "pending" }
      ],
      ...(memory.version ? { memoryVersion: memory.version } : {})
    };
    await this.database.mutate((state) => state.agentRuns.push(run));
    try {
      const input = { request: normalizedRequest, skill: project.skill, skillInstructions: withMemory(loaded.instructions, memory.content), venueInstructions: loaded.venueInstructions };
      const result = await runAgentOperation<{ outline: DraftOutlineSection[] }>((signal) => this.provider!.planDraft!(input, signal), { signal: requestSignal, label: "Draft planning" });
      const outline = this.validateOutline(result.outline, project.mainDocument);
      const plan: DraftPlan = {
        id: `draft_${crypto.randomUUID()}`,
        projectId,
        agentRunId: run.id,
        status: "proposed",
        request: normalizedRequest,
        outline,
        createdAt,
        updatedAt: now()
      };
      const updatedRun = await this.database.mutate((state) => {
        state.draftPlans.push(plan);
        const stored = state.agentRuns.find((item) => item.id === run.id)!;
        stored.status = "waiting-approval";
        stored.steps![0]!.status = "completed";
        stored.updatedAt = now();
        return stored;
      });
      return { run: updatedRun, plan };
    } catch (error) {
      await this.fail(run.id, error);
      throw error instanceof ApiError ? error : new ApiError(502, "agent_failed", error instanceof Error ? error.message : "Draft planning failed");
    }
  }

  async confirm(projectId: string, planId: string, outline: DraftOutlineSection[], requestSignal?: AbortSignal): Promise<{ run: AgentRun; plan: DraftPlan; changeSet: ChangeSet }> {
    if (!this.provider?.generateDraft) throw new ApiError(503, "agent_not_configured", "Set OPENAI_API_KEY to enable Draft Agent");
    const plan = this.getPlan(projectId, planId);
    if (plan.status !== "proposed") throw new ApiError(409, "draft_not_proposed", "This draft outline is no longer awaiting confirmation");
    const project = this.workspaces.getProject(projectId);
    const checkedOutline = this.validateOutline(outline, project.mainDocument);
    const loaded = await this.skills.load(project.skill);
    const memory = this.memories?.confirmedContext(projectId) ?? { content: "" };
    await this.database.mutate((state) => {
      const storedPlan = state.draftPlans.find((item) => item.id === planId)!;
      storedPlan.status = "generating";
      storedPlan.outline = checkedOutline;
      storedPlan.updatedAt = now();
      const run = state.agentRuns.find((item) => item.id === plan.agentRunId)!;
      run.status = "running";
      run.steps![1]!.status = "running";
      run.updatedAt = now();
    });
    try {
      const input = {
        request: plan.request,
        outline: checkedOutline,
        mainDocument: project.mainDocument,
        skill: project.skill,
        skillInstructions: withMemory(loaded.instructions, memory.content),
        venueInstructions: loaded.venueInstructions
      };
      const result = await runAgentOperation<{ files: DraftGeneratedFile[] }>((signal) => this.provider!.generateDraft!(input, signal), { signal: requestSignal, defaultTimeoutMs: 300_000, label: "Draft generation" });
      const files = this.validateFiles(result.files, project.mainDocument, checkedOutline);
      if (!files.some((file) => file.path.toLowerCase().endsWith(".bib")) && !await this.workspaces.fileExists(projectId, "references.bib")) {
        files.push({ path: "references.bib", content: "% Add verified BibTeX entries here. Do not invent citations.\n", rationale: "Create an explicit placeholder for verified references." });
      }
      const changes: TextChange[] = [];
      for (const file of files) {
        if (await this.workspaces.fileExists(projectId, file.path)) {
          const opened = await this.workspaces.readTextFile(projectId, file.path);
          changes.push(replaceFileChange(file.path, opened, file.content));
        } else {
          changes.push(createFileChange(file.path, file.content));
        }
      }
      const effectiveChanges = changes.filter((change) => change.hunks?.length);
      if (!effectiveChanges.length) throw new ApiError(502, "draft_no_changes", "Draft Agent did not propose any file changes");
      const changeSet: ChangeSet = {
        id: `change_${crypto.randomUUID()}`,
        projectId,
        agentRunId: plan.agentRunId,
        status: "proposed",
        summary: "Create security paper draft",
        rationale: "Creates the confirmed outline as a minimal, evidence-honest LaTeX draft.",
        changes: effectiveChanges,
        createdAt: now(),
        updatedAt: now()
      };
      const resultState = await this.database.mutate((state) => {
        state.changeSets.push(changeSet);
        const storedPlan = state.draftPlans.find((item) => item.id === planId)!;
        storedPlan.status = "waiting-approval";
        storedPlan.changeSetId = changeSet.id;
        storedPlan.updatedAt = now();
        const run = state.agentRuns.find((item) => item.id === plan.agentRunId)!;
        run.status = "waiting-approval";
        run.changeSetId = changeSet.id;
        run.steps![1]!.status = "completed";
        run.steps![2]!.status = "running";
        run.updatedAt = now();
        return { run, plan: storedPlan };
      });
      return { ...resultState, changeSet };
    } catch (error) {
      await this.database.mutate((state) => {
        const storedPlan = state.draftPlans.find((item) => item.id === planId);
        if (storedPlan) { storedPlan.status = "proposed"; storedPlan.updatedAt = now(); }
      });
      await this.fail(plan.agentRunId, error);
      throw error instanceof ApiError ? error : new ApiError(502, "agent_failed", error instanceof Error ? error.message : "Draft generation failed");
    }
  }

  cancel(projectId: string, planId: string): Promise<DraftPlan> {
    const plan = this.getPlan(projectId, planId);
    if (!new Set(["proposed", "generating"]).has(plan.status)) throw new ApiError(409, "draft_not_cancellable", "This Draft Agent run cannot be cancelled");
    return this.database.mutate((state) => {
      const stored = state.draftPlans.find((item) => item.id === planId)!;
      stored.status = "cancelled";
      stored.updatedAt = now();
      const run = state.agentRuns.find((item) => item.id === stored.agentRunId);
      if (run) { run.status = "cancelled"; run.updatedAt = now(); }
      return stored;
    });
  }

  list(projectId: string): DraftPlan[] {
    return this.database.snapshot().draftPlans.filter((plan) => plan.projectId === projectId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private getPlan(projectId: string, planId: string): DraftPlan {
    const plan = this.database.snapshot().draftPlans.find((item) => item.id === planId && item.projectId === projectId);
    if (!plan) throw new ApiError(404, "draft_not_found", "Draft plan not found");
    return plan;
  }

  private validateRequest(request: DraftRequest): void {
    if (request.brief?.trim()) return;
    if (request.topic?.trim() && request.researchQuestion?.trim() && request.contributions?.some((item) => item.trim())) return;
    throw new ApiError(400, "draft_input_incomplete", "Describe the research question, claimed contributions, constraints, and available evidence in the research brief");
  }

  private normalizeRequest(request: DraftRequest): DraftRequest {
    if (request.brief?.trim()) return { brief: request.brief.trim().slice(0, 20_000) };
    return {
      topic: request.topic!.trim(),
      researchQuestion: request.researchQuestion!.trim(),
      contributions: request.contributions!.map((item) => item.trim()).filter(Boolean),
      ...(request.materials?.trim() ? { materials: request.materials.trim() } : {})
    };
  }

  private validateOutline(outline: DraftOutlineSection[], mainDocument: string): DraftOutlineSection[] {
    if (!Array.isArray(outline) || outline.length < 5) throw new ApiError(400, "draft_outline_incomplete", "The outline must contain at least five sections");
    const normalized = outline.map((section) => ({ ...section, path: normalizeWorkspacePath(section.path), title: section.title.trim(), purpose: section.purpose.trim() }));
    if (normalized.some((section) => !section.title || !section.purpose || !section.path.endsWith(".tex") || section.path === mainDocument)) {
      throw new ApiError(400, "draft_outline_invalid", "Each section needs a unique .tex path, title, and purpose");
    }
    if (new Set(normalized.map((section) => section.path)).size !== normalized.length) throw new ApiError(400, "draft_outline_duplicate", "Draft section paths must be unique");
    const titles = normalized.map((section) => section.title.toLowerCase()).join(" ");
    for (const required of ["abstract", "introduction", "evaluation", "conclusion"]) {
      if (!titles.includes(required)) throw new ApiError(400, "draft_outline_incomplete", `The outline must include ${required}`);
    }
    if (!/(method|design|approach|system)/.test(titles)) throw new ApiError(400, "draft_outline_incomplete", "The outline must include a method or design section");
    return normalized;
  }

  private validateFiles(files: DraftGeneratedFile[], mainDocument: string, outline: DraftOutlineSection[]): DraftGeneratedFile[] {
    const normalized = files.map((file) => ({ ...file, path: normalizeWorkspacePath(file.path) }));
    const required = new Set([mainDocument, ...outline.map((section) => section.path)]);
    if (new Set(normalized.map((file) => file.path)).size !== normalized.length || normalized.some((file) => !isTextFile(file.path) || !file.content.trim())) {
      throw new ApiError(502, "draft_files_invalid", "Draft Agent returned duplicate, binary, or empty files");
    }
    for (const path of required) if (!normalized.some((file) => file.path === path)) throw new ApiError(502, "draft_files_incomplete", `Draft Agent did not return '${path}'`);
    return normalized;
  }

  private fail(runId: string, error: unknown): Promise<void> {
    return this.database.mutate((state) => {
      const run = state.agentRuns.find((item) => item.id === runId);
      if (run) {
        run.status = isAgentCancellation(error) ? "cancelled" : "failed";
        run.error = error instanceof Error ? error.message : "Draft Agent failed";
        run.steps?.forEach((step) => { if (step.status === "running") step.status = "failed"; });
        run.updatedAt = now();
      }
    });
  }
}

function withMemory(skill: string, memory: string): string { return memory ? `${skill}\n\nConfirmed Paper Memory (treat as project facts):\n${memory}` : skill; }
