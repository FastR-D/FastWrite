import { Icon } from "vscrui";
export type SidebarView = "files" | "git" | "evidence" | "outline";
const views = [{ id: "files", label: "Files", icon: "files" }, { id: "git", label: "Git", icon: "source-control" }, { id: "evidence", label: "Evidence", icon: "book" }, { id: "outline", label: "Outline", icon: "list-tree" }] as const;

export function ActivityBar({ active, expanded, onSelect, onSettings, evidenceCount }: { active: SidebarView; expanded: boolean; onSelect: (view: SidebarView) => void; onSettings: () => void; evidenceCount: number }) {
  return <nav className="activity-bar" aria-label="Workspace views">
    {views.map(({ id, label, icon }) => <button key={id} type="button" title={label} aria-label={label} aria-pressed={active === id && expanded} aria-controls={`sidebar-${id}`} onClick={() => onSelect(id)}><Icon name={icon} size={20} aria-hidden="true" />{id === "evidence" && evidenceCount > 0 ? <span className="activity-badge">{evidenceCount}</span> : null}</button>)}
    <button className="activity-settings" type="button" title="Settings" aria-label="Workspace settings" onClick={onSettings}><Icon name="settings-gear" size={20} aria-hidden="true" /></button>
  </nav>;
}
