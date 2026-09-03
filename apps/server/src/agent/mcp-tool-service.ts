import type { McpPermissionPolicy, McpRegistry } from "@fastwrite/harness-core";
import type { JsonDatabase } from "../storage/database";
import type { WorkspaceService } from "../workspace/workspace-service";
import type { LatexCompileService } from "../compiler/latex-compile-service";
import { ApiError } from "../http";
import type { McpAuditRecord } from "@fastwrite/harness-core";

export class McpToolService {
  constructor(private readonly registry: McpRegistry, private readonly workspaces: WorkspaceService, private readonly compiler?: LatexCompileService, private readonly database?: JsonDatabase) {}
  async call(projectId: string, name: string, input: unknown, policy: McpPermissionPolicy): Promise<unknown> {
    const startedAt = Date.now();
    const resolved = this.registry.resolveTool(name, policy);
    if (!resolved) { this.record(projectId, name, "denied", startedAt); throw new ApiError(403, "mcp_tool_denied", `MCP tool '${name}' is not permitted by the active policy`); }
    validateSchema(input, resolved.tool.inputSchema);
    if (name === "workspace.read") {
      const path = recordString(input, "path");
      const file = await this.workspaces.readTextFile(projectId, path);
      const result = { path, content: file.content.slice(0, 120_000), version: file.file.version }; this.record(projectId, name, "completed", startedAt); return result;
    }
    if (name === "workspace.search") {
      const query = recordString(input, "query").toLowerCase();
      const results: Array<{ path: string; excerpts: string[] }> = [];
      for (const path of textPaths(await this.workspaces.tree(projectId))) {
        const file = await this.workspaces.readTextFile(projectId, path);
        if (!file.content.toLowerCase().includes(query)) continue;
        results.push({ path, excerpts: file.content.split(/\r?\n/).filter((line) => line.toLowerCase().includes(query)).slice(0, 20) });
        if (results.length >= 50) break;
      }
      const result = { query, results }; this.record(projectId, name, "completed", startedAt); return result;
    }
    if (name === "latex.compile") {
      if (!this.compiler) throw new ApiError(503, "mcp_tool_unavailable", "LaTeX compiler is unavailable");
      const result = await this.compiler.compile(projectId); this.record(projectId, name, "completed", startedAt); return result;
    }
    throw new Error(`MCP tool '${name}' has no executor`);
  }
  audit(projectId?: string): McpAuditRecord[] { return (this.database?.snapshot().mcpAudits ?? []).filter((item) => !projectId || item.projectId === projectId).map((item) => structuredClone(item)); }
  private record(projectId: string, tool: string, status: McpAuditRecord["status"], startedAt: number): void { const item = { id: `mcp_${crypto.randomUUID()}`, projectId, tool, status, durationMs: Date.now() - startedAt, createdAt: new Date().toISOString() }; if (this.database) void this.database.mutate((state) => { state.mcpAudits.push(item); if (state.mcpAudits.length > 5000) state.mcpAudits.splice(0, state.mcpAudits.length - 5000); }).catch(() => undefined); }
}

function recordString(value: unknown, key: string): string { const candidate = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined; if (typeof candidate !== "string" || !candidate.trim()) throw new ApiError(400, "mcp_input_invalid", `${key} is required`); return candidate.trim().slice(0, 500); }
function validateSchema(input: unknown, schema: Record<string, unknown>): void {
  if (schema.type === "object" && (input === null || typeof input !== "object" || Array.isArray(input))) throw new ApiError(400, "mcp_input_invalid", "input must be an object");
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : [];
  for (const key of required) if (!(input as Record<string, unknown>)[key]) throw new ApiError(400, "mcp_input_invalid", `${key} is required`);
}
function textPaths(nodes: Array<{ type: string; path: string; children?: Array<{ type: string; path: string; children?: any[] }> }>): string[] { return nodes.flatMap((node) => node.type === "directory" ? textPaths(node.children ?? []) : [node.path]); }
