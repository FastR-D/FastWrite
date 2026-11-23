import { useState, type ComponentProps } from "react";
import { Icon, IconButton, icons } from "../ui";
import { WorkingChangesView } from "./WorkingChangesView";
import styles from "./SourceControlView.module.css";

export interface DiffRequest { baseRef: string; targetRef: string; path: string; oldPath?: string; projectVersion?: number; }

export function gitRefLabel(ref: string): string {
  return ref === "index" ? "暂存版本" : ref === "empty" ? "空版本" : ref.slice(0, 8);
}

type SourceControlProps = Omit<ComponentProps<typeof WorkingChangesView>, "refreshRevision"> & {
  onSync?: () => void;
};

export function SourceControlView({ onSync, ...props }: SourceControlProps) {
  const [refreshRevision, setRefreshRevision] = useState(0);

  return <section className={styles.panel} aria-label="版本控制">
    <header className={styles.toolbar}>
      <span className={styles.panelIcon}><Icon name={icons.sourceControl} size={15} aria-hidden /></span>
      <h2>版本控制</h2>
      {onSync ? <IconButton className={styles.iconAction} label="与 GitHub 同步" icon={<Icon name={icons.sync} size={14} />} onClick={onSync} /> : null}
      <IconButton className={styles.iconAction} label="刷新版本控制" icon={<Icon name={icons.refresh} size={14} />} onClick={() => setRefreshRevision(value => value + 1)} />
    </header>
    <WorkingChangesView {...props} refreshRevision={refreshRevision} />
  </section>;
}
