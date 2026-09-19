import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import type { HistoryComparison } from "@fastwrite/shared";
import { api, ApiClientError } from "../../api/client";
import type { DocumentRegistry, DocumentEntry } from "../../lib/editor/documentRegistry";
import { configureMonaco, languageForPath } from "../../lib/editor/monaco";
import { Button, Select } from "../ui";
import type { DiffRequest } from "./SourceControlView";

const DIFF_LAYOUTS = [
  { value: "auto", label: "Automatic layout" },
  { value: "split", label: "Side by side" },
  { value: "inline", label: "Inline" }
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
          if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
          entry = registry.open(document);
        } catch (failure) {
          if (failure instanceof ApiClientError && failure.status === 404) return { original, modified: { ref: "working", path: request.path, exists: false, binary: false, size: 0 } };
          throw failure;
        }
      }
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      release = registry.acquire(entry);
      working.current = entry;
      return { original, modified: { ref: "working", path: request.path, exists: true, binary: false, content: entry.model.getValue(), size: new Blob([entry.model.getValue()]).size } };
    };
    void load().then(result => { if (!controller.signal.aborted) setComparison(result); }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Comparison unavailable"); });
    return () => { controller.abort(); queueMicrotask(() => release?.()); };
  }, [projectId, request, registry]);
  useEffect(() => {
    if (!host.current || !comparison || comparison.original.binary || comparison.modified.binary) return;
    configureMonaco();
    const entry = working.current;
    const instance = monaco.editor.createDiffEditor(host.current, { automaticLayout: true, readOnly: !entry, originalEditable: false, renderSideBySide: host.current.clientWidth >= 800, minimap: { enabled: false }, hideUnchangedRegions: { enabled: true }, scrollBeyondLastLine: false, wordWrap: "on", originalAriaLabel: "Historical original", modifiedAriaLabel: entry ? `Working buffer for ${request.path}` : "Historical modified" });
    const identity = crypto.randomUUID();
    const model = (side: "original" | "modified") => monaco.editor.createModel(comparison[side].content ?? "", languageForPath(comparison[side].path), monaco.Uri.from({ scheme: "fastwrite-history", authority: projectId, path: `/${comparison[side].ref}/${comparison[side].path}`, query: `${side}-${identity}` }));
    const original = model("original"), modified = entry?.model ?? model("modified");
    const release = entry ? registry.acquire(entry) : undefined;
    instance.setModel({ original, modified });
    host.current.dataset.originalModelId = original.id;
    host.current.dataset.modifiedModelId = modified.id;
    instance.getOriginalEditor().updateOptions({ ariaLabel: "Historical original" });
    instance.getModifiedEditor().updateOptions({ ariaLabel: entry ? `Working buffer for ${request.path}` : "Historical modified" });
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
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Restore failed; local content retained"); }
    finally { setRestoring(false); }
  };
  return <section className="workspace-diff" aria-label="History comparison" data-diff-target={request.targetRef} data-diff-path={request.path}>
    <div className="workbench-actions"><strong>{request.oldPath ? `${request.oldPath} → ` : ""}{request.path}</strong><Select aria-label="Diff layout" value={mode} onChange={value => setMode(value as typeof mode)} options={DIFF_LAYOUTS} /><Button variant="ghost" disabled={!changeCount} onClick={() => jump(-1)}>Previous change</Button><Button variant="ghost" disabled={!changeCount} onClick={() => jump(1)}>Next change</Button><span>{changeCount} changes</span><Button variant="ghost" disabled={(request.targetRef === "working" || request.targetRef === "working-tree") || !comparison?.modified.exists || comparison.modified.binary || restoring} onClick={() => setConfirmRestore(true)}>Restore file</Button><Button variant="ghost" disabled={restoring} onClick={onClose}>Close comparison</Button></div>
    {confirmRestore ? <div className="diff-restore-confirmation" role="group" aria-label="Confirm history restore"><p>Replace {request.path} with checkpoint {request.targetRef.slice(0, 8)}. A new history commit will record this restore.</p>{dirty ? <p>Local edits must be saved to a checkpoint before restoring.</p> : null}<Button variant="primary" disabled={dirty || restoring} onClick={() => void restore(false)}>Confirm restore</Button><Button variant="secondary" disabled={restoring} onClick={() => void restore(true)}>Save checkpoint then restore</Button><Button variant="ghost" disabled={restoring} onClick={() => setConfirmRestore(false)}>Cancel</Button></div> : null}
    <div className="diff-identities" data-original-exists={!comparison ? "unknown" : comparison.original.exists ? "true" : "false"} data-modified-exists={!comparison ? "unknown" : comparison.modified.exists ? "true" : "false"}><span>Original: {request.baseRef.slice(0, 8)} {comparison && !comparison.original.exists ? "· file does not exist" : ""}</span><span>Modified: {request.targetRef === "working" ? "Working buffer · editable" : request.targetRef === "working-tree" ? `Saved tree v${request.projectVersion}` : request.targetRef.slice(0, 8)} {comparison && !comparison.modified.exists ? "· file does not exist" : ""}</span></div>
    {error ? <p role="alert">{error}</p> : !comparison ? <p role="status">Loading comparison…</p> : comparison.original.binary || comparison.modified.binary ? <p>Binary comparison · original {comparison.original.size} bytes · modified {comparison.modified.size} bytes</p> : null}
    <div className="diff-editor-host" ref={host} />
  </section>;
}
