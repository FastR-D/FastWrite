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
      skill: { id: "network-information-security", name: "网络与信息安全", version: "2.0.0", venue: "network-information-security" },
      skillInstructions: "Follow the writing profile.",
      venueInstructions: "Preserve evidence boundaries.",
      steps: ["Complete main.tex"],
      affectedFiles: ["main.tex"],
      targetPath: "main.tex",
      risks: [],
      validation: ["Compile LaTeX"]
    });

    expect(requestPath).toBe("/v1/chat/completions");
    expect(requestBody.response_format).toEqual({ type: "json_object" });
    expect(JSON.stringify(requestBody).toLowerCase()).toContain("json");
    expect(JSON.stringify(requestBody)).toContain("JSON-escape every backslash");
    const messages = requestBody.messages as Array<{ role: string; content: string }>;
    const systemMessage = messages.find((message) => message.role === "system");
    expect(systemMessage?.content).toContain('"maxItems":1');
    expect(systemMessage?.content).toContain('"const":"main.tex"');
    const userMessage = messages.find((message) => message.role === "user");
    expect(userMessage?.content.toLowerCase()).toContain("json");
    expect(result.files[0]?.content).toBe("\\documentclass{article}\n\\begin{document}\nSee \\cite{paper}.\n\\end{document}\n");
  });

  test("uses the Responses wire API for a custom Codex-style provider", async () => {
    let requestPath = "";
    let requestBody: Record<string, unknown> = {};
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestPath = new URL(request.url).pathname;
        requestBody = await request.json() as Record<string, unknown>;
        return Response.json({
          id: "resp_test",
          object: "response",
          created_at: 0,
          status: "completed",
          model: "gpt-5.5",
          output: [{
            id: "msg_test",
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: JSON.stringify({ suggestion: "Continue with verified evidence." }), annotations: [], logprobs: [] }]
          }],
          usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 }
        });
      }
    });
    servers.push(server);

    const provider = new OpenAIAgentProvider("test-key", "gpt-5.5", `http://127.0.0.1:${server.port}/v1`, "responses");
    expect(provider.fileGenerationConcurrency()).toBe(1);
    const result = await provider.complete!({
      intent: "sentence",
      path: "main.tex",
      contextBefore: "Evidence shows",
      contextAfter: "",
      outline: [],
      bibliography: "",
      skill: { id: "network-information-security", name: "网络与信息安全", version: "2.0.0", venue: "network-information-security" },
      skillInstructions: "Follow the writing profile.",
      venueInstructions: "Preserve evidence boundaries."
    });

    expect(requestPath).toBe("/v1/responses");
    expect(requestBody.stream).toBe(true);
    expect(JSON.stringify(requestBody.input).toLowerCase()).toContain("json");
    expect(Array.isArray(requestBody.input)).toBe(true);
    expect((requestBody.text as { format?: { type?: string; strict?: boolean } }).format).toEqual({ type: "json_object" });
    expect(requestBody).not.toHaveProperty("text.verbosity");
    expect(String(requestBody.instructions)).toContain("Schema (fastwrite_completion)");
    expect(result.suggestion).toBe("Continue with verified evidence.");
  });

  test("reads a Codex mirror stream that returns text only in response.completed", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        const completed = {
          type: "response.completed",
          sequence_number: 1,
          response: {
            id: "resp_completed",
            object: "response",
            status: "completed",
            output: [{
              id: "msg_completed",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: JSON.stringify({ suggestion: "Parsed from the completed event." }), annotations: [] }]
            }]
          }
        };
        return new Response(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
      }
    });
    servers.push(server);

    const provider = new OpenAIAgentProvider("test-key", "gpt-5.5", `http://127.0.0.1:${server.port}/v1`, "responses");
    const result = await provider.complete!({
      intent: "sentence",
      path: "main.tex",
      contextBefore: "Evidence shows",
      contextAfter: "",
      outline: [],
      bibliography: "",
      skill: { id: "network-information-security", name: "网络与信息安全", version: "2.0.0", venue: "network-information-security" },
      skillInstructions: "Follow the writing profile.",
      venueInstructions: "Preserve evidence boundaries."
    });

    expect(result.suggestion).toBe("Parsed from the completed event.");
  });

  test("uses the SSE event field when a mirror omits type from delta data", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        const output = JSON.stringify({ suggestion: "Parsed from an untyped mirror delta." });
        return new Response([
          `event: response.created\ndata: ${JSON.stringify({ response: { status: "in_progress", output: [] } })}\n\n`,
          `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: output.slice(0, 20), item_id: "msg_delta", output_index: 0, content_index: 0 })}\n\n`,
          `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: output.slice(20), item_id: "msg_delta", output_index: 0, content_index: 0 })}\n\n`,
          "event: response.completed\ndata: {\"response\":{\"status\":\"completed\",\"output\":[]}}\n\n",
          "data: [DONE]\n\n"
        ].join(""), { headers: { "content-type": "text/event-stream" } });
      }
    });
    servers.push(server);

    const provider = new OpenAIAgentProvider("test-key", "gpt-5.5", `http://127.0.0.1:${server.port}/v1`, "responses");
    const result = await provider.complete!({
      intent: "sentence",
      path: "main.tex",
      contextBefore: "Evidence shows",
      contextAfter: "",
      outline: [],
      bibliography: "",
      skill: { id: "network-information-security", name: "网络与信息安全", version: "2.0.0", venue: "network-information-security" },
      skillInstructions: "Follow the writing profile.",
      venueInstructions: "Preserve evidence boundaries."
    });

    expect(result.suggestion).toBe("Parsed from an untyped mirror delta.");
  });

  test("reads mirror SSE without blank event separators and with split data JSON", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        const output = JSON.stringify({ suggestion: "Parsed from nonstandard SSE framing." });
        const payload = JSON.stringify({ delta: output, item_id: "msg_split", output_index: 0, content_index: 0 });
        const splitAt = Math.floor(payload.length / 2);
        return new Response([
          "event: response.created\n",
          "data: {\"response\":{\"status\":\"in_progress\",\"output\":[]}}\n",
          "event: response.output_text.delta\n",
          `data: ${payload.slice(0, splitAt)}\n`,
          `data: ${payload.slice(splitAt)}\n`,
          "event: response.completed\n",
          "data: {\"response\":{\"status\":\"completed\",\"output\":[]}}\n",
          "data: [DONE]\n"
        ].join(""), { headers: { "content-type": "text/event-stream" } });
      }
    });
    servers.push(server);

    const provider = new OpenAIAgentProvider("test-key", "gpt-5.5", `http://127.0.0.1:${server.port}/v1`, "responses");
    const result = await provider.complete!({
      intent: "sentence", path: "main.tex", contextBefore: "Evidence shows", contextAfter: "", outline: [], bibliography: "",
      skill: { id: "network-information-security", name: "网络与信息安全", version: "2.0.0", venue: "network-information-security" },
      skillInstructions: "Follow the writing profile.", venueInstructions: "Preserve evidence boundaries."
    });

    expect(result.suggestion).toBe("Parsed from nonstandard SSE framing.");
  });

  test("falls back to Chat Completions when a mirror ends Responses without text", async () => {
    const requestPaths: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        requestPaths.push(path);
        if (path.endsWith("/responses")) {
          return new Response([
            "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"status\":\"in_progress\",\"output\":[]}}\n\n",
            "event: response.in_progress\ndata: {\"type\":\"response.in_progress\",\"response\":{\"status\":\"in_progress\",\"output\":[]}}\n\n",
            "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"reasoning\"}}\n\n",
            "data: [DONE]\n\n"
          ].join(""), { headers: { "content-type": "text/event-stream" } });
        }
        const body = await request.json() as { messages?: Array<{ content?: string }> };
        expect(JSON.stringify(body.messages).toLowerCase()).toContain("json");
        return Response.json({
          id: "chatcmpl_fallback", object: "chat.completion", created: 0, model: "gpt-5.5",
          choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ suggestion: "Recovered through Chat Completions." }) }, finish_reason: "stop" }]
        });
      }
    });
    servers.push(server);

    const provider = new OpenAIAgentProvider("test-key", "gpt-5.5", `http://127.0.0.1:${server.port}/v1`, "responses");
    const result = await provider.complete!({
      intent: "sentence", path: "main.tex", contextBefore: "Evidence shows", contextAfter: "", outline: [], bibliography: "",
      skill: { id: "network-information-security", name: "网络与信息安全", version: "2.0.0", venue: "network-information-security" },
      skillInstructions: "Follow the writing profile.", venueInstructions: "Preserve evidence boundaries."
    });

    expect(requestPaths).toEqual(["/v1/responses", "/v1/chat/completions"]);
    expect(result.suggestion).toBe("Recovered through Chat Completions.");
  });
});
