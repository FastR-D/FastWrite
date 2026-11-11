import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../app";
import type { AgentProvider } from "../agent/provider";
import type { ServerCompileResult } from "../compiler/latex-compile-service";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup(
  options: {
    authenticated?: boolean;
    provider?: AgentProvider;
    compiler?: { compile: (...args: any[]) => Promise<ServerCompileResult> };
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "fastwrite-latex-workflows-"));
  roots.push(root);
  const app = await createApplication(root, {
    features: { serverAuth: options.authenticated ?? false },
    ...(options.authenticated
      ? {
          bootstrapAdmin: {
            email: "platform@example.test",
            password: "integration-bootstrap-password",
          },
        }
      : {}),
    ...(options.provider ? { agentProvider: options.provider } : {}),
    ...(options.compiler ? { latexCompiler: options.compiler } : {}),
  });
  const request = (
    path: string,
    body?: unknown,
    token?: string,
    method = body === undefined ? "GET" : "POST",
  ) =>
    app(
      new Request(`http://fastwrite.test${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const user = (await (
    await request("/api/auth/register", {
      email: "owner@example.test",
      password: "long-unique-test-password",
    })
  ).json()) as any;
  const project = (await (
    await request("/api/projects", { name: "Language services" }, user.token)
  ).json()) as any;
  return { app, request, user, project };
}
test("official MCP client initializes, lists tools, reads files, proposes edits and honors revocation and project scope", async () => {
  const { app, request, user, project } = await setup({ authenticated: true });
  const tokenResponse = await request(
    `/api/projects/${project.id}/mcp-tokens`,
    { name: "test", scopes: ["read", "propose"], days: 1 },
    user.token,
  );
  expect(tokenResponse.status).toBe(201);
  const access = (await tokenResponse.json()) as any;
  const fetcher: typeof fetch = (async (input: any, init?: RequestInit) =>
    app(
      input instanceof Request
        ? new Request(input, init)
        : new Request(String(input), init),
    )) as typeof fetch;
  const client = new Client({ name: "integration-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://fastwrite.test/api/projects/${project.id}/mcp`),
      {
        requestInit: { headers: { authorization: `Bearer ${access.token}` } },
        fetch: fetcher,
      },
    ),
  );
  expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
    "propose_edit",
  );
  const fileResult = (await client.callTool({
    name: "read_file",
    arguments: { path: "main.tex" },
  })) as any;
  const file = JSON.parse(fileResult.content[0].text);
  expect(file.content).toContain("document");
  const oldText = file.content.slice(0, 20);
  const proposal = (await client.callTool({
    name: "propose_edit",
    arguments: {
      path: "main.tex",
      baseVersion: file.version,
      oldText,
      newText: oldText + "\n% MCP proposal\n",
      reason: "test candidate",
    },
  })) as any;
  expect(proposal.isError).not.toBe(true);
  expect(
    (
      (await (
        await request(
          `/api/projects/${project.id}/file?path=main.tex`,
          undefined,
          user.token,
        )
      ).json()) as any
    ).content,
  ).toBe(file.content);
  const pending = (await (
    await request(
      `/api/projects/${project.id}/pending-proposals`,
      undefined,
      user.token,
    )
  ).json()) as any[];
  expect(pending).toHaveLength(1);
  const denied = (await client.callTool({
    name: "compile",
    arguments: {},
  })) as any;
  expect(denied.isError).toBe(true);
  const second = (await (
    await request("/api/projects", { name: "other" }, user.token)
  ).json()) as any;
  expect(
    (
      await request(
        `/api/projects/${second.id}/mcp`,
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        access.token,
      )
    ).status,
  ).toBe(401);
  await request(
    `/api/projects/${project.id}/mcp-tokens/${access.access.id}`,
    undefined,
    user.token,
    "DELETE",
  );
  await expect(client.listTools()).rejects.toThrow();
  await client.close();
});
test("project index only includes files readable by the requesting user", async () => {
  const { request, user, project } = await setup();
  const res = await request(
    `/api/projects/${project.id}/latex-index`,
    undefined,
    user.token,
  );
  expect(res.status).toBe(200);
  expect(
    ((await res.json()) as any).documents.some(
      (doc: any) => doc.path === "main.tex",
    ),
  ).toBe(true);
  const tokens = (await (
    await request(
      `/api/projects/${project.id}/mcp-tokens`,
      { name: "reader", scopes: ["read"], days: 1 },
      user.token,
    )
  ).json()) as any;
  expect(
    JSON.stringify(
      await (
        await request(
          `/api/projects/${project.id}/mcp-tokens`,
          undefined,
          user.token,
        )
      ).json(),
    ),
  ).not.toContain(tokens.token);
});
test("lightweight repair compiles an isolated candidate and returns a reviewable ChangeSet without writing sources", async () => {
  let patched = false;
  const calls: unknown[] = [];
  const provider = {
    revise: async () => ({ replacement: "", rationale: "" }),
    assistantStep: async (input: any) => {
      if (!patched) {
        patched = true;
        return {
          action: "propose_edit",
          path: "main.tex",
          oldText: "\\begin{document}",
          newText: "\\begin{document}\n% fix",
          explanation: "minimal fix",
        };
      }
      return {
        action: "finish",
        path: "",
        oldText: "",
        newText: "",
        explanation: "candidate ready",
      };
    },
  } as AgentProvider;
  const compiler = {
    compile: async (_id: string, _signal: AbortSignal, candidate: any) => {
      calls.push(candidate);
      return {
        success: Boolean(candidate),
        projectVersion: 1,
        snapshotId: "test",
        engine: "server" as const,
        workspacePaths: ["main.tex"],
        log: candidate ? "compiled" : "main.tex:1: Error: test",
        diagnostics: candidate
          ? []
          : [
              {
                id: "err",
                severity: "error" as const,
                path: "main.tex",
                line: 1,
                raw: "error",
                message: "test",
              },
            ],
      };
    },
  };
  const { request, user, project } = await setup({ provider, compiler });
  const original = (await (
    await request(
      `/api/projects/${project.id}/file?path=main.tex`,
      undefined,
      user.token,
    )
  ).json()) as any;
  const response = await request(
    `/api/projects/${project.id}/compile-assistant`,
    { expectedVersion: project.version, lightweight: true },
    user.token,
  );
  expect(response.status).toBe(201);
  const result = (await response.json()) as any;
  expect(result.validated).toBe(true);
  expect(result.changeSet.status).toBe("proposed");
  expect(calls).toHaveLength(2);
  expect(
    (
      (await (
        await request(
          `/api/projects/${project.id}/file?path=main.tex`,
          undefined,
          user.token,
        )
      ).json()) as any
    ).content,
  ).toBe(original.content);
  expect((calls[1] as any).files[0].content).toContain("% fix");
  expect(
    (
      await request(
        `/api/projects/${project.id}/compile-assistant`,
        { expectedVersion: 9999, lightweight: true },
        user.token,
      )
    ).status,
  ).toBe(409);
});

