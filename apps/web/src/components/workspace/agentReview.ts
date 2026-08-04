import type { ChangeSet, ChangeSetDecisionRequest, TextChange, TextHunkStatus } from "@fastwrite/shared";

export interface HunkCounts {
  total: number;
  pending: number;
  accepted: number;
  rejected: number;
}

export function hunkCounts(change: TextChange): HunkCounts {
  const hunks = change.hunks ?? [];
  return {
    total: hunks.length,
    pending: hunks.filter((hunk) => hunk.status === "pending").length,
    accepted: hunks.filter((hunk) => hunk.status === "accepted").length,
    rejected: hunks.filter((hunk) => hunk.status === "rejected").length
  };
}

export function changeSetHunkCounts(changeSet: ChangeSet): HunkCounts {
  return changeSet.changes.reduce((counts, change) => {
    const next = hunkCounts(change);
    return {
      total: counts.total + next.total,
      pending: counts.pending + next.pending,
      accepted: counts.accepted + next.accepted,
      rejected: counts.rejected + next.rejected
    };
  }, { total: 0, pending: 0, accepted: 0, rejected: 0 });
}

export function fileReviewState(change: TextChange): TextHunkStatus | "mixed" {
  const counts = hunkCounts(change);
  if (counts.pending) return "pending";
  if (counts.accepted && counts.rejected) return "mixed";
  if (counts.accepted) return "accepted";
  return "rejected";
}

export function pendingDecisions(changeSet: ChangeSet, status: "accepted" | "rejected"): ChangeSetDecisionRequest["decisions"] {
  return changeSet.changes.flatMap((change) => {
    const hunkIds = (change.hunks ?? []).filter((hunk) => hunk.status === "pending").map((hunk) => hunk.id);
    return hunkIds.length ? [{ path: change.path, hunkIds, status }] : [];
  });
}
