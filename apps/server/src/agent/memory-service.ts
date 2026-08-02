import type { MemoryItem, MemoryItemStatus, PaperMemory, WorkspaceTreeNode } from "@fastwrite/shared";
import { ApiError } from "../http";
import type { JsonDatabase } from "../storage/database";
import type { WorkspaceService } from "../workspace/workspace-service";
import type { AgentProvider } from "./provider";
import type { SkillRegistry } from "./skill-registry";

function now() { return new Date().toISOString(); }
function textPaths(nodes: WorkspaceTreeNode[]): string[] { return nodes.flatMap((node) => node.type === "directory" ? textPaths(node.children) : node.kind === "text" ? [node.path] : []); }

export class MemoryService {
  constructor(private readonly database: JsonDatabase, private readonly workspaces: WorkspaceService, private readonly skills: SkillRegistry, private readonly provider?: AgentProvider) {}

  latest(projectId: string): PaperMemory | null {
    const latest = this.database.snapshot().paperMemories.filter((memory) => memory.projectId === projectId).sort((a, b) => b.version - a.version)[0];
    if (!latest) return null;
    const versions = this.database.snapshot().fileVersions[projectId] ?? {};
    latest.items.forEach((item) => {
      if (item.status === "confirmed" && item.sources.some((source) => versions[source.path]?.version !== source.fileVersion)) item.status = "stale";
    });
    return latest;
  }

  async extract(projectId: string): Promise<PaperMemory> {
    if (!this.provider?.extractMemory) throw new ApiError(503, "agent_not_configured", "Set OPENAI_API_KEY to generate Paper Memory");
    const project = this.workspaces.getProject(projectId);
    const documents = await Promise.all(textPaths(await this.workspaces.tree(projectId)).map(async (path) => {
      const opened = await this.workspaces.readTextFile(projectId, path);
      return { path, content: opened.content, version: opened.file.version };
    }));
    const skill = await this.skills.load(project.skill);
    const result = await this.provider.extractMemory({ documents, skill: project.skill, skillInstructions: skill.instructions, venueInstructions: skill.venueInstructions });
    const documentMap = new Map(documents.map((document) => [document.path, document]));
    const timestamp = now();
    const proposed: MemoryItem[] = result.items.flatMap((item) => {
      const sources = item.sources.flatMap((source) => {
        const document = documentMap.get(source.path);
        const excerpt = source.excerpt.trim().slice(0, 1_000);
        const offset = document?.content.indexOf(excerpt) ?? -1;
        if (!document || !excerpt || offset < 0) return [];
        return [{ path: source.path, line: document.content.slice(0, offset).split("\n").length, ...(source.section ? { section: source.section } : {}), excerpt, fileVersion: document.version }];
      });
      if (!sources.length || !item.content.trim()) return [];
      return [{ id: `memory_item_${crypto.randomUUID()}`, category: item.category, label: item.label.trim(), content: item.content.trim(), status: "suggested" as const, sources, createdAt: timestamp, updatedAt: timestamp }];
    });
    const previous = this.latest(projectId);
    const preserved = previous?.items.filter((item) => item.status === "confirmed" || item.status === "stale").map((item) => structuredClone(item)) ?? [];
    const memory: PaperMemory = { id: `memory_${crypto.randomUUID()}`, projectId, version: (previous?.version ?? 0) + 1, projectVersion: project.version, items: [...preserved, ...proposed], createdAt: timestamp, updatedAt: timestamp };
    return this.database.mutate((state) => { state.paperMemories.push(memory); return memory; });
  }

  updateItem(projectId: string, itemId: string, updates: { status?: MemoryItemStatus; content?: string; label?: string }): Promise<PaperMemory> {
    const latest = this.latest(projectId);
    if (!latest) throw new ApiError(404, "paper_memory_not_found", "Generate Paper Memory first");
    const item = latest.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new ApiError(404, "memory_item_not_found", "Paper Memory item not found");
    if (updates.content !== undefined && !updates.content.trim()) throw new ApiError(400, "memory_content_empty", "Memory content cannot be empty");
    if (updates.status) item.status = updates.status;
    if (updates.content !== undefined) item.content = updates.content.trim();
    if (updates.label !== undefined && updates.label.trim()) item.label = updates.label.trim();
    item.updatedAt = now();
    return this.saveVersion(latest);
  }

  rollback(projectId: string): Promise<PaperMemory> {
    const memories = this.database.snapshot().paperMemories.filter((memory) => memory.projectId === projectId).sort((a, b) => b.version - a.version);
    if (memories.length < 2) throw new ApiError(409, "memory_no_previous_version", "Paper Memory has no previous version");
    return this.saveVersion(memories[1]!);
  }

  confirmedContext(projectId: string): { version?: number; content: string } {
    const latest = this.latest(projectId);
    if (!latest) return { content: "" };
    const items = latest.items.filter((item) => item.status === "confirmed");
    return { version: latest.version, content: items.map((item) => `[${item.category}] ${item.label}: ${item.content}`).join("\n") };
  }

  private saveVersion(source: PaperMemory): Promise<PaperMemory> {
    const project = this.workspaces.getProject(source.projectId);
    const latestVersion = Math.max(0, ...this.database.snapshot().paperMemories.filter((memory) => memory.projectId === source.projectId).map((memory) => memory.version));
    const saved: PaperMemory = { ...structuredClone(source), id: `memory_${crypto.randomUUID()}`, version: latestVersion + 1, projectVersion: project.version, createdAt: now(), updatedAt: now() };
    return this.database.mutate((state) => { state.paperMemories.push(saved); return saved; });
  }
}
