import type { ReactNode } from "react";
import { icons } from "../icons";
import { Icon } from "../primitives/Icon";
import styles from "./Alert.module.css";

export type AlertTone = "error" | "warning" | "info" | "success";

export interface AlertProps {
  children: ReactNode;
  tone?: AlertTone;
  /** Bold first line, when the message needs a headline. */
  title?: string;
  /** Buttons or links rendered under the message. */
  actions?: ReactNode;
  /** Override the derived ARIA role. */
  role?: "alert" | "status" | "none";
  className?: string;
}

const TONE_ICON = {
  error: icons.error,
  warning: icons.warning,
  info: icons.info,
  success: icons.check
} as const;

export function Alert({ children, tone = "info", title, actions, role, className = "" }: AlertProps) {
  const resolvedRole = role ?? (tone === "error" || tone === "warning" ? "alert" : "status");
  return (
    <div className={`${styles.alert} ${styles[tone]} ${className}`.trim()} role={resolvedRole === "none" ? undefined : resolvedRole}>
      <span className={styles.icon} aria-hidden="true"><Icon name={TONE_ICON[tone]} size={14} /></span>
      <div className={styles.body}>
        {title ? <span className={styles.title}>{title}</span> : null}
        <span>{children}</span>
        {actions ? <div className={styles.actions}>{actions}</div> : null}
      </div>
    </div>
  );
}
