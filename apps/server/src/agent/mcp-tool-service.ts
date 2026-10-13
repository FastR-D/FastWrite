import type { McpAuditRecord, McpPermissionPolicy, McpRegistry } from "@fastwrite/harness-core";
import { isTextFile } from "@fastwrite/shared";
import type { JsonDatabase } from "../storage/database";
import type { WorkspaceService } from "../workspace/workspace-service";
import type { LatexCompileService } from "../compiler/latex-compile-service";
import { ApiError } from "../http";
import { validateMcpInput } from "./mcp-input-schema";

export interface McpExecutionContext {
  signal?: AbortSignal;
  validate?: () => void | Promise<void>;
  authorizePath?: (path: string) => void | Promise<void>;
}

export class McpToolService {
  constructor(private readonly registry: McpRegistry, private readonly workspaces: WorkspaceService, private readonly compiler?: LatexCompileService, private readonly database?: JsonDatabase) {}

  async call(projectId: string, name: string, input: unknown, policy: McpPermissionPolicy, context: McpExecutionContext = {}): Promise<unknown> {
    const startedAt = Date.now();
    let status: McpAuditRecord["status"] = "failed";
    const check = async () => {
      if (context.signal?.aborted) throw new ApiError(499, "mcp_cancelled", "MCP call cancelled");
      await context.validate?.();
      if (context.signal?.aborted) throw new ApiError(499, "mcp_cancelled", "MCP call cancelled");
      if (!this.registry.resolveTool(name, policy)) throw new ApiError(403, "mcp_tool_denied", `MCP tool '${name}' is not allowed`);
    };
    const checkPath = async (path: string) => { await check(); await context.authorizePath?.(path); await check(); };
    try {
      const resolved = this.registry.resolveTool(name, policy);
      if (!resolved) throw new ApiError(403, "mcp_tool_denied", `MCP tool '${name}' is not allowed`);
      validateMcpInput(input, resolved.tool.inputSchema);
      await check();
      let result: unknown;
      if (name === "workspace.read") {
        const path = recordString(input, "path");
        await checkPath(path);
        const file = await this.workspaces.readTextFile(projectId, path);
        result = { path, content: file.content.slice(0, 120_000), version: file.file.version };
        await checkPath(path);
      } else if (name === "workspace.search") {
        const query = recordString(input, "query").toLowerCase();
        const results: Array<{ path: string; excerpts: string[] }> = [];
        for (const path of textPaths(await this.workspaces.tree(projectId))) {
          await checkPath(path);
          const file = await this.workspaces.readTextFile(projectId, path);
          await checkPath(path);
          if (!file.content.toLowerCase().includes(query)) continue;
          results.push({ path, excerpts: file.content.split(/\r?\n/).filter(line => line.toLowerCase().includes(query)).slice(0, 20).map(line => line.slice(0, 4000)) });
          if (results.length >= 50) break;
        }
        // A later read can revoke access to an earlier result.
        for (const item of results) await checkPath(item.path);
        result = { query, results };
      } else if (name === "latex.compile") {
        if (!this.compiler) throw new ApiError(503, "mcp_tool_unavailable", "LaTeX compiler is unavailable");
        result = await this.compiler.compile(projectId, context.signal);
      } else if (name === "research.search") {
        const query = recordString(input, "query");
        if (/\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*\S+|\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{16,}/i.test(query)) throw new ApiError(400, "mcp_sensitive_input", "Remove credentials from the research query");
        throw new ApiError(403, "mcp_approval_required", "External research requires the dedicated research workflow; generic MCP execution cannot approve it");
      } else throw new ApiError(503, "mcp_tool_unavailable", `MCP tool '${name}' has no executor`);
      await check();
      status = "completed";
      return result;
    } catch (error) {
      status = error instanceof ApiError && [401, 403].includes(error.status) ? "denied" : "failed";
      throw error;
    } finally {
      await this.record(projectId, name, status, startedAt);
    }
  }

  audit(projectId?: string): McpAuditRecord[] { return (this.database?.snapshot().mcpAudits ?? []).filter(item => !projectId || item.projectId === projectId).map(item => structuredClone(item)); }
  private async record(projectId: string, tool: string, status: McpAuditRecord["status"], startedAt: number): Promise<void> {
    if (!this.database) return;
    const entry: McpAuditRecord = { id: `mcp_${crypto.randomUUID()}`, projectId, tool, status, durationMs: Date.now() - startedAt, createdAt: new Date().toISOString() };
    await this.database.mutate(state => { state.mcpAudits.push(entry); if (state.mcpAudits.length > 5000) state.mcpAudits.splice(0, state.mcpAudits.length - 5000); });
  }
}
function recordString(input: unknown, key: string): string {
  const value = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>)[key] : undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 500) throw new ApiError(400, "mcp_input_invalid", `${key} must contain 1-500 characters`);
  return value.trim();
}
function textPaths(nodes: any[]): string[] { return nodes.flatMap(node => node.type === "directory" ? textPaths(node.children) : (node.kind === "text" || node.kind === undefined && isTextFile(node.path)) ? [node.path] : []); }
