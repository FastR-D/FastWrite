import type { ButtonHTMLAttributes, ReactNode } from "react";
import { LoaderCircle } from "lucide-react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "small" | "medium";
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({ variant = "secondary", size = "medium", loading = false, icon, children, className = "", disabled, ...props }: ButtonProps) {
  return (
    <button className={`button button--${variant} button--${size} ${className}`} disabled={disabled || loading} {...props}>
      {loading ? <LoaderCircle className="button__spinner" aria-hidden="true" /> : icon}
      {children ? <span>{children}</span> : null}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  icon: ReactNode;
  variant?: "ghost" | "secondary" | "danger";
}

export function IconButton({ label, icon, variant = "ghost", className = "", ...props }: IconButtonProps) {
  return (
    <button className={`icon-button icon-button--${variant} ${className}`} aria-label={label} title={label} {...props}>
      {icon}
    </button>
  );
}
