import type { ReactNode } from "react";
import styles from "./Text.module.css";

export interface TextProps {
  children: ReactNode;
  tone?: "default" | "muted";
  size?: "small" | "normal";
  mono?: boolean;
  className?: string;
}

/** Inline typography that wraps long paths and follows the workbench theme. */
export function Text({ children, tone = "default", size = "normal", mono = false, className = "" }: TextProps) {
  return <span className={[styles.text, styles[tone], styles[size], mono ? styles.mono : "", className].filter(Boolean).join(" ")}>{children}</span>;
}
