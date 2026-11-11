import type { ReactNode } from "react";
import { Icon, icons } from "../../ui";
import styles from "./AiWorkspace.module.css";

export function AiRunActivity({ title, detail, children, stopped = false }: { title: string; detail?: string; children?: ReactNode; stopped?: boolean }) {
  return <div className={styles.activity} role="status" aria-live="polite">
    <span className={styles.activityIcon}><Icon name={stopped ? icons.info : icons.loading} spin={!stopped} /></span>
    <div className={styles.activityBody}>
      <strong>{title}</strong>
      {detail ? <p>{detail}</p> : null}
      {children}
    </div>
  </div>;
}
