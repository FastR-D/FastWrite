import { useEffect, useMemo, useState } from "react";
import type { WorkspaceTreeNode } from "@fastwrite/shared";
import { MessageSquare, ShieldCheck } from "lucide-react";
import { api } from "../api/client";
import { Button } from "../components/ui/Button";

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
  useEffect(() => { void load().catch((failure) => setError(failure instanceof Error ? failure.message : "Share link is unavailable")); }, [token]);
  const select = async (nextPath: string) => { setPath(nextPath); try { setContent((await api.shared.file(token, nextPath)).content); } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not open file"); } };
  const comment = async () => { if (!body.trim() || !author.trim()) return; try { await api.shared.comment(token, { path, ...(Number(line) > 0 ? { line: Number(line) } : {}), author: author.trim(), body: body.trim() }); setBody(""); await load(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not add comment"); } };
  if (error && !data) return <main className="workspace-error"><h1>Review link unavailable</h1><p>{error}</p></main>;
  if (!data) return <main className="app-loading">Loading shared paper…</main>;
  return <main className="shared-review-page"><header className="workspace-topbar"><div className="workspace-topbar__left"><span className="brand__mark">F</span><div className="project-identity"><strong>{data.project.name}</strong><span>Shared review · version {data.project.version}</span></div></div><span className="skill-badge"><ShieldCheck /> {data.permission === "comment" ? "Comment access" : "Read only"}</span></header><div className="shared-review-layout"><aside><h2>Files</h2>{paths.map((item) => <button className={item === path ? "is-active" : ""} key={item} onClick={() => void select(item)}>{item}</button>)}</aside><section><header><strong>{path}</strong><span>Manuscript editing is disabled for shared links.</span></header><pre>{content}</pre></section><aside><h2>Comments</h2>{data.comments.filter((comment) => comment.path === path).map((comment) => <article key={comment.id}><strong>{comment.author}{comment.line ? ` · line ${comment.line}` : ""}</strong><p>{comment.body}</p><small>{new Date(comment.createdAt).toLocaleString()}</small></article>)}{data.permission === "comment" ? <div className="shared-comment-form"><input value={author} onChange={(event) => setAuthor(event.target.value)} placeholder="Your name" /><input value={line} onChange={(event) => setLine(event.target.value)} inputMode="numeric" placeholder="Line (optional)" /><textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="Review comment" /><Button icon={<MessageSquare />} disabled={!author.trim() || !body.trim()} onClick={() => void comment()}>Add comment</Button></div> : <p>This link is read-only.</p>}{error ? <div className="form-error">{error}</div> : null}</aside></div></main>;
}

function flattenTextFiles(nodes: WorkspaceTreeNode[]): string[] { return nodes.flatMap((node) => node.type === "directory" ? flattenTextFiles(node.children) : node.kind === "text" ? [node.path] : []); }
