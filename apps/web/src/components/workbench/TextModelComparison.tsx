import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import { configureMonaco } from "../../lib/editor/monaco";

export const textModelComparisonStats = { created: 0, disposed: 0 };

/** Caller owns both models; comparison views never dispose shared or recovery buffers. */
export function TextModelComparison({ original, modified, originalLabel, modifiedLabel, readOnly = true }: { original: monaco.editor.ITextModel; modified: monaco.editor.ITextModel; originalLabel: string; modifiedLabel: string; readOnly?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [inline, setInline] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    configureMonaco();
    const instance = monaco.editor.createDiffEditor(host.current, { automaticLayout: true, readOnly, originalEditable: false, originalAriaLabel: originalLabel, modifiedAriaLabel: modifiedLabel, wordWrap: "on", minimap: { enabled: false }, scrollBeyondLastLine: false });
    textModelComparisonStats.created += 1;
    // Parent effects may release owned models before this child's React cleanup runs.
    // Register before setModel so the diff detaches before its disposal guard fires.
    const detachers = [original.onWillDispose(() => instance.setModel(null)), modified.onWillDispose(() => instance.setModel(null))];
    instance.setModel({ original, modified }); editor.current = instance;
    const layout = () => instance.updateOptions({ renderSideBySide: !inline && (host.current?.clientWidth ?? 0) >= 760 });
    layout(); const observer = new ResizeObserver(layout); observer.observe(host.current);
    return () => { observer.disconnect(); instance.setModel(null); detachers.forEach(item => item.dispose()); instance.dispose(); textModelComparisonStats.disposed += 1; editor.current = null; };
  }, [original, modified, readOnly, originalLabel, modifiedLabel, inline]);
  const jump = (direction: number) => {
    const instance = editor.current, changes = instance?.getLineChanges(); if (!instance || !changes?.length) return;
    const target = instance.getModifiedEditor(), line = target.getPosition()?.lineNumber ?? 0;
    const sorted = direction > 0 ? changes : [...changes].reverse();
    const change = sorted.find(item => direction > 0 ? item.modifiedStartLineNumber > line : item.modifiedStartLineNumber < line) ?? sorted[0]!;
    const next = Math.max(1, change.modifiedStartLineNumber); target.setPosition({ lineNumber: next, column: 1 }); target.revealLineInCenter(next); target.focus();
  };
  return <div className="text-model-comparison"><div className="workbench-actions"><span>{originalLabel} → {modifiedLabel}</span><button type="button" onClick={() => jump(-1)}>Previous change</button><button type="button" onClick={() => jump(1)}>Next change</button><label><input type="checkbox" checked={inline} onChange={event => setInline(event.target.checked)} /> Inline comparison</label></div><div className="text-model-comparison__editor" ref={host} /></div>;
}
