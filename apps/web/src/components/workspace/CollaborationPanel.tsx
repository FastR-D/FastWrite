import { userFacingError } from "../../lib/notifications";
import { useEffect, useRef, useState } from "react";
import type { CommentThreadView, TextSelection } from "@fastwrite/shared";
import type { ProjectCollaboration } from "../../lib/useProjectCollaboration";
import type { DocumentRegistry } from "../../lib/editor/documentRegistry";
import type { WritingMode } from "./SourceEditor";
import { CollaborationHistoryPanel } from "./CollaborationHistoryPanel";
import { api } from "../../api/client";
import { roleLabel } from "../../lib/labels";
import { Button, Field, Icon, IconButton, Select, TabBar, TextArea, TextField, icons } from "../ui";
import styles from "./CollaborationPanel.module.css";

type Member = Awaited<ReturnType<typeof api.projects.members>>["members"][number];
export function CollaborationPanel({ projectId, registry, collaboration, selection, selectedPath, activeCommentId, writingMode, onWritingModeChange, onInvite, onShare, onNavigate, onSelection, onCompare, onRestored }: {
  projectId: string; registry: DocumentRegistry; collaboration: ProjectCollaboration;
  selection: TextSelection | null; selectedPath: string | null; activeCommentId: string;
  writingMode: WritingMode; onWritingModeChange: (mode: WritingMode) => void;
  onInvite: () => void; onShare: () => void;
  onNavigate: (path: string, from?: number, to?: number, line?: number) => Promise<void>;
  onSelection: (id: string) => void;
  onCompare: (oid: string, path: string) => void;
  onRestored: () => Promise<void>;
}) {
  const { access, threads, externalComments, peers, refresh } = collaboration;
  const [tab, setTab] = useState("discussions");
  const [filter, setFilter] = useState("open");
  const [scope, setScope] = useState("all");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("comment");
  const [body, setBody] = useState("");
  const [replacement, setReplacement] = useState("");
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [members, setMembers] = useState<Member[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const active = activeCommentId;
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    setTab("discussions"); setFilter("all"); setScope("all"); setQuery("");
  }, [active]);
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => { scrollRef.current?.querySelector<HTMLElement>(`[data-thread-id="${active}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }); });
    return () => cancelAnimationFrame(frame);
  }, [active, threads.length, filter, scope]);
  useEffect(() => {
    let live = true;
    const load = () => { if (access?.realtime) void api.projects.members(projectId).then(result => { if (live) setMembers(result.members); }).catch(() => undefined); };
    load();
    const timer = tab === "people" ? setInterval(load, 15_000) : undefined;
    return () => { live = false; clearInterval(timer); };
  }, [projectId, access?.realtime, tab]);
  const act = async (key: string, operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key); setError("");
    try { await operation(); refresh(); }
    catch (failure) { setError(userFacingError(failure, "操作失败，内容已保留")); }
    finally { setBusy(""); }
  };
  const create = () => act("create", async () => {
    if (kind === "project") {
      const created = await api.projects.createComment(projectId, { scope: "project", body: body.trim() });
      setBody(""); onSelection(created.id); setFilter("open"); setScope("all"); return;
    }
    if (!selection) return;
    await registry.flush();
    const created = await api.projects.createComment(projectId, { path: selection.path, from: selection.from, to: selection.to, quote: selection.text,
      body: body.trim() || "建议修改", ...(kind === "suggestion" ? { replacement } : {}) });
    setBody(""); setReplacement(""); onSelection(created.id); setFilter("open"); setScope("all");
  });
  const navigate = (thread: CommentThreadView) => act(`navigate:${thread.id}`, async () => {
    onSelection(thread.id);
    const range = registry.get(thread.path)?.collaboration?.relativeRange(thread.startRelativePosition, thread.endRelativePosition);
    await onNavigate(thread.path, range?.from ?? thread.from, range?.to ?? thread.to);
  });
  const visible = threads.filter(thread => (scope !== "file" || thread.path === selectedPath)
    && (filter === "all" || (filter === "resolved" ? thread.status === "resolved" : filter === "suggestions" ? thread.suggestion?.status === "pending" : thread.status !== "resolved"))
    && (!query || `${thread.path} ${thread.quote} ${thread.messages.map(message => `${message.authorName} ${message.body}`).join(" ")}`.toLowerCase().includes(query.toLowerCase())));
  const online = [...new Map([...peers].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).map(peer => [peer.userId, peer])).values()];
  return <div className={styles.panel}>
    <header className={styles.header}>
      <div><strong>论文协作</strong><small>{online.length ? `${online.length} 人在线` : "与合作者一起完成论文"}</small></div>
      <IconButton label="刷新协作" icon={<Icon name={icons.refresh} />} onClick={refresh} />
    </header>
    {selectedPath && access ? <div className={styles.mode}>
      <Field label="写作模式"><Select aria-label="写作模式" value={writingMode} onChange={value => onWritingModeChange(value as WritingMode)} options={[...(access.canWrite ? [{ value: "editing", label: "编辑" }] : []), ...(access.canComment ? [{ value: "reviewing", label: "审阅 · 跟踪修订" }] : []), { value: "viewing", label: "查看" }]} /></Field>
      <small className={styles.hint}>{writingMode === "reviewing" ? "修订自动保存，接受后写入正文" : writingMode === "viewing" ? "只读正文，可选择文本与查看讨论" : "更改实时同步给协作者"}</small>
    </div> : null}
    <TabBar label="协作面板" activeId={tab} onSelect={setTab} tabs={[{ id: "discussions", label: `讨论 ${threads.filter(item => item.status !== "resolved").length || ""}` }, { id: "external", label: `外部反馈 ${externalComments.filter(item => item.status === "open").length || ""}` }, { id: "people", label: "成员" }, { id: "history", label: "历史" }]} />
    {error || collaboration.error ? <div className={styles.error} role="alert">{error || collaboration.error}</div> : null}
    <div className={styles.scroll} ref={scrollRef}>
      {tab === "history" ? <CollaborationHistoryPanel projectId={projectId} canWrite={!!access?.canWrite} selectedPath={selectedPath} onFlush={() => registry.flush()} onCompare={onCompare} onRestored={onRestored} /> : tab === "people" ? <>
        <div className={styles.actions}>
          {access?.canInvite ? <Button size="small" icon={<Icon name={icons.personAdd} />} onClick={onInvite}>邀请与权限</Button> : null}
          {access?.canManage ? <Button size="small" icon={<Icon name={icons.share} />} onClick={onShare}>分享链接</Button> : null}
        </div>
        {access ? <p className={styles.hint}>你的权限：{roleLabel(access.role)}</p> : null}
        <h3 className={styles.sectionTitle}>正在写作</h3>
        {online.map(peer => <Button key={peer.userId} className={styles.person} variant="ghost" onClick={() => { void act(`peer:${peer.userId}`, () => onNavigate(peer.path, undefined, undefined, peer.line)); }} title="跳转到协作者所在位置">
          <span className={styles.avatar} style={{ backgroundColor: peer.color }}>{peer.name.slice(0, 1)}</span>
          <span><strong>{peer.name}{peer.userId === access?.userId ? "（你）" : ""}</strong><small>{peer.path}{peer.line ? `:${peer.line}` : ""}</small></span><span className={styles.online} />
        </Button>)}
        {!online.length ? <p className={styles.hint}>暂无在线成员</p> : null}
        <h3 className={styles.sectionTitle}>项目成员 · {members.length}</h3>
        {members.map(member => <div className={styles.member} key={member.userId}><span><strong>{member.user.displayName}</strong><small>{member.user.emailNormalized}</small></span><span className={styles.badge}>{roleLabel(member.role)}</span></div>)}
      </> : tab === "external" ? <>
        <p className={styles.hint}>通过分享链接收到的反馈。访客姓名由其自行填写。</p>
        {externalComments.map(comment => <article className={styles.thread} key={comment.id}>
          <header className={styles.threadHeader}><Button variant="ghost" size="small" onClick={() => { void act(comment.id, () => onNavigate(comment.path, undefined, undefined, comment.line)); }}>{comment.path}{comment.line ? `:${comment.line}` : ""}</Button><span className={styles.badge}>{comment.status === "resolved" ? "已解决" : "待处理"}</span></header>
          <div className={styles.message}><div><strong>{comment.author} · 访客</strong><time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleDateString()}</time></div><p>{comment.body}</p></div>
          {comment.canComment ? <Button size="small" variant="ghost" disabled={!!busy} onClick={() => { void act(comment.id, () => api.projects.updateSharedComment(projectId, comment.id, comment.status === "open" ? "resolved" : "open")); }}>{comment.status === "open" ? "解决反馈" : "重新打开"}</Button> : null}
        </article>)}
        {!externalComments.length ? <p className={styles.hint}>暂无外部反馈。可在成员页创建只读或可评论的分享链接。</p> : null}
      </> : <>
        <div className={styles.filters}>
          <Select aria-label="讨论状态" value={filter} onChange={setFilter} options={[{ value: "open", label: `待处理 (${collaboration.openCount})` }, { value: "suggestions", label: "修改建议" }, { value: "resolved", label: "已处理" }, { value: "all", label: "全部讨论" }]} />
          <Select aria-label="讨论范围" value={scope} onChange={setScope} options={[{ value: "all", label: "整个项目" }, { value: "file", label: "当前文件" }]} />
        </div>
        <TextField aria-label="搜索讨论" value={query} onChange={setQuery} placeholder="搜索讨论、作者或原文" />
        {access?.canComment ? <section className={styles.compose} aria-label="新建讨论">
          <div className={styles.actions}><Select aria-label="讨论类型" value={kind} onChange={setKind} options={[{ value: "comment", label: "添加评论" }, { value: "suggestion", label: "建议修改" }, { value: "project", label: "项目讨论" }]} /><span className={styles.hint}>{kind === "project" ? "不关联文件的项目讨论" : selection ? `${selection.path}:${selection.startLine}` : "先在正文中选择文本"}</span></div>
          {selection && kind !== "project" ? <blockquote className={styles.quote}>{selection.text.slice(0, 400)}{selection.text.length > 400 ? "…" : ""}</blockquote> : null}
          {kind === "suggestion" ? <Field label="替换为（留空表示删除）"><TextArea aria-label="建议替换内容" rows={4} value={replacement} onChange={setReplacement} placeholder="输入建议的新文本" /></Field> : null}
          <TextArea aria-label="新评论" rows={3} value={body} onChange={setBody} placeholder={kind === "suggestion" ? "说明修改理由（可选）" : "写下评论或问题"} />
          <div className={styles.actions}>
            <MentionPicker members={members} onPick={mention => setBody(value => `${value}${value ? " " : ""}${mention} `)} />
            <Button size="small" variant="primary" loading={busy === "create"} disabled={!!busy || (kind === "project" ? !body.trim() : !selection || (kind === "comment" ? !body.trim() : replacement === selection.text))} onClick={() => { void create(); }}>{kind === "suggestion" ? "提交建议" : "发表评论"}</Button>
          </div>
        </section> : <p className={styles.hint}>{access?.realtime ? "你可以阅读讨论。如需反馈，请向项目所有者申请审阅权限。" : "登录后可参与项目讨论。"}</p>}
        {!collaboration.loaded ? <p role="status" className={styles.hint}>正在加载讨论…</p> : null}
        {visible.map(thread => <article className={`${styles.thread} ${active === thread.id ? styles.active : ""}`} key={thread.id} data-thread-id={thread.id}>
          <header className={styles.threadHeader}>{thread.scope === "project" ? <strong>项目讨论</strong> : <Button size="small" variant="ghost" disabled={thread.anchorStatus === "orphaned" || !!busy} onClick={() => { void navigate(thread); }}>{thread.path}</Button>}<span className={styles.badge}>{thread.suggestion ? ({ pending: "修改建议", accepted: "已接受", rejected: "已拒绝", withdrawn: "已撤回" }[thread.suggestion.status]) : thread.status === "resolved" ? "已解决" : "待处理"}</span></header>
          {thread.scope !== "project" ? <blockquote className={styles.quote}>{thread.quote || "插入位置"}</blockquote> : null}
          {thread.suggestion ? <div className={styles.change}><small>建议替换为</small><pre>{thread.suggestion.replacement || "（删除所选文本）"}</pre></div> : null}
          {thread.status !== "resolved" && thread.anchorStatus !== "attached" ? <p className={styles.warning}>{thread.anchorStatus === "changed" ? "原文已修改，请核对后重新关联选区。" : "原文已删除或文件已移除，请重新关联选区。"}</p> : null}
          {thread.messages.map(message => <div className={styles.message} key={message.id}><div><strong>{message.authorName}</strong><time dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString()}>{new Date(message.createdAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></div><p>{displayMentions(message.body)}</p></div>)}
          <div className={styles.actions}>
            {thread.suggestion?.status === "pending" && thread.canEdit ? <>
              <Button size="small" variant="primary" disabled={!!busy || thread.anchorStatus !== "attached"} onClick={() => { void act(thread.id, async () => { await registry.flush(); await api.projects.decideSuggestion(projectId, thread.id, "accepted"); await registry.get(thread.path)?.collaboration?.refresh(); }); }}>接受建议</Button>
              <Button size="small" variant="ghost" disabled={!!busy} onClick={() => { void act(thread.id, () => api.projects.decideSuggestion(projectId, thread.id, "rejected")); }}>拒绝</Button>
            </> : null}
            {!thread.suggestion && thread.canComment ? <Button size="small" variant="ghost" disabled={!!busy} onClick={() => { void act(thread.id, () => api.projects.updateComment(projectId, thread.id, thread.status === "resolved" ? "open" : "resolved")); }}>{thread.status === "resolved" ? "重新打开" : "解决讨论"}</Button> : null}
            {thread.status !== "resolved" && thread.anchorStatus !== "attached" && thread.canComment ? <Button size="small" variant="ghost" disabled={!!busy || !selection} onClick={() => { void act(thread.id, async () => { if (!selection) return; await registry.flush(); await api.projects.reanchorComment(projectId, thread.id, { path: selection.path, from: selection.from, to: selection.to, quote: selection.text }); }); }}>关联当前选区</Button> : null}
          </div>
          {thread.canComment && thread.status !== "resolved" ? <div className={styles.reply}>
            <TextArea aria-label={`回复 ${thread.messages[0]?.authorName ?? "讨论"}`} rows={2} value={replies[thread.id] ?? ""} onChange={value => setReplies(current => ({ ...current, [thread.id]: value }))} placeholder="回复讨论" />
            <div className={styles.actions}><MentionPicker members={members} onPick={mention => setReplies(current => ({ ...current, [thread.id]: `${current[thread.id] ?? ""} ${mention} ` }))} /><Button size="small" disabled={!!busy || !replies[thread.id]?.trim()} onClick={() => { void act(thread.id, async () => { await api.projects.replyComment(projectId, thread.id, replies[thread.id]!.trim()); setReplies(current => ({ ...current, [thread.id]: "" })); }); }}>回复</Button></div>
          </div> : null}
        </article>)}
        {collaboration.loaded && !visible.length ? <div className={styles.empty}><Icon name={icons.comment} /><strong>{threads.length ? "没有符合条件的讨论" : "让讨论留在论文旁"}</strong><p>{threads.length ? "试试其他筛选条件。" : "选中正文后添加评论或提出修改建议。"}</p></div> : null}
      </>}
    </div>
  </div>;
}
function displayMentions(body: string) { return body.replace(/@\[([^\]\n]+)\]\(user_[A-Za-z0-9_-]+\)/g, "@$1"); }
function MentionPicker({ members, onPick }: { members: Member[]; onPick: (value: string) => void }) {
  return <Select aria-label="提及协作者" value="" onChange={id => { const member = members.find(item => item.userId === id); if (member) onPick(`@[${member.user.displayName.replace(/[\]\n]/g, "").slice(0, 100)}](${id})`); }} options={[{ value: "", label: "@ 提及" }, ...members.map(member => ({ value: member.userId, label: member.user.displayName }))]} />;
}
