import type { CompletionRequest, CompletionResponse, OutlineItem, WorkspaceTreeNode } from "@fastwrite/shared";
import { ApiError } from "../http";
import type { WorkspaceService } from "../workspace/workspace-service";
import type { AgentProvider } from "./provider";
import type { AgentGateway } from "./agent-gateway";
import type { SkillRegistry } from "./skill-registry";
import type { MemoryService } from "./memory-service";

const COMPLETION_KINDS = new Set(["auto"]);
const BEFORE_LIMIT = 2_500;
const AFTER_LIMIT = 600;
const BIBLIOGRAPHY_LIMIT = 8_000;
const SUGGESTION_LIMIT = 2_000;

function textPaths(nodes: WorkspaceTreeNode[]): string[] {
  return nodes.flatMap((node) => node.type === "directory" ? textPaths(node.children) : node.kind === "text" ? [node.path] : []);
}

function outlineTitles(items: OutlineItem[]): string[] {
  return items.flatMap((item) => [item.title, ...outlineTitles(item.children)]);
}

function activeSectionTitle(items: OutlineItem[], path: string, line: number): string | undefined {
  return items
    .flatMap((item) => [item, ...flattenOutline(item.children)])
    .filter((item) => item.path === path && item.line <= line)
    .sort((left, right) => right.line - left.line)[0]?.title;
}

function flattenOutline(items: OutlineItem[]): OutlineItem[] {
  return items.flatMap((item) => [item, ...flattenOutline(item.children)]);
}

export class CompletionService {
  constructor(
    private readonly workspaces: WorkspaceService,
    private readonly skills: SkillRegistry,
    private readonly provider: AgentProvider | AgentGateway | undefined,
    private readonly memories: MemoryService
  ) {}

  private get agent(): AgentProvider | undefined { return this.provider && "provider" in this.provider ? this.provider.provider : this.provider; }

  async suggest(projectId: string, request: CompletionRequest): Promise<CompletionResponse> {
    if (!this.agent?.complete) throw new ApiError(503, "completion_not_configured", "Configure a Harness to use writing completion");
    if (!COMPLETION_KINDS.has(request.kind)) throw new ApiError(400, "completion_kind_invalid", "Unknown completion kind");
    if (!Number.isInteger(request.cursor) || request.cursor < 0 || !Number.isInteger(request.fileVersion) || request.fileVersion < 1) {
      throw new ApiError(400, "completion_position_invalid", "Completion cursor and file version must be positive integers");
    }

    const project = this.workspaces.getProject(projectId);
    const opened = await this.workspaces.readTextFile(projectId, request.path);
    if (opened.file.version !== request.fileVersion) {
      throw new ApiError(409, "completion_stale", "The file changed before completion was generated", { currentVersion: opened.file.version });
    }
    if (request.cursor > opened.content.length) throw new ApiError(400, "completion_cursor_invalid", "Completion cursor is outside the file");

    const [skill, workflowInstructions, outline, paths] = await Promise.all([
      this.skills.load(project.skill, project.publicationTarget),
      this.skills.loadWorkflow("completion"),
      this.workspaces.outline(projectId),
      this.workspaces.tree(projectId).then(textPaths)
    ]);
    const bibliographyParts = await Promise.all(paths.filter((path) => path.toLowerCase().endsWith(".bib")).map(async (path) => {
      const file = await this.workspaces.readTextFile(projectId, path);
      return `% ${path}\n${file.content}`;
    }));
    const cursorLine = opened.content.slice(0, request.cursor).split("\n").length;
    const memory = await this.memories.focusedWriterContext(projectId, opened.file.path, activeSectionTitle(outline, opened.file.path, cursorLine));
    const memoryInstructions = memory.content ? `\n\nLocal Paper Context (paper core and current section only):\n${memory.content}` : "";
    const contextBefore = opened.content.slice(Math.max(0, request.cursor - BEFORE_LIMIT), request.cursor);
    const contextAfter = opened.content.slice(request.cursor, request.cursor + AFTER_LIMIT);
    const result = await this.agent.complete({
      intent: inferCompletionIntent(opened.file.path, contextBefore),
      path: opened.file.path,
      contextBefore,
      contextAfter,
      ...(memory.content ? { paperContext: memory.content } : {}),
      outline: outlineTitles(outline),
      bibliography: bibliographyParts.join("\n\n").slice(0, BIBLIOGRAPHY_LIMIT),
      skill: project.skill,
      skillInstructions: `${workflowInstructions}\n\n${skill.instructions}${memoryInstructions}`,
      venueInstructions: skill.venueInstructions
    });

    return {
      suggestion: String(result.suggestion ?? "").slice(0, SUGGESTION_LIMIT),
      path: opened.file.path,
      cursor: request.cursor,
      fileVersion: opened.file.version,
      kind: request.kind
    };
  }
}

export type CompletionIntent = "sentence" | "latex" | "formula" | "citation";

export function inferCompletionIntent(path: string, before: string): CompletionIntent {
  if (path.toLowerCase().endsWith(".bib")) return "citation";
  const mathDelimiters = (before.match(/(?<!\\)\$/g) ?? []).length;
  if (mathDelimiters % 2 === 1 || /\\begin\{(?:equation|align|gather|multline)\*?\}[^]*$/m.test(before) && !/\\end\{(?:equation|align|gather|multline)\*?\}[^]*$/m.test(before)) return "formula";
  if (/\\(?:begin|end|cite|ref|label|includegraphics|input|include|section|subsection)\*?(?:\[[^\]]*\])?\{[^}]*$/m.test(before) || /\\[A-Za-z@]*$/.test(before)) return "latex";
  return "sentence";
}
