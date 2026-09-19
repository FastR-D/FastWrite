import type { ReactNode } from "react";
import styles from "./View.module.css";

export interface ViewProps {
  children: ReactNode;
  /** When false the view is removed from layout but stays mounted, preserving scroll and editor state. */
  isVisible?: boolean;
  className?: string;
  "aria-label"?: string;
  id?: string;
}

export function View({ children, isVisible = true, className = "", ...rest }: ViewProps) {
  return (
    <div className={`${styles.view} ${isVisible ? "" : styles.hidden} ${className}`.trim()} {...rest}>
      {children}
    </div>
  );
}
