import { useId } from "react";
import type { Ref } from "react";
import { useFieldWiring } from "./Field";
import styles from "./FileField.module.css";

export interface FileFieldProps {
  /** Receives the chosen files. */
  onSelect: (files: File[]) => void;
  /** Allow choosing more than one file. */
  multiple?: boolean;
  /** Select a directory rather than files (Chrome/Safari). */
  directory?: boolean;
  /** Restrict by extension or MIME type, e.g. ".tex" or "image/*". */
  accept?: string;
  disabled?: boolean;
  id?: string;
  name?: string;
  /** Accessible name. Required — file inputs have no visible label of their own. */
  label: string;
  /**
   * Hide the native input. Use when a separate Button opens the picker via the
   * ref; the caller is then responsible for exposing the label to the button.
   */
  hidden?: boolean;
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
  /**
   * Id of the element describing this input, wired up by Field. Must admit
   * undefined: Field passes it through a render prop and there may be no hint
   * or error to point at.
   */
  "aria-describedby"?: string | undefined;
  /** Marks the field invalid, driven by Field's error state. */
  invalid?: boolean;
}

export function FileField({
  onSelect,
  multiple = false,
  directory = false,
  accept,
  disabled = false,
  id,
  label,
  hidden = false,
  className = "",
  inputRef,
  invalid,
  "aria-describedby": describedBy,
  ...rest
}: FileFieldProps) {
  const generated = useId();
  const wiring = useFieldWiring();
  const inputId = id ?? wiring?.id ?? generated;
  const resolvedDescribedBy = describedBy ?? wiring?.describedBy;
  const resolvedInvalid = invalid ?? wiring?.invalid ?? false;

  return (
    <input
      {...rest}
      ref={inputRef}
      id={inputId}
      name={inputId}
      aria-describedby={resolvedDescribedBy}
      type="file"
      className={`${styles.input} ${hidden ? styles.hidden : ""} ${resolvedInvalid ? styles.invalid : ""} ${className}`.trim()}
      aria-label={label}
      aria-invalid={resolvedInvalid || undefined}
      accept={accept}
      disabled={disabled}
      multiple={multiple}
      {...(directory ? { webkitdirectory: "" } : {})}
      onChange={(event) => {
        onSelect(Array.from(event.target.files ?? []));
        // Allow re-selecting the same file.
        event.target.value = "";
      }}
    />
  );
}
