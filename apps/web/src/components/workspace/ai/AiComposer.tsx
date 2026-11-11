import type { ReactNode, Ref } from "react";
import type { ReviseCommandId } from "@fastwrite/shared";
import { Button, Icon, TextArea, icons } from "../../ui";
import type { AiPanelState } from "./AiMessage";
import styles from "./AiWorkspace.module.css";

export function AiComposer({ instruction, state, hasSelection, inputRef, shortcuts, context, onChange, onSubmit, onShortcut, onMore, onStop }: {
  instruction: string;
  state: AiPanelState;
  hasSelection: boolean;
  inputRef: Ref<HTMLTextAreaElement>;
  shortcuts: ReadonlyArray<{ id: ReviseCommandId; label: string }>;
  context: ReactNode;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onShortcut: (id: ReviseCommandId) => void;
  onMore: () => void;
  onStop: () => void;
}) {
  const running = state === "running";
  const applying = state === "applying";
  const busy = running || applying;
  const canSubmit = hasSelection && !!instruction.trim() && !busy;
  return <form className={`revise-composer ${styles.composer}`} onSubmit={event => { event.preventDefault(); if (canSubmit) onSubmit(); }}>
    {context}
    <div className={`revise-shortcuts ${styles.shortcuts}`} role="group" aria-label="快捷修改指令">
      {shortcuts.map(shortcut => <Button variant="ghost" className="revise-shortcut" size="small" key={shortcut.id} disabled={!hasSelection || busy} onClick={() => onShortcut(shortcut.id)}>{shortcut.label}</Button>)}
      <Button variant="ghost" className="revise-shortcut" size="small" icon={<Icon name={icons.ellipsis} />} disabled={!hasSelection || busy} onClick={onMore}>更多操作</Button>
    </div>
    <div className={`revise-composer__input ${styles.inputBox}`}>
      <TextArea ref={inputRef} className={styles.input ?? ""} rows={2} value={instruction} onChange={onChange} onKeyDown={event => {
        if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        event.preventDefault();
        if (canSubmit) onSubmit();
      }} placeholder={hasSelection ? "提出进一步修改要求…" : "在编辑器中选择文本以开始…"} disabled={!hasSelection || busy} aria-label="修改要求" />
      {running ? <Button variant="secondary" size="small" icon={<Icon name={icons.circleSlash} />} onClick={onStop}>停止生成</Button> : <Button variant="primary" size="small" icon={<Icon name={icons.send} />} loading={applying} disabled={!canSubmit} onClick={() => { if (canSubmit) onSubmit(); }}>{applying ? "应用中" : "发送"}</Button>}
    </div>
    <span className={styles.composerHint}>Enter 发送 · Shift+Enter 换行</span>
  </form>;
}
