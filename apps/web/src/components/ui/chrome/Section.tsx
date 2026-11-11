import { useId, type ReactNode } from "react";
import styles from "./Section.module.css";

export interface SectionProps {
  title: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
  headingLevel?: 2 | 3;
  surface?: boolean;
  hidden?: boolean;
  className?: string;
}

/** Named content group with consistent headings, spacing and optional panel chrome. */
export function Section({ title, description, children, actions, headingLevel = 2, surface = false, hidden, className = "" }: SectionProps) {
  const id = useId();
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section className={`${styles.section} ${surface ? styles.surface : ""} ${className}`.trim()} hidden={hidden} aria-labelledby={id}>
      <header className={styles.header}>
        <div className={styles.titles}>
          <Heading id={id} className={styles.title}>{title}</Heading>
          {description ? <p className={styles.description}>{description}</p> : null}
        </div>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}
