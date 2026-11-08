import { userFacingError } from "../../lib/notifications";
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { taskSkillLabel } from "../../lib/useTaskSkills";
import { Button, Icon, icons } from "../ui";
import styles from "./SkillPanel.module.css";

export function SkillDetailPanel({ id }: { id: string }) {
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof api.agentSkills.detail>> | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setDetail(null); setError(""); setLoading(true);
    void api.agentSkills.detail(id, controller.signal).then(setDetail).catch(failure => { if (!controller.signal.aborted) setError(userFacingError(failure, "无法读取 Skill")); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, revision]);
  return <article className={styles.document}>
    <header><Icon name={icons.book} /><h2>{taskSkillLabel(id)}</h2>{detail ? <span>v{detail.descriptor.version} · 只读</span> : null}</header>
    {error ? <div role="alert"><p>{error}</p><Button onClick={() => setRevision(value => value + 1)}>重试</Button></div> : !detail ? loading ? <p role="status">正在加载 Skill 内容…</p> : <Button onClick={() => setRevision(value => value + 1)}>重新加载 Skill</Button> : <><p>{detail.descriptor.description}</p><pre tabIndex={0} aria-label="Skill 具体内容">{detail.instructions}</pre></>}
  </article>;
}
