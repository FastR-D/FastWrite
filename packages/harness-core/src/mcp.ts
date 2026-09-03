export interface McpToolDefinition { name: string; description: string; inputSchema: Record<string, unknown> }
export interface McpServerDefinition { id: string; name: string; version: string; tools: McpToolDefinition[]; enabled: boolean }
export interface McpPermissionPolicy { allow: string[]; deny?: string[] }
export interface McpAuditRecord { id: string; projectId: string; tool: string; status: "completed" | "denied" | "failed"; durationMs: number; createdAt: string }

export class McpRegistry {
  readonly #servers = new Map<string, McpServerDefinition>();
  register(server: McpServerDefinition): void {
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(server.id)) throw new Error("Invalid MCP server id");
    if (this.#servers.has(server.id)) throw new Error(`Duplicate MCP server: ${server.id}`);
    this.#servers.set(server.id, structuredClone(server));
  }
  list(): McpServerDefinition[] { return [...this.#servers.values()].map((server) => structuredClone(server)); }
  resolveTool(name: string, policy: McpPermissionPolicy): { server: McpServerDefinition; tool: McpToolDefinition } | undefined {
    if (policy.deny?.some((pattern) => matches(pattern, name))) return undefined;
    if (!policy.allow.some((pattern) => matches(pattern, name))) return undefined;
    for (const server of this.#servers.values()) {
      const tool = server.tools.find((candidate) => `${server.id}.${candidate.name}` === name);
      if (tool && server.enabled) return { server: structuredClone(server), tool: structuredClone(tool) };
    }
    return undefined;
  }
}

function matches(pattern: string, value: string): boolean {
  if (pattern === value || pattern === "*") return true;
  if (pattern.endsWith(".*")) return value.startsWith(pattern.slice(0, -1));
  return false;
}