test("MCP and language index recheck file ACLs after a token has been issued", async () => {
  const { app, request, user, project } = await setup();
  await request(
    `/api/projects/${project.id}/files`,
    {
      path: "secret.bib",
      content: "@article{SecretKey,title={Private Metadata}}",
    },
    user.token,
  );
  const access = (await (
    await request(
      `/api/projects/${project.id}/mcp-tokens`,
      { name: "acl", scopes: ["read", "propose", "compile"], days: 1 },
      user.token,
    )
  ).json()) as any;
  expect(
    (
      await request(
        `/api/projects/${project.id}/acl/new`,
        {
          pathPrefix: "secret.bib",
          subjectType: "user",
          subjectId: user.user.id,
          action: "read",
          effect: "deny",
        },
        user.token,
        "PUT",
      )
    ).status,
  ).toBe(200);
  const index = (await (
    await request(
      `/api/projects/${project.id}/latex-index`,
      undefined,
      user.token,
    )
  ).json()) as any;
  expect(index.entries.some((entry: any) => entry.key === "SecretKey")).toBe(
    false,
  );
  const fetcher: typeof fetch = (async (input: any, init?: RequestInit) =>
    app(
      input instanceof Request
        ? new Request(input, init)
        : new Request(String(input), init),
    )) as typeof fetch;
  const client = new Client({ name: "acl-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://fastwrite.test/api/projects/${project.id}/mcp`),
      {
        requestInit: { headers: { authorization: `Bearer ${access.token}` } },
        fetch: fetcher,
      },
    ),
  );
  const file = (await client.callTool({
    name: "read_file",
    arguments: { path: "secret.bib" },
  })) as any;
  expect(file.isError).toBe(true);
  const compilation = (await client.callTool({
    name: "compile",
    arguments: {},
  })) as any;
  expect(compilation.isError).toBe(true);
  const files = (await client.callTool({
    name: "list_files",
    arguments: {},
  })) as any;
  expect(JSON.parse(files.content[0].text).paths).not.toContain("secret.bib");
  await client.close();
});

test("the full assistant observes failed candidate compiles and continues to a successful candidate", async () => {
  const seen: any[] = [];
  let step = 0;
  const provider = {
    revise: async () => ({ replacement: "", rationale: "" }),
    assistantStep: async (input: any) => {
      seen.push(input.observation);
      const outputs = [
        {
          action: "propose_edit",
          path: "main.tex",
          oldText: "\\begin{document}",
          newText: "\\begin{document}\n% first attempt",
          explanation: "first",
        },
        {
          action: "compile",
          path: "",
          oldText: "",
          newText: "",
          explanation: "check candidate",
        },
        {
          action: "read_file",
          path: "main.tex",
          oldText: "",
          newText: "",
          explanation: "inspect after failure",
        },
        {
          action: "propose_edit",
          path: "main.tex",
          oldText: "% first attempt",
          newText: "% verified attempt",
          explanation: "second",
        },
        {
          action: "compile",
          path: "",
          oldText: "",
          newText: "",
          explanation: "verify again",
        },
        {
          action: "finish",
          path: "",
          oldText: "",
          newText: "",
          explanation: "compiled",
        },
      ];
      return outputs[step++];
    },
  } as AgentProvider;
  const compiler = {
    compile: async (_id: string, _signal: AbortSignal, candidate: any) => ({
      success: Boolean(
        candidate?.files[0]?.content.includes("% verified attempt"),
      ),
      projectVersion: 1,
      snapshotId: "loop",
      engine: "server" as const,
      workspacePaths: ["main.tex"],
      log: "test",
      diagnostics: [],
    }),
  };
  const { request, user, project } = await setup({ provider, compiler });
  const response = await request(
    `/api/projects/${project.id}/compile-assistant`,
    { expectedVersion: project.version, lightweight: false },
    user.token,
  );
  expect(response.status).toBe(201);
  const result = (await response.json()) as any;
  expect(result.validated).toBe(true);
  expect(seen[2].success).toBe(false);
  expect(seen[5].success).toBe(true);
  expect(result.changeSet.changes[0].after).toContain("% verified attempt");
});
