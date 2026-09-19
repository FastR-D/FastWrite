import type { CSSProperties, FocusEvent, FormEvent, KeyboardEvent } from "react";
import { useFieldWiring } from "../controls/Field";
import styles from "./TextField.module.css";

export interface TextFieldProps {
  /** Current value. */
  value?: string | undefined;
  /** Initial value when uncontrolled. */
  defaultValue?: string;
  /** Receives the new value, matching vscrui's signature. */
  onChange?: (value: string) => void;
  /** Called on every keystroke too, for callers that need the raw event. */
  onInput?: (event: FormEvent<HTMLInputElement>) => void;
  onBlur?: (event: FocusEvent<HTMLInputElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  readonly?: boolean;
  required?: boolean;
  /** Hints the on-screen keyboard on touch devices (e.g. "numeric"). */
  inputMode?: "none" | "text" | "numeric" | "decimal" | "tel" | "email" | "url" | "search";
  type?: "text" | "email" | "password" | "url" | "search" | "datetime-local" | "tel";
  id?: string;
  name?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  spellCheck?: boolean;
  maxLength?: number;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  /** Set when a parent Field renders the error text; drives aria-invalid. */
  invalid?: boolean;
  /** Id of the element describing this input, wired up by Field. */
  /**
   * Inline style. Forwarded to the element because some call sites size a
   * control to its context (a JSON editor, a coordinate field) and there is no
   * prop for every dimension.
   */
  style?: CSSProperties;
  "aria-describedby"?: string | undefined;
  "aria-label"?: string;
  className?: string;
  "data-save-command"?: string;
  /**
   * Id of a `<datalist>` to offer suggestions from. A plain HTML attribute, so
   * it passes straight through — the bibliography path field needs it and has no
   * other way to keep its completions.
   */
  list?: string;
}

export function TextField({
  value,
  defaultValue,
  onChange,
  onInput,
  className = "",
  invalid,
  id,
  "aria-describedby": describedBy,
  type = "text",
  ...rest
}: TextFieldProps) {
  const wiring = useFieldWiring();
  const resolvedId = id ?? wiring?.id;
  const resolvedDescribedBy = describedBy ?? wiring?.describedBy;
  const resolvedInvalid = invalid ?? wiring?.invalid ?? false;
  return (
    <input
      {...rest}
      id={resolvedId}
      aria-describedby={resolvedDescribedBy}
      type={type}
      className={`${styles.input} ${resolvedInvalid ? styles.invalid : ""} ${className}`.trim()}
      value={value}
      defaultValue={defaultValue}
      aria-invalid={resolvedInvalid || undefined}
      onChange={(event) => {
        onChange?.(event.target.value);
        onInput?.(event);
      }}
    />
  );
}
