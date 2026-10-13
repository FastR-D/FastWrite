import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonDatabase } from "../storage/database";
import { WorkspaceService } from "../workspace/workspace-service";
import { ResearchService } from "./research-service";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function serviceWith(fetcher: NonNullable<ConstructorParameters<typeof ResearchService>[2]>) {
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-research-"));
  temporaryDirectories.push(directory);
  const database = new JsonDatabase(directory);
  await database.initialize();
  const workspaces = new WorkspaceService(directory, database);
  await workspaces.initialize();
  const project = await workspaces.createEmpty("Provider status");
  return { service: new ResearchService(database, workspaces, fetcher), project, database, workspaces };
}

async function importBundle(service: ResearchService, workspaces: WorkspaceService, projectId: string) {
  const bundleId = "abcdef012345678901234567";
  const root = `references/fastread/${bundleId}`;
  const files = {
    "evidence.md": "# Evidence\n\n- Shared bundle evidence.\n",
    "citations.json": `${JSON.stringify({
      version: 1,
      bundle_id: bundleId,
      selector: { task_id: "shared-paper", topic_id: "" },
      papers: [{ id: "shared-paper", title: "Shared bundle paper", authors: ["Ada Lovelace"], year: 2026, doi: "10.1000/shared-bundle" }],
      citations: [{ task_id: "shared-paper", page: 3, exact_quote: "Shared bundle evidence.", source_hash: "shared-source-hash" }]
    }, null, 2)}\n`,
    "references.bib": "@article{Lovelace2026Shared,\n  title = {Shared bundle paper},\n  author = {Ada Lovelace},\n  year = {2026}\n}\n"
  };
  for (const [name, content] of Object.entries(files)) await workspaces.createFile(projectId, `${root}/${name}`, content);
  const manifest = `${JSON.stringify({
    version: 1,
    bundle_id: bundleId,
    immutable: true,
    files: Object.entries(files).map(([name, content]) => ({
      name,
      sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
      bytes: Buffer.byteLength(content)
    }))
  }, null, 2)}\n`;
  await workspaces.createFile(projectId, `${root}/manifest.json`, manifest);
  return (await service.importFastReadBundles(projectId, `${root}/manifest.json`))[0]!;
}

