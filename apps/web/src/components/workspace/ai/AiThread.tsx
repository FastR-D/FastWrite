import { useMemo, type ReactNode } from "react";
import { Alert, Button, Icon, icons } from "../../ui";
import { AiMessage, type AiChatMessage, type AiPanelState } from "./AiMessage";
import { AiRunActivity } from "./AiRunActivity";
import { useThreadFollow } from "./useThreadFollow";
import styles from "./AiWorkspace.module.css";

export function AiThread({ conversationKey, active, messages, assistantName, state, error, empty, proposal, proposalVersion }: {
  conversationKey: string;
  active: boolean;
  messages: AiChatMessage[];
  assistantName: string;
  state: AiPanelState;
  error: string;
  empty?: ReactNode;
  proposal?: ReactNode;
  proposalVersion: string;
}) {
  const update = useMemo(() => ({ messages, state, proposalVersion, error }), [messages, state, proposalVersion, error]);
  const follow = useThreadFollow(conversationKey, update, active);
  const compactEmpty = !messages.length && !error && state !== "running" && state !== "stopped";
  const lastAssistant = messages.reduce((last, message, index) => message.role === "assistant" ? index : last, -1);
  return <div className={`${styles.thread} ${compactEmpty ? styles.emptyThread : ""}`}>
    <div ref={follow.viewportRef} className={`revise-chat__messages ${styles.messages}`} onScroll={follow.onScroll} role="log" aria-label="修改对话" aria-live="polite" aria-relevant="additions">
      <div ref={follow.contentRef} className={styles.messageContent}>
        {messages.map((message, index) => <AiMessage key={message.id} message={message} assistantName={assistantName}>
          {index === lastAssistant ? proposal : undefined}
        </AiMessage>)}
        {state === "running" ? <AiRunActivity title="正在优化当前候选内容…" detail="生成的修改将先显示为候选，接受后才写入文件。" /> : null}
        {state === "stopped" ? <AiRunActivity title="已停止生成" detail="本次请求没有应用修改，可以调整要求后继续。" stopped /> : null}
        {error ? <Alert tone="error">{error}</Alert> : null}
        {empty}
      </div>
    </div>
    {follow.away ? <div className={styles.latest}><Button size="small" variant="secondary" icon={<Icon name={icons.chevronDown} />} aria-label="回到最新消息" onClick={follow.toLatest}>{follow.unseen ? "有新内容 · 回到最新" : "回到最新"}</Button></div> : null}
  </div>;
}
