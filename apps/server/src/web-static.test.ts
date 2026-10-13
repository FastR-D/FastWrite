import { describe, expect, test } from "bun:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { webFileResponse } from "./web-static";

const text = "export const message = 'FastWrite';\n".repeat(100);
const plain = new Blob([text]);
const compressed = new Blob([gzipSync(text)]);
const asset = "assets/index-1234abcd.js";
const request = (encoding?: string, extra: Record<string, string> = {}, method = "GET") => new Request(`http://localhost/write/${asset}`, { method, headers: { ...(encoding === undefined ? {} : { "accept-encoding": encoding }), ...extra } });

describe("static web resources", () => {
  test("gzip is lossless and versioned assets are cached without changing their MIME type", async () => {
    const response = webFileResponse(request("br, gzip"), asset, plain, compressed);
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("vary")).toBe("Accept-Encoding");
    expect(gunzipSync(new Uint8Array(await response.arrayBuffer())).toString()).toBe(text);
  });

  test("encoding quality, missing gzip siblings and range requests keep the original representation", async () => {
    for (const encoding of [undefined, "br", "gzip;q=0", "*;q=1, gzip;q=0", "gzip;q=invalid"]) {
      const response = webFileResponse(request(encoding), asset, plain, compressed);
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(await response.text()).toBe(text);
    }
    expect(webFileResponse(request("gzip"), asset, plain).headers.get("content-encoding")).toBeNull();
    expect(webFileResponse(request("gzip", { range: "bytes=0-99" }), asset, plain, compressed).headers.get("content-encoding")).toBeNull();
    expect(webFileResponse(request("GZIP; Q=0.5"), asset, plain, compressed).headers.get("content-encoding")).toBe("gzip");
  });

  test("HTML and service workers revalidate; TeX data archives stay application bytes", async () => {
    expect(webFileResponse(request("gzip"), "index.html", plain, compressed).headers.get("cache-control")).toBe("no-cache");
    expect(webFileResponse(request("gzip"), "sw.js", plain, compressed).headers.get("cache-control")).toBe("no-cache");
    const archive = webFileResponse(request("gzip"), "bundles/default.data.gz", compressed, compressed);
    expect(archive.headers.get("content-encoding")).toBeNull();
    expect(archive.headers.get("content-type")).toBe("application/octet-stream");
    expect(await archive.arrayBuffer()).toEqual(await compressed.arrayBuffer());
  });

  test("HEAD returns negotiated metadata without a body", async () => {
    const response = webFileResponse(request("gzip", {}, "HEAD"), asset, plain, compressed);
    expect(response.headers.get("content-length")).toBe(String(compressed.size));
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(await response.text()).toBe("");
  });
});
