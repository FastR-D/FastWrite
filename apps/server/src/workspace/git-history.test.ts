import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rename, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitHistory } from "./git-history";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fastwrite-history-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  return { root, workspace, history: new GitHistory() };
}

test("real root and subsequent changes distinguish rename, deletion, empty and binary files", async () => {
  const { root, workspace, history } = await fixture();
  const original = "中文 name [1] : old.tex";
  const renamed = "中文 renamed [2].tex";
  await writeFile(join(workspace, original), "one\ntwo\nthree\n");
  await writeFile(join(workspace, "deleted.tex"), "delete me\n");
  await writeFile(join(workspace, "modified.tex"), "before\n");
  await writeFile(join(workspace, "empty.tex"), "");
  const first = (await history.snapshot(root, workspace, "Manual checkpoint"))!;
  const initial = await history.summary(root, first);
  expect(initial.parentOids).toEqual([]);
  expect(initial.files.every(file => file.status === "A")).toBe(true);
  expect(initial.source).toBe("manual");
  expect(await history.compare(root, "empty", first, original)).toMatchObject({ original: { ref: "empty", exists: false }, modified: { ref: first, exists: true } });
  await rename(join(workspace, original), join(workspace, renamed));
  await rm(join(workspace, "deleted.tex"));
  await writeFile(join(workspace, "modified.tex"), "after\nextra\n");
  await writeFile(join(workspace, "image.png"), new Uint8Array([137, 80, 0, 255]));
  const second = (await history.snapshot(root, workspace, "Autosave modified.tex"))!;
  const indexBefore = await readFile(join(root, "history.git/index"));
  const summary = await history.summary(root, second);
  expect(summary.parentOids).toEqual([first]);
  expect(summary.source).toBe("automatic");
  expect(summary.files).toContainEqual({ path: renamed, oldPath: original, status: "R", binary: false, additions: 0, deletions: 0 });
  expect(summary.files.find(file => file.path === "deleted.tex")?.status).toBe("D");
  expect(summary.files.find(file => file.path === "modified.tex")).toMatchObject({ status: "M", additions: 2, deletions: 1 });
  expect(summary.files.find(file => file.path === "image.png")).toMatchObject({ status: "A", binary: true, additions: null });
  expect((await history.tree(root, first)).map(file => file.path)).toContain("deleted.tex");
  expect(await history.side(root, first, "empty.tex")).toMatchObject({ exists: true, binary: false, content: "", size: 0 });
  expect(await history.side(root, second, "deleted.tex")).toMatchObject({ exists: false });
  expect(await history.side(root, second, "image.png")).toMatchObject({ exists: true, binary: true, size: 4 });
  expect(await history.compare(root, first, second, renamed, original)).toMatchObject({ original: { ref: first, path: original, content: "one\ntwo\nthree\n" }, modified: { ref: second, path: renamed, content: "one\ntwo\nthree\n" } });
  await expect(history.fileAt(root, second, "deleted.tex")).rejects.toMatchObject({ status: 404 });
  await expect(history.fileAt(root, second, "image.png")).rejects.toMatchObject({ status: 415 });
  expect(await readFile(join(root, "history.git/index"))).toEqual(indexBefore);
});

test("pagination is anchored against new snapshots and path filters are literal", async () => {
  const { root, workspace, history } = await fixture();
  await writeFile(join(workspace, "[a].tex"), "first");
  const first = (await history.snapshot(root, workspace, "first"))!;
  await writeFile(join(workspace, "a.tex"), "second");
  const second = (await history.snapshot(root, workspace, "second"))!;
  const page = await history.page(root, { limit: 1 });
  expect(page.commits.map(item => item.oid)).toEqual([second]);
  expect(page.nextCursor).toBeString();
  await writeFile(join(workspace, "a.tex"), "third");
  await history.snapshot(root, workspace, "third");
  const next = await history.page(root, { limit: 1, cursor: page.nextCursor! });
  expect(next.commits.map(item => item.oid)).toEqual([first]);
  expect(next.nextCursor).toBeNull();
  expect((await history.page(root, { path: "[a].tex" })).commits.map(item => item.oid)).toEqual([first]);
  await expect(history.page(root, { cursor: page.nextCursor!, path: "a.tex" })).rejects.toMatchObject({ status: 400 });
  await expect(history.side(root, first, "../secret")).rejects.toMatchObject({ status: 400 });
  await expect(history.summary(root, "HEAD")).rejects.toMatchObject({ status: 404 });
  await expect(history.summary(root, "a".repeat(40))).rejects.toMatchObject({ status: 404 });
});

