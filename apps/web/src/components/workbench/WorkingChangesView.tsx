import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkingFile, WorkingStatus } from "@fastwrite/shared";
import { api } from "../../api/client";
import { Alert, Button, EmptyState, Field, TextArea } from "../ui";
import { WorkingFileRow } from "./WorkingFileRow";
import type { DiffRequest } from "./SourceControlView";

/**
 * The sidebar body: a commit box over the Changes / Staged / Merge groups.
 *
 * Both groups come from one server call, because porcelain v2's XY field is
 * already the split — X is index-vs-HEAD, Y is worktree-vs-index. A file can
 * appear in both at once (staged, then edited again), which is why the model is
 * one record with two statuses rather than two lists.
 */
export function WorkingChangesView({ projectId, version, onCompare, onCommit, onFlush }: {
  projectId: string;
  version: number;
  /**
   * The file open in the workspace. Phase A does not read it: the old list used
   * it to offer "compare the open buffer with the latest checkpoint", and the
   * Graph view brings that back in Phase B. Kept in the signature so the call
   * site does not have to change twice.
   */
  selectedPath: string | null;
  onCompare: (request: DiffRequest) => void;
  /**
   * Commits the index and re-reads the project. It does not flush: `act` flushes
   * before every mutation, this one included.
   */
  onCommit: (message: string) => Promise<void>;
  /** Writes every pending editor save to disk. `act` awaits it before each mutation. */
  onFlush: () => Promise<void>;
}) {
  const [status, setStatus] = useState<WorkingStatus | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const request = ++generation.current;
    try {
      const next = await api.projects.workingStatus(projectId);
      if (request === generation.current) { setStatus(next); setError(""); }
    } catch (failure) {
      if (request === generation.current) setError(failure instanceof Error ? failure.message : "Working changes unavailable");
    }
  }, [projectId]);

  useEffect(() => { void load(); return () => { generation.current += 1; }; }, [load, version]);

  /*
   * Every mutation re-reads the status rather than trusting the call's exit
   * code: `git clean` and `git restore` both exit 0 while doing nothing when the
   * path is ignored, already gone or staged as a deletion. The re-read is what
   * decides whether the operation happened.
   *
   * The flush has to happen here, not at the call site of any one operation,
   * because every operation reads the worktree: `stage` runs `git add`, which
   * copies the on-disk content, and `discard` writes the index back to disk. The
   * editor debounces saves by 850ms, so without the flush the index gets the
   * text from before the user's last keystrokes, and a discard is undone 850ms
   * later when the pending save writes the buffer back over the restore. Doing
   * it in `act` means a future operation cannot forget it.
   */
  const act = async (run: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await onFlush(); await run(); await load(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The Git operation failed"); }
    finally { setBusy(false); }
  };

  /*
   * Every row compares the working tree against the current commit, so this
   * passes the RESOLVED oid rather than the literal string "HEAD".
   *
   * `GitHistory.resolveCommit` accepts only a hex oid — it is also the path that
   * checks the commit is reachable from managed history, which is not a question
   * you can ask of a symbolic ref. Passing "HEAD" therefore returns 404 and the
   * diff pane shows "History checkpoint not found" instead of the comparison.
   *
   * `status.head` is null only in a repository with no commits, where there is
   * genuinely nothing to compare against; the row is inert until something is
   * committed rather than opening a diff that cannot exist.
   */
  const open = (file: WorkingFile) => {
    if (!status?.head) return;
    onCompare({ baseRef: status.head, targetRef: "working", path: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}) });
  };

  const changes = (status?.files ?? []).filter((file) => file.conflicted === false && (file.unstaged !== null || file.untracked));
  const staged = (status?.files ?? []).filter((file) => file.staged !== null);
  const merge = (status?.files ?? []).filter((file) => file.conflicted);
  const canCommit = staged.length > 0 && message.trim().length > 0 && !busy;

  const commit = () => { if (!canCommit) return; void act(async () => { await onCommit(message.trim()); setMessage(""); }); };

  if (!status && !error) return <p role="status">Loading changes…</p>;
  return <section className="working-changes" aria-label="Working changes">
    <Field label="Commit message">
      <TextArea
        value={message}
        onChange={setMessage}
        rows={2}
        resize="none"
        placeholder="Describe this change"
        aria-label="Commit message"
        onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); commit(); } }}
      />
    </Field>
    <Button variant="primary" disabled={!canCommit} onClick={commit}>{busy ? "Working…" : "Commit"}</Button>
    {error ? <Alert tone="error">{error}</Alert> : null}

    {merge.length ? <Group title="Merge Changes" files={merge} group="merge" count={merge.length} onOpen={open} /> : null}
    <Group title="Changes" files={changes} group="changes" count={changes.length} onOpen={open}
      bulkAction={changes.length ? { label: "Stage all changes", run: () => act(() => api.projects.stagePaths(projectId, changes.map((file) => file.path))) } : undefined}
      perFile={{ stage: (file) => act(() => api.projects.stagePaths(projectId, [file.path])),
                 discard: (file) => act(() => api.projects.discardPaths(projectId, [file.path])) }} />
    <Group title="Staged Changes" files={staged} group="staged" count={staged.length} onOpen={open}
      bulkAction={staged.length ? { label: "Unstage all changes", run: () => act(() => api.projects.unstagePaths(projectId, staged.map((file) => file.path))) } : undefined}
      perFile={{ unstage: (file) => act(() => api.projects.unstagePaths(projectId, [file.path])) }} />

    {!merge.length && !changes.length && !staged.length ? <EmptyState title="No changes" detail="The workspace matches the last commit." /> : null}
  </section>;
}

function Group({ title, files, group, count, onOpen, bulkAction, perFile }: {
  title: string; files: WorkingFile[]; group: "changes" | "staged" | "merge"; count: number;
  onOpen: (file: WorkingFile) => void;
  /*
   * `| undefined` is explicit because the call site passes the property
   * unconditionally, as `condition ? action : undefined`, and this project
   * enables exactOptionalPropertyTypes.
   */
  bulkAction?: { label: string; run: () => void } | undefined;
  perFile?: { stage?: (file: WorkingFile) => void; unstage?: (file: WorkingFile) => void; discard?: (file: WorkingFile) => void };
}) {
  if (!count) return null;
  return <section className="working-group" aria-label={title}>
    <header className="working-group__header">
      <h3>{title} <span aria-label={`${count} files`}>{count}</span></h3>
      {bulkAction ? <Button size="small" variant="ghost" onClick={bulkAction.run}>{bulkAction.label}</Button> : null}
    </header>
    <div className="working-group__files">
      {files.map((file) => <WorkingFileRow key={`${group}:${file.path}`} file={file} group={group} onOpen={() => onOpen(file)}
        {...(perFile?.stage ? { onStage: () => perFile.stage!(file) } : {})}
        {...(perFile?.unstage ? { onUnstage: () => perFile.unstage!(file) } : {})}
        {...(perFile?.discard ? { onDiscard: () => perFile.discard!(file) } : {})} />)}
    </div>
  </section>;
}
