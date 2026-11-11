import type { ReferencePaper, ReferenceSettings, TextSelection } from "@fastwrite/shared";
import { Icon, IconButton, Tag, icons } from "../../ui";
import { ReferenceTags } from "../ReferenceTags";
import styles from "./AiWorkspace.module.css";

export function AiContextBar({ selection, settings, papers, disabled, onClear, onRemoveReference }: {
  selection: TextSelection | null;
  settings: ReferenceSettings | null;
  papers: ReferencePaper[];
  disabled: boolean;
  onClear: () => void;
  onRemoveReference: (id: string) => void;
}) {
  if (!selection && !settings?.selections.length) return null;
  return <div className={styles.context} aria-label="本次修改上下文">
    {selection ? <div className={`revise-context-strip ${styles.selection}`}>
      <Tag tone="ai" icon={<Icon name={icons.fileCode} size={14} />} title={selection.path}>{selection.path} · 行 {selection.startLine}–{selection.endLine}</Tag>
      <p title={selection.text}>{selection.text}</p>
      <IconButton label="清除所选上下文" icon={<Icon name={icons.close} />} disabled={disabled} onClick={onClear} />
    </div> : null}
    <ReferenceTags settings={settings} papers={papers} onRemove={onRemoveReference} />
  </div>;
}
