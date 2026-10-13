import { statusLabel } from "../../lib/labels";
import { useEffect, useMemo, useState } from "react";
import type { PaperMemory, PaperProject } from "@fastwrite/shared";
import { api } from "../../api/client";
import { Button, Dialog, Icon, IconButton, TextArea, icons } from "../ui";

type Candidate = { title: string; current?: string; proposed: string };
type MemoryPart = { key: string; title: string; content: string; candidate?: string | undefined } & (
  | { kind: "overview" }
  | { kind: "section"; id: string }
  | { kind: "item"; id: string; label: string }
);

export function MemoryDialog({ open, project, onClose, onNavigate, onChanged }: { open: boolean; project: PaperProject; onClose: () => void; onNavigate: (path: string, line?: number) => void; onChanged: () => void | Promise<void> }) {
  const [memory, setMemory] = useState<PaperMemory | null>(null);
  const [operation, setOperation] = useState<"generating" | "applying" | "saving" | "accepting" | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<MemoryPart | null>(null);
  const [draft, setDraft] = useState("");
  const loading = operation !== null;

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError("");
    setEditing(null);
    api.memory.get(project.id, controller.signal).then(setMemory).catch((failure) => setError(message(failure)));
    return () => controller.abort();
  }, [open, project.id]);

  const candidates = useMemo(() => candidateEntries(memory), [memory]);
  const regenerate = async () => {
    setOperation("generating"); setError("");
    try { setMemory(await api.memory.extract(project.id)); await onChanged(); }
    catch (failure) { setError(message(failure)); }
    finally { setOperation(null); }
  };
  const apply = async () => {
    setOperation("applying"); setError("");
    try { setMemory(await api.memory.apply(project.id)); await onChanged(); }
    catch (failure) { setError(message(failure)); }
    finally { setOperation(null); }
  };
  const beginEdit = (part: MemoryPart) => { setEditing(part); setDraft(part.content); setError(""); };
  const savePart = async () => {
    if (!editing || !draft.trim()) return;
    setOperation("saving"); setError("");
    try {
      const updated = editing.kind === "overview"
        ? await api.memory.updateOverview(project.id, { content: draft })
        : editing.kind === "section"
          ? await api.memory.updateSection(project.id, editing.id, { content: draft })
          : await api.memory.updateItem(project.id, editing.id, { content: draft, label: editing.label });
      setMemory(updated);
      setEditing(null);
      await onChanged();
    } catch (failure) { setError(message(failure)); }
    finally { setOperation(null); }
  };
  const acceptCandidate = async (part: MemoryPart) => {
    if (!part.candidate) return;
    setOperation("accepting"); setError("");
    try {
      const updated = part.kind === "overview"
        ? await api.memory.acceptOverviewCandidate(project.id)
        : part.kind === "section"
          ? await api.memory.acceptSectionCandidate(project.id, part.id)
          : await api.memory.acceptItemCandidate(project.id, part.id);
      setMemory(updated);
      setEditing(null);
      await onChanged();
    } catch (failure) { setError(message(failure)); }
    finally { setOperation(null); }
  };
  const parts = useMemo(() => memoryParts(memory), [memory]);

  return <Dialog open={open} width="large" title="论文记忆" description={memory ? "在此编辑各部分记忆，每次保存都会更新根目录的 memory.md 文件。" : "创建可持续维护的项目记忆和指令文件。"} onClose={() => { if (!loading) onClose(); }} footer={<>
    <Button variant="ghost" onClick={onClose}>关闭</Button>
    {memory ? <Button variant="secondary" icon={<Icon name={icons.fileText} />} onClick={() => { onNavigate("memory.md"); onClose(); }}>打开 memory.md</Button> : null}
    {memory && candidates.length ? <Button variant="primary" icon={<Icon name={icons.check} />} loading={loading} disabled={Boolean(editing)} onClick={() => void apply()}>应用已审核的记忆</Button> : null}
    <Button variant={memory ? "secondary" : "primary"} icon={loading ? <Icon name={icons.loading} spin /> : <Icon name={icons.refresh} />} loading={loading} onClick={() => void regenerate()}>{memory ? "重新生成候选内容" : "生成记忆"}</Button>
  </>}>
    {loading ? <div className="agent-progress"><Icon name={icons.loading} spin /><strong>{operation === "saving" ? "正在润色编辑后的记忆" : operation === "accepting" ? "正在接受候选记忆" : operation === "applying" ? "正在应用已审核的记忆" : "正在生成论文记忆"}</strong><span>现有用户指令将保持不变。</span></div> : memory ? <div className="memory-panel memory-panel--review">
      <section className="memory-file-callout"><Icon name={icons.fileText} /><div><strong>memory.md 位于论文根目录</strong><span>用户指令可直接在文件中编辑，保存下方任一概述、章节或事实即可立即写入文件。</span></div></section>
      <div className="memory-review-summary"><strong>{candidates.length ? `${candidates.length} 个候选条目待审核` : "已审核的记忆为最新版本"}</strong><span>{parts.length} 个可编辑部分</span></div>
      {parts.length ? <div className="memory-review">{parts.map((part) => <article className="memory-review-card" key={part.key}><header><span>{part.title}</span>{editing?.key === part.key ? <div><IconButton label="润色并保存此部分记忆" icon={<Icon name={icons.save} />} variant="secondary" disabled={!draft.trim()} onClick={() => void savePart()} /><IconButton label="取消编辑此部分记忆" icon={<Icon name={icons.close} />} onClick={() => setEditing(null)} /></div> : <IconButton label={`编辑 ${part.title}`} icon={<Icon name={icons.edit} />} onClick={() => beginEdit(part)} />}</header>{editing?.key === part.key ? <AutoSizeTextarea label={`编辑 ${part.title}`} value={draft} onChange={setDraft} /> : <p className="memory-review-card__candidate">{part.content}</p>}{part.candidate && part.candidate !== part.content ? <div className="memory-candidate"><Button size="small" variant="primary" icon={<Icon name={icons.check} />} onClick={() => void acceptCandidate(part)}>接受候选内容</Button><p>{part.candidate}</p></div> : null}</article>)}</div> : <div className="memory-empty"><Icon name={icons.database} /><span>修改稿件后重新生成，即可创建可编辑的记忆部分。</span></div>}
    </div> : <div className="review-empty"><Icon name={icons.database} /><h3>建立论文记忆</h3><p>生成有证据支持的上下文，检查完整候选内容，再保存为根目录下可编辑的 memory.md 文件。</p></div>}
    {error ? <div className="form-error" role="alert">{error}</div> : null}
  </Dialog>;
}

