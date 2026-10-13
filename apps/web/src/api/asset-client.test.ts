import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { api } from "./client";

const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
const fetchTarget = globalThis as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
let values: Map<string, string>;
let fetchMock: ReturnType<typeof spyOn<typeof fetchTarget, "fetch">>;
beforeEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
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
  if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
  else Reflect.deleteProperty(globalThis, "window");
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
    if (++calls === 1) { expect(init?.signal).toBe(controller.signal); return new Response(null, { status: 401 }); }
    expect(init?.signal).toBeUndefined();
    controller.abort();
    return Response.json({ token: "refreshed-test-token" });
  });
  await expect(api.projects.readAsset("project", "image.png", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toBe(2);
});

test("concurrent requests and auth/me share one refresh, with per-caller cancellation", async () => {
  const controller = new AbortController(); let refreshCalls = 0;
  let finish!: () => void; const barrier = new Promise<void>(resolve => { finish = resolve; });
  fetchMock.mockImplementation(async (url, init) => {
    if (String(url) === "/api/auth/refresh") { refreshCalls++; await barrier; return Response.json({ token: "fresh" }); }
    if (new Headers(init?.headers).get("authorization") === "Bearer test-access-token") return new Response(null, { status: 401 });
    return String(url) === "/api/auth/me" ? Response.json({ id: "user" }) : new Response("bytes");
  });
  const cancelled = api.projects.readAsset("project", "image.png", controller.signal).catch(error => error);
  const asset = api.projects.readAsset("project", "second.png"); const me = api.auth.me();
  await new Promise(resolve => setTimeout(resolve, 0)); controller.abort(); finish();
  expect((await cancelled).name).toBe("AbortError");
  expect(await (await asset).text()).toBe("bytes"); expect((await me).id).toBe("user");
  expect(refreshCalls).toBe(1);
});

test.each([200, 401])("a late refresh response (%s) cannot replace or delete newer credentials", async status => {
  fetchMock.mockImplementation(async url => {
    if (String(url) === "/api/auth/refresh") { values.set("fastwrite.session-token", "new-login"); return Response.json({ token: "old-session" }, { status }); }
    if (values.get("fastwrite.session-token") === "test-access-token") return new Response(null, { status: 401 });
    return new Response("bytes");
  });
  await expect(api.projects.readAsset("project", "image.png")).rejects.toMatchObject({ code: "session_changed" });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(values.get("fastwrite.session-token")).toBe("new-login");
});

test("API failures show Chinese guidance while preserving status, code and conflict details", async () => {
  const details = { path: "main.tex", expectedVersion: 2, actualVersion: 3 };
  fetchMock.mockResolvedValue(Response.json({ error: { code: "file_version_conflict", message: "File version changed", details } }, { status: 409 }));
  await expect(api.projects.readAsset("project", "image.png")).rejects.toMatchObject({
    status: 409, code: "file_version_conflict", message: "文件版本已更改，请比较最新内容后再保存。", serverMessage: "File version changed", details
  });
});

test("Chinese server validation details reach the UI unchanged", async () => {
  fetchMock.mockResolvedValue(Response.json({ error: { code: "reference_scope_invalid", message: "请选择至少一个参考章节。" } }, { status: 400 }));
  await expect(api.projects.readAsset("project", "image.png")).rejects.toMatchObject({ code: "reference_scope_invalid", message: "请选择至少一个参考章节。" });
});
