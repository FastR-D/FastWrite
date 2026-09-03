import { expect, test } from "bun:test";
import { McpRegistry } from "./mcp";

test("MCP registry enforces allow and deny policies", () => {
  const registry = new McpRegistry();
  registry.register({ id: "workspace", name: "Workspace", version: "1.0.0", enabled: true, tools: [{ name: "read", description: "read", inputSchema: { type: "object" } }] });
  expect(registry.resolveTool("workspace.read", { allow: ["workspace.*"] })?.tool.name).toBe("read");
  expect(registry.resolveTool("workspace.read", { allow: ["workspace.*"], deny: ["workspace.read"] })).toBeUndefined();
  expect(() => registry.register({ id: "workspace", name: "Duplicate", version: "1", enabled: true, tools: [] })).toThrow();
});