function AutoSizeTextarea({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <TextArea aria-label={label} rows={1} value={value} onChange={onChange} growWithContent autoFocus />;
}

function memoryParts(memory: PaperMemory | null): MemoryPart[] {
  if (!memory) return [];
  const parts: MemoryPart[] = [];
  if (memory.overview) parts.push({ key: "overview", kind: "overview", title: "论文概述", content: memory.overview.content, candidate: memory.overview.candidate?.content });
  for (const section of memory.sections ?? []) parts.push({ key: `section:${section.id}`, kind: "section", id: section.id, title: `${section.title} (${section.path})`, content: section.content, candidate: section.candidate?.content });
  for (const item of memory.items) if (item.status !== "rejected") parts.push({ key: `item:${item.id}`, kind: "item", id: item.id, label: item.label, title: `${statusLabel(item.category)}： ${item.label}`, content: item.content, candidate: item.candidate?.content });
  return parts;
}

function candidateEntries(memory: PaperMemory | null): Candidate[] {
  if (!memory) return [];
  const entries: Candidate[] = [];
  if (memory.overview) entries.push({ title: "论文概述", ...(memory.overview.locked ? { current: memory.overview.content } : {}), proposed: memory.overview.candidate?.content ?? memory.overview.content });
  for (const section of memory.sections ?? []) entries.push({ title: `${section.title} (${section.path})`, ...(section.locked ? { current: section.content } : {}), proposed: section.candidate?.content ?? section.content });
  for (const item of memory.items) if (item.status !== "rejected") entries.push({ title: `${statusLabel(item.category)}： ${item.label}`, ...(item.status === "confirmed" || item.locked ? { current: item.content } : {}), proposed: item.candidate?.content ?? item.content });
  return entries.filter((entry) => !entry.current || entry.current !== entry.proposed);
}

function message(error: unknown) { return error instanceof Error ? error.message : "论文记忆请求失败"; }
