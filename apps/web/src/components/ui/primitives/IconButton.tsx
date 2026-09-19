import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./IconButton.module.css";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Accessible name. Applied as both aria-label and title. */
  label: string;
  icon: ReactNode;
  variant?: "ghost" | "secondary" | "danger";
}

export function IconButton({ label, icon, variant = "ghost", className = "", type = "button", ...rest }: IconButtonProps) {
  const classes = [
    styles.iconButton,
    variant === "secondary" ? styles.bordered : "",
    variant === "danger" ? styles.danger : "",
    className
  ].filter(Boolean).join(" ");

  return (
    <button className={classes} type={type} aria-label={label} title={label} {...rest}>
      <span className={styles.icon} aria-hidden="true">{icon}</span>
    </button>
  );
}
