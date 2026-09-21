import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { loadWorkspaceFile, loadWorkspaceSnapshot, saveWorkspaceFile, saveWorkspaceSnapshot } from "./offlineWorkspace";

const storage = new Map<string, string>();
const original = globalThis.localStorage;
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); }
} });

afterEach(() => storage.clear());

describe("offline workspace cache", () => {
  test("isolates snapshots and cached files by project and path", () => {
    const project = { id: "paper_a", name: "A", mainDocument: "main.tex", version: 3 } as never;
    saveWorkspaceSnapshot("paper_a", { project, tree: [], outline: [], claims: [] });
    saveWorkspaceFile("paper_a", "main.tex", { content: "A", file: { path: "main.tex", version: 3 } });
    saveWorkspaceFile("paper_b", "main.tex", { content: "B" });
    expect(loadWorkspaceSnapshot("paper_a")?.project.id).toBe("paper_a");
    expect(loadWorkspaceSnapshot("paper_b")).toBeNull();
    expect(loadWorkspaceFile<{ content: string }>("paper_a", "main.tex")?.content).toBe("A");
    expect(loadWorkspaceFile<{ content: string }>("paper_b", "main.tex")?.content).toBe("B");
  });

  test("ignores malformed snapshot and file records", () => {
    storage.set("fastwrite.workspace-snapshot:broken", "not-json");
    storage.set("fastwrite.workspace-file:broken:main.tex", "{}");
    expect(loadWorkspaceSnapshot("broken")).toBeNull();
    expect(loadWorkspaceFile<Record<string, never>>("broken", "main.tex")).toEqual({});
  });
});

afterAll(() => Object.defineProperty(globalThis, "localStorage", { configurable: true, value: original }));
