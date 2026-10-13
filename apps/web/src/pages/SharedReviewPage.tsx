import { useEffect, useMemo, useState } from "react";
import type { WorkspaceTreeNode } from "@fastwrite/shared";
import { api } from "../api/client";
import { Button, Icon, icons, TextArea, TextField } from "../components/ui";

type SharedData = Awaited<ReturnType<typeof api.shared.get>>;

export function SharedReviewPage({ token }: { token: string }) {
  const [data, setData] = useState<SharedData | null>(null);
  const [path, setPath] = useState("");
  const [content, setContent] = useState("");
  const [author, setAuthor] = useState("");
  const [body, setBody] = useState("");
  const [line, setLine] = useState("");
  const [error, setError] = useState("");
  const paths = useMemo(() => flattenTextFiles(data?.tree ?? []), [data]);
  const load = async () => { const next = await api.shared.get(token); setData(next); const selected = path || next.project.mainDocument; setPath(selected); const file = await api.shared.file(token, selected); setContent(file.content); };
  useEffect(() => { void load().catch((failure) => setError(failure instanceof Error ? failure.message : "分享链接不可用")); }, [token]);
  const select = async (nextPath: string) => { setPath(nextPath); try { setContent((await api.shared.file(token, nextPath)).content); } catch (failure) { setError(failure instanceof Error ? failure.message : "无法打开文件"); } };
  const comment = async () => { if (!body.trim() || !author.trim()) return; try { await api.shared.comment(token, { path, ...(Number(line) > 0 ? { line: Number(line) } : {}), author: author.trim(), body: body.trim() }); setBody(""); await load(); } catch (failure) { setError(failure instanceof Error ? failure.message : "无法添加评论"); } };
  if (error && !data) return <main className="workspace-error"><h1>审稿链接不可用</h1><p>{error}</p></main>;
  if (!data) return <main className="app-loading">正在加载分享的论文…</main>;
  return <main className="shared-review-page"><header className="workspace-topbar"><div className="workspace-topbar__left"><span className="brand__mark">F</span><div className="project-identity"><strong>{data.project.name}</strong><span>分享审稿 · 版本 {data.project.version}</span></div></div><span className="skill-badge"><Icon name={icons.verified} /> {data.permission === "comment" ? "可评论" : "只读"}</span></header><div className="shared-review-layout"><aside><h2>文件</h2>{paths.map((item) => <Button variant="ghost" className={`shared-review-file${item === path ? " is-active" : ""}`} key={item} onClick={() => void select(item)}>{item}</Button>)}</aside><section><header><strong>{path}</strong><span>分享链接不支持编辑稿件。</span></header><pre>{content}</pre></section><aside><h2>评论</h2>{data.comments.filter((comment) => comment.path === path).map((comment) => <article key={comment.id}><strong>{comment.author}{comment.line ? ` · 行号 ${comment.line}` : ""}</strong><p>{comment.body}</p><small>{new Date(comment.createdAt).toLocaleString("zh-CN")}</small></article>)}{data.permission === "comment" ? <div className="shared-comment-form"><TextField className="shared-field" value={author} onChange={setAuthor} placeholder="你的姓名" /><TextField className="shared-field" value={line} onChange={setLine} inputMode="numeric" placeholder="行号（可选）" /><TextArea className="shared-field" value={body} onChange={setBody} placeholder="审稿评论" /><Button icon={<Icon name={icons.comment} />} disabled={!author.trim() || !body.trim()} onClick={() => void comment()}>添加评论</Button></div> : <p>此链接为只读链接。</p>}{error ? <div className="form-error">{error}</div> : null}</aside></div></main>;
}

function flattenTextFiles(nodes: WorkspaceTreeNode[]): string[] { return nodes.flatMap((node) => node.type === "directory" ? flattenTextFiles(node.children) : node.kind === "text" ? [node.path] : []); }
