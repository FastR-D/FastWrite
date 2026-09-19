import type { ReactNode } from "react";
import styles from "./ListRow.module.css";

export interface ListProps {
  children: ReactNode;
  /** Accessible name. Required — a bare list is announced as an unlabelled list. */
  label: string;
  /** Render as <ol> for sequences (commit history, step timelines). */
  ordered?: boolean;
  compact?: boolean;
  className?: string;
}

export function List({ children, label, ordered = false, compact = false, className = "" }: ListProps) {
  const classes = `${styles.list} ${compact ? styles.compact : ""} ${className}`.trim();
  return ordered
    ? <ol className={classes} aria-label={label}>{children}</ol>
    : <ul className={classes} aria-label={label}>{children}</ul>;
}

export interface ListRowProps {
  children: ReactNode;
  /**
   * Makes the whole row a button. Omit for rows that only display content —
   * the row then renders its children directly inside the <li>.
   */
  onClick?: () => void;
  /** Highlight as the current row. */
  selected?: boolean;
  /** Skip pointer/keyboard interaction without dimming (e.g. a placeholder row). */
  disabled?: boolean;
  title?: string;
  className?: string;
}

export function ListRow({ children, onClick, selected = false, disabled = false, title, className = "" }: ListRowProps) {
  if (!onClick) {
    return <li className={`${styles.row} ${className}`.trim()} title={title}>{children}</li>;
  }

  const classes = [styles.rowButton, selected ? styles.selected : "", className].filter(Boolean).join(" ");

  return (
    <li className={styles.row}>
      <button type="button" className={classes} onClick={onClick} disabled={disabled} title={title} aria-current={selected ? "true" : undefined}>
        {children}
      </button>
    </li>
  );
}

/** A row with a bold primary label and a muted secondary line. */
export function ListRowText({ primary, secondary }: { primary: ReactNode; secondary?: ReactNode }) {
  return (
    <span className={styles.rowContent}>
      <span className={styles.primary}>{primary}</span>
      {secondary ? <span className={styles.secondary}>{secondary}</span> : null}
    </span>
  );
}

export function ListEmpty({ children }: { children: ReactNode }) {
  return <li className={styles.empty}>{children}</li>;
}
