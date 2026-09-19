import type { ReactNode } from "react";
import { icons } from "../icons";
import { Icon } from "../primitives/Icon";
import styles from "./EmptyState.module.css";

export interface EmptyStateProps {
  title: string;
  /** One or two sentences on what to do next. */
  detail?: string;
  icon?: ReactNode;
  /** A single call to action, e.g. "Start review". */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ title, detail, icon, action, className = "" }: EmptyStateProps) {
  return (
    <div className={`${styles.empty} ${className}`.trim()}>
      <span className={styles.icon} aria-hidden="true">{icon ?? <Icon name={icons.info} size={20} />}</span>
      <span className={styles.title}>{title}</span>
      {detail ? <span className={styles.detail}>{detail}</span> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
