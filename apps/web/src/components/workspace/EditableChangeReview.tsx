import { useEffect, useState } from "react";
import { Check, Pencil, X } from "lucide-react";
import type { TextChange } from "@fastwrite/shared";
import { Button } from "../ui/Button";
import { ChangeHunkReview } from "./ChangeHunkReview";

interface EditableChangeReviewProps {
  change: TextChange;
  busy: boolean;
  readOnly?: boolean;
  editingDisabled?: boolean;
  showHunkToolbar?: boolean;
  onDecide: (hunkIds: string[], status: "accepted" | "rejected") => void;
  onSave?: (after: string) => Promise<void>;
  onEditHunk?: (hunkId: string, after: string) => Promise<void>;
  onNavigate?: (path: string, line?: number) => void;
}

export function EditableChangeReview({ change, busy, readOnly = false, editingDisabled = false, showHunkToolbar = true, onDecide, onSave, onEditHunk, onNavigate }: EditableChangeReviewProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(change.after);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setEditing(false);
    setDraft(change.after);
    setError("");
  }, [change.path, change.after]);

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await onSave!(draft);
      setEditing(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save the edited proposal");
    } finally {
      setSaving(false);
    }
  };

  if (!editing) return <div className="editable-change-review">
    {!readOnly && onSave ? <div className="editable-change-review__bar"><span>{editingDisabled ? "This file has decided hunks; continue reviewing them below." : "Review the generated Diff, or edit the proposed text before accepting."}</span>{!editingDisabled ? <Button size="small" variant="secondary" icon={<Pencil />} disabled={busy} onClick={() => setEditing(true)}>Edit proposal</Button> : null}</div> : null}
    <ChangeHunkReview change={change} busy={busy} readOnly={readOnly} showToolbar={showHunkToolbar} onDecide={onDecide} {...(onEditHunk ? { onEditHunk } : {})} {...(onNavigate ? { onNavigate } : {})} />
  </div>;

  return <div className="proposal-editor">
    <header><div><strong>Editing proposed content</strong><span>{change.path}</span></div><small>The workspace file is unchanged until you accept.</small></header>
    <textarea aria-label={`Editable proposal for ${change.path}`} value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} autoFocus />
    {error ? <div className="form-error" role="alert">{error}</div> : null}
    <footer><Button size="small" variant="ghost" icon={<X />} disabled={saving} onClick={() => { setDraft(change.after); setEditing(false); setError(""); }}>Cancel edit</Button><Button size="small" variant="primary" icon={<Check />} loading={saving} disabled={saving || draft === change.after || draft === change.before} onClick={() => void save()}>Save proposal</Button></footer>
  </div>;
}
