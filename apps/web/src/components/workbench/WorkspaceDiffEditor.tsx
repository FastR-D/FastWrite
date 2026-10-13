import { useEffect, useRef, useState } from "react";
import * as monaco from "../../lib/editor/monacoRuntime";
import type { HistoryComparison } from "@fastwrite/shared";
import { api, ApiClientError } from "../../api/client";
import type { DocumentRegistry, DocumentEntry } from "../../lib/editor/documentRegistry";
import { configureMonaco, languageForPath } from "../../lib/editor/monaco";
import { Button, Select } from "../ui";
import type { DiffRequest } from "./SourceControlView";

const DIFF_LAYOUTS = [
  { value: "auto", label: "自动布局" },
  { value: "split", label: "并排对比" },
  { value: "inline", label: "行内对比" }
];

export function WorkspaceDiffEditor({ registry, projectId, projectVersion, dirty, request, onClose, onRestored, onSaveCheckpoint }: { registry: DocumentRegistry; projectId: string; projectVersion: number; dirty: boolean; request: DiffRequest; onClose: () => void; onRestored: (path: string) => Promise<void>; onSaveCheckpoint: () => Promise<number> }) {
  const working = useRef<DocumentEntry | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [comparison, setComparison] = useState<HistoryComparison | null>(null);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"auto" | "split" | "inline">("auto");
  const [changeCount, setChangeCount] = useState(0);
  const [previewVersion, setPreviewVersion] = useState(projectVersion);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [restoring, setRestoring] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setComparison(null); setError(""); setChangeCount(0); setPreviewVersion(projectVersion); setConfirmRestore(false);
    working.current = null;
    let release: (() => void) | undefined;
    const load = async (): Promise<HistoryComparison> => {
      if (request.targetRef === "working-tree") return api.projects.historyWorkingCompare(projectId, request.baseRef, request.path, request.projectVersion!, request.oldPath, controller.signal);
      if (request.targetRef !== "working") return api.projects.historyCompare(projectId, request.baseRef, request.targetRef, request.path, request.oldPath, controller.signal);
      const original = await api.projects.historySide(projectId, request.baseRef, request.oldPath ?? request.path, controller.signal);
      let entry = registry.get(request.path);
      if (!entry) {
        try {
          const document = await api.projects.readFile(projectId, request.path, controller.signal);
          if (controller.signal.aborted) throw new DOMException("已中止", "AbortError");
          entry = registry.open(document);
        } catch (failure) {
          if (failure instanceof ApiClientError && failure.status === 404) return { original, modified: { ref: "working", path: request.path, exists: false, binary: false, size: 0 } };
          throw failure;
        }
      }
      if (controller.signal.aborted) throw new DOMException("已中止", "AbortError");
      release = registry.acquire(entry);
      working.current = entry;
      return { original, modified: { ref: "working", path: request.path, exists: true, binary: false, content: entry.model.getValue(), size: new Blob([entry.model.getValue()]).size } };
    };
    void load().then(result => { if (!controller.signal.aborted) setComparison(result); }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "对比暂不可用"); });
    return () => { controller.abort(); queueMicrotask(() => release?.()); };
  }, [projectId, request, registry]);
  useEffect(() => {
    if (!host.current || !comparison || comparison.original.binary || comparison.modified.binary) return;
    configureMonaco();
    const entry = working.current;
    const instance = monaco.editor.createDiffEditor(host.current, { automaticLayout: true, readOnly: !entry, originalEditable: false, renderSideBySide: host.current.clientWidth >= 800, minimap: { enabled: false }, hideUnchangedRegions: { enabled: true }, scrollBeyondLastLine: false, wordWrap: "on", originalAriaLabel: "历史原始版本", modifiedAriaLabel: entry ? `当前编辑内容： ${request.path}` : "历史修改版本" });
    const identity = crypto.randomUUID();
    const model = (side: "original" | "modified") => monaco.editor.createModel(comparison[side].content ?? "", languageForPath(comparison[side].path), monaco.Uri.from({ scheme: "fastwrite-history", authority: projectId, path: `/${comparison[side].ref}/${comparison[side].path}`, query: `${side}-${identity}` }));
    const original = model("original"), modified = entry?.model ?? model("modified");
    const release = entry ? registry.acquire(entry) : undefined;
    instance.setModel({ original, modified });
    host.current.dataset.originalModelId = original.id;
    host.current.dataset.modifiedModelId = modified.id;
    instance.getOriginalEditor().updateOptions({ ariaLabel: "历史原始版本" });
    instance.getModifiedEditor().updateOptions({ ariaLabel: entry ? `当前编辑内容： ${request.path}` : "历史修改版本" });
    let provider = entry?.collaboration;
    let detachCollaboration = provider?.attachEditor(instance.getModifiedEditor());
    const unsubscribeProvider = registry.subscribe(changed => {
      if (changed !== entry || provider === entry?.collaboration) return;
      detachCollaboration?.(); provider = entry?.collaboration;
      detachCollaboration = provider?.attachEditor(instance.getModifiedEditor());
    });
    editor.current = instance;
    const subscription = instance.onDidUpdateDiff(() => setChangeCount(instance.getLineChanges()?.length ?? 0));
    return () => { unsubscribeProvider(); detachCollaboration?.(); subscription.dispose(); instance.setModel(null); instance.dispose(); original.dispose(); if (!entry) modified.dispose(); release?.(); editor.current = null; };
  }, [comparison, projectId, registry]);
  useEffect(() => {
    if (!host.current || !editor.current) return;
    const element = host.current;
    const update = () => editor.current?.updateOptions({ renderSideBySide: mode === "split" || mode === "auto" && element.clientWidth >= 800 });
    update(); const observer = new ResizeObserver(update); observer.observe(element);
    return () => observer.disconnect();
  }, [mode, comparison]);
  const jump = (direction: number) => {
    const instance = editor.current; const changes = instance?.getLineChanges(); if (!instance || !changes?.length) return;
    const modified = instance.getModifiedEditor(); const line = modified.getPosition()?.lineNumber ?? 0;
    const sorted = direction > 0 ? changes : [...changes].reverse();
    const target = sorted.find(change => direction > 0 ? change.modifiedStartLineNumber > line : change.modifiedStartLineNumber < line) ?? sorted[0]!;
    const next = Math.max(1, target.modifiedStartLineNumber); modified.setPosition({ lineNumber: next, column: 1 }); modified.revealLineInCenter(next); modified.focus();
  };
  const restore = async (saveFirst: boolean) => {
    if ((request.targetRef === "working" || request.targetRef === "working-tree") || !comparison?.modified.exists || comparison.modified.binary || restoring) return;
    setRestoring(true); setError("");
    try {
      const version = saveFirst ? await onSaveCheckpoint() : previewVersion;
      await api.projects.restoreHistory(projectId, request.targetRef, [request.path], version);
      await onRestored(request.path);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "恢复失败，已保留本地内容"); }
    finally { setRestoring(false); }
  };
  return <section className="workspace-diff" aria-label="历史对比" data-diff-target={request.targetRef} data-diff-path={request.path}>
    <div className="workbench-actions"><strong>{request.oldPath ? `${request.oldPath} → ` : ""}{request.path}</strong><Select aria-label="差异布局" value={mode} onChange={value => setMode(value as typeof mode)} options={DIFF_LAYOUTS} /><Button variant="ghost" disabled={!changeCount} onClick={() => jump(-1)}>上一处更改</Button><Button variant="ghost" disabled={!changeCount} onClick={() => jump(1)}>下一处更改</Button><span>{changeCount} 处更改</span><Button variant="ghost" disabled={(request.targetRef === "working" || request.targetRef === "working-tree") || !comparison?.modified.exists || comparison.modified.binary || restoring} onClick={() => setConfirmRestore(true)}>恢复文件</Button><Button variant="ghost" disabled={restoring} onClick={onClose}>关闭对比</Button></div>
    {confirmRestore ? <div className="diff-restore-confirmation" role="group" aria-label="确认恢复历史版本"><p>替换 {request.path} 为检查点版本 {request.targetRef.slice(0, 8)}。此次恢复将记录为新的历史提交。</p>{dirty ? <p>恢复前必须先将本地更改保存到检查点。</p> : null}<Button variant="primary" disabled={dirty || restoring} onClick={() => void restore(false)}>确认恢复</Button><Button variant="secondary" disabled={restoring} onClick={() => void restore(true)}>保存检查点后恢复</Button><Button variant="ghost" disabled={restoring} onClick={() => setConfirmRestore(false)}>取消</Button></div> : null}
    <div className="diff-identities" data-original-exists={!comparison ? "unknown" : comparison.original.exists ? "true" : "false"} data-modified-exists={!comparison ? "unknown" : comparison.modified.exists ? "true" : "false"}><span>原始版本： {request.baseRef.slice(0, 8)} {comparison && !comparison.original.exists ? "· 文件不存在" : ""}</span><span>修改版本： {request.targetRef === "working" ? "当前编辑内容 · 可编辑" : request.targetRef === "working-tree" ? `已保存工作区版本${request.projectVersion}` : request.targetRef.slice(0, 8)} {comparison && !comparison.modified.exists ? "· 文件不存在" : ""}</span></div>
    {error ? <p role="alert">{error}</p> : !comparison ? <p role="status">正在加载对比…</p> : comparison.original.binary || comparison.modified.binary ? <p>二进制对比 · 原始版本 {comparison.original.size} 字节 · 修改版本 {comparison.modified.size} 字节</p> : null}
    <div className="diff-editor-host" ref={host} />
  </section>;
}
