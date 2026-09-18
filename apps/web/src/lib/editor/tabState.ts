export interface SourceTab { path: string; pinned: boolean; }
export function openSourceTab(tabs: SourceTab[], path: string, pinned = false): SourceTab[] {
  const existing = tabs.find(tab => tab.path === path);
  if (existing) return pinned && !existing.pinned ? tabs.map(tab => tab.path === path ? { ...tab, pinned: true } : tab) : tabs;
  const preview = tabs.findIndex(tab => !tab.pinned);
  const next = { path, pinned };
  return preview < 0 || pinned ? [...tabs, next] : tabs.map((tab, index) => index === preview ? next : tab);
}
export function pinSourceTab(tabs: SourceTab[], path: string): SourceTab[] {
  if (!tabs.some(tab => tab.path === path && !tab.pinned)) return tabs;
  return tabs.map(tab => tab.path === path && !tab.pinned ? { ...tab, pinned: true } : tab);
}
