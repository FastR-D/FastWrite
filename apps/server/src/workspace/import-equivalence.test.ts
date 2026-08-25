import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceTreeNode } from "@fastwrite/shared";
import { JsonDatabase } from "../storage/database";
import { WorkspaceService } from "./workspace-service";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("managed import equivalence", () => {
  test("normalizes local and GitHub copies into the same workspace tree", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "fastwrite-import-equivalence-"));
    const sourceDirectory = await mkdtemp(join(tmpdir(), "fastwrite-import-source-"));
    temporaryDirectories.push(dataDirectory, sourceDirectory);

    await mkdir(join(sourceDirectory, "sections"), { recursive: true });
    await mkdir(join(sourceDirectory, "figures"), { recursive: true });
    await mkdir(join(sourceDirectory, ".git"), { recursive: true });
    await mkdir(join(sourceDirectory, ".writeagent", "backups", "main.tex"), { recursive: true });
    await writeFile(join(sourceDirectory, "main.tex"), "\\documentclass{article}\n\\input{sections/intro}", "utf8");
    await writeFile(join(sourceDirectory, "sections", "intro.tex"), "\\section{Introduction}\nHello", "utf8");
    await writeFile(join(sourceDirectory, "figures", "plot.png"), new Uint8Array([137, 80, 78, 71]));
    await writeFile(join(sourceDirectory, ".git", "config"), "must not enter the workspace", "utf8");
    await writeFile(join(sourceDirectory, ".writeagent", "backups", "main.tex", "old.tex"), "must not become a main document", "utf8");

    const database = new JsonDatabase(dataDirectory);
    await database.initialize();
    const workspaces = new WorkspaceService(dataDirectory, database);
    await workspaces.initialize();

    const local = await workspaces.copyExternalDirectory({
      sourceDirectory,
      name: "Local paper",
      mainDocument: "main.tex",
      venue: "network-information-security",
      source: { type: "local", displayName: "paper" }
    });
    const github = await workspaces.copyExternalDirectory({
      sourceDirectory,
      name: "GitHub paper",
      mainDocument: "main.tex",
      venue: "network-information-security",
      source: {
        type: "github",
        repository: "https://github.com/example/paper",
        ref: "HEAD",
        commit: "0123456789abcdef0123456789abcdef01234567"
      }
    });

    expect(flattenTree(await workspaces.tree(local.id))).toEqual(flattenTree(await workspaces.tree(github.id)));
    expect(await readFile(join(workspaces.workspaceRoot(local.id), "figures", "plot.png"))).toEqual(
      await readFile(join(workspaces.workspaceRoot(github.id), "figures", "plot.png"))
    );
    expect(flattenTree(await workspaces.tree(local.id)).some((entry) => entry.path.startsWith(".git"))).toBe(false);
    expect(flattenTree(await workspaces.tree(local.id)).some((entry) => entry.path.startsWith(".writeagent"))).toBe(false);
  });
});

function flattenTree(nodes: WorkspaceTreeNode[]): Array<{ path: string; type: WorkspaceTreeNode["type"]; kind?: string; size?: number }> {
  return nodes.flatMap((node) => node.type === "directory"
    ? [{ path: node.path, type: node.type }, ...flattenTree(node.children)]
    : [{ path: node.path, type: node.type, kind: node.kind, size: node.size }]);
}
