import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  File,
  FileCode2,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  LoaderCircle
} from "lucide-react";
import type { WorkspaceTreeNode } from "@fastwrite/shared";

interface FileTreeProps {
  nodes: WorkspaceTreeNode[];
  selectedPath: string | null;
  mainDocument: string;
  onSelect: (node: WorkspaceTreeNode) => void;
  onExpand?: (path: string) => Promise<void>;
}

interface VisibleNode {
  node: WorkspaceTreeNode;
  depth: number;
}

const ROW_HEIGHT = 27;
const OVERSCAN = 8;

export function FileTree({ nodes, selectedPath, mainDocument, onSelect, onExpand }: FileTreeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [loadFailed, setLoadFailed] = useState<Set<string>>(() => new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(500);

  useEffect(() => {
    if (!selectedPath) return;
    const segments = selectedPath.split("/");
    setExpanded((current) => {
      const next = new Set(current);
      let parent = "";
      for (const segment of segments.slice(0, -1)) {
        parent = parent ? `${parent}/${segment}` : segment;
        next.add(parent);
      }
      return next.size === current.size ? current : next;
    });
  }, [selectedPath]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => setViewportHeight(entry?.contentRect.height ?? 500));
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const rows = useMemo(() => flattenVisible(nodes, expanded), [expanded, nodes]);

  useEffect(() => {
    if (!selectedPath || !containerRef.current) return;
    const index = rows.findIndex(({ node }) => node.path === selectedPath);
    if (index < 0) return;
    const rowTop = index * ROW_HEIGHT;
    const rowBottom = rowTop + ROW_HEIGHT;
    const viewBottom = containerRef.current.scrollTop + viewportHeight;
    if (rowTop < containerRef.current.scrollTop) containerRef.current.scrollTop = rowTop;
    else if (rowBottom > viewBottom) containerRef.current.scrollTop = Math.max(0, rowBottom - viewportHeight);
  }, [rows, selectedPath, viewportHeight]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  const visibleRows = rows.slice(start, end);

  const loadDirectory = async (path: string, retry = false) => {
    if (!onExpand || loading.has(path) || (!retry && loadFailed.has(path))) return;
    if (retry) setLoadFailed((current) => { const next = new Set(current); next.delete(path); return next; });
    setLoading((current) => new Set(current).add(path));
    try { await onExpand(path); }
    catch { setLoadFailed((current) => new Set(current).add(path)); }
    finally { setLoading((current) => { const next = new Set(current); next.delete(path); return next; }); }
  };

  useEffect(() => {
    for (const path of expanded) {
      const directory = findDirectory(nodes, path);
      if (directory && directory.loaded === false && !loading.has(path)) void loadDirectory(path);
    }
  }, [expanded, loading, nodes, onExpand]);

  const toggle = (node: Extract<WorkspaceTreeNode, { type: "directory" }>) => {
    const opening = !expanded.has(node.path);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(node.path)) next.delete(node.path);
      else next.add(node.path);
      return next;
    });
    if (opening && node.loaded === false) void loadDirectory(node.path, true);
  };

  return (
    <div ref={containerRef} className="file-tree" role="tree" onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
      <div className="file-tree__canvas" style={{ height: rows.length * ROW_HEIGHT + 8 }}>
        {visibleRows.map(({ node, depth }, offset) => {
          const index = start + offset;
          const rowStyle = { top: 4 + index * ROW_HEIGHT, paddingLeft: (node.type === "directory" ? 8 : 26) + depth * 14 };
          if (node.type === "directory") {
            const isExpanded = expanded.has(node.path);
            const isLoading = loading.has(node.path);
            return (
              <button key={node.path} className="tree-row file-tree__virtual-row" style={rowStyle} role="treeitem" aria-expanded={isExpanded} aria-busy={isLoading} onClick={() => toggle(node)}>
                {isLoading ? <LoaderCircle className="tree-row__chevron spin" /> : isExpanded ? <ChevronDown className="tree-row__chevron" /> : <ChevronRight className="tree-row__chevron" />}
                {isExpanded ? <FolderOpen className="tree-row__folder" /> : <Folder className="tree-row__folder" />}
                <span title={node.path}>{node.name}</span>
              </button>
            );
          }
          return (
            <button key={node.path} className={`tree-row tree-row--file file-tree__virtual-row ${selectedPath === node.path ? "is-selected" : ""}`} style={rowStyle} role="treeitem" aria-selected={selectedPath === node.path} onClick={() => onSelect(node)}>
              <FileIcon path={node.path} kind={node.kind} />
              <span title={node.path}>{node.name}</span>
              {node.path === mainDocument ? <BookOpen className="tree-row__main" aria-label="Main document" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function findDirectory(nodes: WorkspaceTreeNode[], path: string): Extract<WorkspaceTreeNode, { type: "directory" }> | undefined {
  for (const node of nodes) {
    if (node.type !== "directory") continue;
    if (node.path === path) return node;
    const nested = findDirectory(node.children, path);
    if (nested) return nested;
  }
  return undefined;
}

export function flattenVisible(nodes: WorkspaceTreeNode[], expanded: ReadonlySet<string>, depth = 0): VisibleNode[] {
  return nodes.flatMap((node) => [
    { node, depth },
    ...(node.type === "directory" && expanded.has(node.path) ? flattenVisible(node.children, expanded, depth + 1) : [])
  ]);
}

function FileIcon({ path, kind }: { path: string; kind: string }) {
  if (kind === "image") return <FileImage className="tree-row__image" />;
  const extension = path.split(".").at(-1)?.toLowerCase();
  if (extension === "tex" || extension === "sty" || extension === "cls") return <FileCode2 className="tree-row__tex" />;
  if (extension === "md" || extension === "bib") return <FileText className="tree-row__text" />;
  return <File />;
}
