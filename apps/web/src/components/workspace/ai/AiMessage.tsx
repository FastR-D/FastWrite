import type { ReactNode } from "react";
import { Icon, icons } from "../../ui";
import styles from "./AiWorkspace.module.css";

export interface AiChatMessage { id: string; role: "user" | "assistant"; content: string; rationale?: string }
export type AiPanelState = "idle" | "running" | "applying" | "accepted" | "error" | "stopped";

export function AiMessage({ message, assistantName, children }: { message: AiChatMessage; assistantName: string; children?: ReactNode }) {
  const assistant = message.role === "assistant";
  return <article className={`revise-message revise-message--${message.role} ${styles.message} ${assistant ? styles.assistant : styles.user}`}>
    <header className={styles.messageHeading}>
      {assistant ? <span className={styles.assistantIcon}><Icon name={icons.sparkle} size={14} /></span> : null}
      <span>{assistant ? assistantName : "你"}</span>
    </header>
    {children ?? <p className={styles.messageText}>{message.content}</p>}
  </article>;
}
