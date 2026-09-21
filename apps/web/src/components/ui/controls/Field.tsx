import { createContext, useContext, useId, type ReactNode } from "react";
import styles from "./Field.module.css";

/**
 * The wiring Field computed for its control. Controls read this as a default,
 * so a call site that forgets to forward `id`/`describedBy`/`invalid` still gets
 * them.
 *
 * This exists because the render-prop API makes the wiring opt-in at ~80 call
 * sites, and a forgotten `id` produces a label pointing at nothing plus a
 * control with no accessible name — silently. Typecheck cannot see it and the
 * page looks correct. Defaulting from context makes the wrong thing impossible
 * rather than merely detectable.
 *
 * `null` means "no Field above me", which is different from a Field that
 * computed no description: that case carries an object with `describedBy:
 * undefined`.
 */
export const FieldContext = createContext<FieldRenderProps | null>(null);

/** Wiring for a control, falling back to the enclosing Field. */
export function useFieldWiring(): FieldRenderProps | null {
  return useContext(FieldContext);
}

export interface FieldRenderProps {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
}

export interface FieldProps {
  /** Visible label text. */
  label: ReactNode;
  /**
   * Either a plain node, or a render prop receiving the wiring Field computed
   * for the control. A function is not a ReactNode, so the union is explicit.
   */
  children: ReactNode | ((props: FieldRenderProps) => ReactNode);
  /** Helper text under the control, referenced by aria-describedby. */
  hint?: ReactNode;
  /** Error text. Its presence also marks the control invalid. */
  error?: ReactNode;
  /** Render "(optional)" next to the label. */
  optional?: boolean;
  /** Tighter vertical rhythm, for template info blocks. */
  compact?: boolean;
  className?: string;
}

/**
 * Field owns the label/control/description relationship so callers cannot wire
 * it up incorrectly.
 *
 * It clones no children and injects no props. Instead it renders the label and
 * description elements with stable ids and publishes them on FieldContext, so
 * the control underneath picks them up without the call site forwarding
 * anything:
 *
 *   <Field label="Project name">
 *     <TextField value={name} onChange={setName} />
 *   </Field>
 *
 * An explicit prop still wins over the context, so the render-prop form keeps
 * working unchanged:
 *
 *   <Field label="Project name">
 *     {({ id, describedBy, invalid }) => (
 *       <TextField id={id} aria-describedby={describedBy} invalid={invalid} ... />
 *     )}
 *   </Field>
 *
 * Controls that render more than one labelable element (MultiSelect) consume
 * the wiring themselves and null the context for their children.
 *
 * The label element wraps the label text ONLY, never the control. Wrapping the
 * control would (a) leave a dangling `for` on the plain-children path, where
 * nothing ever claims the id, (b) put several labelable descendants inside one
 * label for MultiSelect, which is invalid, and (c) make the label forward a
 * synthetic click to its labelled control — clicking inside a Select's popover
 * would toggle the trigger. Keeping the hint and error outside the label also
 * stops them leaking into the control's accessible name.
 */
export function Field({ label, children, hint, error, optional = false, compact = false, className = "" }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = error ? errorId : hint ? hintId : undefined;

  const content = typeof children === "function"
    ? (children as (props: FieldRenderProps) => ReactNode)({ id, describedBy, invalid: Boolean(error) })
    : children;

  return (
    <FieldContext.Provider value={{ id, describedBy, invalid: Boolean(error) }}>
      <div className={`${styles.field} ${compact ? styles.compact : ""} ${className}`.trim()}>
        <label className={styles.label} htmlFor={id}>
          {label}
          {optional ? <span className={styles.optional}>(optional)</span> : null}
        </label>
        {content}
        {error ? <small className={styles.error} id={errorId}>{error}</small>
          : hint ? <small className={styles.hint} id={hintId}>{hint}</small>
          : null}
      </div>
    </FieldContext.Provider>
  );
}
