import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { Button, Field, Select, TextArea, TextField } from "../ui";

export function FastReadPanel({ projectId, revision }: { projectId: string; revision: number }) {
  const [connected, setConnected] = useState(false);
  const [token, setToken] = useState("");
  const [papers, setPapers] = useState<Array<{ id: string; title: string }>>([]);
  const [notes, setNotes] = useState<Array<{ id: string; paper_id: string; title: string; content: string }>>([]);
  const [paperId, setPaperId] = useState("");
  const [title, setTitle] = useState("写作反馈");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.all([api.fastRead.status(), api.fastRead.feedback(projectId)]).then(([status, feedback]) => {
      if (!active) return;
      setConnected(status.connected); setPapers(feedback.papers); setNotes(feedback.items);
      setPaperId(current => feedback.papers.some(paper => paper.id === current) ? current : feedback.papers[0]?.id ?? "");
    }).catch(failure => { if (active) setError(failure instanceof Error ? failure.message : "无法读取联动状态"); });
    return () => { active = false; };
  }, [projectId, revision]);
  const perform = async (operation: () => Promise<void>) => {
    setBusy(true); setError(""); setMessage("");
    try { await operation(); } catch (failure) { setError(failure instanceof Error ? failure.message : "操作未完成"); } finally { setBusy(false); }
  };
  return <section className="research-section" aria-label="FastRead 联动">
    <header><div><h3>连接 FastRead</h3><p>连接后可接收论文、原文摘录和阅读笔记，并将写作反馈同步回论文。</p></div><div>
      <Button size="small" loading={busy} onClick={() => void perform(async () => { const result = await api.fastRead.connect(); setToken(result.token); setConnected(true); })}>{connected ? "重新生成连接码" : "生成连接码"}</Button>
      {connected ? <Button size="small" variant="ghost" disabled={busy} onClick={() => void perform(async () => { await api.fastRead.disconnect(); setConnected(false); setToken(""); setMessage("连接已撤销"); })}>撤销连接</Button> : null}
    </div></header>
    {token ? <Field label="连接码" hint="复制到 FastRead 设置中的 FastWrite 连接栏。重新生成后旧连接码立即失效。"><TextField value={token} readonly /><Button size="small" variant="ghost" onClick={() => void perform(async () => { await navigator.clipboard.writeText(token); setMessage("连接码已复制"); })}>复制连接码</Button></Field> : <p>{connected ? "已生成连接码" : "尚未连接"}</p>}
    {papers.length ? <div className="research-protocol">
      <h4>写作反馈</h4><Field label="关联论文"><Select value={paperId} onChange={next => { setPaperId(next); setContent(""); setTitle("写作反馈"); }} options={papers.map(paper => ({ value: paper.id, label: paper.title }))} /></Field>
      <Field label="标题"><TextField value={title} onChange={setTitle} /></Field>
      <Field label="反馈内容"><TextArea value={content} onChange={setContent} placeholder="记录论文在当前稿件中的用途、待补证据或新的研究问题。" /></Field>
      <Button size="small" loading={busy} disabled={!paperId || !content.trim()} onClick={() => void perform(async () => { await api.fastRead.saveFeedback(projectId, { paper_id: paperId, title, content }); setNotes((await api.fastRead.feedback(projectId)).items); setMessage("写作反馈已保存，可在 FastRead 拉取"); })}>保存写作反馈</Button>
      {notes.filter(note => note.paper_id === paperId).map(note => <article key={note.id} className="research-bundle"><strong>{note.title}</strong><p style={{ whiteSpace: "pre-wrap" }}>{note.content}</p><Button size="small" variant="ghost" onClick={() => { setTitle(note.title); setContent(note.content); }}>载入编辑</Button></article>)}
    </div> : null}
    {message ? <p className="research-notice" role="status">{message}</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
  </section>;
}
