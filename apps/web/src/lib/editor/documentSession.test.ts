import { expect, test } from "bun:test";
import { DocumentSession } from "./documentSession";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("old ACK preserves new input and next save uses acknowledged version", async () => {
  const first = deferred<{ version: number }>();
  const second = deferred<{ version: number }>();
  const calls: Array<{ content: string; baseVersion: number; revision: number }> = [];
  const session = new DocumentSession("p", "a.tex", "", 4, (snapshot) => {
    calls.push(snapshot);
    return calls.length === 1 ? first.promise : second.promise;
  });
  session.edit("A");
  const flushA = session.flush();
  session.edit("AB");
  const flushB = session.flush();
  expect(calls).toHaveLength(1);
  first.resolve({ version: 5 });
  await flushA;
  expect(session.content).toBe("AB");
  expect(session.dirty).toBe(true);
  expect(calls[1]).toEqual({ content: "AB", baseVersion: 5, revision: 2 });
  second.resolve({ version: 6 });
  await flushB;
  expect(session.dirty).toBe(false);
});

test("failed flush rejects, retains newest input and can retry", async () => {
  const pending = deferred<{ version: number }>();
  let attempts = 0;
  const session = new DocumentSession("p", "a", "base", 1, async () => ++attempts === 1 ? pending.promise : { version: 2 });
  session.edit("A");
  const flushed = session.flush();
  session.edit("AB");
  pending.reject(new Error("offline"));
  await expect(flushed).rejects.toThrow("offline");
  expect(session.content).toBe("AB");
  expect(session.baseContent).toBe("base");
  expect(session.dirty).toBe(true);
  await session.flush();
  expect(session.baseContent).toBe("AB");
  expect(session.dirty).toBe(false);
});

test("switching active documents does not cancel either document's debounce", async () => {
  const writes: string[] = [];
  const a = new DocumentSession("p", "a", "", 1, async ({ content }) => { writes.push(`a:${content}`); return { version: 2 }; }, 1);
  const b = new DocumentSession("p", "b", "", 1, async ({ content }) => { writes.push(`b:${content}`); return { version: 2 }; }, 1);
  a.edit("alpha");
  b.edit("beta");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(writes.sort()).toEqual(["a:alpha", "b:beta"]);
  expect(a.dirty || b.dirty).toBe(false);
  expect(new DocumentSession("other", "a", "", 1, async () => ({ version: 2 })).key).not.toBe(a.key);
});

test("metadata refresh and own ACK cannot reset a dirty working buffer", async () => {
  const pending = deferred<{ version: number }>();
  const session = new DocumentSession("p", "a", "base", 1, () => pending.promise);
  session.edit("A");
  const saved = session.flush();
  session.edit("AB");
  expect(session.receive("base", 1)).toBe(false);
  expect(session.content).toBe("AB");
  pending.resolve({ version: 2 });
  await saved;
  expect(session.receive("A", 2)).toBe(false);
  expect(session.content).toBe("AB");
  await session.flush();
});

test("external updates require a clean session and preserve dirty text", async () => {
  const session = new DocumentSession("p", "a", "base", 1, async () => ({ version: 4 }));
  expect(session.receive("remote", 2)).toBe(true);
  expect(session.content).toBe("remote");
  session.edit("local");
  expect(session.receive("other", 3)).toBe(false);
  expect(session.content).toBe("local");
  expect(session.baseContent).toBe("remote");
  expect(session.error).toBeInstanceOf(Error);
  await session.flush();
});

test("reviewed conflict resolution rebases conditionally and remains dirty until ACK", async () => {
  const pending = deferred<{ version: number }>();
  const calls: unknown[] = [];
  const session = new DocumentSession("p", "conflict", "base", 1, snapshot => { calls.push(snapshot); return pending.promise; }, 10000);
  session.edit("ours");
  expect(() => session.resolveConflict("merged", "theirs", 3, 0)).toThrow("Local text changed");
  expect(session.content).toBe("ours");
  session.resolveConflict("merged", "theirs", 3, 1);
  expect(session.baseContent).toBe("theirs");
  expect(session.dirty).toBe(true);
  const saved = session.flush();
  expect(calls).toEqual([{ content: "merged", baseVersion: 3, revision: 2 }]);
  expect(() => session.resolveConflict("stale", "theirs", 3, 2)).toThrow("in progress");
  pending.resolve({ version: 4 }); await saved;
  expect(session.content).toBe("merged");
  expect(session.dirty).toBe(false);
  expect(() => session.resolveConflict("old", "old", 2, 2)).toThrow("older");
});

test("a rejected reviewed merge preserves the result and its reviewed baseline", async () => {
  const session = new DocumentSession("p", "conflict", "base", 1, async () => { throw new Error("version conflict"); }, 10000);
  session.edit("ours");
  session.resolveConflict("merged", "theirs", 2, 1);
  await expect(session.flush()).rejects.toThrow("version conflict");
  expect(session.content).toBe("merged");
  expect(session.baseContent).toBe("theirs");
  expect(session.dirty).toBe(true);
});
