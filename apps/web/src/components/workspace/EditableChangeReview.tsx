import { useEffect, useState } from "react";
import { Check, Pencil, X } from "lucide-react";
import type { TextChange } from "@fastwrite/shared";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import { Button } from "../ui/Button";
import { ChangeHunkReview } from "./ChangeHunkReview";
import { TextModelComparison } from "../workbench/TextModelComparison";
import { configureMonaco, languageForPath } from "../../lib/editor/monaco";

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
    <ProposalMonacoDiff change={change} readOnly={readOnly} />
    <ChangeHunkReview change={change} busy={busy} readOnly={readOnly} showToolbar={showHunkToolbar} onDecide={onDecide} {...(onEditHunk ? { onEditHunk } : {})} {...(onNavigate ? { onNavigate } : {})} />
  </div>;

  return <div className="proposal-editor">
    <header><div><strong>Editing proposed content</strong><span>{change.path}</span></div><small>The workspace file is unchanged until you accept.</small></header>
    <textarea aria-label={`Editable proposal for ${change.path}`} value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} autoFocus />
    {error ? <div className="form-error" role="alert">{error}</div> : null}
    <footer><Button size="small" variant="ghost" icon={<X />} disabled={saving} onClick={() => { setDraft(change.after); setEditing(false); setError(""); }}>Cancel edit</Button><Button size="small" variant="primary" icon={<Check />} loading={saving} disabled={saving || draft === change.after || draft === change.before} onClick={() => void save()}>Save proposal</Button></footer>
  </div>;
}

function ProposalMonacoDiff({ change, readOnly }: { change: TextChange; readOnly: boolean }) {
  const [models, setModels] = useState<{ original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel } | null>(null);
  useEffect(() => {
    configureMonaco();
    const identity = crypto.randomUUID();
    const original = monaco.editor.createModel(change.before, languageForPath(change.path), monaco.Uri.from({ scheme: "fastwrite-agent", authority: "proposal", path: `/${change.path}`, query: `${identity}-before` }));
    const modified = monaco.editor.createModel(change.after, languageForPath(change.path), monaco.Uri.from({ scheme: "fastwrite-agent", authority: "proposal", path: `/${change.path}`, query: `${identity}-after` }));
    setModels({ original, modified });
    return () => { setModels(null); original.dispose(); modified.dispose(); };
  }, [change.path, change.before, change.after]);
  return models ? <TextModelComparison original={models.original} modified={models.modified} originalLabel={`Original proposal ${change.path}`} modifiedLabel={`Agent proposal ${change.path}`} readOnly={readOnly} /> : null;
}
