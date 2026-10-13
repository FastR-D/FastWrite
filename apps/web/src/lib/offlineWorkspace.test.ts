import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { canUseOfflineCache, loadWorkspaceFile, loadWorkspaceSnapshot, saveWorkspaceFile, saveWorkspaceSnapshot } from "./offlineWorkspace";

const storage = new Map<string, string>();
const original = globalThis.localStorage;
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); }
} });

afterEach(() => storage.clear());

describe("offline workspace cache", () => {
  test("isolates snapshots and cached files by project and path", async () => {
    const project = { id: "paper_a", name: "A", mainDocument: "main.tex", version: 3 } as never;
    await saveWorkspaceSnapshot("paper_a", { project, tree: [], outline: [], claims: [] });
    await saveWorkspaceFile("paper_a", "main.tex", { content: "A", file: { path: "main.tex", version: 3 } });
    await saveWorkspaceFile("paper_b", "main.tex", { content: "B" });
    expect((await loadWorkspaceSnapshot("paper_a"))?.project.id).toBe("paper_a");
    expect(await loadWorkspaceSnapshot("paper_b")).toBeNull();
    expect((await loadWorkspaceFile<{ content: string }>("paper_a", "main.tex"))?.content).toBe("A");
    expect((await loadWorkspaceFile<{ content: string }>("paper_b", "main.tex"))?.content).toBe("B");
  });

  test("ignores malformed snapshot and file records", async () => {
    storage.set("fastwrite.workspace-snapshot:v2:local:broken", "not-json");
    storage.set("fastwrite.workspace-file:v2:local:broken:main.tex", "{}");
    expect(await loadWorkspaceSnapshot("broken")).toBeNull();
    expect(await loadWorkspaceFile<Record<string, never>>("broken", "main.tex")).toEqual({});
  });
});

afterAll(() => Object.defineProperty(globalThis, "localStorage", { configurable: true, value: original }));

 test("cached content cannot cross login sessions and HTTP errors never trigger recovery", async () => {
  storage.set("fastwrite.session-token", "owner-session");
  await saveWorkspaceFile("private", "main.tex", {content:"private data"});
  expect(await loadWorkspaceFile<{ content: string }>("private", "main.tex")).toEqual({content:"private data"});
  storage.set("fastwrite.session-token", "another-session");
  expect(await loadWorkspaceFile<{ content: string }>("private", "main.tex")).toBeNull();
  storage.delete("fastwrite.session-token");
  expect(await loadWorkspaceFile<{ content: string }>("private", "main.tex")).toBeNull();
  expect(canUseOfflineCache(new TypeError("Failed to fetch"))).toBe(true);
  for(const error of [new Error("Access denied"), Object.assign(new Error("unauthorized"), {status:401}), new DOMException("cancelled", "AbortError"), new TypeError("undefined is not a function")]) expect(canUseOfflineCache(error)).toBe(false);
 });
