import { useEffect, useRef, useState } from "react";
import type { HistoryChangedFile, HistoryCommit, HistoryFileSide, HistoryWorkingChanges } from "@fastwrite/shared";
import { api } from "../../api/client";
import type { DocumentRegistry } from "../../lib/editor/documentRegistry";
import type { DiffRequest } from "./SourceControlView";

type Change = HistoryChangedFile & { unsaved?: boolean };
export function CurrentChangesView({ registry, projectId, version, historyEpoch, commits, onCompare }: { registry: DocumentRegistry; projectId: string; version: number; historyEpoch: number; commits: HistoryCommit[]; onCompare: (request: DiffRequest) => void }) {
  const [baseline, setBaseline] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [snapshot, setSnapshot] = useState<HistoryWorkingChanges | null>(null);
  const [files, setFiles] = useState<Change[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const originals = useRef(new Map<string, Promise<HistoryFileSide>>());
  useEffect(() => registry.subscribe(() => setRevision(value => value + 1)), [registry]);
  useEffect(() => {
    const controller = new AbortController(); setSnapshot(null); setFiles([]); setError(""); setLoading(true);
    void (async () => {
      const oid = baseline || (await api.projects.historyPage(projectId, { limit: 1 })).commits[0]?.oid;
      if (!oid || controller.signal.aborted) return;
      const result = await api.projects.historyWorkingChanges(projectId, oid, controller.signal);
      if (!controller.signal.aborted) { originals.current.clear(); setSnapshot(result); }
    })().catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Current changes unavailable"); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [projectId, version, baseline, refresh, historyEpoch]);
  useEffect(() => {
    if (!snapshot) return;
    let active = true;
    const dirty = [...registry.entries.values()].filter(entry => registry.dirtyEntry(entry));
    void Promise.all(dirty.map(async entry => {
      const serverChange = snapshot.files.find(file => file.path === entry.session.path);
      const path = serverChange?.oldPath ?? entry.session.path;
      const key = JSON.stringify([snapshot.baseRef, path]);
      let original = originals.current.get(key);
      if (!original) {
        original = api.projects.historySide(projectId, snapshot.baseRef, path).catch(error => { originals.current.delete(key); throw error; });
        originals.current.set(key, original);
      }
      return { entry, original: await original, serverChange };
    })).then(overlays => {
      if (!active) return;
      const result = new Map<string, Change>(snapshot.files.map(file => [file.path, file]));
      for (const { entry, original, serverChange } of overlays) {
        if (!registry.dirtyEntry(entry)) continue;
        if (original.content === entry.model.getValue() && serverChange?.status !== "R" && serverChange?.status !== "D") result.delete(entry.session.path);
        else result.set(entry.session.path, { path: entry.session.path, status: serverChange?.status === "R" || serverChange?.status === "D" ? serverChange.status : original.exists ? "M" : "A", ...(serverChange?.oldPath ? { oldPath: serverChange.oldPath } : {}), binary: false, additions: null, deletions: null, unsaved: true });
      }
      setFiles([...result.values()].sort((a, b) => a.path.localeCompare(b.path)));
    }).catch(failure => { if (active) setError(failure instanceof Error ? failure.message : "Buffer comparison unavailable"); });
    return () => { active = false; };
  }, [projectId, snapshot, registry, revision]);
  return <section className="current-changes" aria-label="Current changes"><h3>Current changes <span aria-label="Changed file count">{files.length}</span></h3>
    <label>Baseline<select aria-label="Current changes baseline" value={baseline} onChange={event => setBaseline(event.target.value)}><option value="">Latest checkpoint</option>{baseline && !commits.some(commit => commit.oid === baseline) ? <option value={baseline}>{baseline.slice(0, 8)}</option> : null}{commits.map(commit => <option key={commit.oid} value={commit.oid}>{commit.oid.slice(0, 8)} · {commit.message}</option>)}</select></label>
    <button onClick={() => setRefresh(value => value + 1)} disabled={loading}>Refresh changes</button>
    {snapshot ? <p>Base {snapshot.baseRef.slice(0, 8)} · saved tree v{snapshot.projectVersion} + unsaved buffers</p> : null}
    {error ? <p role="alert">{error}</p> : null}{loading ? <p role="status">Loading current changes…</p> : null}
    <ul className="changed-files" aria-label="Current changed files">{files.map(file => <li key={file.path}><button onClick={() => {
      if (!snapshot) return;
      const savedOnly = file.binary || file.status === "D" && !file.unsaved;
      onCompare({ baseRef: snapshot.baseRef, targetRef: savedOnly ? "working-tree" : "working", path: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}), ...(savedOnly ? { projectVersion: snapshot.projectVersion } : {}) });
    }}><b>{file.status}</b> {file.oldPath ? `${file.oldPath} → ` : ""}{file.path}{file.unsaved ? " · unsaved" : ""}{file.binary ? " · binary" : ""}</button></li>)}</ul>
    {!loading && !error && !files.length ? <p>No changes from this baseline.</p> : null}
  </section>;
}
