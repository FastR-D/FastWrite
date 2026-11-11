import type { ReactNode } from "react";
import { useFieldWiring } from "../controls/Field";
import styles from "./Checkbox.module.css";

export interface CheckboxProps {
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  name?: string;
  /** Visible text. Omit only when aria-label supplies the accessible name. */
  children?: ReactNode;
  /** Render as a compact icon-and-text pill instead of a bare checkbox. */
  variant?: "default" | "pill";
  icon?: ReactNode;
  /**
   * Marks the control invalid. A checkbox has no error text of its own, so this
   * pairs with aria-describedby pointing at the Field error.
   */
  invalid?: boolean;
  /** Id of the element describing this control, wired up by Field. */
  "aria-describedby"?: string | undefined;
  "aria-label"?: string;
  title?: string;
  className?: string;
}

export function Checkbox({
  checked,
  defaultChecked,
  onChange,
  disabled = false,
  variant = "default",
  icon,
  children,
  invalid,
  id,
  "aria-describedby": describedBy,
  className = "",
  ...rest
}: CheckboxProps) {
  const wiring = useFieldWiring();
  const resolvedId = id ?? wiring?.id;
  const resolvedDescribedBy = describedBy ?? wiring?.describedBy;
  const resolvedInvalid = invalid ?? wiring?.invalid ?? false;

  const pill = variant === "pill";
  const classes = [
    styles.label,
    pill ? styles.pill : "",
    pill && checked ? styles.on : "",
    disabled ? styles.disabled : "",
    className
  ].filter(Boolean).join(" ");

  return (
    <label className={classes}>
      <input
        {...rest}
        id={resolvedId}
        aria-describedby={resolvedDescribedBy}
        type="checkbox"
        className={styles.input}
        checked={checked}
        defaultChecked={defaultChecked}
        disabled={disabled}
        aria-invalid={resolvedInvalid || undefined}
        onChange={(event) => onChange?.(event.target.checked)}
      />
      {!pill ? <span className={`${styles.box} ${resolvedInvalid ? styles.invalid : ""}`} aria-hidden="true">
        <svg className={styles.check} width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8.5 6.25 11.5 13 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span> : null}
      {pill ? <span className={styles.pillLabel}>{icon}{children}</span> : children}
    </label>
  );
}
