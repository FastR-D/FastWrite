import { useMemo } from "react";
import type { ChangeSet } from "@fastwrite/shared";
import { diffWords } from "../../../lib/wordDiff";
import { Button, Icon, Tag, TextArea, icons } from "../../ui";
import styles from "./AiWorkspace.module.css";

export function ChangeSetCard({ changeSet, rationale, editing, editedAfter, busy, onEdit, onEditText, onCancelEdit, onDecide, onRollback }: {
  changeSet: ChangeSet;
  rationale?: string | undefined;
  editing: boolean;
  editedAfter: string;
  busy: boolean;
  onEdit: () => void;
  onEditText: (text: string) => void;
  onCancelEdit: () => void;
  onDecide: (decision: "accept" | "reject") => void;
  onRollback: () => void;
}) {
  const change = changeSet.changes[0];
  const proposedAfter = editing ? editedAfter : change?.after ?? "";
  const diff = useMemo(() => diffWords(change?.before ?? "", proposedAfter), [change?.before, proposedAfter]);
  if (!change) return null;
  const accepted = changeSet.status === "accepted";
  const pending = changeSet.status === "proposed";
  return <section className={styles.proposal} aria-label="修改候选">
    <header className={styles.proposalHeading}><code>{change.path}</code><Tag tone={accepted ? "success" : "info"}>{accepted ? "已应用" : "待审核"}</Tag></header>
    {editing ? <TextArea className={`revision-edit-textarea ${styles.editInput}`} aria-label="可编辑的修改文本" value={editedAfter} onChange={onEditText} spellCheck={false} autoFocus /> : <div className={`revision-diff ${styles.diff}`} aria-label="建议的逐词更改">{diff.map((part, index) => part.type === "delete" ? <del key={index}>{part.value}</del> : part.type === "insert" ? <ins key={index}>{part.value}</ins> : <span key={index}>{part.value}</span>)}</div>}
    {rationale ? <p className={styles.rationale}>{rationale}</p> : null}
    <footer className={`revision-inline-actions ${styles.proposalActions}`}>
      {accepted ? <><span className={`revision-accepted ${styles.accepted}`}><Icon name={icons.check} /> 已应用</span><Button size="small" variant="ghost" icon={<Icon name={icons.discard} />} disabled={busy} onClick={onRollback}>回滚</Button></> : pending ? <>
        <Button size="small" variant="ghost" icon={<Icon name={icons.close} />} disabled={busy} onClick={() => onDecide("reject")}>拒绝</Button>
        {editing ? <Button size="small" variant="ghost" disabled={busy} onClick={onCancelEdit}>取消编辑</Button> : <Button size="small" variant="secondary" icon={<Icon name={icons.edit} />} disabled={busy} onClick={onEdit}>编辑</Button>}
        <Button size="small" variant="primary" icon={<Icon name={icons.check} />} disabled={busy || (editing && (!editedAfter.trim() || editedAfter === change.before))} onClick={() => onDecide("accept")}>{editing && editedAfter !== change.after ? "保存并接受" : "接受"}</Button>
      </> : null}
    </footer>
  </section>;
}
