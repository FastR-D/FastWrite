import type { ButtonHTMLAttributes, ComponentType, ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { Button as VscrButton } from "vscrui";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
const NativeVscrButton = VscrButton as unknown as ComponentType<ButtonHTMLAttributes<HTMLButtonElement> & { appearance?: "primary" | "secondary" | "icon" }>;

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "small" | "medium";
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({ variant = "secondary", size = "medium", loading = false, icon, children, className = "", disabled, ...props }: ButtonProps) {
  if (variant === "primary" || variant === "secondary") {
    return <NativeVscrButton type="button" appearance={variant} className={`fw-vscr-button fw-vscr-button--${size} ${className}`} disabled={disabled || loading} {...props}>
      {loading ? <LoaderCircle className="button__spinner" aria-hidden="true" /> : icon}
      {children ? <span>{children}</span> : null}
    </NativeVscrButton>;
  }
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
