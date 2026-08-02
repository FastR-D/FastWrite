import { describe, expect, test } from "bun:test";
import { compilerPackageProgress, compilerResourceProgress, resolveCompilerBundles, trackedCompilerResourceName } from "./compilerResources";

describe("compiler resources", () => {
  test("reports bounded byte progress with the current resource", () => {
    expect(compilerResourceProgress(1536, 4096, "booktabs.sty")).toEqual({
      percent: 38,
      detail: "38% · 1.5 KB / 4.0 KB · download · booktabs.sty"
    });
    expect(compilerResourceProgress(5000, 4096, "booktabs.sty", true).percent).toBe(100);
  });

  test("turns on-demand package logs into user-facing progress", () => {
    expect(compilerPackageProgress("[FETCH] enumitem: starting fetch")).toBe("Checking TeX package enumitem…");
    expect(compilerPackageProgress("Missing: enumitem.sty, fetching enumitem from CTAN...")).toBe("Downloading missing TeX package for enumitem.sty: enumitem…");
    expect(compilerPackageProgress("Processed 12 TeX/font files from enumitem")).toBe("Downloaded TeX package enumitem · 12 files");
    expect(compilerPackageProgress("ordinary compiler log")).toBeNull();
  });

  test("tracks only WASM and compressed TeX bundle downloads", () => {
    expect(trackedCompilerResourceName("/busytex.wasm")).toBe("busytex.wasm");
    expect(trackedCompilerResourceName("http://localhost/bundles/core.data.gz")).toBe("core.data.gz");
    expect(trackedCompilerResourceName("/bundles/bundles.json")).toBeNull();
    expect(trackedCompilerResourceName("/api/projects/paper")).toBeNull();
  });

  test("resolves engine, package, eager and transitive dependency bundles", () => {
    const bundles = resolveCompilerBundles("\\usepackage{algorithm,hyperref}", {
      engines: { pdflatex: { required: ["core"] } },
      packages: { algorithm: "algorithms", hyperref: "hyperref" },
      bundles: { core: {}, algorithms: {}, hyperref: { requires: ["graphics"] }, graphics: {} }
    }, ["extra-misc"]);
    expect(bundles).toEqual(["algorithms", "core", "extra-misc", "graphics", "hyperref"]);
  });
});
