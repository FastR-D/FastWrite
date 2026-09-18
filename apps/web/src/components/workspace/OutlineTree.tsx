import { ChevronRight, Hash } from "lucide-react";
import type { OutlineItem } from "@fastwrite/shared";

export function OutlineTree({ items, onSelect, activeId }: { items: OutlineItem[]; onSelect: (item: OutlineItem) => void; activeId?: string | null | undefined }) {
  if (items.length === 0) return <div className="panel-empty"><Hash /><span>No sections detected</span></div>;
  return <div className="outline-tree">{items.map((item) => <OutlineNode key={item.id} item={item} onSelect={onSelect} activeId={activeId} />)}</div>;
}

function OutlineNode({ item, onSelect, activeId }: { item: OutlineItem; onSelect: (item: OutlineItem) => void; activeId?: string | null | undefined }) {
  return (
    <>
      <button className={`outline-row${activeId === item.id ? " is-active" : ""}`} aria-current={activeId === item.id ? "location" : undefined} style={{ paddingLeft: 10 + item.level * 12 }} onClick={() => onSelect(item)} title={`${item.path}:${item.line}`}>
        <ChevronRight />
        <span>{item.title}</span>
      </button>
      {item.children.map((child) => <OutlineNode key={child.id} item={child} onSelect={onSelect} activeId={activeId} />)}
    </>
  );
}
