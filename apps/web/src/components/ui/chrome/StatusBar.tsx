import type { ReactNode } from "react";
import styles from "./StatusBar.module.css";

export interface StatusBarProps {
  children: ReactNode;
  /** Accessible name for the bar. */
  label: string;
  className?: string;
}

/**
 * The workbench status strip.
 *
 * `className` reaches the <footer> so the caller can keep the stable
 * `workbench-status` hook the e2e suite reads its innerText from. That element
 * carries aria-label but no role, so a role-based locator is impossible — the
 * class name is the only handle and must survive.
 */
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
