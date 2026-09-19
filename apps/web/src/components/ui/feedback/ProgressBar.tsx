import styles from "./ProgressBar.module.css";

export interface ProgressBarProps {
  /** Completion percentage, 0-100. Omit for indeterminate work. */
  value?: number;
  /** Accessible name. Required: a progress bar with no name is not announced usefully. */
  label: string;
  /** Secondary detail, e.g. "34.4 MB / 50.6 MB · core.data.gz". */
  detail?: string;
  className?: string;
}

export function ProgressBar({ value, label, detail, className = "" }: ProgressBarProps) {
  const indeterminate = value === undefined;
  const clamped = indeterminate ? 0 : Math.min(100, Math.max(0, value));

  return (
    <div className={`${styles.wrapper} ${indeterminate ? styles.indeterminate : ""} ${className}`.trim()}>
      <div className={styles.header}>
        <span className={styles.label}>{label}</span>
        {detail ? <span className={styles.detail}>{detail}</span> : null}
      </div>
      <div
        className={styles.track}
        role="progressbar"
        aria-label={label}
        aria-valuemin={indeterminate ? undefined : 0}
        aria-valuemax={indeterminate ? undefined : 100}
        aria-valuenow={indeterminate ? undefined : clamped}
      >
        <div className={styles.fill} style={indeterminate ? undefined : { width: `${clamped}%` }} />
      </div>
    </div>
  );
}