function onePagePdf(text: string): string {
  const escaped = text.replace(/([\\()])/g, "\\$1");
  const stream = `BT /F1 16 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf).toString("base64");
}

describe("Research provider transparency", () => {
  test("keeps successful provider results and records partial failures", async () => {
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("api.crossref.org")) return Response.json({ message: { items: [{ title: ["Traceable result"], author: [{ given: "Ada", family: "Lovelace" }], issued: { "date-parts": [[2026]] }, DOI: "10.1000/provider" }] } });
      if (url.includes("export.arxiv.org")) return new Response("<feed></feed>", { status: 200 });
      if (url.includes("api.openalex.org")) return new Response("rate limited", { status: 429 });
      throw new TypeError("simulated provider network failure");
    }) as unknown as typeof fetch;
    const { service, project } = await serviceWith(fetcher);
    const result = await service.search(project.id, "traceable result");
    expect(result.run).toMatchObject({ status: "completed", error: "2 research providers unavailable" });
    expect(result.run.providers).toEqual([
      { provider: "crossref", status: "completed", resultCount: 1 },
      { provider: "openalex", status: "failed", resultCount: 0, error: "OpenAlex returned HTTP 429" },
      { provider: "semantic-scholar", status: "failed", resultCount: 0, error: "simulated provider network failure" },
      { provider: "arxiv", status: "completed", resultCount: 0 }
    ]);
    expect(result.works).toHaveLength(1);
  });

  test("reports an all-provider failure instead of a misleading empty success", async () => {
    const fetcher = (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
    const { service, project } = await serviceWith(fetcher);
    const result = await service.search(project.id, "unavailable source");
    expect(result.run).toMatchObject({ status: "failed", error: "All research providers failed" });
    expect(result.run.providers?.every((item) => item.status === "failed")).toBe(true);
    expect(result.works).toEqual([]);
  });
});

describe("Authorized PDF evidence", () => {
  test("extracts page text with page provenance and replaces duplicate imports", async () => {
    const fetcher = (async () => new Response("unused", { status: 500 })) as unknown as typeof fetch;
    const { service, project, database } = await serviceWith(fetcher);
    const work = await service.importWork(project.id, { title: "PDF fixture", authors: ["Ada Lovelace"], year: 2026 });
    const pdf = onePagePdf("Distributional Equivalence PDF fixture");

    const first = await service.extractPdfEvidence(project.id, work.id, pdf, true);
    const second = await service.extractPdfEvidence(project.id, work.id, pdf, true);

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ origin: "source-text", representation: "verbatim", locatorType: "page", locator: "1" });
    expect(first[0]!.content).toContain("Distributional Equivalence PDF fixture");
    expect(second).toHaveLength(1);
    expect(second[0]!.id).toBe(first[0]!.id);
    await database.mutate(s => { s.sourceEvidence[0]!.status = "approved"; });
    const replaced = await service.extractPdfEvidence(project.id, work.id, onePagePdf("A revised reference with different text"), true);
    expect(replaced[0]!.sourceHash).not.toBe(first[0]!.sourceHash);
    expect(replaced[0]!.status).toBe("candidate");
    expect(database.snapshot().sourceEvidence[0]!.sourceHash).toBe(replaced[0]!.sourceHash);
    expect(database.snapshot().sourceEvidence.filter((item) => item.workId === work.id)).toHaveLength(1);
    expect(service.extractPdfEvidence(project.id, work.id, Buffer.from("not a PDF").toString("base64"), true)).rejects.toMatchObject({ status: 422, code: "pdf_invalid" });
  });
});

describe("FastRead project isolation", () => {
  test("imports the same bundle into separate project-scoped evidence records", async () => {
    const fetcher = (async () => new Response("unused", { status: 500 })) as unknown as typeof fetch;
    const { service, project, database, workspaces } = await serviceWith(fetcher);
    const otherProject = await workspaces.createEmpty("Second project");

    const first = await importBundle(service, workspaces, project.id);
    const second = await importBundle(service, workspaces, otherProject.id);
    const evidence = database.snapshot().sourceEvidence;
    const firstEvidence = evidence.filter((item) => item.projectId === project.id);
    const secondEvidence = evidence.filter((item) => item.projectId === otherProject.id);

    expect(first.status).toBe("imported");
    expect(second.status).toBe("imported");
    expect(first.id).not.toBe(second.id);
    expect(firstEvidence).toHaveLength(1);
    expect(secondEvidence).toHaveLength(1);
    expect(firstEvidence[0]!.id).not.toBe(secondEvidence[0]!.id);
    expect(first.evidenceIds).toEqual([firstEvidence[0]!.id]);
    expect(second.evidenceIds).toEqual([secondEvidence[0]!.id]);
  });
});

test("search persists provider metadata without creating Evidence or authorization", async () => {
  const { service, project, database } = await serviceWith((async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("crossref")) return Response.json({ message: { items: [{ title: ["Metadata paper"], DOI: "10.1000/metadata", abstract: "<jats:p>A public abstract.</jats:p>", subject: ["Science"], URL: "https://example.org/paper", "is-referenced-by-count": 3 }] } });
    if (url.includes("arxiv")) return new Response('<feed><entry><id>https://arxiv.org/abs/2609.00001</id><title>Arxiv metadata</title><summary>A &amp; B.</summary><category term="cs.AI"/><published>2026-09-01</published></entry></feed>');
    return Response.json({ results: [], data: [] });
  }) as typeof fetch);
  await service.search(project.id, "metadata");
  const papers = service.listWorks(project.id);
  expect(papers).toHaveLength(2);
  expect(papers.find(p => p.title === "Metadata paper")!.metadataObservations[0]!.fields).toMatchObject({ abstract: "A public abstract.", tags: ["Science"], citationCount: 3, sourceUrl: "https://example.org/paper" });
  expect(papers.find(p => p.title === "Arxiv metadata")!.metadataObservations[0]!.fields).toMatchObject({ abstract: "A & B.", tags: ["cs.AI"], sourceUrl: "https://arxiv.org/abs/2609.00001" });
  expect(papers.every(p => p.project.status === "candidate")).toBe(true);
  expect(database.snapshot().sourceEvidence).toHaveLength(0);
  const originalTime = papers[0]!.metadataObservations[0]!.fetchedAt;
  await service.search(project.id, "metadata");
  const repeated = service.listWorks(project.id).find(p => p.id === papers[0]!.id)!;
  expect(repeated.metadataObservations).toHaveLength(2);
  expect(repeated.metadataObservations.every(row => row.fetchedAt === originalTime)).toBe(true);
});

test("research tool access revocation after provider response prevents candidate persistence",async()=>{
 const {ApiError}=await import("../http");let allowed=true,calls=0;
 const f=await serviceWith(async()=>{calls++;allowed=false;return Response.json({message:{items:[{title:["Must not persist"],DOI:"10.5555/revoked"}]},results:[],data:[]});});
 await expect(f.service.search(f.project.id,"test query",undefined,()=>{if(!allowed)throw new ApiError(403,"revoked","Permission revoked");})).rejects.toMatchObject({status:403});
 expect(calls).toBe(4);expect(f.database.snapshot().researchWorks).toEqual([]);expect(f.database.snapshot().projectResearchWorks).toEqual([]);
 expect(f.database.snapshot().researchRuns[0]?.status).toBe("failed");
});

test("queued access revocation is checked when research metadata actually enters the write queue", async () => {
  let requests = 0, responseChecks = 0;
  const f = await serviceWith(async () => {
    requests++;
    return Response.json({ message: { items: [{ title: ["Queued candidate"], DOI: "10.5555/queued" }] }, results: [], data: [] });
  });
  let allowed = true;
  let revocation: Promise<unknown> | undefined;
  const authorize = () => {
    if (requests !== 4) return;
    responseChecks++;
    if (!allowed) throw new Error("Queued permission revoked");
    // Enqueue revocation after the pre-write check; it runs before candidate commit.
    if (responseChecks === 2) revocation = f.database.mutate(() => { allowed = false; });
  };
  await expect(f.service.search(f.project.id, "original query", undefined, authorize)).rejects.toThrow("Queued permission revoked");
  await revocation;
  expect(f.database.snapshot().researchWorks).toEqual([]);
  expect(f.database.snapshot().projectResearchWorks).toEqual([]);
  expect(f.database.snapshot().metadataObservations).toEqual([]);
  expect(f.database.snapshot().researchRuns[0]).toMatchObject({ status: "failed", workIds: [] });
});

test("concurrent searches share one persisted work identity", async () => {
  const f = await serviceWith(async () => Response.json({ message: { items: [{ title: ["Shared search candidate"], DOI: "10.5555/shared-search" }] }, results: [], data: [] }));
  const results = await Promise.all([f.service.search(f.project.id, "first query"), f.service.search(f.project.id, "second query")]);
  expect(results.every(result => result.run.status === "completed")).toBe(true);
  expect(f.database.snapshot().researchWorks).toHaveLength(1);
  expect(f.database.snapshot().projectResearchWorks).toHaveLength(1);
  expect(results[0]!.works[0]!.id).toBe(results[1]!.works[0]!.id);
  expect(f.database.snapshot().researchRuns.every(run => run.workIds[0] === results[0]!.works[0]!.id)).toBe(true);
});

test("cancellation during asynchronous write authorization prevents research candidate persistence", async () => {
  const controller = new AbortController();
  let requests = 0, responseChecks = 0;
  const f = await serviceWith(async () => {
    requests++;
    return Response.json({ message: { items: [{ title: ["Cancelled candidate"], DOI: "10.5555/cancelled" }] }, results: [], data: [] });
  });
  await expect(f.service.search(f.project.id, "cancel at write authorization", controller.signal, async () => {
    if (requests !== 4) return;
    responseChecks++;
    if (responseChecks === 3) { await Promise.resolve(); controller.abort(); }
  })).rejects.toMatchObject({ code: "research_cancelled" });
  expect(responseChecks).toBe(3);
  expect(f.database.snapshot().researchWorks).toEqual([]);
  expect(f.database.snapshot().projectResearchWorks).toEqual([]);
  expect(f.database.snapshot().metadataObservations).toEqual([]);
  expect(f.database.snapshot().researchRuns[0]).toMatchObject({ status: "cancelled", workIds: [] });
});