test("a reachable checkpoint older than 200 commits remains readable", async () => {
  const { root, workspace, history } = await fixture();
  await writeFile(join(workspace, "main.tex"), "original");
  const first = (await history.snapshot(root, workspace, "first"))!;
  for (let index = 0; index < 201; index++) {
    await writeFile(join(workspace, "main.tex"), String(index));
    await history.snapshot(root, workspace, `checkpoint ${index}`);
  }
  expect((await history.list(root, 200)).some(commit => commit.oid === first)).toBe(false);
  expect((await history.summary(root, first)).oid).toBe(first);
  expect(await history.fileAt(root, first, "main.tex")).toBe("original");
}, 30000);


test("unreachable commits in the object database cannot be read as managed history", async () => {
  const { root, workspace, history } = await fixture();
  await writeFile(join(workspace, "main.tex"), "main");
  const first = (await history.snapshot(root, workspace, "first"))!;
  const git = async (args: string[]) => {
    const child = Bun.spawn(["git", `--git-dir=${join(root, "history.git")}`, ...args], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    return output.trim();
  };
  const tree = await git(["rev-parse", `${first}^{tree}`]);
  const orphan = await git(["commit-tree", tree, "-m", "unreachable"]);
  await expect(history.summary(root, orphan)).rejects.toMatchObject({ status: 404 });
  await expect(history.fileAt(root, orphan, "main.tex")).rejects.toMatchObject({ status: 404 });
});

test("compares arbitrary checkpoint pairs with net changes and reversible rename paths", async () => {
  const { root, workspace, history } = await fixture();
  await writeFile(join(workspace, "old name.tex"), "stable content\n".repeat(10));
  await writeFile(join(workspace, "gone.tex"), "gone\n");
  await writeFile(join(workspace, "unchanged.tex"), "original\n");
  const base = (await history.snapshot(root, workspace, "base"))!;
  await writeFile(join(workspace, "unchanged.tex"), "temporary\n");
  await history.snapshot(root, workspace, "intermediate");
  await writeFile(join(workspace, "unchanged.tex"), "original\n");
  await rename(join(workspace, "old name.tex"), join(workspace, "新 name.tex"));
  await rm(join(workspace, "gone.tex"));
  await writeFile(join(workspace, "added.tex"), "new\n");
  const target = (await history.snapshot(root, workspace, "target"))!;
  const comparison = await history.changes(root, base, target);
  expect(comparison).toMatchObject({ baseRef: base, targetRef: target });
  expect(comparison.files).toHaveLength(3);
  expect(comparison.files).toContainEqual(expect.objectContaining({ status: "R", oldPath: "old name.tex", path: "新 name.tex" }));
  expect(comparison.files).toContainEqual(expect.objectContaining({ status: "D", path: "gone.tex" }));
  expect(comparison.files).toContainEqual(expect.objectContaining({ status: "A", path: "added.tex" }));
  const reverse = await history.changes(root, target, base);
  expect(reverse.files).toContainEqual(expect.objectContaining({ status: "R", oldPath: "新 name.tex", path: "old name.tex" }));
  expect((await history.changes(root, base, base)).files).toEqual([]);
});

test("working-tree comparison is isolated, includes uncheckpointed add delete rename, and does not move history HEAD", async () => {
  const { root, workspace, history } = await fixture();
  await writeFile(join(workspace, "base.tex"), "base\n");
  await writeFile(join(workspace, "old.tex"), "rename me\n".repeat(10));
  await writeFile(join(workspace, "removed.tex"), "remove\n");
  const base = (await history.snapshot(root, workspace, "base"))!;
  await writeFile(join(workspace, "base.tex"), "modified\n");
  await rename(join(workspace, "old.tex"), join(workspace, "renamed.tex"));
  await rm(join(workspace, "removed.tex"));
  await writeFile(join(workspace, "added.tex"), "added\n");
  const before = (await history.list(root))[0]!.oid;
  const changes = await history.workingChanges(root, workspace, base);
  expect(changes.files).toEqual(expect.arrayContaining([
    expect.objectContaining({ status: "M", path: "base.tex" }),
    expect.objectContaining({ status: "R", oldPath: "old.tex", path: "renamed.tex" }),
    expect.objectContaining({ status: "D", path: "removed.tex" }),
    expect.objectContaining({ status: "A", path: "added.tex" }),
  ]));
  expect((await history.list(root))[0]!.oid).toBe(before);
  const renamed = await history.workingComparison(root, workspace, base, "renamed.tex", "old.tex");
  expect(renamed.original.content).toContain("rename me");
  expect(renamed.modified.content).toContain("rename me");
  const deleted = await history.workingComparison(root, workspace, base, "removed.tex");
  expect(deleted).toMatchObject({ original: { exists: true }, modified: { exists: false } });
});
