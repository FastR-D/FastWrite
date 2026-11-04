import type { ReactNode } from "react";
import styles from "./StatusBar.module.css";

export interface StatusBarProps {
  children: ReactNode;
  /** Accessible name for the bar. */
  label: string;
  className?: string;
}

/** Generic status strip for component consumers. */
export function StatusBar({ children, label, className = "" }: StatusBarProps) {
  return (
    <footer className={`${styles.bar} ${className}`.trim()} aria-label={label}>
      {children}
    </footer>
  );
}

export interface StatusItemProps {
  children: ReactNode;
  icon?: ReactNode;
  title?: string;
  /** Push this item and everything after it to the right edge. */
  trailing?: boolean;
}

export function StatusItem({ children, icon, title, trailing = false }: StatusItemProps) {
  return (
    <span className={`${styles.item} ${trailing ? styles.spacer : ""}`.trim()} title={title}>
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      {children}
    </span>
  );
}
