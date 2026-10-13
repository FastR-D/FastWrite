import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { createApplication } from "./app";
import { config } from "./config";

test("serves gzip build assets through the application and keeps SPA fallbacks distinct from missing assets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fastwrite-static-"));
  const originalWebDirectory = config.webDirectory;
  try {
    const webDirectory = join(directory, "web");
    await mkdir(join(webDirectory, "assets"), { recursive: true });
    const source = "console.log('FastWrite static delivery');\n".repeat(100);
    const compressed = gzipSync(source);
    await writeFile(join(webDirectory, "assets", "app-abcdefgh.js"), source);
    await writeFile(join(webDirectory, "assets", "app-abcdefgh.js.gz"), compressed);
    await writeFile(join(webDirectory, "index.html"), "<!doctype html><title>FastWrite</title>");
    config.webDirectory = webDirectory;
    const app = await createApplication(join(directory, "data"), { features: { serverAuth: false } });
    const request = (path: string, init?: RequestInit) => app(new Request(`http://fastwrite.test${path}`, init));

    const asset = await request("/assets/app-abcdefgh.js", { headers: { "accept-encoding": "gzip" } });
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-encoding")).toBe("gzip");
    expect(asset.headers.get("content-type")).toContain("text/javascript");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(asset.headers.get("vary")).toBe("Accept-Encoding");
    expect(gunzipSync(await asset.arrayBuffer()).toString()).toBe(source);

    const uncompressed = await request("/assets/app-abcdefgh.js", { headers: { "accept-encoding": "gzip;q=0" } });
    expect(uncompressed.headers.get("content-encoding")).toBeNull();
    expect(await uncompressed.text()).toBe(source);
    const head = await request("/assets/app-abcdefgh.js", { method: "HEAD", headers: { "accept-encoding": "gzip" } });
    expect(head.headers.get("content-length")).toBe(String(compressed.byteLength));
    expect(await head.text()).toBe("");

    const clientRoute = await request("/projects?invite=example");
    expect(clientRoute.status).toBe(200);
    expect(clientRoute.headers.get("content-type")).toContain("text/html");
    expect(clientRoute.headers.get("cache-control")).toBe("no-cache");
    for (const path of ["/assets/missing.js", "/worker-missing.js", "/bundles/missing.data.gz"]) {
      const missing = await request(path);
      expect(missing.status).toBe(404);
      expect(missing.headers.get("content-type")).toContain("application/json");
    }
  } finally {
    config.webDirectory = originalWebDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});
