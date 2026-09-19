import { Spinner } from "../feedback/Spinner";
import styles from "./Loader.module.css";

export interface LoaderProps {
  /** Show a full-viewport blocking overlay. Set false for an inline indicator. */
  overlay?: boolean;
  message?: string;
}

export function Loader({ overlay = true, message }: LoaderProps) {
  if (!overlay) return <Spinner label={message} />;
  return (
    <div className={styles.overlay} role="status" aria-live="polite">
      <div className={styles.message}>
        <Spinner size={16} /> {message ?? "Loading…"}
      </div>
    </div>
  );
}
