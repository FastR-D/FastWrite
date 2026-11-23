import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { WorkingFile, WorkingStatus } from "@fastwrite/shared";
import { api } from "../../api/client";
import { userFacingError } from "../../lib/notifications";
import { Button, Icon, IconButton, List, TextArea, icons } from "../ui";
import { SourceControlHistory } from "./SourceControlHistory";
import { WorkingFileRow, type ChangeGroup } from "./WorkingFileRow";
import type { DiffRequest } from "./SourceControlView";
import styles from "./SourceControlView.module.css";

export function WorkingChangesView({ projectId, version, active, refreshRevision, selectedPath, mainDocument, activeDiff, onCompare, onCommit, onDiscard, onFlush }: {
  projectId: string;
  version: number;
  active: boolean;
  refreshRevision: number;
  selectedPath: string | null;
  mainDocument: string;
  activeDiff: DiffRequest | null;
  onCompare: (request: DiffRequest) => void;
  onCommit: (message: string) => Promise<void>;
  onDiscard: (paths: string[]) => Promise<void>;
  onFlush: () => Promise<void>;
}) {
  const [status, setStatus] = useState<WorkingStatus | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const mutation = useRef(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    const request = ++generation.current;
    try {
      const next = await api.projects.workingStatus(projectId, signal);
      if (!signal?.aborted && request === generation.current) { setStatus(next); setError(""); }
    } catch (failure) {
      if (!signal?.aborted && request === generation.current) setError(userFacingError(failure, "无法获取当前更改"));
    }
  }, [projectId]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [active, load, refreshRevision, version]);

  const act = async (run: () => Promise<void>) => {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(true);
    setError("");
    try {
      // Stage and discard operate on disk, so flush debounced editor saves first.
      await onFlush();
      await run();
      await load();
    } catch (failure) {
      setError(userFacingError(failure, "Git 操作失败"));
    } finally {
      mutation.current = false;
      setBusy(false);
    }
  };

  const files = status?.files ?? [];
  const changes = files.filter(file => !file.conflicted && (file.unstaged !== null || file.untracked));
  const staged = files.filter(file => file.staged !== null);
  const merge = files.filter(file => file.conflicted);
  const head = status?.head ?? "empty";
  const canCommit = !!staged.length && !merge.length && !!message.trim() && !busy;

  const commit = () => {
    if (canCommit) void act(async () => { await onCommit(message.trim()); setMessage(""); });
  };

  const requestFor = (file: WorkingFile, group: ChangeGroup): DiffRequest => ({
    baseRef: group === "changes" ? "index" : head,
    targetRef: group === "staged" ? "index" : "working",
    path: file.path,
    ...(group !== "changes" && file.oldPath ? { oldPath: file.oldPath } : {})
  });

  return <div className={styles.body}>
    <section className={styles.composer} aria-label="提交更改">
      <TextArea
        className={styles.commitInput ?? ""}
        value={message}
        onChange={setMessage}
        rows={2}
        resize="none"
        placeholder="填写提交说明"
        aria-label="提交说明"
        disabled={busy}
        onKeyDown={event => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); commit(); }
        }}
      />
      <Button className={styles.commitButton} size="small" variant="primary" icon={<Icon name={icons.check} size={14} />} loading={busy} disabled={!canCommit} onClick={commit}>提交</Button>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </section>

    <div className={styles.scroll}>
      <section aria-label="当前更改">
        {merge.length ? <Group title="合并更改" files={merge} group="merge" busy={busy} requestFor={requestFor} activeDiff={activeDiff} onCompare={onCompare} /> : null}
        {staged.length ? <Group title="已暂存更改" files={staged} group="staged" busy={busy} requestFor={requestFor} activeDiff={activeDiff} onCompare={onCompare}
          bulkAction={{ label: "取消暂存全部更改", run: () => act(() => api.projects.unstagePaths(projectId, staged.map(file => file.path))) }}
          onUnstage={file => act(() => api.projects.unstagePaths(projectId, [file.path]))} /> : null}
        {changes.length ? <Group title="更改" files={changes} group="changes" busy={busy} requestFor={requestFor} activeDiff={activeDiff} onCompare={onCompare}
          bulkAction={{ label: "暂存全部更改", run: () => act(() => api.projects.stagePaths(projectId, changes.map(file => file.path))) }}
          onStage={file => act(() => api.projects.stagePaths(projectId, [file.path]))}
          onDiscard={file => act(() => onDiscard([file.path]))} /> : null}
        {!status && !error ? <p className={styles.notice} role="status">正在加载更改…</p> : null}
        {status && !files.length ? <p className={styles.clean}><Icon name={icons.check} size={14} aria-hidden />没有待提交的更改</p> : null}
      </section>

      {status ? <SourceControlHistory projectId={projectId} active={active} head={status.head} refreshRevision={refreshRevision}
        currentPath={selectedPath ?? mainDocument} activeDiff={activeDiff} onCompare={onCompare} /> : null}
    </div>
  </div>;
}

function Group({ title, files, group, busy, requestFor, activeDiff, onCompare, bulkAction, onStage, onUnstage, onDiscard }: {
  title: string;
  files: WorkingFile[];
  group: ChangeGroup;
  busy: boolean;
  requestFor: (file: WorkingFile, group: ChangeGroup) => DiffRequest;
  activeDiff: DiffRequest | null;
  onCompare: (request: DiffRequest) => void;
  bulkAction?: { label: string; run: () => void };
  onStage?: (file: WorkingFile) => void;
  onUnstage?: (file: WorkingFile) => void;
  onDiscard?: (file: WorkingFile) => void;
}) {
  const [open, setOpen] = useState(true);
  const id = useId();

  return <section className={styles.group} aria-label={title}>
    <header className={styles.groupHeader}>
      <Button variant="ghost" size="small" className={styles.disclosure} aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
        <Icon name={open ? icons.chevronDown : icons.chevronRight} size={13} aria-hidden />
        <strong>{title}</strong>
      </Button>
      <span className={styles.count} aria-label={files.length + " 个文件"}>{files.length}</span>
      {bulkAction ? <IconButton className={styles.iconAction} label={bulkAction.label} icon={<Icon name={group === "staged" ? icons.remove : icons.add} size={14} />} disabled={busy} onClick={bulkAction.run} /> : null}
    </header>
    <div id={id} hidden={!open}>
      <List label={title}>
        {files.map(file => {
          const request = requestFor(file, group);
          return <WorkingFileRow key={file.path} file={file} group={group} busy={busy}
            selected={activeDiff?.path === request.path && activeDiff.baseRef === request.baseRef && activeDiff.targetRef === request.targetRef && activeDiff.oldPath === request.oldPath}
            onOpen={() => onCompare(request)}
            onStage={onStage && (() => onStage(file))}
            onUnstage={onUnstage && (() => onUnstage(file))}
            onDiscard={onDiscard && (() => onDiscard(file))} />;
        })}
      </List>
    </div>
  </section>;
}
