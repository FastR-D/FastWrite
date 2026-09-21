import styles from "./Spinner.module.css";

export interface SpinnerProps {
  /** Diameter in pixels. */
  size?: number;
  /** Accessible label. Omit only if an adjacent status text conveys the same thing. */
  label?: string | undefined;
  className?: string;
}

export function Spinner({ size = 14, label, className = "" }: SpinnerProps) {
  return (
    <span
      className={`${styles.spinner} ${className}`.trim()}
      style={{ width: size, height: size, borderWidth: Math.max(2, Math.round(size / 7)) }}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : "true"}
    />
  );
}
