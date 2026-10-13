import { useEffect, useState } from "react";
import type { ChangeSetConflictDetails } from "@fastwrite/shared";
import { diffWords } from "../../lib/wordDiff";
import { Button, Dialog, Icon, icons } from "../ui";

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
    title="审核期间文件已发生更改"
    description={`${details?.conflicts.length ?? 0} 个已审核文件 已与工作区不一致。`}
    onClose={() => { if (!busy) onCancel(); }}
    footer={<><Button variant="ghost" disabled={busy} onClick={onCancel}>保留当前文件</Button><Button variant="danger" icon={<Icon name={icons.warning} />} loading={busy} onClick={onConfirm}>使用审核结果覆盖</Button></>}
  >
    <div className="changeset-conflict">
      <nav aria-label="冲突文件">{details?.conflicts.map((item, index) => <Button variant="ghost" className={index === activeIndex ? "is-active" : ""} key={item.path} onClick={() => setActiveIndex(index)}><Icon name={icons.fileText} /><span>{item.path}</span><small>{item.currentContent === null ? "已删除" : "已修改"}</small></Button>)}</nav>
      <section>
        <header><strong>{conflict?.path}</strong><span>当前工作区 → 审核结果</span></header>
        {conflict ? <div className="revision-diff" aria-label={`覆盖差异： ${conflict.path}`}>{diffWords(conflict.currentContent ?? "", conflict.reviewedContent).map((part, index) => part.type === "delete" ? <del key={index}>{part.value}</del> : part.type === "insert" ? <ins key={index}>{part.value}</ins> : <span key={index}>{part.value}</span>)}</div> : null}
      </section>
    </div>
  </Dialog>;
}
