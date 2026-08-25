import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LatexTemplateService, templateForVenue } from "./latex-template-service";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("LaTeX venue templates", () => {
  test("labels official, publisher-family, mirror, and unavailable sources", () => {
    expect(templateForVenue("iclr")).toMatchObject({ trust: "official", venueSpecific: true });
    expect(templateForVenue("tse")).toMatchObject({ trust: "publisher", venueSpecific: false });
    expect(templateForVenue("neurips")).toMatchObject({ trust: "community-mirror", venueSpecific: true });
    expect(templateForVenue("bioinformatics")).toBeUndefined();
  });

  test("copies a bounded official template tree and preserves its supporting files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fastwrite-template-"));
    temporaryDirectories.push(directory);
    const tex = new TextEncoder().encode("\\documentclass{article}\n\\title{Instructions}\n\\begin{document}Draft\\end{document}\n");
    const style = new TextEncoder().encode("% official style\n");
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/git/trees/")) return Response.json({ tree: [
        { path: "iclr2026/iclr2026_conference.tex", type: "blob", size: tex.byteLength },
        { path: "iclr2026/iclr2026_conference.sty", type: "blob", size: style.byteLength },
        { path: "iclr2026/instructions.pdf", type: "blob", size: 500 },
        { path: "other/not-copied.tex", type: "blob", size: tex.byteLength }
      ] });
      if (url.endsWith("iclr2026_conference.tex")) return new Response(tex);
      if (url.endsWith("iclr2026_conference.sty")) return new Response(style);
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    const result = await new LatexTemplateService(directory, fetcher).materialize("Evidence First", "artificial-intelligence", { domain: "artificial-intelligence", venueId: "iclr", stage: "submission" });
    expect(result.mainDocument).toBe("iclr2026_conference.tex");
    expect(await readFile(join(result.stagingDirectory, result.mainDocument), "utf8")).toContain("\\title{Evidence First}");
    expect(await readFile(join(result.stagingDirectory, "iclr2026_conference.sty"), "utf8")).toContain("official style");
    expect(Bun.file(join(result.stagingDirectory, "instructions.pdf")).exists()).resolves.toBe(false);
  });
});
