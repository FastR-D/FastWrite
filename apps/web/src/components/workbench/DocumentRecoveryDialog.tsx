import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
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
    }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Server version unavailable; local copies are retained."); });
    return () => { controller.abort(); modelsRef.current = null; for (const item of Object.values(created)) item.dispose(); };
  }, [registry, entry, draftId]);
  const preserveResult = async () => {
    const content = modelsRef.current?.result.getValue();
    if (content !== undefined && content !== localContent) await registry.preserve(entry, content, "merge-result", { ...(baseContent === undefined ? {} : { content: baseContent }), version: baseVersion });
  };
  const close = async () => {
    if (busy) return;
    try { await preserveResult(); onClose(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not preserve the merge result"); }
  };
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await operation(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Recovery failed; local copies retained"); }
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
  return <Dialog open title={`Recover ${entry.session.path}`} description="Compare the base, local text and server version. Applying the result checks the server version again. Saved local copies remain available until explicitly deleted." width="fullscreen" className="document-recovery" onClose={() => { void close(); }} footer={<><Button variant="ghost" disabled={busy} onClick={() => { void close(); }}>Cancel</Button><Button variant="primary" data-save-command disabled={busy || !models || !server || entry.mode !== "rest"} onClick={() => { void run(async () => { await registry.resolve(entry, modelsRef.current!.result.getValue(), server!, captured.revision); onClose(); }); }}>Apply result and save</Button></>}>
    <div className="recovery-controls"><Field label="Local version"><Select aria-label="Local version" value={draftId} disabled={busy} onChange={id => { void run(async () => { await preserveResult(); setDraftId(id); }); }} options={[{ value: "working", label: "Working buffer at comparison start" }, ...drafts.map(item => ({ value: item.id, label: `Saved local draft · ${new Date(item.savedAt).toLocaleString()} · base v${item.baseVersion}` }))]} /></Field><span>Base v{baseVersion} · Local revision {captured.revision} · Server {server ? `v${server.file.version}` : "unavailable"}</span></div>
    <div className="recovery-controls"><SegmentedControl label="Recovery comparison" value={view} onChange={setView} options={[{ value: "base", label: "Base vs local", disabled: baseContent === undefined }, { value: "local", label: "Server vs local", disabled: !server }, { value: "result", label: "Server vs editable result", disabled: !server }]} /><Button variant="ghost" disabled={!models || busy} onClick={() => replaceResult(localContent)}>Use local text</Button><Button variant="ghost" disabled={!server || busy} onClick={() => replaceResult(server!.content)}>Use server text</Button></div>
    {baseContent === undefined ? <p>This older draft has no stored base text; compare it with the server version.</p> : null}
    {entry.mode === "collaboration" ? <p>Save this recovery as a separate file before resolving the collaborative document.</p> : null}
    {error ? <p role="alert">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
    {models && (view === "base" || server) ? <TextModelComparison original={view === "base" ? models.base : models.server} modified={view === "result" ? models.result : models.local} originalLabel={view === "base" ? "Recovery base" : "Recovery server"} modifiedLabel={view === "result" ? "Recovery result" : "Recovery local"} readOnly={view !== "result"} /> : <p>Server comparison is unavailable until the server version loads. Local copies can still be inspected or downloaded.</p>}
    <div className="recovery-controls"><Field label="Copy path"><TextField aria-label="Recovery copy path" value={copyPath} onChange={setCopyPath} /></Field><Button variant="secondary" disabled={busy || !models} onClick={() => { void run(async () => { await registry.saveCopy(entry, copyPath, modelsRef.current!.result.getValue()); setNotice(`Saved copy: ${copyPath}`); }); }}>Save result as copy</Button><Button variant="ghost" disabled={!models} onClick={download}>Download result</Button>{draft ? <Button variant="danger" disabled={busy} onClick={() => { if (window.confirm("Delete this saved local draft? The working buffer will stay unchanged.")) void run(async () => { await preserveResult(); await registry.forgetRecovery(entry, draft.id); setDraftId("working"); }); }}>Delete saved draft</Button> : null}</div>
  </Dialog>;
}
