import { useEffect, useMemo, useState, type HTMLAttributes } from "react";
import { Icon, icons, Tree, treeRowClasses } from "../ui";
import type { WorkspaceTreeNode } from "@fastwrite/shared";

interface FileTreeProps {
  nodes: WorkspaceTreeNode[];
  selectedPath: string | null;
  mainDocument: string;
  onPin?: (node: WorkspaceTreeNode) => void;
  onSelect: (node: WorkspaceTreeNode) => void;
  onExpand?: (path: string) => Promise<void>;
}

interface VisibleNode {
  node: WorkspaceTreeNode;
  depth: number;
}

const ROW_HEIGHT = 27;

/*
 * Expansion, the lazy-load bookkeeping and the row markup stay here; the
 * virtualiser, the treeitem wrapper and the depth padding live in `Tree`. The
 * label keeps its `<span title={path}>` — sixteen Playwright selectors look for
 * exactly that, so it travels through `renderRow` unchanged.
 */
export function FileTree({ nodes, selectedPath, mainDocument, onSelect, onExpand, onPin }: FileTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [loadFailed, setLoadFailed] = useState<Set<string>>(() => new Set());

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

  const rows = useMemo(() => flattenVisible(nodes, expanded), [expanded, nodes]);

  const loadDirectory = async (path: string, retry = false) => {
    if (!onExpand || loading.has(path) || (!retry && loadFailed.has(path))) return;
    if (retry) setLoadFailed((current) => { const next = new Set(current); next.delete(path); return next; });
    setLoading((current) => new Set(current).add(path));
    try { await onExpand(path); }
    catch { setLoadFailed((current) => { const next = new Set(current); next.add(path); return next; }); }
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

  const rowProps = ({ node }: VisibleNode): HTMLAttributes<HTMLButtonElement> => node.type === "directory"
    ? { "aria-expanded": expanded.has(node.path), "aria-busy": loading.has(node.path), onClick: () => toggle(node) }
    : { onClick: () => onSelect(node), onDoubleClick: () => onPin?.(node) };

  return (
    <Tree
      className="file-tree"
      label="Project files"
      rows={rows}
      rowKey={({ node }) => node.path}
      rowHeight={ROW_HEIGHT}
      selectedKey={selectedPath}
      rowIndent={({ node, depth }) => (node.type === "directory" ? 8 : 26) + depth * 14}
      rowProps={rowProps}
      renderRow={(row) => <TreeRow row={row} expanded={expanded} loading={loading} mainDocument={mainDocument} />}
    />
  );
}

function TreeRow({ row, expanded, loading, mainDocument }: { row: VisibleNode; expanded: ReadonlySet<string>; loading: ReadonlySet<string>; mainDocument: string }) {
  const { node } = row;
  if (node.type === "directory") {
    const isExpanded = expanded.has(node.path);
    const isLoading = loading.has(node.path);
    return (
      <>
        {isLoading ? <Icon name={icons.loading} size={12} spin /> : isExpanded ? <Icon name={icons.chevronDown} size={12} /> : <Icon name={icons.chevronRight} size={12} />}
        {isExpanded ? <Icon name={icons.folderOpened} size={14} className={treeRowClasses.folder} /> : <Icon name={icons.folder} size={14} className={treeRowClasses.folder} />}
        <span className={treeRowClasses.label} title={node.path}>{node.name}</span>
      </>
    );
  }
  return (
    <>
      <FileIcon path={node.path} kind={node.kind} />
      <span className={treeRowClasses.label} title={node.path}>{node.name}</span>
      {node.path === mainDocument ? <Icon name={icons.book} size={14} className={treeRowClasses.main} aria-label="Main document" /> : null}
    </>
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
  if (kind === "image") return <Icon name={icons.fileMedia} size={14} className={treeRowClasses.image} />;
  const extension = path.split(".").at(-1)?.toLowerCase();
  if (extension === "tex" || extension === "sty" || extension === "cls") return <Icon name={icons.fileCode} size={14} className={treeRowClasses.tex} />;
  if (extension === "md" || extension === "bib") return <Icon name={icons.fileText} size={14} className={treeRowClasses.text} />;
  return <Icon name={icons.file} />;
}
