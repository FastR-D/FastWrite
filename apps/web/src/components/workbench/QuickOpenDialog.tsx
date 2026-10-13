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
    api.projects.tree(projectId, controller.signal).then(tree => { if (!controller.signal.aborted) setFiles(paths(tree)); }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "无法加载文件"); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
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
  return <Dialog open={open} title="快速打开" description="输入文件名或路径，使用方向键选择，按回车打开。" onClose={onClose}>
    <QuickPick label="匹配的文件" filterLabel="按名称查找文件" items={files.map(path => ({ id: path, label: path }))} onSelect={choose} emptyMessage={error || loading ? "" : "没有匹配的文件。"} />
    {error ? <p role="alert">{error}</p> : loading ? <p role="status">正在加载文件…</p> : null}
  </Dialog>;
}
