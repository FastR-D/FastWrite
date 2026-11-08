import { expect, test } from "bun:test";
import { mergeReviewDraft } from "./review-merge";
test("review rebase preserves independent local input and incoming accepted changes", () => {
  expect(mergeReviewDraft("title\nbody\nend", "title\nnew body\nend", "new title\nbody\nend")).toEqual({ content: "new title\nnew body\nend", conflict: false });
  expect(mergeReviewDraft("title\nbody", "title\nbody!", "% remote\ntitle\nbody")).toEqual({ content: "% remote\ntitle\nbody!", conflict: false });
});
test("overlapping review rebases retain local input for explicit comparison", () => {
  expect(mergeReviewDraft("old", "ours", "theirs")).toEqual({ content: "ours", conflict: true });
  expect(mergeReviewDraft("x", "one x", "two x")).toEqual({ content: "one x", conflict: true });
  expect(mergeReviewDraft("old", "same", "same")).toEqual({ content: "same", conflict: false });
});
