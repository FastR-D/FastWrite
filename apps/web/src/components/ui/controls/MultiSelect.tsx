import styles from "./MultiSelect.module.css";
import { FieldContext, useFieldWiring } from "./Field";
import { Checkbox } from "../primitives/Checkbox";

export interface MultiSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface MultiSelectProps {
  options: MultiSelectOption[];
  value: string[];
  onChange: (value: string[]) => void;
  /** Accessible name for the group. */
  label: string;
  emptyMessage?: string;
  /**
   * Marks the group invalid. The group is the thing a Field labels, so the
   * error is announced once for the group rather than on every checkbox — the
   * controls themselves carry no error of their own.
   */
  invalid?: boolean;
  /** Id of the element describing this group, wired up by Field. */
  "aria-describedby"?: string | undefined;
  className?: string;
}

export function MultiSelect({ options, value, onChange, label, emptyMessage = "Nothing available", invalid, className = "", "aria-describedby": describedBy }: MultiSelectProps) {
  const wiring = useFieldWiring();
  const resolvedDescribedBy = describedBy ?? wiring?.describedBy;
  const resolvedInvalid = invalid ?? wiring?.invalid ?? false;

  const toggle = (option: string, checked: boolean) => {
    onChange(checked ? [...value, option] : value.filter((entry) => entry !== option));
  };

  return (
    /*
     * Nulls the context for the children: the group owns the wiring, and each
     * checkbox inheriting it would put N copies of the same id in the DOM.
     */
    <FieldContext.Provider value={null}>
      <div
        className={`${styles.wrapper} ${resolvedInvalid ? styles.invalid : ""} ${className}`.trim()}
        role="group"
        aria-label={label}
        aria-describedby={resolvedDescribedBy}
        aria-invalid={resolvedInvalid || undefined}
      >
        {options.map((option) => (
          <Checkbox
            key={option.value}
            checked={value.includes(option.value)}
            // `?? false`: CheckboxProps.disabled is a bare `boolean`, and
            // exactOptionalPropertyTypes rejects an explicit undefined.
            disabled={option.disabled ?? false}
            onChange={(checked) => toggle(option.value, checked)}
          >
            {option.label}
          </Checkbox>
        ))}
        {!options.length ? <div className={styles.empty}>{emptyMessage}</div> : null}
      </div>
    </FieldContext.Provider>
  );
}
