import { useEffect, useId, useState } from "react";
import type { HistoryCommit, HistoryPage, HistorySummary } from "@fastwrite/shared";
import { api } from "../../api/client";
import { userFacingError } from "../../lib/notifications";
import { Button, Icon, IconButton, List, ListRow, icons } from "../ui";
import type { DiffRequest } from "./SourceControlView";
import { GitFileLabel, gitFileStatus } from "./WorkingFileRow";
import styles from "./SourceControlView.module.css";

const dateFormat = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" });
const commitSubject = (message: string) => message.trim().split(/\r?\n/, 1)[0] || "无提交说明";

export function SourceControlHistory({ projectId, active, head, refreshRevision, currentPath, activeDiff, onCompare }: {
  projectId: string;
  active: boolean;
  head: string | null;
  refreshRevision: number;
  currentPath: string;
  activeDiff: DiffRequest | null;
  onCompare: (request: DiffRequest) => void;
}) {
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [error, setError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const id = useId();

  useEffect(() => {
    if (!active || !open) return;
    const controller = new AbortController();
    setError("");
    void api.projects.historyPage(projectId, { limit: 24 }, controller.signal).then(result => {
      if (!controller.signal.aborted) setPage(result);
    }).catch(failure => {
      if (!controller.signal.aborted) setError(userFacingError(failure, "无法加载提交历史"));
    });
    return () => controller.abort();
  }, [projectId, active, open, head, refreshRevision]);

  const loadMore = async () => {
    const previous = page;
    if (!previous?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const next = await api.projects.historyPage(projectId, { cursor: previous.nextCursor, limit: 24 });
      setPage(current => current === previous ? { commits: [...previous.commits, ...next.commits], nextCursor: next.nextCursor } : current);
    } catch (failure) {
      setError(userFacingError(failure, "无法加载更早的提交"));
    } finally { setLoadingMore(false); }
  };

  return <section className={styles.group} aria-label="提交历史">
    <header className={styles.groupHeader}>
      <Button variant="ghost" size="small" className={styles.disclosure} aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
        <Icon name={open ? icons.chevronDown : icons.chevronRight} size={13} aria-hidden />
        <strong>提交历史</strong>
      </Button>
      <Icon name={icons.history} className={styles.historyIcon ?? ""} size={14} aria-hidden />
    </header>
    <div id={id} hidden={!open}>
      {!page && !error ? <p className={styles.notice} role="status">正在加载提交历史…</p> : null}
      {page && !page.commits.length ? <p className={styles.notice}>暂无提交</p> : null}
      {page?.commits.length ? <List ordered label="提交列表">
        {page.commits.map(commit => <CommitRow key={commit.oid} projectId={projectId} commit={commit} isHead={head === commit.oid}
          expanded={selected === commit.oid} active={open && active} onToggle={() => setSelected(value => value === commit.oid ? null : commit.oid)}
          onCompare={onCompare} activeDiff={activeDiff}
          onCompareWorking={() => onCompare({ baseRef: commit.oid, targetRef: "working", path: currentPath })} />)}
      </List> : null}
      {error ? <p className={styles.notice} role="alert">{error}</p> : null}
      {page?.nextCursor ? <Button className={styles.moreHistory} variant="ghost" size="small" loading={loadingMore} onClick={() => void loadMore()}>加载更早的提交</Button> : null}
    </div>
  </section>;
}

function CommitRow({ projectId, commit, isHead, expanded, active, activeDiff, onToggle, onCompare, onCompareWorking }: {
  projectId: string;
  commit: HistoryCommit;
  isHead: boolean;
  expanded: boolean;
  active: boolean;
  activeDiff: DiffRequest | null;
  onToggle: () => void;
  onCompare: (request: DiffRequest) => void;
  onCompareWorking: () => void;
}) {
  const [summary, setSummary] = useState<HistorySummary | null>(null);
  const [error, setError] = useState("");
  const id = useId();
  const subject = commitSubject(commit.message);
  const shortOid = commit.oid.slice(0, 7);

  useEffect(() => {
    if (!active || !expanded || summary) return;
    const controller = new AbortController();
    setError("");
    void api.projects.historySummary(projectId, commit.oid, controller.signal).then(result => {
      if (!controller.signal.aborted) setSummary(result);
    }).catch(failure => {
      if (!controller.signal.aborted) setError(userFacingError(failure, "无法加载此提交的文件"));
    });
    return () => controller.abort();
  }, [projectId, commit.oid, active, expanded, summary]);

  return <ListRow className={styles.commit + (isHead ? " " + styles.headCommit : "")}>
    <div className={styles.commitRow} data-selected={expanded || undefined}>
      <Button size="small" variant="ghost" className={styles.commitOpen} aria-expanded={expanded} aria-controls={id} onClick={onToggle} title={commit.message}>
        <span className={styles.commitNode} aria-hidden />
        <span className={styles.commitLabel}>
          <span className={styles.commitSubject}>{subject}</span>
          <span className={styles.commitMeta}><code>{shortOid}</code><time dateTime={commit.createdAt}>{dateFormat.format(new Date(commit.createdAt))}</time>{isHead ? <span className={styles.head}>HEAD</span> : null}</span>
        </span>
      </Button>
      <IconButton className={styles.iconAction} label={"将当前文件与提交 " + shortOid + " 对比"} icon={<Icon name={icons.gitCompare} size={14} />} onClick={onCompareWorking} />
    </div>
    <div id={id} hidden={!expanded} className={styles.commitDetails}>
      {error ? <p className={styles.notice} role="alert">{error}</p> : null}
      {!summary && !error ? <p className={styles.notice} role="status">正在加载文件…</p> : null}
      {summary && !summary.files.length ? <p className={styles.notice}>此提交没有文件更改</p> : null}
      {summary?.files.length ? <List label="提交的文件">
        {summary.files.map(file => <ListRow className={styles.fileRow + (activeDiff?.targetRef === commit.oid && activeDiff.path === file.path ? " " + styles.selectedRow : "")} key={file.path}>
          <Button size="small" variant="ghost" className={styles.fileOpen} aria-label={file.path} title={file.oldPath ? file.oldPath + " → " + file.path : file.path} onClick={() => onCompare({
            baseRef: commit.parentOids[0] ?? "empty",
            targetRef: commit.oid,
            path: file.path,
            ...(file.oldPath ? { oldPath: file.oldPath } : {})
          })}><GitFileLabel path={file.path} oldPath={file.oldPath} /></Button>
          <span className={styles.statusMarker} data-status={file.status} aria-label={gitFileStatus[file.status]} title={gitFileStatus[file.status]}>{file.status}</span>
        </ListRow>)}
      </List> : null}
    </div>
  </ListRow>;
}
