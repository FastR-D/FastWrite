import {
  normalizeWorkspacePath,
  type ChangeSet,
  type AgentRun,
  type LatexDiagnostic,
} from "@fastwrite/shared";
import type { AgentProvider } from "./provider";
import type { WorkspaceService } from "../workspace/workspace-service";
import type {
  LatexCompileService,
  ServerCompileResult,
} from "../compiler/latex-compile-service";
import type { JsonDatabase } from "../storage/database";
import { replaceFileChange } from "./change-set";
import { ApiError } from "../http";

export interface AssistantStepInput {
  objective: string;
  tools: string[];
  observation: unknown;
  history: Array<{ action: string; result: unknown }>;
}
export interface AssistantStepOutput {
  action: "read_file" | "compile" | "propose_edit" | "finish";
  path: string;
  oldText: string;
  newText: string;
  explanation: string;
}
export interface CompileAssistantResult {
  run: AgentRun;
  changeSet?: ChangeSet;
  explanation: string;
  validated: boolean;
  diagnostics: LatexDiagnostic[];
  steps: Array<{ action: string; result: unknown }>;
}
/** Model tools act on an isolated candidate. Real text only changes through ChangeSet approval. */
export class CompileAssistantService {
  private readonly active = new Set<string>();
  constructor(
    private readonly database: JsonDatabase,
    private readonly workspaces: WorkspaceService,
    private readonly compiler: LatexCompileService,
    private readonly provider: AgentProvider,
  ) {}
  async run(
    projectId: string,
    request: {
      objective?: string;
      diagnosticId?: string;
      lightweight?: boolean;
      expectedVersion: number;
    },
    signal: AbortSignal,
    validate: () => Promise<void>,
    actorUserId?: string,
  ): Promise<CompileAssistantResult> {
    if (this.active.has(projectId))
      throw new ApiError(
        409,
        "compile_assistant_busy",
        "该项目已有编译助手任务",
      );
    if (!this.provider.assistantStep)
      throw new ApiError(
        503,
        "agent_not_configured",
        "请先配置支持结构化输出的模型",
      );
    await validate();
    const project = this.workspaces.getProject(projectId);
    if (request.expectedVersion !== project.version)
      throw new ApiError(
        409,
        "compile_assistant_stale",
        "项目版本已变化，请保存后重试",
      );
    if (this.active.size >= 8)
      throw new ApiError(
        429,
        "compile_assistant_capacity",
        "编译助手繁忙，请稍后重试",
      );
    this.active.add(projectId);
    const createdAt = new Date().toISOString();
    const run: AgentRun = {
      id: `run_${crypto.randomUUID()}`,
      projectId,
      type: "revise",
      status: "running",
      objective:
        request.objective?.trim().slice(0, 2000) ||
        "检查编译错误并提出最小修复",
      skill: project.skill,
      ...(project.publicationTarget
        ? { publicationTarget: project.publicationTarget }
        : {}),
      createdAt,
      updatedAt: createdAt,
      auditTrail: [],
    };
    const originals = new Map<
        string,
        Awaited<ReturnType<WorkspaceService["readTextFile"]>>
      >(),
      candidate = new Map<string, string>();
    const history: Array<{ action: string; result: unknown }> = [];
    let explanation = "",
      verified = false,
      result: ServerCompileResult | undefined;
    const check = async () => {
      signal.throwIfAborted();
      await validate();
      if (this.workspaces.getProject(projectId).version !== project.version)
        throw new ApiError(
          409,
          "compile_assistant_stale",
          "项目在检查期间已变化，请重新运行",
        );
    };
    const compile = async () => {
      await check();
      const output = await this.compiler.compile(
        projectId,
        signal,
        candidate.size
          ? {
              expectedVersion: project.version,
              files: [...candidate].map(([path, content]) => ({
                path,
                content,
              })),
            }
          : undefined,
      );
      await check();
      return output;
    };
    try {
      await this.database.mutate((state) => state.agentRuns.push(run));
      result = this.compiler.latest(projectId) as
        | ServerCompileResult
        | undefined;
      if (!result || result.projectVersion !== project.version)
        result = await compile();
      const target = request.diagnosticId
        ? result.diagnostics?.find((item) => item.id === request.diagnosticId)
        : result.diagnostics?.find((item) => item.severity === "error");
      if (request.diagnosticId && !target)
        throw new ApiError(
          409,
          "compile_diagnostic_stale",
          "所选错误已变化，请重新编译并选择",
        );
      const targetPath = target?.path ?? project.mainDocument;
      const read = async (rawPath: string) => {
        const path = normalizeWorkspacePath(rawPath);
        if (!/\.(tex|sty|cls|bib)$/i.test(path))
          throw new ApiError(
            400,
            "assistant_file_invalid",
            "编译助手仅处理 LaTeX 源文件",
          );
        if (request.lightweight && path !== targetPath)
          throw new ApiError(
            400,
            "assistant_scope_exceeded",
            "单条错误修复不能修改其他文件，请使用完整编译助手",
          );
        await check();
        const opened =
          originals.get(path) ??
          (await this.workspaces.readTextFile(projectId, path));
        originals.set(path, opened);
        const content = candidate.get(path) ?? opened.content;
        if (content.length > 120_000)
          throw new ApiError(
            413,
            "assistant_file_too_large",
            "文件过大，请使用局部精修",
          );
        return { path, version: opened.file.version, content };
      };
      const initial = await read(targetPath);
      let observation: unknown = {
        compile: summarize(result),
        source: initial,
        selectedDiagnostic: target,
        mainDocument: project.mainDocument,
      };
      let compileCount = 0;
      for (let step = 0; step < (request.lightweight ? 4 : 10); step++) {
        await check();
        const output = await this.provider.assistantStep(
          {
            objective: `${run.objective}\n${request.lightweight ? "Fix only the selected diagnostic, within 60 lines of its location, at most 30 changed lines. Preserve all prose and facts." : "Use read_file, propose_edit and compile to inspect and fix the project. Keep edits minimal. Never invent claims or citations."}`,
            tools: ["read_file", "propose_edit", "compile", "finish"],
            observation,
            history: history.map((item) => ({
              action: item.action,
              result:
                item.action === "read_file"
                  ? {
                      path: (item.result as { path?: string }).path,
                      readPreviously: true,
                    }
                  : item.result,
            })),
          },
          signal,
        );
        await check();
        if (
          !output ||
          !["read_file", "compile", "propose_edit", "finish"].includes(
            output.action,
          )
        )
          throw new ApiError(
            502,
            "assistant_output_invalid",
            "模型返回了不支持的操作",
          );
        if (
          ["read_file", "propose_edit"].includes(output.action) &&
          typeof output.path !== "string"
        )
          throw new ApiError(
            502,
            "assistant_output_invalid",
            "模型未返回有效文件路径",
          );
        explanation = String(output.explanation ?? "").slice(0, 4000);
        if (output.action === "finish") break;
        if (output.action === "read_file")
          observation = await read(output.path);
        else if (output.action === "compile") {
          if (++compileCount > 3) break;
          result = await compile();
          verified = candidate.size > 0 && result.success;
          observation = summarize(result);
        } else {
          if (candidate.size >= 5 && !candidate.has(output.path))
            throw new ApiError(
              400,
              "assistant_file_limit",
              "一次最多修改五个文件",
            );
          const source = await read(output.path),
            before = output.oldText,
            after = output.newText;
          if (
            typeof before !== "string" ||
            typeof after !== "string" ||
            !before ||
            before === after ||
            before.length > 20_000 ||
            after.length > 24_000
          )
            throw new ApiError(
              502,
              "assistant_patch_invalid",
              "模型未返回有效的最小修改",
            );
          const offset = source.content.indexOf(before);
          if (offset < 0 || source.content.indexOf(before, offset + 1) >= 0)
            throw new ApiError(
              409,
              "assistant_patch_ambiguous",
              "修复原文不唯一或已变化，未写入正文",
            );
          const line = source.content.slice(0, offset).split("\n").length;
          if (
            request.lightweight &&
            (Math.max(before.split("\n").length, after.split("\n").length) >
              30 ||
              (target?.line && Math.abs(line - target.line) > 60))
          )
            throw new ApiError(
              400,
              "assistant_patch_too_broad",
              "修复超出单条错误范围，请使用完整编译助手",
            );
          candidate.set(
            source.path,
            source.content.slice(0, offset) +
              after +
              source.content.slice(offset + before.length),
          );
          verified = false;
          observation = {
            path: source.path,
            candidateUpdated: true,
            needsCompile: true,
          };
        }
        history.push({ action: output.action, result: observation });
      }
      if (candidate.size && !verified) {
        result = await compile();
        verified = result.success;
        history.push({ action: "compile", result: summarize(result) });
      }
      await check();
      const changes = [...candidate]
        .filter(([path, content]) => content !== originals.get(path)!.content)
        .map(([path, content]) =>
          replaceFileChange(path, originals.get(path)!, content),
        );
      // A lightweight fix is offered only when its isolated candidate compiles successfully.
      if (request.lightweight && changes.length && !verified)
        throw new ApiError(
          422,
          "compile_fix_unverified",
          "候选未通过编译，正文未改动。可使用完整编译助手继续排查。",
          { diagnostics: result?.diagnostics },
        );
      const changeSet: ChangeSet | undefined = changes.length
        ? {
            id: `change_${crypto.randomUUID()}`,
            projectId,
            agentRunId: run.id,
            status: "proposed",
            summary: request.lightweight
              ? "编译错误最小修复（已验证）"
              : "编译助手候选修改",
            rationale: explanation,
            changes,
            createdAt,
            updatedAt: new Date().toISOString(),
          }
        : undefined;
      await this.database.mutate((state) => {
        signal.throwIfAborted();
        if (changeSet) state.changeSets.push(changeSet);
        const stored = state.agentRuns.find((item) => item.id === run.id)!;
        stored.status = changeSet ? "waiting-approval" : "completed";
        if (changeSet) stored.changeSetId = changeSet.id;
        stored.updatedAt = new Date().toISOString();
        stored.auditTrail = history.map((item) => ({
          id: `audit_${crypto.randomUUID()}`,
          action:
            item.action === "compile"
              ? ("compile" as const)
              : ("context-read" as const),
          summary: `编译助手：${item.action}`,
          createdAt: new Date().toISOString(),
        }));
      });
      return {
        run: this.database
          .snapshot()
          .agentRuns.find((item) => item.id === run.id)!,
        ...(changeSet ? { changeSet } : {}),
        explanation,
        validated: verified,
        diagnostics: result?.diagnostics ?? [],
        steps: history,
      };
    } catch (error) {
      await this.database.mutate((state) => {
        const stored = state.agentRuns.find((item) => item.id === run.id);
        if (stored) {
          stored.status = signal.aborted ? "cancelled" : "failed";
          stored.error =
            error instanceof Error ? error.message : "编译助手失败";
        }
      });
      throw error;
    } finally {
      this.active.delete(projectId);
    }
  }
}
function summarize(result: ServerCompileResult) {
  return {
    success: result.success,
    projectVersion: result.projectVersion,
    compiler: result.compiler,
    environmentId: result.environmentId,
    diagnostics: result.diagnostics ?? [],
    log: result.log.slice(-16_000),
    error: result.error,
    workspacePaths: result.workspacePaths,
  };
}
