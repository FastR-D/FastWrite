import { useFileDropTarget } from "../../lib/uploads/use-file-drop-target";
import { Icon } from "vscrui";
import { IconButton } from "../ui";
export type SidebarView = "files" | "git" | "evidence" | "outline" | "reference-style" | "skills";
const views = [{ id: "files", label: "Files", icon: "files" }, { id: "git", label: "Git", icon: "source-control" }, { id: "evidence", label: "Evidence", icon: "book" }, { id: "outline", label: "Outline", icon: "list-tree" }, { id: "reference-style", label: "Reference style", icon: "book" }] as const;

export function ActivityBar({ active, expanded, onSelect, onSettings, evidenceCount, onDropFiles }: { active: SidebarView; expanded: boolean; onSelect: (view: SidebarView) => void; onSettings: () => void; evidenceCount: number; onDropFiles?: (transfer: DataTransfer) => void }) {
  const drop = useFileDropTarget(onDropFiles);
  return <nav className="activity-bar" aria-label="Workspace views">
    {views.map(({ id, label, icon }) => <IconButton key={id} {...(id === "files" ? drop.props("") : {})} title={id === "files" && drop.activeTarget !== null ? "Drop files into project root" : label} label={label} icon={<><Icon name={icon} size={20} />{id === "evidence" && evidenceCount > 0 ? <span className="activity-badge">{evidenceCount}</span> : null}</>} aria-pressed={active === id && expanded} aria-controls={`sidebar-${id}`} onClick={() => onSelect(id)} />)}
    {drop.activeTarget !== null ? <span className="activity-drop-hint" role="status">Drop files into project root</span> : null}
    <IconButton className="activity-settings" label="Workspace settings" title="Settings" icon={<Icon name="settings-gear" size={20} />} onClick={onSettings} />
  </nav>;
}
