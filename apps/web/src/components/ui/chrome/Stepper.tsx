import type { ReactNode } from "react";
import styles from "./Stepper.module.css";

/*
 * One component covers three timelines that share only their shape.
 *
 * The call sites disagree on status vocabulary, on whether a step has a detail
 * line, on whether an unfinished step shows its number, and on layout — so the
 * caller translates its own status words into the four below and `variant`
 * picks the track. No e2e assertion touches these visuals, which is what made
 * a single component viable in place of four.
 */

export type StepStatus = "complete" | "current" | "error" | "pending";

export interface Step {
  id: string;
  label: string;
  status: StepStatus;
  /**
   * The glyph in the marker. The caller supplies it: `Stepper` does not know
   * the icon vocabulary. A step without one falls back to its number when the
   * list is `numbered`.
   */
  icon?: ReactNode;
  /** Secondary line under the label. */
  detail?: ReactNode;
  /** Right-hand value — a count in the evidence chain, for example. */
  value?: ReactNode;
}

export interface StepperProps {
  steps: Step[];
  /** Accessible name for the list. */
  label?: string;
  /**
   * `list`  — vertical cards, one per step (AgentTaskDialog).
   * `grid`  — equal-width columns, wrapping (ReviewDialog, DraftDialog).
   * `chain` — inline icon + label + value, for a legend of counts (ResearchDialog).
   */
  variant?: "list" | "grid" | "chain";
  /** Show the step number for a pending step that has no icon. */
  numbered?: boolean;
  /** Draw connector lines between grid steps (DraftDialog). */
  connectors?: boolean;
  className?: string;
}

export function Stepper({ steps, label, variant = "list", numbered = false, connectors = false, className = "" }: StepperProps) {
  const classes = [styles[variant], numbered ? styles.numbered : "", connectors ? styles.connectors : "", className].filter(Boolean).join(" ");

  return (
    <ol className={classes} aria-label={label}>
      {steps.map((step, index) => (
        <li
          key={step.id}
          className={`${styles.row} ${styles[step.status]}`}
          aria-current={step.status === "current" ? "step" : undefined}
        >
          <span className={styles.marker}>{step.icon ?? (numbered ? index + 1 : null)}</span>
          {variant === "chain"
            ? <span className={styles.label}>{step.label}</span>
            : <strong className={styles.label}>{step.label}</strong>}
          {step.detail == null ? null : <small className={styles.detail}>{step.detail}</small>}
          {step.value == null ? null : <strong className={styles.value}>{step.value}</strong>}
        </li>
      ))}
    </ol>
  );
}
