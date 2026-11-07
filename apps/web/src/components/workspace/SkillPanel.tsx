import type { AgentTaskSkillDescriptor } from "@fastwrite/shared";
import { Button, Checkbox, Icon, IconButton, icons } from "../ui";
import { MAX_TASK_SKILLS, WRITING_STAGE_PRESETS, taskSkillLabel } from "../../lib/useTaskSkills";
import styles from "./SkillPanel.module.css";

interface SkillPanelProps {
  skills: AgentTaskSkillDescriptor[];
  selectedIds: string[];
  loading: boolean;
  error: string;
  hasSection: boolean;
  onChange: (ids: string[]) => void;
  onReload: () => void;
  onUse: () => void;
}

export function SkillPanel({ skills, selectedIds, loading, error, hasSection, onChange, onReload, onUse }: SkillPanelProps) {
  const needsSection = skills.some(skill => selectedIds.includes(skill.id) && skill.allowedScope === "section");
  return <>
    <header className="panel-heading panel-heading--plain">
      <span>内置 Skill</span>
      <IconButton label="刷新 Skill" icon={<Icon name={icons.refresh} />} disabled={loading} onClick={onReload} />
    </header>
    <div className={styles.content} role="region" aria-label="Skill 列表" tabIndex={0}>
      <p className={styles.hint}>勾选用于接下来智能助手任务的 Skill，最多 {MAX_TASK_SKILLS} 个。</p>
      {!loading && !error && skills.length ? <div className={styles.stages} role="group" aria-label="按写作阶段选择 Skill">
        <p className={styles.hint}>按写作阶段替换当前选择：</p>
        <div className={styles.stageButtons}>{WRITING_STAGE_PRESETS.filter(preset => preset.ids.every(id => skills.some(skill => skill.id === id))).map(preset => <Button key={preset.label} size="small" variant="secondary" aria-pressed={preset.ids.length === selectedIds.length && preset.ids.every(id => selectedIds.includes(id))} onClick={() => onChange([...preset.ids])}>{preset.label}</Button>)}</div>
      </div> : null}
      {loading ? <p role="status">正在加载 Skill…</p> : error ? <div role="alert"><p>{error}</p><Button size="small" onClick={onReload}>重试</Button></div> : skills.length ? <div className={styles.list} role="group" aria-label="内置 Skill">
        {skills.map(skill => {
          const checked = selectedIds.includes(skill.id);
          return <div className={styles.item} key={skill.id}>
            <Checkbox checked={checked} disabled={!checked && selectedIds.length >= MAX_TASK_SKILLS} onChange={enabled => onChange(enabled ? [...selectedIds, skill.id] : selectedIds.filter(id => id !== skill.id))}>
              <span className={styles.details}>
                <strong title={skill.id}>{taskSkillLabel(skill.id)}</strong>
                <span>{skill.description}</span>
                <small>{skill.allowedScope === "section" ? "当前章节" : skill.allowedScope === "file" ? "当前文件" : "整篇论文"} · v{skill.version}</small>
              </span>
            </Checkbox>
          </div>;
        })}
      </div> : <p className={styles.hint}>暂无可用的内置 Skill。</p>}
      {selectedIds.length ? <div className={styles.actions}>
        <span>已选择 {selectedIds.length} 个 Skill</span>
        {needsSection && !hasSection ? <p className={styles.hint}>请先在编辑器中定位一个章节，再使用章节 Skill。</p> : null}
        <Button variant="primary" disabled={loading || Boolean(error) || (needsSection && !hasSection)} onClick={onUse}>用于智能助手</Button>
        <Button variant="ghost" onClick={() => onChange([])}>清空选择</Button>
      </div> : null}
    </div>
  </>;
}
