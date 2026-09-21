import { useEffect, useState } from "react";
import type { WorkspaceTreeNode } from "@fastwrite/shared";
import { api } from "../../api/client";
import { Dialog, QuickPick } from "../ui";
function paths(nodes: WorkspaceTreeNode[]): string[] { return nodes.flatMap(node => node.type === "directory" ? paths(node.children) : [node.path]); }
export function QuickOpenDialog({ open, projectId, onClose, onOpen }: { open: boolean; projectId: string; onClose: () => void; onOpen: (path: string) => void }) {
  const [files, setFiles] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setError(""); setFiles([]); setLoading(true);
    api.projects.tree(projectId, controller.signal).then(tree => { if (!controller.signal.aborted) setFiles(paths(tree)); }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Could not load files"); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, projectId]);
  const choose = (path: string) => { onOpen(path); onClose(); };
  /*
   * QuickPick owns the filter, the arrow/Home/End keys, Enter and the 100-row
   * cap; it replaces a hand-rolled listbox that did the same work.
   *
   * It is rendered unconditionally, even while the tree is loading or the fetch
   * failed. Gating it on those states unmounts it twice per open — once when
   * `loading` turns true for the first time and again when it clears — and the
   * filter it keeps inside itself is lost each time, so a name typed during the
   * load disappears. `emptyMessage` is blanked in those states instead, since
   * "No matching files." would contradict the line printed below the list.
   *
   * `label` and `filterLabel` are separate because that is how the two elements
   * were already named — "Matching files" on the listbox, "Find file by name"
   * on the field. One name for both would have to rename one of them.
   */
  return <Dialog open={open} title="Quick open" description="Type a file name or path. Use arrow keys and Enter to open." onClose={onClose}>
    <QuickPick label="Matching files" filterLabel="Find file by name" items={files.map(path => ({ id: path, label: path }))} onSelect={choose} emptyMessage={error || loading ? "" : "No matching files."} />
    {error ? <p role="alert">{error}</p> : loading ? <p role="status">Loading files…</p> : null}
  </Dialog>;
}
