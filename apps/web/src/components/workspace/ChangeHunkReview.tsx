import { Check, X } from "lucide-react";
import type { TextChange } from "@fastwrite/shared";
import { diffWords } from "../../lib/wordDiff";
import { Button } from "../ui/Button";

export function ChangeHunkReview({ change, busy, onDecide }: { change: TextChange; busy: boolean; onDecide: (hunkIds: string[], status: "accepted" | "rejected") => void }) {
  const hunks = change.hunks ?? [];
  const pending = hunks.filter((hunk) => hunk.status === "pending");
  if (!hunks.length) return <div className="revision-diff">{diffWords(change.before, change.after).map((part, index) => part.type === "delete" ? <del key={index}>{part.value}</del> : part.type === "insert" ? <ins key={index}>{part.value}</ins> : <span key={index}>{part.value}</span>)}</div>;
  return <div className="hunk-review">
    <div className="hunk-review__toolbar"><span>{pending.length} of {hunks.length} hunks pending</span><Button size="small" variant="ghost" disabled={busy || !pending.length} onClick={() => onDecide(pending.map((hunk) => hunk.id), "rejected")}>Reject file</Button><Button size="small" variant="secondary" disabled={busy || !pending.length} onClick={() => onDecide(pending.map((hunk) => hunk.id), "accepted")}>Accept file</Button></div>
    <div className="hunk-review__list">{hunks.map((hunk, index) => {
      const parts = diffWords(hunk.before, hunk.after);
      return <article className={`hunk-card hunk-card--${hunk.status}`} key={hunk.id}>
        <header><span>Hunk {index + 1}</span><strong>{hunk.status}</strong></header>
        <div className="revision-diff">{parts.map((part, partIndex) => part.type === "delete" ? <del key={partIndex}>{part.value}</del> : part.type === "insert" ? <ins key={partIndex}>{part.value}</ins> : <span key={partIndex}>{part.value}</span>)}</div>
        {hunk.rationale || hunk.evidence?.length ? <div className="hunk-evidence">
          {hunk.rationale ? <p><strong>Reason</strong>{hunk.rationale}</p> : null}
          {hunk.evidence?.map((evidence, evidenceIndex) => <article key={`${evidence.issueId}-${evidence.path}-${evidenceIndex}`}>
            <header><strong>{evidence.issueTitle}</strong><code>{evidence.path}{evidence.line ? `:${evidence.line}` : ""}</code>{evidence.inferred ? <span>inferred</span> : null}</header>
            <blockquote>{evidence.excerpt}</blockquote>
          </article>)}
        </div> : null}
        {hunk.status === "pending" ? <footer><Button size="small" variant="ghost" icon={<X />} disabled={busy} onClick={() => onDecide([hunk.id], "rejected")}>Reject</Button><Button size="small" variant="primary" icon={<Check />} disabled={busy} onClick={() => onDecide([hunk.id], "accepted")}>Accept</Button></footer> : null}
      </article>;
    })}</div>
  </div>;
}
