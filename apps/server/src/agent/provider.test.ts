import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { OpenAIAgentProvider } from "./provider";

const servers: Server<unknown>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("OpenAIAgentProvider compatible endpoints", () => {
  test("uses chat JSON mode and preserves LaTeX in generated Agent files", async () => {
    let requestPath = "";
    let requestBody: Record<string, unknown> = {};
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestPath = new URL(request.url).pathname;
        requestBody = await request.json() as Record<string, unknown>;
        return Response.json({
          id: "chatcmpl_test",
          object: "chat.completion",
          created: 0,
          model: "test-model",
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                files: [{
                  path: "main.tex",
                  content: "\\documentclass{article}\n\\begin{document}\nSee \\cite{paper}.\n\\end{document}\n",
                  rationale: "Completes the approved plan."
                }]
              })
            },
            finish_reason: "stop"
          }]
        });
      }
    });
    servers.push(server);

    const provider = new OpenAIAgentProvider("test-key", "test-model", `http://127.0.0.1:${server.port}/v1`);
    const result = await provider.generateAgentTask!({
      objective: "Complete the paper",
      intent: "continue",
      scope: { type: "project" },
      issues: [],
      documents: [{ path: "main.tex", content: "TODO", version: 1 }],
      skill: { id: "security-top4", name: "Security Top-4", version: "1.0.0", venue: "security-top4" },
      skillInstructions: "Follow the writing profile.",
      venueInstructions: "Preserve evidence boundaries.",
      steps: ["Complete main.tex"],
      affectedFiles: ["main.tex"],
      risks: [],
      validation: ["Compile LaTeX"]
    });

    expect(requestPath).toBe("/v1/chat/completions");
    expect(requestBody.response_format).toEqual({ type: "json_object" });
    expect(JSON.stringify(requestBody)).toContain("JSON-escape every backslash");
    expect(result.files[0]?.content).toBe("\\documentclass{article}\n\\begin{document}\nSee \\cite{paper}.\n\\end{document}\n");
  });
});
