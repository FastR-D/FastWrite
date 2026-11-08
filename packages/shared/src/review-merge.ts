import { buildReviewHunks } from "./text-hunks";

/** Merge independent draft edits without turning an incoming edit into a deletion. */
export function mergeReviewDraft(base: string, local: string, incoming: string): { content: string; conflict: boolean } {
  if (local === base || local === incoming) return { content: incoming, conflict: false };
  if (incoming === base) return { content: local, conflict: false };
  const ours = buildReviewHunks(base, local), theirs = buildReviewHunks(base, incoming);
  const combined = [...ours];
  for (const remote of theirs) {
    let duplicate = false;
    for (const own of ours) {
      if (own.from === remote.from && own.to === remote.to && own.after === remote.after) { duplicate = true; break; }
      const overlaps = Math.max(own.from, remote.from) < Math.min(own.to, remote.to)
        || own.from === own.to && remote.from <= own.from && own.from <= remote.to
        || remote.from === remote.to && own.from <= remote.from && remote.from <= own.to;
      if (overlaps) return { content: local, conflict: true };
    }
    if (!duplicate) combined.push(remote);
  }
  let content = base;
  for (const edit of combined.sort((a, b) => b.from - a.from)) content = content.slice(0, edit.from) + edit.after + content.slice(edit.to);
  return { content, conflict: false };
}
