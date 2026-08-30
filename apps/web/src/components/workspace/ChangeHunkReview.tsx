import { useEffect, useState } from "react";
import { Check, Pencil, X } from "lucide-react";
import type { TextChange } from "@fastwrite/shared";
import { diffWords } from "../../lib/wordDiff";
import { Button } from "../ui/Button";
import { hunkCounts } from "./agentReview";

export function ChangeHunkReview({ change, busy, readOnly = false, showToolbar = true, onDecide, onEditHunk }: { change: TextChange; busy: boolean; readOnly?: boolean; showToolbar?: boolean; onDecide: (hunkIds: string[], status: "accepted" | "rejected") => void; onEditHunk?: (hunkId: string, after: string) => Promise<void> }) {
  const hunks = change.hunks ?? [];
  const pending = hunks.filter((hunk) => hunk.status === "pending");
  const pendingHasBlocking = pending.some((hunk) => hunk.findings?.some((finding) => finding.status === "blocking"));
  const counts = hunkCounts(change);
  const [editingHunk, setEditingHunk] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setEditingHunk(null); setDraft(""); setError(""); }, [change.path, change.after]);
  const saveEdit = async () => {
    if (!editingHunk || !onEditHunk) return;
    setSaving(true); setError("");
    try { await onEditHunk(editingHunk, draft); setEditingHunk(null); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Could not save the edited hunk"); }
    finally { setSaving(false); }
  };
  if (!hunks.length) return <div className="revision-diff">{diffWords(change.before, change.after).map((part, index) => part.type === "delete" ? <del key={index}>{part.value}</del> : part.type === "insert" ? <ins key={index}>{part.value}</ins> : <span key={index}>{part.value}</span>)}</div>;
  return <div className="hunk-review">
    {showToolbar ? <div className="hunk-review__toolbar"><span className="review-counts"><b className="is-pending">Pending {counts.pending}/{counts.total}</b><b className="is-accepted">Accepted {counts.accepted}/{counts.total}</b><b className="is-rejected">Rejected {counts.rejected}/{counts.total}</b></span>{!readOnly ? <><Button size="small" variant="ghost" disabled={busy || !pending.length} onClick={() => onDecide(pending.map((hunk) => hunk.id), "rejected")}>Reject pending file hunks</Button><Button size="small" variant="secondary" disabled={busy || !pending.length || pendingHasBlocking} title={pendingHasBlocking ? "Edit or reject hunks with blocking evidence findings first" : undefined} onClick={() => onDecide(pending.map((hunk) => hunk.id), "accepted")}>Accept pending file hunks</Button></> : null}</div> : null}
    <div className="hunk-review__list">{hunks.map((hunk, index) => {
      const parts = diffWords(hunk.before, hunk.after);
      const editing = editingHunk === hunk.id;
      return <article className={`hunk-card hunk-card--${hunk.status}`} key={hunk.id}>
        <header><span>Hunk {index + 1}</span><strong>{hunk.status}</strong></header>
        {editing ? <div className="hunk-editor"><textarea aria-label={`Edit hunk ${index + 1} for ${change.path}`} value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} autoFocus />{error ? <div className="form-error" role="alert">{error}</div> : null}<footer><Button size="small" variant="ghost" icon={<X />} disabled={saving} onClick={() => { setEditingHunk(null); setDraft(""); setError(""); }}>Cancel edit</Button><Button size="small" variant="primary" icon={<Check />} loading={saving} disabled={saving || draft === hunk.after || draft === hunk.before} onClick={() => void saveEdit()}>Save hunk</Button></footer></div> : <div className="revision-diff">{parts.map((part, partIndex) => part.type === "delete" ? <del key={partIndex}>{part.value}</del> : part.type === "insert" ? <ins key={partIndex}>{part.value}</ins> : <span key={partIndex}>{part.value}</span>)}</div>}
        {hunk.rationale || hunk.evidence?.length ? <div className="hunk-evidence">
          {hunk.rationale ? <p><strong>Reason</strong>{hunk.rationale}</p> : null}
          {hunk.evidence?.map((evidence, evidenceIndex) => <article key={`${evidence.issueId}-${evidence.path}-${evidenceIndex}`}>
            <header><strong>{evidence.issueTitle}</strong><code>{evidence.path}{evidence.line ? `:${evidence.line}` : ""}</code>{evidence.inferred ? <span>inferred</span> : null}</header>
            <blockquote>{evidence.excerpt}</blockquote>
          </article>)}
        </div> : null}
        {hunk.findings?.length ? <div className="hunk-findings">{hunk.findings.map((finding) => <p className={`is-${finding.status}`} key={finding.id}><strong>{finding.status}</strong><span>{finding.message}</span></p>)}</div> : null}
        {!readOnly && !editing ? <footer>{onEditHunk ? <Button size="small" variant="secondary" icon={<Pencil />} disabled={busy || hunk.status === "accepted"} title={hunk.status === "accepted" ? "Change to reject before editing this hunk" : "Edit only this hunk"} onClick={() => { setEditingHunk(hunk.id); setDraft(hunk.after); setError(""); }}>Edit hunk</Button> : null}{hunk.status !== "rejected" ? <Button size="small" variant="ghost" icon={<X />} disabled={busy} onClick={() => onDecide([hunk.id], "rejected")}>{hunk.status === "accepted" ? "Change to reject" : "Reject"}</Button> : null}{hunk.status !== "accepted" ? <Button size="small" variant={hunk.status === "pending" ? "primary" : "secondary"} icon={<Check />} disabled={busy || hunk.findings?.some((finding) => finding.status === "blocking")} title={hunk.findings?.some((finding) => finding.status === "blocking") ? "Edit or reject this hunk to resolve its blocking finding" : undefined} onClick={() => onDecide([hunk.id], "accepted")}>{hunk.status === "rejected" ? "Change to accept" : "Accept"}</Button> : null}</footer> : null}
      </article>;
    })}</div>
  </div>;
}
