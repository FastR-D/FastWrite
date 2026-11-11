import type { ReactNode } from "react";
import styles from "./View.module.css";

export type ControlDensity = "compact" | "comfortable";

export interface ViewProps {
  children: ReactNode;
  /** When false the view is removed from layout but stays mounted, preserving scroll and editor state. */
  isVisible?: boolean;
  className?: string;
  "aria-label"?: string;
  role?: "group" | "region";
  id?: string;
  /** Inherited by shared controls; nested compact views restore workbench metrics. */
  density?: ControlDensity;
}

export function View({ children, isVisible = true, density, className = "", ...rest }: ViewProps) {
  return (
    <div className={`${styles.view} ${isVisible ? "" : styles.hidden} ${density ? styles[density] : ""} ${className}`.trim()} {...rest}>
      {children}
    </div>
  );
}
