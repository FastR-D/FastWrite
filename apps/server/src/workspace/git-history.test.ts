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

test("working status reads both groups from one call and bootstraps the index", async () => {
  const { root, workspace, history } = await fixture();
  await writeFile(join(workspace, "main.tex"), "one\n");
  await writeFile(join(workspace, "sections.tex"), "two\n");
  await history.snapshot(root, workspace, "Manual checkpoint");
  const head = (await history.list(root, 1))[0]!.oid;

  // Change one tracked file, add an untracked one, and stage a third.
  await writeFile(join(workspace, "main.tex"), "one changed\n");
  await writeFile(join(workspace, "refs.bib"), "new\n");
  await writeFile(join(workspace, "sections.tex"), "two changed\n");
  await history.stage(root, workspace, ["sections.tex"]);

  const status = await history.workingStatus(root, workspace);
  expect(status.head).toBe(head);
  const byPath = Object.fromEntries(status.files.map((file) => [file.path, file]));
  expect(byPath["main.tex"]).toMatchObject({ unstaged: "M", staged: null, untracked: false });
  expect(byPath["refs.bib"]).toMatchObject({ untracked: true, staged: null, unstaged: null });
  // Staged and then unmodified: staged only.
  expect(byPath["sections.tex"]).toMatchObject({ staged: "M", unstaged: null });
});

test("a file staged and then edited again appears in both groups", async () => {
  const { root, workspace, history } = await fixture();
  await writeFile(join(workspace, "main.tex"), "one\n");
  await history.snapshot(root, workspace, "Manual checkpoint");
  await writeFile(join(workspace, "main.tex"), "two\n");
  await history.stage(root, workspace, ["main.tex"]);
  await writeFile(join(workspace, "main.tex"), "three\n");

  const file = (await history.workingStatus(root, workspace)).files[0]!;
  expect(file.staged).toBe("M");
  expect(file.unstaged).toBe("M");
});

test("stage and unstage move a file between the two groups", async () => {
  const { root, workspace, history } = await fixture();
  await writeFile(join(workspace, "main.tex"), "one\n");
  await history.snapshot(root, workspace, "Manual checkpoint");
  await writeFile(join(workspace, "main.tex"), "two\n");

  await history.stage(root, workspace, ["main.tex"]);
  let file = (await history.workingStatus(root, workspace)).files[0]!;
  expect(file.staged).toBe("M");
  expect(file.unstaged).toBeNull();

  await history.unstage(root, workspace, ["main.tex"]);
  file = (await history.workingStatus(root, workspace)).files[0]!;
  expect(file.staged).toBeNull();
  expect(file.unstaged).toBe("M");
});

test("unstage on the repository's first commit leaves the file untracked again", async () => {
  const { root, workspace, history } = await fixture();
  await writeFile(join(workspace, "new.tex"), "content\n");
  await history.stage(root, workspace, ["new.tex"]);
  expect((await history.workingStatus(root, workspace)).files[0]!.staged).toBe("A");

  // `git restore --staged` fails against an unborn HEAD, so this path must be
  // handled rather than left to throw.
  await history.unstage(root, workspace, ["new.tex"]);
  const file = (await history.workingStatus(root, workspace)).files[0]!;
  expect(file.untracked).toBe(true);
  expect(file.staged).toBeNull();
});

test("discard reverts a tracked file to its staged content", async () => {
  const { root, workspace, history } = await fixture();
  await writeFile(join(workspace, "main.tex"), "committed\n");
  await history.snapshot(root, workspace, "Manual checkpoint");
  await writeFile(join(workspace, "main.tex"), "staged\n");
  await history.stage(root, workspace, ["main.tex"]);
  await writeFile(join(workspace, "main.tex"), "unstaged edit\n");

  await history.discard(root, workspace, ["main.tex"]);
  expect(await readFile(join(workspace, "main.tex"), "utf8")).toBe("staged\n");
});

test("discard deletes an untracked file", async () => {
  const { root, workspace, history } = await fixture();
  await writeFile(join(workspace, "scratch.tex"), "draft\n");
  await history.discard(root, workspace, ["scratch.tex"]);
  expect((await history.workingStatus(root, workspace)).files).toEqual([]);
});

test("operations refuse an empty path list", async () => {
  const { root, workspace, history } = await fixture();
  await writeFile(join(workspace, "main.tex"), "one\n");
  await history.snapshot(root, workspace, "Manual checkpoint");

  // A empty list reaching `git add` with no pathspec would stage everything;
  // in discard it would delete the entire working tree. Rejected at the edge.
  for (const call of [
    () => history.stage(root, workspace, []),
    () => history.unstage(root, workspace, []),
    () => history.discard(root, workspace, [])
  ]) {
    await expect(call()).rejects.toThrow();
  }
});

