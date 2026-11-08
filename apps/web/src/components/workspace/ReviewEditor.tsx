import { userFacingError } from "../../lib/notifications";
import { buildReviewHunks } from "@fastwrite/shared";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import * as monaco from "../../lib/editor/monacoRuntime";
import { compactGutterOptions, configureMonaco, languageForPath } from "../../lib/editor/monaco";
import { projectReviewDraft } from "../../lib/editor/reviewDraftStore";
import { listRecoveryDrafts, type RecoveryDraft } from "../../lib/offlineDrafts";
import { currentTheme } from "../../lib/theme";
import { Button, Icon, icons } from "../ui";
import styles from "./ReviewEditor.module.css";

export const ReviewEditor = forwardRef<{ flush: () => Promise<void> }, { projectId: string; path: string; userId: string; onSaved: () => void }>(function ReviewEditor({ projectId, path, userId, onSaved }, ref) {
  const draft = projectReviewDraft(projectId, path, userId, onSaved);
  const [, refresh] = useState(0);
  const [recoveries, setRecoveries] = useState<RecoveryDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const applying = useRef(false);
  useImperativeHandle(ref, () => ({ flush: () => draft.flush() }), [draft]);
  useEffect(() => {
    const unsubscribe = draft.subscribe(() => refresh(value => value + 1));
    void draft.ready().catch(() => undefined);
    const online = () => { void draft.flush().catch(() => undefined); };
    const poll = setInterval(() => { if (document.visibilityState === "visible") void draft.refresh(); }, 3_000);
    const unload = (event: BeforeUnloadEvent) => { if (draft.dirty || draft.state === "saving") { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("online", online); window.addEventListener("beforeunload", unload);
    return () => { clearInterval(poll); unsubscribe(); window.removeEventListener("online", online); window.removeEventListener("beforeunload", unload); };
  }, [draft]);
  useEffect(() => {
    let live = true;
    void listRecoveryDrafts(projectId, `review:${userId}:${path}`).then(items => { if (live) setRecoveries(items.slice(0, 5)); }).catch(() => undefined);
    return () => { live = false; };
  }, [projectId, userId, path, draft.session?.id]);
  useEffect(() => {
    if (!host.current || !draft.session) return;
    configureMonaco();
    const instance = monaco.editor.createDiffEditor(host.current, {
      ...compactGutterOptions,
      automaticLayout: true, readOnly: busyRef.current || !!draft.session.closedAt, originalEditable: false,
      renderSideBySide: host.current.clientWidth >= 900, minimap: { enabled: false }, wordWrap: "on", scrollBeyondLastLine: false,
      theme: currentTheme() === "dark" ? "fastwrite-github-dark" : "fastwrite-github",
      originalAriaLabel: `修订原文： ${path}`, modifiedAriaLabel: `修订编辑器： ${path}`,
      fontSize: 13, lineHeight: 22, hideUnchangedRegions: { enabled: false }
    });
    const original = monaco.editor.createModel(draft.session.baseContent, languageForPath(path));
    const modified = monaco.editor.createModel(draft.content, languageForPath(path));
    instance.setModel({ original, modified });
    const labelEditors = () => { instance.getOriginalEditor().updateOptions({ ariaLabel: `修订原文： ${path}` }); instance.getModifiedEditor().updateOptions({ ariaLabel: `修订编辑器： ${path}` }); };
    labelEditors();
    editor.current = instance;
    const change = modified.onDidChangeContent(() => { if (!applying.current) draft.edit(modified.getValue()); });
    const update = () => {
      instance.updateOptions({ readOnly: busyRef.current || !!draft.session?.closedAt }); labelEditors();
      if (draft.session && original.getValue() !== draft.session.baseContent) original.setValue(draft.session.baseContent);
      if (modified.getValue() !== draft.content) {
        applying.current = true;
        try {
          const edits = buildReviewHunks(modified.getValue(), draft.content).map(hunk => { const start = modified.getPositionAt(hunk.from), end = modified.getPositionAt(hunk.to); return { range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column), text: hunk.after }; });
          modified.applyEdits(edits);
        } finally { applying.current = false; }
      }
    };
    const unsubscribe = draft.subscribe(update);
    const observer = new ResizeObserver(() => { if (host.current) { instance.updateOptions({ renderSideBySide: host.current.clientWidth >= 900 }); labelEditors(); } });
    observer.observe(host.current);
    return () => { observer.disconnect(); unsubscribe(); change.dispose(); instance.setModel(null); instance.dispose(); original.dispose(); modified.dispose(); editor.current = null; };
  }, [draft, draft.session?.id, path]);
  useEffect(() => { if (editor.current) { editor.current.updateOptions({ readOnly: busy || !!draft.session?.closedAt }); editor.current.getModifiedEditor().updateOptions({ ariaLabel: `修订编辑器： ${path}` }); editor.current.getOriginalEditor().updateOptions({ ariaLabel: `修订原文： ${path}` }); } }, [busy, draft, path]);
  const next = async () => { setBusy(true); try { await draft.nextRound(); } catch { /* The session exposes and retains its error and buffer. */ } finally { setBusy(false); } };
  const labels = { loading: "正在加载修订草稿…", saved: "修订已保存，等待审核", dirty: "正在记录修订…", saving: "正在保存修订…", offline: "离线，修订保留在此设备", conflict: "修订需要核对，本地输入已保留" };
  return <div className={styles.review}>
    <div className={styles.bar}>
      <span role="status"><Icon name={icons.edit} /> {labels[draft.state]}{draft.session?.pendingCount ? ` · ${draft.session.pendingCount} 处待审核` : ""}</span>
      <Button size="small" disabled={busy || !draft.session || draft.state === "conflict" || !!draft.session.closedAt} loading={draft.state === "saving"} onClick={() => { void draft.flush().catch(() => undefined); }}>保存修订</Button>
    </div>
    <p className={styles.hint}>直接输入即可记录增删。所有更改均为建议，接受前不改变正文或 PDF。</p>
    {draft.session?.closedAt || draft.session?.liveConflict || draft.state === "conflict" ? <div className={styles.notice}>
      <span>{draft.error instanceof Error ? userFacingError(draft.error) : draft.session?.liveConflict ? "正文中的同一位置已更改，相关修订需要核对。本轮草稿和讨论已保留。" : "本轮已有修订被处理。剩余建议继续保留在讨论中。"}</span>
      <Button size="small" loading={busy} onClick={() => { void next(); }}>保存副本并开始下一轮</Button>
    </div> : draft.error ? <p className={styles.error} role="alert">{userFacingError(draft.error, "暂时无法保存修订")}</p> : null}
    <div className={styles.host} ref={host} />
    {recoveries.length ? <div className={styles.recoveries}><span>本地修订副本</span>{recoveries.map(item => <Button key={item.id} size="small" variant="ghost" onClick={() => download(path, item.content)}>{new Date(item.savedAt).toLocaleString("zh-CN")}</Button>)}</div> : null}
  </div>;
});
function download(path: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = `${path.split("/").at(-1) ?? "paper.tex"}.review.tex`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
