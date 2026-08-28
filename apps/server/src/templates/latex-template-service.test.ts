import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LatexTemplateService, templateForVenue } from "./latex-template-service";
import { zipSync } from "fflate";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("LaTeX venue templates", () => {
  test("labels official, publisher-family, mirror, and unavailable sources", () => {
    expect(templateForVenue("iclr")).toMatchObject({ trust: "official", venueSpecific: true });
    expect(templateForVenue("tse")).toMatchObject({ trust: "publisher", venueSpecific: false });
    expect(templateForVenue("neurips")).toMatchObject({ trust: "community-mirror", venueSpecific: true });
    expect(templateForVenue("bioinformatics")).toBeUndefined();
  });

  test("copies and caches the official ICLR 2027 style archive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fastwrite-template-"));
    temporaryDirectories.push(directory);
    const tex = new TextEncoder().encode("\\documentclass{article}\n\\title{Instructions}\n\\begin{document}Draft\\end{document}\n");
    const style = new TextEncoder().encode("% official style\n");
    const archive = zipSync({
      "iclr2027/iclr2027_conference.tex": tex,
      "iclr2027/iclr2027_conference.sty": style,
      "iclr2027/instructions.pdf": new Uint8Array(500)
    });
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("iclr-2027-style-files.zip")) return new Response(archive);
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    const bundledDirectory = join(directory, "bundled");
    const result = await new LatexTemplateService(directory, fetcher, bundledDirectory).materialize("Evidence First", "artificial-intelligence", { domain: "artificial-intelligence", venueId: "iclr", stage: "submission" });
    expect(result.mainDocument).toBe("iclr2027_conference.tex");
    expect(await readFile(join(result.stagingDirectory, result.mainDocument), "utf8")).toContain("\\title{Evidence First}");
    expect(await readFile(join(result.stagingDirectory, "iclr2027_conference.sty"), "utf8")).toContain("official style");
    expect(Bun.file(join(result.stagingDirectory, "instructions.pdf")).exists()).resolves.toBe(false);
    const cachedResult = await new LatexTemplateService(directory, (async () => { throw new Error("network should not be used for cached templates"); }) as unknown as typeof fetch, bundledDirectory).materialize("Cached Paper", "artificial-intelligence", { domain: "artificial-intelligence", venueId: "iclr", stage: "submission" });
    expect(await readFile(join(cachedResult.stagingDirectory, cachedResult.mainDocument), "utf8")).toContain("\\title{Cached Paper}");
  });

  test("rejects unsupported explicit template years", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fastwrite-template-"));
    temporaryDirectories.push(directory);
    const service = new LatexTemplateService(directory, (async () => { throw new Error("network should not be used"); }) as unknown as typeof fetch, join(directory, "bundled"));
    await expect(service.materialize("Evidence First", "artificial-intelligence", { domain: "artificial-intelligence", venueId: "iclr", year: 2026, stage: "submission" })).rejects.toMatchObject({ code: "template_unavailable" });
  });
});
