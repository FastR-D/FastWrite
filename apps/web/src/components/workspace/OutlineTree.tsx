import { ChevronRight, Hash } from "lucide-react";
import type { OutlineItem } from "@fastwrite/shared";

export function OutlineTree({ items, onSelect }: { items: OutlineItem[]; onSelect: (item: OutlineItem) => void }) {
  if (items.length === 0) return <div className="panel-empty"><Hash /><span>No sections detected</span></div>;
  return <div className="outline-tree">{items.map((item) => <OutlineNode key={item.id} item={item} onSelect={onSelect} />)}</div>;
}

function OutlineNode({ item, onSelect }: { item: OutlineItem; onSelect: (item: OutlineItem) => void }) {
  return (
    <>
      <button className="outline-row" style={{ paddingLeft: 10 + item.level * 12 }} onClick={() => onSelect(item)} title={`${item.path}:${item.line}`}>
        <ChevronRight />
        <span>{item.title}</span>
      </button>
      {item.children.map((child) => <OutlineNode key={child.id} item={child} onSelect={onSelect} />)}
    </>
  );
}
