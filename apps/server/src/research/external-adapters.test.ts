import { describe, expect, test } from "bun:test";
import { ExternalResearchAdapters } from "./external-adapters";

describe("external research adapters", () => {
  test("rejects unconfigured destinations and URL endpoint escapes before fetching", async () => {
    let calls = 0;
    const adapter = new ExternalResearchAdapters(async () => { calls++; return Response.json({ ok: true }); }, { zotero: "http://127.0.0.1:23119" });
    const request = { kind: "zotero", operation: "health", authorized: true } as const;
    for (const base of ["http://127.0.0.1:9999", "http://127.0.0.1:23119/internal#", "http://127.0.0.1:23119?path=", "http://user:pass@127.0.0.1:23119"]) {
      await expect(adapter.callConfigured(request, base)).rejects.toBeDefined();
    }
    await expect(adapter.callConfigured({ ...request, kind: "grobid" })).rejects.toMatchObject({ code: "external_adapter_not_allowed" });
    expect(calls).toBe(0);
    expect(await adapter.callConfigured(request)).toEqual({ ok: true });
    expect(calls).toBe(1);
  });

  test("does not follow redirects and cancels oversized response streams", async () => {
    const adapter = new ExternalResearchAdapters(async (_input, init) => {
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBeDefined();
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/internal" } });
    }, { zotero: "https://adapter.example.test" });
    await expect(adapter.callConfigured({ kind: "zotero", operation: "health", authorized: true }, undefined, new AbortController().signal)).rejects.toMatchObject({ code: "external_adapter_failed" });
    let cancelled = false;
    const oversized = new ExternalResearchAdapters(async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(100_001)); }, cancel() { cancelled = true; }
    })), { zotero: "https://adapter.example.test" });
    await expect(oversized.callConfigured({ kind: "zotero", operation: "health", authorized: true })).rejects.toMatchObject({ code: "external_adapter_response_too_large" });
    expect(cancelled).toBe(true);
  });
  test("requires explicit authorization and read-only configuration", async () => {
    const adapter = new ExternalResearchAdapters(async () => new Response("{}"));
    await expect(adapter.call({ kind: "zotero", operation: "health", authorized: false }, { kind: "zotero", baseUrl: "http://127.0.0.1:23119", readOnly: true, allowed: true })).rejects.toMatchObject({ code: "external_adapter_authorization_required" });
    await expect(adapter.call({ kind: "pandoc", operation: "convert", authorized: true }, { kind: "pandoc", baseUrl: "http://127.0.0.1:3030", readOnly: true, allowed: true })).rejects.toMatchObject({ code: "external_adapter_write_denied" });
  });

  test("bounds requests and returns adapter JSON", async () => {
    let seen = "";
    const adapter = new ExternalResearchAdapters(async (input, init) => { seen = `${input}${init?.method}`; return new Response(JSON.stringify({ ok: true })); });
    const result = await adapter.call({ kind: "grobid", operation: "parse", authorized: true, input: { text: "paper" } }, { kind: "grobid", baseUrl: "http://127.0.0.1:8070/", readOnly: true, allowed: true });
    expect(result).toEqual({ ok: true });
    expect(seen).toContain("/api/processFulltextDocumentPOST");
    await expect(adapter.call({ kind: "zotero", operation: "search", authorized: true, input: "x".repeat(50_001) }, { kind: "zotero", baseUrl: "http://127.0.0.1:23119", readOnly: true, allowed: true })).rejects.toMatchObject({ code: "external_adapter_input_too_large" });
  });
});