test("operations refuse a path that escapes the workspace", async () => {
  const { root, workspace, history } = await fixture();
  await writeFile(join(workspace, "main.tex"), "one\n");
  await history.snapshot(root, workspace, "Manual checkpoint");
  await expect(history.discard(root, workspace, ["../../etc/passwd"])).rejects.toThrow();
});

test("discard restores a staged deletion from HEAD", async () => {
  const { root, workspace, history } = await fixture();
  await writeFile(join(workspace, "gone.tex"), "committed content\n");
  await history.snapshot(root, workspace, "Manual checkpoint");

  // `git rm` stages the deletion, which empties the index entry. Restoring from
  // the index then matches nothing — measured to exit 0 while doing nothing —
  // so this path must source from HEAD.
  await history.stageRemoval(root, workspace, ["gone.tex"]);
  expect((await history.workingStatus(root, workspace)).files[0]).toMatchObject({ staged: "D" });

  await history.discard(root, workspace, ["gone.tex"]);
  expect(await readFile(join(workspace, "gone.tex"), "utf8")).toBe("committed content\n");
});

test("discard refuses a conflicted file", async () => {
  const { root, workspace, history } = await fixture();
  await writeFile(join(workspace, "main.tex"), "one\n");
  await history.snapshot(root, workspace, "Manual checkpoint");

  /*
   * Build a real conflict rather than asserting on a hand-made status.
   *
   * The helper returns the exit code instead of throwing, because `git merge`
   * exits **1** when it conflicts — the expected outcome here. A helper that
   * rejected on non-zero would kill the test before it asserted anything.
   */
  const runGit = async (args: string[]) => {
    const child = Bun.spawn(["git", `--git-dir=${join(root, "history.git")}`, `--work-tree=${workspace}`, ...args], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(child.stdout).text();
    await new Response(child.stderr).text();
    return { code: await child.exited, stdout };
  };

  /*
   * The base branch is read, not assumed, and returned to by name rather than
   * with `checkout -`. `-` resolves `@{-1}` from the reflog, so it goes back to
   * whatever was previous rather than to what this test meant — and if
   * `checkout -b` were to fail, the merge would find nothing to merge, exit 0,
   * and report "already up to date" with no conflict at all.
   */
  const base = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  await runGit(["checkout", "-q", "-b", "other"]);
  await writeFile(join(workspace, "main.tex"), "other\n");
  await runGit(["commit", "-qam", "other"]);
  await runGit(["checkout", "-q", base]);
  await writeFile(join(workspace, "main.tex"), "main\n");
  await runGit(["commit", "-qam", "main"]);
  // `--no-edit` so a clean merge cannot block on an editor in a non-TTY runner.
  await runGit(["merge", "--no-edit", "other"]);

  const status = await history.workingStatus(root, workspace);
  expect(status.files.some((file) => file.conflicted)).toBe(true);
  await expect(history.discard(root, workspace, ["main.tex"])).rejects.toThrow(/conflict/i);
});

test("commit records the index and leaves unstaged work alone", async () => {
  const { root, workspace, history } = await fixture();
  await writeFile(join(workspace, "main.tex"), "one\n");
  await writeFile(join(workspace, "other.tex"), "one\n");
  await history.snapshot(root, workspace, "Manual checkpoint");

  await writeFile(join(workspace, "main.tex"), "two\n");
  await writeFile(join(workspace, "other.tex"), "two\n");
  await history.stage(root, workspace, ["main.tex"]);
  const oid = await history.commit(root, workspace, "Stage one file");
  expect(oid).toBeTruthy();

  // The commit contains main.tex only; other.tex is still unstaged.
  const summary = await history.summary(root, oid!);
  expect(summary.files.map((file) => file.path)).toEqual(["main.tex"]);

  const file = (await history.workingStatus(root, workspace)).files.find((entry) => entry.path === "other.tex")!;
  expect(file.unstaged).toBe("M");
  expect(file.staged).toBeNull();
});

test("commit with nothing staged is refused", async () => {
  const { root, workspace, history } = await fixture();
  await writeFile(join(workspace, "main.tex"), "one\n");
  await history.snapshot(root, workspace, "Manual checkpoint");
  await expect(history.commit(root, workspace, "Nothing to commit")).rejects.toThrow(/nothing/i);
});

test("a project with no repository yet gets one, with its exclusions", async () => {
  const { root, workspace, history } = await fixture();
  // No snapshot first — this is a freshly created project.
  await writeFile(join(workspace, "main.tex"), "content\n");

  const status = await history.workingStatus(root, workspace);
  expect(status.head).toBeNull();
  expect(status.files.map((file) => file.path)).toEqual(["main.tex"]);

  // The exclude file is what keeps engine artifacts out of the status.
  expect(await readFile(join(root, "history.git", "info", "exclude"), "utf8")).toContain(".fastwrite");
});
