import type { CSSProperties } from "react";
import styles from "./Divider.module.css";

export interface DividerProps {
  orientation?: "horizontal" | "vertical";
  /** Inline style, forwarded — some rules carry their own vertical margin. */
  style?: CSSProperties;
  className?: string;
}

export function Divider({ orientation = "horizontal", className = "", style }: DividerProps) {
  return (
    <hr
      className={`${styles.divider} ${styles[orientation]} ${className}`.trim()}
      style={style}
      aria-orientation={orientation === "vertical" ? "vertical" : undefined}
    />
  );
}
