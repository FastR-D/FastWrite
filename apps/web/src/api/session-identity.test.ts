import { expect, test } from "bun:test";
import { requestResponse } from "./client";
import { rememberSession, sessionIdentity } from "../lib/sessionIdentity";

test("refresh preserves draft ownership and an old request cannot retry as another account", async () => {
  const descriptors = Object.fromEntries(["localStorage", "window", "fetch"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
  try {
    rememberSession({ token: "account-a-old", user: { id: "account-a" } });
    const scope = sessionIdentity().scope;
    const requests: string[] = [];
    Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: async (path: string, init: RequestInit) => {
      requests.push(path);
      if (path === "/api/auth/refresh") return Response.json({ token: "account-a-refreshed", user: { id: "account-a" } });
      return new Headers(init.headers).get("authorization") === "Bearer account-a-refreshed" ? Response.json({ saved: true }) : new Response(null, { status: 401 });
    } });
    expect((await requestResponse("/api/projects/shared/file", { method: "PUT", body: "draft A" })).status).toBe(200);
    expect(requests).toHaveLength(3);
    expect(sessionIdentity().scope).toBe(scope);

    let resolveRequest!: (response: Response) => void;
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return await new Promise<Response>(resolve => { resolveRequest = resolve; }); }) as unknown as typeof fetch;
    const pending = requestResponse("/api/projects/shared/file", { method: "PUT", body: "draft A" });
    void pending.catch(() => undefined);
    rememberSession({ token: "account-b", user: { id: "account-b" } });
    resolveRequest(new Response(null, { status: 401 }));
    await expect(pending).rejects.toMatchObject({ code: "session_changed" });
    expect(calls).toBe(1);
  } finally {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
