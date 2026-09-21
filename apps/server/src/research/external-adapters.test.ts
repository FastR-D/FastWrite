import { describe, expect, test } from "bun:test";
import { ExternalResearchAdapters } from "./external-adapters";

describe("external research adapters", () => {
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
