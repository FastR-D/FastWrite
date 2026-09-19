import { useFieldWiring } from "./Field";
import type { CSSProperties } from "react";
import styles from "./NumberField.module.css";

export interface NumberFieldProps {
  value?: number | undefined;
  defaultValue?: number;
  /** Receives the parsed number, or undefined while the input is empty. */
  onChange?: (value: number | undefined) => void;
  /** Fired when the user leaves the field — matches the existing onBlur commit pattern. */
  onCommit?: (value: number | undefined) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  name?: string;
  compact?: boolean;
  invalid?: boolean;
  /* Field hands these through a render prop, so they must admit undefined
     under exactOptionalPropertyTypes. */
  /**
   * Inline style. Forwarded to the element because some call sites size a
   * control to its context (a JSON editor, a coordinate field) and there is no
   * prop for every dimension.
   */
  style?: CSSProperties;
  "aria-describedby"?: string | undefined;
  "aria-label"?: string;
  className?: string;
}

function parse(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function NumberField({
  value,
  defaultValue,
  onChange,
  onCommit,
  compact = false,
  invalid,
  id,
  "aria-describedby": describedBy,
  className = "",
  ...rest
}: NumberFieldProps) {
  const wiring = useFieldWiring();
  const resolvedId = id ?? wiring?.id;
  const resolvedDescribedBy = describedBy ?? wiring?.describedBy;
  const resolvedInvalid = invalid ?? wiring?.invalid ?? false;
  return (
    <input
      {...rest}
      id={resolvedId}
      aria-describedby={resolvedDescribedBy}
      type="number"
      className={`${styles.input} ${compact ? styles.compact : ""} ${resolvedInvalid ? styles.invalid : ""} ${className}`.trim()}
      value={value}
      defaultValue={defaultValue}
      aria-invalid={resolvedInvalid || undefined}
      onChange={(event) => onChange?.(parse(event.target.value))}
      onBlur={(event) => onCommit?.(parse(event.target.value))}
    />
  );
}
