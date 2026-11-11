import { useFileDropTarget } from "../../lib/uploads/use-file-drop-target";
import { Icon, IconButton, icons } from "../ui";
export type SidebarView = "files" | "git" | "evidence" | "outline" | "reference-style" | "skills" | "collaboration";
const views = [{ id: "files", label: "文件", icon: icons.files }, { id: "git", label: "Git", icon: icons.sourceControl }, { id: "evidence", label: "证据", icon: icons.book }, { id: "outline", label: "大纲", icon: icons.listTree }, { id: "reference-style", label: "参考论文", icon: icons.book }, { id: "skills", label: "Skill", icon: icons.extensions }, { id: "collaboration", label: "协作", icon: icons.commentDiscussion }] as const;

export function ActivityBar({ active, expanded, onSelect, onSettings, evidenceCount, onDropFiles }: { active: SidebarView; expanded: boolean; onSelect: (view: SidebarView) => void; onSettings: () => void; evidenceCount: number; onDropFiles?: (transfer: DataTransfer) => void }) {
  const drop = useFileDropTarget(onDropFiles);
  return <nav className="activity-bar" aria-label="工作区视图">
    {views.map(({ id, label, icon }) => <IconButton key={id} {...(id === "files" ? drop.props("") : {})} title={id === "files" && drop.activeTarget !== null ? "将文件拖放到项目根目录" : label} label={label} icon={<><Icon name={icon} size={20} />{id === "evidence" && evidenceCount > 0 ? <span className="activity-badge">{evidenceCount}</span> : null}</>} aria-pressed={active === id && expanded} aria-controls={`sidebar-${id}`} onClick={() => onSelect(id)} />)}
    {drop.activeTarget !== null ? <span className="activity-drop-hint" role="status">将文件拖放到项目根目录</span> : null}
    <IconButton className="activity-settings" label="工作区设置" title="设置" icon={<Icon name={icons.settingsGear} size={20} />} onClick={onSettings} />
  </nav>;
}
