import { describe, expect, test } from "bun:test";
import type { ChangeSet, TextChange } from "@fastwrite/shared";
import { changeSetHunkCounts, fileReviewState, hunkCounts, pendingDecisions } from "./agentReview";

const change = (path: string, statuses: Array<"pending" | "accepted" | "rejected">): TextChange => ({
  path,
  from: 0,
  to: 0,
  before: "",
  after: "changed",
  baseVersion: 1,
  hunks: statuses.map((status, index) => ({ id: `${path}-${index}`, from: 0, to: 0, before: "", after: `${index}`, status }))
});

const changeSet = (changes: TextChange[]): ChangeSet => ({
  id: "change-test",
  projectId: "paper-test",
  agentRunId: "run-test",
  status: "partially-accepted",
  summary: "test",
  rationale: "test",
  changes,
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z"
});

describe("Agent ChangeSet review", () => {
  test("counts pending, accepted, and rejected hunks per file and overall", () => {
    const first = change("main.tex", ["accepted", "pending", "rejected"]);
    const second = change("method.tex", ["accepted", "accepted"]);
    expect(hunkCounts(first)).toEqual({ total: 3, pending: 1, accepted: 1, rejected: 1 });
    expect(changeSetHunkCounts(changeSet([first, second]))).toEqual({ total: 5, pending: 1, accepted: 3, rejected: 1 });
    expect(fileReviewState(first)).toBe("pending");
    expect(fileReviewState(second)).toBe("accepted");
  });

  test("bulk accept selects only pending hunks and never re-accepts rejected hunks", () => {
    const decisions = pendingDecisions(changeSet([
      change("main.tex", ["rejected", "pending"]),
      change("method.tex", ["accepted", "pending"])
    ]), "accepted");
    expect(decisions).toEqual([
      { path: "main.tex", hunkIds: ["main.tex-1"], status: "accepted" },
      { path: "method.tex", hunkIds: ["method.tex-1"], status: "accepted" }
    ]);
  });
});
