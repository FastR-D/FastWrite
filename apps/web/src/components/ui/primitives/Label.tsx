import type { LabelHTMLAttributes, ReactNode } from "react";
import styles from "./Label.module.css";

export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  children: ReactNode;
}

export function Label({ children, className = "", ...rest }: LabelProps) {
  return <label className={`${styles.label} ${className}`.trim()} {...rest}>{children}</label>;
}
