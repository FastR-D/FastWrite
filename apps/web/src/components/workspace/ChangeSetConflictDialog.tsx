import { useEffect, useState } from "react";
import { AlertTriangle, FileText } from "lucide-react";
import type { ChangeSetConflictDetails } from "@fastwrite/shared";
import { diffWords } from "../../lib/wordDiff";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

export function ChangeSetConflictDialog({ details, busy, onCancel, onConfirm }: {
  details: ChangeSetConflictDetails | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => setActiveIndex(0), [details]);
  const conflict = details?.conflicts[activeIndex];
  return <Dialog
    open={Boolean(details)}
    width="wide"
    className="changeset-conflict-dialog"
    title="File changed during review"
    description={`${details?.conflicts.length ?? 0} reviewed file${details?.conflicts.length === 1 ? "" : "s"} no longer match the workspace.`}
    onClose={() => { if (!busy) onCancel(); }}
    footer={<><Button variant="ghost" disabled={busy} onClick={onCancel}>Keep current files</Button><Button variant="danger" icon={<AlertTriangle />} loading={busy} onClick={onConfirm}>Overwrite with reviewed result</Button></>}
  >
    <div className="changeset-conflict">
      <nav aria-label="Conflicting files">{details?.conflicts.map((item, index) => <button className={index === activeIndex ? "is-active" : ""} key={item.path} onClick={() => setActiveIndex(index)}><FileText /><span>{item.path}</span><small>{item.currentContent === null ? "deleted" : "modified"}</small></button>)}</nav>
      <section>
        <header><strong>{conflict?.path}</strong><span>Current workspace → reviewed result</span></header>
        {conflict ? <div className="revision-diff" aria-label={`Overwrite diff for ${conflict.path}`}>{diffWords(conflict.currentContent ?? "", conflict.reviewedContent).map((part, index) => part.type === "delete" ? <del key={index}>{part.value}</del> : part.type === "insert" ? <ins key={index}>{part.value}</ins> : <span key={index}>{part.value}</span>)}</div> : null}
      </section>
    </div>
  </Dialog>;
}
