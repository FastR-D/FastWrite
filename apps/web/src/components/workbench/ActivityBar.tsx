import { Icon } from "vscrui";
import { IconButton } from "../ui";
export type SidebarView = "files" | "git" | "evidence" | "outline";
const views = [{ id: "files", label: "Files", icon: "files" }, { id: "git", label: "Git", icon: "source-control" }, { id: "evidence", label: "Evidence", icon: "book" }, { id: "outline", label: "Outline", icon: "list-tree" }] as const;

export function ActivityBar({ active, expanded, onSelect, onSettings, evidenceCount }: { active: SidebarView; expanded: boolean; onSelect: (view: SidebarView) => void; onSettings: () => void; evidenceCount: number }) {
  return <nav className="activity-bar" aria-label="Workspace views">
    {views.map(({ id, label, icon }) => <IconButton key={id} label={label} icon={<><Icon name={icon} size={20} />{id === "evidence" && evidenceCount > 0 ? <span className="activity-badge">{evidenceCount}</span> : null}</>} aria-pressed={active === id && expanded} aria-controls={`sidebar-${id}`} onClick={() => onSelect(id)} />)}
    <IconButton className="activity-settings" label="Workspace settings" title="Settings" icon={<Icon name="settings-gear" size={20} />} onClick={onSettings} />
  </nav>;
}
