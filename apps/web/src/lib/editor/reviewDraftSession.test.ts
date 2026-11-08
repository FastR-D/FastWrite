import { expect, test } from "bun:test";
import type { CollaborationReviewSessionView } from "@fastwrite/shared";
import { ReviewDraftSession, type ReviewDraftPort, type ReviewDraftRecord } from "./reviewDraftSession";
const base = (): CollaborationReviewSessionView => ({ id: "review_1", projectId: "p", documentId: "doc", path: "main.tex", authorUserId: "user_1", baseContent: "base", draftContent: "base", fileVersion: 1, revision: 0, pendingCount: 0, createdAt: "", updatedAt: "" });
function port(overrides: Partial<ReviewDraftPort> = {}) {
  const records: ReviewDraftRecord[] = [];
  const value: ReviewDraftPort = { start: async () => base(), load: async () => undefined, store: async record => { records.push(structuredClone(record)); }, archive: async () => undefined, save: async (_id, input) => ({ ...base(), revision: input.expectedRevision + 1, draftContent: input.draftContent, lastOperationId: input.operationId }), ...overrides };
  return { value, records };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test("a review ACK cannot overwrite newer input, and the next request uses its revision", async () => {
  const ack = deferred<CollaborationReviewSessionView>();
  const calls: Array<{ draftContent: string; expectedRevision: number; operationId: string }> = [];
  const p = port({ save: async (_id, input) => { calls.push(input); if (calls.length === 1) return ack.promise; return { ...base(), revision: input.expectedRevision + 1, draftContent: input.draftContent }; } });
  const draft = new ReviewDraftSession(p.value, () => undefined, 100_000); await draft.ready();
  draft.edit("first"); const saving = draft.flush();
  while (!calls.length) await new Promise(resolve => setTimeout(resolve, 1));
  draft.edit("newest"); ack.resolve({ ...base(), revision: 1, draftContent: "first" }); await saving;
  expect(calls.map(call => [call.draftContent, call.expectedRevision])).toEqual([["first", 0], ["newest", 1]]);
  expect(draft.content).toBe("newest"); expect(draft.dirty).toBe(false); await draft.dispose();
});

test("lost network acknowledgements retry the identical operation and retain the local draft", async () => {
  const calls: string[] = []; let fail = true;
  const p = port({ save: async (_id, input) => { calls.push(input.operationId); if (fail) throw new TypeError("offline"); return { ...base(), revision: 1, draftContent: input.draftContent, lastOperationId: input.operationId }; } });
  const draft = new ReviewDraftSession(p.value, () => undefined, 100_000); await draft.ready(); draft.edit("local proposal");
  await expect(draft.flush()).rejects.toThrow("offline");
  expect(draft.state).toBe("offline"); expect(p.records.at(-1)?.content).toBe("local proposal");
  fail = false; await draft.flush(); expect(calls[0]).toBe(calls[1]); expect(draft.state).toBe("saved"); await draft.dispose();
});

test("a stale window preserves input and archives it before starting a new round", async () => {
  const archived: string[] = [];
  const cached: ReviewDraftRecord = { session: base(), content: "unsent local" };
  const p = port({ load: async () => cached, start: async previous => previous ? { ...base(), id: "review_2", baseContent: "accepted latest", draftContent: "accepted latest" } : { ...base(), revision: 2, draftContent: "other window" }, archive: async record => { archived.push(record.content); } });
  const draft = new ReviewDraftSession(p.value, () => undefined, 100_000); await draft.ready();
  expect(draft.state).toBe("conflict"); expect(draft.content).toBe("unsent local");
  await draft.nextRound(); expect(archived).toEqual(["unsent local"]); expect(draft.content).toBe("accepted latest"); await draft.dispose();
});


test("an incoming accepted edit merges with input typed while a save is pending", async () => {
  const ack = deferred<CollaborationReviewSessionView>(); const calls: string[] = [];
  const initial = { ...base(), baseContent: "title\nbody", draftContent: "title\nbody" };
  const p = port({ start: async () => initial, save: async (_id, input) => { calls.push(input.draftContent); if (calls.length === 1) return ack.promise; return { ...initial, revision: 2, baseContent: "accepted title\nbody", draftContent: input.draftContent }; } });
  const draft = new ReviewDraftSession(p.value, () => undefined, 100_000); await draft.ready(); draft.edit("title\nour body");
  const saving = draft.flush(); while (!calls.length) await new Promise(resolve => setTimeout(resolve, 1));
  draft.edit("title\nour newest body"); ack.resolve({ ...initial, revision: 1, baseContent: "accepted title\nbody", draftContent: "accepted title\nour body" }); await saving;
  expect(draft.content).toBe("accepted title\nour newest body"); expect(calls.at(-1)).toBe("accepted title\nour newest body"); await draft.dispose();
});

test("clean review buffers refresh live accepted text without dropping their pending suggestion", async () => {
  const initial = { ...base(), baseContent: "title\nbody", draftContent: "title\nour body", revision: 1 };
  const p = port({ start: async () => initial, read: async () => ({ ...initial, revision: 2, baseContent: "new title\nbody", draftContent: "new title\nour body" }) });
  const draft = new ReviewDraftSession(p.value, () => undefined, 100_000); await draft.ready(); await draft.refresh();
  expect(draft.content).toBe("new title\nour body"); expect(draft.session?.baseContent).toBe("new title\nbody"); expect(draft.dirty).toBe(false); await draft.dispose();
});
