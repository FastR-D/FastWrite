import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { ApiError } from "../http";
import { TexPackageService } from "./tex-package-service";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("dynamic TeX packages", () => {
  test("downloads a TeX Live archive once and reuses the server cache", async () => {
    const directory = await temporaryDirectory();
    const archive = new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 1, 2, 3]);
    let requests = 0;
    const service = new TexPackageService(directory, mockFetch(async (url) => {
      requests += 1;
      expect(url).toContain("/2025/tlnet-final/archive/enumitem.tar.xz");
      return new Response(archive, { headers: { "content-length": String(archive.byteLength) } });
    }));
    await service.initialize();

    expect(new Uint8Array(await (await service.texLiveArchive("enumitem")).arrayBuffer())).toEqual(archive);
    expect(new Uint8Array(await (await service.texLiveArchive("enumitem")).arrayBuffer())).toEqual(archive);
    expect(requests).toBe(1);
  });

  test("rejects unsafe package names before making a network request", async () => {
    const directory = await temporaryDirectory();
    let requested = false;
    const service = new TexPackageService(directory, mockFetch(async () => { requested = true; return new Response(); }));
    await service.initialize();

    await expect(service.texLiveArchive("../secret")).rejects.toMatchObject({ status: 400, code: "invalid_tex_package" } satisfies Partial<ApiError>);
    expect(requested).toBe(false);
  });

  test("normalizes CTAN package metadata for the compiler's container lookup", async () => {
    const directory = await temporaryDirectory();
    const service = new TexPackageService(directory, mockFetch(async () => Response.json({ name: "algorithm", texlive: "algorithms" })));
    await service.initialize();

    expect(await (await service.ctanPackageInfo("algorithm")).json()).toMatchObject({ name: "algorithm", contained_in: "algorithms" });
  });

  test("uses the file index when a style name differs from its TeX Live package", async () => {
    const directory = await temporaryDirectory();
    const service = new TexPackageService(directory, mockFetch(async (url) => {
      if (url.includes("ctan.org/json")) return Response.json({ errors: ["Not found"] });
      if (url.includes("file-to-package.json")) return Response.json({ "algorithm.sty": "algorithms" });
      return new Response(null, { status: 404 });
    }));
    await service.initialize();

    expect(await (await service.ctanPackageInfo("algorithm")).json()).toEqual({ name: "algorithm", contained_in: "algorithms" });
  });

  test("falls back to CTAN ZIP files and returns only runtime files", async () => {
    const directory = await temporaryDirectory();
    const zip = zipSync({
      "rare/tex/latex/rare/rare.sty": new TextEncoder().encode("\\RequirePackage{helper}\n\\ProvidesPackage{rare}"),
      "rare/doc/rare.pdf": new Uint8Array([1, 2, 3])
    });
    const service = new TexPackageService(directory, mockFetch(async (url) => {
      if (url.includes("ctan.org/json")) return Response.json({ name: "rare", install: "/macros/latex/contrib/rare.zip" });
      if (url.includes("mirrors.ctan.org/install")) return new Response(zip);
      return new Response(null, { status: 404 });
    }));
    await service.initialize();

    const result = await (await service.ctanPackage("rare")).json() as { files: Record<string, { content: string }>; dependencies: string[]; totalFiles: number };
    expect(result.totalFiles).toBe(1);
    expect(result.files["/texlive/texmf-dist/tex/latex/rare/rare.sty"]?.content).toContain("ProvidesPackage");
    expect(result.dependencies).toEqual(["helper"]);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-tex-packages-"));
  temporaryDirectories.push(directory);
  return directory;
}

function mockFetch(handler: (url: string) => Promise<Response>): typeof fetch {
  return ((input: string | URL | Request) => handler(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)) as typeof fetch;
}
