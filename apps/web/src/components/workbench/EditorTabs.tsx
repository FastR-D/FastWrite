import { useEffect, useRef } from "react";
import { FileText, GitCompare, X } from "lucide-react";
import type { SourceTab } from "../../lib/editor/tabState";
import type { DiffRequest } from "./SourceControlView";

export const diffRequestKey = (request: DiffRequest) => encodeURIComponent(JSON.stringify([request.baseRef, request.targetRef, request.path, request.oldPath ?? "", request.projectVersion ?? null]));
export interface ComparisonTab { key: string; request: DiffRequest; }
export function EditorTabs({ tabs, activePath, dirty, onSelect, onPin, onClose, comparisons = [], activeComparison = null, onSelectComparison, onCloseComparison }: { tabs: SourceTab[]; activePath: string | null; dirty: Record<string, boolean>; onSelect: (path: string) => void; onPin: (path: string) => void; onClose: (path: string) => void; comparisons?: ComparisonTab[]; activeComparison?: string | null; onSelectComparison?: (request: DiffRequest) => void; onCloseComparison?: (key: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => { host.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [activePath, activeComparison]);
  const items = [
    ...tabs.map(tab => {
      const name = tab.path.split("/").pop()!;
      return { key: `source:${tab.path}`, label: tabs.filter(item => item.path.split("/").pop() === name).length > 1 ? tab.path : name, title: tab.path, active: activePath === tab.path, preview: !tab.pinned, dirty: !!dirty[tab.path], comparison: false, controls: "source-editor-area", select: () => onSelect(tab.path), pin: () => onPin(tab.path), close: () => onClose(tab.path), closeLabel: `Close ${tab.path}` };
    }),
    ...comparisons.map(tab => {
      const { request } = tab;
      const label = `${request.path} (${request.baseRef.slice(0, 8)} → ${request.targetRef === "working" ? "buffer" : request.targetRef === "working-tree" ? `saved v${request.projectVersion}` : request.targetRef.slice(0, 8)})`;
      return { key: `diff:${tab.key}`, label, title: label, active: activeComparison === tab.key, preview: false, dirty: request.targetRef === "working" && !!dirty[request.path], comparison: true, controls: `comparison-${tab.key}`, select: () => onSelectComparison?.(request), pin: () => undefined, close: () => onCloseComparison?.(tab.key), closeLabel: `Close comparison ${label}` };
    })
  ];
  return <div className="editor-tabs" ref={host} role="tablist" aria-label="Open editors" onWheel={event => { if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) event.currentTarget.scrollLeft += event.deltaY; }}>
    {items.map((item, index) => <div key={item.key} className={`editor-tab${item.active ? " is-active" : ""}${item.preview ? " is-preview" : ""}`} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); item.close(); } }}>
      <button role="tab" aria-controls={item.controls} aria-selected={item.active} tabIndex={item.active || !items.some(candidate => candidate.active) && index === 0 ? 0 : -1} title={item.title} onClick={item.select} onDoubleClick={item.pin} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        const next = event.key === "ArrowRight" ? (index + 1) % items.length : event.key === "ArrowLeft" ? (index + items.length - 1) % items.length : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : -1;
        if (next >= 0) { event.preventDefault(); items[next]!.select(); (host.current?.querySelectorAll('[role="tab"]')[next] as HTMLElement | undefined)?.focus(); }
      }}>{item.comparison ? <GitCompare aria-hidden="true" /> : <FileText aria-hidden="true" />}{item.label}{item.dirty ? <span aria-label="Unsaved changes">●</span> : null}</button>
      <button aria-label={item.closeLabel} title={item.closeLabel} onClick={item.close}><X aria-hidden="true" /></button>
    </div>)}
  </div>;
}
