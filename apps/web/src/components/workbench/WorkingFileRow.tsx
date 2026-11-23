import type { WorkingFile } from "@fastwrite/shared";
import { Button, Icon, IconButton, ListRow, icons } from "../ui";
import styles from "./SourceControlView.module.css";

export type ChangeGroup = "changes" | "staged" | "merge";

export const gitFileStatus: Record<string, string> = {
  M: "已修改",
  A: "已添加",
  D: "已删除",
  U: "未跟踪",
  R: "已重命名",
  T: "类型变更",
  "!": "冲突"
};

export function GitFileLabel({ path, oldPath }: { path: string; oldPath?: string | undefined }) {
  const boundary = path.lastIndexOf("/");
  const name = path.slice(boundary + 1);
  const directory = boundary === -1 ? "" : path.slice(0, boundary);
  const icon = /\.(tex|sty|cls|bib)$/i.test(name) ? icons.fileCode : /\.(png|jpe?g|svg|webp)$/i.test(name) ? icons.fileMedia : icons.fileText;

  return <>
    <Icon name={icon} size={15} className={styles.fileIcon ?? ""} aria-hidden />
    <span className={styles.fileLabel}>
      <span className={styles.fileName}>{oldPath ? oldPath.split("/").pop() + " → " : ""}{name}</span>
      {directory ? <small className={styles.directory}>{directory}</small> : null}
    </span>
  </>;
}

export function WorkingFileRow({ file, group, selected, busy, onOpen, onStage, onUnstage, onDiscard }: {
  file: WorkingFile;
  group: ChangeGroup;
  selected: boolean;
  busy: boolean;
  onOpen: () => void;
  onStage?: (() => void) | undefined;
  onUnstage?: (() => void) | undefined;
  onDiscard?: (() => void) | undefined;
}) {
  const pathLabel = file.oldPath ? file.oldPath + " → " + file.path : file.path;
  const marker = group === "merge" ? "!" : group === "staged" ? file.staged ?? "M" : file.untracked ? "U" : file.unstaged ?? "M";

  return <ListRow className={styles.fileRow + (selected ? " " + styles.selectedRow : "")}>
    <Button size="small" variant="ghost" className={styles.fileOpen} aria-label={pathLabel} title={pathLabel} aria-pressed={selected} onClick={onOpen}>
      <GitFileLabel path={file.path} oldPath={file.oldPath} />
    </Button>
    <div className={styles.fileActions}>
      {onDiscard ? <IconButton className={styles.iconAction} label={"放弃文件更改： " + file.path} icon={<Icon name={icons.discard} size={13} />} disabled={busy} onClick={onDiscard} /> : null}
      {onStage ? <IconButton className={styles.iconAction} label={"暂存 " + file.path} icon={<Icon name={icons.add} size={13} />} disabled={busy} onClick={onStage} /> : null}
      {onUnstage ? <IconButton className={styles.iconAction} label={"取消暂存 " + file.path} icon={<Icon name={icons.remove} size={13} />} disabled={busy} onClick={onUnstage} /> : null}
    </div>
    <span className={styles.statusMarker} data-status={marker} aria-label={gitFileStatus[marker]} title={gitFileStatus[marker]}>{marker}</span>
  </ListRow>;
}
