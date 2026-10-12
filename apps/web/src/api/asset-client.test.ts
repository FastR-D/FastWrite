import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { api } from "./client";

const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const fetchTarget = globalThis as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
let values: Map<string, string>;
let fetchMock: ReturnType<typeof spyOn<typeof fetchTarget, "fetch">>;
beforeEach(() => {
  values = new Map([["fastwrite.session-token", "test-access-token"]]);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
  fetchMock = spyOn(fetchTarget, "fetch");
});
afterEach(() => {
  fetchMock.mockRestore();
  if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

test("asset downloads authenticate and return bytes without putting tokens in the URL", async () => {
  fetchMock.mockImplementation(async (url, init) => {
    expect(String(url)).toBe("/api/projects/project%2Fid/asset?path=figures%2Fa%20%26%20b.png");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-access-token");
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
  });
  const blob = await api.projects.readAsset("project/id", "figures/a & b.png");
  expect(blob.type).toBe("image/png");
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
});

test("expired asset authentication refreshes once and retries with the new token", async () => {
  let calls = 0;
  fetchMock.mockImplementation(async (url, init) => {
    calls++;
    if (calls === 1) return new Response(null, { status: 401 });
    if (calls === 2) {
      expect(String(url)).toBe("/api/auth/refresh");
      return Response.json({ token: "refreshed-test-token" });
    }
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer refreshed-test-token");
    return new Response("image bytes");
  });
  expect(await (await api.projects.readAsset("project", "image.png")).text()).toBe("image bytes");
  expect(calls).toBe(3);
  expect(values.get("fastwrite.session-token")).toBe("refreshed-test-token");
});

test("access denied is surfaced as an API error instead of an image blob", async () => {
  fetchMock.mockResolvedValue(Response.json({ error: { code: "path_access_denied", message: "Access denied" } }, { status: 403 }));
  await expect(api.projects.readAsset("project", "image.png")).rejects.toMatchObject({ status: 403, code: "path_access_denied" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("cancelling an asset preview aborts even while refreshing its session", async () => {
  const controller = new AbortController();
  let calls = 0;
  fetchMock.mockImplementation(async (_url, init) => {
    expect(init?.signal).toBe(controller.signal);
    if (++calls === 1) return new Response(null, { status: 401 });
    controller.abort();
    init?.signal?.throwIfAborted();
    throw new Error("unreachable");
  });
  await expect(api.projects.readAsset("project", "image.png", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toBe(2);
});
