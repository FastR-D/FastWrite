import { userFacingError } from "../../lib/notifications";
import { useEffect, useState } from "react";
import type { CollaborationVersion } from "@fastwrite/shared";
import { api } from "../../api/client";
import { Button, Dialog, Field, Icon, icons, TextField } from "../ui";
import styles from "./CollaborationPanel.module.css";

type Preview = Awaited<ReturnType<typeof api.projects.versionPreview>>;
export function CollaborationHistoryPanel({ projectId, canWrite, selectedPath, onFlush, onCompare, onRestored }: { projectId: string; canWrite: boolean; selectedPath: string | null; onFlush: () => Promise<void>; onCompare: (oid: string, path: string) => void; onRestored: () => Promise<void> }) {
  const [versions, setVersions] = useState<CollaborationVersion[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [selected, setSelected] = useState<CollaborationVersion | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [restore, setRestore] = useState<"file" | "project" | null>(null);
  const [result, setResult] = useState("");
  const load = async (next?: string) => { const page = await api.projects.versions(projectId, next); setVersions(current => next ? [...current, ...page.commits] : page.commits); setCursor(page.nextCursor); };
  useEffect(() => { let live = true; void api.projects.versions(projectId).then(page => { if (live) { setVersions(page.commits); setCursor(page.nextCursor); } }).catch(failure => { if (live) setError(userFacingError(failure)); }); return () => { live = false; }; }, [projectId]);
  const act = async (operation: () => Promise<void>) => { if (busy) return; setBusy(true); setError(""); try { await operation(); } catch (failure) { setError(userFacingError(failure, "版本操作失败")); } finally { setBusy(false); } };
  const choose = (version: CollaborationVersion) => { void act(async () => { await onFlush(); const next = await api.projects.versionPreview(projectId, version.oid); setSelected(version); setPreview(next); setResult(""); }); };
  const save = () => { void act(async () => { await onFlush(); await api.projects.saveVersion(projectId, label.trim()); setLabel(""); await load(); setResult("版本已保存，包含当前评论与修订状态。"); }); };
  const confirm = () => { void act(async () => {
    if (!selected || !preview || !restore) return;
    await onFlush();
    await api.projects.restoreVersion(projectId, selected.oid, preview.projectVersion, preview.discussionVersion, restore === "file" && selectedPath ? [selectedPath] : undefined);
    setRestore(null); setPreview(null); setSelected(null); await onRestored(); await load(); setResult("已恢复；恢复前的状态已自动保存在历史中。");
  }); };
  return <>
    <p className={styles.hint}>查看和比较团队版本；命名版本同时保留正文、评论与修订状态。</p>
    {canWrite ? <div className={styles.compose}><Field label="保存命名版本"><TextField aria-label="版本名称" value={label} onChange={setLabel} placeholder="例如：首次投稿、返修第一轮" /></Field><Button size="small" disabled={busy || !label.trim()} icon={<Icon name={icons.history} />} onClick={save}>保存版本</Button></div> : null}
    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    {result ? <p role="status" className={styles.hint}>{result}</p> : null}
    {selected && preview ? <section className={styles.thread} aria-label="版本恢复预览">
      <strong>{selected.label}</strong><small className={styles.hint}>与当前项目相比，{preview.files.length} 个文件有变化。{preview.annotationsAvailable ? "包含评论与修订快照。" : "此旧版本仅保存了源文件。"}</small>
      <div className={styles.actions}><Button size="small" disabled={busy || !selectedPath} onClick={() => { if (selectedPath) onCompare(selected.oid, selectedPath); }}>对比当前文件</Button>{canWrite ? <Button size="small" disabled={busy || !selectedPath} onClick={() => setRestore("file")}>恢复当前文件</Button> : null}</div>
      {preview.files.slice(0, 100).map(file => <Button variant="ghost" size="small" key={file.path} onClick={() => onCompare(selected.oid, file.path)}>{file.status} · {file.path}{file.binary ? " · 二进制" : ""}</Button>)}
      {preview.files.length > 100 ? <span className={styles.hint}>还有 {preview.files.length - 100} 个文件</span> : null}
      {canWrite ? <Button size="small" variant="danger" disabled={busy || !preview.canRestoreAll} onClick={() => setRestore("project")}>恢复整个项目到此版本</Button> : null}
    </section> : null}
    {versions.map(version => <Button className={styles.version} variant="ghost" key={version.oid} disabled={busy} onClick={() => choose(version)}><strong>{version.label}</strong><small>{version.authorName} · {new Date(version.createdAt).toLocaleString("zh-CN")}</small><span>{version.annotationsAvailable ? "正文、评论与修订" : "源文件版本"}</span></Button>)}
    {cursor ? <Button size="small" disabled={busy} onClick={() => { void act(() => load(cursor)); }}>加载更早版本</Button> : null}
    {!versions.length && !error ? <p className={styles.hint}>尚无可用历史版本。</p> : null}
    <Dialog open={!!restore} title={restore === "project" ? "恢复整个项目？" : "恢复当前文件？"} description={`目标版本：${selected?.label ?? ""}`} onClose={() => { if (!busy) setRestore(null); }} footer={<><Button variant="ghost" disabled={busy} onClick={() => setRestore(null)}>取消</Button><Button variant="danger" loading={busy} onClick={confirm}>确认恢复</Button></>}>
      <p>{restore === "project" ? `将恢复源文件、主文件设置，以及此版本保存的评论和修订状态。当前新增但此版本不存在的文件将从正文工作区移除。预览中共有 ${preview?.files.length ?? 0} 个文件发生变化。` : `将恢复 ${selectedPath ?? "当前文件"} 的内容和此版本保存的评论与修订状态。`}</p>
      <p>恢复前会自动保存副本；若确认期间有新更改，恢复将停止并要求刷新预览。</p>
      {error ? <div role="alert" className={styles.error}>{error}</div> : null}
    </Dialog>
  </>;
}
