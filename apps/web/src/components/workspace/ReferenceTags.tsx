import type { ReferencePaper, ReferenceSettings, StyleReferenceContext } from "@fastwrite/shared";
import { referenceScopeLabel } from "./ReferenceStylePanel";
import { Button } from "../ui";
import styles from "./ReferenceStylePanel.module.css";

export function ReferenceTags({ settings, papers, onRemove }: { settings: ReferenceSettings | null; papers: ReferencePaper[]; onRemove: (id: string) => void }) {
  if (!settings?.selections.length) return null;
  return <div className={styles.tags} aria-label="写作参考设置"><span>写作参考：</span>{settings.selections.map(selection => <span className={styles.tag} key={selection.referenceId}>{papers.find(paper => paper.id === selection.referenceId)?.title ?? "参考论文"} · {referenceScopeLabel(selection)} <Button size="small" variant="ghost" aria-label={`移除参考 ${papers.find(paper => paper.id === selection.referenceId)?.title ?? selection.referenceId}`} onClick={() => onRemove(selection.referenceId)}>×</Button></span>)}</div>;
}

export function ReferenceSnapshotSummary({ context }: { context?: StyleReferenceContext | undefined }) {
  if (!context?.references.length) return null;
  return <div className={styles.tags} aria-label="计划使用的参考快照"><span>本计划已固定参考范围：</span>{context.references.map(reference => <span className={styles.tag} key={reference.referenceId}>{reference.title} · {referenceScopeLabel(reference)} · 已分析 {reference.coverage.characters.toLocaleString("zh-CN")} 字符</span>)}</div>;
}
