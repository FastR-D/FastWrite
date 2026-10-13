import { statusLabel } from "../../lib/labels";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ParsedReference, ReferenceAspect, ReferencePaper, ReferenceProfileStatus, ReferenceSelection, ReferenceSettings, ReferenceScope } from "@fastwrite/shared";
import { api } from "../../api/client";
import { Button, Checkbox, Dialog, Disclosure, Field, FileField, MultiSelect, NumberField, Select, TextArea, TextField } from "../ui";
import { ReferencePdfViewer } from "./ReferencePdfViewer";
import styles from "./ReferenceStylePanel.module.css";

export type ReferenceWriteTarget = "selection" | "section" | "file" | "project";
export interface ReferenceWriteAction { id: string; target: ReferenceWriteTarget; instruction: string; path?: string; }
const aspects = [{ value: "structure", label: "章节结构" }, { value: "paragraphs", label: "段落组织" }, { value: "argumentation", label: "论述顺序" }, { value: "expression", label: "句式与语气" }];
const statusLabels = { parsing: "解析中", "needs-input": "选择入口文件", ready: "可用", failed: "解析失败" };
const scopeLabels = { full: "全文", sections: "指定章节", pages: "指定页码", excerpt: "原文选段" };
export function referenceScopeLabel(selection: ReferenceSelection): string { return selection.scope.type === "pages" ? `第 ${selection.scope.from}–${selection.scope.to} 页` : scopeLabels[selection.scope.type]; }
export function ReferenceStylePanel({ projectId, path, hasSelection, hasSection, refreshVersion, onSettingsChanged, onWrite }: {
  refreshVersion: number; projectId: string; path?: string; hasSelection: boolean; hasSection: boolean;
  onSettingsChanged: (settings: ReferenceSettings, papers: ReferencePaper[]) => void;
  onWrite: (target: ReferenceWriteTarget, instruction: string) => void;
}) {
  const [papers, setPapers] = useState<ReferencePaper[]>([]);
  const [settings, setSettings] = useState<ReferenceSettings>({ projectId, revision: 0, selections: [] });
  const [profiles, setProfiles] = useState<ReferenceProfileStatus[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [parsed, setParsed] = useState<ParsedReference | null>(null);
  const [draft, setDraft] = useState<ReferenceSelection | null>(null);
  const [entry, setEntry] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(false);
  const [original, setOriginal] = useState(false);
  const [target, setTarget] = useState<ReferenceWriteTarget>("section");
  const [deleting, setDeleting] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null), inputRef = useRef<HTMLInputElement>(null), abortRef = useRef<AbortController | null>(null);
  const onChanged = useRef(onSettingsChanged); onChanged.current = onSettingsChanged;
  const selected = papers.find(paper => paper.id === selectedId);
  const activeProfile = profiles.find(profile => profile.referenceId === selectedId);
  const reload = useCallback(async (signal?: AbortSignal) => {
    const [nextPapers, nextSettings, nextProfiles] = await Promise.all([api.referencePapers.list(projectId, signal), api.referencePapers.settings(projectId, signal), api.referencePapers.profiles(projectId, signal)]);
    if (signal?.aborted) return;
    setPapers(nextPapers); setSettings(nextSettings); setProfiles(nextProfiles); onChanged.current(nextSettings, nextPapers);
    setSelectedId(id => nextPapers.some(paper => paper.id === id) ? id : nextPapers[0]?.id ?? "");
  }, [projectId]);
  useEffect(() => { const controller = new AbortController(); void reload(controller.signal).catch(failure => { if (!controller.signal.aborted) setError(message(failure)); }); return () => { controller.abort(); abortRef.current?.abort(); }; }, [reload, refreshVersion]);
  const processing = papers.some(paper => paper.status === "parsing") || profiles.some(profile => ["queued", "running"].includes(profile.status));
  useEffect(() => {
    if (!processing) return;
    const controller = new AbortController(); let running = false;
    const timer = window.setInterval(() => { if (running) return; running = true; void reload(controller.signal).catch(failure => { if (!controller.signal.aborted) setError(message(failure)); }).finally(() => { running = false; }); }, 1200);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [processing, reload]);
  useEffect(() => {
    setParsed(null); setError(""); setEntry(selected?.mainDocument ?? selected?.candidates?.[0] ?? ""); setTitle(selected?.title ?? "");
    if (!selected || selected.status !== "ready") { setDraft(null); return; }
    setDraft(settings.selections.find(selection => selection.referenceId === selected.id) ?? { referenceId: selected.id, parseRevision: selected.parseRevision, scope: { type: "full" }, aspects: ["structure", "paragraphs", "argumentation", "expression"] });
    const controller = new AbortController();
    void api.referencePapers.text(projectId, selected.id, controller.signal).then(setParsed).catch(failure => { if (!controller.signal.aborted) setError(message(failure)); });
    return () => controller.abort();
    // Preserve draft edits during background polling.
  }, [projectId, selectedId, selected?.parseRevision, selected?.status]);
  const perform = async (action: () => Promise<unknown>) => { setBusy(true); setError(""); try { await action(); await reload(); } catch (failure) { setError(message(failure)); await reload().catch(() => {}); } finally { setBusy(false); } };
  const upload = async (files: File[]) => {
    if (!files.length || busy) return;
    const controller = new AbortController(); abortRef.current = controller; setBusy(true); setError("");
    try { for (const file of files) { if (file.size > 30 * 1024 * 1024) throw new Error("参考论文不能超过 30 MB"); setUploading(file.name); const paper = await api.referencePapers.upload(projectId, file, controller.signal); setSelectedId(paper.id); await reload(controller.signal); } }
    catch (failure) { if (!controller.signal.aborted) setError(message(failure)); }
    finally { setUploading(""); setBusy(false); if (abortRef.current === controller) abortRef.current = null; }
  };
  const save = async (enabled: boolean) => {
    if (!draft) return;
    const selections = settings.selections.filter(selection => selection.referenceId !== draft.referenceId);
    const next = await api.referencePapers.saveSettings(projectId, enabled ? [...selections, draft] : selections, settings.revision);
    setSettings(next); onChanged.current(next, papers);
  };
  const changeScope = (type: string) => {
    if (!draft) return;
    const scope: ReferenceScope = type === "sections" ? { type: "sections", sectionIds: [] } : type === "pages" ? { type: "pages", from: 1, to: selected?.pageCount ?? 1 } : type === "excerpt" ? { type: "excerpt", from: 0, to: 0 } : { type: "full" };
    setDraft({ ...draft, scope }); if (type === "excerpt") { setOriginal(false); setPreview(true); }
  };
  const validScope = !!draft && !!draft.aspects.length && (draft.scope.type === "full" || draft.scope.type === "sections" && !!draft.scope.sectionIds.length || draft.scope.type === "pages" && draft.scope.from >= 1 && draft.scope.to >= draft.scope.from && draft.scope.to <= (selected?.pageCount ?? 0) || draft.scope.type === "excerpt" && draft.scope.to > draft.scope.from);
  const targetAvailable = target === "selection" ? hasSelection : target === "section" ? hasSection : target === "file" ? !!path : true;
  return <div className={styles.panel} onDragOver={event => { event.preventDefault(); }} onDrop={event => { event.preventDefault(); event.stopPropagation(); void upload(Array.from(event.dataTransfer.files)); }}>
    <FileField hidden inputRef={inputRef} label="添加参考论文" accept=".pdf,.zip" multiple onSelect={files => void upload(files)} disabled={busy} />
    <Button disabled={busy} onClick={() => inputRef.current?.click()}>添加参考论文</Button>
    <p className={styles.hint}>选择或拖放 PDF / TeX ZIP，最多 30 MB。参考范围与当前论文的写作范围分别设置。</p>
    {uploading ? <div role="status">正在上传 {uploading}… <Button size="small" variant="ghost" onClick={() => abortRef.current?.abort()}>取消上传</Button></div> : null}
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {!papers.length ? <p className={styles.empty}>添加一篇论文，借鉴它的结构、论述与表达方式。</p> : <div className={styles.list} aria-label="参考论文列表">{papers.map(paper => <Button key={paper.id} variant={selectedId === paper.id ? "secondary" : "ghost"} onClick={() => setSelectedId(paper.id)} aria-pressed={selectedId === paper.id}><span className={styles.paperName}>{paper.title}<small>{paper.sourceKind === "tex-zip" ? "TeX" : "PDF"} · {statusLabels[paper.status]}{settings.selections.some(selection => selection.referenceId === paper.id) ? " · 已启用" : ""}</small></span></Button>)}</div>}
    {selected ? <div className={styles.detail}>
      <Field label="论文标题"><TextField value={title} onChange={setTitle} /></Field>
      <div className={styles.actions}><Button size="small" disabled={busy || !title.trim() || title === selected.title} onClick={() => void perform(() => api.referencePapers.rename(projectId, selected.id, title))}>保存标题</Button><Button size="small" variant="ghost" disabled={busy} onClick={() => setDeleting(true)}>删除论文</Button></div>
      {selected.status !== "needs-input" && (selected.candidates?.length ?? 0) > 1 ? <Field label="入口文件"><Select value={entry} options={(selected.candidates ?? []).map(value => ({ value, label: value }))} onChange={setEntry} /></Field> : null}
      {selected.status === "ready" && entry && entry !== selected.mainDocument ? <Button disabled={busy} onClick={() => void perform(() => api.referencePapers.parse(projectId, selected.id, entry))}>切换入口并重新解析</Button> : null}
      {selected.status === "needs-input" ? <><Field label="入口文件"><Select value={entry} options={(selected.candidates ?? []).map(value => ({ value, label: value }))} onChange={setEntry} /></Field><Button disabled={busy || !entry} onClick={() => void perform(() => api.referencePapers.parse(projectId, selected.id, entry))}>解析所选论文</Button></> : null}
      {selected.status === "parsing" ? <p role="status">正在提取正文和章节…</p> : null}
      {selected.status === "failed" ? <><p role="alert" className={styles.error}>{selected.error}</p><Button disabled={busy} onClick={() => void perform(() => api.referencePapers.parse(projectId, selected.id, entry || selected.mainDocument))}>重试解析</Button></> : null}
      {selected.status === "ready" && draft ? <>
        <p className={styles.hint}>{selected.characterCount.toLocaleString("zh-CN")} 字符{selected.pageCount ? ` · ${selected.pageCount} 页` : ""} · {selected.sections.length} 个章节</p>
        <Button size="small" disabled={!parsed} onClick={() => setPreview(true)}>阅读原文 / 选择片段</Button>
        <Field label="参考论文范围"><Select value={draft.scope.type} onChange={changeScope} options={[{ value: "full", label: "全文" }, { value: "sections", label: "指定章节" }, ...(selected.pageCount ? [{ value: "pages", label: "指定页码" }] : []), { value: "excerpt", label: "原文选段" }]} /></Field>
        {draft.scope.type === "sections" ? <Field label="参考章节"><MultiSelect label="参考章节" value={draft.scope.sectionIds} options={selected.sections.map(section => ({ value: section.id, label: `${"　".repeat(section.level > 1 ? section.level - 1 : 0)}${section.title}` }))} onChange={sectionIds => setDraft({ ...draft, scope: { type: "sections", sectionIds } })} /></Field> : null}
        {draft.scope.type === "pages" ? <div className={styles.range}><Field label="起始页"><NumberField min={1} max={selected.pageCount ?? 1} value={draft.scope.from} onChange={from => setDraft({ ...draft, scope: { type: "pages", from: from ?? 1, to: draft.scope.type === "pages" ? draft.scope.to : 1 } })} /></Field><Field label="结束页"><NumberField min={1} max={selected.pageCount ?? 1} value={draft.scope.to} onChange={to => setDraft({ ...draft, scope: { type: "pages", from: draft.scope.type === "pages" ? draft.scope.from : 1, to: to ?? 1 } })} /></Field></div> : null}
        {draft.scope.type === "excerpt" ? <p className={styles.hint}>{draft.scope.to > draft.scope.from ? `已选择 ${draft.scope.to - draft.scope.from} 字符` : "打开原文，选中所需文字，再点击“使用所选片段”。"}</p> : null}
        <Field label="借鉴方式"><MultiSelect label="借鉴方式" options={aspects} value={draft.aspects} onChange={value => setDraft({ ...draft, aspects: value as ReferenceAspect[] })} /></Field>
        <Field label="额外要求"><TextArea rows={2} maxLength={1000} value={draft.instruction ?? ""} placeholder="例如：先提出问题，再分析不足，最后介绍贡献" onChange={instruction => setDraft({ ...draft, instruction })} /></Field>
        <Button disabled={busy || !validScope} onClick={() => void perform(() => save(true))}>启用并保存参考范围</Button>
        {settings.selections.some(selection => selection.referenceId === selected.id) ? <Button size="small" variant="ghost" disabled={busy} onClick={() => void perform(() => save(false))}>停用此参考</Button> : null}
        <Button size="small" variant="secondary" disabled={busy || !settings.selections.length} onClick={() => void perform(() => api.referencePapers.prepare(projectId))}>准备写作参考</Button>
        {activeProfile ? <p role="status" className={styles.hint}>{activeProfile.status === "completed" ? "写法分析已缓存，可用于写作与补全。" : activeProfile.status === "missing" ? "写作时会分析全部所选内容；可提前准备以供补全使用。" : activeProfile.progress?.message ?? statusLabel(activeProfile.status)}{activeProfile.error ? `：${activeProfile.error}` : ""}</p> : null}
        <Field label="当前论文写作范围"><Select value={target} onChange={value => setTarget(value as ReferenceWriteTarget)} options={[{ value: "selection", label: "当前选区", disabled: !hasSelection }, { value: "section", label: "当前章节", disabled: !hasSection }, { value: "file", label: "当前文件", disabled: !path }, { value: "project", label: "整篇论文" }]} /></Field>
        <Button disabled={busy || !targetAvailable || !settings.selections.length} onClick={() => onWrite(target, "借鉴所选参考论文的写法，保持当前论文的事实、数字、术语和引用，改进结构、论述和表达。")}>在 FastWrite 中写作</Button>
        {selected.warnings.length ? <Disclosure summary={`解析提示（${selected.warnings.length}）`} className={styles.hint ?? ""}>{selected.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</Disclosure> : null}
      </> : null}
    </div> : null}
    <Dialog open={preview && !!parsed && !!selected} title={selected?.title ?? "参考论文"} description="原文只读；选段以解析文本中的位置保存。" width="wide" onClose={() => setPreview(false)}>
      {selected && parsed ? <div className={styles.reader}><div className={styles.actions}><Checkbox checked={original} onChange={setOriginal} disabled={selected.sourceKind === "tex-zip"}>查看原始 PDF</Checkbox><Button disabled={original} onClick={() => { const text = textRef.current; if (!text || text.selectionEnd <= text.selectionStart || !draft) { setError("请先在解析文本中选中一段文字。"); return; } setDraft({ ...draft, scope: { type: "excerpt", from: text.selectionStart, to: text.selectionEnd } }); setPreview(false); }}>使用所选片段</Button></div>{original ? <ReferencePdfViewer projectId={projectId} referenceId={selected.id} /> : <TextArea ref={textRef} readonly value={parsed.text} rows={22} resize="none" aria-label="参考论文解析原文" className={styles.sourceText ?? ""} />}</div> : null}
    </Dialog>
    <Dialog open={deleting} title="删除参考论文" description={`移除“${selected?.title ?? ""}”及其解析内容和活动参考设置。已生成的写作候选仍可审核。`} width="small" onClose={() => setDeleting(false)}><Button disabled={busy} onClick={() => { setDeleting(false); if (selected) void perform(() => api.referencePapers.remove(projectId, selected.id)); }}>删除</Button></Dialog>
  </div>;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
