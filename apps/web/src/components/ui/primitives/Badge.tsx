import type { ReactNode } from "react";
import styles from "./Badge.module.css";

export interface BadgeProps {
  children: ReactNode;
  /** Accessible description; the bare number alone is rarely meaningful. */
  label?: string;
  className?: string;
}

export function Badge({ children, label, className = "" }: BadgeProps) {
  return (
    <span className={`${styles.badge} ${className}`.trim()} aria-label={label} title={label}>
      {children}
    </span>
  );
}
