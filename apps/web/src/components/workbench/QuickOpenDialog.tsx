import { useEffect, useState } from "react";
import type { WorkspaceTreeNode } from "@fastwrite/shared";
import { api } from "../../api/client";
import { Dialog } from "../ui/Dialog";
function paths(nodes: WorkspaceTreeNode[]): string[] { return nodes.flatMap(node => node.type === "directory" ? paths(node.children) : [node.path]); }
export function QuickOpenDialog({ open, projectId, onClose, onOpen }: { open: boolean; projectId: string; onClose: () => void; onOpen: (path: string) => void }) {
  const [files, setFiles] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setQuery(""); setIndex(0); setError(""); setFiles([]); setLoading(true);
    api.projects.tree(projectId, controller.signal).then(tree => { if (!controller.signal.aborted) setFiles(paths(tree)); }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load files"); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, projectId]);
  const matches = files.filter(path => path.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, 100);
  const choose = (path: string) => { onOpen(path); onClose(); };
  return <Dialog open={open} title="Quick open" description="Type a file name or path. Use arrow keys and Enter to open." onClose={onClose}>
    <input autoFocus aria-label="Find file by name" value={query} onChange={event => { setQuery(event.target.value); setIndex(0); }} onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setIndex(current => Math.max(0, Math.min(matches.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)))); }
      if (event.key === "Enter" && matches[index]) { event.preventDefault(); choose(matches[index]); }
    }} />
    {error ? <p role="alert">{error}</p> : loading ? <p role="status">Loading files…</p> : !matches.length ? <p>No matching files.</p> : null}
    <div className="quick-open-list" role="listbox" aria-label="Matching files">{matches.map((path, item) => <button key={path} role="option" aria-selected={item === index} onClick={() => choose(path)}>{path}</button>)}</div>
  </Dialog>;
}
