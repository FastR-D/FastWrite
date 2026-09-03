import { describe, expect, test } from "bun:test";
import { McpRegistry } from "@fastwrite/harness-core";
import { McpToolService } from "./mcp-tool-service";

describe("McpToolService input validation", () => {
  test("rejects malformed input before tool execution", async () => {
    const registry = new McpRegistry();
    registry.register({ id: "workspace", name: "Workspace", version: "1.0.0", enabled: true, tools: [{ name: "read", description: "read", inputSchema: { type: "object", required: ["path"] } }] });
    const service = new McpToolService(registry, {} as never);
    await expect(service.call("project", "workspace.read", {}, { allow: ["workspace.read"] })).rejects.toMatchObject({ code: "mcp_input_invalid", status: 400 });
  });
});
