import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, Database, FileText, LoaderCircle, Pencil, RefreshCw, Save, X } from "lucide-react";
import type { PaperMemory, PaperProject } from "@fastwrite/shared";
import { api } from "../../api/client";
import { Button, IconButton } from "../ui/Button";
import { Dialog } from "../ui/Dialog";

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

  return <Dialog open={open} width="large" title="Paper Memory" description={memory ? "Edit each memory part here; every save updates the root memory.md file." : "Create a durable project memory and instructions file."} onClose={() => { if (!loading) onClose(); }} footer={<>
    <Button variant="ghost" onClick={onClose}>Close</Button>
    {memory ? <Button variant="secondary" icon={<FileText />} onClick={() => { onNavigate("memory.md"); onClose(); }}>Open memory.md</Button> : null}
    {memory && candidates.length ? <Button variant="primary" icon={<Check />} loading={loading} disabled={Boolean(editing)} onClick={() => void apply()}>Apply reviewed memory</Button> : null}
    <Button variant={memory ? "secondary" : "primary"} icon={loading ? <LoaderCircle className="spin" /> : <RefreshCw />} loading={loading} onClick={() => void regenerate()}>{memory ? "Regenerate candidate" : "Generate Memory"}</Button>
  </>}>
    {loading ? <div className="agent-progress"><LoaderCircle className="spin" /><strong>{operation === "saving" ? "Polishing edited Memory" : operation === "accepting" ? "Accepting Memory candidate" : operation === "applying" ? "Applying reviewed Memory" : "Building Paper Memory"}</strong><span>Existing user instructions remain unchanged.</span></div> : memory ? <div className="memory-panel memory-panel--review">
      <section className="memory-file-callout"><FileText /><div><strong>memory.md is in the paper root</strong><span>User Instructions are edited directly in the file. Save any overview, section, or fact below to persist it immediately.</span></div></section>
      <div className="memory-review-summary"><strong>{candidates.length ? `${candidates.length} candidate entries to review` : "Reviewed memory is current"}</strong><span>{parts.length} editable parts</span></div>
      {parts.length ? <div className="memory-review">{parts.map((part) => <article className="memory-review-card" key={part.key}><header><span>{part.title}</span>{editing?.key === part.key ? <div><IconButton label="Polish and save memory part" icon={<Save />} variant="secondary" disabled={!draft.trim()} onClick={() => void savePart()} /><IconButton label="Cancel editing memory part" icon={<X />} onClick={() => setEditing(null)} /></div> : <IconButton label={`Edit ${part.title}`} icon={<Pencil />} onClick={() => beginEdit(part)} />}</header>{editing?.key === part.key ? <AutoSizeTextarea label={`Edit ${part.title}`} value={draft} onChange={setDraft} /> : <p className="memory-review-card__candidate">{part.content}</p>}{part.candidate && part.candidate !== part.content ? <div className="memory-candidate"><Button size="small" variant="primary" icon={<Check />} onClick={() => void acceptCandidate(part)}>Accept candidate</Button><p>{part.candidate}</p></div> : null}</article>)}</div> : <div className="memory-empty"><Database /><span>Regenerate after changing the manuscript to create editable memory parts.</span></div>}
    </div> : <div className="review-empty"><Database /><h3>Build a paper memory</h3><p>Generate evidence-backed context, inspect the complete candidate, and save it as an editable root-level memory.md file.</p></div>}
    {error ? <div className="form-error" role="alert">{error}</div> : null}
  </Dialog>;
}

function AutoSizeTextarea({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const textarea = ref.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${textarea.scrollHeight + 2}px`;
  }, [value]);
  return <textarea ref={ref} rows={1} aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} autoFocus />;
}

function memoryParts(memory: PaperMemory | null): MemoryPart[] {
  if (!memory) return [];
  const parts: MemoryPart[] = [];
  if (memory.overview) parts.push({ key: "overview", kind: "overview", title: "Paper overview", content: memory.overview.content, candidate: memory.overview.candidate?.content });
  for (const section of memory.sections ?? []) parts.push({ key: `section:${section.id}`, kind: "section", id: section.id, title: `${section.title} (${section.path})`, content: section.content, candidate: section.candidate?.content });
  for (const item of memory.items) if (item.status !== "rejected") parts.push({ key: `item:${item.id}`, kind: "item", id: item.id, label: item.label, title: `${item.category}: ${item.label}`, content: item.content, candidate: item.candidate?.content });
  return parts;
}

function candidateEntries(memory: PaperMemory | null): Candidate[] {
  if (!memory) return [];
  const entries: Candidate[] = [];
  if (memory.overview) entries.push({ title: "Paper overview", ...(memory.overview.locked ? { current: memory.overview.content } : {}), proposed: memory.overview.candidate?.content ?? memory.overview.content });
  for (const section of memory.sections ?? []) entries.push({ title: `${section.title} (${section.path})`, ...(section.locked ? { current: section.content } : {}), proposed: section.candidate?.content ?? section.content });
  for (const item of memory.items) if (item.status !== "rejected") entries.push({ title: `${item.category}: ${item.label}`, ...(item.status === "confirmed" || item.locked ? { current: item.content } : {}), proposed: item.candidate?.content ?? item.content });
  return entries.filter((entry) => !entry.current || entry.current !== entry.proposed);
}

function message(error: unknown) { return error instanceof Error ? error.message : "Paper Memory request failed"; }
