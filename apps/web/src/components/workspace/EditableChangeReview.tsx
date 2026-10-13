import { useEffect, useState } from "react";
import type { TextChange } from "@fastwrite/shared";
import * as monaco from "../../lib/editor/monacoRuntime";
import { Button, Icon, TextArea, icons } from "../ui";
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
      setError(failure instanceof Error ? failure.message : "无法保存已编辑的建议内容");
    } finally {
      setSaving(false);
    }
  };

  if (!editing) return <div className="editable-change-review">
    {!readOnly && onSave ? <div className="editable-change-review__bar"><span>{editingDisabled ? "此文件已有完成审核的修改块，请在下方继续审核。" : "查看生成的差异，或在接受前编辑建议文本。"}</span>{!editingDisabled ? <Button size="small" variant="secondary" icon={<Icon name={icons.edit} />} disabled={busy} onClick={() => setEditing(true)}>编辑建议内容</Button> : null}</div> : null}
    <ProposalMonacoDiff change={change} readOnly={readOnly} />
    <ChangeHunkReview change={change} busy={busy} readOnly={readOnly} showToolbar={showHunkToolbar} onDecide={onDecide} {...(onEditHunk ? { onEditHunk } : {})} {...(onNavigate ? { onNavigate } : {})} />
  </div>;

  return <div className="proposal-editor">
    <header><div><strong>正在编辑建议内容</strong><span>{change.path}</span></div><small>接受前不会更改工作区文件。</small></header>
    <TextArea aria-label={`可编辑建议： ${change.path}`} value={draft} onChange={setDraft} spellCheck={false} autoFocus />
    {error ? <div className="form-error" role="alert">{error}</div> : null}
    <footer><Button size="small" variant="ghost" icon={<Icon name={icons.close} />} disabled={saving} onClick={() => { setDraft(change.after); setEditing(false); setError(""); }}>取消编辑</Button><Button size="small" variant="primary" icon={<Icon name={icons.check} />} loading={saving} disabled={saving || draft === change.after || draft === change.before} onClick={() => void save()}>保存建议内容</Button></footer>
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
  return models ? <TextModelComparison original={models.original} modified={models.modified} originalLabel={`原始建议 ${change.path}`} modifiedLabel={`智能助手建议 ${change.path}`} readOnly={readOnly} /> : null;
}
