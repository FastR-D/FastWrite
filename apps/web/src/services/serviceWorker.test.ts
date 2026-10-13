import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");

function worker(network: (request: { url: string }) => Promise<Response>, cacheFull = false, cacheUnreadable = false) {
  type FetchEvent = { request: unknown; respondWith(value: Promise<Response>): void };
  const listeners = new Map<string, (event: FetchEvent) => void>();
  const cached = new Map<string, Response>();
  const key = (request: string | { url: string }) => typeof request === "string" ? request : request.url;
  runInNewContext(source, {
    URL, Response,
    self: { location: { href: "https://example.test/write/sw.js", origin: "https://example.test" }, addEventListener: (name: string, handler: (event: FetchEvent) => void) => listeners.set(name, handler) },
    fetch: network,
    caches: {
      match: async (request: string | { url: string }) => { if (cacheUnreadable) throw new Error("cache unavailable"); return cached.get(key(request))?.clone(); },
      open: async () => ({ put: async (request: string | { url: string }, response: Response) => { if (cacheFull) throw new Error("cache quota exceeded"); cached.set(key(request), response); } })
    }
  });
  return {
    cached,
    fetch(path: string, mode = "cors", headers: Record<string, string> = {}) {
      let result: Promise<Response> | undefined;
      listeners.get("fetch")!({ request: { method: "GET", url: `https://example.test${path}`, mode, headers: new Headers(headers) }, respondWith(value) { result = value; } });
      return result;
    }
  };
}

describe("service worker recovery", () => {
  test("navigations fetch a fresh release rather than replaying the old HTML", async () => {
    const instance = worker(async () => new Response("new release"));
    instance.cached.set("https://example.test/write/index.html", new Response("old release"));
    expect(await (await instance.fetch("/write/", "navigate"))!.text()).toBe("new release");
    expect(await instance.cached.get("https://example.test/write/index.html")!.text()).toBe("new release");
  });

  test("only failed navigations fall back to HTML; missing scripts expose the network error", async () => {
    const instance = worker(async () => { throw new TypeError("offline"); });
    instance.cached.set("https://example.test/write/index.html", new Response("offline shell"));
    expect(await (await instance.fetch("/write/projects/paper", "navigate"))!.text()).toBe("offline shell");
    const script = await instance.fetch("/write/assets/missing-1234abcd.js");
    expect(script!.type).toBe("error");
    expect(script!.status).toBe(0);
  });

  test("API, authenticated and out-of-base requests never use the public cache", () => {
    const instance = worker(async () => new Response("public"));
    expect(instance.fetch("/write/api/projects")).toBeUndefined();
    expect(instance.fetch("/write/private", "cors", { Authorization: "Bearer fixture" })).toBeUndefined();
    expect(instance.fetch("/other-site/")).toBeUndefined();
  });

  test("immutable assets can replay exact cached bytes while a server 404 remains a 404", async () => {
    const instance = worker(async () => new Response("missing", { status: 404 }));
    instance.cached.set("https://example.test/write/assets/index-1234abcd.js", new Response("cached script"));
    expect(await (await instance.fetch("/write/assets/index-1234abcd.js"))!.text()).toBe("cached script");
    expect((await instance.fetch("/write/assets/missing-1234abcd.js"))!.status).toBe(404);
  });

  test("cache quota/read failures do not hide a successful network response", async () => {
    for (const unreadable of [false, true]) {
      const instance = worker(async () => new Response("fresh network page"), true, unreadable);
      expect(await (await instance.fetch("/write/", "navigate"))!.text()).toBe("fresh network page");
    }
  });
});
