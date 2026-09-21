import type { ReactNode } from "react";
import styles from "./Disclosure.module.css";

export interface DisclosureProps {
  /** Always-visible summary line. */
  summary: ReactNode;
  children: ReactNode;
  /** Start expanded. */
  defaultOpen?: boolean;
  className?: string;
}

/**
 * A collapsible section built on the native <details>/<summary> pair, so the
 * open/closed state, keyboard activation and screen-reader announcement come
 * from the platform. The chevron is decoration; the summary's own text is the
 * accessible name.
 */
export function Disclosure({ summary, children, defaultOpen = false, className = "" }: DisclosureProps) {
  return (
    <details className={`${styles.disclosure} ${className}`.trim()} open={defaultOpen || undefined}>
      <summary className={styles.summary}>
        <span className={styles.chevron} aria-hidden="true">▶</span>
        {summary}
      </summary>
      <div className={styles.body}>{children}</div>
    </details>
  );
}
