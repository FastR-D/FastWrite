import { type ReactNode } from "react";
import type { SourceTab } from "../../lib/editor/tabState";
import type { DiffRequest } from "./SourceControlView";
import { Icon, icons, TabBar, type TabItem } from "../ui";

export const diffRequestKey = (request: DiffRequest) => encodeURIComponent(JSON.stringify([request.baseRef, request.targetRef, request.path, request.oldPath ?? "", request.projectVersion ?? null]));
export interface ComparisonTab { key: string; request: DiffRequest; }

/** A tab plus the gestures the strip drives it with. TabBar only carries presentation. */
interface EditorTabEntry {
  id: string;
  label: ReactNode;
  title: string;
  controls: string;
  icon: ReactNode;
  preview: boolean;
  dirty: boolean;
  active: boolean;
  closeLabel: string;
  select: () => void;
  pin: () => void;
  close: () => void;
}

export function EditorTabs({ tabs, activePath, dirty, onSelect, onPin, onClose, comparisons = [], activeComparison = null, onSelectComparison, onCloseComparison, settings }: { tabs: SourceTab[]; activePath: string | null; dirty: Record<string, boolean>; onSelect: (path: string) => void; onPin: (path: string) => void; onClose: (path: string) => void; comparisons?: ComparisonTab[]; activeComparison?: string | null; onSelectComparison?: (request: DiffRequest) => void; onCloseComparison?: (key: string) => void; settings?: { active: boolean; select: () => void; close: () => void } | undefined }) {
  const entries: EditorTabEntry[] = [
    ...tabs.map(tab => {
      const name = tab.path.split("/").pop()!;
      return {
        id: `source:${tab.path}`,
        label: tabs.filter(item => item.path.split("/").pop() === name).length > 1 ? tab.path : name,
        title: tab.path,
        controls: "source-editor-area",
        icon: <Icon name={icons.fileText} aria-hidden />,
        preview: !tab.pinned,
        dirty: !!dirty[tab.path],
        active: activePath === tab.path,
        closeLabel: `Close ${tab.path}`,
        select: () => onSelect(tab.path),
        pin: () => onPin(tab.path),
        close: () => onClose(tab.path)
      };
    }),
    ...comparisons.map(tab => {
      const { request } = tab;
      const label = `${request.path} (${request.baseRef.slice(0, 8)} → ${request.targetRef === "working" ? "buffer" : request.targetRef === "working-tree" ? `saved v${request.projectVersion}` : request.targetRef.slice(0, 8)})`;
      return {
        id: `diff:${tab.key}`,
        label,
        title: label,
        controls: `comparison-${tab.key}`,
        icon: <Icon name={icons.gitCompare} aria-hidden />,
        preview: false,
        dirty: request.targetRef === "working" && !!dirty[request.path],
        active: activeComparison === tab.key,
        closeLabel: `Close comparison ${label}`,
        select: () => onSelectComparison?.(request),
        pin: () => undefined,
        close: () => onCloseComparison?.(tab.key)
      };
    }),
    ...(settings ? [{
      id: "settings",
      label: "Settings",
      title: "Project settings",
      controls: "settings-editor-panel",
      icon: <Icon name={icons.settingsGear} aria-hidden />,
      preview: false,
      dirty: false,
      active: settings.active,
      closeLabel: "Close Settings",
      select: settings.select,
      pin: () => undefined,
      close: settings.close
    }] : [])
  ];
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const items: TabItem[] = entries.map(({ id, label, title, controls, icon, preview, dirty: isDirty }) => ({ id, label, title, controls, icon, preview, dirty: isDirty }));
  return <TabBar
    className="editor-tabs"
    label="Open editors"
    tabs={items}
    activeId={entries.find(entry => entry.active)?.id ?? null}
    scrollActiveIntoView
    onSelect={id => byId.get(id)?.select()}
    onActivate={id => byId.get(id)?.pin()}
    onClose={id => byId.get(id)?.close()}
    closeLabel={tab => byId.get(tab.id)?.closeLabel ?? `Close ${tab.id}`}
  />;
}
