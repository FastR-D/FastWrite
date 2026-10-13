import { useEffect, useRef, useState } from "react";
import * as monaco from "../../lib/editor/monacoRuntime";
import type { FileContentResponse } from "@fastwrite/shared";
import { api } from "../../api/client";
import type { DocumentEntry, DocumentRegistry } from "../../lib/editor/documentRegistry";
import { configureMonaco, languageForPath } from "../../lib/editor/monaco";
import { Button, Dialog, Field, SegmentedControl, Select, TextField } from "../ui";
import { TextModelComparison } from "./TextModelComparison";

type Models = Record<"base" | "local" | "server" | "result", monaco.editor.ITextModel>;
export function DocumentRecoveryDialog({ registry, entry, onClose }: { registry: DocumentRegistry; entry: DocumentEntry; onClose: () => void }) {
  const [captured] = useState(() => ({ content: entry.model.getValue(), baseContent: entry.session.baseContent, baseVersion: entry.session.serverVersion, revision: entry.session.localRevision }));
  const [drafts, setDrafts] = useState(entry.recoveries);
  const [draftId, setDraftId] = useState(entry.session.error ? "working" : entry.recoveries[0]?.id ?? "working");
  const draft = drafts.find(item => item.id === draftId);
  const localContent = draft?.content ?? captured.content;
  const baseContent = draft ? draft.baseContent : captured.baseContent;
  const baseVersion = draft?.baseVersion ?? captured.baseVersion;
  const [models, setModels] = useState<Models | null>(null);
  const modelsRef = useRef<Models | null>(null);
  const [server, setServer] = useState<FileContentResponse | null>(null);
  const [view, setView] = useState<"base" | "local" | "result">("result");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copyPath, setCopyPath] = useState(() => entry.session.path.replace(/(\.[^/.]+)?$/, `-recovered-${Date.now()}$1`));
  useEffect(() => registry.subscribe(changed => { if (changed === entry) setDrafts([...entry.recoveries]); }), [registry, entry]);
  useEffect(() => registry.acquire(entry), [registry, entry]);
  useEffect(() => {
    configureMonaco(); setError(""); setNotice(""); setServer(null);
    const identity = crypto.randomUUID();
    const model = (side: string, content: string) => monaco.editor.createModel(content, languageForPath(entry.session.path), monaco.Uri.from({ scheme: "fastwrite-recovery", authority: registry.projectId, path: `/${entry.session.path}`, query: `${identity}-${side}` }));
    const created = { base: model("base", baseContent ?? ""), local: model("local", localContent), server: model("server", ""), result: model("result", localContent) };
    modelsRef.current = created; setModels(created);
    const controller = new AbortController();
    void api.projects.readFile(registry.projectId, entry.session.path, controller.signal).then(document => {
      if (controller.signal.aborted) return;
      created.server.applyEdits([{ range: created.server.getFullModelRange(), text: document.content }]); setServer(document);
    }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "服务端版本暂不可用，已保留本地副本。"); });
    return () => { controller.abort(); modelsRef.current = null; for (const item of Object.values(created)) item.dispose(); };
  }, [registry, entry, draftId]);
  const preserveResult = async () => {
    const content = modelsRef.current?.result.getValue();
    if (content !== undefined && content !== localContent) await registry.preserve(entry, content, "merge-result", { ...(baseContent === undefined ? {} : { content: baseContent }), version: baseVersion });
  };
  const close = async () => {
    if (busy) return;
    try { await preserveResult(); onClose(); } catch (failure) { setError(failure instanceof Error ? failure.message : "无法保存合并结果"); }
  };
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await operation(); } catch (failure) { setError(failure instanceof Error ? failure.message : "恢复失败，已保留本地副本"); }
    finally { setBusy(false); }
  };
  const replaceResult = (content: string) => {
    const model = modelsRef.current?.result; if (!model) return;
    model.pushStackElement(); model.pushEditOperations(null, [{ range: model.getFullModelRange(), text: content }], () => null); model.pushStackElement(); setView("result");
  };
  const download = () => {
    const content = modelsRef.current?.result.getValue() ?? localContent;
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = copyPath.split("/").pop() || "recovered.txt"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <Dialog open title={`恢复 ${entry.session.path}`} description="比较基准版本、本地文本和服务端版本。应用结果前将再次检查服务端版本；已保存的本地副本会保留，直到手动删除。" width="fullscreen" className="document-recovery" onClose={() => { void close(); }} footer={<><Button variant="ghost" disabled={busy} onClick={() => { void close(); }}>取消</Button><Button variant="primary" data-save-command disabled={busy || !models || !server || entry.mode !== "rest"} onClick={() => { void run(async () => { await registry.resolve(entry, modelsRef.current!.result.getValue(), server!, captured.revision); onClose(); }); }}>应用结果并保存</Button></>}>
    <div className="recovery-controls"><Field label="本地版本"><Select aria-label="本地版本" value={draftId} disabled={busy} onChange={id => { void run(async () => { await preserveResult(); setDraftId(id); }); }} options={[{ value: "working", label: "开始比较时的编辑内容" }, ...drafts.map(item => ({ value: item.id, label: `已保存的本地草稿 · ${new Date(item.savedAt).toLocaleString("zh-CN")} · 基准版本${item.baseVersion}` }))]} /></Field><span>基准版本{baseVersion} · 本地修订 {captured.revision} · 服务端 {server ? `v${server.file.version}` : "不可用"}</span></div>
    <div className="recovery-controls"><SegmentedControl label="恢复对比" value={view} onChange={setView} options={[{ value: "base", label: "基准与本地对比", disabled: baseContent === undefined }, { value: "local", label: "服务端与本地对比", disabled: !server }, { value: "result", label: "服务端与编辑结果对比", disabled: !server }]} /><Button variant="ghost" disabled={!models || busy} onClick={() => replaceResult(localContent)}>使用本地文本</Button><Button variant="ghost" disabled={!server || busy} onClick={() => replaceResult(server!.content)}>使用服务端文本</Button></div>
    {baseContent === undefined ? <p>此旧草稿未保存基准文本，请与服务端版本比较。</p> : null}
    {entry.mode === "collaboration" ? <p>处理协作文档前，请先将恢复内容保存为独立文件。</p> : null}
    {error ? <p role="alert">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
    {models && (view === "base" || server) ? <TextModelComparison original={view === "base" ? models.base : models.server} modified={view === "result" ? models.result : models.local} originalLabel={view === "base" ? "恢复基准" : "服务端恢复版本"} modifiedLabel={view === "result" ? "恢复结果" : "本地恢复版本"} readOnly={view !== "result"} /> : <p>加载服务端版本后才能进行比较，期间仍可查看或下载本地副本。</p>}
    <div className="recovery-controls"><Field label="副本路径"><TextField aria-label="恢复副本路径" value={copyPath} onChange={setCopyPath} /></Field><Button variant="secondary" disabled={busy || !models} onClick={() => { void run(async () => { await registry.saveCopy(entry, copyPath, modelsRef.current!.result.getValue()); setNotice(`已保存副本： ${copyPath}`); }); }}>将结果另存为副本</Button><Button variant="ghost" disabled={!models} onClick={download}>下载结果</Button>{draft ? <Button variant="danger" disabled={busy} onClick={() => { if (window.confirm("删除此本地草稿？当前编辑内容将保持不变。")) void run(async () => { await preserveResult(); await registry.forgetRecovery(entry, draft.id); setDraftId("working"); }); }}>删除已保存的草稿</Button> : null}</div>
  </Dialog>;
}
