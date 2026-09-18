import { useCallback, useEffect, useRef, useState } from "react";
import type { HistoryChanges, HistoryCommit, HistorySummary } from "@fastwrite/shared";
import { Dropdown } from "vscrui";
import { CurrentChangesView } from "./CurrentChangesView";
import type { DocumentRegistry } from "../../lib/editor/documentRegistry";
import { api } from "../../api/client";
import { Button } from "../ui/Button";

export interface DiffRequest { baseRef: string; targetRef: string; path: string; oldPath?: string; projectVersion?: number; }
export function SourceControlView({ registry, projectId, version, selectedPath, onCompare, onCheckpoint, onSync }: { registry: DocumentRegistry; projectId: string; version: number; selectedPath: string | null; onCompare: (request: DiffRequest) => void; onCheckpoint: () => Promise<void>; onSync?: () => void }) {
  const [historyEpoch, setHistoryEpoch] = useState(0);
  const [commits, setCommits] = useState<HistoryCommit[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<HistorySummary | null>(null);
  const [baseRef, setBaseRef] = useState("");
  const [targetRef, setTargetRef] = useState("");
  const [comparison, setComparison] = useState<HistoryChanges | null>(null);
  const [comparing, setComparing] = useState(false);
  const compareController = useRef<AbortController | null>(null);
  useEffect(() => { compareController.current?.abort(); setComparison(null); setComparing(false); }, [projectId, baseRef, targetRef]);
  useEffect(() => () => compareController.current?.abort(), []);
  const compareCheckpoints = async () => {
    compareController.current?.abort(); const controller = new AbortController(); compareController.current = controller;
    setComparing(true); setComparison(null); setError("");
    try { const result = await api.projects.historyChanges(projectId, baseRef, targetRef, controller.signal); if (!controller.signal.aborted) setComparison(result); }
    catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Comparison unavailable"); }
    finally { if (!controller.signal.aborted) setComparing(false); }
  };
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const selectionGeneration = useRef(0);
  const load = useCallback(async (next?: string) => {
    const request = ++generation.current;
    setBusy(true); setError("");
    try {
      const page = await api.projects.historyPage(projectId, { ...(next ? { cursor: next } : {}), ...(filter ? { path: filter } : {}) });
      if (request !== generation.current) return;
      setCommits(current => next ? [...current, ...page.commits] : page.commits);
      setCursor(page.nextCursor); setHistoryEpoch(value => value + 1);
    } catch (failure) { if (request === generation.current) setError(failure instanceof Error ? failure.message : "History unavailable"); }
    finally { if (request === generation.current) setBusy(false); }
  }, [projectId, filter]);
  useEffect(() => { void load(); return () => { generation.current++; selectionGeneration.current++; }; }, [load, version]);
  const choose = async (commit: HistoryCommit) => {
    const request = ++selectionGeneration.current;
    setError(""); setSelected(null);
    try { const summary = await api.projects.historySummary(projectId, commit.oid); if (request === selectionGeneration.current) setSelected(summary); }
    catch (failure) { if (request === selectionGeneration.current) setError(failure instanceof Error ? failure.message : "Checkpoint unavailable"); }
  };
  return <section className="source-control-view" aria-label="Managed Git history">
    <header className="panel-heading"><span>Git · Managed history</span></header>
    <p>Checkpoints preserve project snapshots. Automatic saves are recorded after two minutes of inactivity.</p>
    <div className="workbench-actions"><Button size="small" disabled={busy} onClick={async () => { setBusy(true); try { await onCheckpoint(); await load(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Checkpoint failed"); setBusy(false); } }}>Create checkpoint</Button>{onSync ? <Button size="small" onClick={onSync}>GitHub sync</Button> : null}</div>
    {commits[0] && selectedPath ? <Button size="small" className="compare-working" onClick={() => onCompare({ baseRef: commits[0]!.oid, targetRef: "working", path: selectedPath })}>Compare open buffer with latest checkpoint</Button> : null}
    <CurrentChangesView registry={registry} projectId={projectId} version={version} historyEpoch={historyEpoch} commits={commits} onCompare={onCompare} />
    <fieldset className="checkpoint-comparison"><legend>Compare two checkpoints</legend>
      <label>Original checkpoint<Dropdown className="checkpoint-dropdown" value={baseRef} placeholder="Choose original" options={[...(baseRef && !commits.some(commit => commit.oid === baseRef) ? [{ value: baseRef, label: `${baseRef.slice(0, 8)} · selected checkpoint` }] : []), ...commits.map(commit => ({ value: commit.oid, label: `${commit.oid.slice(0, 8)} · ${commit.message}` }))]} onChange={value => setBaseRef(typeof value === "string" ? value : value?.value ?? "")} /></label>
      <label>Modified checkpoint<Dropdown className="checkpoint-dropdown" value={targetRef} placeholder="Choose modified" options={[...(targetRef && !commits.some(commit => commit.oid === targetRef) ? [{ value: targetRef, label: `${targetRef.slice(0, 8)} · selected checkpoint` }] : []), ...commits.map(commit => ({ value: commit.oid, label: `${commit.oid.slice(0, 8)} · ${commit.message}` }))]} onChange={value => setTargetRef(typeof value === "string" ? value : value?.value ?? "")} /></label>
      <Button size="small" disabled={!baseRef || !targetRef || comparing} onClick={() => void compareCheckpoints()}>{comparing ? "Comparing…" : "Compare checkpoints"}</Button>
      {comparing ? <p role="status">Comparing checkpoints…</p> : null}
      {comparison ? <><p>{comparison.baseRef.slice(0, 8)} → {comparison.targetRef.slice(0, 8)} · {comparison.files.length} changed files</p><ul className="changed-files" aria-label="Changes between selected checkpoints">{comparison.files.map(file => <li key={file.path}><button onClick={() => onCompare({ baseRef: comparison.baseRef, targetRef: comparison.targetRef, path: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}) })}><b>{file.status}</b> {file.oldPath ? `${file.oldPath} → ` : ""}{file.path}{file.binary ? " · binary" : ""}</button></li>)}</ul>{!comparison.files.length ? <p>No differences between these checkpoints.</p> : null}</> : null}
    </fieldset>
    <label className="history-filter">Filter history by exact path<input value={filter} onChange={event => setFilter(event.target.value)} placeholder="main.tex" /></label>
    {error ? <p role="alert">{error}</p> : null}
    <ol className="history-list">{commits.map(commit => <li key={commit.oid}><button aria-expanded={selected?.oid === commit.oid} onClick={() => void choose(commit)}><strong>{commit.message}</strong><small>{commit.oid.slice(0, 8)} · {commit.source} · {new Date(commit.createdAt).toLocaleString()}</small></button>
      {selected?.oid === commit.oid && selectedPath ? <Button size="small" className="compare-working" onClick={() => onCompare({ baseRef: selected.oid, targetRef: "working", path: selectedPath })}>Compare open buffer with this checkpoint</Button> : null}
      {selected?.oid === commit.oid ? <ul className="changed-files">{selected.files.map(file => <li key={file.path}><button title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path} onClick={() => onCompare({ baseRef: selected.parentOids[0] ?? "empty", targetRef: selected.oid, path: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}) })}><b>{file.status}</b> {file.oldPath ? `${file.oldPath} → ` : ""}{file.path}{file.binary ? " · binary" : ""}</button></li>)}{!selected.files.length ? <li>No file changes</li> : null}</ul> : null}
    </li>)}</ol>
    {cursor ? <Button size="small" disabled={busy} onClick={() => void load(cursor)}>Load older checkpoints</Button> : null}
    {busy ? <p role="status">Loading history…</p> : !commits.length ? <p>No checkpoints match.</p> : null}
  </section>;
}
