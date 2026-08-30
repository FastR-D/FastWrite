import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonDatabase } from "../storage/database";
import { WorkspaceService } from "../workspace/workspace-service";
import { ResearchService } from "./research-service";

const temporaryDirectories: string[] = [];
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function serviceWith(fetcher: typeof fetch) {
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
