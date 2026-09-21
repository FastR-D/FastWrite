import type { ButtonHTMLAttributes, ComponentType, ReactNode } from "react";
import { Button as VscruiButton } from "vscrui";
import { icons } from "../icons";
import { Icon } from "./Icon";
import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "small" | "medium";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  onClick?: () => void;
}

/*
 * vscrui's Button types `onClick` as `() => void` and omits the usual button
 * attributes, so bridge its prop surface to ours explicitly rather than via a
 * blanket cast. The index signature keeps arbitrary pass-through attributes
 * (tabIndex, autoFocus, data-*) legal, since vscrui spreads them onto the DOM.
 *
 * `onClick` admits an explicit `undefined` because the project enables
 * `exactOptionalPropertyTypes` and the handler is passed through unconditionally.
 */
type VscruiButtonProps = {
  appearance?: "primary" | "secondary" | "icon";
  className?: string;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  onClick?: (() => void) | undefined;
  [key: string]: unknown;
};
const Vscrui = VscruiButton as unknown as ComponentType<VscruiButtonProps>;

export function Button({
  variant = "secondary",
  size = "medium",
  loading = false,
  icon,
  children,
  className = "",
  disabled,
  type = "button",
  onClick,
  ...rest
}: ButtonProps) {
  const classes = `${styles.button} ${styles[size]} ${variant === "danger" ? styles.danger : ""} ${variant === "ghost" ? styles.ghost : ""} ${className}`.trim();
  // CSS-module lookups are `string | undefined` under noUncheckedIndexedAccess;
  // Icon's className is a plain optional string, so default it to "".
  const leading = loading ? <Icon name={icons.loading} spin className={styles.spinner ?? ""} /> : icon;

  /*
   * primary / secondary map onto vscrui appearances. ghost and danger do not,
   * and are rendered here.
   *
   * ghost used to be mapped to vscrui's `icon` appearance, which is its
   * ICON-BUTTON shape: 3px padding, a 5px radius and a dotted hover outline. A
   * text ghost wearing it looked like a different control from the primary next
   * to it. vscrui has no text-ghost appearance and no danger appearance at all,
   * so both render through the local <button> and take their metrics from this
   * module — see the ownership note at the top of Button.module.css.
   */
  if (variant === "danger" || variant === "ghost") {
    return (
      <button className={classes} disabled={disabled || loading} type={type} onClick={onClick} {...rest}>
        {leading}
        {children}
      </button>
    );
  }

  return (
    <Vscrui
      appearance={variant === "primary" ? "primary" : "secondary"}
      className={classes}
      disabled={disabled || loading}
      type={type}
      onClick={onClick}
      {...rest}
    >
      {leading}
      {children}
    </Vscrui>
  );
}
