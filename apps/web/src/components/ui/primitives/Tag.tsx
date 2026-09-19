import type { ReactNode } from "react";
import styles from "./Tag.module.css";

export interface TagProps {
  children: ReactNode;
  /** Status colour. Always paired with text — never colour alone. */
  tone?: "neutral" | "success" | "danger" | "warning" | "info";
  icon?: ReactNode;
  title?: string;
  className?: string;
}

export function Tag({ children, tone = "neutral", icon, className = "", ...rest }: TagProps) {
  return (
    <span className={`${styles.tag} ${styles[tone]} ${className}`.trim()} {...rest}>
      {icon}
      {children}
    </span>
  );
}
