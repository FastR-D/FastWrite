import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../app";
import { operationSchemas, operationPrompt, validateOperationOutput } from "./structured-provider";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const validReview = { overallAssessment: "Bounded review", recommendation: "borderline", strengths: [], weaknesses: [], nextSteps: [], issues: [] };

test("runtime API settings drive real HTTP requests and malformed review never persists a clean report", async () => {
  const calls: any[] = [];
  let malformed = true;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as any;
    calls.push({ path: new URL(request.url).pathname, authorization: request.headers.get("authorization"), body });
    const prompt = body.messages[0].content as string;
    const value = prompt.includes("operation 'complete'") ? { suggestion: "Actual HTTP fixture completion." } : malformed ? { result: {} } : validReview;
    return Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });
  } });
  cleanups.push(async () => upstream.stop(true));
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-api-chain-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const app = await createApplication(directory);
  const request = (path: string, method = "GET", body?: unknown) => app(new Request(`http://fastwrite.test${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) }));
  const configured = await request("/api/harness-settings", "PUT", { apiKey: "fixture-key", baseURL: `http://127.0.0.1:${upstream.port}/v1`, model: "qwen3.8-27b", wireAPI: "chat" });
  expect(await configured.json()).toMatchObject({ configured: true, transport: "api", source: "runtime", model: "qwen3.8-27b" });
  const project = await (await request("/api/projects", "POST", { name: "API wiring" })).json() as any;
  const root = `/api/projects/${project.id}`;
  const completion = await request(root + "/completions", "POST", { path: "main.tex", cursor: 0, fileVersion: 1, kind: "auto" });
  expect(await completion.json()).toMatchObject({ suggestion: "Actual HTTP fixture completion." });
  expect(calls[0]).toMatchObject({ path: "/v1/chat/completions", authorization: "Bearer fixture-key", body: { model: "qwen3.8-27b", enable_thinking: false } });
  const failed = await request(root + "/reviews", "POST", { sourceOnly: true });
  expect(failed.status).toBe(502);
  expect(await (await request(root + "/reviews")).json()).toEqual([]);
  malformed = false;
  const retried = await request(root + "/reviews", "POST", { sourceOnly: true });
  expect(retried.status).toBe(201);
  expect(await retried.json()).toMatchObject({ report: { recommendation: "borderline", inputType: "source" } });
  const stale = await request(root + "/reviews", "POST", { pageText: ["Old PDF"], projectVersion: project.version - 1 });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: "review_pdf_stale" } });
  await request(root + "/compile-results", "POST", { projectVersion: project.version, status: "success", summary: "Fixture compilation record" });
  const pdfReview = await request(root + "/reviews", "POST", { sourceOnly: false, pageText: ["PDF_PAGE_SENTINEL"], projectVersion: project.version });
  expect(pdfReview.status).toBe(201);
  expect(await pdfReview.json()).toMatchObject({ report: { inputType: "pdf-preview" } });
  expect(calls.at(-1).body.messages[0].content).toContain('"pdfPageText":["PDF_PAGE_SENTINEL"]');
});

test("all writing operations have explicit schemas and reject generic result wrappers", () => {
  for (const method of Object.keys(operationSchemas)) {
    expect(() => validateOperationOutput(method, { result: {} })).toThrow();
    expect(operationPrompt(method, { outline: [], mainDocument: "main.tex" })).not.toContain('{"result":object}');
  }
  expect(() => validateOperationOutput("review", { ...validReview, recommendation: "undefined" })).toThrow();
  expect(() => validateOperationOutput("rereviewIssues", { assessments: [{ issueId: "i", resolved: "yes", assessment: "ok" }], regressions: [] })).toThrow();
});
