import type { ReactNode } from "react";
import styles from "./SegmentedControl.module.css";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
  title?: string;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the group. Required. */
  label: string;
  bordered?: boolean;
  className?: string;
}

/**
 * A group of mutually-exclusive toggle buttons.
 *
 * Deliberately NOT a radio group: the call sites expose these as buttons with
 * aria-pressed, and the e2e suite addresses them by button role and name.
 * Switching to role="radio" would break those assertions for no accessibility
 * gain — a pressed toggle and a selected radio are both announced as selected.
 */
export function SegmentedControl<T extends string>({ options, value, onChange, label, bordered = false, className = "" }: SegmentedControlProps<T>) {
  return (
    <div className={`${styles.group} ${bordered ? styles.bordered : ""} ${className}`.trim()} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`${styles.item} ${option.value === value ? styles.selected : ""}`.trim()}
          aria-pressed={option.value === value}
          disabled={option.disabled}
          title={option.title}
          onClick={() => onChange(option.value)}
        >
          {option.icon ? <span className={styles.icon} aria-hidden="true">{option.icon}</span> : null}
          {option.label}
        </button>
      ))}
    </div>
  );
}
