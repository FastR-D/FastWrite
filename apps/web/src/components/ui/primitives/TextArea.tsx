import { useEffect, useRef } from "react";
import type { CSSProperties, FocusEvent, FormEvent, KeyboardEvent, Ref } from "react";
import { useFieldWiring } from "../controls/Field";
import styles from "./TextArea.module.css";

export interface TextAreaProps {
  value?: string | undefined;
  defaultValue?: string;
  onChange?: (value: string) => void;
  onInput?: (event: FormEvent<HTMLTextAreaElement>) => void;
  onBlur?: (event: FocusEvent<HTMLTextAreaElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  readonly?: boolean;
  /** Marks the field required for native form validation. */
  required?: boolean;
  rows?: number;
  maxLength?: number;
  spellCheck?: boolean;
  autoFocus?: boolean;
  id?: string;
  name?: string;
  resize?: "none" | "both" | "horizontal" | "vertical";
  /** Grow height to fit content instead of scrolling. */
  growWithContent?: boolean;
  /** Fill the available height rather than sizing to content. */
  fill?: boolean;
  invalid?: boolean;
  /**
   * Inline style. Forwarded to the element because some call sites size a
   * control to its context (a JSON editor, a coordinate field) and there is no
   * prop for every dimension.
   */
  style?: CSSProperties;
  "aria-describedby"?: string | undefined;
  "aria-label"?: string;
  className?: string;
  /**
   * Handle on the underlying element. React 19 passes `ref` as a normal prop to
   * function components, so declaring it here is all that is needed. Call sites
   * migrated from a raw element used it to move focus — the AI workspace focuses
   * the composer after a decision, for instance.
   */
  ref?: Ref<HTMLTextAreaElement>;
}

export function TextArea({
  value,
  defaultValue,
  onChange,
  onInput,
  resize = "vertical",
  growWithContent = false,
  fill = false,
  invalid,
  id,
  "aria-describedby": describedBy,
  className = "",
  ref: forwardedRef,
  ...rest
}: TextAreaProps) {
  const elementRef = useRef<HTMLTextAreaElement>(null);
  const wiring = useFieldWiring();
  const resolvedId = id ?? wiring?.id;
  const resolvedDescribedBy = describedBy ?? wiring?.describedBy;
  const resolvedInvalid = invalid ?? wiring?.invalid ?? false;

  useEffect(() => {
    if (!growWithContent || !elementRef.current) return;
    const element = elementRef.current;
    element.style.height = "0px";
    element.style.height = `${element.scrollHeight + 2}px`;
  }, [growWithContent, value]);

  const classes = [
    styles.textarea,
    styles[resize],
    fill ? styles.fill : "",
    resolvedInvalid ? styles.invalid : "",
    className
  ].filter(Boolean).join(" ");

  /* Mirrored rather than replaced: the grow-with-content effect needs the same
     element the caller does. */
  const attach = (element: HTMLTextAreaElement | null) => {
    elementRef.current = element;
    if (typeof forwardedRef === "function") forwardedRef(element);
    else if (forwardedRef) forwardedRef.current = element;
  };

  return (
    <textarea
      {...rest}
      ref={attach}
      id={resolvedId}
      aria-describedby={resolvedDescribedBy}
      className={classes}
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
